const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const utils = require('../board-utils.js');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(script => script.trim());

function board(overrides = {}) {
    const elements = new Map();
    const events = {};
    const alerts = [];
    const downloads = [];
    const document = {
        activeElement: null,
        addEventListener: (name, fn) => { events[name] = fn; },
        querySelectorAll: () => [],
        getElementById: id => {
            if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', contains: () => false });
            return elements.get(id);
        }
    };
    const context = vm.createContext({
        document, console, setTimeout, clearTimeout,
        supabase: { createClient: () => ({}) },
        TicketBoardUtils: { ...utils, downloadFile: (...args) => downloads.push(args), ...overrides },
        alert: message => alerts.push(message),
    });
    context.window = context;
    vm.runInContext(scripts[0].replace(/\n    init\(\);\s*$/, ''), context);
    return { context, document, alerts, downloads, run: code => vm.runInContext(code, context) };
}

test('inline JavaScript parses and local script/image/audio references exist', () => {
    scripts.forEach(script => new vm.Script(script));
    for (const [, reference] of html.matchAll(/(?:src)="([^"#]+)"/g)) {
        if (!/^https?:/.test(reference)) assert.ok(fs.existsSync(path.join(__dirname, '..', reference)), reference);
    }
});

test('music can play, pause and resume; a failed play can be retried', async () => {
    const handlers = {};
    let click, plays = 0, fail = false, errors = 0;
    const audio = {
        paused: true,
        addEventListener: (name, fn) => { handlers[name] = fn; },
        play: async () => { plays++; if (fail) throw new Error('unavailable'); audio.paused = false; handlers.play(); },
        pause: () => { audio.paused = true; handlers.pause(); }
    };
    const button = { style: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener: (_, fn) => { click = fn; } };
    utils.bindAudioButton(audio, button, () => errors++);
    await click(); assert.equal(audio.paused, false);
    await click(); assert.equal(audio.paused, true);
    await click(); assert.equal(plays, 2);
    assert.equal(button.attributes['aria-pressed'], 'true');
    await click(); fail = true;
    await click(); assert.equal(errors, 1); assert.equal(button.disabled, false);
    fail = false; await click(); assert.equal(audio.paused, false);
});

test('paginated reads retain more than 1000 records and propagate failures', async () => {
    const rows = Array.from({ length: 1201 }, (_, id) => ({ id }));
    const ranges = [];
    const client = { from() { return this; }, select() { return this; }, order() { return this; },
        async range(start, end) { ranges.push([start, end]); return { data: rows.slice(start, end + 1) }; } };
    assert.deepEqual(await utils.readAllRows(client, 'tickets'), rows);
    assert.equal(ranges.length, 3);
    client.range = async () => ({ error: new Error('connection lost') });
    await assert.rejects(utils.readAllRows(client, 'tickets'), /connection lost/);
});

test('backup reads fresh tickets and history with IDs and handwritten memo intact', async () => {
    const tickets = [{ id: 19, ticket_no: 'X-8', memo: '定金300', uniq_key: 'seat', created_at: '2026-09-10' }];
    const logs = [{ id: 20, ticket_id: 19, detail: '已收款' }];
    const b = board({ readAllRows: async (_, table) => table === 'tickets' ? tickets : logs });
    b.run("authUser = {id:'test'}; operatorName = 'X'; allTickets = [];");
    assert.equal(await b.run('downloadBackup()'), true);
    const backup = JSON.parse(b.downloads[0][0]);
    assert.deepEqual(backup.tickets, tickets);
    assert.deepEqual(backup.ticket_logs, logs);
    assert.equal(backup.scope, 'current-user-visible-rows');
});

test('failed history read produces no misleading partial backup', async () => {
    const b = board({ readAllRows: async (_, table) => {
        if (table === 'ticket_logs') throw new Error('permission denied');
        return [{ id: 1 }];
    } });
    b.run("authUser = {id:'test'}; operatorName = 'X';");
    assert.equal(await b.run('downloadBackup()'), false);
    assert.equal(b.downloads.length, 0);
    assert.match(b.alerts[0], /备份失败/);
});

test('seat overlap checks match each seat and distinguish A1 from A10', () => {
    const b = board();
    b.run("allTickets = [{id:1, show:'东京场', note:'[BLOCK:A10]', seat:'5列8番'}, {id:2, show:'东京场', note:'[BLOCK:A1]', seat:'5列9番'}];");
    assert.equal(b.run("getTicket('东京场','A1','5列8番')"), undefined);
    assert.equal(b.run("findOccupant('东京场','A1','5列8番，5列9番',null).id"), 2);
    assert.equal(b.run("findOccupant('东京场','A1','5列8番,5列9番',2)"), null);
});

test('repeat action is suppressed while pending and is usable after failure', async () => {
    const b = board();
    let release;
    b.context.calls = 0;
    b.context.pending = new Promise(resolve => { release = resolve; });
    b.run("window.exampleSave = async () => { calls++; await pending; throw new Error('offline'); }; guardTicketAction('exampleSave', true);");
    const first = b.run('exampleSave()');
    await b.run('exampleSave()');
    assert.equal(b.context.calls, 1);
    release(); await first;
    assert.equal(b.run('pendingTicketWrites'), 0);
    await b.run('exampleSave()');
    assert.equal(b.context.calls, 2);
});

test('table refresh waits until the active editor is left', () => {
    const b = board();
    const tbody = b.document.getElementById('ticket-list-body');
    tbody.innerHTML = 'unsaved input';
    tbody.contains = element => !!element;
    b.document.activeElement = { matches: () => true };
    b.run('renderTicketTable()');
    assert.equal(tbody.innerHTML, 'unsaved input');
    assert.equal(b.run('ticketTableRenderPending'), true);
    b.run('window.renderCount = 0; renderTicketTable = () => { renderCount++; };');
    b.run('flushTicketTable()'); assert.equal(b.context.renderCount, 0);
    b.document.activeElement = null;
    b.run('flushTicketTable()'); assert.equal(b.context.renderCount, 1);
});

test('late responses cannot replace newer ticket data', async () => {
    const pending = [];
    const b = board({ readAllRows: () => new Promise(resolve => pending.push(resolve)) });
    b.run('rebuildTicketNoMap = () => {}; updateStatsAndHighlights = () => {};');
    const old = b.run('fetchTickets()');
    const latest = b.run('fetchTickets()');
    pending[1]([{ id: 2, created_at: '2026-09-10' }]); await latest;
    pending[0]([{ id: 1, created_at: '2026-09-09' }]); await old;
    assert.equal(b.run('allTickets[0].id'), 2);
});

test('CSV escapes formulas, quotes and multiline notes', () => {
    assert.equal(utils.csvCell('=1+1'), '"\'=1+1"');
    assert.equal(utils.csvCell('  @SUM(1)'), '"\'  @SUM(1)"');
    assert.equal(utils.csvCell('备注"甲"\n第二行'), '"备注""甲""\n第二行"');
});

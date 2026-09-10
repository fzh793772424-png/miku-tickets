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
    for (const [, reference] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
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

test('log dates consistently show the Japanese date across midnight', () => {
    assert.match(utils.formatLogDate('2026-09-10T16:05:08Z'), /2026\/09\/11.*01:05:08/);
    assert.equal(utils.formatLogDate('invalid'), '时间未知');
    assert.equal(utils.formatLogDate(null), '时间未知');
});

test('a zero-row update is a conflict, while null fields use IS NULL', async () => {
    const filters = [];
    let result = { data: null, error: null };
    const client = {
        from() { return this; }, update() { return this; },
        eq(...args) { filters.push(['eq', ...args]); return this; },
        is(...args) { filters.push(['is', ...args]); return this; },
        select() { return this; }, maybeSingle: async () => result
    };
    const ticket = { id: 1, note: '[BY:X]', memo: null, status: '在手' };
    const conflict = await utils.updateTicketChecked(client, ticket, { memo: 'draft' });
    assert.match(conflict.error.message, /已被修改/);
    assert.ok(filters.some(([fn, key, value]) => fn === 'is' && key === 'memo' && value === null));
    assert.ok(filters.some(([fn, key, value]) => fn === 'eq' && key === 'note' && value === '[BY:X]'));
    result = { data: { id: 1 }, error: null };
    assert.equal((await utils.updateTicketChecked(client, ticket, { memo: 'draft' })).error, null);
});

test('CSV and the visible table share member/status/memo filters', () => {
    const b = board();
    b.document.getElementById('filter-member').value = 'X';
    b.document.getElementById('filter-status').value = '在手';
    b.document.getElementById('filter-keyword').value = '定金';
    b.run(`allTickets = [
      {id:1,show:'东京场',seat:'待分配',status:'在手',memo:'定金300',note:'[BY:X]'},
      {id:2,show:'东京场',seat:'待分配',status:'已出',memo:'定金100',note:'[BY:X]'},
      {id:3,show:'东京场',seat:'待分配',status:'在手',memo:'定金500',note:'[BY:大瓜]'}
    ];`);
    assert.equal(b.run('getVisibleTickets().length'), 1);
    b.run('exportToCSV()');
    assert.match(b.downloads[0][0], /定金300/);
    assert.doesNotMatch(b.downloads[0][0], /定金100|定金500/);
});

test('memo draft stays in the dialog when a save conflicts', async () => {
    const b = board({ updateTicketChecked: async () => ({ error: new Error('已被修改') }) });
    let closed = false;
    b.document.getElementById('memo-dialog').close = () => { closed = true; };
    b.document.getElementById('memo-text').value = '保留我的多行备注\n面交';
    b.run("memoEditingTicket = {id:1,memo:''};");
    await b.run('saveTicketMemo()');
    assert.equal(closed, false);
    assert.equal(b.document.getElementById('memo-text').value, '保留我的多行备注\n面交');
    assert.match(b.document.getElementById('memo-error').textContent, /已被修改/);
    assert.equal(b.document.getElementById('memo-save').disabled, false);
});

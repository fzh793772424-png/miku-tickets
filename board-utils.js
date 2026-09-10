/* Shared, dependency-free helpers for the ticket board. */
(function (root) {
    'use strict';

    async function readAllRows(client, table) {
        const rows = [];
        const pageSize = 500;
        for (let offset = 0; ; offset += pageSize) {
            const { data, error } = await client.from(table).select('*')
                .order('id', { ascending: true }).range(offset, offset + pageSize - 1);
            if (error) throw error;
            if (!Array.isArray(data)) throw new Error('未收到完整的数据，请重试');
            rows.push(...data);
            if (data.length < pageSize) return rows;
        }
    }

    function csvCell(value) {
        let text = String(value == null ? '' : value);
        // Quoting alone does not stop spreadsheet formula execution.
        if (/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
    }

    function downloadFile(contents, type, filename) {
        const url = URL.createObjectURL(new Blob([contents], { type }));
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function bindAudioButton(audio, button, onError) {
        if (!audio || !button) return;
        let pending = false;
        audio.volume = 0.3;
        const sync = () => {
            const playing = !audio.paused;
            button.setAttribute('aria-pressed', String(playing));
            button.setAttribute('aria-label', playing ? '暂停背景音乐' : '播放背景音乐');
            button.title = playing ? '暂停背景音乐' : '播放背景音乐';
            button.textContent = playing ? '⏸' : '🎵';
            button.style.background = playing
                ? 'linear-gradient(135deg,#ff8fb3,#ff5c9c)'
                : 'linear-gradient(135deg,#39c5bb,#b388eb)';
        };
        ['play', 'pause', 'ended', 'error'].forEach(event => audio.addEventListener(event, sync));
        button.addEventListener('click', async () => {
            if (pending) return;
            if (!audio.paused) { audio.pause(); sync(); return; }
            pending = true;
            button.disabled = true;
            try { await audio.play(); }
            catch (error) { onError(error); }
            finally { pending = false; button.disabled = false; sync(); }
        });
        sync();
    }

    function formatLogDate(value) {
        const date = new Date(value);
        if (!value || Number.isNaN(date.getTime())) return '时间未知';
        return new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        }).format(date);
    }

    async function updateTicketChecked(client, ticket, changes) {
        try {
            let query = client.from('tickets').update(changes).eq('id', ticket.id);
            for (const field of ['note', 'seat', 'status', 'price', 'buyer', 'memo', 'show']) {
                if (!(field in ticket)) continue;
                query = ticket[field] == null ? query.is(field, null) : query.eq(field, ticket[field]);
            }
            const { data, error } = await query.select('id').maybeSingle();
            if (error) return { error };
            if (!data) return { error: new Error('这张票已被修改、转走或删除，或你没有修改权限。请刷新后核对再保存。') };
            return { data, error: null };
        } catch (error) { return { error }; }
    }

    const api = { readAllRows, csvCell, downloadFile, bindAudioButton, formatLogDate, updateTicketChecked };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TicketBoardUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

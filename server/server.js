'use strict';
/**
 * server.js — Máy chủ cục bộ của SuperClipboard.
 *
 *  - Kết nối helper .NET (nguồn sự kiện clipboard) với kho lưu trữ.
 *  - Cung cấp REST API + SSE cho giao diện.
 *  - Phục vụ tệp giao diện trong thư mục web/.
 *  - Chỉ lắng nghe trên 127.0.0.1 (không lộ ra mạng ngoài).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./store.js');
const detect = require('./detect.js');
const search = require('./search.js');
const views = require('./views.js');
const { HelperBridge } = require('./helper-bridge.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Nội dung quá lớn')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON không hợp lệ')); }
    });
    req.on('error', reject);
  });
}

function createApp(opts = {}) {
  const root = path.join(__dirname, '..');
  const dataDir = opts.dataDir || process.env.SUPERCLIP_DATA ||
    path.join(process.env.APPDATA || path.join(root, 'data'), 'SuperClipboard');
  const webDir = path.join(root, 'web');
  const helperExe = opts.helperExe || path.join(root, 'helper', 'SuperClipHelper.exe');

  const store = new Store(dataDir).init();
  const bridge = new HelperBridge({
    exePath: helperExe,
    tmpDir: path.join(dataDir, 'tmp'),
  });

  // ------------------------------------------------------------------ tiện ích

  const ctx = () => {
    const collections = new Map();
    for (const c of store.collections) collections.set(c.id, c);
    const collectionNames = new Map();
    for (const c of store.collections) collectionNames.set(c.id, c.name);
    return { collections, collectionNames };
  };

  const sseClients = new Set();
  function broadcast(type, payload) {
    const msg = `data: ${JSON.stringify({ type, payload, ts: Date.now() })}\n\n`;
    for (const res of sseClients) {
      try { res.write(msg); } catch { sseClients.delete(res); }
    }
  }

  function status() {
    return {
      helperReady: bridge.state.ready,
      helperPid: bridge.state.pid,
      helperVersion: bridge.state.version,
      kbHookError: bridge.state.kbHookError,
      latencyMs: bridge.state.latencyMs,
      focus: bridge.state.lastFocus,
      hotkeys: bridge.state.hotkeys,
      dataDir,
      paused: !!store.settings.pauseCapture,
      stats: store.stats,
      uptime: Math.round(process.uptime()),
    };
  }

  // ------------------------------------------------------------------ nối helper

  let lastClipSeq = 0;
  let autoClearTimer = null;

  bridge.on('clip', (ev) => {
    lastClipSeq = ev.seq || 0;
    const res = store.ingest(ev, bridge.state.lastFocus);
    if (!res) return;
    store.lastClipSeq = ev.seq || 0;
    scheduleSecretWipe(res.item, ev.seq || 0);
    broadcast(res.isNew ? 'item:new' : 'item:update', {
      card: views.card(res.item, ctx()),
      isNew: res.isNew,
    });
  });

  bridge.on('paste', (p) => {
    const it = store.recordPaste({ seq: p.seq, proc: p.proc, title: p.title, ts: p.ts });
    if (it) broadcast('item:update', { card: views.card(it, ctx()), isNew: false, reason: 'paste' });
  });

  bridge.on('focus', (f) => broadcast('focus', f));
  bridge.on('ready', () => broadcast('helper', status()));
  bridge.on('exit', () => broadcast('helper', status()));
  bridge.on('fatal', (e) => broadcast('error', { message: e.message }));
  bridge.on('hookfail', () => broadcast('helper', status()));

  store.on('item', (it, isNew) => { /* đã phát ở trên */ });
  store.on('removed', (id) => broadcast('item:removed', { id }));
  store.on('collections', (c) => broadcast('collections', c));
  store.on('settings', (s) => broadcast('settings', s));

  /** Tự động xoá clipboard sau khi copy bí mật (nếu bật). */
  function scheduleSecretWipe(item, seq) {
    const sec = Number(store.settings.autoClearSecretSec || 0);
    if (autoClearTimer) { clearTimeout(autoClearTimer); autoClearTimer = null; }
    if (!sec || !item.secrets || !item.secrets.length) return;
    if (store.settings.pauseCapture) return;
    autoClearTimer = setTimeout(() => {
      autoClearTimer = null;
      if (store.lastClipSeq !== seq) return;       // người dùng đã copy thứ khác
      bridge.clearClipboard();
      broadcast('clipboard:wipe', { id: item.id, afterSec: sec });
    }, Math.max(3, sec) * 1000);
  }

  // ------------------------------------------------------------------ hành động

  function targetInfo(hwnd) {
    const w = bridge.state.recentWindows.find(x => x.hwnd === hwnd);
    if (w) return { hwnd: w.hwnd, proc: (w.proc || '').replace(/\.exe$/i, ''), title: w.title || '' };
    const f = bridge.state.lastFocus;
    if (f) return { hwnd: f.hwnd, proc: (f.proc || '').replace(/\.exe$/i, ''), title: f.title || '' };
    return { hwnd: 0, proc: '', title: '' };
  }

  /**
   * Đưa nội dung của item trở lại clipboard hệ thống.
   * Trả về số thứ tự clipboard mới để ánh xạ với mục — nhờ đó Ctrl+V ngay sau đó
   * vẫn được ghi nhận đúng vào mục này.
   */
  function putOnClipboard(item) {
    return new Promise((resolve) => {
      const to = setTimeout(() => { bridge.off('ack', on); resolve(0); }, 2500);
      function on(msg) {
        if (msg.t === 'setok') { clearTimeout(to); bridge.off('ack', on); resolve(msg.seq || 0); }
      }
      bridge.on('ack', on);
      let sent = false;
      if (item.kind === 'image' && item.image) {
        const p = store.blobFile(item.image);
        if (p) sent = bridge.setImage(p);
      } else if (item.kind === 'files' && item.files && item.files.length) {
        sent = bridge.setFiles(item.files);
        if (!sent) sent = bridge.setText(item.text || '', item.html || null, item.sourceUrl || '');
      } else {
        sent = bridge.setText(item.text || '', item.html || null, item.sourceUrl || '');
      }
      if (!sent) { clearTimeout(to); bridge.off('ack', on); resolve(0); }
    });
  }

  function waitAck(what, ms = 2500) {
    return new Promise((resolve) => {
      const to = setTimeout(() => { bridge.off('ack', on); resolve(false); }, ms);
      function on(msg) {
        if (msg.t === 'setok' && (!what || msg.what === what)) {
          clearTimeout(to); bridge.off('ack', on); resolve(true);
        }
      }
      bridge.on('ack', on);
    });
  }

  async function copyItem(id) {
    const item = store.get(id);
    if (!item) return { ok: false, error: 'Không tìm thấy mục' };
    const seq = await putOnClipboard(item);
    store.mapClipboardSeq(seq, id);
    store.markUsed(id, 'SuperClipboard', 'Sao chép lại');
    return { ok: true, clipboard: true, seq };
  }

  async function pasteItem(id, hwnd) {
    const item = store.get(id);
    if (!item) return { ok: false, error: 'Không tìm thấy mục' };
    const t = targetInfo(hwnd || 0);
    const seq = await putOnClipboard(item);
    store.mapClipboardSeq(seq, id);
    await new Promise(r => setTimeout(r, 70));
    bridge.pasteTo(t.hwnd);
    store.markUsed(id, 'SuperClipboard', 'Dán tới ' + t.proc);
    store.recordPaste({ id, proc: t.proc, title: t.title, ts: Date.now() });
    const updated = store.get(id);
    broadcast('item:update', { card: views.card(updated, ctx()), isNew: false, reason: 'paste' });
    return { ok: true, target: t, seq };
  }

  function markdownReport() {
    const items = store.all().filter(i => i.secrets && i.secrets.length)
      .sort((a, b) => (b.lastCopiedAt || 0) - (a.lastCopiedAt || 0));
    const lines = [];
    lines.push('# Kho bí mật — SuperClipboard');
    lines.push('');
    lines.push(`_Xuất lúc ${new Date().toLocaleString('vi-VN')} · ${items.length} bí mật_`);
    lines.push('');
    lines.push('| Dịch vụ | Giá trị (đã che) | Nguồn | Đã dán vào | Copy cuối |');
    lines.push('|---|---|---|---|---|');
    for (const it of items) {
      const s = it.secrets[0];
      const dest = views.pasteSummary(it).map(d => d.app).join(', ') || '—';
      const src = it.sourceUrl ? `[${it.sourceDomain || it.sourceUrl}](${it.sourceUrl})` : (it.origin.app || '—');
      lines.push(`| ${s.label} | \`${s.masked}\` | ${src} | ${dest} | ${new Date(it.lastCopiedAt || it.createdAt).toLocaleString('vi-VN')} |`);
    }
    lines.push('');
    lines.push('## Nguồn theo tên miền');
    const sites = new Map();
    for (const it of items) {
      if (!it.sourceDomain) continue;
      const e = sites.get(it.sourceDomain) || { n: 0, url: it.sourceUrl, last: 0 };
      e.n++; e.last = Math.max(e.last, it.lastCopiedAt || 0);
      sites.set(it.sourceDomain, e);
    }
    for (const [d, e] of [...sites.entries()].sort((a, b) => b[1].n - a[1].n)) {
      lines.push(`- **${d}** — ${e.n} bí mật · lần cuối ${new Date(e.last).toLocaleString('vi-VN')} · ${e.url}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ định tuyến

  async function handleApi(req, res, u) {
    const p = u.pathname;
    const q = u.searchParams;
    const json = (obj, code = 200) => {
      const body = Buffer.from(JSON.stringify(obj), 'utf8');
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    };

    // ---- SSE ----
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1500\n\n');
      res.write(`data: ${JSON.stringify({ type: 'hello', payload: status() })}\n\n`);
      sseClients.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { } }, 20000);
      req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
      return;
    }

    // ---- Ảnh trong kho ----
    if (p.startsWith('/api/blob/')) {
      const f = store.blobFile(decodeURIComponent(p.slice('/api/blob/'.length)));
      if (!f) { res.writeHead(404); res.end('not found'); return; }
      const st = fs.statSync(f);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      fs.createReadStream(f).pipe(res);
      return;
    }

    // ---- Trạng thái / khởi tạo ----
    if (p === '/api/state') {
      const c = ctx();
      return json({
        status: status(),
        settings: store.settings,
        collections: store.collections,
        facets: search.facets(store.all()),
        overview: store.overview(),
        items: search.search(store.all(), '', { ctx: c, scope: 'all', limit: 120 }).items
          .map(it => views.card(it, c)),
        total: store.items.size,
        targets: bridge.state.recentWindows.slice(0, 12),
      });
    }

    if (p === '/api/status') return json(status());

    if (p === '/api/facets') return json(search.facets(store.all()));

    if (p === '/api/targets') {
      const list = bridge.state.recentWindows.slice(0, 20).map(w => ({ ...w, proc: (w.proc || '').replace(/\.exe$/i, '') }));
      const f = bridge.state.lastFocus;
      return json({ targets: list, focus: f ? { ...f, proc: (f.proc || '').replace(/\.exe$/i, '') } : null });
    }

    // ---- Danh sách ----
    if (p === '/api/items' && req.method === 'GET') {
      const c = ctx();
      const r = search.search(store.all(), q.get('query') || q.get('q') || '', {
        ctx: c,
        scope: q.get('scope') || 'all',
        collectionId: q.get('collection') || null,
        sort: q.get('sort') || null,
        limit: parseInt(q.get('limit') || '120', 10),
        offset: parseInt(q.get('offset') || '0', 10),
      });
      return json({
        total: r.total,
        offset: parseInt(q.get('offset') || '0', 10),
        items: r.items.map(it => views.card(it, c)),
        parsed: r.parsed,
        sort: r.sort,
      });
    }

    // ---- Một mục ----
    const mItem = /^\/api\/items\/([a-f0-9]{6,32})(?:\/(\w+))?$/.exec(p);
    if (mItem) {
      const id = mItem[1];
      const action = mItem[2];
      const c = ctx();
      const item = store.get(id);
      if (!item) return json({ error: 'Không tìm thấy mục' }, 404);

      if (!action && req.method === 'GET') {
        const reveal = q.get('reveal') === '1';
        return json({
          item: views.full(item, c, { reveal }),
          lineage: views.lineage(store, id, c),
        });
      }
      if (action === 'reveal' && req.method === 'POST') {
        return json({ text: item.text || '', secrets: item.secrets || [] });
      }
      if (action === 'copy' && req.method === 'POST') return json(await copyItem(id));
      if (action === 'paste' && req.method === 'POST') {
        const body = await readBody(req);
        return json(await pasteItem(id, body.hwnd | 0));
      }
      if (action === 'delete' && req.method === 'POST') {
        store.remove(id);
        return json({ ok: true });
      }
      if (req.method === 'POST' || req.method === 'PATCH') {
        const body = await readBody(req);
        const updated = store.update(id, body);
        if (!updated) return json({ error: 'Không cập nhật được' }, 400);
        broadcast('item:update', { card: views.card(updated, c), isNew: false, reason: 'edit' });
        return json({ ok: true, item: views.full(updated, c, {}) });
      }
      if (req.method === 'DELETE') { store.remove(id); return json({ ok: true }); }
    }

    // ---- Bộ sưu tập ----
    if (p === '/api/collections') {
      if (req.method === 'GET') return json({ collections: store.collections });
      if (req.method === 'POST') {
        const body = await readBody(req);
        return json({ collection: store.createCollection(body.name, body.color) });
      }
    }
    const mColl = /^\/api\/collections\/([a-f0-9]{6,32})$/.exec(p);
    if (mColl) {
      if (req.method === 'PATCH' || req.method === 'POST') {
        const body = await readBody(req);
        return json({ collection: store.renameCollection(mColl[1], body) });
      }
      if (req.method === 'DELETE') { store.deleteCollection(mColl[1]); return json({ ok: true }); }
    }

    // ---- Cài đặt ----
    if (p === '/api/settings') {
      if (req.method === 'GET') return json({ settings: store.settings });
      if (req.method === 'PATCH' || req.method === 'POST') {
        const body = await readBody(req);
        return json({ settings: store.setSettings(body) });
      }
    }

    // ---- Hành động hệ thống ----
    if (p === '/api/actions/clear' && req.method === 'POST') {
      const body = await readBody(req);
      store.clearAll(!!body.keepPinned);
      bridge.snapshot();
      return json({ ok: true, total: store.items.size });
    }
    if (p === '/api/actions/wipe-clipboard' && req.method === 'POST') {
      bridge.clearClipboard();
      return json({ ok: true });
    }
    if (p === '/api/actions/pause' && req.method === 'POST') {
      const body = await readBody(req);
      const paused = body.paused == null ? !store.settings.pauseCapture : !!body.paused;
      store.setSettings({ pauseCapture: paused });
      return json({ ok: true, paused });
    }
    if (p === '/api/actions/hotkey' && req.method === 'POST') {
      const body = await readBody(req);
      const ok = bridge.registerHotkey(body.id || 1, body.mods || 3, body.vk || 0x56);
      return json({ ok });
    }
    if (p === '/api/actions/focus' && req.method === 'POST') {
      const body = await readBody(req);
      bridge.focusTitle(body.title || '');
      return json({ ok: true });
    }
    if (p === '/api/actions/snapshot' && req.method === 'POST') {
      bridge.snapshot();
      return json({ ok: true });
    }

    // ---- Xuất dữ liệu ----
    if (p === '/api/export') {
      const body = Buffer.from(JSON.stringify(store.exportJson(), null, 2), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="superclipboard-export.json"',
        'Content-Length': body.length,
      });
      return res.end(body);
    }
    if (p === '/api/report.md') {
      const body = Buffer.from(markdownReport(), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="kho-bi-mat.md"',
        'Content-Length': body.length,
      });
      return res.end(body);
    }

    return json({ error: 'Không rõ endpoint: ' + p }, 404);
  }

  function serveStatic(req, res, u) {
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '/index.html') rel = '/index.html';
    else if (rel === '/palette') rel = '/palette.html';
    else if (rel === '/icon.png') rel = '/icon.png';
    let file;
    if (rel === '/icon.png') file = path.join(root, 'assets', 'icon.png');
    else file = path.join(webDir, rel.replace(/^\/+/, ''));
    const norm = path.normalize(file);
    if (!norm.startsWith(webDir) && !norm.startsWith(path.join(root, 'assets'))) {
      res.writeHead(403); return res.end('forbidden');
    }
    fs.stat(norm, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(norm).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(norm).pipe(res);
    });
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      res.writeHead(403); return res.end('origin bị từ chối');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Allow': 'GET,POST,PATCH,DELETE' });
      return res.end();
    }
    if (u.pathname.startsWith('/api/')) {
      handleApi(req, res, u).catch((e) => {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: e.message }));
        } catch { }
      });
      return;
    }
    serveStatic(req, res, u);
  });

  function listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address().port));
    });
  }

  function start() { bridge.start(); }

  function stop() {
    bridge.stop();
    for (const c of sseClients) { try { c.end(); } catch { } }
    try { server.close(); } catch { }
  }

  return { server, store, bridge, ctx, listen, start, stop, status, dataDir, broadcast };
}

module.exports = { createApp };

// ------------------------------------------------------------------ chạy trực tiếp

if (require.main === module) {
  const app = createApp({});
  const port = parseInt(process.env.PORT || '4317', 10);
  app.listen(port).then((p) => {
    console.log(`SuperClipboard server: http://127.0.0.1:${p}`);
    console.log(`Dữ liệu: ${app.dataDir}`);
    app.start();
  }).catch((e) => { console.error('Không mở được cổng:', e.message); process.exit(1); });
  process.on('SIGINT', () => { app.stop(); process.exit(0); });
}

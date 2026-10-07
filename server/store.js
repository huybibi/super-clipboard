'use strict';
/**
 * store.js — Kho lưu trữ bền vững cho SuperClipboard.
 *
 * Thiết kế:
 *  - `items.ndjson`: nhật ký chỉ ghi thêm (append-only). Mỗi dòng là một bản ghi đầy đủ;
 *    dòng sau (cùng id) ghi đè dòng trước. Nạp lại = phát lại nhật ký. Không cần CSDL native.
 *  - `blobs/<sha256>.png`: ảnh lưu thành tệp riêng, tự động khử trùng theo nội dung.
 *  - `meta.json`: collections + cài đặt.
 *  - Chỉ mục trong bộ nhớ: Map theo id, theo hash, theo seq clipboard, và chỉ mục từ khóa.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const detect = require('./detect.js');

const SCHEMA = 2;
const MAX_COPIES_KEPT = 60;
const MAX_PASTES_KEPT = 120;
const MAX_HTML_KEPT = 200 * 1024;
const MAX_TEXT_KEPT = 4 * 1024 * 1024;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function nowMs() { return Date.now(); }

/** Bỏ tham số theo dõi trong URL để "tìm lại đúng trang nguồn" sạch sẽ hơn. */
function cleanUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const junk = [];
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref|referrer|source|si|igshid|_ga)/i.test(k)) junk.push(k);
    }
    junk.forEach(k => u.searchParams.delete(k));
    u.hash = '';
    return u.toString();
  } catch { return url; }
}

function shortId() {
  return crypto.randomBytes(8).toString('hex');
}

class Store extends EventEmitter {
  constructor(dataDir) {
    super();
    this.setMaxListeners(0);
    this.dataDir = dataDir;
    /** pid của tiến trình đang chạy app — dùng để bỏ qua nội dung copy từ chính mình. */
    this.selfPid = process.pid;
    this.blobDir = path.join(dataDir, 'blobs');
    this.logPath = path.join(dataDir, 'items.ndjson');
    this.metaPath = path.join(dataDir, 'meta.json');
    this.items = new Map();       // id -> item
    this.byHash = new Map();      // hash -> id
    this.bySeq = new Map();       // seq clipboard -> id
    this.recentSeq = [];          // hàng đợi giới hạn cho bySeq
    this.collections = [];
    this.settings = {
      maxItems: 5000,
      retentionDays: 90,
      captureImages: true,
      trackPastes: true,
      ignoreApps: [],
      ignorePatterns: [],
      autoPaste: true,
      pauseCapture: false,
      startOnLogin: false,
      updateCheck: false,
    };
    this.logLines = 0;
    this.stats = { captured: 0, deduped: 0, pastes: 0, copies: 0 };
  }

  // ------------------------------------------------------------------ khởi động

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.blobDir, { recursive: true });
    this._loadMeta();
    this._loadLog();
    this._compactIfNeeded(true);
    return this;
  }

  _loadMeta() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (Array.isArray(raw.collections)) this.collections = raw.collections;
        if (raw.settings) Object.assign(this.settings, raw.settings);
      }
    } catch { /* lần chạy đầu tiên */ }
  }

  _saveMeta() {
    const tmp = this.metaPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      schema: SCHEMA, collections: this.collections, settings: this.settings,
    }, null, 2));
    fs.renameSync(tmp, this.metaPath);
  }

  _loadLog() {
    let raw = '';
    try { raw = fs.readFileSync(this.logPath, 'utf8'); } catch { return; }
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      this.logLines++;
      try {
        const rec = JSON.parse(line);
        if (!rec || !rec.id) continue;
        // Dòng bia mộ: mục đã bị xoá, phải biến mất chứ không được nạp lại.
        if (rec._deleted) { this.items.delete(rec.id); continue; }
        // Bỏ qua bản ghi hỏng/thiếu dữ liệu, tránh sinh ra mục "(rỗng)".
        if (!rec.kind) continue;
        this.items.set(rec.id, rec);
      } catch { /* bỏ dòng hỏng */ }
    }
    for (const it of this.items.values()) if (it.hash) this.byHash.set(it.hash, it.id);
  }

  _append(rec) {
    try {
      fs.appendFileSync(this.logPath, JSON.stringify(rec) + '\n');
      this.logLines++;
    } catch (e) {
      this.emit('error', e);
    }
  }

  _persist(it) {
    this.items.set(it.id, it);
    this.byHash.set(it.hash, it.id);
    this._append(it);
  }

  /** Nén nhật ký khi số dòng phình to hơn nhiều so với số bản ghi thật. */
  _compactIfNeeded(force) {
    if (!force && this.logLines < this.items.size * 2 + 200) return;
    try {
      const tmp = this.logPath + '.tmp';
      const fd = fs.openSync(tmp, 'w');
      for (const it of this.items.values()) fs.writeSync(fd, JSON.stringify(it) + '\n');
      fs.closeSync(fd);
      fs.renameSync(tmp, this.logPath);
      this.logLines = this.items.size;
    } catch (e) { this.emit('error', e); }
  }

  // ------------------------------------------------------------------ ghi nội dung

  _blobPath(name) { return path.join(this.blobDir, name); }

  /** Lưu ảnh từ tệp tạm của helper vào kho blob, khử trùng theo nội dung. */
  _ingestImage(tmpFile) {
    const buf = fs.readFileSync(tmpFile);
    const hash = sha256(buf);
    const name = hash.slice(0, 32) + '.png';
    const dest = this._blobPath(name);
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
    try { fs.unlinkSync(tmpFile); } catch { }
    return { name, hash, bytes: buf.length };
  }

  /**
   * Nhận một sự kiện copy từ helper và biến nó thành (hoặc cập nhật) một item.
   * Trả về { item, isNew } hoặc null nếu bị bỏ qua.
   */
  ingest(ev, focusInfo) {
    if (this.settings.pauseCapture) return null;

    const kind = ev.kind;
    if (kind !== 'text' && kind !== 'image' && kind !== 'files' && kind !== 'html') return null;
    if (kind === 'image' && !this.settings.captureImages) return null;

    const app = (ev.srcProc || (focusInfo && focusInfo.proc) || '').replace(/\.exe$/i, '');
    if (app && this.settings.ignoreApps.includes(app.toLowerCase())) return null;

    // Bỏ qua nội dung được copy trong khi CHÍNH cửa sổ SuperClipboard đang được focus.
    // Nhờ vậy các công cụ kiểm thử (và thao tác copy bên trong app) không làm rác kho.
    if (this.selfPid && ev.srcPid && ev.srcPid === this.selfPid) return null;

    let text = ev.text != null ? String(ev.text) : '';
    if (text.length > MAX_TEXT_KEPT) text = text.slice(0, MAX_TEXT_KEPT);
    const sourceUrl = cleanUrl(ev.sourceUrl || '');
    const title = ev.srcTitle || (focusInfo && focusInfo.title) || '';

    // Bỏ qua các nội dung vô nghĩa
    if (kind === 'text' && text.trim().length === 0) return null;
    for (const pat of this.settings.ignorePatterns) {
      try { if (new RegExp(pat, 'i').test(text)) return null; } catch { }
    }

    let hash, imageName = null, bytes = 0, width = 0, height = 0;
    let fileList = [];
    if (kind === 'image') {
      if (!ev.imageFile || !fs.existsSync(ev.imageFile)) return null;
      const info = this._ingestImage(ev.imageFile);
      imageName = info.name; bytes = info.bytes; width = ev.width | 0; height = ev.height | 0;
      hash = 'img:' + info.hash;
    } else if (kind === 'files') {
      const files = Array.isArray(ev.files) ? ev.files : [];
      hash = 'files:' + sha256(files.join('\n'));
      text = files.join('\n');
      fileList = files;
    } else {
      hash = 'txt:' + sha256(detect.canonical(text) + '\u0000' + sourceUrl);
      if (!detect.canonical(text) && ev.html) hash = 'html:' + sha256(detect.canonical(ev.html));
    }

    const ts = ev.ts || nowMs();
    const existingId = this.byHash.get(hash);

    // ---- Đã có: chỉ cập nhật lịch sử sử dụng ----
    if (existingId) {
      const it = this.items.get(existingId);
      if (it) {
        this.stats.deduped++;
        const internal = app.toLowerCase() === 'superclipboard';
        if (!internal) it.copyCount = (it.copyCount || 1) + 1;
        it.lastCopiedAt = ts;
        it.usedAt = ts;
        if (!it.sourceUrl && sourceUrl) { it.sourceUrl = sourceUrl; it.sourceDomain = detect.domainOf(sourceUrl); }
        it.copies = it.copies || [];
        it.copies.push({ ts, app, title, url: sourceUrl, internal });
        if (it.copies.length > MAX_COPIES_KEPT) it.copies = it.copies.slice(-MAX_COPIES_KEPT);
        if (ev.seq) this._mapSeq(ev.seq, it.id);
        this._persist(it);
        this.emit('item', it, false);
        return { item: it, isNew: false };
      }
    }

    // ---- Mới ----
    const info = detect.classify({ kind, text });
    const html = ev.html && ev.html.length <= MAX_HTML_KEPT ? ev.html : null;
    const item = {
      id: shortId(),
      hash,
      kind,
      text: text || '',
      html,
      sourceUrl: sourceUrl || '',
      sourceDomain: detect.domainOf(sourceUrl),
      sourceTitle: title,
      image: imageName,
      bytes, width, height,
      files: fileList,
      createdAt: ts,
      lastCopiedAt: ts,
      copyCount: 1,
      origin: { app, title, pid: ev.srcPid || 0, exe: focusInfo ? focusInfo.exe || '' : '' },
      copies: [{ ts, app, title, url: sourceUrl, internal: app.toLowerCase() === 'superclipboard' }],
      pastes: [],
      tags: info.tags,
      secrets: info.secrets.map(s => ({ id: s.id, label: s.label, severity: s.severity, color: s.color, masked: s.masked })),
      collections: [],
      pinned: false,
      note: '',
      important: 0,
    };
    item.important = detect.importance(item);
    this.stats.captured++;
    if (ev.seq) this._mapSeq(ev.seq, item.id);
    this._persist(item);
    this.emit('item', item, true);
    this._enforceLimits();
    return { item, isNew: true };
  }

  _mapSeq(seq, id) {
    this.bySeq.set(String(seq), id);
    this.recentSeq.push(String(seq));
    while (this.recentSeq.length > 400) {
      const old = this.recentSeq.shift();
      if (!this.recentSeq.includes(old)) this.bySeq.delete(old);
    }
  }

  /**
   * Gắn số thứ tự clipboard (do helper trả về khi ta tự đặt nội dung) với một mục.
   * Nhờ vậy khi người dùng bấm Ctrl+V ngay sau đó, app biết CHÍNH XÁC đã dán mục nào.
   */
  mapClipboardSeq(seq, id) {
    if (!seq) return;
    this._mapSeq(String(seq), id);
  }

  /** Ghi nhận một thao tác dán (Ctrl+V) vào item tương ứng. */
  recordPaste(paste) {
    if (!this.settings.trackPastes) return null;
    const id = paste.id || (paste.seq ? this.bySeq.get(String(paste.seq)) : null);
    const item = id ? this.items.get(id) : this.lastItem();
    if (!item) return null;
    const app = (paste.proc || '').replace(/\.exe$/i, '');
    if (app.toLowerCase() === 'superclipboard') return null;   // dán ngay trong app thì bỏ qua
    item.pastes = item.pastes || [];
    const last = item.pastes[item.pastes.length - 1];
    // Gộp nếu dán liên tiếp vào cùng một ứng dụng trong 3 giây
    if (last && last.app === app && last.title === paste.title && (paste.ts - last.ts) < 3000) {
      last.count = (last.count || 1) + 1;
      last.ts = paste.ts;
    } else {
      item.pastes.push({ ts: paste.ts, app, title: paste.title || '', count: 1 });
      if (item.pastes.length > MAX_PASTES_KEPT) item.pastes = item.pastes.slice(-MAX_PASTES_KEPT);
    }
    item.lastPastedAt = paste.ts;
    item.important = detect.importance(item);
    this.stats.pastes++;
    this._persist(item);
    this.emit('item', item, false);
    return item;
  }

  /** Ghi nhận việc ứng dụng tự đưa một item vào clipboard để dùng. */
  markUsed(id, app, title) {
    const item = this.items.get(id);
    if (!item) return null;
    item.lastUsedAt = nowMs();
    item.usedCount = (item.usedCount || 0) + 1;
    item.important = detect.importance(item);
    this.stats.copies++;
    this._persist(item);
    this.emit('item', item, false);
    return item;
  }

  lastItem() {
    let best = null;
    for (const it of this.items.values()) if (!best || it.lastCopiedAt > best.lastCopiedAt) best = it;
    return best;
  }

  // ------------------------------------------------------------------ sửa đổi

  update(id, patch) {
    const it = this.items.get(id);
    if (!it) return null;
    const allowed = ['pinned', 'note', 'collections', 'tags'];
    for (const k of allowed) if (k in patch) it[k] = patch[k];
    if (Array.isArray(it.tags)) {
      it.tags = [...new Set(it.tags
        .map(t => String(t).trim().slice(0, 32))
        .filter(Boolean))].slice(0, 30);
    }
    it.important = detect.importance(it);
    this._persist(it);
    this.emit('item', it, false);
    return it;
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return false;
    this.items.delete(id);
    this.byHash.delete(it.hash);
    if (it.image) { try { fs.unlinkSync(this._blobPath(it.image)); } catch { } }
    this._append({ id, _deleted: true, hash: it.hash });
    this.emit('removed', id);
    return true;
  }

  clearAll(keepPinned) {
    for (const it of [...this.items.values()]) {
      if (keepPinned && it.pinned) continue;
      this.remove(it.id);
    }
    this._compactIfNeeded(true);
  }

  // ------------------------------------------------------------------ collections

  createCollection(name, color) {
    const c = { id: shortId(), name: String(name || 'Bộ sưu tập').slice(0, 60), color: color || '#6366f1', createdAt: nowMs() };
    this.collections.push(c);
    this._saveMeta();
    this.emit('collections', this.collections);
    return c;
  }

  renameCollection(id, patch) {
    const c = this.collections.find(x => x.id === id);
    if (!c) return null;
    if (patch.name) c.name = String(patch.name).slice(0, 60);
    if (patch.color) c.color = patch.color;
    this._saveMeta();
    this.emit('collections', this.collections);
    return c;
  }

  deleteCollection(id) {
    this.collections = this.collections.filter(c => c.id !== id);
    for (const it of this.items.values()) {
      if (it.collections && it.collections.includes(id)) {
        it.collections = it.collections.filter(x => x !== id);
        this._persist(it);
      }
    }
    this._saveMeta();
    this.emit('collections', this.collections);
  }

  setSettings(patch) {
    Object.assign(this.settings, patch || {});
    this._saveMeta();
    this.emit('settings', this.settings);
    return this.settings;
  }

  // ------------------------------------------------------------------ dọn dẹp

  _enforceLimits() {
    const { maxItems, retentionDays } = this.settings;
    const cutoff = retentionDays > 0 ? nowMs() - retentionDays * 86400000 : 0;
    const list = [...this.items.values()]
      .filter(it => !it.pinned)
      .sort((a, b) => (a.lastCopiedAt || 0) - (b.lastCopiedAt || 0));
    let removed = 0;
    while (list.length > Math.max(0, maxItems)) {
      const it = list.shift();
      this.remove(it.id);
      removed++;
    }
    if (cutoff > 0) {
      for (const it of list) {
        if ((it.lastCopiedAt || 0) < cutoff) { this.remove(it.id); removed++; }
      }
    }
    if (removed) this._compactIfNeeded(false);
  }

  // ------------------------------------------------------------------ truy vấn

  get(id) { return this.items.get(id) || null; }

  all() { return [...this.items.values()]; }

  /** Toàn bộ "gia đình" của một bí mật: A1, A2, A3... cùng dịch vụ, cùng nguồn. */
  lineage(id) {
    const it = this.items.get(id);
    if (!it) return null;
    const secret = (it.secrets && it.secrets[0]) || null;
    const family = secret ? detect.secretFamily(secret, it.sourceDomain) : null;
    const siblings = family
      ? this.all().filter(x => x.id !== it.id && x.secrets && x.secrets.length &&
          detect.secretFamily(x.secrets[0], x.sourceDomain) === family)
        .sort((a, b) => a.createdAt - b.createdAt)
      : [];
    const timeline = [];
    for (const c of (it.copies || [])) {
      timeline.push({ type: 'copy', ts: c.ts, app: c.app, title: c.title, url: c.url, internal: c.internal });
    }
    for (const p of (it.pastes || [])) {
      timeline.push({ type: 'paste', ts: p.ts, app: p.app, title: p.title, count: p.count || 1 });
    }
    timeline.sort((a, b) => a.ts - b.ts);

    const destinations = new Map();
    for (const p of (it.pastes || [])) {
      const key = (p.app || '?').toLowerCase();
      const d = destinations.get(key) || { app: p.app || '?', title: p.title || '', count: 0, last: 0 };
      d.count += p.count || 1;
      d.last = Math.max(d.last, p.ts);
      if (p.title) d.title = p.title;
      destinations.set(key, d);
    }
    return {
      item: it,
      secret,
      family,
      siblings: siblings.map(s => ({ id: s.id, createdAt: s.createdAt, masked: s.secrets[0].masked, app: s.origin.app })),
      timeline,
      destinations: [...destinations.values()].sort((a, b) => b.count - a.count),
    };
  }

  /** Thống kê tổng quan cho trang chủ. */
  overview() {
    const items = this.all();
    const byApp = new Map();
    const bySite = new Map();
    const secrets = [];
    for (const it of items) {
      const a = (it.origin && it.origin.app) || 'không rõ';
      byApp.set(a, (byApp.get(a) || 0) + 1);
      if (it.sourceDomain) bySite.set(it.sourceDomain, (bySite.get(it.sourceDomain) || 0) + 1);
      if (it.secrets && it.secrets.length) secrets.push(it);
    }
    const pasteTargets = new Map();
    for (const it of items) for (const p of (it.pastes || [])) {
      const k = p.app || '?';
      pasteTargets.set(k, (pasteTargets.get(k) || 0) + (p.count || 1));
    }
    return {
      total: items.length,
      secrets: secrets.length,
      pastes: this.stats.pastes,
      deduped: this.stats.deduped,
      images: items.filter(i => i.kind === 'image').length,
      pinned: items.filter(i => i.pinned).length,
      topApps: [...byApp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n })),
      topSites: [...bySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n })),
      topDestinations: [...pasteTargets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n })),
    };
  }

  blobFile(name) {
    const safe = path.basename(String(name || ''));
    if (!/^[a-f0-9]{8,64}\.png$/.test(safe)) return null;
    const p = this._blobPath(safe);
    return fs.existsSync(p) ? p : null;
  }

  exportJson() {
    return {
      exportedAt: new Date().toISOString(),
      schema: SCHEMA,
      collections: this.collections,
      items: this.all().map(it => ({ ...it, imageData: undefined })),
    };
  }
}

module.exports = { Store, cleanUrl, sha256 };

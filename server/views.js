'use strict';
/**
 * views.js — Biến bản ghi trong kho thành dữ liệu gọn cho giao diện.
 *
 * Nguyên tắc an toàn: giá trị bí mật KHÔNG được gửi ra giao diện theo mặc định.
 * Giao diện chỉ nhận bản đã che; muốn xem thật phải gọi endpoint /reveal.
 */

const detect = require('./detect.js');

function domainOf(url) { return detect.domainOf(url); }

function collectionInfo(it, ctx) {
  if (!ctx || !ctx.collections) return [];
  return (it.collections || [])
    .map(id => ctx.collections.get(id))
    .filter(Boolean)
    .map(c => ({ id: c.id, name: c.name, color: c.color }));
}

/** Che mọi bí mật xuất hiện trong văn bản, giữ nguyên bố cục. */
function maskSecretsIn(text) {
  if (!text) return { text: '', found: [] };
  const found = detect.findSecrets(text);
  if (!found.length) return { text, found: [] };
  let out = '';
  let last = 0;
  for (const s of found) {
    if (s.start < last) continue;
    out += text.slice(last, s.start) + s.masked;
    last = s.end;
  }
  out += text.slice(last);
  return { text: out, found };
}

function firstLine(text, max = 110) {
  const s = String(text || '').replace(/\r/g, '');
  const line = s.split('\n').find(l => l.trim().length) || '';
  const t = line.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function previewOf(it, maskedText) {
  if (it.kind === 'image') return `Ảnh ${it.width || '?'}×${it.height || '?'} · ${fmtBytes(it.bytes)}`;
  if (it.kind === 'files') return (it.files || []).map(f => f.split(/[\\/]/).pop()).join(', ');
  const t = String(maskedText || '').replace(/\s+/g, ' ').trim();
  return t.length > 220 ? t.slice(0, 219) + '…' : t;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function pasteSummary(it) {
  const map = new Map();
  for (const p of (it.pastes || [])) {
    const k = (p.app || '?');
    const e = map.get(k) || { app: k, count: 0, last: 0, title: '' };
    e.count += p.count || 1;
    if (p.ts > e.last) { e.last = p.ts; e.title = p.title || ''; }
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** Thẻ rút gọn cho danh sách. */
function card(it, ctx) {
  const masked = it.kind === 'image' || it.kind === 'files'
    ? { text: it.text, found: [] }
    : maskSecretsIn(it.text);
  const pastes = pasteSummary(it);
  return {
    id: it.id,
    kind: it.kind,
    title: it.kind === 'image' ? 'Ảnh ' + (it.width || '?') + '×' + (it.height || '?')
      : it.kind === 'files' ? (it.files && it.files[0] ? it.files[0].split(/[\\/]/).pop() : 'Tệp')
        : (firstLine(masked.text) || '(rỗng)'),
    preview: previewOf(it, masked.text),
    lineCount: it.text ? String(it.text).split('\n').length : 0,
    charCount: it.text ? String(it.text).length : 0,
    tags: it.tags || [],
    secrets: (it.secrets || []).map(s => ({ id: s.id, label: s.label, severity: s.severity, color: s.color, masked: s.masked })),
    secretCount: (it.secrets || []).length,
    sourceApp: (it.origin && it.origin.app) || '',
    sourceTitle: it.sourceTitle || (it.origin && it.origin.title) || '',
    sourceUrl: it.sourceUrl || '',
    sourceDomain: it.sourceDomain || '',
    createdAt: it.createdAt,
    lastCopiedAt: it.lastCopiedAt,
    lastPastedAt: it.lastPastedAt || 0,
    lastUsedAt: it.lastUsedAt || 0,
    copyCount: it.copyCount || 1,
    usedCount: it.usedCount || 0,
    pasteCount: pastes.reduce((a, x) => a + x.count, 0),
    pasteApps: pastes.slice(0, 4),
    pinned: !!it.pinned,
    hasNote: !!(it.note && it.note.trim()),
    note: it.note || '',
    important: it.important || 0,
    collections: collectionInfo(it, ctx),
    image: it.image ? '/api/blob/' + it.image : null,
    width: it.width || 0,
    height: it.height || 0,
    bytes: it.bytes || 0,
    files: it.files || [],
  };
}

/** Bản đầy đủ cho bảng chi tiết (mặc định đã che bí mật). */
function full(it, ctx, opts = {}) {
  const reveal = !!opts.reveal;
  const base = card(it, ctx);
  const masked = reveal ? { text: it.text, found: [] } : maskSecretsIn(it.text);
  return {
    ...base,
    text: masked.text,
    revealed: reveal,
    html: reveal && it.html && it.html.length < 200000 ? it.html : null,
    hasHtml: !!it.html,
    secretValues: reveal ? (it.secrets || []).map(s => ({ id: s.id, label: s.label, masked: s.masked })) : [],
    origin: {
      app: (it.origin && it.origin.app) || '',
      title: (it.origin && it.origin.title) || '',
      exe: (it.origin && it.origin.exe) || '',
    },
    copies: (it.copies || []).slice(-60),
    pastes: (it.pastes || []).slice(-80),
  };
}

/** Toàn bộ "gia đình" của một bí mật: A1, A2, A3… cùng dịch vụ, cùng nguồn. */
function lineage(store, id, ctx) {
  const l = store.lineage(id);
  if (!l) return null;
  const cur = l.item;
  return {
    family: l.family,
    siblingCount: l.siblings.length,
    siblings: [
      ...l.siblings.map(s => ({ id: s.id, createdAt: s.createdAt, masked: s.masked, app: s.app, current: false })),
      { id: cur.id, createdAt: cur.createdAt, masked: l.secret ? l.secret.masked : firstLine(cur.text, 40), app: cur.origin.app, current: true },
    ].sort((a, b) => a.createdAt - b.createdAt),
    destinations: l.destinations,
    timeline: l.timeline,
  };
}

module.exports = { card, full, lineage, maskSecretsIn, firstLine, fmtBytes, pasteSummary, domainOf };

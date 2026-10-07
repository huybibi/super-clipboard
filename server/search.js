'use strict';
/**
 * search.js — Tìm kiếm thông minh cho SuperClipboard.
 *
 * Trả lời trực tiếp câu hỏi của người dùng:
 *   "một lúc sau tôi lại muốn tìm lại url X để tạo thêm key A2 A3"
 * => phải tìm được theo: nội dung, tên miền nguồn, ứng dụng nguồn,
 *    ứng dụng đã dán, nhãn, bộ sưu tập, khoảng thời gian...
 *
 * Hỗ trợ tiếng Việt có dấu lẫn không dấu ("khoá" = "khoa").
 */

// ------------------------------------------------------------------ tiện ích

const DIACRITICS = [
  [/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a'],
  [/[ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴ]/g, 'a'],
  [/[èéẹẻẽêềếệểễ]/g, 'e'],
  [/[ÈÉẸẺẼÊỀẾỆỂỄ]/g, 'e'],
  [/[ìíịỉĩ]/g, 'i'],
  [/[ÌÍỊỈĨ]/g, 'i'],
  [/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o'],
  [/[ÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠ]/g, 'o'],
  [/[ùúụủũưừứựửữ]/g, 'u'],
  [/[ÙÚỤỦŨƯỪỨỰỬỮ]/g, 'u'],
  [/[ỳýỵỷỹ]/g, 'y'],
  [/[ỲÝỴỶỸ]/g, 'y'],
  [/đ/g, 'd'], [/Đ/g, 'd'],
];

/** Bỏ dấu tiếng Việt + thường hoá. */
function stripDiacritics(s) {
  let out = String(s == null ? '' : s);
  for (const [re, rep] of DIACRITICS) out = out.replace(re, rep);
  return out;
}

/** Chuẩn hoá để so khớp: không dấu, không phân biệt hoa thường, gộp khoảng trắng. */
function normalize(s) {
  return stripDiacritics(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Tách truy vấn thành các "token" (tôn trọng dấu ngoặc kép, kể cả sau tiền tố `site:`). */
function tokenize(q) {
  const out = [];
  const re = /([A-Za-z\u00C0-\u024F_-]+):"([^"]*)"|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    if (m[1] != null) out.push({ text: m[1] + ':' + m[2], quoted: true });
    else if (m[3] != null) out.push({ text: m[3], quoted: true });
    else out.push({ text: m[4], quoted: false });
  }
  return out;
}

// ------------------------------------------------------------------ cú pháp

const KEY_ALIASES = {
  app: 'app', 'ung-dung': 'app', tu: 'app', nguon: 'app', 'nguồn': 'app',
  site: 'site', domain: 'site', trang: 'site', web: 'site', host: 'site',
  tag: 'tag', nhan: 'tag', 'nhãn': 'tag', loai: 'kind', 'loại': 'kind', kind: 'kind',
  type: 'kind',
  coll: 'coll', collection: 'coll', bo: 'coll', 'bộ': 'coll',
  is: 'is', has: 'has', co: 'has', 'có': 'has',
  after: 'after', sau: 'after', since: 'after', before: 'before', truoc: 'before',
  'trước': 'before', until: 'before',
  url: 'url', key: 'secret', secret: 'secret', token: 'secret', bim: 'secret',
  'bímật': 'secret', 'bimat': 'secret',
  paste: 'pasteapp', dan: 'pasteapp', 'dán': 'pasteapp', dest: 'pasteapp',
  title: 'title', tieude: 'title', 'tiêuđề': 'title',
};

const IS_VALUES = {
  pinned: 'pinned', ghim: 'pinned',
  secret: 'secret', 'bímật': 'secret', bimat: 'secret',
  image: 'image', anh: 'image', 'ảnh': 'image',
  text: 'text', vanban: 'prose', prose: 'prose',
  file: 'files', files: 'files', tep: 'files', 'tệp': 'files',
  url: 'url', link: 'url',
  code: 'code', json: 'json',
  unused: 'unused', 'chưadùng': 'unused', chua_dung: 'unused',
  used: 'used', 'đãdùng': 'used', da_dung: 'used',
  empty: 'empty',
};

const HAS_VALUES = {
  paste: 'paste', 'dán': 'paste', dan: 'paste',
  note: 'note', ghichu: 'note', 'ghichú': 'note',
  url: 'url', image: 'image', 'ảnh': 'image', anh: 'image',
  secret: 'secret', 'bímật': 'secret', coll: 'coll', 'bộ': 'coll',
  tag: 'tag', copy: 'copy',
};

/** "7d", "24h", "30m", "today", "hom qua", "2026-01-31" -> timestamp (ms) */
function parseTime(v, isBefore) {
  const s = normalize(v);
  const now = Date.now();
  if (!s) return null;
  if (s === 'today' || s === 'hom nay' || s === 'homnay') {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return isBefore ? d.getTime() + 86400000 : d.getTime();
  }
  if (s === 'yesterday' || s === 'hom qua' || s === 'homqua') {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return isBefore ? d.getTime() : d.getTime() - 86400000;
  }
  let m = /^(\d+)\s*(m|min|phut|ph|h|gio|hr|hour|d|ngay|day|w|tuan|week|mo|thang|month|y|nam|year)$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const ms = /^(m|min|phut|ph)$/.test(unit) ? 60000
      : /^(h|gio|hr|hour)$/.test(unit) ? 3600000
        : /^(d|ngay|day)$/.test(unit) ? 86400000
          : /^(w|tuan|week)$/.test(unit) ? 604800000
            : /^(mo|thang|month)$/.test(unit) ? 2592000000 : 31536000000;
    return now - n * ms;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(s + (isBefore ? 'T23:59:59' : 'T00:00:00')).getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}t/.test(s)) {
    const t = new Date(v).getTime();
    return isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Phân tích cú pháp truy vấn.
 * Ví dụ: `site:stripe.com is:secret sau:30d stripe`
 */
function parseQuery(q) {
  const parsed = {
    raw: String(q || '').trim(),
    terms: [], app: [], site: [], tag: [], kind: [], coll: [], is: [],
    has: [], after: null, before: null, url: [], secret: [], pasteapp: [], title: [],
  };
  for (const tk of tokenize(parsed.raw)) {
    const m = /^([a-zA-Zà-ỹÀ-Ỹ_-]+):(.*)$/.exec(tk.text);
    if (m && KEY_ALIASES[normalize(m[1])]) {
      const key = KEY_ALIASES[normalize(m[1])];
      let val = m[2].replace(/^"|"$/g, '').trim();
      if (!val) continue;
      if (key === 'after') { parsed.after = Math.max(parsed.after || 0, parseTime(val, false) || 0) || parsed.after; continue; }
      if (key === 'before') { parsed.before = parseTime(val, true) || parsed.before; continue; }
      if (key === 'is') {
        const v = IS_VALUES[normalize(val)];
        if (v) parsed.is.push(v);
        continue;
      }
      if (key === 'has') {
        const v = HAS_VALUES[normalize(val)];
        if (v) parsed.has.push(v);
        continue;
      }
      if (key === 'kind') { parsed.kind.push(normalize(val)); continue; }
      parsed[key].push(normalize(val));
      continue;
    }
    if (tk.text) parsed.terms.push(normalize(tk.text));
  }
  parsed.isEmpty = !parsed.terms.length && !Object.keys(parsed)
    .some(k => Array.isArray(parsed[k]) && parsed[k].length) && !parsed.after && !parsed.before;
  return parsed;
}

// ------------------------------------------------------------------ chỉ mục

/** Tạo "đống cỏ" văn bản để dò tìm, kèm trọng số theo trường. */
function fields(item, ctx) {
  const f = [];
  if (item.text) f.push({ v: item.text.slice(0, 20000), w: 1 });
  if (item.note) f.push({ v: item.note, w: 3 });
  if (item.sourceUrl) f.push({ v: item.sourceUrl, w: 2 });
  if (item.sourceDomain) f.push({ v: item.sourceDomain, w: 3 });
  if (item.sourceTitle) f.push({ v: item.sourceTitle, w: 2 });
  if (item.origin && item.origin.app) f.push({ v: item.origin.app, w: 3 });
  if (item.origin && item.origin.title) f.push({ v: item.origin.title, w: 2 });
  if (item.tags && item.tags.length) f.push({ v: item.tags.join(' '), w: 2 });
  if (item.secrets && item.secrets.length) {
    f.push({ v: item.secrets.map(s => s.label + ' ' + s.id + ' ' + s.masked).join(' '), w: 2 });
  }
  if (item.pastes && item.pastes.length) {
    f.push({ v: item.pastes.map(p => p.app + ' ' + p.title).join(' '), w: 2 });
  }
  if (item.files && item.files.length) f.push({ v: item.files.join(' '), w: 2 });
  if (ctx && ctx.collectionNames && item.collections) {
    const names = item.collections.map(id => ctx.collectionNames.get(id)).filter(Boolean);
    if (names.length) f.push({ v: names.join(' '), w: 3 });
  }
  return f;
}

const HAY_CACHE = new WeakMap();

function haystack(item, ctx) {
  let h = HAY_CACHE.get(item);
  const stamp = (item.copies ? item.copies.length : 0) + ':' + (item.pastes ? item.pastes.length : 0) +
    ':' + (item.note || '').length + ':' + (item.collections ? item.collections.join(',') : '');
  if (h && h.stamp === stamp) return h;
  const parts = fields(item, ctx).map(f => ({ n: normalize(f.v), w: f.w }));
  h = {
    stamp,
    plain: parts.map(p => p.n).join('\u0000'),
    terms: parts.map(p => ({ t: p.n, w: p.w })),
  };
  HAY_CACHE.set(item, h);
  return h;
}

function includesTerm(item, ctx, term) {
  const h = haystack(item, ctx);
  if (h.plain.includes(term)) return true;
  // cho phép khớp rời: "str" khớp "stripe"
  return false;
}

function termScore(item, ctx, term) {
  const h = haystack(item, ctx);
  let best = 0;
  for (const f of h.terms) {
    let idx = f.t.indexOf(term);
    if (idx < 0) continue;
    let s = 10 * f.w;
    if (idx === 0 || /\W/.test(f.t[idx - 1] || ' ')) s += 6;   // khớp đầu từ
    if (f.w >= 3) s += 4;
    if (s > best) best = s;
  }
  return best;
}

// ------------------------------------------------------------------ lọc

function matchesFilters(item, p, ctx) {
  if (p.after && (item.lastCopiedAt || item.createdAt || 0) < p.after) return false;
  if (p.before && (item.lastCopiedAt || item.createdAt || 0) > p.before) return false;

  if (p.kind.length && !p.kind.includes(String(item.kind))) return false;

  if (p.app.length) {
    const hay = normalize([
      (item.origin && item.origin.app) || '',
      (item.origin && item.origin.title) || '',
      (item.copies || []).map(c => c.app + ' ' + c.title).join(' '),
    ].join(' '));
    for (const a of p.app) if (!hay.includes(a)) return false;
  }

  if (p.site.length) {
    const hay = normalize([item.sourceDomain || '', item.sourceUrl || '', item.sourceTitle || ''].join(' '));
    for (const s of p.site) if (!hay.includes(s)) return false;
  }

  if (p.title.length) {
    const hay = normalize([item.sourceTitle || '', (item.origin && item.origin.title) || ''].join(' '));
    for (const s of p.title) if (!hay.includes(s)) return false;
  }

  if (p.tag.length) {
    const tags = (item.tags || []).map(normalize);
    for (const t of p.tag) if (!tags.some(x => x.includes(t))) return false;
  }

  if (p.url.length) {
    const hay = normalize([item.sourceUrl || '', item.text || ''].join(' '));
    for (const u of p.url) if (!hay.includes(u)) return false;
  }

  if (p.secret.length) {
    const hay = normalize((item.secrets || []).map(s => s.id + ' ' + s.label + ' ' + s.value).join(' '));
    for (const s of p.secret) if (!hay.includes(s)) return false;
  }

  if (p.coll.length) {
    const names = (item.collections || []).map(id => normalize((ctx.collectionNames.get(id) || id)));
    for (const c of p.coll) if (!names.some(n => n.includes(c))) return false;
  }

  if (p.pasteapp.length) {
    const hay = normalize((item.pastes || []).map(x => x.app + ' ' + x.title).join(' '));
    for (const a of p.pasteapp) if (!hay.includes(a)) return false;
  }

  for (const flag of p.is) {
    if (flag === 'pinned' && !item.pinned) return false;
    if (flag === 'secret' && !(item.secrets && item.secrets.length)) return false;
    if (flag === 'image' && item.kind !== 'image') return false;
    if (flag === 'text' && item.kind !== 'text') return false;
    if (flag === 'prose' && !isPlainText(item)) return false;
    if (flag === 'files' && item.kind !== 'files') return false;
    if (flag === 'code' && !(item.tags || []).includes('code')) return false;
    if (flag === 'json' && !(item.tags || []).includes('json')) return false;
    if (flag === 'url' && !(item.tags || []).includes('url')) return false;
    if (flag === 'empty' && item.kind !== 'empty') return false;
    if (flag === 'unused' && (item.usedCount || 0) > 0) return false;
    if (flag === 'used' && !(item.usedCount || 0)) return false;
  }

  for (const flag of p.has) {
    if (flag === 'paste' && !(item.pastes && item.pastes.length)) return false;
    if (flag === 'note' && !(item.note && item.note.trim())) return false;
    if (flag === 'url' && !item.sourceUrl) return false;
    if (flag === 'image' && !item.image) return false;
    if (flag === 'secret' && !(item.secrets && item.secrets.length)) return false;
    if (flag === 'coll' && !(item.collections && item.collections.length)) return false;
    if (flag === 'tag' && !(item.tags && item.tags.length)) return false;
    if (flag === 'copy' && (item.copyCount || 0) < 2) return false;
  }
  return true;
}

// ------------------------------------------------------------------ xếp hạng

const DAY = 86400000;

function recencyScore(item) {
  const t = item.lastCopiedAt || item.createdAt || 0;
  const age = Math.max(0, Date.now() - t) / DAY;
  return 30 * Math.exp(-age / 7);           // bán rã 7 ngày
}

function rank(item, p, ctx, now) {
  let s = recencyScore(item);
  s += Math.min(24, (item.copyCount || 1) * 2.5);
  s += Math.min(30, (item.pastes || []).reduce((a, x) => a + (x.count || 1), 0) * 4);
  s += Math.min(20, ((item.usedCount || 0)) * 3);
  if (item.pinned) s += 60;
  if (item.secrets && item.secrets.length) s += 6;
  for (const term of p.terms) s += termScore(item, ctx, term) * 1.5;
  // Khớp ở tiêu đề/nguồn được ưu tiên hơn khớp trong thân văn bản dài
  const len = (item.text || '').length;
  if (len > 4000) s -= 4;
  return s - (now - (item.lastCopiedAt || 0)) / (DAY * 3650);
}

const SORTS = {
  recent: (a, b) => (b.lastCopiedAt || b.createdAt || 0) - (a.lastCopiedAt || a.createdAt || 0),
  oldest: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
  copies: (a, b) => (b.copyCount || 0) - (a.copyCount || 0),
  pastes: (a, b) => (b.pastes || []).length - (a.pastes || []).length,
  important: (a, b) => (b.important || 0) - (a.important || 0),
  alpha: (a, b) => normalize(a.text || '').localeCompare(normalize(b.text || '')),
};

/**
 * Tìm kiếm + lọc + sắp xếp.
 * @returns {{total:number, items:Array, parsed:object}}
 */
function search(items, query, opts = {}) {
  const ctx = opts.ctx || { collectionNames: new Map() };
  const p = typeof query === 'string' ? parseQuery(query) : (query || parseQuery(''));
  const now = Date.now();
  const scope = opts.scope || 'all';
  const sortKey = opts.sort && SORTS[opts.sort] ? opts.sort : (p.terms.length ? 'relevance' : 'recent');

  let list = items.filter(it => matchesFilters(it, p, ctx));
  list = list.filter(it => matchesScope(it, scope, opts.collectionId));

  if (p.terms.length) {
    list = list.filter(it => p.terms.every(t => includesTerm(it, ctx, t)));
    for (const it of list) it.__score = rank(it, p, ctx, now);
  } else {
    for (const it of list) it.__score = rank(it, p, ctx, now);
  }

  if (p.terms.length) list.sort((a, b) => b.__score - a.__score);
  else list.sort(SORTS[sortKey]);

  const total = list.length;
  const offset = Math.max(0, opts.offset | 0);
  const limit = Math.min(1000, Math.max(1, opts.limit == null ? 120 : opts.limit | 0));
  return { total, items: list.slice(offset, offset + limit), parsed: p, sort: sortKey };
}

/**
 * "Đường dẫn": nội dung CHÍNH LÀ link (mỗi dòng đều là một URL), chứ không phải
 * chỉ những mục tình cờ được copy từ một trang web.
 */
function isLinkItem(item) {
  const tags = item.tags || [];
  if (tags.includes('link-only')) return true;
  if (!tags.includes('url')) return false;
  const lines = String(item.text || '').split('\n').map(s => s.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(l => /^https?:\/\//i.test(l));
}

/**
 * "Văn bản thường": nội dung dạng chữ, TRỪ những thứ đã có mục riêng ở sidebar
 * (mã nguồn → Mã/Code, link → Đường dẫn, API key/mật khẩu → Kho bí mật).
 */
function isPlainText(item) {
  if (item.kind !== 'text' && item.kind !== 'html') return false;
  const tags = item.tags || [];
  if (tags.includes('code') || tags.includes('secret')) return false;
  return !isLinkItem(item);
}

function matchesScope(item, scope, collectionId) {
  switch (scope) {
    case 'all': return true;
    case 'pinned': return !!item.pinned;
    case 'secrets': return !!(item.secrets && item.secrets.length);
    case 'images': return item.kind === 'image';
    case 'text': return isPlainText(item);
    case 'urls': return isLinkItem(item);
    case 'files': return item.kind === 'files';
    case 'code': return (item.tags || []).includes('code');
    case 'unused': return !(item.usedCount || 0) && !(item.pastes || []).length;
    case 'today': {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      return (item.lastCopiedAt || 0) >= d.getTime();
    }
    case 'collection': return !!(item.collections && item.collections.includes(collectionId));
    default: return true;
  }
}

/** Đếm số lượng cho từng nhóm (sidebar). */
function facets(items) {
  const kinds = {}, apps = {}, sites = {}, tags = {}, dest = {};
  let secrets = 0, pinned = 0, images = 0, urls = 0, files = 0, today = 0, unused = 0, code = 0, text = 0;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  for (const it of items) {
    kinds[it.kind] = (kinds[it.kind] || 0) + 1;
    const a = (it.origin && it.origin.app) || 'không rõ';
    apps[a] = (apps[a] || 0) + 1;
    if (it.sourceDomain) sites[it.sourceDomain] = (sites[it.sourceDomain] || 0) + 1;
    for (const t of (it.tags || [])) tags[t] = (tags[t] || 0) + 1;
    for (const pp of (it.pastes || [])) {
      const k = pp.app || '?';
      dest[k] = (dest[k] || 0) + (pp.count || 1);
    }
    if (it.secrets && it.secrets.length) secrets++;
    if (it.pinned) pinned++;
    if (it.kind === 'image') images++;
    if (isLinkItem(it)) urls++;    if (it.kind === 'files') files++;
    if ((it.tags || []).includes('code')) code++;
    if (isPlainText(it)) text++;
    if ((it.lastCopiedAt || 0) >= dayStart.getTime()) today++;
    if (!(it.usedCount || 0) && !(it.pastes || []).length) unused++;
  }
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([name, count]) => ({ name, count }));
  return {
    total: items.length, secrets, pinned, images, urls, files, today, unused, code, text,
    kinds, apps: top(apps, 24), sites: top(sites, 24), tags: top(tags, 30), destinations: top(dest, 24),
  };
}

module.exports = {
  stripDiacritics, normalize, parseQuery, search, facets, matchesScope, tokenize, parseTime,
  isPlainText, isLinkItem,
};

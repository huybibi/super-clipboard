/* =========================================================================
   SuperClipboard — giao diện chính
   ========================================================================= */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  status: null,
  settings: {},
  collections: [],
  facets: {},
  items: [],
  total: 0,
  selectedId: null,
  detail: null,
  lineage: null,
  revealed: {},
  revealTimer: null,
  scope: 'all',
  collectionId: null,
  query: '',
  sort: 'recent',
  limit: 120,
  targets: [],
  focus: null,
  lastTarget: null,
  seenIds: new Set(),
};

/* ------------------------------------------------------------------ tiện ích */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function timeAgo(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 0) return 'vừa xong';
  const m = Math.floor(d / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return m + ' phút trước';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' giờ trước';
  const day = Math.floor(h / 24);
  const dt = new Date(ts);
  const hm = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
  if (day === 1) return 'hôm qua ' + hm;
  if (day < 7) return day + ' ngày trước';
  return dt.getDate() + '/' + (dt.getMonth() + 1) + ' ' + hm;
}

function fullTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const KIND_ICO = { text: '📝', html: '🌐', image: '🖼', files: '📎', empty: '▫️' };

function toast(title, sub, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 320); }, 3800);
}

function statusMsg(msg) { $('#st-msg').textContent = msg || ''; }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const txt = await res.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  if (!res.ok) throw new Error((body && body.error) || ('Lỗi ' + res.status));
  return body;
}

/** Bọc các đoạn ••• thành thẻ nổi bật. */
function decorateMasked(text) {
  return esc(text).replace(/([•·]{4,})/g, '<span class="masked-mark">$1</span>');
}

/* ------------------------------------------------------------------ khởi động */

async function boot() {
  wireEvents();
  try {
    const s = await api('/api/state');
    state.status = s.status;
    state.settings = s.settings || {};
    state.collections = s.collections || [];
    state.facets = s.facets || {};
    state.items = s.items || [];
    state.total = s.total || 0;
    state.targets = s.targets || [];
    state.items.forEach(i => state.seenIds.add(i.id));
    renderSidebar();
    renderStatus();
    renderList();
    if (state.items.length) select(state.items[0].id);
    connectSSE();
    if (s.status && s.status.hotkeys && s.status.hotkeys[1] === false) {
      toast('Phím tắt Ctrl+Alt+V đang bị ứng dụng khác chiếm',
        'Mở Cài đặt để thử đăng ký lại, hoặc dùng biểu tượng khay hệ thống.', 'err');
    }
  } catch (e) {
    toast('Không kết nối được máy chủ', e.message, 'err');
  }
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onopen = () => { $('#st-live').classList.remove('off'); };
  es.onerror = () => { $('#st-live').classList.add('off'); };
  es.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handleEvent(m);
  };
}

function handleEvent(m) {
  const p = m.payload;
  switch (m.type) {
    case 'hello':
      state.status = p; renderStatus(); break;
    case 'helper':
      state.status = p; renderStatus(); break;
    case 'focus':
      state.focus = { proc: p.proc, title: p.title, hwnd: p.hwnd };
      renderStatus(); break;
    case 'item:new': {
      const card = p.card;
      if (state.seenIds.has(card.id)) { refreshListSoon(); break; }
      state.seenIds.add(card.id);
      onNewItem(card);
      break;
    }
    case 'item:update':
      applyCardUpdate(p.card);
      if (state.selectedId === p.card.id && state.detail) refreshDetail(p.card.id);
      break;
    case 'item:removed':
      state.items = state.items.filter(i => i.id !== p.id);
      if (state.selectedId === p.id) { state.selectedId = null; state.detail = null; renderDetail(); }
      renderList();
      loadFacets();
      break;
    case 'collections':
      state.collections = p; renderSidebar();
      break;
    case 'settings':
      state.settings = p; renderStatus();
      break;
    case 'clipboard:wipe':
      toast('Đã tự động xoá clipboard', `Bí mật được giữ trên màn hình ${p.afterSec} giây rồi xoá khỏi clipboard.`, 'ok');
      break;
    case 'error':
      toast('Helper báo lỗi', p.message, 'err'); break;
  }
}

let listRefreshTimer = null;
function refreshListSoon() {
  clearTimeout(listRefreshTimer);
  listRefreshTimer = setTimeout(() => loadItems(), 400);
}

function onNewItem(card) {
  const bits = [];
  if (card.sourceDomain) bits.push('từ ' + card.sourceDomain);
  else if (card.sourceApp) bits.push('từ ' + card.sourceApp);
  if (card.sourceUrl) bits.push(card.sourceUrl.replace(/^https?:\/\//, ''));
  const sub = (card.secrets.length ? '🔑 ' + card.secrets[0].label + ' · ' : '') +
    (bits.join(' · ') || 'không rõ nguồn');
  toast('Đã lưu: ' + (card.title || '').slice(0, 60), sub, card.secrets.length ? 'secret' : '');
  loadItems();
  loadFacets();
}

function applyCardUpdate(card) {
  const i = state.items.findIndex(x => x.id === card.id);
  if (i >= 0) state.items[i] = card;
  else state.items.unshift(card);
  renderList();
}

async function loadFacets() {
  try {
    state.facets = await api('/api/facets');
    renderSidebar();
    renderStatus();
  } catch { }
}

async function loadItems(append = false) {
  try {
    const params = new URLSearchParams({
      query: state.query, scope: state.scope, sort: state.sort,
      limit: String(state.limit), offset: append ? String(state.items.length) : '0',
    });
    if (state.collectionId) params.set('collection', state.collectionId);
    const r = await api('/api/items?' + params.toString());
    state.items = append ? state.items.concat(r.items) : r.items;
    state.total = r.total;
    state.items.forEach(i => state.seenIds.add(i.id));
    renderList();
    renderStatus();
  } catch (e) { toast('Không tải được danh sách', e.message, 'err'); }
}

/* ------------------------------------------------------------------ sidebar */

const SCOPES = [
  { id: 'all', label: 'Tất cả', ico: '🗂', key: 'total' },
  { id: 'today', label: 'Hôm nay', ico: '☀️', key: 'today' },
  { id: 'pinned', label: 'Đã ghim', ico: '📌', key: 'pinned' },
  { id: 'text', label: 'Văn bản', ico: '📄', key: 'text' },
  { id: 'secrets', label: 'Kho bí mật', ico: '🔑', key: 'secrets', cls: 'secret' },
  { id: 'urls', label: 'Đường dẫn', ico: '🔗', key: 'urls' },
  { id: 'images', label: 'Ảnh', ico: '🖼', key: 'images' },
  { id: 'code', label: 'Mã / Code', ico: '⌨️', key: 'code' },
  { id: 'files', label: 'Tệp', ico: '📎', key: 'files' },
  { id: 'unused', label: 'Chưa dùng lần nào', ico: '🕓', key: 'unused' },
];

function renderSidebar() {
  const f = state.facets || {};
  $('#nav-scopes').innerHTML = SCOPES.map(s => `
    <button class="nav-item ${s.cls || ''} ${state.scope === s.id && !state.collectionId ? 'active' : ''}"
            data-scope="${s.id}">
      <span class="ico">${s.ico}</span>
      <span class="lbl">${esc(s.label)}</span>
      <span class="n">${f[s.key] || 0}</span>
    </button>`).join('');

  $('#collections').innerHTML = state.collections.length
    ? state.collections.map(c => `
      <button class="chip-coll ${state.collectionId === c.id ? 'active' : ''}" data-coll="${c.id}"
              style="${state.collectionId === c.id ? 'color:' + esc(c.color || '#6366f1') : ''}">
        <span class="swatch" style="background:${esc(c.color || '#6366f1')}"></span>${esc(c.name)}
      </button>`).join('')
    : '<span style="font-size:11.5px;color:var(--muted);padding:2px 4px">Chưa có bộ sưu tập nào</span>';

  const facet = (list, attr, showFav) => (list || []).length
    ? list.map(x => `
      <button class="facet" ${attr}="${esc(x.name)}" title="${esc(x.name)}">
        ${showFav ? '<span class="fav"></span>' : '<span class="mono">›</span>'}
        <span class="name">${esc(x.name)}</span><span class="n">${x.count}</span>
      </button>`).join('')
    : '<span style="font-size:11.5px;color:var(--muted);padding:2px 4px">—</span>';

  $('#facets-apps').innerHTML = facet(f.apps, 'data-app', true);
  $('#facets-sites').innerHTML = facet(f.sites, 'data-site', false);
  $('#facets-dest').innerHTML = facet(f.destinations, 'data-dest', false);
  $('#target-count').textContent = (state.targets || []).length;
}

function renderStatus() {
  const st = state.status || {};
  const f = state.facets || {};
  $('#st-helper').innerHTML = `<span class="dot ${st.helperReady ? 'ok' : 'bad'}"></span>` +
    (st.helperReady ? 'helper #' + st.helperPid : 'helper ngắt kết nối');
  $('#st-total').textContent = (f.total || 0) + ' mục';
  $('#st-secrets').textContent = (f.secrets || 0) + ' bí mật';
  const fo = state.focus;
  $('#st-focus').textContent = fo ? (fo.proc || '?') + (fo.title ? ' — ' + fo.title.slice(0, 46) : '') : 'chưa rõ cửa sổ';
  const paused = !!state.settings.pauseCapture;
  $('#pause-label').textContent = paused ? 'Đang tạm dừng' : 'Đang ghi';
  $('#pause-dot').className = 'dot ' + (paused ? 'warn' : 'ok');
  $('#brand-sub').textContent = paused ? 'tạm dừng ghi' : 'trí nhớ clipboard';
}

/* ------------------------------------------------------------------ danh sách */

function cardHTML(it) {
  const ico = it.kind === 'image' && it.image
    ? `<img src="${esc(it.image)}" alt="">`
    : (KIND_ICO[it.kind] || '📝');

  const meta = [];
  if (it.secrets.length) {
    const s = it.secrets[0];
    meta.push(`<span class="badge secret ${s.severity === 'critical' ? 'critical' : ''}">🔑 ${esc(s.label)}</span>`);
  }
  if (it.sourceDomain) meta.push(`<span class="badge site">🌐 ${esc(it.sourceDomain)}</span>`);
  else if (it.sourceApp) meta.push(`<span class="badge app">${esc(it.sourceApp)}</span>`);
  if (it.pasteApps.length) {
    const names = it.pasteApps.map(p => esc(p.app)).join(', ');
    meta.push(`<span class="badge dest">➜ ${names}${it.pasteCount > 1 ? ' ×' + it.pasteCount : ''}</span>`);
  }
  if (it.copyCount > 1) meta.push(`<span class="badge">⧉ ${it.copyCount} lần copy</span>`);
  if (it.pinned) meta.push('<span class="badge pin">📌</span>');
  if (it.hasNote) meta.push('<span class="badge">📝 ghi chú</span>');
  for (const c of it.collections) {
    meta.push(`<span class="badge" style="color:${esc(c.color)};border-color:${esc(c.color)}55">${esc(c.name)}</span>`);
  }
  if (it.kind === 'image') meta.push(`<span class="badge mono">${it.width}×${it.height}</span>`);
  if (it.lineCount > 1) meta.push(`<span class="badge mono">${it.lineCount} dòng</span>`);
  else if (it.charCount > 0 && it.kind !== 'image') meta.push(`<span class="badge mono">${it.charCount} ký tự</span>`);

  return `
  <article class="card ${it.pinned ? 'pinned' : ''} ${it.secrets.some(s => s.severity === 'critical') ? 'risk' : ''} ${state.selectedId === it.id ? 'selected' : ''}"
           data-id="${it.id}" tabindex="-1">
    <div class="card-ico">${ico}</div>
    <div class="card-body">
      <div class="card-title">${esc(it.title || '(không có tiêu đề)')}</div>
      <div class="card-preview">${decorateMasked(it.preview || '')}</div>
      <div class="card-meta">${meta.join('')}</div>
    </div>
    <div class="card-side">
      <span class="card-time">${timeAgo(it.lastCopiedAt || it.createdAt)}</span>
      ${it.lastPastedAt ? `<span class="card-time" style="color:var(--green)">dán ${timeAgo(it.lastPastedAt)}</span>` : ''}
    </div>
  </article>`;
}

function renderList() {
  const list = $('#list');
  const empty = $('#list-empty');
  if (!state.items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    list.style.display = 'none';
  } else {
    empty.hidden = true;
    list.style.display = '';
    let html = state.items.map(cardHTML).join('');
    if (state.items.length < state.total) {
      html += `<button class="btn subtle wide" id="btn-more" style="margin-top:6px">
                 Tải thêm (${state.items.length}/${state.total})</button>`;
    }
    list.innerHTML = html;
    const more = $('#btn-more');
    if (more) more.onclick = () => { state.limit = Math.min(1000, state.limit + 120); loadItems(true); };
  }
  const scopeLabel = state.collectionId
    ? (state.collections.find(c => c.id === state.collectionId) || {}).name || 'Bộ sưu tập'
    : (SCOPES.find(s => s.id === state.scope) || {}).label || 'Tất cả';
  $('#list-title').textContent = scopeLabel;
  $('#list-count').textContent = state.total;
  $('#query-echo').textContent = state.query ? '⟫ ' + state.query : '';
}

/* ------------------------------------------------------------------ chi tiết */

async function select(id) {
  if (!id) return;
  state.selectedId = id;
  $$('.card').forEach(c => c.classList.toggle('selected', c.dataset.id === id));
  await refreshDetail(id);
}

async function refreshDetail(id) {
  try {
    const reveal = state.revealed[id] ? '?reveal=1' : '';
    const r = await api(`/api/items/${id}${reveal}`);
    if (state.selectedId !== id) return;
    state.detail = r.item;
    state.lineage = r.lineage;
    renderDetail();
  } catch (e) { statusMsg('Không tải được chi tiết: ' + e.message); }
}

function renderDetail() {
  const d = state.detail;
  const box = $('#detail');
  if (!d) {
    box.innerHTML = `
      <div class="detail-empty">
        <div class="empty-art">🔎</div>
        <h3>Chọn một mục</h3>
        <p>Bên phải sẽ hiện đầy đủ: nội dung, <b>nguồn gốc</b>, <b>đã dán vào đâu</b>,
           dòng thời gian và cả những API key cùng “dòng họ” với nó.</p>
        <div class="kbd-legend">
          <div><kbd>/</kbd> tìm kiếm</div>
          <div><kbd>↑</kbd><kbd>↓</kbd> di chuyển</div>
          <div><kbd>Enter</kbd> copy lại</div>
          <div><kbd>Ctrl</kbd>+<kbd>Enter</kbd> dán tới app trước đó</div>
          <div><kbd>P</kbd> ghim · <kbd>Del</kbd> xoá</div>
          <div><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> bảng lệnh nhanh</div>
        </div>
      </div>`;
    return;
  }

  const revealed = !!state.revealed[d.id];
  const pastes = d.pasteApps || [];
  const fam = state.lineage;

  const sections = [];

  /* --- cảnh báo bí mật --- */
  if (d.secrets.length) {
    sections.push(`
      <div class="d-section critical">
        <h4>🔑 Bí mật được phát hiện <span class="counter">${d.secrets.length}</span></h4>
        <div class="body">
          ${d.secrets.map(s => `
            <div class="sibling" style="margin-bottom:5px">
              <span class="badge secret ${s.severity === 'critical' ? 'critical' : ''}">${esc(s.label)}</span>
              <span class="mono">${esc(s.masked)}</span>
              <span class="n">${s.severity === 'critical' ? 'nguy hiểm cao' : s.severity === 'high' ? 'nguy hiểm' : 'thấp'}</span>
            </div>`).join('')}
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            <button class="btn small" data-act="reveal">${revealed ? '🙈 Ẩn giá trị' : '👁 Hiện giá trị'}</button>
            <button class="btn small danger" data-act="wipe">🧽 Xoá clipboard ngay</button>
            ${state.settings.autoClearSecretSec > 0
              ? `<span class="counter">tự động xoá sau ${state.settings.autoClearSecretSec}s</span>` : ''}
          </div>
        </div>
      </div>`);
  }

  /* --- nội dung --- */
  sections.push(`
    <div class="d-section">
      <h4>Nội dung
        <span>
          ${d.kind !== 'image' ? `<button class="icon-btn tiny" data-act="copy" title="Đưa vào clipboard">⧉</button>` : ''}
        </span>
      </h4>
      <div class="body">
        ${revealed ? '<div class="reveal-banner">⚠️ Đang hiện giá trị thật — sẽ tự ẩn sau 30 giây.</div>' : ''}
        <div class="content-box" id="content-box">${
          d.kind === 'image' && d.image
            ? `<img src="${esc(d.image)}" alt="ảnh">`
            : decorateMasked(d.text || '(rỗng)')
        }</div>
      </div>
    </div>`);

  /* --- nguồn gốc --- */
  const srcRows = [];
  if (d.sourceDomain) {
    srcRows.push(`<dt>Trang nguồn</dt><dd>
        <a href="${esc(d.sourceUrl)}" target="_blank" rel="noreferrer">${esc(d.sourceUrl)}</a>
        <button class="icon-btn tiny" data-act="open-src" title="Mở trong trình duyệt">↗</button>
      </dd>`);
    srcRows.push(`<dt>Tên miền</dt><dd>${esc(d.sourceDomain)}</dd>`);
  }
  if (d.sourceTitle) srcRows.push(`<dt>Tiêu đề</dt><dd>${esc(d.sourceTitle)}</dd>`);
  if (d.origin.app) srcRows.push(`<dt>Ứng dụng</dt><dd>${esc(d.origin.app)}</dd>`);
  srcRows.push(`<dt>Copy lần đầu</dt><dd>${fullTime(d.createdAt)}</dd>`);
  srcRows.push(`<dt>Copy gần nhất</dt><dd>${fullTime(d.lastCopiedAt)} · <b>${d.copyCount}</b> lần</dd>`);
  sections.push(`
    <div class="d-section">
      <h4>Nguồn gốc — copy từ đâu</h4>
      <div class="body"><dl class="kv">${srcRows.join('')}</dl></div>
    </div>`);

  /* --- nơi đã dán --- */
  const destRows = pastes.length
    ? pastes.map(p => `
      <div class="sibling">
        <span class="badge dest">➜ ${esc(p.app)}</span>
        <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((p.title || '').slice(0, 44))}</span>
        <span class="n">×${p.count} · ${timeAgo(p.last)}</span>
      </div>`).join('')
    : `<div style="color:var(--muted);font-size:12px">Chưa ghi nhận lần dán nào. Hãy bấm
       <b>Dán tới ▾</b> để gửi vào một ứng dụng, hoặc cứ Ctrl+V như bình thường —
       SuperClipboard sẽ tự nhớ đích đến.</div>`;
  sections.push(`
    <div class="d-section">
      <h4>Đã dán vào đâu <span class="counter">${pastes.reduce((a, x) => a + x.count, 0)} lần</span></h4>
      <div class="body"><div class="sibling-list">${destRows}</div></div>
    </div>`);

  /* --- dòng họ A1/A2 --- */
  if (fam && fam.siblings.length > 1) {
    sections.push(`
      <div class="d-section">
        <h4>🔗 Dòng họ bí mật — cùng dịch vụ &amp; nguồn <span class="counter">${fam.siblings.length}</span></h4>
        <div class="body">
          <div style="color:var(--muted);font-size:11.5px;margin-bottom:8px">
            ${esc(fam.family)} · những key này được tạo từ cùng một nơi.
          </div>
          <div class="sibling-list">
            ${fam.siblings.map((s, i) => `
              <div class="sibling ${s.current ? 'current' : ''}">
                <span class="badge">A${i + 1}</span>
                <span class="mono">${esc(s.masked)}</span>
                <span class="n">${timeAgo(s.createdAt)}</span>
                ${s.current ? '<span class="n">đang xem</span>'
                  : `<button class="icon-btn tiny go" data-act="goto" data-id="${s.id}" title="Mở">→</button>`}
              </div>`).join('')}
          </div>
        </div>
      </div>`);
  }

  /* --- dòng thời gian --- */
  const tl = [];
  if (fam) {
    for (const e of fam.timeline.slice(-40)) {
      const t = fullTime(e.ts);
      if (e.type === 'copy') {
        tl.push(`<div class="tl-item">
          <div class="tl-time">${t}</div><div class="tl-line"><span class="tl-dot"></span></div>
          <div class="tl-body"><b>Copy</b> ${e.internal ? '<span class="tl-sub">(từ SuperClipboard)</span>' : ''}
            <div class="tl-sub">${esc(e.app || '?')}${e.title ? ' — ' + esc(e.title.slice(0, 60)) : ''}</div>
            ${e.url ? `<div class="tl-sub">🔗 ${esc(e.url)}</div>` : ''}
          </div></div>`);
      } else {
        tl.push(`<div class="tl-item">
          <div class="tl-time">${t}</div><div class="tl-line"><span class="tl-dot paste"></span></div>
          <div class="tl-body"><b style="color:var(--green)">Dán</b>
            <div class="tl-sub">➜ ${esc(e.app || '?')}${e.title ? ' — ' + esc(e.title.slice(0, 60)) : ''}
            ${e.count > 1 ? ' ×' + e.count : ''}</div>
          </div></div>`);
      }
    }
  }
  sections.push(`
    <div class="d-section">
      <h4>Dòng thời gian</h4>
      <div class="body"><div class="timeline">${tl.join('') || '<span style="color:var(--muted)">—</span>'}</div></div>
    </div>`);

  /* --- ghi chú & bộ sưu tập --- */
  sections.push(`
    <div class="d-section">
      <h4>Ghi chú, nhãn &amp; bộ sưu tập</h4>
      <div class="body">
        <textarea class="note-input" id="note" rows="2"
          placeholder="Ví dụ: dùng cho App B, hết hạn 31/12…">${esc(d.note || '')}</textarea>
        <div class="tag-edit">
          ${(d.tags || []).map(t => `<span class="chip-coll">${esc(t)}
            <button class="tag-x" data-act="rm-tag" data-tag="${esc(t)}" title="Bỏ nhãn">×</button></span>`).join('')}
          <input class="tag-input" id="tag-input" placeholder="+ nhãn rồi Enter" spellcheck="false">
        </div>
        <div class="coll-picker">
          ${state.collections.map(c => `
            <button class="chip-coll ${d.collections.some(x => x.id === c.id) ? 'active' : ''}"
                    data-act="toggle-coll" data-id="${c.id}"
                    style="${d.collections.some(x => x.id === c.id) ? 'color:' + esc(c.color) : ''}">
              <span class="swatch" style="background:${esc(c.color)}"></span>${esc(c.name)}
            </button>`).join('')}
          <button class="chip-coll" data-act="new-coll">＋ Bộ sưu tập mới</button>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px">
          <button class="btn small primary" data-act="save-note">Lưu ghi chú</button>
          <button class="btn small" data-act="pin">${d.pinned ? '📌 Bỏ ghim' : '📌 Ghim lại'}</button>
          <button class="btn small danger" data-act="delete">🗑 Xoá</button>
        </div>
      </div>
    </div>`);

  box.innerHTML = `
    <div class="d-head">
      <div class="d-kind">${KIND_ICO[d.kind] || ''} ${esc(d.kind)} · ${esc(d.id)}</div>
      <div class="d-title">${esc(d.title || '(không tiêu đề)')}</div>
      <div class="d-actions">
        <button class="btn primary" data-act="copy">⧉ Copy lại <kbd>Enter</kbd></button>
        <button class="btn" data-act="paste-menu">➜ Dán tới ▾ <kbd>Ctrl+↵</kbd></button>
        ${d.sourceUrl ? `<button class="btn ghost" data-act="open-src">↗ Mở nguồn</button>` : ''}
      </div>
    </div>
    ${sections.join('')}`;

  wireDetail();
  if (revealed) startRevealTimer(d.id);
}

function startRevealTimer(id) {
  clearTimeout(state.revealTimer);
  state.revealTimer = setTimeout(() => {
    if (state.selectedId === id && state.revealed[id]) {
      state.revealed[id] = false;
      refreshDetail(id);
      toast('Đã tự ẩn giá trị bí mật', 'Bấm “Hiện giá trị” nếu cần xem lại.', 'ok');
    }
  }, 30000);
}

function wireDetail() {
  const d = state.detail;
  if (!d) return;
  const note = $('#note');
  if (note) {
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(); }
      e.stopPropagation();
    });
  }
  const tagInput = $('#tag-input');
  if (tagInput) {
    tagInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = tagInput.value.trim();
        if (!v) return;
        const tags = [...new Set([...(d.tags || []), v])];
        tagInput.value = '';
        updateItem(d.id, { tags });
      }
    });
  }
  $$('#detail [data-act]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const act = el.dataset.act;
      if (act === 'copy') doCopy(d.id);
      else if (act === 'paste-menu') openPasteMenu(el, d.id);
      else if (act === 'open-src') openExternal(d.sourceUrl);
      else if (act === 'reveal') {
        state.revealed[d.id] = !state.revealed[d.id];
        if (!state.revealed[d.id]) clearTimeout(state.revealTimer);
        refreshDetail(d.id);
      } else if (act === 'wipe') { api('/api/actions/wipe-clipboard', { method: 'POST' }); toast('Đã xoá clipboard', '', 'ok'); }
      else if (act === 'pin') { updateItem(d.id, { pinned: !d.pinned }); }
      else if (act === 'delete') { deleteItem(d.id); }
      else if (act === 'save-note') saveNote();
      else if (act === 'toggle-coll') toggleCollection(d.id, el.dataset.id);
      else if (act === 'new-coll') createCollectionPrompt(d.id);
      else if (act === 'rm-tag') {
        const tags = (d.tags || []).filter(t => t !== el.dataset.tag);
        updateItem(d.id, { tags });
      }
      else if (act === 'goto') { select(el.dataset.id); scrollToSelected(); }
    };
  });
}

function scrollToSelected() {
  const el = $(`.card[data-id="${state.selectedId}"]`);
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ------------------------------------------------------------------ hành động */

async function doCopy(id) {
  try {
    await api(`/api/items/${id}/copy`, { method: 'POST' });
    toast('Đã đưa vào clipboard', 'Giờ chỉ cần Ctrl+V ở bất kỳ đâu.', 'ok');
    statusMsg('Đã copy lại mục ' + id);
  } catch (e) { toast('Không copy được', e.message, 'err'); }
}

async function doPaste(id, hwnd) {
  try {
    const r = await api(`/api/items/${id}/paste`, { method: 'POST', body: { hwnd: hwnd || 0 } });
    if (r.target && r.target.hwnd) {
      state.lastTarget = r.target;
      toast('Đã dán vào ' + (r.target.proc || 'ứng dụng đích'),
        r.target.title ? r.target.title.slice(0, 70) : '', 'ok');
      setTimeout(() => { refreshDetail(id); loadFacets(); }, 600);
    } else {
      toast('Không xác định được cửa sổ đích', 'Hãy bấm vào ứng dụng muốn dán rồi thử lại.', 'err');
    }
  } catch (e) { toast('Không dán được', e.message, 'err'); }
}

async function updateItem(id, patch) {
  try {
    await api(`/api/items/${id}`, { method: 'POST', body: patch });
    await refreshDetail(id);
    renderList();
  } catch (e) { toast('Không lưu được', e.message, 'err'); }
}

async function saveNote() {
  const d = state.detail;
  if (!d) return;
  const v = $('#note').value;
  try {
    await api(`/api/items/${d.id}`, { method: 'POST', body: { note: v } });
    d.note = v; d.hasNote = !!v.trim();
    toast('Đã lưu ghi chú', v.slice(0, 70), 'ok');
    const card = state.items.find(x => x.id === d.id);
    if (card) card.hasNote = d.hasNote;
    renderList();
  } catch (e) { toast('Không lưu được ghi chú', e.message, 'err'); }
}

async function toggleCollection(id, collId) {
  const d = state.detail;
  if (!d) return;
  const cur = new Set(d.collections.map(c => c.id));
  if (cur.has(collId)) cur.delete(collId); else cur.add(collId);
  await updateItem(id, { collections: [...cur] });
}

async function deleteItem(id) {
  if (!confirm('Xoá mục này khỏi kho?')) return;
  try {
    await api(`/api/items/${id}/delete`, { method: 'POST' });
    state.items = state.items.filter(i => i.id !== id);
    if (state.selectedId === id) { state.selectedId = null; state.detail = null; renderDetail(); }
    renderList(); loadFacets();
    toast('Đã xoá', '', 'ok');
  } catch (e) { toast('Không xoá được', e.message, 'err'); }
}

function openExternal(url) {
  if (!url) return;
  window.open(url, '_blank');
}

async function openPasteMenu(anchor, id) {
  const old = $('#paste-menu'); if (old) old.remove();
  let targets = [], focus = null;
  try { const r = await api('/api/targets'); targets = r.targets || []; focus = r.focus; } catch { }
  state.targets = targets;

  const menu = document.createElement('div');
  menu.id = 'paste-menu';
  menu.className = 'modal';
  menu.style.cssText = 'position:fixed;z-index:90;width:330px;padding:0;max-height:360px;overflow:auto';
  const rect = anchor.getBoundingClientRect();
  menu.style.left = Math.min(window.innerWidth - 345, rect.left) + 'px';
  menu.style.top = Math.min(window.innerHeight - 200, rect.bottom + 6) + 'px';

  const items = [];
  if (focus && focus.hwnd) {
    items.push(`<button class="facet" data-hwnd="${focus.hwnd}">
      <span class="mono">⌨</span><span class="name">Cửa sổ đang focus: <b>${esc(focus.proc)}</b></span></button>`);
  }
  for (const t of targets.slice(0, 14)) {
    items.push(`<button class="facet" data-hwnd="${t.hwnd}">
      <span class="mono">🪟</span>
      <span class="name">${esc(t.proc || '?')} — ${esc((t.title || '').slice(0, 40))}</span>
      <span class="n">${timeAgo(t.ts)}</span></button>`);
  }
  menu.innerHTML = `<h3 style="font-size:12px">Dán vào cửa sổ nào?</h3>
    <div class="m-body" style="padding:8px;display:flex;flex-direction:column;gap:2px">
      ${items.join('') || '<span style="color:var(--muted);font-size:12px">Chưa thấy cửa sổ nào. Hãy bấm vào ứng dụng đích trước.</span>'}
    </div>`;
  document.body.appendChild(menu);
  $$('#paste-menu [data-hwnd]', menu).forEach(b => {
    b.onclick = () => { menu.remove(); doPaste(id, parseInt(b.dataset.hwnd, 10)); };
  });
  const close = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

/* ------------------------------------------------------------------ modal */

function modal(title, bodyHTML, footHTML) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-back">
      <div class="modal">
        <h3>${title}</h3>
        <div class="m-body">${bodyHTML}</div>
        ${footHTML ? `<div class="m-foot">${footHTML}</div>` : ''}
      </div>
    </div>`;
  const back = $('.modal-back');
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeModal(); });
  return root;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function openOverview() {
  const f = state.facets || {};
  const o = (state.status && state.status.stats) || {};
  const bars = (list, title) => `
    <h4 style="font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin:16px 0 6px">${title}</h4>
    <div class="bars">${(list || []).slice(0, 6).map(x => {
      const max = Math.max(...(list || [{ count: 1 }]).map(y => y.count), 1);
      return `<div class="bar-row"><span class="lbl">${esc(x.name)}</span>
        <span class="bar"><i style="width:${Math.round(x.count / max * 100)}%"></i></span>
        <span class="n">${x.count}</span></div>`;
    }).join('') || '<span style="color:var(--muted);font-size:12px">—</span>'}</div>`;

  modal('Tổng quan kho clipboard', `
    <div class="stat-grid">
      <div class="stat accent"><div class="v">${f.total || 0}</div><div class="k">Mục đã lưu</div></div>
      <div class="stat"><div class="v">${f.secrets || 0}</div><div class="k">Bí mật / API key</div></div>
      <div class="stat"><div class="v">${f.today || 0}</div><div class="k">Copy hôm nay</div></div>
      <div class="stat"><div class="v">${o.pastes || 0}</div><div class="k">Lần dán đã ghi</div></div>
      <div class="stat"><div class="v">${f.images || 0}</div><div class="k">Ảnh</div></div>
      <div class="stat"><div class="v">${o.deduped || 0}</div><div class="k">Lần copy trùng</div></div>
    </div>
    ${bars(f.apps, 'Ứng dụng nguồn nhiều nhất')}
    ${bars(f.sites, 'Trang web nguồn nhiều nhất')}
    ${bars(f.destinations, 'Nơi đã dán nhiều nhất')}
  `, `<button class="btn" onclick="window.__sc.exportJson()">⇩ Xuất JSON</button>
      <button class="btn" onclick="window.__sc.exportReport()">📄 Báo cáo Markdown</button>
      <button class="btn primary" onclick="window.__sc.closeModal()">Đóng</button>`);
}

function openSettings() {
  const s = state.settings;
  modal('Cài đặt', `
    <div class="row2">
      <div class="field"><label>Số mục tối đa</label>
        <input class="text-input" id="s-max" type="number" min="100" value="${s.maxItems || 5000}"></div>
      <div class="field"><label>Số ngày giữ (0 = mãi mãi)</label>
        <input class="text-input" id="s-ret" type="number" min="0" value="${s.retentionDays || 0}"></div>
    </div>
    <div class="field"><label>Tự động xoá clipboard sau khi copy bí mật (giây, 0 = tắt)</label>
      <input class="text-input" id="s-wipe" type="number" min="0" value="${s.autoClearSecretSec || 0}"></div>
    <label class="switch"><input type="checkbox" id="s-img" ${s.captureImages ? 'checked' : ''}> Lưu ảnh đã copy</label>
    <label class="switch"><input type="checkbox" id="s-paste" ${s.trackPastes ? 'checked' : ''}> Ghi nhận nơi đã dán (Ctrl+V)</label>
    <label class="switch"><input type="checkbox" id="s-login" ${s.startOnLogin ? 'checked' : ''}>
      Khởi động cùng Windows — chạy nền ở khay hệ thống, không mở cửa sổ</label>
    <div class="field" style="margin-top:12px"><label>Bỏ qua ứng dụng (cách nhau dấu phẩy, ví dụ: keepass, 1password)</label>
      <input class="text-input" id="s-apps" value="${esc((s.ignoreApps || []).join(', '))}"></div>
    <div class="field"><label>Bỏ qua nội dung khớp mẫu (mỗi dòng một biểu thức chính quy)</label>
      <textarea class="note-input" id="s-pats" rows="3">${esc((s.ignorePatterns || []).join('\n'))}</textarea></div>
    <div class="field"><label>Phím tắt mở bảng lệnh nhanh toàn cục</label>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn small" onclick="window.__sc.registerHotkey()">Đăng ký Ctrl+Alt+V</button>
        <span id="hk-state" style="font-size:11.5px;color:var(--muted)"></span>
      </div></div>
  `, `<button class="btn" onclick="window.__sc.closeModal()">Huỷ</button>
      <button class="btn primary" onclick="window.__sc.saveSettings()">Lưu cài đặt</button>`);
}

async function saveSettings() {
  const patch = {
    maxItems: parseInt($('#s-max').value, 10) || 5000,
    retentionDays: parseInt($('#s-ret').value, 10) || 0,
    autoClearSecretSec: parseInt($('#s-wipe').value, 10) || 0,
    captureImages: $('#s-img').checked,
    trackPastes: $('#s-paste').checked,
    startOnLogin: $('#s-login').checked,
    ignoreApps: $('#s-apps').value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
    ignorePatterns: $('#s-pats').value.split('\n').map(x => x.trim()).filter(Boolean),
  };
  try {
    const r = await api('/api/settings', { method: 'PATCH', body: patch });
    state.settings = r.settings;
    renderStatus();
    closeModal();
    toast('Đã lưu cài đặt', '', 'ok');
  } catch (e) { toast('Không lưu được', e.message, 'err'); }
}

async function registerHotkey() {
  try {
    await api('/api/actions/hotkey', { method: 'POST', body: { id: 1, mods: 3, vk: 0x56 } });
    $('#hk-state').textContent = 'Đã gửi yêu cầu đăng ký Ctrl+Alt+V cho helper.';
  } catch (e) { $('#hk-state').textContent = 'Lỗi: ' + e.message; }
}

function openHelp() {
  modal('Cú pháp tìm kiếm', `
    <p style="color:var(--text-dim);font-size:12.5px;margin-top:0">
      Gõ nhiều từ thì tất cả đều phải khớp. Không phân biệt dấu: <b>khoa</b> tìm được <b>khoá</b>.
      Dùng <code>"ngoặc kép"</code> cho cụm chính xác.</p>
    <table class="help-table">
      <tr><td>site:stripe.com</td><td>Nội dung copy từ tên miền này</td></tr>
      <tr><td>app:chrome</td><td>Copy từ ứng dụng này</td></tr>
      <tr><td>pasteapp:notepad</td><td>Đã từng dán vào ứng dụng này</td></tr>
      <tr><td>is:secret</td><td>Chỉ những mục có API key / mật khẩu</td></tr>
      <tr><td>is:vanban <span style="color:var(--muted)">(is:prose)</span></td>
          <td>Văn bản thường — giống mục “Văn bản” ở sidebar: nội dung dạng chữ,
              <b>trừ</b> mã nguồn, đường dẫn và bí mật (đã có mục riêng)</td></tr>
      <tr><td>is:text</td><td>Mọi mục dạng chữ, gồm cả code, JSON, URL, bí mật</td></tr>
      <tr><td>is:image · is:url · is:code · is:json · is:pinned · is:unused</td><td>Lọc theo loại</td></tr>
      <tr><td>has:paste · has:note · has:url · has:secret</td><td>Có đặc điểm này</td></tr>
      <tr><td>coll:"Key cho App B"</td><td>Nằm trong bộ sưu tập</td></tr>
      <tr><td>sau:7d · sau:30d · sau:2026-01-01</td><td>Trong khoảng thời gian</td></tr>
      <tr><td>truoc:hom qua · truoc:2026-03-01</td><td>Trước mốc thời gian</td></tr>
      <tr><td>tag:config · tag:lang:Python</td><td>Theo nhãn tự động</td></tr>
      <tr><td>url:dashboard</td><td>Chuỗi xuất hiện trong URL nguồn hoặc nội dung</td></tr>
    </table>
  `, `<button class="btn primary" onclick="window.__sc.closeModal()">Đã hiểu</button>`);
}

function openClear() {
  modal('Dọn kho', `
    <p style="font-size:12.5px;color:var(--text-dim);margin-top:0">
      Thao tác này xoá các mục khỏi kho (ảnh cũng bị xoá khỏi đĩa). Không thể hoàn tác.</p>
    <label class="switch"><input type="checkbox" id="keep-pin" checked> Giữ lại những mục đã ghim</label>
  `, `<button class="btn" onclick="window.__sc.closeModal()">Huỷ</button>
      <button class="btn danger" onclick="window.__sc.doClear()">Xoá ngay</button>`);
}

async function doClear() {
  const keepPinned = $('#keep-pin').checked;
  try {
    await api('/api/actions/clear', { method: 'POST', body: { keepPinned } });
    closeModal();
    toast('Đã dọn kho', keepPinned ? 'Giữ lại các mục đã ghim.' : 'Đã xoá toàn bộ.', 'ok');
    state.selectedId = null; state.detail = null;
    await loadItems(); await loadFacets(); renderDetail();
  } catch (e) { toast('Không dọn được', e.message, 'err'); }
}

async function createCollectionPrompt(assignToId) {
  const name = prompt('Tên bộ sưu tập mới:');
  if (!name) return;
  const colors = ['#6366f1', '#22d3ee', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  try {
    const r = await api('/api/collections', { method: 'POST', body: { name, color } });
    state.collections.push(r.collection);
    renderSidebar();
    if (assignToId) { await toggleCollection(assignToId, r.collection.id); }
    toast('Đã tạo bộ sưu tập', name, 'ok');
  } catch (e) { toast('Không tạo được', e.message, 'err'); }
}

/* ------------------------------------------------------------------ sự kiện */

function wireEvents() {
  const q = $('#q');
  const applyQuery = () => {
    state.query = q.value.trim();
    state.limit = 120;
    loadItems();
  };
  let debounce;
  q.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(applyQuery, 180); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { q.value = ''; applyQuery(); q.blur(); }
    if (e.key === 'Enter') { const first = $('.card'); if (first) select(first.dataset.id); }
    e.stopPropagation();
  });
  $('#q-clear').onclick = () => { q.value = ''; applyQuery(); q.focus(); };
  $('#q-help').onclick = openHelp;

  $('#nav-scopes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]'); if (!b) return;
    state.scope = b.dataset.scope; state.collectionId = null; state.limit = 120;
    renderSidebar(); loadItems();
  });
  $('#collections').addEventListener('click', (e) => {
    const b = e.target.closest('[data-coll]'); if (!b) return;
    const id = b.dataset.coll;
    if (state.collectionId === id) { state.collectionId = null; }
    else { state.collectionId = id; state.scope = 'collection'; }
    state.limit = 120;
    renderSidebar(); loadItems();
  });
  $('#facets-apps').addEventListener('click', (e) => {
    const b = e.target.closest('[data-app]'); if (!b) return;
    setQuery(`app:"${b.dataset.app}"`);
  });
  $('#facets-sites').addEventListener('click', (e) => {
    const b = e.target.closest('[data-site]'); if (!b) return;
    setQuery(`site:${b.dataset.site}`);
  });
  $('#facets-dest').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dest]'); if (!b) return;
    setQuery(`pasteapp:"${b.dataset.dest}"`);
  });

  $('#list').addEventListener('click', (e) => {
    const c = e.target.closest('.card'); if (!c) return;
    select(c.dataset.id);
  });
  $('#list').addEventListener('dblclick', (e) => {
    const c = e.target.closest('.card'); if (c) doCopy(c.dataset.id);
  });

  $('#sort').onchange = (e) => { state.sort = e.target.value; loadItems(); };
  $('#btn-refresh').onclick = () => { loadItems(); loadFacets(); toast('Đã tải lại', '', 'ok'); };
  $('#btn-new-collection').onclick = () => createCollectionPrompt(null);
  $('#btn-overview').onclick = openOverview;
  $('#btn-settings').onclick = openSettings;
  $('#btn-export').onclick = exportJson;
  $('#btn-report').onclick = exportReport;
  $('#btn-clear').onclick = openClear;
  $('#btn-targets').onclick = async () => {
    const r = await api('/api/targets');
    state.targets = r.targets || [];
    modal('Cửa sổ có thể dán tới', `
      <p style="font-size:12.5px;color:var(--text-dim);margin-top:0">
        Đây là những cửa sổ SuperClipboard đã thấy. Chọn một mục ở danh sách rồi bấm
        <b>Dán tới ▾</b> để gửi vào đúng cửa sổ đó — không cần chuyển qua lại.</p>
      <div class="sibling-list">
        ${(r.targets || []).map(t => `<div class="sibling">
            <span class="badge app">${esc(t.proc || '?')}</span>
            <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title || '')}</span>
            <span class="n">${timeAgo(t.ts)}</span>
            <button class="icon-btn tiny go" data-focus="${esc((t.title || '').slice(0, 40))}">⌖</button>
          </div>`).join('') || '<span style="color:var(--muted);font-size:12px">Chưa thấy cửa sổ nào.</span>'}
      </div>
    `, `<button class="btn primary" onclick="window.__sc.closeModal()">Đóng</button>`);
    $$('[data-focus]').forEach(b => {
      b.onclick = () => { api('/api/actions/focus', { method: 'POST', body: { title: b.dataset.focus } }); };
    });
  };
  $('#btn-pause').onclick = async () => {
    const paused = !state.settings.pauseCapture;
    try {
      const r = await api('/api/actions/pause', { method: 'POST', body: { paused } });
      state.settings.pauseCapture = r.paused;
      renderStatus();
      toast(r.paused ? 'Đã tạm dừng ghi clipboard' : 'Đã bật ghi clipboard', '', 'ok');
    } catch (e) { toast('Lỗi', e.message, 'err'); }
  };

  document.addEventListener('keydown', onKey);
}

function setQuery(v) {
  $('#q').value = v;
  state.query = v;
  state.scope = 'all'; state.collectionId = null;
  renderSidebar();
  loadItems();
}

function onKey(e) {
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';

  if (e.key === 'Escape') {
    if ($('#modal-root').innerHTML) { closeModal(); return; }
    if (typing) { document.activeElement.blur(); return; }
    state.selectedId = null; state.detail = null; renderDetail(); renderList(); return;
  }
  if (typing) return;

  if (e.key === '/' || (e.ctrlKey && e.key.toLowerCase() === 'k')) {
    e.preventDefault(); $('#q').focus(); $('#q').select(); return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const idx = state.items.findIndex(i => i.id === state.selectedId);
    const next = e.key === 'ArrowDown' ? Math.min(state.items.length - 1, idx + 1) : Math.max(0, idx - 1);
    if (state.items[next]) { select(state.items[next].id); scrollToSelected(); }
    return;
  }
  if (e.key === 'Enter' && state.selectedId) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) doPaste(state.selectedId, state.lastTarget ? state.lastTarget.hwnd : 0);
    else doCopy(state.selectedId);
    return;
  }
  if (e.key.toLowerCase() === 'p' && state.selectedId && state.detail) {
    updateItem(state.selectedId, { pinned: !state.detail.pinned }); return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) {
    deleteItem(state.selectedId); return;
  }
}

async function saveVia(kind) {
  if (window.scHost && window.scHost.saveFile) {
    try {
      const p = await window.scHost.saveFile(kind);
      toast('Đã lưu tệp', p, 'ok');
      return;
    } catch (e) { toast('Không lưu được tệp', e.message, 'err'); return; }
  }
  window.open(kind === 'report' ? '/api/report.md' : '/api/export', '_blank');
}

function exportJson() { saveVia('json'); }
function exportReport() { saveVia('report'); }

/* ------------------------------------------------------------------ public */

window.__sc = {
  closeModal,
  saveSettings,
  doClear,
  exportJson,
  exportReport,
  registerHotkey,
  createCollectionPrompt,
  select,
};

boot();

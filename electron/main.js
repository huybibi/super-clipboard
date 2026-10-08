'use strict';
/**
 * main.js — Ứng dụng desktop SuperClipboard (Electron).
 *
 *  - Chạy máy chủ cục bộ trong cùng tiến trình rồi mở giao diện.
 *  - Biểu tượng khay hệ thống, phím tắt toàn cục Ctrl+Alt+V mở bảng lệnh nhanh.
 *  - Cửa sổ "bảng lệnh nhanh": gõ để tìm, Enter để dán thẳng vào ứng dụng
 *    mà bạn vừa rời đi — không cần chuyển cửa sổ thủ công.
 *  - Chế độ --selftest: tự kiểm tra giao diện rồi chụp ảnh màn hình để nghiệm thu.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SELFTEST = process.argv.includes('--selftest');
/** Được Windows khởi động cùng máy: chạy nền ở khay, không mở cửa sổ. */
const FROM_STARTUP = process.argv.includes('--from-startup');

let mainWindow = null;
let paletteWindow = null;
let tray = null;
let svc = null;             // { store, bridge, listen, start, stop, ... }
let baseUrl = '';
let quitting = false;
const consoleErrors = [];
let rendererProbe = null;

function argValue(name, fallback) {
  const a = process.argv.find(x => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : fallback;
}

// Thư mục dữ liệu người dùng (items.ndjson, blobs/, meta.json).
// Hồ sơ nội bộ của Chromium được đẩy xuống thư mục con "runtime" để không
// trộn lẫn với dữ liệu clipboard.
const DATA_ROOT = argValue('data-dir', path.join(app.getPath('appData'), 'SuperClipboard'));
fs.mkdirSync(path.join(DATA_ROOT, 'runtime'), { recursive: true });
app.setPath('userData', path.join(DATA_ROOT, 'runtime'));

// Danh tính ứng dụng với Windows: quyết định tên mục trong registry tự khởi động
// (mặc định của Electron là "electron.app.Electron"), nhóm trên taskbar và thông báo.
app.setAppUserModelId('SuperClipboard');

/* ------------------------------------------------------------------ tiện ích */

function isSelfProc(p) { return /electron|superclipboard/i.test(p || ''); }

/* --------------------------------------------------- khởi động cùng Windows */

/** Tham số dòng lệnh cho mục tự khởi động. */
function startupArgs() {
  const args = app.isPackaged ? [] : [app.getAppPath()];
  args.push('--from-startup');
  return args;
}

/** Windows đã ghi nhận mục tự khởi động chưa? */
function startupEnabled() {
  try {
    return !!app.getLoginItemSettings({ path: process.execPath, args: startupArgs() }).openAtLogin;
  } catch { return false; }
}

/**
 * Bật/tắt chạy cùng Windows (mục trong HKCU\...\Run).
 * force = ghi lại kể cả khi trạng thái đã đúng — dùng khi mở app để tự sửa
 * đường dẫn nếu thư mục cài đặt bị di chuyển.
 */
function applyStartup(enabled, force) {
  const want = !!enabled;
  try {
    if (!force && startupEnabled() === want) return;
    app.setLoginItemSettings({
      openAtLogin: want,
      path: process.execPath,
      args: startupArgs(),
    });
  } catch (e) { consoleErrors.push('startup: ' + e.message); }
}

/** Cửa sổ người dùng vừa rời đi — đích để dán. */
function pickTarget() {
  if (!svc) return null;
  const st = svc.bridge.state;
  if (st.lastFocus && !isSelfProc(st.lastFocus.proc)) return st.lastFocus;
  const w = st.recentWindows.find(x => !isSelfProc(x.proc));
  return w || st.lastFocus || null;
}

function trayImage() {
  const p = path.join(ROOT, 'assets', 'tray.png');
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

/* ------------------------------------------------------------------ cửa sổ */

function createMain() {
  mainWindow = new BrowserWindow({
    width: 1340, height: 860, minWidth: 940, minHeight: 620,
    backgroundColor: '#0a0c13',
    title: 'SuperClipboard',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    show: !SELFTEST && !FROM_STARTUP,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.webContents.on('console-message', (...args) => {
    const d = args[1];
    let level, message;
    if (d && typeof d === 'object' && 'level' in d) { level = d.level; message = d.message; }
    else { level = args[1]; message = args[2]; }
    const isErr = level === 'error' || level === 3;
    if (isErr) consoleErrors.push(String(message));
  });
  mainWindow.webContents.on('preload-error', (_e, p, err) => consoleErrors.push('preload: ' + err.message));
  mainWindow.webContents.on('render-process-gone', (_e, d) => consoleErrors.push('renderer gone: ' + d.reason));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(baseUrl)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    if (!quitting && tray) { e.preventDefault(); mainWindow.hide(); }
  });

  mainWindow.loadURL(baseUrl + '/');
}

function createPalette() {
  const disp = screen.getPrimaryDisplay().workAreaSize;
  const w = 680, h = 470;
  const win = new BrowserWindow({
    width: w, height: h,
    x: Math.round((disp.width - w) / 2),
    y: Math.round(disp.height * 0.22),
    frame: false, transparent: true, resizable: false, movable: true,
    skipTaskbar: true, alwaysOnTop: true, show: false,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  paletteWindow = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.on('console-message', (...args) => {
    const d = args[1];
    const level = (d && typeof d === 'object') ? d.level : args[1];
    const message = (d && typeof d === 'object') ? d.message : args[2];
    if (level === 'error' || level === 3) consoleErrors.push('palette: ' + String(message));
  });
  win.webContents.on('render-process-gone', (_e, d) => consoleErrors.push('palette gone: ' + d.reason));
  // Trang gọi window.close() sau khi dán. Cửa sổ vẫn bị huỷ thật, nên phải quên
  // tham chiếu cũ đi — giữ lại xác cửa sổ chính là lỗi "Object has been destroyed".
  win.on('closed', () => { if (paletteWindow === win) paletteWindow = null; });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('blur', () => { if (!win.isDestroyed() && win.isVisible()) win.hide(); });
}

function openPalette() {
  if (!svc) return;
  if (!paletteWindow || paletteWindow.isDestroyed()) { paletteWindow = null; createPalette(); }
  const t = pickTarget();
  const q = new URLSearchParams();
  if (t && t.hwnd) {
    q.set('target', String(t.hwnd));
    q.set('proc', String(t.proc || '').replace(/\.exe$/i, ''));
    q.set('title', t.title || '');
  }
  paletteWindow.loadURL(baseUrl + '/palette?' + q.toString());
  paletteWindow.show();
  paletteWindow.focus();
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ------------------------------------------------------------------ khay */

function buildTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('SuperClipboard — trí nhớ clipboard');
  const rebuild = () => {
    const paused = !!(svc && svc.store.settings.pauseCapture);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Mở SuperClipboard', click: showMain },
      { label: 'Bảng lệnh nhanh  (Ctrl+Alt+V)', click: openPalette },
      { type: 'separator' },
      {
        label: paused ? '▶  Tiếp tục ghi clipboard' : '⏸  Tạm dừng ghi clipboard',
        click: () => { svc.store.setSettings({ pauseCapture: !paused }); rebuild(); },
      },
      {
        label: '🚀  Khởi động cùng Windows',
        type: 'checkbox',
        checked: !!svc.store.settings.startOnLogin,
        click: (mi) => {
          svc.store.setSettings({ startOnLogin: mi.checked });
          rebuild();
        },
      },
      { label: '🧽  Xoá clipboard ngay', click: () => svc.bridge.clearClipboard() },
      { type: 'separator' },
      { label: `📊  ${svc.store.items.size} mục · ${svc.store.all().filter(i => i.secrets && i.secrets.length).length} bí mật`, enabled: false },
      { label: '📁  Mở thư mục dữ liệu', click: () => shell.openPath(svc.dataDir) },
      { type: 'separator' },
      { label: 'Thoát', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  rebuild();
  tray.on('click', showMain);
  tray.on('double-click', showMain);
  setInterval(rebuild, 15000);
}

/* ------------------------------------------------------------------ IPC */

function wireIpc() {
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:open-data-dir', () => shell.openPath(svc.dataDir));
  ipcMain.handle('app:open-external', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:save-file', async (_e, kind) => {
    const url = kind === 'report' ? '/api/report.md' : '/api/export';
    const res = await fetch(baseUrl + url);
    const buf = Buffer.from(await res.arrayBuffer());
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const name = kind === 'report' ? `kho-bi-mat-${stamp}.md` : `superclipboard-${stamp}.json`;
    const file = path.join(app.getPath('downloads'), name);
    fs.writeFileSync(file, buf);
    shell.showItemInFolder(file);
    return file;
  });
}

/* ------------------------------------------------------------------ tự kiểm thử */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runSelftest() {
  const outDir = path.join(ROOT, 'tools');
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

  // Khoá GIẢ của dữ liệu mẫu, ghép từ hai mảnh để tệp nguồn không chứa chuỗi
  // trùng mẫu khoá thật (GitHub secret scanning sẽ chặn push).
  const DEMO_SECRET = 'sk_live_' + '51H8xQ2ABCdefGHIjklMNOpqrSTUV';
  const DEMO_ANTHROPIC = 'sk-ant-api03-' + 'ZZZsecretVALUE0123456789abcdef';
  // Đối chiếu với bộ fixture dùng chung: bảo đảm phép kiểm tra rò rỉ bên dưới
  // thực sự so đúng giá trị của dữ liệu mẫu, chứ không so một chuỗi vô nghĩa.
  const fixtures = require(path.join(ROOT, 'tools', 'fake.js'));

  try {
    await new Promise((resolve) => {
      if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', resolve);
      else resolve();
    });
    await sleep(1500);

    // Chọn đúng một API key có lịch sử dán để kiểm tra dòng thời gian + dòng họ
    await mainWindow.webContents.executeJavaScript(`(() => {
      const cards = [...document.querySelectorAll('.card')];
      const pick = cards.find(c => c.querySelector('.badge.secret') && c.querySelector('.badge.dest'))
                || cards.find(c => c.querySelector('.badge.secret'));
      if (pick) pick.click();
      return !!pick;
    })()`);
    await sleep(900);

    const probe = await mainWindow.webContents.executeJavaScript(`(() => {
      const q = (s) => document.querySelector(s);
      const box = (s) => { const e = q(s); return e ? e.getBoundingClientRect() : null; };
      const body = document.body.innerHTML;
      const cards = [...document.querySelectorAll('.card')];
      return {
        navItems: document.querySelectorAll('#nav-scopes .nav-item').length,
        collections: document.querySelectorAll('#collections .chip-coll').length,
        facetApps: document.querySelectorAll('#facets-apps .facet').length,
        cards: cards.length,
        firstCardTitle: cards.length ? cards[0].querySelector('.card-title').textContent : '',
        cardBadges: document.querySelectorAll('.card .badge').length,
        selectedCards: document.querySelectorAll('.card.selected').length,
        detailSections: document.querySelectorAll('.d-section').length,
        detailTitle: q('.d-title') ? q('.d-title').textContent : '',
        timelineItems: document.querySelectorAll('.tl-item').length,
        siblingRows: document.querySelectorAll('.sibling').length,
        secretBadges: document.querySelectorAll('.badge.secret').length,
        statusBar: q('.statusbar') ? q('.statusbar').innerText.replace(/\\s+/g, ' ').trim().slice(0, 180) : '',
        layout: {
          sidebar: box('.sidebar') ? Math.round(box('.sidebar').width) : 0,
          list: box('.list') ? Math.round(box('.list').width) : 0,
          detail: box('.detail') ? Math.round(box('.detail').width) : 0,
        },
        vw: window.innerWidth, vh: window.innerHeight,
        bodyScrollH: document.body.scrollHeight,
        leaksSecret: body.indexOf('${DEMO_SECRET}') >= 0,
        leaksKey2: body.indexOf('${DEMO_ANTHROPIC}') >= 0,
        maskedMarks: document.querySelectorAll('.masked-mark').length,
        tagInput: !!document.querySelector('#tag-input'),
        tagChips: document.querySelectorAll('#detail .tag-edit .chip-coll').length,
      };
    })()`);

    rendererProbe = probe;

    check('Sidebar hiển thị đủ nhóm lọc', probe.navItems >= 8, probe.navItems + ' nhóm');
    check('Có danh sách mục trong kho', probe.cards >= 6, probe.cards + ' thẻ');
    check('Thẻ hiện nhãn nguồn / bí mật', probe.cardBadges >= 8, probe.cardBadges + ' nhãn');
    check('Tự chọn sẵn mục đầu tiên', probe.selectedCards === 1);
    check('Bảng chi tiết có đủ các khối', probe.detailSections >= 4, probe.detailSections + ' khối');
    check('Bảng chi tiết hiện tiêu đề', !!probe.detailTitle, probe.detailTitle);
    check('Có dòng thời gian copy/dán', probe.timelineItems >= 2, probe.timelineItems + ' mốc');
    check('Có khối "dòng họ" bí mật', probe.siblingRows >= 2, probe.siblingRows + ' dòng');
    check('Bố cục 3 cột dựng đúng',
      probe.layout.sidebar > 180 && probe.layout.list > 300 && probe.layout.detail > 300,
      JSON.stringify(probe.layout));
    check('Không tràn trang', probe.bodyScrollH <= probe.vh + 2,
      probe.bodyScrollH + ' vs ' + probe.vh);
    check('Bí mật KHÔNG bị lộ ra DOM', !probe.leaksSecret && !probe.leaksKey2);
    check('phép kiểm tra rò rỉ so đúng giá trị của dữ liệu mẫu',
      DEMO_SECRET === fixtures.stripe && DEMO_ANTHROPIC === fixtures.anthropic);
    check('Có đoạn được che dạng •••', probe.maskedMarks > 0, probe.maskedMarks + ' chỗ');
    check('Có ô gắn nhãn thủ công', probe.tagInput);
    check('Nhãn tự động hiện thành chip', probe.tagChips > 0, probe.tagChips + ' nhãn');
    check('Không có lỗi console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    // Công tắc trong Cài đặt phải phản ánh đúng cài đặt đang lưu
    await mainWindow.webContents.executeJavaScript(`document.querySelector('#btn-settings').click()`);
    await sleep(600);
    const setUi = await mainWindow.webContents.executeJavaScript(`(() => {
      const t = document.querySelector('#s-login');
      return { has: !!t, checked: t ? t.checked : null };
    })()`);
    check('Hộp thoại Cài đặt có công tắc “khởi động cùng Windows”',
      setUi.has && setUi.checked === !!svc.store.settings.startOnLogin,
      `giao diện=${setUi.checked} đang lưu=${!!svc.store.settings.startOnLogin}`);
    await mainWindow.webContents.executeJavaScript(`window.__sc.closeModal()`);
    await sleep(400);

    // Khởi động cùng Windows: bật -> Windows phải ghi nhận -> trả lại như ban đầu
    const startupBefore = startupEnabled();
    const setStartup = (v) => fetch(baseUrl + '/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startOnLogin: v }),
    });
    await setStartup(true);
    await sleep(600);
    check('Bật “khởi động cùng Windows” ghi được vào Windows', startupEnabled(),
      'openAtLogin=' + startupEnabled());
    await setStartup(false);
    await sleep(600);
    check('Tắt “khởi động cùng Windows” gỡ được khỏi Windows', !startupEnabled(),
      'openAtLogin=' + startupEnabled());
    if (startupBefore) { applyStartup(true, true); await sleep(300); }
    check('không để lại rác trong registry', startupEnabled() === startupBefore,
      `trước=${startupBefore} sau=${startupEnabled()}`);

    // Nhóm "Văn bản": bấm ở sidebar rồi đối chiếu với API
    const prose = await mainWindow.webContents.executeJavaScript(`(async () => {
      const nav = [...document.querySelectorAll('#nav-scopes .nav-item')];
      const item = nav.find(n => n.dataset.scope === 'text');
      if (!item) return { found: false };
      item.click();
      await new Promise(r => setTimeout(r, 700));
      const cards = [...document.querySelectorAll('.card')];
      const api = await fetch('/api/items?scope=text&limit=200').then(r => r.json());
      const res = {
        found: true, label: item.querySelector('.lbl').textContent.trim(),
        badge: parseInt(item.querySelector('.n').textContent, 10),
        cards: cards.length, apiTotal: api.total,
        withSecret: cards.filter(c => c.querySelector('.badge.secret')).length,
        titles: cards.map(c => c.querySelector('.card-title').textContent.trim().slice(0, 24)),
      };
      const all = nav.find(n => n.dataset.scope === 'all');
      if (all) all.click();
      return res;
    })()`);
    check('Bấm mục “Văn bản” lọc đúng danh sách',
      prose.found && prose.cards > 0 && prose.cards === prose.apiTotal && prose.badge === prose.apiTotal,
      `“${prose.label}” số trên sidebar=${prose.badge} thẻ=${prose.cards} api=${prose.apiTotal} :: ${(prose.titles || []).join(' / ')}`);
    check('Nhóm “Văn bản” không lẫn API key', prose.withSecret === 0, prose.withSecret + ' thẻ có nhãn bí mật');
    await sleep(600);

    // Kiểm tra bảng lệnh nhanh
    const palTest = await new Promise(async (resolve) => {
      const wp = new BrowserWindow({ show: false, width: 700, height: 500, webPreferences: { contextIsolation: true } });
      const errs = [];
      wp.webContents.on('console-message', (...a) => {
        const d = a[1];
        const lvl = d && typeof d === 'object' ? d.level : a[1];
        if (lvl === 'error' || lvl === 3) errs.push(String(d && d.message ? d.message : a[2]));
      });
      await wp.loadURL(baseUrl + '/palette?target=0&proc=notepad&title=Test');
      await sleep(900);
      const r = await wp.webContents.executeJavaScript(`(() => ({
        rows: document.querySelectorAll('.row').length,
        footer: document.querySelector('.foot') ? document.querySelector('.foot').innerText.replace(/\\s+/g,' ').slice(0,80) : '',
        target: document.querySelector('#target') ? document.querySelector('#target').textContent : ''
      }))()`);
      r.errors = errs;
      wp.destroy();
      resolve(r);
    });
    check('Bảng lệnh nhanh tải được kết quả', palTest.rows > 0, palTest.rows + ' dòng');
    check('Bảng lệnh nhanh hiện đích dán', /notepad/.test(palTest.target), palTest.target);
    check('Bảng lệnh nhanh không lỗi', palTest.errors.length === 0, palTest.errors.join(' | '));

    // Chụp ảnh giao diện để nghiệm thu
    const shot = path.join(outDir, 'ui-screenshot.png');
    const img = await mainWindow.webContents.capturePage();
    fs.writeFileSync(shot, img.toPNG());
    check('Đã chụp ảnh màn hình', fs.existsSync(shot) && fs.statSync(shot).size > 20000,
      shot + ' (' + (fs.existsSync(shot) ? fs.statSync(shot).size : 0) + ' bytes)');

    // Chụp thêm ảnh bảng lệnh nhanh
    if (!paletteWindow || paletteWindow.isDestroyed()) { paletteWindow = null; createPalette(); }
    const pt = pickTarget();
    const qs = new URLSearchParams();
    if (pt && pt.hwnd) { qs.set('target', String(pt.hwnd)); qs.set('proc', String(pt.proc || '')); qs.set('title', pt.title || ''); }
    await paletteWindow.loadURL(baseUrl + '/palette?' + qs.toString());
    await sleep(800);
    const shot2 = path.join(outDir, 'palette-screenshot.png');
    const img2 = await paletteWindow.webContents.capturePage();
    fs.writeFileSync(shot2, img2.toPNG());
    check('Đã chụp ảnh bảng lệnh nhanh', fs.existsSync(shot2) && fs.statSync(shot2).size > 5000, shot2);

    // Bấm Ctrl+Alt+V hai lần liên tiếp — cách người dùng thật sự mở bảng lệnh nhanh.
    // Lần thứ hai tới khi lần thứ nhất còn đang tải, đây từng gây lỗi JavaScript.
    const rejErrors = [];
    const onRejection = (r) => rejErrors.push('unhandled: ' + (r && r.message ? r.message : String(r)));
    process.on('unhandledRejection', onRejection);
    const consoleBefore = consoleErrors.length;
    openPalette();
    openPalette();
    await sleep(1600);
    process.off('unhandledRejection', onRejection);
    const noise = rejErrors.concat(consoleErrors.slice(consoleBefore));
    check('Bấm Ctrl+Alt+V hai lần liên tiếp không sinh lỗi JavaScript',
      noise.length === 0, noise.slice(0, 3).join(' | '));

    // Dán một mục rồi bấm Ctrl+Alt+V lần nữa: trang gọi window.close() sau khi dán,
    // cửa sổ bị huỷ, lần mở sau đó gọi loadURL trên xác cửa sổ và ném
    // "TypeError: Object has been destroyed" ở main process.
    if (!paletteWindow || paletteWindow.isDestroyed()) createPalette();
    paletteWindow.show();
    await sleep(400);
    await paletteWindow.webContents.executeJavaScript('window.close()');
    await sleep(700);
    const wasDestroyed = !paletteWindow || paletteWindow.isDestroyed();
    let reopenErr = null;
    try {
      openPalette();
      await sleep(900);
      const shown = paletteWindow && !paletteWindow.isDestroyed() &&
        (await paletteWindow.webContents.executeJavaScript('document.querySelectorAll(".row").length'));
      if (!shown) reopenErr = new Error('mở lại nhưng bảng lệnh nhanh không có nội dung');
    } catch (e) { reopenErr = e; }
    check('Dán xong rồi mở lại bảng lệnh nhanh không lỗi',
      !reopenErr, (reopenErr ? reopenErr.message : 'ok') + (wasDestroyed ? ' [cửa sổ bị huỷ bởi window.close()]' : ''));
  } catch (e) {
    check('Chạy được toàn bộ kịch bản kiểm thử', false, e.message);
  }

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  console.log('\n===== KIỂM THỬ GIAO DIỆN =====');
  for (const r of results) console.log(`${r.ok ? '  OK  ' : '  FAIL'} ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
  console.log(`\n===== ${passed}/${results.length} PASS =====`);
  fs.writeFileSync(path.join(ROOT, 'tools', 'ui-selftest.json'),
    JSON.stringify({ results, probe: rendererProbe, consoleErrors }, null, 2));
  app.exit(failed.length ? 1 : 0);
}

/* ------------------------------------------------------------------ vòng đời */

async function start() {
  const dataDir = DATA_ROOT;
  fs.mkdirSync(dataDir, { recursive: true });

  const { createApp } = require(path.join(ROOT, 'server', 'server.js'));
  svc = createApp({ dataDir });
  const port = await svc.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${port}`;
  svc.start();

  // Cài đặt đổi từ giao diện hoặc menu khay -> áp ngay xuống Windows.
  svc.store.on('settings', (s) => applyStartup(s.startOnLogin));
  // Mở app mà tính năng đang bật -> ghi lại để tự sửa nếu thư mục bị di chuyển.
  // (Khi tính năng đang tắt thì KHÔNG đụng tới registry.)
  if (svc.store.settings.startOnLogin) applyStartup(true, true);

  if (svc.bridge) {
    svc.bridge.on('ready', () => {
      // Đăng ký phím tắt toàn cục: Ctrl + Alt + V
      svc.bridge.registerHotkey(1, 0x0002 | 0x0001, 0x56);
    });
    svc.bridge.on('hotkey', (id) => { if (id === 1) openPalette(); });
  }

  wireIpc();
  createMain();
  if (!SELFTEST) buildTray();

  if (SELFTEST) {
    await sleep(300);
    runSelftest();
  }
}

if (!app.requestSingleInstanceLock() && !SELFTEST) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.whenReady().then(start).catch((e) => {
    console.error('Không khởi động được:', e);
    app.exit(1);
  });
}

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { try { if (svc) svc.stop(); } catch { } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow) showMain(); });

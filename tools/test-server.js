'use strict';
/**
 * test-server.js — Kiểm thử đầu-cuối tầng server + kho + tìm kiếm.
 *
 * Mô phỏng đúng câu chuyện của người dùng:
 *   - copy API key A1 từ trang X (có SourceURL) rồi A2 từ cùng trang
 *   - copy một đoạn văn bản thường
 *   - copy một ảnh
 *   - dán A1 vào "ứng dụng B" (cửa sổ kiểm thử) và kiểm tra app có biết không
 *   - tìm lại trang X, tìm không dấu, lọc theo bí mật
 *
 *   node tools/test-server.js
 */

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIPPS = path.join(ROOT, 'tools', 'clip.ps1');
const SAMPLE = path.join(ROOT, 'tools', 'sample.png');
const TMP = path.join(os.tmpdir(), 'SuperClipboard', 'servertest');
const DATA = path.join(TMP, 'data');

const PS = 'powershell.exe';
const psArgs = (...a) => ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CLIPPS, ...a];

function clip(action, extra = {}) {
  const args = psArgs('-Action', action);
  for (const [k, v] of Object.entries(extra)) args.push('-' + k, v);
  return execFileSync(PS, args, { encoding: 'utf8' }).trim();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  OK   ${name}${detail ? '  → ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  → ' + detail : ''}`); }
}

const { stripe: KEY1, stripe2: KEY2 } = require('./fake.js');
const URLX = 'https://dashboard.stripe.com/apikeys?utm_source=nav&utm_medium=email';
const PLAIN = 'Báo cáo tuần 42: doanh thu tăng 18%, cần gửi cho khách hàng trước 17h.';

async function api(port, p, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function waitFor(fn, ms = 6000, step = 120) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  let backedUp = 'empty';
  try { backedUp = clip('save', { Path: path.join(TMP, 'backup') }); } catch { }
  console.log(`[chuẩn bị] clipboard hiện tại: ${backedUp}`);

  // Cảnh báo nếu ứng dụng thật đang chạy: nó cũng nghe clipboard hệ thống.
  try {
    const n = parseInt(execFileSync('powershell.exe',
      ['-NoProfile', '-Command', '(Get-Process SuperClipHelper -ErrorAction SilentlyContinue | Measure-Object).Count'],
      { encoding: 'utf8' }).trim(), 10);
    if (n > 0) {
      console.log('  ⚠  SuperClipboard đang chạy — nội dung thử có thể lọt vào kho thật.');
      console.log('     Hãy focus vào cửa sổ SuperClipboard trong lúc chạy test, hoặc thoát app trước.\n');
    }
  } catch { }

  const { createApp } = require('../server/server.js');
  const app = createApp({ dataDir: DATA });
  const port = await app.listen(0);
  app.start();
  console.log(`[chuẩn bị] server tại cổng ${port}, dữ liệu tại ${DATA}\n`);

  await waitFor(async () => (await api(port, '/api/status')).body.helperReady, 5000);
  const st = (await api(port, '/api/status')).body;
  check('helper sẵn sàng phục vụ server', st.helperReady, `pid=${st.helperPid} v${st.helperVersion}`);

  // ---------------- 1. Thu thập nội dung ----------------
  console.log('\n[1] Copy dữ liệu như người dùng thật');

  clip('settext', { Text: PLAIN });
  await sleep(500);
  clip('setrich', { Text: KEY1, Fragment: `<code>${KEY1}</code>`, Url: URLX });
  await sleep(500);
  clip('setrich', { Text: KEY2, Fragment: `<code>${KEY2}</code>`, Url: 'https://dashboard.stripe.com/apikeys' });
  await sleep(500);
  clip('setimage', { Path: SAMPLE });
  await sleep(900);

  const state = (await api(port, '/api/state')).body;
  check('lưu đủ 4 mục vào kho', state.total === 4, `total=${state.total}`);
  check('nhận diện được 2 API key Stripe', state.facets.secrets === 2, `secrets=${state.facets.secrets}`);
  check('nhận diện được 1 ảnh', state.facets.images === 1);

  const stripe = state.items.filter(i => i.sourceDomain === 'dashboard.stripe.com');
  check('biết key đến từ dashboard.stripe.com', stripe.length === 2);
  check('đã lược bỏ tham số rác trong URL nguồn',
    stripe.some(i => i.sourceUrl === 'https://dashboard.stripe.com/apikeys'),
    stripe.map(i => i.sourceUrl).join(' | '));

  // ---------------- 2. An toàn: không lộ bí mật ----------------
  console.log('\n[2] An toàn: giá trị bí mật không bị lộ ra giao diện');
  const rawJson = JSON.stringify(state);
  check('JSON gửi cho UI KHÔNG chứa giá trị key thật', !rawJson.includes(KEY1) && !rawJson.includes(KEY2));
  const keyItem = stripe.find(i => i.secrets.length);
  check('có bản che dạng sk_live••••', /sk_live•+/.test(keyItem.secrets[0].masked), keyItem.secrets[0].masked);

  // ---------------- 3. Tìm kiếm ----------------
  console.log('\n[3] Tìm kiếm');
  let r = await api(port, '/api/items?query=' + encodeURIComponent('stripe'));
  check('tìm "stripe" ra 2 key', r.body.total === 2, `total=${r.body.total}`);

  r = await api(port, '/api/items?query=' + encodeURIComponent('site:stripe.com is:secret'));
  check('cú pháp site: + is:secret', r.body.total === 2, `total=${r.body.total}`);

  r = await api(port, '/api/items?query=' + encodeURIComponent('Báo cáo'));
  check('tìm có dấu "Báo cáo"', r.body.total === 1, `total=${r.body.total}`);

  r = await api(port, '/api/items?query=' + encodeURIComponent('bao cao tuan'));
  check('tìm KHÔNG dấu "bao cao tuan" vẫn ra', r.body.total === 1, `total=${r.body.total}`);

  r = await api(port, '/api/items?query=' + encodeURIComponent('is:image'));
  check('lọc is:image', r.body.total === 1, `total=${r.body.total}`);

  r = await api(port, '/api/items?query=' + encodeURIComponent('khach hang truoc 17h'));
  check('tìm theo cụm từ trong câu', r.body.total === 1, `total=${r.body.total}`);

  r = await api(port, '/api/items?scope=secrets&sort=copies');
  check('lọc theo phạm vi "Kho bí mật"', r.body.total === 2, `total=${r.body.total}`);

  // ---------------- 4. Dòng họ A1/A2 ----------------
  console.log('\n[4] Dòng họ bí mật A1 → A2');
  const detail = (await api(port, `/api/items/${keyItem.id}`)).body;
  check('thấy được "anh em" cùng dịch vụ + cùng nguồn', detail.lineage.siblingCount === 1,
    `family=${detail.lineage.family}`);
  check('danh sách anh em có 2 mục', detail.lineage.siblings.length === 2);

  // ---------------- 5. Ghi chú, ghim, bộ sưu tập ----------------
  console.log('\n[5] Ghim, ghi chú, bộ sưu tập');
  const coll = (await api(port, '/api/collections', { method: 'POST', body: { name: 'Key cho App B', color: '#22d3ee' } })).body.collection;
  await api(port, `/api/items/${keyItem.id}`, {
    method: 'POST', body: { pinned: true, note: 'Dùng cho App B, hết hạn 31/12', collections: [coll.id] },
  });
  r = await api(port, '/api/items?query=' + encodeURIComponent('coll:"Key cho App B"'));
  check('lọc theo bộ sưu tập', r.body.total === 1, `total=${r.body.total}`);
  r = await api(port, '/api/items?query=is:pinned');
  check('lọc is:pinned', r.body.total === 1, `total=${r.body.total}`);
  r = await api(port, '/api/items?query=has:note');
  check('lọc has:note', r.body.total === 1, `total=${r.body.total}`);

  // ---------------- 6. Sự kiện tự động (SSE) ----------------
  console.log('\n[6] Thông báo trực tiếp (SSE)');
  const sse = spawn(process.execPath, ['-e', `
    const http=require('http');
    http.get('http://127.0.0.1:${port}/api/events',(res)=>{
      let n=0;
      res.on('data',(d)=>{ const s=d.toString(); if(s.includes('"type"')) { n++; process.stdout.write(s); }
        if(n>=4) process.exit(0); });
    });
    setTimeout(()=>process.exit(0), 5000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  let sseOut = '';
  sse.stdout.on('data', d => { sseOut += d.toString(); });
  await sleep(300);
  clip('settext', { Text: 'Su kien SSE thu nghiem 12345' });
  await sleep(1500);
  check('giao diện nhận được sự kiện item:new', /item:new/.test(sseOut), sseOut.split('\n')[0].slice(0, 60));
  sse.kill();

  // ---------------- 6b. Phân loại theo nhóm ở sidebar ----------------
  console.log('\n[6b] Phân loại theo nhóm');
  clip('settext', { Text: 'https://platform.openai.com/api-keys' });
  await sleep(700);

  const gText = (await api(port, '/api/items?scope=text&limit=50')).body;
  check('nhóm "Văn bản" gồm đúng các đoạn chữ thường', gText.total === 2, `total=${gText.total}`);
  check('nhóm "Văn bản" KHÔNG chứa API key',
    !gText.items.some(i => i.secrets.length),
    gText.items.map(i => (i.secrets.length ? 'KEY!' : 'ok')).join(','));

  const gLink = (await api(port, '/api/items?scope=urls&limit=50')).body;
  check('nhóm "Đường dẫn" chỉ gồm mục có nội dung LÀ link', gLink.total === 1, `total=${gLink.total}`);

  const gSec = (await api(port, '/api/items?scope=secrets&limit=50')).body;
  check('nhóm "Kho bí mật" vẫn đủ 2 key', gSec.total === 2, `total=${gSec.total}`);

  const qProse = (await api(port, '/api/items?query=' + encodeURIComponent('is:vanban'))).body;
  check('từ khoá is:vanban khớp với nhóm "Văn bản"', qProse.total === gText.total,
    `is:vanban=${qProse.total} vs scope=${gText.total}`);

  const faces = (await api(port, '/api/facets')).body;
  check('số đếm ở sidebar khớp với danh sách thật',
    faces.text === gText.total && faces.urls === gLink.total && faces.secrets === gSec.total,
    `text=${faces.text} urls=${faces.urls} secrets=${faces.secrets}`);

  // Chống hồi quy: nội dung được copy trong khi chính cửa sổ app đang focus
  // (ví dụ do bộ kiểm thử ghi vào clipboard) KHÔNG được ghi vào kho.
  const totalBefore = (await api(port, '/api/items?scope=all&limit=500')).body.total;
  const ignored = app.store.ingest({
    kind: 'text', text: 'KHONG DUOC GHI VAO KHO neu copy tu chinh app',
    srcProc: 'electron', srcPid: process.pid, seq: 999999, ts: Date.now(),
  }, { proc: 'electron', pid: process.pid, title: 'SuperClipboard' });
  const totalAfter = (await api(port, '/api/items?scope=all&limit=500')).body.total;
  check('bỏ qua nội dung copy từ chính cửa sổ app', ignored === null && totalAfter === totalBefore,
    `ingest=${ignored} trước=${totalBefore} sau=${totalAfter}`);

  // ---------------- 7. Dán vào "ứng dụng B" ----------------
  console.log('\n[7] Dán vào ứng dụng đích và ghi nhận đích đến');
  const targetOut = path.join(TMP, 'target.txt');
  const win = spawn(PS, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'tools', 'test-window.ps1'),
    '-Title', 'SuperClipboard Test Target', '-DelayMs', '2200', '-LifeMs', '4500',
    '-OutFile', targetOut], { stdio: ['ignore', 'pipe', 'ignore'] });
  await sleep(250);
  app.bridge.focusTitle('SuperClipboard Test Target');

  // Đặt key vào clipboard rồi để cửa sổ đích tự dán bằng Ctrl+V thật
  const keyText = (await api(port, `/api/items/${keyItem.id}/reveal`, { method: 'POST' })).body.text;
  await api(port, `/api/items/${keyItem.id}/copy`, { method: 'POST' });
  await sleep(400);
  const got = await waitFor(() => fs.existsSync(targetOut) && fs.readFileSync(targetOut, 'utf8').trim(), 8000, 200);
  check('nội dung được dán thật vào ứng dụng đích', got === keyText, got ? JSON.stringify(String(got).slice(0, 30)) : 'không có');

  const after = await waitFor(async () => {
    const d = (await api(port, `/api/items/${keyItem.id}`)).body;
    return d.item.pasteCount > 0 ? d : null;
  }, 5000, 200);
  check('app biết key đã được dán vào ứng dụng nào', !!after,
    after ? after.item.pasteApps.map(p => `${p.app}×${p.count}`).join(', ') : '');
  check('tên ứng dụng đích được ghi lại là powershell',
    !!(after && after.item.pasteApps.some(p => /powershell/i.test(p.app))),
    after ? JSON.stringify(after.item.pasteApps) : '');
  win.kill();

  // ---------------- 8. Báo cáo & xuất dữ liệu ----------------
  console.log('\n[8] Báo cáo & xuất dữ liệu');
  const rep = await fetch(`http://127.0.0.1:${port}/api/report.md`).then(x => x.text());
  check('báo cáo Markdown có bảng bí mật', /Kho bí mật/.test(rep) && /dashboard\.stripe\.com/.test(rep));
  check('báo cáo cũng che giá trị', !rep.includes(KEY1));
  const exp = await api(port, '/api/export');
  check('xuất JSON toàn bộ kho', exp.body.items && exp.body.items.length >= 4);

  // ---------------- 9. Xoá mục & khởi động lại ----------------
  console.log('\n[9] Xoá mục và mở lại kho');
  const victim = (await api(port, '/api/items?scope=all&limit=50')).body.items
    .find(i => i.kind === 'text' && !i.secrets.length);
  await api(port, `/api/items/${victim.id}/delete`, { method: 'POST' });
  const goneNow = (await api(port, `/api/items/${victim.id}`)).status;
  check('xoá được mục khỏi kho', goneNow === 404, 'HTTP ' + goneNow);

  // Mở lại kho từ chính nhật ký đó: mục đã xoá KHÔNG được sống lại,
  // và không được sinh ra bản ghi rỗng nào.
  const { Store } = require('../server/store.js');
  const copyDir = path.join(TMP, 'reopen');
  fs.rmSync(copyDir, { recursive: true, force: true });
  fs.mkdirSync(copyDir, { recursive: true });
  fs.copyFileSync(path.join(DATA, 'items.ndjson'), path.join(copyDir, 'items.ndjson'));
  const reopened = new Store(copyDir).init();
  const ghosts = [...reopened.items.values()].filter(i => !i.kind || !i.id);
  check('mục đã xoá KHÔNG sống lại sau khi mở lại kho', !reopened.get(victim.id),
    `kho còn ${reopened.items.size} mục`);
  check('không sinh ra mục "(rỗng)" nào', ghosts.length === 0,
    `${ghosts.length} bản ghi rỗng`);
  check('mở lại kho vẫn giữ đủ các mục còn lại',
    reopened.items.size === (await api(port, '/api/items?scope=all&limit=500')).body.total,
    `mở lại=${reopened.items.size}`);

  // ---------------- 10. Xoá clipboard ----------------
  console.log('\n[10] Quên bí mật');
  await api(port, '/api/actions/wipe-clipboard', { method: 'POST' });
  await sleep(300);
  const afterWipe = clip('gettext', { Path: path.join(TMP, 'wipe') });
  check('xoá clipboard theo yêu cầu', afterWipe === 'notext', afterWipe);

  // ---------------- kết thúc ----------------
  app.stop();
  await sleep(400);
  try { clip('restore', { Path: path.join(TMP, 'backup') }); console.log('\n[phục hồi] đã trả lại clipboard ban đầu'); } catch { }

  console.log(`\n===== KẾT QUẢ SERVER: ${pass} PASS, ${fail} FAIL =====`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

'use strict';
/**
 * test-helper.js — Kiểm thử đầu-cuối SuperClipHelper.exe
 *
 * Kịch bản đúng như câu chuyện của người dùng:
 *   1. Copy text thường
 *   2. Copy API key từ một trang web (CF_HTML có SourceURL)  -> phải biết trang nguồn
 *   3. Copy ảnh
 *   4. Đặt lại nội dung vào clipboard từ app (settext/setimage) -> không được tự lưu lại
 *   5. Xoá clipboard
 *   6. Đăng ký phím tắt toàn cục
 *
 * Clipboard hiện tại của người dùng được SAO LƯU trước và PHỤC HỒI sau khi test.
 *
 *   node tools/test-helper.js
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'helper', 'SuperClipHelper.exe');
const CLIPPS = path.join(ROOT, 'tools', 'clip.ps1');
const SAMPLE = path.join(ROOT, 'tools', 'sample.png');
const TMP = path.join(os.tmpdir(), 'SuperClipboard', 'test');

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
  if (ok) { pass++; console.log(`  OK   ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  const backupBase = path.join(TMP, 'backup');

  // Cảnh báo nếu ứng dụng thật đang chạy: nó cũng nghe clipboard hệ thống.
  try {
    const n = parseInt(execFileSync('powershell.exe',
      ['-NoProfile', '-Command', '(Get-Process SuperClipHelper -ErrorAction SilentlyContinue | Measure-Object).Count'],
      { encoding: 'utf8' }).trim(), 10);
    if (n > 0) {
      console.log('  ⚠  SuperClipboard đang chạy — bộ kiểm thử này sẽ thay đổi clipboard thật vài lần.');
      console.log('     Ứng dụng bỏ qua nội dung copy từ cửa sổ của chính nó, nhưng nếu cửa sổ khác');
      console.log('     đang được focus thì nội dung thử có thể lọt vào kho thật. Nên thoát app trước khi test.\n');
    }
  } catch { }

  // ---- Sao lưu clipboard người dùng ----
  let backedUp = 'empty';
  try { backedUp = clip('save', { Path: backupBase }); } catch (e) { console.log('  (không sao lưu được clipboard: ' + e.message + ')'); }
  console.log(`[chuẩn bị] clipboard hiện tại: ${backedUp}\n`);

  const lines = [];
  const helper = spawn(EXE, ['--tmp', path.join(TMP, 'tmp')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  helper.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { lines.push({ t: 'unparsed', raw: line }); }
    }
  });
  helper.stderr.on('data', d => process.stderr.write('[helper stderr] ' + d));

  const send = (obj) => { helper.stdin.write(JSON.stringify(obj) + '\n'); };
  const waitFor = async (pred, ms = 2500) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = lines.find(pred);
      if (hit) return hit;
      await sleep(40);
    }
    return null;
  };

  const ready = await waitFor(l => l.t === 'ready', 3000);
  check('helper khởi động và báo ready', !!ready, ready ? `pid=${ready.pid} ${ready.arch}` : '');

  // ---- 1. Copy text thường ----
  console.log('\n[1] Copy văn bản thường');
  const T1 = 'Ghi chú: hop voi khach hang luc 14h30 (test 001)';
  clip('settext', { Text: T1 });
  let ev = await waitFor(l => l.t === 'clip' && l.text === T1);
  check('bắt được sự kiện copy', !!ev, ev ? `kind=${ev.kind}` : '');
  check('phân loại là text', ev && ev.kind === 'text');
  check('có tên tiến trình nguồn', !!(ev && ev.srcProc), ev ? `src=${ev.srcProc}` : '');

  // ---- 2. Copy API key từ web ----
  console.log('\n[2] Copy API key từ trang web (CF_HTML + SourceURL)');
  lines.length = 0;
  const KEY = require('./fake.js').stripe;
  const URLX = 'https://dashboard.stripe.com/apikeys?utm_source=nav';
  clip('setrich', {
    Text: KEY, Fragment: `<span style="font-family:monospace">${KEY}</span>`, Url: URLX,
  });
  ev = await waitFor(l => l.t === 'clip' && l.text === KEY);
  check('bắt được key', !!ev);
  check('đọc đúng SourceURL (biết trang nguồn)', ev && ev.sourceUrl === URLX, ev ? String(ev.sourceUrl) : '');
  check('giữ được HTML gốc', !!(ev && ev.html && ev.html.includes('monospace')));

  // ---- 3. Copy ảnh ----
  console.log('\n[3] Copy ảnh');
  lines.length = 0;
  execFileSync(PS, ['-STA', '-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;$i=[System.Drawing.Image]::FromFile('${SAMPLE}');[System.Windows.Forms.Clipboard]::SetImage($i);$i.Dispose()`],
    { stdio: 'ignore' });
  ev = await waitFor(l => l.t === 'clip' && (l.kind === 'image' || l.kind === 'text'), 3000);
  check('bắt được sự kiện clipboard sau khi copy ảnh', !!ev, ev ? `kind=${ev.kind} ${ev.width || 0}x${ev.height || 0}` : '');
  check('nhận đúng là ảnh (kèm tệp PNG tạm)', !!(ev && ev.imageFile && fs.existsSync(ev.imageFile)), ev ? String(ev.imageFile) : '');

  // ---- 4. Ghi lại clipboard từ app ----
  console.log('\n[4] App tự đặt nội dung vào clipboard (không được tự lưu lại)');
  lines.length = 0;
  const T4 = 'PASTE-BACK: gia tri duoc dan lai tu SuperClipboard';
  send({ cmd: 'settext', text: T4, html: '<b>' + T4 + '</b>', url: 'https://example.com/nguon' });
  const okSet = await waitFor(l => l.t === 'setok' && l.what === 'text', 3000);
  check('helper xác nhận đã đặt clipboard', !!okSet, okSet ? `seq=${okSet.seq}` : '');
  if (!okSet) {
    const err = lines.find(l => l.t === 'error');
    if (err) console.log('       ↳ helper báo lỗi:', JSON.stringify(err));
  }
  await sleep(600);
  const selfCapture = lines.find(l => l.t === 'clip');
  check('KHÔNG tự bắt lại nội dung mình vừa đặt', !selfCapture, selfCapture ? JSON.stringify(selfCapture).slice(0, 90) : '');
  const got = path.join(TMP, 'roundtrip');
  clip('gettext', { Path: got });
  const back = fs.readFileSync(got + '.txt', 'utf8');
  check('nội dung trong clipboard đúng từng ký tự', back === T4, JSON.stringify(back.slice(0, 40)));

  // ---- 5. Ghi ảnh trở lại clipboard ----
  console.log('\n[5] Dán lại ảnh từ kho');
  lines.length = 0;
  send({ cmd: 'setimage', path: SAMPLE });
  const okImg = await waitFor(l => l.t === 'setok' && l.what === 'image', 3000);
  check('đặt ảnh vào clipboard', !!okImg);
  const dim = clip('getimage', { Path: path.join(TMP, 'check') });
  check('ảnh trong clipboard đúng kích thước 240x120', dim === '240x120', dim);

  // ---- 6. Xoá clipboard ----
  console.log('\n[6] Xoá clipboard (tự động quên bí mật)');
  send({ cmd: 'clearcip' });
  const okClear = await waitFor(l => l.t === 'setok' && l.what === 'clear', 3000);
  check('xoá clipboard thành công', !!okClear);
  await sleep(300);
  const after = clip('gettext', { Path: path.join(TMP, 'after') });
  check('clipboard đã rỗng', after === 'notext', after);

  // ---- 7. Phím tắt toàn cục ----
  console.log('\n[7] Đăng ký phím tắt toàn cục');
  // Dùng tổ hợp riêng của bộ kiểm thử (Ctrl+Alt+F9) để không đụng vào Ctrl+Alt+V
  // của ứng dụng đang chạy.
  send({ cmd: 'hotkey', id: 91, mods: 3, vk: 0x78 });
  const hk = await waitFor(l => l.t === 'hotkeyreg' && l.id === 91, 3000);
  check('đăng ký được phím tắt toàn cục', !!(hk && hk.ok), hk ? `err=${hk.err}` : '');
  send({ cmd: 'hotkey', id: 92, mods: 3, vk: 0x78 });
  const hk2 = await waitFor(l => l.t === 'hotkeyreg' && l.id === 92, 3000);
  check('báo lỗi rõ ràng khi tổ hợp đã bị chiếm (mã 1409)',
    !!(hk2 && !hk2.ok && hk2.err === 1409), hk2 ? `ok=${hk2.ok} err=${hk2.err}` : '');
  send({ cmd: 'unhotkey', id: 91 });
  await waitFor(l => l.t === 'hotkeyunreg' && l.id === 91, 2000);

  // ---- 8. Ping ----
  send({ cmd: 'ping' });
  const pong = await waitFor(l => l.t === 'pong', 2000);
  check('helper còn sống (ping/pong)', !!pong);

  // ---- Kết thúc ----
  send({ cmd: 'quit' });
  await sleep(400);
  if (!helper.killed) helper.kill();

  // ---- Phục hồi clipboard ----
  try { clip('restore', { Path: backupBase }); console.log('\n[phục hồi] đã trả lại clipboard ban đầu (' + backedUp + ')'); }
  catch (e) { console.log('\n[phục hồi] lỗi: ' + e.message); }

  console.log(`\n===== KẾT QUẢ HELPER: ${pass} PASS, ${fail} FAIL =====`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

'use strict';
/**
 * make-shortcut.js — Tạo shortcut "SuperClipboard" trên Desktop (Windows).
 *
 *   node tools/make-shortcut.js           # tạo shortcut, sinh assets/icon.ico nếu thiếu
 *   node tools/make-shortcut.js --force   # sinh lại assets/icon.ico rồi tạo shortcut
 *
 * Shortcut trỏ thẳng vào electron.exe kèm đường dẫn app và KHÔNG có cờ
 * --from-startup, nên bấm là cửa sổ chính mở ra. Nếu app đang chạy nền ở khay,
 * lần chạy này trở thành "tiến trình thứ hai" và được chuyển thành hiện cửa sổ
 * nhờ requestSingleInstanceLock() trong electron/main.js.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const ICO = path.join(ASSETS, 'icon.ico');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const NAME = 'SuperClipboard';

/** Bọc các ảnh PNG thành một tệp .ico (Windows Vista+ đọc được entry nén PNG). */
function buildIco(pngPaths) {
  const imgs = pngPaths.filter(p => fs.existsSync(p)).map(p => {
    const buf = fs.readFileSync(p);
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Không phải PNG: ' + p);
    return { buf, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  });
  if (!imgs.length) throw new Error('Thiếu assets/icon.png — chạy: node tools/make-icon.js');

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type = icon
  header.writeUInt16LE(imgs.length, 4);  // số ảnh

  const dir = Buffer.alloc(16 * imgs.length);
  let offset = 6 + dir.length;
  imgs.forEach((im, i) => {
    const o = i * 16;
    dir.writeUInt8(im.w >= 256 ? 0 : im.w, o);   // 0 nghĩa là 256
    dir.writeUInt8(im.h >= 256 ? 0 : im.h, o + 1);
    dir.writeUInt8(0, o + 2);                    // số màu trong bảng màu
    dir.writeUInt8(0, o + 3);                    // reserved
    dir.writeUInt16LE(1, o + 4);                 // color planes
    dir.writeUInt16LE(32, o + 6);                // bits per pixel
    dir.writeUInt32LE(im.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += im.buf.length;
  });

  return Buffer.concat([header, dir, ...imgs.map(i => i.buf)]);
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function main() {
  if (process.platform !== 'win32') {
    console.error('make-shortcut.js chỉ dùng trên Windows.');
    process.exit(1);
  }
  if (!fs.existsSync(EXE)) {
    console.error('Không thấy ' + EXE);
    console.error('Bản cài Electron đang thiếu/hỏng. Sửa bằng:');
    console.error('  npm install --prefer-offline --no-audit --no-fund');
    console.error('  node node_modules\\electron\\install.js');
    process.exit(1);
  }

  if (process.argv.includes('--force') || !fs.existsSync(ICO)) {
    fs.mkdirSync(ASSETS, { recursive: true });
    fs.writeFileSync(ICO, buildIco([path.join(ASSETS, 'icon.png'), path.join(ASSETS, 'tray.png')]));
    console.log('Đã ghi ' + path.relative(ROOT, ICO) + ' (' + fs.statSync(ICO).size + ' byte)');
  }

  const ps = [
    "$ErrorActionPreference='Stop'",
    "$desktop=[Environment]::GetFolderPath('DesktopDirectory')",
    '$ws=New-Object -ComObject WScript.Shell',
    '$sc=$ws.CreateShortcut((Join-Path $desktop ' + psQuote(NAME + '.lnk') + '))',
    '$sc.TargetPath=' + psQuote(EXE),
    '$sc.Arguments=' + psQuote('"' + ROOT + '"'),
    '$sc.WorkingDirectory=' + psQuote(ROOT),
    '$sc.IconLocation=' + psQuote(ICO + ',0'),
    '$sc.Description=' + psQuote('SuperClipboard — trí nhớ clipboard (chạy nền ở khay)'),
    '$sc.Save()',
    'Write-Output ("DA-TAO:" + (Join-Path $desktop ' + psQuote(NAME + '.lnk') + '))'
  ].join('; ');

  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    console.error((r.stderr || '').trim() || 'PowerShell trả mã lỗi ' + r.status);
    process.exit(1);
  }
  const line = String(r.stdout || '').split(/\r?\n/).find(x => x.startsWith('DA-TAO:'));
  const lnk = line ? line.slice('DA-TAO:'.length).trim() : '';
  if (!lnk || !fs.existsSync(lnk)) {
    console.error('Không tạo được shortcut.'); process.exit(1);
  }
  console.log('Đã tạo shortcut: ' + lnk);
  console.log('  → ' + EXE + ' "' + ROOT + '"');
}

main();

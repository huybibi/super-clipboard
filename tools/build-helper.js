'use strict';
/**
 * build-helper.js — Biên dịch SuperClipHelper.cs thành SuperClipHelper.exe
 * Dùng csc.exe có sẵn trong .NET Framework (không cần cài thêm gì).
 *
 *   node tools/build-helper.js
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'helper', 'SuperClipHelper.cs');
const OUT = path.join(ROOT, 'helper', 'SuperClipHelper.exe');

function findCsc() {
  const candidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('Không tìm thấy csc.exe của .NET Framework 4.x');
}

function build() {
  const csc = findCsc();
  console.log('[build] compiler:', csc);
  console.log('[build] source   :', SRC);

  const fw = path.dirname(csc);
  const args = [
    '/nologo',
    '/target:exe',
    '/platform:anycpu',
    '/optimize+',
    '/warn:0',
    '/out:' + OUT,
    '/reference:' + path.join(fw, 'System.dll'),
    '/reference:' + path.join(fw, 'System.Core.dll'),
    '/reference:' + path.join(fw, 'System.Drawing.dll'),
    '/reference:' + path.join(fw, 'System.Windows.Forms.dll'),
    SRC,
  ];

  execFileSync(csc, args, { stdio: 'inherit' });
  const st = fs.statSync(OUT);
  console.log(`[build] OK -> ${OUT} (${st.size} bytes)`);
}

if (require.main === module) {
  try { build(); } catch (e) {
    console.error('[build] LỖI:', e.message);
    process.exit(1);
  }
}

module.exports = { build };

'use strict';
/**
 * make-icon.js — Sinh icon ứng dụng (assets/icon.png 256px, assets/tray.png 32px).
 *   node tools/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const { Canvas, encode, roundRect } = require('./png.js');

const A = [99, 102, 241];    // #6366f1 indigo
const B = [168, 85, 247];    // #a855f7 violet
const ACCENT = [34, 211, 238]; // #22d3ee cyan
const INK = [15, 18, 34];    // nền tối

function lerp(a, b, t) { return a + (b - a) * t; }

function drawIcon(size) {
  const c = new Canvas(size, size);
  const s = size;
  const R = s * 0.23;

  // Nền: gradient chéo indigo -> violet
  c.fillShape(0, 0, s, s, (x, y) => {
    const t = Math.min(1, Math.max(0, (x / s) * 0.45 + (y / s) * 0.55));
    return [Math.round(lerp(A[0], B[0], t)), Math.round(lerp(A[1], B[1], t)), Math.round(lerp(A[2], B[2], t)), 255];
  }, roundRect(0, 0, s, s, R));

  // Vệt sáng chéo
  c.fillShape(0, 0, s, s, () => [255, 255, 255, 26],
    (x, y) => y < s * 0.5 && x + y < s * 0.95 && roundRect(0, 0, s, s, R)(x, y));

  // Thân clipboard
  const bx0 = s * 0.24, bx1 = s * 0.76, by0 = s * 0.20, by1 = s * 0.84;
  c.fillShape(bx0, by0, bx1, by1, () => [255, 255, 255, 242], roundRect(bx0, by0, bx1, by1, s * 0.085));

  // Kẹp trên
  const kx0 = s * 0.38, kx1 = s * 0.62, ky0 = s * 0.135, ky1 = s * 0.255;
  c.fillShape(kx0, ky0, kx1, ky1, () => [INK[0], INK[1], INK[2], 235],
    roundRect(kx0, ky0, kx1, ky1, s * 0.045));

  // Ba dòng nội dung
  const rows = [
    [0.36, 0.52, 0.66],
    [0.36, 0.62, 0.50],
    [0.36, 0.72, 0.60],
  ];
  for (let i = 0; i < rows.length; i++) {
    const [ry, rx1, col] = rows[i];
    const y0 = s * ry, y1 = y0 + s * 0.052;
    const x0 = s * 0.33, x1 = s * rx1;
    c.fillShape(x0, y0, x1, y1, () => {
      if (i === 2) return [ACCENT[0], ACCENT[1], ACCENT[2], 245];
      return [INK[0] + 40, INK[1] + 46, INK[2] + 90, 220];
    }, roundRect(x0, y0, x1, y1, s * 0.026));
  }
  return c;
}

function main() {
  const root = path.join(__dirname, '..');
  const assets = path.join(root, 'assets');
  fs.mkdirSync(assets, { recursive: true });

  const big = path.join(assets, 'icon.png');
  fs.writeFileSync(big, encode(drawIcon(256)));
  console.log('[icon]', big, fs.statSync(big).size, 'bytes');

  const tray = path.join(assets, 'tray.png');
  fs.writeFileSync(tray, encode(drawIcon(32)));
  console.log('[icon]', tray, fs.statSync(tray).size, 'bytes');

  // Ảnh mẫu cho kiểm thử clipboard ảnh
  const sample = path.join(root, 'tools', 'sample.png');
  const c = new Canvas(240, 120);
  c.fillShape(0, 0, 240, 120, (x, y) => {
    const t = x / 240;
    return [Math.round(lerp(30, 220, t)), Math.round(lerp(120, 60, t)), 200, 255];
  }, roundRect(0, 0, 240, 120, 12));
  c.fillShape(30, 30, 210, 90, () => [255, 255, 255, 235], roundRect(30, 30, 210, 90, 10));
  fs.writeFileSync(sample, encode(c));
  console.log('[icon]', sample, fs.statSync(sample).size, 'bytes');
}

if (require.main === module) main();
module.exports = { drawIcon };

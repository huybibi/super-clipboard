'use strict';
/**
 * png-decode.js — Bộ giải mã PNG tối giản (RGBA / RGB, 8-bit) để kiểm chứng ảnh chụp.
 * Chỉ dùng cho việc nghiệm thu, không tham gia vào ứng dụng.
 */

const zlib = require('zlib');
const fs = require('fs');

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** @returns {{width:number,height:number,channels:number,data:Buffer}} */
function decode(fileOrBuffer) {
  const buf = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Không phải tệp PNG');

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('Chỉ hỗ trợ 8-bit, nhận được ' + bitDepth);
  if (interlace) throw new Error('Không hỗ trợ ảnh interlace');

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

function rgbaAt(img, x, y) {
  const i = (y * img.width + x) * img.channels;
  if (img.channels === 4) return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  if (img.channels === 3) return [img.data[i], img.data[i + 1], img.data[i + 2], 255];
  return [img.data[i], img.data[i], img.data[i], 255];
}

/** Thống kê cơ bản để biết ảnh có "trống/đen thui" hay không. */
function analyze(file) {
  const img = decode(file);
  const buckets = new Map();
  let sum = 0, n = 0, transparent = 0;
  const step = Math.max(1, Math.floor(Math.min(img.width, img.height) / 400));
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const [r, g, b, a] = rgbaAt(img, x, y);
      if (a < 8) { transparent++; continue; }
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum; n++;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
  }
  const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  return {
    width: img.width,
    height: img.height,
    sampled: n + transparent,
    transparentPct: +(transparent / (n + transparent) * 100).toFixed(1),
    avgLuma: n ? +(sum / n).toFixed(1) : 0,
    distinctColors: buckets.size,
    dominantPct: top.length ? +(top[0][1] / Math.max(1, n) * 100).toFixed(1) : 0,
    topColors: top.slice(0, 5).map(([k, c]) => ({
      rgb: `#${(((k >> 8) & 15) * 17).toString(16).padStart(2, '0')}${(((k >> 4) & 15) * 17).toString(16).padStart(2, '0')}${((k & 15) * 17).toString(16).padStart(2, '0')}`,
      pct: +(c / Math.max(1, n) * 100).toFixed(1),
    })),
  };
}

module.exports = { decode, analyze, rgbaAt };

if (require.main === module) {
  for (const f of process.argv.slice(2)) {
    try { console.log(f, JSON.stringify(analyze(f))); }
    catch (e) { console.log(f, 'LỖI: ' + e.message); }
  }
}

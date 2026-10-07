'use strict';
/**
 * png.js — Bộ mã hoá PNG tối giản (không phụ thuộc thư viện ngoài).
 * Dùng để sinh icon ứng dụng và ảnh mẫu cho kiểm thử.
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** Canvas RGBA đơn giản để vẽ icon. */
class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.data = Buffer.alloc(w * h * 4, 0);
  }
  px(x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const sa = a / 255;
    const dr = this.data[i], dg = this.data[i + 1], db = this.data[i + 2], da = this.data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) { this.data[i + 3] = 0; return; }
    this.data[i] = Math.round((r * sa + dr * da * (1 - sa)) / oa);
    this.data[i + 1] = Math.round((g * sa + dg * da * (1 - sa)) / oa);
    this.data[i + 2] = Math.round((b * sa + db * da * (1 - sa)) / oa);
    this.data[i + 3] = Math.round(oa * 255);
  }
  /** Khử răng cưa 3x3 cho hình tròn / bo góc. */
  fillShape(x0, y0, x1, y1, colorAt, inside, ss = 3) {
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
        let hits = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
            if (inside(px, py)) hits++;
          }
        }
        if (!hits) continue;
        const c = colorAt(x, y);
        const a = c[3] * (hits / (ss * ss));
        this.px(x, y, c[0], c[1], c[2], a);
      }
    }
  }
}

function roundRect(x0, y0, x1, y1, r) {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r + 0.0001;
  };
}

function circle(cx, cy, r) {
  return (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r + 0.0001;
}

/** Mã hoá canvas thành Buffer PNG (RGBA, 8-bit). */
function encode(canvas) {
  const { w, h, data } = canvas;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { Canvas, encode, roundRect, circle };

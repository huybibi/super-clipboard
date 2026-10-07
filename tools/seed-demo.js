'use strict';
/**
 * seed-demo.js — Tạo dữ liệu mẫu đúng theo câu chuyện sử dụng:
 * nhiều API key copy từ các trang web, ghim, ghi chú, dán vào nhiều ứng dụng.
 *
 *   node tools/seed-demo.js "C:\đường\dẫn\thư-mục-dữ-liệu"
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Store } = require('../server/store.js');
const F = require('./fake.js');

const dataDir = process.argv[2] || path.join(os.tmpdir(), 'SuperClipboard', 'demo');
fs.mkdirSync(dataDir, { recursive: true });

const store = new Store(dataDir).init();
const H = 3600000;
const now = Date.now();

const SIGN = {
  stripe1: F.stripe,
  stripe2: F.stripe2,
  anthropic: F.anthropic,
};

const sample = path.join(__dirname, 'sample.png');
const tmpImg = path.join(dataDir, 'demo-sample.png');
fs.copyFileSync(sample, tmpImg);

const seed = [
  {
    ev: {
      kind: 'text', text: SIGN.stripe1, ts: now - 26 * H, seq: 1001,
      sourceUrl: 'https://dashboard.stripe.com/apikeys?utm_source=nav',
      srcProc: 'chrome', srcTitle: 'API keys – Stripe',
      html: `<code style="font-family:monospace">${SIGN.stripe1}</code>`,
    },
    pin: true, note: 'Khoá chính cho App B — hết hạn 31/12/2026.', coll: ['Key cho App B'],
    pastes: [{ proc: 'Notepad', title: 'ghi-chu.txt - Notepad', n: 1, ago: 25 * H },
             { proc: 'Postman', title: 'Postman — New Request', n: 2, ago: 20 * H }],
  },
  {
    ev: {
      kind: 'text', text: SIGN.stripe2, ts: now - 5 * H, seq: 1002,
      sourceUrl: 'https://dashboard.stripe.com/apikeys',
      srcProc: 'chrome', srcTitle: 'API keys – Stripe',
    },
    coll: ['Key cho App B'],
    pastes: [{ proc: 'Code', title: 'server.js - super-clipboard - Visual Studio Code', n: 1, ago: 4 * H }],
  },
  {
    ev: {
      kind: 'text', text: SIGN.anthropic, ts: now - 3 * H, seq: 1003,
      sourceUrl: 'https://console.anthropic.com/settings/keys',
      srcProc: 'msedge', srcTitle: 'API Keys – Anthropic Console',
    },
    coll: ['Key cho App B'],
  },
  {
    ev: {
      kind: 'text', text: F.github, ts: now - 30 * H, seq: 1004,
      sourceUrl: 'https://github.com/settings/tokens',
      srcProc: 'chrome', srcTitle: 'Personal access tokens (classic)',
    },
    pastes: [{ proc: 'WindowsTerminal', title: 'PowerShell — git push', n: 1, ago: 29 * H }],
  },
  {
    ev: {
      kind: 'text', text: 'postgres://admin:S3cr3tP4ss@db.prod.example.com:5432/khachhang', ts: now - 9 * H, seq: 1005,
      sourceUrl: 'https://console.neon.tech/app/projects/prod-branch',
      srcProc: 'chrome', srcTitle: 'Neon Console — Connection string',
    },
    pin: true, coll: ['Hạ tầng'], note: 'Chuỗi kết nối CSDL production. Không chia sẻ ra ngoài.',
  },
  {
    ev: {
      kind: 'text', ts: now - 2 * H, seq: 1006, srcProc: 'chrome', srcTitle: 'Hộp thư đến - Gmail',
      text: 'Báo cáo tuần 42: doanh thu tăng 18% so với tuần trước, tỷ lệ huỷ giảm còn 1,9%.\n' +
            'Cần gửi cho chị Lan trước 17h thứ Sáu, kèm bảng chi tiết theo kênh bán.',
    },
    coll: ['Khách hàng'],
  },
  {
    ev: {
      kind: 'text', ts: now - 40 * H, seq: 1007,
      sourceUrl: 'https://stackoverflow.com/questions/46155/how-can-i-validate-a-url',
      srcProc: 'chrome', srcTitle: 'How can I validate a URL in TypeScript? - Stack Overflow',
      text: 'export function isValidUrl(value: string): boolean {\n' +
            '  try {\n    new URL(value);\n    return true;\n  } catch {\n    return false;\n  }\n}',
    },
    pastes: [{ proc: 'Code', title: 'utils.ts - Visual Studio Code', n: 1, ago: 39 * H }],
  },
  {
    ev: { kind: 'image', imageFile: tmpImg, width: 240, height: 120, ts: now - 7 * H, seq: 1008,
          srcProc: 'chrome', srcTitle: 'Ảnh chụp bảng doanh thu' },
  },
  {
    ev: {
      kind: 'text', text: 'https://platform.openai.com/api-keys', ts: now - 11 * H, seq: 1009,
      sourceUrl: 'https://platform.openai.com/docs/overview', srcProc: 'chrome',
      srcTitle: 'API keys – OpenAI Platform',
    },
    note: 'Trang tạo key OpenAI — mở đây khi cần tạo key mới.',
  },
  {
    ev: {
      kind: 'text', ts: now - 15 * H, seq: 1010,
      sourceUrl: 'https://vercel.com/docs/projects/environment-variables',
      srcProc: 'chrome', srcTitle: 'Environment Variables – Vercel Docs',
      text: 'OPENAI_API_KEY=' + F.openai + '\n' +
            'DB_PASSWORD=hunter2xyz\n' +
            'STRIPE_WEBHOOK_SECRET=' + F.webhook,
    },
    coll: ['Hạ tầng'],
  },
  {
    ev: {
      kind: 'text', ts: now - 52 * H, seq: 1011, srcProc: 'Code',
      srcTitle: 'settings.json - Visual Studio Code',
      text: '{\n  "editor.fontSize": 14,\n  "editor.formatOnSave": true,\n  "files.autoSave": "onFocusChange"\n}',
    },
  },
];

const colls = new Map();
function collId(name) {
  if (!colls.has(name)) {
    const colors = { 'Key cho App B': '#6366f1', 'Hạ tầng': '#22d3ee', 'Khách hàng': '#f59e0b' };
    colls.set(name, store.createCollection(name, colors[name] || '#8b5cf6').id);
  }
  return colls.get(name);
}

let n = 0;
const ids = [];
for (const s of seed) {
  const r = store.ingest(s.ev, { proc: s.ev.srcProc, title: s.ev.srcTitle });
  if (!r) continue;
  ids.push(r.item.id);
  const patch = {};
  if (s.pin) patch.pinned = true;
  if (s.note) patch.note = s.note;
  if (s.coll) patch.collections = s.coll.map(collId);
  if (Object.keys(patch).length) store.update(r.item.id, patch);
  for (const p of (s.pastes || [])) {
    for (let k = 0; k < (p.n || 1); k++) {
      store.recordPaste({ id: r.item.id, proc: p.proc, title: p.title, ts: now - (p.ago || 0) + k * 60000 });
    }
  }
  // Thêm vài lần copy lại để lịch sử trông tự nhiên
  if (n % 3 === 0 && s.ev.kind === 'text') {
    store.ingest({ ...s.ev, ts: (s.ev.ts || now) + 20 * 60000, seq: (s.ev.seq || 0) + 500, srcProc: 'chrome' },
      { proc: 'chrome', title: s.ev.srcTitle });
  }
  n++;
}

console.log(`[seed] ${store.items.size} mục, ${store.collections.length} bộ sưu tập -> ${dataDir}`);
console.log(`[seed] ${store.all().filter(i => i.secrets && i.secrets.length).length} bí mật được phát hiện`);

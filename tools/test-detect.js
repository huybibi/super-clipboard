'use strict';
// Kiểm thử bộ phát hiện bí mật và phân loại nội dung.
const d = require('../server/detect.js');
const F = require('./fake.js');

const cases = [
  ['Stripe secret', F.stripeShort],
  ['OpenAI', F.openai],
  ['Anthropic', F.anthropicFull],
  ['AWS AKID', F.aws],
  ['GitHub PAT', F.github],
  ['JWT', F.jwt],
  ['Postgres URL', F.postgres],
  ['ENV block', F.envBlock],
  ['PEM', F.pem],
  ['Telegram', F.telegram],
  ['Slack', F.slack],
  ['Google API', F.google],
];

let pass = 0, fail = 0;
console.log('=== PHAT HIEN BI MAT ===');
for (const [name, text] of cases) {
  const found = d.findSecrets(text);
  const ok = found.length > 0;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'OK  ' : 'MISS'} ${name.padEnd(16)} -> ` +
    (found.map(f => `${f.id}[${f.severity}] ${f.masked}`).join(' | ') || 'KHONG TIM THAY'));
}

console.log('\n=== AM TINH GIA (khong duoc bao sai) ===');
const negatives = [
  ['cau van thuong', 'Hom nay troi dep, toi di uong ca phe voi ban.'],
  ['so dien thoai', '0912345678'],
  ['url thuong', 'https://example.com/blog/bai-viet-moi'],
  ['ma mau', '#ff9900 va rgb(1,2,3)'],
  ['email', 'nguyenvana@gmail.com'],
];
for (const [name, text] of negatives) {
  const found = d.findSecrets(text);
  const ok = found.length === 0;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'OK  ' : 'FALSE+'} ${name.padEnd(16)} -> ` +
    (found.map(f => f.id).join(', ') || 'sach'));
}

console.log('\n=== PHAN LOAI ===');
const samples = [
  ['url', 'https://dashboard.stripe.com/apikeys'],
  ['json', '{"name":"test","value":123}'],
  ['code-ts', 'const x: string = "hello";\nexport function foo() { return x; }'],
  ['code-py', 'def hello(name):\n    return f"hi {name}"'],
  ['env', 'API_KEY=abc\nSECRET=xyz\nDEBUG=true'],
  ['markdown', '# Tieu de\n- muc 1\n- muc 2'],
];
for (const [name, text] of samples) {
  const r = d.classify({ kind: 'text', text });
  console.log(`${name.padEnd(10)} -> tags=[${r.tags.join(', ')}] secrets=${r.secrets.length}`);
}

console.log('\n=== CHE GIA TRI ===');
console.log(F.stripeShort + ' ->', d.mask(F.stripeShort));
console.log('short ->', d.mask('abc123'));

console.log(`\n===== KET QUA: ${pass} PASS, ${fail} FAIL =====`);
process.exit(fail > 0 ? 1 : 0);

'use strict';
/**
 * detect.js — Phát hiện API key, token, bí mật và phân loại nội dung.
 *
 * Đây là phần trả lời trực tiếp cho câu hỏi của người dùng:
 * "Tôi copy một API key A1 từ website X" -> ứng dụng phải TỰ NHẬN RA đó là key,
 * thuộc dịch vụ nào, và che đi khi hiển thị.
 */

// Mức độ nguy hiểm: critical = lộ là mất tiền / mất quyền truy cập
const RULES = [
  { id: 'private_key', label: 'Private Key (PEM)', severity: 'critical', color: '#ef4444',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]{0,4000}?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },

  { id: 'openai', label: 'OpenAI API Key', severity: 'critical', color: '#10b981',
    re: /\bsk-(?:proj|svcacct|admin|None)?-?[A-Za-z0-9_-]{32,}\b/g, exclude: /^sk-ant-|^sk-or-|^sk_live|^sk_test/ },

  { id: 'anthropic', label: 'Anthropic API Key', severity: 'critical', color: '#d97757',
    re: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/g },

  { id: 'openrouter', label: 'OpenRouter API Key', severity: 'critical', color: '#8b5cf6',
    re: /\bsk-or-v1-[0-9a-f]{48,}\b/g },

  { id: 'stripe_secret', label: 'Stripe Secret Key', severity: 'critical', color: '#635bff',
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },

  { id: 'stripe_pub', label: 'Stripe Publishable Key', severity: 'low', color: '#635bff',
    re: /\bpk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },

  { id: 'aws_akid', label: 'AWS Access Key ID', severity: 'critical', color: '#ff9900',
    re: /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g },

  { id: 'aws_secret', label: 'AWS Secret Access Key', severity: 'critical', color: '#ff9900',
    re: /(?:aws)?[_ -]?(?:secret)?[_ -]?access[_ -]?key["'\s:=]{1,8}([A-Za-z0-9/+=]{40})/gi },

  { id: 'github_pat', label: 'GitHub Token', severity: 'critical', color: '#c9d1d9',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },

  { id: 'gitlab', label: 'GitLab Token', severity: 'critical', color: '#fc6d26',
    re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },

  { id: 'google_api', label: 'Google API Key', severity: 'high', color: '#4285f4',
    re: /\bAIza[0-9A-Za-z_-]{32,40}\b/g },

  { id: 'google_oauth', label: 'Google OAuth Secret', severity: 'critical', color: '#4285f4',
    re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g },

  { id: 'slack', label: 'Slack Token', severity: 'critical', color: '#4a154b',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },

  { id: 'slack_webhook', label: 'Slack Webhook', severity: 'high', color: '#4a154b',
    re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{20,}/g },

  { id: 'jwt', label: 'JWT Token', severity: 'high', color: '#f59e0b',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },

  { id: 'bearer', label: 'Bearer Token', severity: 'high', color: '#f59e0b',
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },

  { id: 'db_url', label: 'Chuỗi kết nối CSDL', severity: 'critical', color: '#3b82f6',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|mssql|clickhouse):\/\/[^\s'"<>]{8,}/gi },

  { id: 'sendgrid', label: 'SendGrid API Key', severity: 'critical', color: '#1a82e2',
    re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },

  { id: 'twilio', label: 'Twilio API Key', severity: 'critical', color: '#f22f46',
    re: /\bSK[0-9a-fA-F]{32}\b/g },

  { id: 'discord_webhook', label: 'Discord Webhook', severity: 'high', color: '#5865f2',
    re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{50,}/g },

  { id: 'telegram_bot', label: 'Telegram Bot Token', severity: 'critical', color: '#29a9eb',
    re: /\b\d{8,10}:[A-Za-z0-9_-]{30,40}\b/g },

  { id: 'npm', label: 'npm Token', severity: 'critical', color: '#cb3837',
    re: /\bnpm_[A-Za-z0-9]{36}\b/g },

  { id: 'shopify', label: 'Shopify Token', severity: 'critical', color: '#96bf48',
    re: /\bshpat_[0-9a-fA-F]{32}\b|\bshpss_[0-9a-fA-F]{32}\b/g },

  { id: 'vault', label: 'HashiCorp Vault Token', severity: 'critical', color: '#ffcf25',
    re: /\bhvs\.[A-Za-z0-9_-]{20,}\b|\bs\.[A-Za-z0-9]{24}\b/g },

  { id: 'huggingface', label: 'Hugging Face Token', severity: 'critical', color: '#ffd21e',
    re: /\bhf_[A-Za-z0-9]{30,}\b/g },

  { id: 'cloudflare', label: 'Cloudflare API Token', severity: 'critical', color: '#f38020',
    re: /\b(?:CLOUDFLARE|CF)_(?:API_)?(?:TOKEN|KEY)["'\s:=]{1,6}[A-Za-z0-9_-]{30,}/gi },

  { id: 'supabase', label: 'Supabase Key', severity: 'high', color: '#3ecf8e',
    re: /\beyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },

  { id: 'env_secret', label: 'Biến môi trường bí mật', severity: 'high', color: '#a3e635',
    re: /^[ \t]*[A-Z][A-Z0-9_]{2,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_PWD|_CREDENTIAL|_APIKEY|API_KEY|SECRET_KEY|ACCESS_KEY)[ \t]*=[ \t]*\S{6,}[ \t]*$/gm },

  { id: 'kv_secret', label: 'Cặp khóa/giá trị bí mật', severity: 'high', color: '#a3e635',
    re: /(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key|passwd|password|passphrase)\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{16,})["']?/gi },
];

// Nhãn "bí mật" gộp: chỉ những rule này mới khiến item bị coi là nhạy cảm
const SECRET_IDS = new Set(RULES.filter(r => r.severity !== 'low').map(r => r.id));

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

const CODE_HINTS = [
  /^\s*(?:import|from|export|const|let|var|function|class|def|async|await|return|package|public|private|using|#include)\b/m,
  /=>|::|<\/?[a-z][\w-]*>|\{\s*"[\w-]+"\s*:|\bSELECT\b[\s\S]{0,200}\bFROM\b/i,
  /^\s*[\w.]+\s*\([^)]*\)\s*\{/m,
];

const LANG_HINTS = [
  // Markdown và Dockerfile phải đứng TRƯỚC Python, nếu không dấu '#' sẽ bị hiểu là chú thích Python
  [/^#{1,3}\s+\S|^\s*(?:[-*+]|\d+\.)\s+\S.*\n\s*(?:[-*+]|\d+\.)\s+\S/m, 'Markdown'],
  [/^\s*(?:FROM|RUN|COPY|CMD|ENTRYPOINT|WORKDIR|ADD|ENV)\s+\S/m, 'Dockerfile'],
  [/\b(?:interface|type)\s+\w+\s*(?:=|\{)|:\s*(?:string|number|boolean)\b|\bimplements\b/, 'TypeScript'],
  [/^\s*(?:import|from)\s+\w|^\s*def\s+\w+\s*\(|\bself\.|^\s*(?:class)\s+\w+.*:\s*$/m, 'Python'],
  [/^\s*(?:package|func)\s+\w|:=|fmt\./, 'Go'],
  [/^\s*(?:use|fn|let mut|impl|pub struct)\b/m, 'Rust'],
  [/\bpublic\s+(?:static\s+)?(?:void|class)\b|System\.out\.println/, 'Java'],
  [/\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,120}\b(?:FROM|INTO|SET|WHERE)\b/i, 'SQL'],
  [/^\s*[.#]?[\w-]+\s*\{[^}]*:[^;]+;/m, 'CSS'],
];

function normalizeText(s) {
  return String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Chuẩn hóa để băm: bỏ khác biệt vô nghĩa về khoảng trắng cuối dòng. */
function canonical(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\s+|\s+$/g, '');
}

/** Che bí mật khi hiển thị: giữ đầu/cuối để người dùng vẫn nhận ra key nào. */
function mask(secret) {
  const s = String(secret);
  if (s.length <= 10) return '•'.repeat(Math.max(6, s.length));
  const head = s.slice(0, Math.min(7, Math.floor(s.length * 0.25)));
  const tail = s.slice(-4);
  return head + '•'.repeat(Math.min(24, Math.max(6, s.length - head.length - tail.length))) + tail;
}

/** Tìm mọi bí mật trong một đoạn văn bản. */
function findSecrets(text) {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  const seen = new Set();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = rule.re.exec(text)) !== null && guard++ < 400) {
      const raw = m[1] && rule.id === 'aws_secret' ? m[1] : m[0];
      const value = String(raw).trim();
      if (value.length < 8) continue;
      if (rule.exclude && rule.exclude.test(value)) continue;
      const key = rule.id + '|' + value;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: rule.id,
        label: rule.label,
        severity: rule.severity,
        color: rule.color,
        value,
        masked: mask(value),
        start: m.index,
        end: m.index + m[0].length,
      });
      if (rule.re.lastIndex === m.index) rule.re.lastIndex++;
    }
  }
  // Bỏ các phát hiện nằm lồng trong phát hiện dài hơn (ví dụ JWT nằm trong Bearer)
  const filtered = out.filter((a, i) => !out.some((b, j) =>
    j !== i && b.start <= a.start && b.end >= a.end && (b.end - b.start) > (a.end - a.start)));
  // Cùng một giá trị bị nhiều quy tắc bắt (ví dụ JWT vs Supabase) -> giữ quy tắc ưu tiên cao hơn
  const byValue = new Map();
  for (const f of filtered) if (!byValue.has(f.value)) byValue.set(f.value, f);
  const uniq = [...byValue.values()];
  uniq.sort((a, b) => a.start - b.start);
  return uniq;
}

/** Phân loại nội dung: url / code / text / json / markdown ... */
function classify(item) {
  const tags = new Set();
  const text = item.text || '';
  const t = text.trim();

  if (item.kind === 'image') tags.add('image');
  if (item.kind === 'files') tags.add('files');

  const urls = (text.match(URL_RE) || []).map(u => u.replace(/[.,;:]+$/, ''));
  if (urls.length) tags.add('url');
  if (t && /^https?:\/\/\S+$/i.test(t)) tags.add('link-only');
  if (EMAIL_RE.test(t)) tags.add('email');
  if (IPV4_RE.test(t)) tags.add('ip');
  if (t.startsWith('{') || t.startsWith('[')) {
    try { JSON.parse(t); tags.add('json'); } catch { /* không phải JSON hợp lệ */ }
  }
  if (!tags.has('json') && CODE_HINTS.some(re => re.test(t))) tags.add('code');
  for (const [re, lang] of LANG_HINTS) {
    if (re.test(t)) { tags.add('code'); tags.add('lang:' + lang); break; }
  }
  const lines = t.split('\n');
  if (lines.length >= 2 && lines.filter(l => /[:=]/.test(l)).length >= lines.length * 0.6) tags.add('config');
  if (text.length > 40 || lines.length > 1) tags.add('multiline');

  const secrets = findSecrets(text);
  if (secrets.length) {
    tags.add('secret');
    for (const s of secrets) tags.add('secret:' + s.id);
  }
  return { tags: [...tags], secrets, urls };
}

/** Điểm "đáng chú ý" để xếp hạng và làm nổi bật trong UI. */
function importance(item) {
  let score = 0;
  if (item.pinned) score += 100;
  if (item.secrets && item.secrets.length) score += 40;
  if (item.tags && item.tags.includes('url')) score += 6;
  if (item.tags && item.tags.includes('code')) score += 5;
  score += Math.min(20, (item.copyCount || 1) * 2);
  score += Math.min(20, (item.pastes ? item.pastes.length : 0) * 5);
  return score;
}

/** Tên "họ" của bí mật: dùng để nhóm A1, A2, A3 của cùng một dịch vụ. */
function secretFamily(secret, sourceDomain) {
  return (secret ? secret.id : 'unknown') + '@' + (sourceDomain || 'không rõ nguồn');
}

function domainOf(url) {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function titleOfUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    return u.hostname.replace(/^www\./, '') + (seg.length ? ' › ' + seg.slice(0, 3).join(' › ') : '');
  } catch { return url; }
}

module.exports = {
  RULES, SECRET_IDS, normalizeText, canonical, mask,
  findSecrets, classify, importance, secretFamily, domainOf, titleOfUrl,
};

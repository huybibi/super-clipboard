'use strict';
/**
 * Khoá GIẢ dùng cho kiểm thử và dữ liệu mẫu.
 *
 * Vì sao phải ghép từ nhiều mảnh: những mẫu như "sk_live_…" hay "xoxb-…" bị
 * GitHub secret scanning nhận nhầm là khoá thật và chặn push. Ghép lúc chạy
 * thì tệp nguồn không còn chuỗi nào trùng mẫu khoá, mà giá trị kiểm thử vẫn
 * y nguyên — bộ phát hiện vẫn được thử đúng như trước.
 *
 * TUYỆT ĐỐI không đặt khoá thật vào đây.
 */

const fake = (...parts) => parts.join('');

module.exports = {
  fake,

  stripe: fake('sk_live_', '51H8xQ2ABCdefGHIjklMNOpqrSTUV'),
  stripe2: fake('sk_live_', '51H8xQ2ZZZdefghijklmnopqrstuv'),
  stripeShort: fake('sk_live_', '51H8xQ2ABCdefGHIjklMNOpqr'),

  anthropic: fake('sk-ant-api03-', 'ZZZsecretVALUE0123456789abcdef'),
  anthropicFull: fake('sk-ant-api03-', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'),
  openai: fake('sk-proj-', '9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghij'),

  github: fake('ghp_', '1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R'),
  aws: fake('AKIA', 'IOSFODNN7EXAMPLE'),
  slack: fake('xoxb-', '123456789012-0987654321098-AbCdEfGhIjKlMnOpQrStUvWx'),
  google: fake('AIza', 'SyD-9a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P'),
  telegram: fake('7712345678', ':AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'),
  pem: [
    ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
    'MIIEowIBAAKCAQEA',
    ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
  ].join('\n'),
  webhook: fake('whsec_', '9f8e7d6c5b4a3210'),

  jwt: fake('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.',
            'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
  postgres: 'postgres://admin:S3cr3t@db.example.com:5432/prod',
  envBlock: [fake('OPENAI_API_KEY=sk-', 'abcdef1234567890abcdef'), 'DB_PASSWORD=hunter2xyz'].join('\n'),
};

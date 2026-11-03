// 個資（身分證字號／居留證號）驗證與加密儲存
// - 加密：AES-256-GCM，每筆隨機 12 bytes IV；格式 "v1:" + base64(iv | tag | ciphertext)
// - 金鑰：環境變數 PII_KEY（64 位 hex、base64 32 bytes，或任意字串→SHA-256）；
//   未設定時自動產生並存到 DATA_DIR/pii.key（權限 600）。遺失金鑰將無法解密，請一併備份。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
let KEY = null, KEY_SOURCE = '';
function loadKey() {
  if (KEY) return KEY;
  const env = String(process.env.PII_KEY || '').trim();
  if (env) {
    if (/^[0-9a-f]{64}$/i.test(env)) KEY = Buffer.from(env, 'hex');
    else { const b = Buffer.from(env, 'base64'); KEY = b.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(env) ? b : crypto.createHash('sha256').update(env).digest(); }
    KEY_SOURCE = 'env';
    return KEY;
  }
  const file = path.join(DATA_DIR, 'pii.key');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) { KEY = Buffer.from(hex, 'hex'); KEY_SOURCE = 'file'; return KEY; }
    throw new Error(`${file} 內容格式錯誤（應為 64 位 hex）`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const k = crypto.randomBytes(32);
  fs.writeFileSync(file, k.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  KEY = k; KEY_SOURCE = 'generated';
  return KEY;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(blob) {
  if (!blob) return null;
  const s = String(blob);
  if (!s.startsWith('v1:')) throw new Error('未知的加密格式');
  const raw = Buffer.from(s.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
// 解密失敗（例如金鑰被更換）時回傳 null，不讓整個頁面壞掉
function tryDecrypt(blob) { try { return decrypt(blob); } catch { return null; } }

// 字母對應數字（內政部身分證字號編碼規則；I、O、W 等不依字母順序）
const LETTER = { A: 10, B: 11, C: 12, D: 13, E: 14, F: 15, G: 16, H: 17, I: 34, J: 18, K: 19, L: 20, M: 21, N: 22, O: 35, P: 23, Q: 24, R: 25, S: 26, T: 27, U: 28, V: 29, W: 32, X: 30, Y: 31, Z: 33 };
const WEIGHTS = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
function checksumOk(id) {
  const n = LETTER[id[0]];
  if (!n) return false;
  const digits = [Math.floor(n / 10), n % 10, ...id.slice(1).split('').map(Number)];
  return digits.reduce((s, d, i) => s + d * WEIGHTS[i], 0) % 10 === 0;
}
// 驗證並正規化（去空白、轉大寫）
// - 國民身分證：1 英文字母＋9 數字，第 2 碼為 1（男）或 2（女），檢查碼正確
// - 新式外來人口統一證號（居留證，2021 起）：1 英文字母＋9 數字，第 2 碼為 8（男）或 9（女），檢查碼規則與身分證相同
function validateNationalId(input) {
  const v = String(input ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (!v) return { ok: false, error: '請輸入身分證字號' };
  if (!/^[A-Z]\d{9}$/.test(v)) return { ok: false, error: '身分證字號格式錯誤：應為 1 個英文字母加 9 個數字（例如 A123456789）' };
  if (!/^[A-Z][1289]/.test(v)) return { ok: false, error: '身分證字號第 2 碼應為 1 或 2（新式居留證為 8 或 9）' };
  if (!checksumOk(v)) return { ok: false, error: '身分證字號檢查碼不正確，請確認是否輸入錯誤' };
  return { ok: true, value: v, kind: /^[A-Z][89]/.test(v) ? 'resident' : 'citizen' };
}
const maskId = (v) => (v ? `${v.slice(0, 3)}****${v.slice(-3)}` : '');
// 產生格式正確的假號碼（示範資料用）
function fakeId(letter, body8) {
  const head = letter + body8;
  for (let d = 0; d <= 9; d++) if (checksumOk(head + d)) return head + d;
  return null;
}

module.exports = { encrypt, decrypt, tryDecrypt, validateNationalId, maskId, fakeId, checksumOk, keySource: () => (loadKey(), KEY_SOURCE) };

// 身分證字號：格式／檢查碼驗證、AES-GCM 加密儲存、後台遮罩顯示、PDF 薪資單密碼＝身分證字號、未登錄時擋下寄送
// 執行：npm test（在暫存資料夾啟動獨立伺服器；SMTP 指向沒有服務的連接埠，不會寄出任何信件）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3950 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clockin-nid-'));
let srv, cookie = '';

async function call(method, url, body, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/pdf')) return { status: r.status, pdf: Buffer.from(await r.arrayBuffer()) };
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j) ? Object.assign(j, { status: r.status }) : { status: r.status, ...j };
}
const ok = async (method, url, body, headers) => { const r = await call(method, url, body, headers); assert.ok(r.status < 300, `${method} ${url} → ${r.status} ${r.error || ''}`); return r; };
const raw = () => require('better-sqlite3')(path.join(DATA_DIR, fs.readdirSync(DATA_DIR).find((f) => /\.db$/.test(f))), { readonly: true });

// 單元測試在子程序執行，確保 PII 模組使用暫存資料夾的金鑰
const PII_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clockin-pii-'));
process.env.DATA_DIR = PII_DIR; delete process.env.PII_KEY;
const PII = require('../pii');

const MONTH = '2026-09';
let A, NOID;
before(async () => {
  srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR, PORT: String(PORT), PII_KEY: '' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/api/public/info'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const r = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin1234' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  NOID = (await ok('POST', '/api/admin/employees', { name: '未登錄丁', pin: '6001', email: 'ding@mail.test.invalid' })).id;
  await ok('PUT', `/api/admin/payroll/employees/${NOID}`, { pay_type: 'monthly', pay_amount: 30000, pay_items: [] });
  await ok('POST', '/api/admin/punches', { employee_id: NOID, type: 'in', date: '2026-09-01', time: '09:00', reason: '測試' });
  await ok('POST', '/api/admin/punches', { employee_id: NOID, type: 'out', date: '2026-09-01', time: '18:00', reason: '測試' });
  A = (await ok('GET', '/api/admin/employees')).find((e) => e.name === '示範員工A').id;
  await ok('POST', '/api/admin/punches', { employee_id: A, type: 'in', date: '2026-09-02', time: '09:00', reason: '測試' });
  await ok('POST', '/api/admin/punches', { employee_id: A, type: 'out', date: '2026-09-02', time: '18:00', reason: '測試' });
});
after(() => { srv && srv.kill(); for (const d of [DATA_DIR, PII_DIR]) fs.rmSync(d, { recursive: true, force: true }); });

test('驗證：格式、第 2 碼、檢查碼；新式居留證；自動轉大寫', () => {
  for (const v of ['A123456789', 'B223456782', 'E180000009', 'F131104093']) assert.equal(PII.validateNationalId(v).ok, true, v);
  assert.equal(PII.validateNationalId('a123456789').value, 'A123456789');
  assert.equal(PII.validateNationalId(' A1234-56789 ').value, 'A123456789');
  const res = PII.validateNationalId('A800000014'); assert.equal(res.ok, true); assert.equal(res.kind, 'resident');
  assert.equal(PII.validateNationalId('A900000016').ok, true);
  assert.match(PII.validateNationalId('A123456788').error, /檢查碼/);
  assert.match(PII.validateNationalId('A323456789').error, /第 2 碼/);
  assert.match(PII.validateNationalId('A12345678').error, /格式/);
  assert.match(PII.validateNationalId('AB12345678').error, /格式/); // 舊式居留證（2 個英文字母）不接受
  assert.match(PII.validateNationalId('').error, /請輸入/);
  assert.equal(PII.maskId('A123456789'), 'A12****789');
});

test('AES-GCM：每次 IV 不同、可解密、竄改會失敗；金鑰自動產生於 DATA_DIR（權限 600）', () => {
  const a = PII.encrypt('A123456789'), b = PII.encrypt('A123456789');
  assert.notEqual(a, b); assert.match(a, /^v1:/); assert.ok(!a.includes('A123456789'));
  assert.equal(PII.decrypt(a), 'A123456789');
  const buf = Buffer.from(a.slice(3), 'base64'); buf[buf.length - 1] ^= 1;
  assert.throws(() => PII.decrypt('v1:' + buf.toString('base64')));
  assert.equal(PII.tryDecrypt('v1:' + buf.toString('base64')), null);
  const st = fs.statSync(path.join(PII_DIR, 'pii.key'));
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(PII.keySource(), 'generated');
});

test('PII_KEY 環境變數：使用指定金鑰，不產生金鑰檔', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockin-pk-'));
  const code = "const P=require('./pii');const c=P.encrypt('A123456789');console.log(JSON.stringify({src:P.keySource(),back:P.decrypt(c)}))";
  const out = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir, PII_KEY: 'ab'.repeat(32) }, encoding: 'utf8' });
  const j = JSON.parse(out.stdout);
  assert.equal(j.src, 'env'); assert.equal(j.back, 'A123456789');
  assert.equal(fs.existsSync(path.join(dir, 'pii.key')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('示範員工有假身分證字號；API 只回傳遮罩，資料庫內為密文', async () => {
  const list = await ok('GET', '/api/admin/employees');
  const json = JSON.stringify(list);
  const a = list.find((e) => e.name === '示範員工A');
  assert.equal(a.has_national_id, true); assert.equal(a.national_id_masked, 'A12****789');
  assert.equal(list.find((e) => e.name === '示範員工B').national_id_masked, 'B22****782');
  assert.equal(list.find((e) => e.name === '示範員工C').national_id_masked, 'E18****009');
  for (const plain of ['A123456789', 'B223456782', 'E180000009']) assert.ok(!json.includes(plain), '回應不可含明碼');
  assert.ok(!json.includes('national_id_enc'));
  assert.equal(list.find((e) => e.id === NOID).has_national_id, false);
  const db = raw();
  const rows = db.prepare('SELECT national_id_enc v FROM employees WHERE is_sample=1').all();
  db.close();
  assert.equal(rows.length, 3);
  for (const r of rows) { assert.match(r.v, /^v1:/); assert.ok(!/[A-Z]\d{9}/.test(r.v)); }
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'pii.key')));
});

test('新增／修改：格式錯誤擋下、重複擋下、留空不變更、可清除；稽核不含明碼', async () => {
  let r = await call('POST', '/api/admin/employees', { name: '格式錯', pin: '6002', national_id: 'A123456788' });
  assert.equal(r.status, 400); assert.match(r.error, /檢查碼/);
  r = await call('POST', '/api/admin/employees', { name: '重複', pin: '6003', national_id: 'a123456789' });
  assert.equal(r.status, 400); assert.match(r.error, /示範員工A/);
  const id = (await ok('POST', '/api/admin/employees', { name: '居留戊', pin: '6004', national_id: 'a800000014' })).id;
  const get = async () => (await ok('GET', '/api/admin/employees')).find((e) => e.id === id);
  assert.equal((await get()).national_id_masked, 'A80****014');
  await ok('PUT', `/api/admin/employees/${id}`, { name: '居留戊', pin: '6004', national_id: '' });
  assert.equal((await get()).national_id_masked, 'A80****014', '留空不變更');
  await ok('PUT', `/api/admin/employees/${id}`, { name: '居留戊', pin: '6004', national_id: 'F131104093' });
  assert.equal((await get()).national_id_masked, 'F13****093');
  await ok('PUT', `/api/admin/employees/${id}`, { name: '居留戊', pin: '6004', clear_national_id: '1' });
  assert.equal((await get()).has_national_id, false);
  const logs = JSON.stringify(await ok('GET', '/api/admin/audit?limit=50').catch(() => ({})));
  assert.ok(logs.includes('已更新身分證字號') && logs.includes('已清除身分證字號'), '稽核紀錄有記錄變更');
  for (const plain of ['A800000014', 'F131104093', 'A123456788']) assert.ok(!logs.includes(plain), '稽核紀錄不可含身分證字號');
});

test('PDF 密碼＝身分證字號（大寫）；未登錄者擋下，不退回 PIN', async () => {
  await ok('POST', `/api/admin/payroll/${MONTH}/confirm`);
  const s = await ok('GET', `/api/admin/payroll/${MONTH}/sends`);
  assert.equal(s.pdf_password_mode, 'id');
  const noid = s.recipients.find((r) => r.id === NOID);
  assert.equal(noid.state, 'no_id'); assert.equal(noid.no_national_id, true); assert.match(noid.note, /身分證字號/);
  assert.equal(s.recipients.find((r) => r.id === A).no_national_id, false);

  // 後台「加密版」下載：有登錄 → 加密；未登錄 → 409
  const pdf = await call('GET', `/api/admin/payroll/${MONTH}/payslip/${A}.pdf?protect=1`);
  assert.equal(pdf.status, 200); assert.ok(pdf.pdf.includes('/Encrypt'));
  const blocked = await call('GET', `/api/admin/payroll/${MONTH}/payslip/${NOID}.pdf?protect=1`);
  assert.equal(blocked.status, 409); assert.match(blocked.error, /尚未登錄身分證字號/);
  const plain = await call('GET', `/api/admin/payroll/${MONTH}/payslip/${NOID}.pdf`);
  assert.equal(plain.status, 200, '管理員留存版（不加密）仍可下載');

  if (spawnSync('pdfinfo', ['-v']).status !== null) {
    const f = path.join(DATA_DIR, 'a.pdf'); fs.writeFileSync(f, pdf.pdf);
    assert.equal(spawnSync('pdfinfo', ['-upw', 'A123456789', f]).status, 0, '身分證字號可開啟');
    assert.notEqual(spawnSync('pdfinfo', ['-upw', '1111', f]).status, 0, 'PIN 不能開啟');
    assert.notEqual(spawnSync('pdfinfo', ['-upw', 'a123456789', f]).status, 0, '小寫不能開啟（密碼為英文大寫）');
    assert.notEqual(spawnSync('pdfinfo', [f]).status, 0, '沒有密碼不能開啟');
  }

  // 員工自行下載
  const login = async (id, pin) => (await ok('POST', '/api/login', { employee_id: id, pin })).token;
  const tA = await login(A, '1111'), tN = await login(NOID, '6001');
  const list = await ok('GET', '/api/payslips', null, { authorization: `Bearer ${tA}` });
  assert.match(list.password_hint, /身分證字號（英文大寫）/);
  assert.equal((await call('GET', `/api/payslips/${MONTH}.pdf`, null, { authorization: `Bearer ${tA}` })).status, 200);
  const eb = await call('GET', `/api/payslips/${MONTH}.pdf`, null, { authorization: `Bearer ${tN}` });
  assert.equal(eb.status, 409); assert.match(eb.error, /身分證字號/);

  // 寄送：SMTP 指向沒有服務的連接埠；只寄給未登錄者 → 直接略過並記錄原因（不會連線、不會寄出）
  await ok('PUT', '/api/admin/smtp', { host: '127.0.0.1', port: 1, secure: false, user: '', from_addr: 'hr@mail.test.invalid', subject: '【{公司}】{月份} 薪資單', body: '{密碼說明}', pdf_password_mode: 'id' });
  const sent = await ok('POST', `/api/admin/payroll/${MONTH}/send`, { employee_ids: [NOID] });
  assert.equal(sent.sent, 0); assert.equal(sent.skipped, 1);
  assert.match(sent.results[0].error, /尚未登錄身分證字號/);
});

test('舊設定 pdf_password_mode=pin 啟動時自動改為身分證字號', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockin-mig-'));
  const code = "const {getSetting,setSetting}=require('./db');setSetting('pdf_password_mode','pin');";
  spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir, NO_SAMPLE: '1' } });
  const out = spawnSync(process.execPath, ['-e', "console.log(require('./db').getSetting('pdf_password_mode'))"], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir, NO_SAMPLE: '1' }, encoding: 'utf8' });
  assert.equal(out.stdout.trim(), 'id');
  fs.rmSync(dir, { recursive: true, force: true });
});

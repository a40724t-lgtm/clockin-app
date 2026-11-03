// 國定假日：行事曆資料、請假略過放假日、薪資加倍（勞基法第 37、39 條）
// 執行：npm test（會在暫存資料夾啟動一個獨立的伺服器，不影響正式資料）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3800 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clockin-hol-'));
let srv, cookie = '';

async function call(method, url, body, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}
const ok = async (method, url, body, headers) => { const r = await call(method, url, body, headers); assert.ok(r.status < 300, `${method} ${url} → ${r.status} ${r.error || ''}`); return r; };
async function punch(emp, date, tin, tout) {
  await ok('POST', '/api/admin/punches', { employee_id: emp, type: 'in', date, time: tin, reason: '測試' });
  await ok('POST', '/api/admin/punches', { employee_id: emp, type: 'out', date, time: tout, reason: '測試' });
}

let M, H, P; // 月薪、時薪（照給 8 小時）、時薪（無固定排班）
before(async () => {
  srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/public/info'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const r = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin1234' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  await ok('PUT', '/api/admin/settings', { company_name: '測試公司', work_start: '09:00', standard_hours: 8, late_grace_min: 5, lunch_enabled: true, lunch_start: '12:00', lunch_end: '13:00' });
  M = (await ok('POST', '/api/admin/employees', { name: '月薪甲', pin: '5001' })).id;
  H = (await ok('POST', '/api/admin/employees', { name: '時薪乙', pin: '5002' })).id;
  P = (await ok('POST', '/api/admin/employees', { name: '兼職丙', pin: '5003' })).id;
  await ok('PUT', `/api/admin/payroll/employees/${M}`, { pay_type: 'monthly', pay_amount: 36000, pay_items: [] });
  await ok('PUT', `/api/admin/payroll/employees/${H}`, { pay_type: 'hourly', pay_amount: 200, pay_items: [] });
  await ok('PUT', `/api/admin/payroll/employees/${P}`, { pay_type: 'hourly', pay_amount: 200, pay_items: [], holiday_hours: 0 });
  // 2026-10：10/9（五）國慶日補假、10/26（一）光復節補假
  await punch(M, '2026-10-09', '10:00', '19:00');  // 國定假日出勤 8 小時（10:00 到班不算遲到）
  await punch(M, '2026-10-26', '09:00', '21:00');  // 國定假日出勤 11 小時（超過 8 小時 3 小時）
  await punch(M, '2026-10-12', '09:00', '18:00');  // 一般工作日
  await punch(H, '2026-10-09', '09:00', '14:00');  // 國定假日出勤 4 小時；10/26 未出勤
  await punch(H, '2026-10-13', '09:00', '18:00');  // 一般工作日 8 小時
  await punch(P, '2026-10-26', '09:00', '18:00');  // 原無排班，國定假日出勤 8 小時
});
after(() => { srv && srv.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('2026、2027 年各 16 個勞基法國定假日，含 2025 年新增假日與補假', async () => {
  for (const y of [2026, 2027]) {
    const r = await ok('GET', `/api/admin/holidays?year=${y}`);
    assert.equal(r.summary.statutory, 16, `${y} 國定假日數`);
    const names = r.list.map((h) => h.name).join('、');
    for (const n of ['開國紀念日', '和平紀念日', '小年夜', '除夕', '春節', '兒童節', '清明節', '勞動節', '端午節', '中秋節', '教師節', '國慶日', '臺灣光復', '行憲紀念日']) assert.ok(names.includes(n), `${y} 缺 ${n}`);
  }
  const y26 = await ok('GET', '/api/admin/holidays?year=2026');
  const at = (d) => y26.list.find((h) => h.date === d);
  assert.equal(at('2026-05-01').name, '勞動節');
  assert.equal(at('2026-09-28').kind, 'statutory');
  assert.equal(at('2026-10-10').weekend, true);
  assert.equal(at('2026-10-10').paid_holiday, false);           // 週六國定假日 → 休息日，由補假放假
  assert.equal(at('2026-10-09').kind, 'makeup');
  assert.equal(at('2026-10-09').paid_holiday, true);
  assert.equal(y26.list.filter((h) => h.kind === 'gov_workday' && h.off).length, 0); // 補行上班不適用民間
});

test('月薪：國定假日出勤 8 小時內加給一日工資（月薪÷30），超過 8 小時依平日加班', async () => {
  const p = await ok('GET', '/api/admin/payroll?month=2026-10');
  const e = p.employees.find((x) => x.id === M);
  const line = e.earn.find((l) => l.label === '國定假日出勤加給');
  assert.equal(e.holiday.worked_days, 2);
  assert.equal(line.amount, 2400);                   // 2 天 × 36000/30
  assert.equal(e.ot.wd1, 2); assert.equal(e.ot.wd2, 1); // 10/26 第 9～10 小時 ×1.34、第 11 小時 ×1.67
  assert.equal(e.ot.pay, Math.round(2 * 150 * 1.34) + Math.round(1 * 150 * 1.67));
  assert.equal(e.late_count, 0);                     // 國定假日 10:00 到班不算遲到
  assert.equal(e.gross, 36000 + 2400 + e.ot.pay);
  assert.equal(e.earn.find((l) => l.label === '國定假日照給'), undefined); // 月薪已含國定假日工資
  const d9 = e.days.find((d) => d.date === '2026-10-09');
  assert.match(d9.holiday, /國慶日/); assert.equal(d9.holiday_extra, 1200);
});

test('時薪：出勤加發「時薪×出勤時數」；原約定工作日放假照給「時薪×約定時數」', async () => {
  const p = await ok('GET', '/api/admin/payroll?month=2026-10');
  const e = p.employees.find((x) => x.id === H);
  assert.equal(e.paid_hours, 12);                                                    // 4 + 8 小時
  assert.equal(e.earn.find((l) => l.label === '工時薪資').amount, 2400);
  assert.equal(e.earn.find((l) => l.label === '國定假日出勤加給').amount, 800);       // 4h × 200
  const off = e.earn.find((l) => l.label === '國定假日照給');
  assert.equal(off.amount, (8 - 4 + 8) * 200);                                       // 10/9 補足 4h、10/26 8h
  assert.equal(e.holiday.paid_off_days, 2);
  assert.equal(e.gross, 2400 + 800 + 2400);
});

test('時薪無固定排班（照給 0 小時）：未出勤不給，出勤仍加倍', async () => {
  const p = await ok('GET', '/api/admin/payroll?month=2026-10');
  const e = p.employees.find((x) => x.id === P);
  assert.equal(e.earn.find((l) => l.label === '工時薪資').amount, 1600);
  assert.equal(e.earn.find((l) => l.label === '國定假日出勤加給').amount, 1600);
  assert.equal(e.earn.find((l) => l.label === '國定假日照給'), undefined);
  assert.equal(e.gross, 3200);
  assert.ok(p.totals.holiday_pay >= 2400 + 800 + 2400 + 1600);
});

test('請假跨國定假日：放假日不計入請假時數', async () => {
  const lg = await ok('POST', '/api/login', { employee_id: M, pin: '5001' });
  const auth = { Authorization: `Bearer ${lg.token}` };
  const types = await ok('GET', '/api/leaves', null, auth);
  const tid = types.types[0].id;
  // 10/8（四）～10/12（一）：10/9 國慶日補假、10/10～11 週末 → 只算 10/8、10/12
  const r = await ok('POST', '/api/leaves/preview', { type_id: tid, mode: 'full', start_date: '2026-10-08', end_date: '2026-10-12' }, auth);
  assert.equal(r.hours, 16);
  assert.deepEqual(r.holidays_skipped.map((x) => x.date), ['2026-10-09']);
  const only = await call('POST', '/api/leaves', { type_id: tid, mode: 'full', start_date: '2026-10-09', end_date: '2026-10-09', reason: '測試' }, auth);
  assert.equal(only.status, 400); assert.match(only.error, /放假日/);
});

test('勞資協商調移、公司自訂假日、政府彈性放假與鎖定月份', async () => {
  // 調移 12/25（五）行憲紀念日 → 12/28（一）
  await ok('POST', '/api/admin/holidays/swap', { date: '2026-12-25', to_date: '2026-12-28', note: '全體同意' });
  let y = await ok('GET', '/api/admin/holidays?year=2026');
  const out = y.list.find((h) => h.date === '2026-12-25'), inn = y.list.find((h) => h.date === '2026-12-28');
  assert.equal(out.kind, 'swap_out'); assert.equal(out.off, false);
  assert.equal(inn.kind, 'swap_in'); assert.equal(inn.paid_holiday, true);
  assert.equal(y.summary.statutory, 16); // 調移不減少國定假日數
  assert.equal((await call('POST', '/api/admin/holidays/swap', { date: '2026-10-10', to_date: '2026-10-14' })).status, 400); // 週末國定假日請調移補假
  assert.equal((await call('POST', '/api/admin/holidays/swap', { date: '2026-09-28', to_date: '2026-10-03' })).status, 400); // 調到週六
  await ok('DELETE', `/api/admin/holidays/changes/${out.change_id}`);
  y = await ok('GET', '/api/admin/holidays?year=2026');
  assert.equal(y.list.find((h) => h.date === '2026-12-25').kind, 'statutory');
  // 公司自訂假日
  await ok('POST', '/api/admin/holidays/custom', { date: '2026-12-31', name: '年終盤點休假' });
  y = await ok('GET', '/api/admin/holidays?year=2026');
  const c = y.list.find((h) => h.date === '2026-12-31');
  assert.equal(c.kind, 'custom'); assert.equal(c.paid_holiday, false); assert.equal(c.off, true);
  assert.equal((await call('POST', '/api/admin/holidays/custom', { date: '2026-12-31', name: '重複' })).status, 400);
  assert.equal((await call('POST', '/api/admin/holidays/custom', { date: '2026-10-09', name: '已是補假' })).status, 400);
  await ok('DELETE', `/api/admin/holidays/changes/${c.change_id}`);
  assert.equal((await call('PUT', '/api/admin/holidays/bridge/2026-12-31', { adopt: true })).status, 400); // 非政府彈性放假日
  // 鎖定月份不可修改
  await ok('POST', '/api/admin/payroll/2026-10/confirm');
  assert.equal((await call('POST', '/api/admin/holidays/custom', { date: '2026-10-15', name: '鎖定測試' })).status, 409);
  assert.equal((await call('POST', '/api/admin/holidays/swap', { date: '2026-10-26', to_date: '2026-10-27' })).status, 409);
});

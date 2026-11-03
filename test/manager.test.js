// 主管角色：帳號管理、登入、權限（伺服器端每個 API 都要擋）、只能看自己團隊、審核者記錄
// 執行：npm test（暫存資料夾啟動獨立伺服器；示範員工 A、B＝門市部，C＝倉儲部）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4000 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clockin-mgr-'));
let srv, owner = '';

async function call(method, url, body, cookie = owner, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {}
  return Array.isArray(j) ? Object.assign(j, { status: r.status, text }) : { status: r.status, text, setCookie: r.headers.get('set-cookie'), ...j };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${r.error || ''}`); return r; };
const login = async (username, password) => { const r = await call('POST', '/api/admin/login', { username, password }, ''); return r.status === 200 ? r.setCookie.split(';')[0] : r; };
const empAuth = async (id, pin) => ({ Authorization: `Bearer ${(await ok('POST', '/api/login', { employee_id: id, pin }, '')).token}` });

let EMP, mStore, mWare, M1, M2, leaveA, leaveC, wfhC, leaveB;
before(async () => {
  srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, PORT: String(PORT), PII_KEY: '' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/api/public/info'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const r = await call('POST', '/api/admin/login', { password: 'admin1234' }, '');
  owner = r.setCookie.split(';')[0];
  EMP = Object.fromEntries((await ok('GET', '/api/admin/employees')).map((e) => [e.name.slice(-1), e]));
  // 員工送出申請
  const lv0 = await ok('GET', '/api/leaves', null, '', await empAuth(EMP.A.id, '1111'));
  const types = lv0.types;
  const personal = types.find((t) => t.name === '事假').id, wfh = lv0.work_types.find((t) => t.kind === 'wfh').id;
  const sub = async (e, pin, body) => (await ok('POST', '/api/leaves', { mode: 'full', reason: '測試', ...body }, '', await empAuth(e.id, pin))).id ?? null;
  await sub(EMP.A, '1111', { type_id: personal, start_date: '2026-12-02', end_date: '2026-12-02' });
  await sub(EMP.B, '2222', { type_id: personal, start_date: '2026-12-03', end_date: '2026-12-03' });
  await sub(EMP.C, '3333', { type_id: personal, start_date: '2026-12-04', end_date: '2026-12-04' });
  await sub(EMP.C, '3333', { type_id: wfh, start_date: '2026-12-08', end_date: '2026-12-08' });
  const all = (await ok('GET', '/api/admin/leaves?status=pending&from=2026-12-01&to=2026-12-31')).leaves;
  const find = (e, d) => all.find((l) => l.employee_id === e.id && l.start_date === d).id;
  leaveA = find(EMP.A, '2026-12-02'); leaveB = find(EMP.B, '2026-12-03'); leaveC = find(EMP.C, '2026-12-04'); wfhC = find(EMP.C, '2026-12-08');
});
after(() => { srv && srv.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('管理員建立主管：驗證、密碼雜湊、不回傳雜湊', async () => {
  assert.equal((await call('POST', '/api/admin/managers', { name: '陳店長', username: 'chen', password: 'short', departments: ['門市部'] })).status, 400);
  assert.equal((await call('POST', '/api/admin/managers', { name: '陳店長', username: 'chen', password: 'store-pass-1' })).status, 400, '沒有部門或員工');
  assert.equal((await call('POST', '/api/admin/managers', { name: '陳店長', username: 'a b', password: 'store-pass-1', departments: ['門市部'] })).status, 400);
  M1 = (await ok('POST', '/api/admin/managers', { name: '陳店長', username: 'chen', password: 'store-pass-1', departments: ['門市部'] })).manager;
  assert.deepEqual(M1.team.map((e) => e.name).sort(), ['示範員工A', '示範員工B']);
  assert.equal((await call('POST', '/api/admin/managers', { name: '另一位', username: 'CHEN', password: 'store-pass-1', departments: ['門市部'] })).status, 400, '帳號不分大小寫不可重複');
  M2 = (await ok('POST', '/api/admin/managers', { name: '林組長', username: 'lin', password: 'ware-pass-1', employee_ids: [EMP.C.id] })).manager;
  const list = await ok('GET', '/api/admin/managers');
  assert.ok(!list.text.includes('password_hash') && !list.text.includes('store-pass-1'));
  assert.deepEqual(list.departments, ['倉儲部', '門市部']);
  const Database = require('better-sqlite3'); const db = new Database(path.join(DATA_DIR, 'clockin.db'), { readonly: true });
  const h = db.prepare('SELECT password_hash FROM managers WHERE username=?').get('chen').password_hash; db.close();
  assert.match(h, /^[0-9a-f]{32}:[0-9a-f]{64}$/); assert.ok(!h.includes('store-pass-1'));
});

test('主管登入：錯誤密碼 401；帳號不分大小寫；/me 只有基本資料', async () => {
  assert.equal((await login('chen', 'wrong-pass')).status, 401);
  mStore = await login('Chen', 'store-pass-1'); assert.equal(typeof mStore, 'string');
  mWare = await login('lin', 'ware-pass-1');
  const me = await ok('GET', '/api/admin/me', null, mStore);
  assert.equal(me.role, 'manager'); assert.equal(me.manager.name, '陳店長'); assert.equal(me.team_size, 2);
  assert.equal(me.settings.admin_password, undefined); assert.equal(me.checks, undefined);
  assert.equal((await ok('GET', '/api/admin/me')).role, 'owner');
});

test('主管不能使用的 API 一律 403（薪資、身分證、寄信、設定、國定假日、員工管理、補登打卡、匯出、修改紀錄）', async () => {
  const denied = [
    ['GET', '/api/admin/overview'], ['GET', '/api/admin/my-ip'], ['PUT', '/api/admin/checks', {}], ['PUT', '/api/admin/settings', {}],
    ['GET', '/api/admin/payroll?month=2026-10'], ['GET', '/api/admin/payroll/settings'], ['PUT', `/api/admin/payroll/employees/${EMP.A.id}`, { pay_type: 'monthly', pay_amount: 1 }],
    ['POST', '/api/admin/payroll/2026-10/confirm'], ['GET', '/api/admin/payroll/2026-10/export'], ['GET', `/api/admin/payroll/2026-10/payslip/${EMP.A.id}.pdf`], ['GET', '/api/admin/payroll/2026-10/payslips.zip'],
    ['GET', '/api/admin/payroll/2026-10/sends'], ['POST', '/api/admin/payroll/2026-10/send', { employee_ids: [EMP.A.id] }],
    ['GET', '/api/admin/smtp'], ['PUT', '/api/admin/smtp', {}], ['POST', '/api/admin/smtp/test', { to: 'x@y.invalid' }],
    ['GET', '/api/admin/holidays?year=2026'], ['POST', '/api/admin/holidays/custom', { date: '2026-12-30', name: 'x' }], ['PUT', '/api/admin/holidays/bridge/2026-12-31', { adopt: true }], ['POST', '/api/admin/holidays/swap', {}], ['DELETE', '/api/admin/holidays/changes/1'],
    ['POST', '/api/admin/employees', { name: 'x', pin: '1234' }], ['PUT', `/api/admin/employees/${EMP.A.id}`, { name: 'x', pin: '1234' }], ['PUT', `/api/admin/employees/${EMP.A.id}/email`, { email: 'a@b.cc' }], ['DELETE', `/api/admin/employees/${EMP.C.id}`],
    ['POST', '/api/admin/punches', {}], ['PUT', '/api/admin/punches/1', {}], ['DELETE', '/api/admin/punches/1', {}], ['GET', '/api/admin/export?format=csv'],
    ['GET', '/api/admin/audit'], ['GET', '/api/admin/managers'], ['POST', '/api/admin/managers', {}], ['PUT', `/api/admin/managers/${M1.id}`, { name: 'x', username: 'chen', departments: ['倉儲部'] }], ['DELETE', `/api/admin/managers/${M2.id}`],
    ['GET', '/api/admin/leave-balances'], ['PUT', `/api/admin/leave-balances/${EMP.A.id}`, {}], ['POST', '/api/admin/leave-types', {}], ['PUT', '/api/admin/leave-types/1', {}], ['POST', `/api/admin/leaves/${leaveA}/revoke`, { comment: 'x' }],
  ];
  for (const [m, u, b] of denied) {
    const r = await call(m, u, b, mStore);
    assert.equal(r.status, 403, `${m} ${u} → ${r.status}`);
    assert.ok(!/A123456789|38,?000|password_hash|smtp_pass/.test(r.text), `${m} ${u} 回應不可含敏感資料`);
  }
  // 員工的 token 不能當主管用；未登入 401
  const ea = await empAuth(EMP.A.id, '1111');
  assert.equal((await call('GET', '/api/admin/leaves', null, '', ea)).status, 401);
  assert.equal((await call('GET', '/api/admin/leaves', null, '')).status, 401);
});

test('主管只看到自己團隊：員工清單（無 PIN／Email／身分證）、打卡紀錄、請假', async () => {
  const emps = await ok('GET', '/api/admin/employees', null, mStore);
  assert.deepEqual(emps.map((e) => e.name).sort(), ['示範員工A', '示範員工B']);
  for (const e of emps) assert.deepEqual(Object.keys(e).sort(), ['department', 'id', 'name']);
  const rec = await ok('GET', '/api/admin/records?from=2026-09-01&to=2026-11-30', null, mStore);
  const ids = new Set([...rec.daily, ...rec.punches, ...rec.blocked].map((x) => x.employee_id));
  assert.ok(rec.daily.length > 0); assert.ok(!ids.has(EMP.C.id)); assert.ok([...ids].every((i) => [EMP.A.id, EMP.B.id].includes(i)));
  assert.equal((await call('GET', `/api/admin/records?employee_id=${EMP.C.id}`, null, mStore)).status, 403);
  const lv = await ok('GET', '/api/admin/leaves?status=all', null, mStore);
  assert.ok(lv.leaves.length >= 2 && lv.leaves.every((l) => [EMP.A.id, EMP.B.id].includes(l.employee_id)));
  assert.equal(lv.pending, lv.leaves.filter((l) => l.status === 'pending').length);
  const lw = await ok('GET', '/api/admin/leaves?status=all', null, mWare);
  assert.ok(lw.leaves.some((l) => l.id === wfhC) && lw.leaves.every((l) => l.employee_id === EMP.C.id));
  assert.equal((await ok('GET', '/api/admin/me', null, mWare)).leave_pending, lw.pending);
});

test('審核：只能審自己團隊；記錄審核者；員工看得到審核者；稽核紀錄有操作者', async () => {
  assert.equal((await call('POST', `/api/admin/leaves/${leaveC}/approve`, {}, mStore)).status, 404, '別的團隊');
  await ok('POST', `/api/admin/leaves/${leaveA}/approve`, { comment: '已安排代班' }, mStore);
  await ok('POST', `/api/admin/leaves/${wfhC}/reject`, { comment: '當天要盤點' }, mWare);
  await ok('POST', `/api/admin/leaves/${leaveB}/approve`, {}); // 管理員仍可審核
  const mineA = (await ok('GET', '/api/leaves', null, '', await empAuth(EMP.A.id, '1111'))).requests.find((l) => l.id === leaveA);
  assert.equal(mineA.status, 'approved'); assert.equal(mineA.decided_by, '陳店長'); assert.equal(mineA.admin_comment, '已安排代班');
  const mineC = (await ok('GET', '/api/leaves', null, '', await empAuth(EMP.C.id, '3333'))).requests.find((l) => l.id === wfhC);
  assert.equal(mineC.status, 'rejected'); assert.equal(mineC.decided_by, '林組長');
  const mineB = (await ok('GET', '/api/leaves', null, '', await empAuth(EMP.B.id, '2222'))).requests.find((l) => l.id === leaveB);
  assert.equal(mineB.decided_by, '管理員');
  const logs = await ok('GET', '/api/admin/audit');
  const ap = logs.find((a) => a.action === '核准請假' && a.detail.includes('示範員工A'));
  assert.equal(ap.actor, '主管 陳店長（chen）'); assert.match(ap.detail, /審核：陳店長/);
  assert.equal(logs.find((a) => a.action === '退回請假').actor, '主管 林組長（lin）');
  assert.equal(logs.find((a) => a.action === '核准請假' && a.detail.includes('示範員工B')).actor, '管理員');
  // 已審核的不能再審
  assert.equal((await call('POST', `/api/admin/leaves/${leaveA}/reject`, {}, mStore)).status, 400);
});

test('部門變動即時生效；停用、重設密碼會登出；主管可改自己的密碼', async () => {
  await ok('PUT', `/api/admin/employees/${EMP.C.id}`, { name: '示範員工C', pin: '3333', note: '示範資料，可刪除', email: EMP.C.email, department: '門市部' });
  assert.equal((await ok('GET', '/api/admin/me', null, mStore)).team_size, 3);
  await ok('PUT', `/api/admin/employees/${EMP.C.id}`, { name: '示範員工C', pin: '3333', note: '示範資料，可刪除', email: EMP.C.email, department: '倉儲部' });
  assert.equal((await ok('GET', '/api/admin/me', null, mStore)).team_size, 2);
  assert.equal((await call('PUT', '/api/admin/password', { old_password: 'nope', new_password: 'new-pass-123' }, mStore)).status, 400);
  await ok('PUT', '/api/admin/password', { old_password: 'store-pass-1', new_password: 'new-pass-123' }, mStore);
  assert.equal(typeof (await login('chen', 'new-pass-123')), 'string');
  await ok('PUT', `/api/admin/managers/${M2.id}`, { name: '林組長', username: 'lin', employee_ids: [EMP.C.id], active: false });
  assert.equal((await call('GET', '/api/admin/me', null, mWare)).status, 401);
  assert.equal((await login('lin', 'ware-pass-1')).status, 401);
  await ok('PUT', `/api/admin/managers/${M2.id}`, { name: '林組長', username: 'lin', employee_ids: [EMP.C.id], active: true, password: 'reset-pass-9' });
  assert.equal(typeof (await login('lin', 'reset-pass-9')), 'string');
  await ok('DELETE', `/api/admin/managers/${M2.id}`);
  assert.equal((await login('lin', 'reset-pass-9')).status, 401);
});

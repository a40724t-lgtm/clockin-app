// 員工填可上班時段：開放期間（管理員／主管權限）、員工填寫與截止、排班顯示與「不行」提醒、未提交名單
// 執行：npm test（暫存資料夾啟動獨立伺服器；示範員工 A、B＝門市部，C＝倉儲部）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4200 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clockin-avail-'));
let srv, owner = '', mgr = '';
async function call(method, url, body, cookie = owner, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {}
  return Array.isArray(j) ? Object.assign(j, { status: r.status, text }) : { status: r.status, text, setCookie: r.headers.get('set-cookie'), ...j };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${r.error || ''}`); return r; };
const empAuth = async (id, pin) => ({ Authorization: `Bearer ${(await ok('POST', '/api/login', { employee_id: id, pin }, '')).token}` });
const days = (from, n, f) => Array.from({ length: n }, (_, i) => { const d = new Date(from + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); const date = d.toISOString().slice(0, 10); return { date, ...f(date, i) }; });

let EMP, T, P1, hA, hB, hC;
before(async () => {
  srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, PORT: String(PORT), PII_KEY: '' }, stdio: 'ignore' });
  for (let i = 0; i < 200; i++) { try { await fetch(BASE + '/api/public/info'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  owner = (await call('POST', '/api/admin/login', { password: 'admin1234' }, '')).setCookie.split(';')[0];
  EMP = Object.fromEntries((await ok('GET', '/api/admin/employees')).map((e) => [e.name.slice(-1), e]));
  await ok('POST', '/api/admin/managers', { name: '陳店長', username: '陳店長', password: 'store-pass-1', departments: ['門市部'] });
  mgr = (await call('POST', '/api/admin/login', { username: '陳店長', password: 'store-pass-1' }, '')).setCookie.split(';')[0];
  T = Object.fromEntries((await ok('GET', '/api/admin/shift-templates')).templates.map((t) => [t.name, t.id]));
  hA = await empAuth(EMP.A.id, '1111'); hB = await empAuth(EMP.B.id, '2222'); hC = await empAuth(EMP.C.id, '3333');
});
after(() => { srv && srv.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('開放登記：驗證日期、截止時間、重疊', async () => {
  const base = { from: '2027-05-03', to: '2027-05-09', deadline_date: '2027-05-01', deadline_time: '18:00', note: '五月第一週' };
  assert.equal((await call('POST', '/api/admin/avail-periods', { ...base, to: '2027-05-01' })).status, 400);
  assert.equal((await call('POST', '/api/admin/avail-periods', { ...base, deadline_date: '2027-05-12' })).status, 400, '截止晚於期間');
  assert.equal((await call('POST', '/api/admin/avail-periods', { ...base, deadline_date: '2020-01-01' })).status, 400, '截止已過');
  assert.equal((await call('POST', '/api/admin/avail-periods', { ...base, deadline_time: '25:00' })).status, 400);
  P1 = (await ok('POST', '/api/admin/avail-periods', base)).id;
  assert.equal((await call('POST', '/api/admin/avail-periods', { ...base, from: '2027-05-09', to: '2027-05-15', deadline_date: '2027-05-08' })).status, 409, '重疊');
  const list = (await ok('GET', '/api/admin/avail-periods')).periods;
  assert.equal(list[0].employee_count, 3); assert.equal(list[0].submitted_count, 0); assert.equal(list[0].open, true);
  assert.equal((await call('GET', '/api/admin/avail-periods', null, '', hA)).status, 401, '員工不能用管理 API');
});

test('員工填寫：要填完每一天、想上的班別要存在、截止前可修改、未在名單的人看不到', async () => {
  let me = await ok('GET', '/api/availability', null, '', hA);
  assert.equal(me.pending, 1); assert.equal(me.periods[0].days.length, 7); assert.equal(me.periods[0].submitted_at, '');
  assert.ok(me.templates.some((t) => t.name === '早班'));
  const put = (h, d) => call('PUT', `/api/availability/${P1}`, { days: d }, '', h);
  assert.equal((await put(hA, days('2027-05-03', 3, () => ({ status: 'ok' })))).status, 400, '沒填完');
  assert.equal((await put(hA, days('2027-05-03', 7, () => ({ status: 'pref', template_id: 9999 })))).status, 400, '班別不存在');
  assert.equal((await put(hA, days('2027-05-10', 7, () => ({ status: 'ok' })))).status, 400, '日期不在期間');
  const fill = days('2027-05-03', 7, (d, i) => (i === 2 ? { status: 'no', note: '小孩畢業典禮' } : i < 2 ? { status: 'pref', template_id: T['早班'] } : { status: 'ok' }));
  const r = await ok('PUT', `/api/availability/${P1}`, { days: fill }, '', hA);
  assert.equal(r.no_days, 1);
  me = await ok('GET', '/api/availability', null, '', hA);
  assert.equal(me.pending, 0); assert.ok(me.periods[0].submitted_at);
  assert.equal(me.periods[0].days[0].template_name, '早班'); assert.equal(me.periods[0].days[2].note, '小孩畢業典禮');
  // 修改
  await ok('PUT', `/api/availability/${P1}`, { days: fill.map((x, i) => (i === 6 ? { date: x.date, status: 'no' } : x)) }, '', hA);
  assert.equal((await ok('GET', '/api/availability', null, '', hA)).periods[0].days[6].status, 'no');
  // 提前結束 → 不能改；重新開放 → 可以
  await ok('PUT', `/api/admin/avail-periods/${P1}`, { closed: true });
  assert.equal((await put(hA, fill)).status, 409);
  assert.equal((await ok('GET', '/api/availability', null, '', hA)).periods[0].open, false);
  await ok('PUT', `/api/admin/avail-periods/${P1}`, { closed: false });
  await ok('PUT', `/api/availability/${P1}`, { days: fill }, '', hA);
});

test('排班畫面：顯示可上班狀態、排在「不行」的日子會提醒、列出未提交的人', async () => {
  const g = await ok('GET', '/api/admin/schedule?from=2027-05-03&to=2027-05-09');
  const a = g.availability.filter((x) => x.employee_id === EMP.A.id);
  assert.equal(a.length, 7);
  assert.equal(a.find((x) => x.date === '2027-05-03').status_text, '想上早班');
  assert.equal(a.find((x) => x.date === '2027-05-05').status, 'no');
  assert.equal(g.avail_periods.length, 1);
  assert.deepEqual(g.avail_periods[0].missing.map((m) => m.name).sort(), ['示範員工B', '示範員工C']);
  const r = await ok('PUT', '/api/admin/schedule/entries', { items: [{ employee_id: EMP.A.id, date: '2027-05-05', kind: 'shift', template_id: T['全天'] }, { employee_id: EMP.A.id, date: '2027-05-04', kind: 'shift', template_id: T['全天'] }] });
  const u = r.warnings.filter((w) => w.type === 'unavail');
  assert.equal(u.length, 1); assert.equal(u[0].date, '2027-05-05'); assert.match(u[0].text, /不行上班（小孩畢業典禮）/);
  // 發布照舊
  await ok('POST', '/api/admin/schedule/publish', { week_start: '2027-05-03' });
  assert.equal((await ok('GET', '/api/schedule?from=2027-05-03&to=2027-05-09', null, '', hA)).entries.length, 2);
});

test('主管：只能為自己團隊開放、只看得到自己團隊的人、不能刪除含其他團隊的期間', async () => {
  // 看得到管理員開的期間，但名單只有自己團隊
  const seen = (await ok('GET', '/api/admin/avail-periods', null, mgr)).periods.find((p) => p.id === P1);
  assert.equal(seen.employee_count, 2); assert.deepEqual(seen.missing.map((m) => m.name), ['示範員工B']); assert.equal(seen.can_manage, false);
  assert.equal((await call('DELETE', `/api/admin/avail-periods/${P1}`, null, mgr)).status, 403);
  assert.equal((await call('PUT', `/api/admin/avail-periods/${P1}`, { closed: true }, mgr)).status, 403);
  const base = { from: '2027-06-07', to: '2027-06-13', deadline_date: '2027-06-04', deadline_time: '12:00' };
  assert.equal((await call('POST', '/api/admin/avail-periods', { ...base, employee_ids: [EMP.A.id, EMP.C.id] }, mgr)).status, 403);
  assert.equal((await call('POST', '/api/admin/avail-periods', { ...base, departments: ['倉儲部'] }, mgr)).status, 403);
  const id = (await ok('POST', '/api/admin/avail-periods', base, mgr)).id;
  const mine = (await ok('GET', '/api/admin/avail-periods', null, mgr)).periods.find((p) => p.id === id);
  assert.equal(mine.employee_count, 2); assert.equal(mine.can_manage, true);
  // C 不在名單 → 看不到、不能填
  assert.ok(!(await ok('GET', '/api/availability', null, '', hC)).periods.some((p) => p.id === id));
  assert.equal((await call('PUT', `/api/availability/${id}`, { days: [] }, '', hC)).status, 404);
  // 主管排班看得到團隊的可上班狀態，看不到 C
  await ok('PUT', `/api/availability/${id}`, { days: days('2027-06-07', 7, () => ({ status: 'ok' })) }, '', hB);
  const g = await ok('GET', '/api/admin/schedule?from=2027-06-07&to=2027-06-13', null, mgr);
  assert.equal(g.availability.length, 7); assert.ok(g.availability.every((x) => x.employee_id === EMP.B.id));
  await ok('PUT', `/api/admin/avail-periods/${id}`, { deadline_date: '2027-06-05', deadline_time: '20:00', note: '延長' }, mgr);
  await ok('DELETE', `/api/admin/avail-periods/${id}`, null, mgr);
  assert.equal((await ok('GET', '/api/admin/schedule?from=2027-06-07&to=2027-06-13', null, mgr)).availability.length, 0, '刪除期間連同填寫內容');
  const audit = JSON.stringify(await ok('GET', '/api/admin/audit'));
  assert.ok(audit.includes('開放可上班時段登記') && audit.includes('陳店長'));
});

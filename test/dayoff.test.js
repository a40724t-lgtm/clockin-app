// 簡化排班：不可排班（員工點日子／固定休假日、主管代填）、提醒（七休一、班距含跨夜、不可排班、公休）、
// 每日最少人數設定、複製上週略過公休、重設回到上次發布、主管只限自己團隊
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4200 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clockin-dayoff-'));
let srv, owner = '', mgr = '';
async function call(method, url, body, cookie = owner, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {}
  return Array.isArray(j) ? Object.assign(j, { status: r.status, text }) : { status: r.status, text, setCookie: r.headers.get('set-cookie'), ...j };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${r.error || ''}`); return r; };
const empAuth = async (id, pin) => ({ Authorization: `Bearer ${(await ok('POST', '/api/login', { employee_id: id, pin }, '')).token}` });
const taipeiToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const shift = (id, date, tpl) => ({ employee_id: id, date, kind: 'shift', template_id: tpl });
const W = (r, type, id, date) => r.warnings.filter((w) => w.type === type && (!id || w.employee_id === id) && (!date || w.date === date));

let EMP, T, hA, hC;
before(async () => {
  srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR, PORT: String(PORT), PII_KEY: '' }, stdio: 'ignore' });
  for (let i = 0; i < 200; i++) { try { await fetch(BASE + '/api/public/info'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  owner = (await call('POST', '/api/admin/login', { password: 'admin1234' }, '')).setCookie.split(';')[0];
  EMP = Object.fromEntries((await ok('GET', '/api/admin/employees')).map((e) => [e.name.slice(-1), e]));
  await ok('POST', '/api/admin/managers', { name: '陳店長', username: '陳店長', password: 'store-pass-1', departments: ['門市部'] });
  mgr = (await call('POST', '/api/admin/login', { username: '陳店長', password: 'store-pass-1' }, '')).setCookie.split(';')[0];
  // 預設班別先記下來（第一個測試檢查），再換成測試用的固定班別（含休息時間、跨夜班）
  SEED = (await ok('GET', '/api/admin/shift-templates')).templates;
  for (const t of SEED) await ok('PUT', `/api/admin/shift-templates/${t.id}`, { ...t, active: false });
  for (const [name, start, end, break_min, applies] of [['早班', '08:00', '16:30', 30, 'all'], ['全天', '09:00', '18:00', 60, 'all'], ['晚班', '14:00', '22:30', 30, 'all'], ['大夜班', '22:00', '07:00', 60, 'all']])
    await ok('POST', '/api/admin/shift-templates', { name, start, end, break_min, applies, color: 'primary' });
  const ACTIVE = (await ok('GET', '/api/admin/shift-templates')).templates.filter((t) => t.active);
  T = Object.fromEntries(ACTIVE.map((t) => [t.name, t.id]));
  hA = await empAuth(EMP.A.id, '1111'); hC = await empAuth(EMP.C.id, '3333');
});
after(() => { srv && srv.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('舊的可上班時段登記 API 已移除', async () => {
  assert.equal((await call('GET', '/api/admin/avail-periods')).status, 404);
  assert.equal((await call('GET', '/api/availability', null, '', hA)).status, 404);
});

test('員工：點未來的日子切換不可排班（今天以前不行）、固定休假日', async () => {
  const t = taipeiToday(), tm = addDays(t, 1);
  assert.equal((await call('PUT', `/api/dayoff/${t}`, { off: true }, '', hA)).status, 400, '今天不行');
  assert.equal((await call('PUT', `/api/dayoff/${addDays(t, -3)}`, { off: true }, '', hA)).status, 400);
  assert.equal((await call('PUT', `/api/dayoff/${addDays(t, 400)}`, { off: true }, '', hA)).status, 400, '超過半年');
  await ok('PUT', `/api/dayoff/${tm}`, { off: true }, '', hA);
  await ok('PUT', `/api/dayoff/${tm}`, { off: true }, '', hA); // 重複沒關係
  let me = await ok('GET', `/api/dayoff?month=${tm.slice(0, 7)}`, null, '', hA);
  assert.deepEqual(me.dates, [tm]);
  await ok('PUT', `/api/dayoff/${tm}`, { off: false }, '', hA);
  me = await ok('GET', `/api/dayoff?month=${tm.slice(0, 7)}`, null, '', hA);
  assert.deepEqual(me.dates, []);
  assert.equal((await call('PUT', '/api/dayoff/fixed', { days: [0, 1, 2, 3, 4, 5, 6] }, '', hA)).status, 400, '至少留一天');
  await ok('PUT', '/api/dayoff/fixed', { days: [6, 0, 0] }, '', hA);
  assert.deepEqual((await ok('GET', '/api/dayoff', null, '', hA)).fixed, [0, 6]);
  assert.deepEqual((await ok('GET', '/api/admin/employees')).find((e) => e.id === EMP.A.id).fixed_off, [0, 6]);
});

test('管理員／主管代填：固定休假日、每月休假天數、不可排班日；主管只限自己團隊', async () => {
  await ok('PUT', `/api/admin/employees/${EMP.B.id}/schedule-prefs`, { fixed_off: [3] }, mgr);
  await ok('PUT', `/api/admin/employees/${EMP.B.id}/schedule-prefs`, { monthly_off: 8 }, mgr);
  assert.equal((await call('PUT', `/api/admin/employees/${EMP.B.id}/schedule-prefs`, { monthly_off: 40 }, mgr)).status, 400);
  assert.equal((await call('PUT', `/api/admin/employees/${EMP.C.id}/schedule-prefs`, { fixed_off: [1] }, mgr)).status, 403);
  assert.equal((await call('PUT', `/api/admin/employees/${EMP.C.id}/dayoff/2027-05-05`, { off: true }, mgr)).status, 403);
  await ok('PUT', `/api/admin/employees/${EMP.B.id}/dayoff/2027-05-04`, { off: true }, mgr);
  const B = (await ok('GET', '/api/admin/employees', null, mgr)).find((e) => e.id === EMP.B.id);
  assert.deepEqual(B.fixed_off, [3]); assert.equal(B.monthly_off, 8);
  await ok('PUT', `/api/admin/employees/${EMP.B.id}/schedule-prefs`, { monthly_off: null });
  assert.equal((await ok('GET', '/api/admin/employees')).find((e) => e.id === EMP.B.id).monthly_off, null, '空白＝不檢查');
  // 排班表顯示不可排班（固定 + 指定日）
  const g = await ok('GET', '/api/admin/schedule?from=2027-05-03&to=2027-05-09', null, mgr);
  const offs = g.dayoff.filter((x) => x.employee_id === EMP.B.id).map((x) => `${x.date}:${x.kind}`).sort();
  assert.deepEqual(offs, ['2027-05-04:date', '2027-05-05:fixed']);
  assert.ok(!g.dayoff.some((x) => x.employee_id === EMP.C.id), '主管看不到其他團隊');
  // 排在不可排班的日子：仍存檔，但提醒
  const r = await ok('PUT', '/api/admin/schedule/entries', { items: [shift(EMP.B.id, '2027-05-05', T['早班']), shift(EMP.B.id, '2027-05-04', T['早班'])] }, mgr);
  assert.equal(r.saved, 2);
  assert.match(W(r, 'dayoff', EMP.B.id, '2027-05-05')[0].text, /固定休假日（週三）/);
  assert.match(W(r, 'dayoff', EMP.B.id, '2027-05-04')[0].text, /員工設定不可排班/);
  const audit = JSON.stringify(await ok('GET', '/api/admin/audit'));
  assert.ok(audit.includes('代填不可排班') && audit.includes('修改排班設定'));
});

test('提醒：七休一（連續上班超過 6 天）、班距未滿 11 小時（含跨夜班）', async () => {
  const C = EMP.C.id;
  const days = Array.from({ length: 7 }, (_, i) => addDays('2027-06-07', i));
  let r = await ok('PUT', '/api/admin/schedule/entries', { items: days.slice(0, 6).map((d) => shift(C, d, T['全天'])) });
  assert.equal(W(r, 'streak', C).length, 0, '6 天不提醒');
  r = await ok('PUT', '/api/admin/schedule/entries', { items: [shift(C, days[6], T['全天'])] });
  assert.equal(W(r, 'streak', C, days[6]).length, 1); assert.match(W(r, 'streak', C)[0].text, /七休一.*第 7 天/);
  // 班距：大夜班 22:00～翌 07:00，隔天 早班 08:00 → 只隔 1 小時；晚班 22:30 下班、隔天全天 09:00 → 10.5 小時
  r = await ok('PUT', '/api/admin/schedule/entries', { items: [shift(C, '2027-06-21', T['大夜班']), shift(C, '2027-06-22', T['早班']), shift(C, '2027-06-24', T['晚班']), shift(C, '2027-06-25', T['全天'])] });
  assert.match(W(r, 'rest', C, '2027-06-22')[0].text, /班距.*1 小時.*11 小時/);
  assert.match(W(r, 'rest', C, '2027-06-25')[0].text, /10\.5 小時/);
  assert.equal(W(r, 'rest', C, '2027-06-24').length, 0, '早班 16:30 → 隔天晚班 14:00 足夠');
});

test('公休（公司自訂假日）：複製上週時略過；每日最少人數設定；重設回到上次發布', async () => {
  const A = EMP.A.id, B = EMP.B.id;
  await ok('POST', '/api/admin/holidays/custom', { date: '2027-07-14', name: '盤點公休' });
  const src = ['2027-07-05', '2027-07-06', '2027-07-07'];
  await ok('PUT', '/api/admin/schedule/entries', { items: src.flatMap((d) => [shift(A, d, T['早班']), shift(B, d, T['晚班'])]) });
  const c = await ok('POST', '/api/admin/schedule/copy', { source_week: '2027-07-05', target_weeks: ['2027-07-12'] });
  assert.equal(c.copied, 4); assert.equal(c.closed, 2, '7/14 公休兩格略過');
  let g = await ok('GET', '/api/admin/schedule?from=2027-07-12&to=2027-07-18');
  assert.ok(!g.entries.some((e) => e.date === '2027-07-14'));
  assert.ok(g.holidays.some((h) => h.date === '2027-07-14' && h.kind === 'custom'));
  // 最少人數
  assert.equal(g.min_staff, 2);
  await ok('PUT', '/api/admin/schedule/settings', { min_staff: 3 });
  assert.equal((await ok('GET', '/api/admin/schedule?from=2027-07-12&to=2027-07-18')).min_staff, 3);
  await ok('PUT', '/api/admin/schedule/settings', { min_staff: '' });
  assert.equal((await ok('GET', '/api/admin/schedule/settings')).min_staff, null, '空白＝不檢查');
  assert.equal((await call('PUT', '/api/admin/schedule/settings', { min_staff: 0 })).status, 400);
  assert.equal((await call('PUT', '/api/admin/schedule/settings', { min_staff: 2 }, mgr)).status, 403, '主管不能改');
  await ok('PUT', '/api/admin/schedule/settings', { min_staff: 2 });
  // 重設：未發布的週 → 清空
  await ok('POST', '/api/admin/schedule/reset', { week_start: '2027-07-12' });
  assert.equal((await ok('GET', '/api/admin/schedule?from=2027-07-12&to=2027-07-18')).entries.length, 0);
  // 已發布的週 → 回到發布的內容
  await ok('POST', '/api/admin/schedule/publish', { week_start: '2027-07-05' });
  await ok('PUT', '/api/admin/schedule/entries', { items: [{ employee_id: A, date: '2027-07-05', kind: 'rest' }, shift(A, '2027-07-09', T['全天'])] });
  await ok('POST', '/api/admin/schedule/reset', { week_start: '2027-07-05' });
  g = await ok('GET', '/api/admin/schedule?from=2027-07-05&to=2027-07-11');
  assert.equal(g.entries.length, 6); assert.equal(g.entries.find((e) => e.employee_id === A && e.date === '2027-07-05').name, '早班');
  assert.equal(g.weeks[0].status, 'published');
  // 主管重設只影響自己的團隊（C 的草稿保留）
  await ok('PUT', '/api/admin/schedule/entries', { items: [shift(EMP.C.id, '2027-07-08', T['早班']), shift(A, '2027-07-08', T['全天'])] });
  await ok('POST', '/api/admin/schedule/reset', { week_start: '2027-07-05' }, mgr);
  g = await ok('GET', '/api/admin/schedule?from=2027-07-05&to=2027-07-11');
  assert.ok(g.entries.some((e) => e.employee_id === EMP.C.id && e.date === '2027-07-08'));
  assert.ok(!g.entries.some((e) => e.employee_id === A && e.date === '2027-07-08'), 'A 的 7/8 回到發布時（沒有班）');
  assert.equal((await call('POST', '/api/admin/schedule/reset', { week_start: '2027-07-06' })).status, 400);
});

test('正職／工讀（依薪資類型）、排班中／不排班', async () => {
  let g = await ok('GET', '/api/admin/schedule?from=2027-08-02&to=2027-08-08');
  const by = Object.fromEntries(g.employees.map((e) => [e.id, e]));
  assert.equal(by[EMP.A.id].staff, 'full'); assert.equal(by[EMP.A.id].staff_text, '正職');
  assert.equal(by[EMP.C.id].staff, 'part'); assert.equal(by[EMP.C.id].staff_text, '工讀', '時薪＝工讀');
  // 不排班：從班表與人數中隱藏，但打卡、薪資照常
  let r = await ok('PUT', `/api/admin/employees/${EMP.C.id}/schedule-prefs`, { scheduling: false });
  assert.equal(r.scheduling, false);
  g = await ok('GET', '/api/admin/schedule?from=2027-08-02&to=2027-08-08');
  assert.ok(!g.employees.some((e) => e.id === EMP.C.id));
  assert.ok(g.hidden_employees.some((e) => e.id === EMP.C.id));
  const emps = await ok('GET', '/api/admin/employees');
  assert.equal(emps.find((e) => e.id === EMP.C.id).scheduling, false, '仍在員工清單');
  const pay = await ok('GET', '/api/admin/payroll?month=2027-08');
  assert.ok(pay.employees.some((e) => e.id === EMP.C.id), '仍在薪資');
  assert.equal((await call('PUT', `/api/admin/employees/${EMP.C.id}/schedule-prefs`, { scheduling: true }, mgr)).status, 403, '主管不能改別隊');
  await ok('PUT', `/api/admin/employees/${EMP.C.id}/schedule-prefs`, { scheduling: true });
  g = await ok('GET', '/api/admin/schedule?from=2027-08-02&to=2027-08-08');
  assert.ok(g.employees.some((e) => e.id === EMP.C.id));
});

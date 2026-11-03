// 排班系統：班別（含跨夜）、勞基法提醒、主管權限（只能排自己團隊）、草稿／發布、員工只看已發布、打卡紀錄對照班表
// 執行：npm test（暫存資料夾啟動獨立伺服器；示範員工 A、B＝門市部，C＝倉儲部）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4100 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clockin-sched-'));
let srv, owner = '', mgr = '';

async function call(method, url, body, cookie = owner, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {}
  return Array.isArray(j) ? Object.assign(j, { status: r.status, text }) : { status: r.status, text, setCookie: r.headers.get('set-cookie'), ...j };
}
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${r.error || ''}`); return r; };
const empAuth = async (id, pin) => ({ Authorization: `Bearer ${(await ok('POST', '/api/login', { employee_id: id, pin }, '')).token}` });
const put = (items, cookie = owner) => call('PUT', '/api/admin/schedule/entries', { items }, cookie);
const W = (r, type, id, date) => r.warnings.filter((w) => w.type === type && (!id || w.employee_id === id) && (!date || w.date === date));

let EMP, T, SEED;
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
  T = Object.fromEntries(ACTIVE.map((t) => [t.name, t]));
});
after(() => { srv && srv.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('班別：預設班別（正職／工讀）、跨夜時數、顏色只能用色票、適用對象、驗證', async () => {
  assert.deepEqual(SEED.map((t) => `${t.name} ${t.start}-${t.end} ${t.applies_text} ${t.hours}h`), ['早班 08:00-17:00 正職班 9h', '晚班 12:00-21:00 正職班 9h', '午班 10:00-14:00 工讀班 4h', '晚間 17:00-21:00 工讀班 4h']);
  assert.ok(SEED.every((t) => t.break_min === 0));
  assert.equal(T['全天'].hours, 8); assert.equal(T['大夜班'].overnight, true); assert.equal(T['大夜班'].hours, 8);
  const pt = (await ok('POST', '/api/admin/shift-templates', { name: '工讀早', start: '06:00', end: '10:00', color: 'sand', applies: 'part' })).id;
  const ptv = (await ok('GET', '/api/admin/shift-templates')).templates.find((x) => x.id === pt);
  assert.equal(ptv.applies, 'part'); assert.equal(ptv.color, 'sand'); assert.equal(ptv.break_min, 0, '不填休息＝0');
  assert.equal((await ok('POST', '/api/admin/shift-templates', { name: '亂填', start: '06:00', end: '10:00', applies: 'xx' })).status, 200);
  assert.equal((await ok('GET', '/api/admin/shift-templates')).templates.find((x) => x.name === '亂填').applies, 'all', '不認得的適用對象＝都可以');
  for (const x of (await ok('GET', '/api/admin/shift-templates')).templates.filter((y) => ['工讀早', '亂填'].includes(y.name))) await ok('PUT', `/api/admin/shift-templates/${x.id}`, { ...x, active: false });
  const id = (await ok('POST', '/api/admin/shift-templates', { name: '小夜', start: '16:00', end: '00:30', break_min: 30, color: '#ff0000' })).id;
  const t = (await ok('GET', '/api/admin/shift-templates')).templates.find((x) => x.id === id);
  assert.equal(t.overnight, true); assert.equal(t.hours, 8); assert.equal(t.color, 'primary', '非色票顏色改用主色');
  assert.equal((await call('POST', '/api/admin/shift-templates', { name: '錯', start: '09:00', end: '09:00' })).status, 400);
  assert.equal((await call('POST', '/api/admin/shift-templates', { name: '錯', start: '9點', end: '18:00' })).status, 400);
  assert.equal((await call('POST', '/api/admin/shift-templates', { name: '錯', start: '09:00', end: '09:30', break_min: 60 })).status, 400, '扣休息後 ≦ 0');
  assert.equal((await call('POST', '/api/admin/shift-templates', { name: '主管加', start: '09:00', end: '18:00' }, mgr)).status, 403);
  assert.equal((await call('PUT', `/api/admin/shift-templates/${id}`, { name: '主管改', start: '09:00', end: '18:00' }, mgr)).status, 403);
  assert.equal((await call('GET', '/api/admin/shift-templates', null, mgr)).status, 200, '主管可讀班別');
});

test('提醒：跨夜班後休息不足 11 小時、單日超過 12 小時、連續 7 天、每月加班 46 小時、國定假日與請假衝突（不擋存檔）', async () => {
  const A = EMP.A.id, B = EMP.B.id, C = EMP.C.id;
  // 2027-01-04（一）大夜班 22:00～翌日 07:00，01-05 早班 08:00 → 只隔 1 小時；01-06 07:00～21:00 = 13 小時
  let r = await ok('PUT', '/api/admin/schedule/entries', { items: [
    { employee_id: A, date: '2027-01-04', kind: 'shift', template_id: T['大夜班'].id },
    { employee_id: A, date: '2027-01-05', kind: 'shift', template_id: T['早班'].id },
    { employee_id: A, date: '2027-01-06', kind: 'shift', start: '07:00', end: '21:00', break_min: 60 },
  ] });
  assert.equal(r.saved, 3, '有提醒也照樣存檔');
  assert.equal(W(r, 'rest', A, '2027-01-05').length, 1); assert.match(W(r, 'rest', A, '2027-01-05')[0].text, /1 小時.*第 34 條/);
  assert.equal(W(r, 'rest', A, '2027-01-06').length, 0, '16:30 下班到隔天 07:00 有 14.5 小時');
  assert.equal(W(r, 'daily', A, '2027-01-06').length, 1); assert.match(W(r, 'daily', A, '2027-01-06')[0].text, /13 小時/);
  assert.equal(W(r, 'daily', A, '2027-01-04').length, 0, '跨夜 8 小時不超過');
  const g = await ok('GET', '/api/admin/schedule?from=2027-01-04&to=2027-01-10');
  const night = g.entries.find((e) => e.employee_id === A && e.date === '2027-01-04');
  assert.equal(night.overnight, true); assert.equal(night.hours, 8);

  // 連續 7 天上班（12/7～12/13）→ 第 7 天提醒；中間排例假就不提醒
  const week = (id, from, n, extra = {}) => Array.from({ length: n }, (_, i) => { const d = new Date(from + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return { employee_id: id, date: d.toISOString().slice(0, 10), kind: 'shift', template_id: T['全天'].id, ...extra }; });
  r = await ok('PUT', '/api/admin/schedule/entries', { items: week(B, '2026-12-07', 7) });
  assert.equal(W(r, 'streak', B).length, 1); assert.equal(W(r, 'streak', B)[0].date, '2026-12-13');
  r = await ok('PUT', '/api/admin/schedule/entries', { items: [{ employee_id: B, date: '2026-12-10', kind: 'regular' }] });
  assert.equal(W(await ok('GET', '/api/admin/schedule?from=2026-12-07&to=2026-12-13'), 'streak', B).length, 0);

  // 每月加班估計：2027-02 每天 12 小時（加班 4 小時）× 12 天 = 48 小時 > 46
  r = await ok('PUT', '/api/admin/schedule/entries', { items: week(B, '2027-02-15', 12, { template_id: null, start: '07:00', end: '20:00', break_min: 60 }) });
  const m = W(r, 'month_ot', B); assert.equal(m.length, 1); assert.match(m[0].text, /2 月預估加班 48 小時.*46/);
  r = await ok('PUT', '/api/admin/schedule/entries', { items: [{ employee_id: B, date: '2027-02-26', kind: 'clear' }] });
  assert.equal(W(await ok('GET', '/api/admin/schedule?from=2027-02-01&to=2027-02-28'), 'month_ot', B).length, 0, '44 小時不提醒');

  // 國定假日（12/25 行憲紀念日）與已核准請假（12/28 事假）排班 → 衝突提醒
  const lv0 = await ok('GET', '/api/leaves', null, '', await empAuth(C, '3333'));
  await ok('POST', '/api/leaves', { mode: 'full', reason: '測試', type_id: lv0.types.find((t) => t.name === '事假').id, start_date: '2026-12-28', end_date: '2026-12-28' }, '', await empAuth(C, '3333'));
  const lid = (await ok('GET', '/api/admin/leaves?status=pending&from=2026-12-01&to=2026-12-31')).leaves.find((l) => l.employee_id === C).id;
  await ok('POST', `/api/admin/leaves/${lid}/approve`, {});
  r = await ok('PUT', '/api/admin/schedule/entries', { items: [{ employee_id: C, date: '2026-12-25', kind: 'shift', template_id: T['全天'].id }, { employee_id: C, date: '2026-12-28', kind: 'shift', template_id: T['全天'].id }] });
  assert.match(W(r, 'holiday', C, '2026-12-25')[0].text, /行憲紀念日/);
  assert.match(W(r, 'leave', C, '2026-12-28')[0].text, /事假（全天）/);
  const cal = await ok('GET', '/api/admin/schedule?from=2026-12-21&to=2027-01-03');
  assert.ok(cal.holidays.some((h) => h.date === '2026-12-25' && h.off));
  assert.ok(cal.leaves.some((l) => l.employee_id === C && l.date === '2026-12-28'));
});

test('主管：只看得到、排得到自己團隊；不能改班別或假日；發布只影響自己的團隊', async () => {
  const A = EMP.A.id, C = EMP.C.id;
  const g = await ok('GET', '/api/admin/schedule?from=2026-12-21&to=2026-12-27', null, mgr);
  assert.deepEqual(g.employees.map((e) => e.name).sort(), ['示範員工A', '示範員工B']);
  assert.ok(!g.entries.some((e) => e.employee_id === C) && !g.leaves.some((e) => e.employee_id === C) && !g.warnings.some((e) => e.employee_id === C), '看不到其他團隊');
  assert.equal(g.can_edit_holidays, false);
  assert.equal((await call('GET', `/api/admin/schedule?employee_id=${C}`, null, mgr)).status, 403);
  assert.equal((await put([{ employee_id: C, date: '2026-12-22', kind: 'shift', template_id: T['全天'].id }], mgr)).status, 403);
  assert.equal((await put([{ employee_id: A, date: '2026-12-22', kind: 'shift', template_id: T['全天'].id }, { employee_id: C, date: '2026-12-23', kind: 'rest' }], mgr)).status, 403, '混入其他團隊整批拒絕');
  assert.equal((await ok('GET', '/api/admin/schedule?from=2026-12-21&to=2026-12-27')).entries.filter((e) => e.date === '2026-12-22').length, 0, '被拒絕的批次沒有存任何一筆');
  await ok('PUT', '/api/admin/schedule/entries', { items: [{ employee_id: A, date: '2026-12-22', kind: 'shift', template_id: T['早班'].id }] }, mgr);
  assert.equal((await call('POST', '/api/admin/schedule/copy', { source_week: '2026-12-21', target_weeks: ['2026-12-28'], employee_ids: [C] }, mgr)).status, 403);
  // 假日設定仍只有管理員可以改
  assert.equal((await call('POST', '/api/admin/holidays/custom', { date: '2026-12-31', name: '尾牙' }, mgr)).status, 403);
  assert.equal((await call('GET', '/api/admin/holidays?year=2026', null, mgr)).status, 403);
  // 主管發布 12/21 這週：只發布 A、B；C 的 12/25 仍是草稿
  await ok('POST', '/api/admin/schedule/publish', { week_start: '2026-12-21' }, mgr);
  const all = await ok('GET', '/api/admin/schedule?from=2026-12-21&to=2026-12-27');
  assert.ok(all.published.some((e) => e.employee_id === A && e.date === '2026-12-22'));
  assert.ok(!all.published.some((e) => e.employee_id === C));
  assert.equal(all.weeks[0].published_count, 2); assert.match(all.weeks[0].published_text, /陳店長/);
  assert.equal((await call('POST', '/api/admin/schedule/publish', { week_start: '2026-12-22' })).status, 400, '必須是週一');
  const audit = await ok('GET', '/api/admin/audit');
  const rows = audit.rows || audit.logs || audit;
  assert.ok(JSON.stringify(rows).includes('發布班表'));
});

test('草稿／發布：員工只看到已發布的班表；發布後再改是草稿，員工仍看到舊的', async () => {
  const A = EMP.A.id, hA = await empAuth(A, '1111');
  await ok('PUT', '/api/admin/schedule/entries', { items: [{ employee_id: A, date: '2027-01-12', kind: 'shift', template_id: T['晚班'].id }, { employee_id: A, date: '2027-01-17', kind: 'regular' }] });
  let me = await ok('GET', '/api/schedule?from=2027-01-11&to=2027-01-17', null, '', hA);
  assert.equal(me.entries.length, 0, '未發布看不到');
  await ok('POST', '/api/admin/schedule/publish', { week_start: '2027-01-11' });
  me = await ok('GET', '/api/schedule?from=2027-01-11&to=2027-01-17', null, '', hA);
  assert.deepEqual(me.entries.map((e) => `${e.date} ${e.kind} ${e.name}`), ['2027-01-12 shift 晚班', '2027-01-17 regular ']);
  assert.ok(!me.entries.some((e) => e.employee_id !== A));
  await ok('PUT', '/api/admin/schedule/entries', { items: [{ employee_id: A, date: '2027-01-12', kind: 'shift', template_id: T['早班'].id }] });
  const wk = (await ok('GET', '/api/admin/schedule?from=2027-01-11&to=2027-01-17')).weeks[0];
  assert.equal(wk.status, 'changed'); assert.ok(wk.changed >= 1);
  me = await ok('GET', '/api/schedule?from=2027-01-11&to=2027-01-17', null, '', hA);
  assert.equal(me.entries.find((e) => e.date === '2027-01-12').name, '晚班', '還沒重新發布 → 員工看到舊班');
  await ok('POST', '/api/admin/schedule/publish', { week_start: '2027-01-11', unpublish: true });
  assert.equal((await ok('GET', '/api/schedule?from=2027-01-11&to=2027-01-17', null, '', hA)).entries.length, 0, '取消發布');
  // 員工沒有管理 API
  assert.equal((await call('GET', '/api/admin/schedule', null, '', hA)).status, 401);
});

test('複製上週／重複套用：已有班表預設不覆蓋', async () => {
  const B = EMP.B.id;
  await ok('PUT', '/api/admin/schedule/entries', { items: [{ employee_id: B, date: '2027-03-01', kind: 'shift', template_id: T['早班'].id }, { employee_id: B, date: '2027-03-07', kind: 'regular' }, { employee_id: B, date: '2027-03-15', kind: 'rest' }] });
  let r = await ok('POST', '/api/admin/schedule/copy', { source_week: '2027-03-01', target_weeks: ['2027-03-08', '2027-03-15', '2027-03-22'], employee_ids: [B] });
  assert.equal(r.copied, 5); assert.equal(r.skipped, 1);
  let g = await ok('GET', `/api/admin/schedule?from=2027-03-01&to=2027-03-28&employee_id=${B}`);
  assert.equal(g.entries.find((e) => e.date === '2027-03-15').kind, 'rest', '沒有覆蓋');
  assert.equal(g.entries.find((e) => e.date === '2027-03-22').name, '早班');
  r = await ok('POST', '/api/admin/schedule/copy', { source_week: '2027-03-01', target_weeks: ['2027-03-15'], employee_ids: [B], overwrite: true });
  g = await ok('GET', `/api/admin/schedule?from=2027-03-15&to=2027-03-21&employee_id=${B}`);
  assert.equal(g.entries.find((e) => e.date === '2027-03-15').name, '早班');
  assert.equal((await call('POST', '/api/admin/schedule/copy', { source_week: '2027-03-02', target_weeks: ['2027-03-09'] })).status, 400);
});

test('打卡紀錄：依已發布班表判斷遲到、早退，顯示排定與實際', async () => {
  const A = EMP.A.id;
  await ok('PUT', '/api/admin/schedule/entries', { items: [
    { employee_id: A, date: '2027-04-12', kind: 'shift', template_id: T['晚班'].id },  // 14:00～22:30
    { employee_id: A, date: '2027-04-14', kind: 'shift', template_id: T['早班'].id },  // 08:00～16:30
  ] });
  await ok('POST', '/api/admin/schedule/publish', { week_start: '2027-04-12' });
  const punch = (date, type, time) => ok('POST', '/api/admin/punches', { employee_id: A, type, date, time, reason: '測試' });
  await punch('2027-04-12', 'in', '13:58'); await punch('2027-04-12', 'out', '21:30');
  await punch('2027-04-13', 'in', '09:20'); await punch('2027-04-13', 'out', '18:00'); // 沒排班 → 依設定的上班時間
  const rec = await ok('GET', `/api/admin/records?from=2027-04-12&to=2027-04-13&employee_id=${A}`);
  const d2 = rec.daily.find((r) => r.date === '2027-04-12');
  assert.equal(d2.late, false, '晚班 14:00 上班，13:58 不算遲到（若照 09:00 上班會算遲到）');
  assert.equal(d2.early, true); assert.equal(d2.early_min, 60);
  assert.equal(d2.shift.text, '晚班 14:00～22:30');
  const d0 = rec.daily.find((r) => r.date === '2027-04-13');
  assert.equal(d0.shift, null); assert.equal(d0.late, true);
  assert.equal(rec.totals.early_count, 1);
  // 主管看自己團隊紀錄也有班表欄位
  const mrec = await ok('GET', `/api/admin/records?from=2027-04-12&to=2027-04-12`, null, mgr);
  assert.equal(mrec.daily.find((r) => r.employee_id === A).shift.name, '晚班');
});

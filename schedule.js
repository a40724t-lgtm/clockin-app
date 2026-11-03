// 排班系統：班別、班表（草稿／已發布）、勞基法提醒、權限
// - 班表以「員工＋日期」為單位：shift 上班（班別或自訂時間）、rest 休息日、regular 例假
// - 管理員／主管編輯的是草稿（schedule_entries）；「發布」時把該週草稿複製到 schedule_published，員工與打卡紀錄只看已發布的班表
// - 提醒（不擋存檔）：勞基法第 30、32 條（每日正常工時 8 小時、含加班不超過 12 小時；每月加班不超過 46 小時）、
//   第 34 條（輪班更換班次至少間隔 11 小時）、第 36 條（每 7 日應有 1 日例假、1 日休息日；連續工作不得超過 6 日）
const L = require('./leave');

const H = 3600000;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
const COLORS = ['primary', 'primary-deep', 'primary-soft', 'sand', 'accent', 'accent-soft', 'text', 'text-soft']; // 只用主色／重點色／文字色的深淺（奶茶色系，無綠色）
const APPLIES = { all: '都可以', full: '正職班', part: '工讀班' };
const KINDS = { shift: '上班', rest: '休息日', regular: '例假' };
const DAILY_MAX_H = 12, REST_MIN_H = 11, MONTH_OT_MAX_H = 46, MAX_STREAK = 6;
const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const weekStart = (d) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return L.addDays(d, -((w + 6) % 7)); }; // 週一
// 班的起訖（epoch）；結束時間 ≦ 開始時間視為跨夜（隔天結束）
function span(date, start, end) {
  const s = L.toEpoch(date, start);
  let e = L.toEpoch(date, end);
  if (e <= s) e += 24 * H;
  return { s, e, overnight: mins(end) <= mins(start) };
}
const shiftHours = (x) => { const { s, e } = span(x.date, x.start, x.end); return Math.max(0, (e - s) / H - (x.break_min || 0) / 60); };
const r2 = (n) => Math.round(n * 100) / 100;

module.exports = function registerSchedule(ctx) {
  const { app, db, audit, HOL, getSettings, getSetting, setSetting, inTeam, ownerOnly, requireEmployee, fmtDateTime, DAYOFF } = ctx;
  if (getSetting('sched_min_staff') === undefined) setSetting('sched_min_staff', '2'); // 每日最少上班人數（空白＝不檢查）
  const minStaff = () => { const v = getSetting('sched_min_staff'); return v === '' || v == null ? null : Number(v); };
  const isClosed = (d) => { const h = HOL.info(d); return !!(h && h.off && h.kind === 'custom'); }; // 公休（公司自訂假日）
  db.exec(`
CREATE TABLE IF NOT EXISTS shift_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
  break_min INTEGER DEFAULT 0, color TEXT DEFAULT 'primary', active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS schedule_entries (
  employee_id INTEGER NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, template_id INTEGER, name TEXT DEFAULT '',
  start TEXT DEFAULT '', end TEXT DEFAULT '', break_min INTEGER DEFAULT 0, color TEXT DEFAULT '', note TEXT DEFAULT '',
  updated_at INTEGER, updated_by TEXT DEFAULT '', PRIMARY KEY (employee_id, date)
);
CREATE TABLE IF NOT EXISTS schedule_published (
  employee_id INTEGER NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, template_id INTEGER, name TEXT DEFAULT '',
  start TEXT DEFAULT '', end TEXT DEFAULT '', break_min INTEGER DEFAULT 0, color TEXT DEFAULT '', note TEXT DEFAULT '',
  PRIMARY KEY (employee_id, date)
);
CREATE TABLE IF NOT EXISTS schedule_weeks (
  week_start TEXT NOT NULL, employee_id INTEGER NOT NULL, published_at INTEGER, published_by TEXT DEFAULT '',
  PRIMARY KEY (week_start, employee_id)
);
`);
  if (!db.prepare('PRAGMA table_info(shift_templates)').all().some((c) => c.name === 'applies')) db.exec("ALTER TABLE shift_templates ADD COLUMN applies TEXT DEFAULT 'all'"); // 正職班／工讀班／都可以
  // 預設班別（第一次啟動）：正職 早班 08–17、晚班 12–21；工讀 10–14、17–21
  if (!db.prepare('SELECT COUNT(*) c FROM shift_templates').get().c) {
    const ins = db.prepare('INSERT INTO shift_templates(name,start,end,break_min,color,applies,sort,created_at) VALUES(?,?,?,?,?,?,?,?)');
    [['早班', '08:00', '17:00', 'primary', 'full'], ['晚班', '12:00', '21:00', 'accent', 'full'], ['午班', '10:00', '14:00', 'sand', 'part'], ['晚間', '17:00', '21:00', 'accent-soft', 'part']]
      .forEach(([n, a, b, c, ap], i) => ins.run(n, a, b, 0, c, ap, i, Date.now()));
  }
  // 員工：排班中／不排班
  if (!db.prepare('PRAGMA table_info(employees)').all().some((c) => c.name === 'scheduling')) db.exec('ALTER TABLE employees ADD COLUMN scheduling INTEGER DEFAULT 1');

  const templates = (all) => db.prepare(`SELECT * FROM shift_templates ${all ? '' : 'WHERE active=1'} ORDER BY sort, id`).all()
    .map((t) => ({ ...t, applies: APPLIES[t.applies] ? t.applies : 'all', applies_text: APPLIES[t.applies] || APPLIES.all, active: !!t.active, hours: r2(shiftHours({ date: '2026-01-05', ...t })), overnight: mins(t.end) <= mins(t.start) }));
  const entryView = (x) => x && ({
    employee_id: x.employee_id, date: x.date, kind: x.kind, kind_text: KINDS[x.kind], template_id: x.template_id, name: x.name || '',
    start: x.start, end: x.end, break_min: x.break_min || 0, color: x.color || 'primary', note: x.note || '',
    ...(x.kind === 'shift' ? { hours: r2(shiftHours(x)), overnight: mins(x.end) <= mins(x.start) } : {}),
  });
  const loadEntries = (table, ids, from, to) => (ids.length ? db.prepare(`SELECT * FROM ${table} WHERE date>=? AND date<=? AND employee_id IN (${ids.map(() => '?').join(',')}) ORDER BY date`).all(from, to, ...ids) : []);

  // 已核准的請假（含居家／公差）展開成每日
  function leaveDays(ids, from, to) {
    if (!ids.length) return [];
    const rows = db.prepare(`SELECT * FROM leave_requests WHERE status='approved' AND end_ts>? AND start_ts<? AND employee_id IN (${ids.map(() => '?').join(',')})`)
      .all(L.toEpoch(from, '00:00'), L.toEpoch(L.addDays(to, 1), '00:00'), ...ids);
    const out = [];
    for (const l of rows) for (let d = L.dateOf(l.start_ts); d <= L.dateOf(l.end_ts - 1); d = L.addDays(d, 1)) {
      if (d < from || d > to) continue;
      const kind = l.kind || 'leave';
      if (kind === 'leave' && L.isOffDay(d)) continue;
      out.push({ employee_id: l.employee_id, date: d, kind, type_name: l.type_name, mode: l.mode, full: l.mode === 'full' || kind !== 'leave', leave_id: l.id });
    }
    return out;
  }

  // 勞基法提醒（不擋存檔）
  function warningsFor(ids, from, to) {
    const s = getSettings();
    const wFrom = L.addDays(from, -7), mFrom = `${from.slice(0, 7)}-01`;
    const lastMonthEnd = (() => { const [y, m] = to.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); })();
    const all = loadEntries('schedule_entries', ids, wFrom < mFrom ? wFrom : mFrom, lastMonthEnd > L.addDays(to, 1) ? lastMonthEnd : L.addDays(to, 1));
    const lv = leaveDays(ids, from, to);
    const offs = DAYOFF ? DAYOFF.offMap(ids, from, to) : new Map();
    const out = [];
    const push = (employee_id, date, type, text) => { if (date >= from && date <= to) out.push({ employee_id, date, type, text }); };
    for (const id of ids) {
      const mine = all.filter((x) => x.employee_id === id);
      const byDate = new Map(mine.map((x) => [x.date, x]));
      const shifts = mine.filter((x) => x.kind === 'shift').map((x) => ({ ...x, ...span(x.date, x.start, x.end), h: shiftHours(x) }));
      for (let i = 0; i < shifts.length; i++) {
        const x = shifts[i];
        if (x.h > DAILY_MAX_H) push(id, x.date, 'daily', `單日工時 ${r2(x.h)} 小時，超過 12 小時（含加班每日不得超過 12 小時，勞基法第 32 條）`);
        const prev = shifts[i - 1];
        if (prev && x.s - prev.e < REST_MIN_H * H) {
          const gap = r2((x.s - prev.e) / H);
          push(id, x.date, gap < 0 ? 'overlap' : 'rest', gap < 0 ? '班距：與前一班時間重疊' : `班距：與前一班只隔 ${gap} 小時，未滿 11 小時（勞基法第 34 條）`);
        }
        const hol = HOL.info(x.date);
        if (hol && hol.off && hol.kind !== 'custom') push(id, x.date, 'holiday', `${hol.name}（${hol.kind_text}）：出勤需經勞工同意，國定假日工資加倍發給`);
        const l = lv.find((d) => d.employee_id === id && d.date === x.date && d.kind === 'leave');
        if (l) push(id, x.date, 'leave', `當天已核准${l.type_name}${l.full ? '（全天）' : '（部分時段）'}`);
        const o = offs.get(`${id}|${x.date}`);
        if (o) push(id, x.date, 'dayoff', `不可排班：${o.text}`);
        if (isClosed(x.date)) push(id, x.date, 'closed', `${HOL.info(x.date).name}（公休）`);
      }
      // 連續上班天數（例假／休息日／沒有排班都會中斷）
      let streak = 0;
      for (let d = wFrom; d <= L.addDays(to, 0); d = L.addDays(d, 1)) {
        const x = byDate.get(d);
        if (x && x.kind === 'shift') { streak++; if (streak === MAX_STREAK + 1) push(id, d, 'streak', `七休一：連續上班第 ${streak} 天（勞基法第 36 條：每 7 日至少休 1 日例假）`); }
        else streak = 0;
      }
      // 每月加班估計：每日超過標準工時的部分＋休息日出勤（本系統以排班日判斷，例假／休息日不排班）
      const months = new Set(); for (let d = from; d <= to; d = L.addDays(d, 1)) months.add(d.slice(0, 7));
      for (const m of months) {
        const ot = shifts.filter((x) => x.date.startsWith(m)).reduce((a, x) => a + Math.max(0, x.h - s.standard_hours), 0);
        if (ot > MONTH_OT_MAX_H) {
          const first = shifts.find((x) => x.date.startsWith(m));
          const d0 = first && first.date >= from ? first.date : (from.startsWith(m) ? from : `${m}-01`);
          push(id, d0, 'month_ot', `${Number(m.slice(5))} 月預估加班 ${r2(ot)} 小時，超過每月 46 小時（勞基法第 32 條）`);
        }
      }
    }
    return out;
  }

  // 可存取的員工：管理員＝全部在職；主管＝自己的團隊
  const scopeIds = (req) => db.prepare('SELECT id FROM employees WHERE active=1 ORDER BY id').all().map((e) => e.id).filter((id) => inTeam(req, id));

  // ---------- 班別 ----------
  app.get('/api/admin/shift-templates', (req, res) => res.json({ templates: templates(req.role === 'owner'), colors: COLORS, applies: APPLIES, min_staff: minStaff() }));
  function parseTemplate(b) {
    const name = String(b.name || '').trim();
    if (!name || name.length > 10) return { error: '班別名稱請輸入 1～10 個字' };
    if (!isTime(b.start) || !isTime(b.end)) return { error: '請輸入上下班時間（例如 09:00）' };
    if (b.start === b.end) return { error: '上下班時間不能相同' };
    const br = Number(b.break_min || 0);
    if (!Number.isInteger(br) || br < 0 || br > 240) return { error: '休息時間請填 0～240 分鐘' };
    const color = COLORS.includes(b.color) ? b.color : 'primary';
    const applies = APPLIES[b.applies] ? b.applies : 'all';
    const h = shiftHours({ date: '2026-01-05', start: b.start, end: b.end, break_min: br });
    if (h <= 0) return { error: '扣掉休息後工時必須大於 0' };
    return { name, start: b.start, end: b.end, break_min: br, color, applies };
  }
  app.post('/api/admin/shift-templates', ownerOnly, (req, res) => {
    const v = parseTemplate(req.body || {}); if (v.error) return res.status(400).json({ error: v.error });
    const r = db.prepare('INSERT INTO shift_templates(name,start,end,break_min,color,applies,sort,created_at) VALUES(?,?,?,?,?,?,?,?)').run(v.name, v.start, v.end, v.break_min, v.color, v.applies, Date.now() % 1e6, Date.now());
    audit('新增班別', `${v.name} ${v.start}～${v.end}${mins(v.end) <= mins(v.start) ? '（跨夜）' : ''}｜${APPLIES[v.applies]}`);
    res.json({ ok: true, id: r.lastInsertRowid });
  });
  app.put('/api/admin/shift-templates/:id', ownerOnly, (req, res) => {
    const t = db.prepare('SELECT * FROM shift_templates WHERE id=?').get(Number(req.params.id));
    if (!t) return res.status(404).json({ error: '找不到班別' });
    const v = parseTemplate(req.body || {}); if (v.error) return res.status(400).json({ error: v.error });
    const active = req.body.active === undefined ? t.active : (req.body.active ? 1 : 0);
    db.prepare('UPDATE shift_templates SET name=?, start=?, end=?, break_min=?, color=?, applies=?, active=? WHERE id=?').run(v.name, v.start, v.end, v.break_min, v.color, v.applies, active, t.id);
    audit('修改班別', `${t.name}${t.name !== v.name ? `→${v.name}` : ''} ${v.start}～${v.end}，休息 ${v.break_min} 分${active ? '' : '（停用）'}；已排的班不受影響`);
    res.json({ ok: true });
  });

  // ---------- 班表 ----------
  app.get('/api/admin/schedule', (req, res) => {
    const from = isDate(req.query.from) ? req.query.from : weekStart(ctx.todayStr());
    const to = isDate(req.query.to) ? req.query.to : L.addDays(from, 6);
    if (to < from || (Date.parse(to) - Date.parse(from)) / 86400000 > 62) return res.status(400).json({ error: '日期範圍錯誤（最多 62 天）' });
    const all = scopeIds(req);
    const on = new Set(all.length ? db.prepare(`SELECT id FROM employees WHERE scheduling<>0 AND id IN (${all.join(',')})`).all().map((e) => e.id) : []);
    let ids = all.filter((id) => on.has(id)); // 「不排班」的員工不顯示在班表
    const hidden = all.filter((id) => !on.has(id));
    if (req.query.employee_id) { const one = Number(req.query.employee_id); if (!all.includes(one)) return res.status(403).json({ error: '這位員工不在您的團隊' }); ids = [one]; }
    const emps = ids.length ? db.prepare(`SELECT id, name, department, fixed_off, monthly_off, pay_type FROM employees WHERE id IN (${ids.join(',')}) ORDER BY department, id`).all() : [];
    const draft = loadEntries('schedule_entries', ids, from, to).map(entryView);
    const pub = loadEntries('schedule_published', ids, from, to).map(entryView);
    // 每週發布狀態：已發布人數、草稿與已發布不同的筆數
    const weeks = [];
    for (let w = weekStart(from); w <= to; w = L.addDays(w, 7)) {
      const we = L.addDays(w, 6);
      const pubIds = ids.length ? db.prepare(`SELECT employee_id, published_at, published_by FROM schedule_weeks WHERE week_start=? AND employee_id IN (${ids.join(',')})`).all(w) : [];
      const key = (x) => [x.employee_id, x.date, x.kind, x.start, x.end, x.break_min, x.name, x.note].join('|');
      const d = loadEntries('schedule_entries', ids, w, we).map(entryView), p = loadEntries('schedule_published', ids, w, we).map(entryView);
      const dm = new Map(d.map((x) => [`${x.employee_id}|${x.date}`, key(x)])), pm = new Map(p.map((x) => [`${x.employee_id}|${x.date}`, key(x)]));
      const changed = new Set([...dm.keys(), ...pm.keys()].filter((c) => dm.get(c) !== pm.get(c))).size; // 有變更的格數
      const last = pubIds.sort((a, b) => b.published_at - a.published_at)[0];
      weeks.push({ week_start: w, week_end: we, published_count: pubIds.length, employee_count: ids.length, changed, status: !pubIds.length ? 'draft' : changed ? 'changed' : 'published',
        published_text: last ? `${fmtDateTime(last.published_at)}・${last.published_by}` : '' });
    }
    const holidays = HOL.between(from, to).filter((h) => h.off || h.kind === 'swap_out' || h.kind === 'bridge')
      .map((h) => ({ date: h.date, name: h.name, kind: h.kind, kind_text: h.kind_text, off: !!h.off, paid_holiday: !!h.paid_holiday, weekend: !!h.weekend, change_id: h.change_id || null, adopted: !!h.adopted }));
    for (const e of emps) { e.fixed_off = DAYOFF ? DAYOFF.parseDays(e.fixed_off) : []; e.staff = e.pay_type === 'hourly' ? 'part' : 'full'; e.staff_text = e.staff === 'part' ? '工讀' : '正職'; delete e.pay_type; }
    const hiddenEmps = hidden.length ? db.prepare(`SELECT id, name, department FROM employees WHERE id IN (${hidden.join(',')}) ORDER BY id`).all() : [];
    res.json({ from, to, employees: emps, hidden_employees: hiddenEmps, entries: draft, dayoff: DAYOFF ? [...DAYOFF.offMap(ids, from, to).values()] : [], min_staff: minStaff(), published: pub, weeks, leaves: leaveDays(ids, from, to), holidays, warnings: warningsFor(ids, from, to),
      templates: templates(false), colors: COLORS, applies: APPLIES, can_edit_holidays: req.role === 'owner', standard_hours: getSettings().standard_hours });
  });

  // 存檔（單筆或批次）：items = [{ employee_id, date, kind: shift|rest|regular|clear, template_id? | start,end,break_min, note? }]
  app.put('/api/admin/schedule/entries', (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length || items.length > 2000) return res.status(400).json({ error: '沒有要儲存的班表' });
    const tpl = new Map(templates(true).map((t) => [t.id, t]));
    const rows = [];
    for (const it of items) {
      const empId = Number(it.employee_id);
      if (!isDate(it.date)) return res.status(400).json({ error: '日期格式錯誤' });
      if (!db.prepare('SELECT id FROM employees WHERE id=? AND active=1').get(empId)) return res.status(400).json({ error: '找不到員工' });
      if (!inTeam(req, empId)) return res.status(403).json({ error: '只能排自己團隊的班' });
      if (it.kind === 'clear') { rows.push({ employee_id: empId, date: it.date, clear: true }); continue; }
      if (!KINDS[it.kind]) return res.status(400).json({ error: '班表類型錯誤' });
      let r = { employee_id: empId, date: it.date, kind: it.kind, template_id: null, name: '', start: '', end: '', break_min: 0, color: '', note: String(it.note || '').trim().slice(0, 60) };
      if (it.kind === 'shift') {
        const t = it.template_id ? tpl.get(Number(it.template_id)) : null;
        if (it.template_id && !t) return res.status(400).json({ error: '找不到班別' });
        const start = t ? t.start : it.start, end = t ? t.end : it.end, br = t ? t.break_min : Number(it.break_min || 0);
        if (!isTime(start) || !isTime(end) || start === end) return res.status(400).json({ error: '請輸入正確的上下班時間' });
        if (!Number.isInteger(br) || br < 0 || br > 240) return res.status(400).json({ error: '休息時間請填 0～240 分鐘' });
        r = { ...r, template_id: t ? t.id : null, name: t ? t.name : '自訂', start, end, break_min: br, color: t ? t.color : (COLORS.includes(it.color) ? it.color : 'text-soft') };
      }
      rows.push(r);
    }
    const now = Date.now(), by = req.actorName || '管理員';
    const up = db.prepare(`INSERT INTO schedule_entries(employee_id,date,kind,template_id,name,start,end,break_min,color,note,updated_at,updated_by) VALUES(@employee_id,@date,@kind,@template_id,@name,@start,@end,@break_min,@color,@note,@updated_at,@updated_by)
      ON CONFLICT(employee_id,date) DO UPDATE SET kind=excluded.kind, template_id=excluded.template_id, name=excluded.name, start=excluded.start, end=excluded.end, break_min=excluded.break_min, color=excluded.color, note=excluded.note, updated_at=excluded.updated_at, updated_by=excluded.updated_by`);
    const del = db.prepare('DELETE FROM schedule_entries WHERE employee_id=? AND date=?');
    db.transaction(() => { for (const r of rows) (r.clear ? del.run(r.employee_id, r.date) : up.run({ ...r, updated_at: now, updated_by: by })); })();
    const names = new Map(db.prepare('SELECT id, name FROM employees').all().map((e) => [e.id, e.name]));
    const dates = rows.map((r) => r.date).sort();
    audit('修改班表', `${[...new Set(rows.map((r) => names.get(r.employee_id)))].join('、')}｜${dates[0]}${dates.length > 1 ? `～${dates[dates.length - 1]}` : ''}，共 ${rows.length} 筆（草稿）`);
    const ids = [...new Set(rows.map((r) => r.employee_id))];
    res.json({ ok: true, saved: rows.length, warnings: warningsFor(ids, dates[0], dates[dates.length - 1]) });
  });

  // 複製週班表：source_week（週一）→ target_weeks；可複製上週、或重複套用到之後幾週
  app.post('/api/admin/schedule/copy', (req, res) => {
    const b = req.body || {};
    if (!isDate(b.source_week) || weekStart(b.source_week) !== b.source_week) return res.status(400).json({ error: '來源週請選週一' });
    const targets = (Array.isArray(b.target_weeks) ? b.target_weeks : []).filter((w) => isDate(w) && weekStart(w) === w && w !== b.source_week);
    if (!targets.length || targets.length > 12) return res.status(400).json({ error: '請選擇 1～12 個目標週' });
    let ids = scopeIds(req);
    if (Array.isArray(b.employee_ids) && b.employee_ids.length) { const want = b.employee_ids.map(Number); if (want.some((x) => !ids.includes(x))) return res.status(403).json({ error: '只能複製自己團隊的班' }); ids = want; }
    const src = loadEntries('schedule_entries', ids, b.source_week, L.addDays(b.source_week, 6));
    const now = Date.now(), by = req.actorName || '管理員';
    let n = 0, skipped = 0, closed = 0;
    const has = db.prepare('SELECT 1 FROM schedule_entries WHERE employee_id=? AND date=?');
    const ins = db.prepare(`INSERT INTO schedule_entries(employee_id,date,kind,template_id,name,start,end,break_min,color,note,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(employee_id,date) DO UPDATE SET kind=excluded.kind, template_id=excluded.template_id, name=excluded.name, start=excluded.start, end=excluded.end, break_min=excluded.break_min, color=excluded.color, note=excluded.note, updated_at=excluded.updated_at, updated_by=excluded.updated_by`);
    db.transaction(() => {
      for (const w of targets) {
        const off = (Date.parse(w) - Date.parse(b.source_week)) / 86400000;
        for (const x of src) {
          const d = L.addDays(x.date, off);
          if (isClosed(d)) { closed++; continue; } // 公休日不複製
          if (!b.overwrite && has.get(x.employee_id, d)) { skipped++; continue; }
          ins.run(x.employee_id, d, x.kind, x.template_id, x.name, x.start, x.end, x.break_min, x.color, x.note, now, by); n++;
        }
      }
    })();
    audit('複製班表', `${b.source_week} 那週 → ${targets.join('、')}，複製 ${n} 筆${skipped ? `（已有班表略過 ${skipped} 筆）` : ''}（草稿）`);
    res.json({ ok: true, copied: n, skipped, closed, warnings: warningsFor(ids, targets[0], L.addDays(targets[targets.length - 1], 6)) });
  });

  // 排班設定：每日最少上班人數（空白＝不檢查）
  app.get('/api/admin/schedule/settings', (req, res) => res.json({ min_staff: minStaff() }));
  app.put('/api/admin/schedule/settings', ownerOnly, (req, res) => {
    const v = req.body?.min_staff;
    if (v === null || v === '' || v === undefined) setSetting('sched_min_staff', '');
    else { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 99) return res.status(400).json({ error: '每日最少人數請填 1～99（空白＝不檢查）' }); setSetting('sched_min_staff', String(n)); }
    audit('修改排班設定', `每日最少上班人數：${minStaff() ?? '不檢查'}`);
    res.json({ ok: true, min_staff: minStaff() });
  });
  // 重設：捨棄這週尚未發布（未傳送）的變更 → 回到上次發布的內容；從未發布的週則清空
  app.post('/api/admin/schedule/reset', (req, res) => {
    const w = req.body?.week_start;
    if (!isDate(w) || weekStart(w) !== w) return res.status(400).json({ error: '請選擇要重設的週（週一）' });
    const ids = scopeIds(req), we = L.addDays(w, 6);
    if (!ids.length) return res.status(400).json({ error: '沒有可重設的員工' });
    const list = ids.join(','), now = Date.now(), by = req.actorName || '管理員';
    const before = db.prepare(`SELECT COUNT(*) c FROM schedule_entries WHERE date>=? AND date<=? AND employee_id IN (${list})`).get(w, we).c;
    db.transaction(() => {
      db.prepare(`DELETE FROM schedule_entries WHERE date>=? AND date<=? AND employee_id IN (${list})`).run(w, we);
      db.prepare(`INSERT INTO schedule_entries(employee_id,date,kind,template_id,name,start,end,break_min,color,note,updated_at,updated_by)
        SELECT employee_id,date,kind,template_id,name,start,end,break_min,color,note,${now},? FROM schedule_published WHERE date>=? AND date<=? AND employee_id IN (${list})`).run(by, w, we);
    })();
    const after = db.prepare(`SELECT COUNT(*) c FROM schedule_entries WHERE date>=? AND date<=? AND employee_id IN (${list})`).get(w, we).c;
    audit('重設班表', `${w}～${we}｜${ids.length} 位員工，回到上次發布的內容（${before} → ${after} 格）`);
    res.json({ ok: true, entries: after });
  });

  // 發布／取消發布一週（只影響自己可管理的員工）
  app.post('/api/admin/schedule/publish', (req, res) => {
    const w = req.body?.week_start;
    if (!isDate(w) || weekStart(w) !== w) return res.status(400).json({ error: '請選擇要發布的週（週一）' });
    const ids = scopeIds(req), we = L.addDays(w, 6);
    if (!ids.length) return res.status(400).json({ error: '沒有可發布的員工' });
    const unpublish = !!req.body.unpublish, by = req.actorName || '管理員', now = Date.now();
    const list = ids.join(',');
    db.transaction(() => {
      db.prepare(`DELETE FROM schedule_published WHERE date>=? AND date<=? AND employee_id IN (${list})`).run(w, we);
      if (unpublish) db.prepare(`DELETE FROM schedule_weeks WHERE week_start=? AND employee_id IN (${list})`).run(w);
      else {
        db.prepare(`INSERT INTO schedule_published(employee_id,date,kind,template_id,name,start,end,break_min,color,note)
          SELECT employee_id,date,kind,template_id,name,start,end,break_min,color,note FROM schedule_entries WHERE date>=? AND date<=? AND employee_id IN (${list})`).run(w, we);
        const up = db.prepare('INSERT INTO schedule_weeks(week_start,employee_id,published_at,published_by) VALUES(?,?,?,?) ON CONFLICT(week_start,employee_id) DO UPDATE SET published_at=excluded.published_at, published_by=excluded.published_by');
        for (const id of ids) up.run(w, id, now, by);
      }
    })();
    const n = db.prepare(`SELECT COUNT(*) c FROM schedule_published WHERE date>=? AND date<=? AND employee_id IN (${list})`).get(w, we).c;
    audit(unpublish ? '取消發布班表' : '發布班表', `${w}～${we}｜${ids.length} 位員工${unpublish ? '' : `，${n} 筆`}`);
    res.json({ ok: true, published: unpublish ? 0 : n });
  });

  // ---------- 員工：我的班表（只看已發布） ----------
  app.get('/api/schedule', requireEmployee, (req, res) => {
    const from = isDate(req.query.from) ? req.query.from : ctx.todayStr();
    const to = isDate(req.query.to) ? req.query.to : L.addDays(from, 13);
    if (to < from || (Date.parse(to) - Date.parse(from)) / 86400000 > 62) return res.status(400).json({ error: '日期範圍錯誤' });
    const id = req.employee.id;
    const list = loadEntries('schedule_published', [id], from, to).map(entryView);
    const holidays = HOL.between(from, to).filter((h) => h.off).map((h) => ({ date: h.date, name: h.name, kind_text: h.kind_text }));
    res.json({ from, to, entries: list, leaves: leaveDays([id], from, to), holidays, published_weeks: db.prepare('SELECT week_start FROM schedule_weeks WHERE employee_id=? AND week_start>=? AND week_start<=?').all(id, weekStart(from), to).map((r) => r.week_start) });
  });

  // 打卡紀錄用：已發布的班表 map（employee|date → entry）
  function publishedMap(from, to) {
    const m = new Map();
    for (const x of db.prepare('SELECT * FROM schedule_published WHERE date>=? AND date<=?').all(from, to)) m.set(`${x.employee_id}|${x.date}`, entryView(x));
    return m;
  }
  return { publishedMap, span, weekStart, warningsFor };
};

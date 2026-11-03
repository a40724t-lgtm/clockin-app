// 不可排班：員工在「班表」月曆點選未來的日子（不可排班），以及每週固定休假日（日～六）
// 管理員／主管可在員工清單或排班表調整員工的固定休假日（主管只限自己團隊）；排班時遇到這些日子仍可排，但會提醒
const L = require('./leave');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const parseDays = (v) => [...new Set(String(v || '').split(',').filter((x) => /^[0-6]$/.test(x)).map(Number))].sort();
const weekdayOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();

module.exports = function registerDayoff(ctx) {
  const { app, db, audit, inTeam, requireEmployee, todayStr } = ctx;
  // 舊版「可上班時段登記」已移除
  db.exec(`
DROP TABLE IF EXISTS avail_entries; DROP TABLE IF EXISTS avail_submissions; DROP TABLE IF EXISTS avail_periods;
CREATE TABLE IF NOT EXISTS dayoff_dates (employee_id INTEGER NOT NULL, date TEXT NOT NULL, created_at INTEGER, PRIMARY KEY (employee_id, date));
`);
  const cols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
  if (!cols.includes('fixed_off')) db.exec("ALTER TABLE employees ADD COLUMN fixed_off TEXT DEFAULT ''"); // 例如 "0,6"＝週日、週六
  if (!cols.includes('monthly_off')) db.exec('ALTER TABLE employees ADD COLUMN monthly_off INTEGER'); // 每月休假天數目標（月薪人員用，空白＝不檢查）

  const fixedOf = (id) => parseDays((db.prepare('SELECT fixed_off FROM employees WHERE id=?').get(id) || {}).fixed_off);
  const cleanDays = (v) => (Array.isArray(v) ? [...new Set(v.map(Number))].filter((x) => Number.isInteger(x) && x >= 0 && x <= 6).sort() : null);
  function setFixed(id, days) { db.prepare('UPDATE employees SET fixed_off=? WHERE id=?').run(days.join(','), id); }
  const daysText = (d) => (d.length ? d.map((x) => `週${WD[x]}`).join('、') : '無');

  // ---------- 員工 ----------
  app.get('/api/dayoff', requireEmployee, (req, res) => {
    const today = todayStr();
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
    const from = `${month}-01`, to = L.addDays(`${L.addDays(from, 40).slice(0, 7)}-01`, -1);
    const dates = db.prepare('SELECT date FROM dayoff_dates WHERE employee_id=? AND date>=? AND date<=? ORDER BY date').all(req.employee.id, from, to).map((r) => r.date);
    res.json({ month, from, to, today, dates, fixed: fixedOf(req.employee.id), max_date: L.addDays(today, 186) });
  });
  app.put('/api/dayoff/fixed', requireEmployee, (req, res) => {
    const days = cleanDays(req.body?.days); if (!days) return res.status(400).json({ error: '請選擇星期' });
    if (days.length > 6) return res.status(400).json({ error: '至少要留一天可以排班' });
    setFixed(req.employee.id, days);
    res.json({ ok: true, fixed: days });
  });
  app.put('/api/dayoff/:date', requireEmployee, (req, res) => {
    const d = req.params.date, today = todayStr();
    if (!isDate(d)) return res.status(400).json({ error: '日期格式錯誤' });
    if (d <= today) return res.status(400).json({ error: '只能設定明天以後的日子' });
    if (d > L.addDays(today, 186)) return res.status(400).json({ error: '最多只能設定半年內的日子' });
    if (req.body?.off) db.prepare('INSERT OR IGNORE INTO dayoff_dates(employee_id,date,created_at) VALUES(?,?,?)').run(req.employee.id, d, Date.now());
    else db.prepare('DELETE FROM dayoff_dates WHERE employee_id=? AND date=?').run(req.employee.id, d);
    res.json({ ok: true, date: d, off: !!req.body?.off });
  });

  // ---------- 管理員／主管（代填）：固定休假日、每月休假天數、不可排班日 ----------
  const teamEmp = (req, res) => {
    const id = Number(req.params.id);
    const emp = db.prepare('SELECT id, name FROM employees WHERE id=? AND active=1').get(id);
    if (!emp) { res.status(404).json({ error: '找不到員工' }); return null; }
    if (!inTeam(req, id)) { res.status(403).json({ error: '這位員工不在您的團隊' }); return null; }
    return emp;
  };
  app.put('/api/admin/employees/:id/schedule-prefs', (req, res) => {
    const emp = teamEmp(req, res); if (!emp) return;
    const b = req.body || {}, parts = [];
    if (b.fixed_off !== undefined) {
      const days = cleanDays(b.fixed_off); if (!days) return res.status(400).json({ error: '請選擇星期' });
      if (days.length > 6) return res.status(400).json({ error: '至少要留一天可以排班' });
      setFixed(emp.id, days); parts.push(`固定休假日 ${daysText(days)}`);
    }
    if (b.monthly_off !== undefined) {
      const v = b.monthly_off === null || b.monthly_off === '' ? null : Number(b.monthly_off);
      if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 31)) return res.status(400).json({ error: '每月休假天數請填 0～31（空白＝不檢查）' });
      db.prepare('UPDATE employees SET monthly_off=? WHERE id=?').run(v, emp.id); parts.push(`每月休假 ${v === null ? '不檢查' : `${v} 天`}`);
    }
    if (b.scheduling !== undefined) {
      db.prepare('UPDATE employees SET scheduling=? WHERE id=?').run(b.scheduling ? 1 : 0, emp.id); parts.push(b.scheduling ? '排班中' : '不排班');
    }
    if (!parts.length) return res.status(400).json({ error: '沒有要更新的設定' });
    audit('修改排班設定', `${emp.name}：${parts.join('；')}`);
    const r = db.prepare('SELECT fixed_off, monthly_off, scheduling FROM employees WHERE id=?').get(emp.id);
    res.json({ ok: true, fixed_off: parseDays(r.fixed_off), monthly_off: r.monthly_off, scheduling: r.scheduling !== 0 });
  });
  app.put('/api/admin/employees/:id/dayoff/:date', (req, res) => {
    const emp = teamEmp(req, res); if (!emp) return;
    const d = req.params.date;
    if (!isDate(d)) return res.status(400).json({ error: '日期格式錯誤' });
    if (req.body?.off) db.prepare('INSERT OR IGNORE INTO dayoff_dates(employee_id,date,created_at) VALUES(?,?,?)').run(emp.id, d, Date.now());
    else db.prepare('DELETE FROM dayoff_dates WHERE employee_id=? AND date=?').run(emp.id, d);
    audit('代填不可排班', `${emp.name} ${d} ${req.body?.off ? '設為不可排班' : '取消不可排班'}`);
    res.json({ ok: true, date: d, off: !!req.body?.off });
  });

  // ---------- 給排班用：employee|date → { kind: 'fixed'|'date', text } ----------
  function offMap(ids, from, to) {
    const m = new Map(); if (!ids.length) return m;
    const fx = new Map(db.prepare(`SELECT id, fixed_off FROM employees WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((e) => [e.id, parseDays(e.fixed_off)]));
    for (let d = from; d <= to; d = L.addDays(d, 1)) for (const id of ids) if ((fx.get(id) || []).includes(weekdayOf(d))) m.set(`${id}|${d}`, { employee_id: id, date: d, kind: 'fixed', text: `固定休假日（週${WD[weekdayOf(d)]}）` });
    for (const r of db.prepare(`SELECT employee_id, date FROM dayoff_dates WHERE date>=? AND date<=? AND employee_id IN (${ids.map(() => '?').join(',')})`).all(from, to, ...ids)) m.set(`${r.employee_id}|${r.date}`, { employee_id: r.employee_id, date: r.date, kind: 'date', text: '員工設定不可排班' });
    return m;
  }
  return { offMap, fixedOf, parseDays };
};

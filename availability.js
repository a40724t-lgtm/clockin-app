// 員工填可上班時段：管理員／主管開放登記期間（日期範圍＋截止時間），員工逐日填「可上班／想上某班別／不行」＋備註，
// 截止前可修改；排班畫面顯示每格的可上班狀態、排在「不行」的日子會提醒，並列出尚未提交的人
const L = require('./leave');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
const STATUS = { ok: '可上班', pref: '想上', no: '不行' };
const days = (from, to) => { const out = []; for (let d = from; d <= to; d = L.addDays(d, 1)) out.push(d); return out; };

module.exports = function registerAvailability(ctx) {
  const { app, db, audit, HOL, inTeam, requireEmployee, fmtDateTime, todayStr } = ctx;
  db.exec(`
CREATE TABLE IF NOT EXISTS avail_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT, from_date TEXT NOT NULL, to_date TEXT NOT NULL, deadline_ts INTEGER NOT NULL,
  note TEXT DEFAULT '', employee_ids TEXT NOT NULL, created_by TEXT DEFAULT '', created_at INTEGER, closed INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS avail_entries (
  period_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL,
  template_id INTEGER, note TEXT DEFAULT '', updated_at INTEGER, PRIMARY KEY (period_id, employee_id, date)
);
CREATE TABLE IF NOT EXISTS avail_submissions (
  period_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, submitted_at INTEGER NOT NULL, PRIMARY KEY (period_id, employee_id)
);
`);
  const empIds = (p) => JSON.parse(p.employee_ids || '[]').map(Number);
  const isOpen = (p) => !p.closed && Date.now() < p.deadline_ts;
  const tplMap = () => new Map(db.prepare('SELECT id, name, start, end, color, active FROM shift_templates').all().map((t) => [t.id, t]));
  const names = () => new Map(db.prepare('SELECT id, name FROM employees').all().map((e) => [e.id, e.name]));
  // 主管只能管理「對象全部在自己團隊」的期間；看得到「對象與團隊有交集」的期間（只看自己團隊的人）
  const canManage = (req, p) => empIds(p).every((id) => inTeam(req, id));
  const canSee = (req, p) => empIds(p).some((id) => inTeam(req, id));

  function periodView(p, req) {
    const ids = empIds(p).filter((id) => !req || inTeam(req, id));
    const active = new Set(db.prepare('SELECT id FROM employees WHERE active=1').all().map((e) => e.id));
    const live = ids.filter((id) => active.has(id));
    const subs = new Map(db.prepare('SELECT employee_id, submitted_at FROM avail_submissions WHERE period_id=?').all(p.id).map((s) => [s.employee_id, s.submitted_at]));
    const nm = names();
    return {
      id: p.id, from: p.from_date, to: p.to_date, deadline_ts: p.deadline_ts, deadline_text: fmtDateTime(p.deadline_ts), note: p.note || '',
      open: isOpen(p), closed: !!p.closed, created_by: p.created_by, created_text: fmtDateTime(p.created_at),
      employee_count: live.length, submitted_count: live.filter((id) => subs.has(id)).length,
      submitted: live.filter((id) => subs.has(id)).map((id) => ({ id, name: nm.get(id), at: fmtDateTime(subs.get(id)) })),
      missing: live.filter((id) => !subs.has(id)).map((id) => ({ id, name: nm.get(id) })),
      can_manage: req ? canManage(req, p) : true,
    };
  }
  function parsePeriod(b, req, cur) {
    const from = cur ? cur.from_date : b.from, to = cur ? cur.to_date : b.to;
    if (!cur) {
      if (!isDate(from) || !isDate(to) || to < from) return { error: '請選擇正確的日期範圍' };
      if ((Date.parse(to) - Date.parse(from)) / 86400000 > 62) return { error: '一次最多開放 63 天' };
      if (to < todayStr()) return { error: '日期範圍已經過去了' };
    }
    if (!isDate(b.deadline_date) || !isTime(b.deadline_time || '')) return { error: '請設定截止日期與時間' };
    const deadline = L.toEpoch(b.deadline_date, b.deadline_time);
    if (deadline > L.toEpoch(L.addDays(to, 1), '00:00')) return { error: '截止時間不能晚於登記期間的最後一天' };
    if (!cur && deadline <= Date.now()) return { error: '截止時間必須在現在之後' };
    const note = String(b.note || '').trim().slice(0, 100);
    if (cur) return { deadline, note };
    // 對象：管理員可選部門（預設全部在職員工）；主管只能選自己團隊
    const all = db.prepare('SELECT id, department FROM employees WHERE active=1 ORDER BY id').all();
    let ids;
    if (Array.isArray(b.employee_ids) && b.employee_ids.length) ids = b.employee_ids.map(Number);
    else if (Array.isArray(b.departments) && b.departments.length) ids = all.filter((e) => b.departments.includes(e.department)).map((e) => e.id);
    else ids = all.map((e) => e.id).filter((id) => inTeam(req, id));
    ids = [...new Set(ids)];
    if (!ids.length) return { error: '沒有符合的員工' };
    if (ids.some((id) => !all.some((e) => e.id === id))) return { error: '找不到員工' };
    if (ids.some((id) => !inTeam(req, id))) return { status: 403, error: '只能為自己團隊的員工開放登記' };
    // 同一位員工同一天只能在一個登記期間
    const clash = db.prepare('SELECT * FROM avail_periods WHERE from_date<=? AND to_date>=?').all(to, from).find((p) => empIds(p).some((id) => ids.includes(id)));
    if (clash) return { status: 409, error: `與已開放的登記期間（${clash.from_date}～${clash.to_date}）重疊，請先刪除或調整日期` };
    return { from, to, deadline, note, ids };
  }

  // ---------- 管理員／主管 ----------
  app.get('/api/admin/avail-periods', (req, res) => {
    const list = db.prepare('SELECT * FROM avail_periods ORDER BY from_date DESC, id DESC LIMIT 50').all().filter((p) => canSee(req, p)).map((p) => periodView(p, req));
    res.json({ periods: list, departments: [...new Set(db.prepare("SELECT department FROM employees WHERE active=1 AND department<>''").all().map((e) => e.department).filter((d) => req.role === 'owner' || db.prepare('SELECT id FROM employees WHERE active=1 AND department=?').all(d).some((e) => inTeam(req, e.id))))].sort() });
  });
  app.post('/api/admin/avail-periods', (req, res) => {
    const v = parsePeriod(req.body || {}, req);
    if (v.error) return res.status(v.status || 400).json({ error: v.error });
    const r = db.prepare('INSERT INTO avail_periods(from_date,to_date,deadline_ts,note,employee_ids,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(v.from, v.to, v.deadline, v.note, JSON.stringify(v.ids), req.actorName || '管理員', Date.now());
    audit('開放可上班時段登記', `${v.from}～${v.to}｜${v.ids.length} 位員工｜截止 ${fmtDateTime(v.deadline)}`);
    res.json({ ok: true, id: r.lastInsertRowid });
  });
  const load = (req, res) => {
    const p = db.prepare('SELECT * FROM avail_periods WHERE id=?').get(Number(req.params.id));
    if (!p || !canSee(req, p)) { res.status(404).json({ error: '找不到這個登記期間' }); return null; }
    if (!canManage(req, p)) { res.status(403).json({ error: '這個登記期間包含其他團隊的員工，請洽管理員' }); return null; }
    return p;
  };
  app.put('/api/admin/avail-periods/:id', (req, res) => {
    const p = load(req, res); if (!p) return;
    const b = req.body || {};
    if (b.closed !== undefined && Object.keys(b).length === 1) {
      db.prepare('UPDATE avail_periods SET closed=? WHERE id=?').run(b.closed ? 1 : 0, p.id);
      audit(b.closed ? '提前結束可上班時段登記' : '重新開放可上班時段登記', `${p.from_date}～${p.to_date}`);
      return res.json({ ok: true });
    }
    const v = parsePeriod(b, req, p); if (v.error) return res.status(400).json({ error: v.error });
    db.prepare('UPDATE avail_periods SET deadline_ts=?, note=?, closed=0 WHERE id=?').run(v.deadline, v.note, p.id);
    audit('修改可上班時段登記', `${p.from_date}～${p.to_date}｜截止 ${fmtDateTime(v.deadline)}`);
    res.json({ ok: true });
  });
  app.delete('/api/admin/avail-periods/:id', (req, res) => {
    const p = load(req, res); if (!p) return;
    db.transaction(() => {
      db.prepare('DELETE FROM avail_entries WHERE period_id=?').run(p.id);
      db.prepare('DELETE FROM avail_submissions WHERE period_id=?').run(p.id);
      db.prepare('DELETE FROM avail_periods WHERE id=?').run(p.id);
    })();
    audit('刪除可上班時段登記', `${p.from_date}～${p.to_date}（含員工填寫內容）`);
    res.json({ ok: true });
  });

  // ---------- 員工 ----------
  const mine = (empId) => db.prepare('SELECT * FROM avail_periods WHERE to_date>=? ORDER BY from_date').all(L.addDays(todayStr(), -7)).filter((p) => empIds(p).includes(empId));
  app.get('/api/availability', requireEmployee, (req, res) => {
    const id = req.employee.id, tm = tplMap();
    const periods = mine(id).map((p) => {
      const ent = new Map(db.prepare('SELECT * FROM avail_entries WHERE period_id=? AND employee_id=?').all(p.id, id).map((x) => [x.date, x]));
      const sub = db.prepare('SELECT submitted_at FROM avail_submissions WHERE period_id=? AND employee_id=?').get(p.id, id);
      return {
        id: p.id, from: p.from_date, to: p.to_date, deadline_text: fmtDateTime(p.deadline_ts), deadline_ts: p.deadline_ts, note: p.note || '', open: isOpen(p), closed: !!p.closed,
        submitted_at: sub ? fmtDateTime(sub.submitted_at) : '',
        days: days(p.from_date, p.to_date).map((d) => {
          const x = ent.get(d), h = HOL.info(d);
          return { date: d, status: x ? x.status : '', template_id: x ? x.template_id : null, template_name: x && x.template_id && tm.get(x.template_id) ? tm.get(x.template_id).name : '', note: x ? x.note : '', holiday: h && h.off ? h.name : '' };
        }),
      };
    });
    const templates = [...tplMap().values()].filter((t) => t.active).map((t) => ({ id: t.id, name: t.name, start: t.start, end: t.end, color: t.color }));
    res.json({ periods, templates, pending: periods.filter((p) => p.open && !p.submitted_at).length });
  });
  app.put('/api/availability/:id', requireEmployee, (req, res) => {
    const id = req.employee.id;
    const p = db.prepare('SELECT * FROM avail_periods WHERE id=?').get(Number(req.params.id));
    if (!p || !empIds(p).includes(id)) return res.status(404).json({ error: '找不到這個登記期間' });
    if (!isOpen(p)) return res.status(409).json({ error: '已超過截止時間，無法修改；如需調整請洽主管' });
    const list = Array.isArray(req.body?.days) ? req.body.days : [];
    const valid = new Set(days(p.from_date, p.to_date)), tm = tplMap(), rows = [];
    for (const x of list) {
      if (!valid.has(x.date)) return res.status(400).json({ error: '日期不在登記期間內' });
      if (!x.status) continue; // 未填
      if (!STATUS[x.status]) return res.status(400).json({ error: '請選擇可上班、指定班別或不行' });
      let tid = null;
      if (x.status === 'pref') { tid = Number(x.template_id); const t = tm.get(tid); if (!t || !t.active) return res.status(400).json({ error: '請選擇想上的班別' }); }
      rows.push({ date: x.date, status: x.status, template_id: tid, note: String(x.note || '').trim().slice(0, 60) });
    }
    if (rows.length < valid.size) return res.status(400).json({ error: `還有 ${valid.size - rows.length} 天沒有填寫` });
    const now = Date.now();
    db.transaction(() => {
      db.prepare('DELETE FROM avail_entries WHERE period_id=? AND employee_id=?').run(p.id, id);
      const ins = db.prepare('INSERT INTO avail_entries(period_id,employee_id,date,status,template_id,note,updated_at) VALUES(?,?,?,?,?,?,?)');
      for (const r of rows) ins.run(p.id, id, r.date, r.status, r.template_id, r.note, now);
      db.prepare('INSERT INTO avail_submissions(period_id,employee_id,submitted_at) VALUES(?,?,?) ON CONFLICT(period_id,employee_id) DO UPDATE SET submitted_at=excluded.submitted_at').run(p.id, id, now);
    })();
    res.json({ ok: true, submitted_at: fmtDateTime(now), no_days: rows.filter((r) => r.status === 'no').length });
  });

  // ---------- 給排班用 ----------
  // employee|date → { status, status_text, template_id, template_name, note }
  function availMap(ids, from, to) {
    const m = new Map(); if (!ids.length) return m;
    const tm = tplMap();
    for (const x of db.prepare(`SELECT e.* FROM avail_entries e JOIN avail_periods p ON p.id=e.period_id WHERE e.date>=? AND e.date<=? AND e.employee_id IN (${ids.map(() => '?').join(',')}) ORDER BY p.id`).all(from, to, ...ids)) {
      const t = x.template_id ? tm.get(x.template_id) : null;
      m.set(`${x.employee_id}|${x.date}`, { employee_id: x.employee_id, date: x.date, status: x.status, status_text: x.status === 'pref' && t ? `想上${t.name}` : STATUS[x.status], template_id: x.template_id, template_name: t ? t.name : '', note: x.note || '' });
    }
    return m;
  }
  // 與日期範圍重疊的登記期間（只含 req 可見的員工）
  const periodsBetween = (req, from, to) => db.prepare('SELECT * FROM avail_periods WHERE from_date<=? AND to_date>=? ORDER BY from_date').all(to, from).filter((p) => canSee(req, p)).map((p) => periodView(p, req));
  return { availMap, periodsBetween };
};

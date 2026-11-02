// 員工上下班打卡系統 — 伺服器
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const ExcelJS = require('exceljs');
const checks = require('./checks');
const L = require('./leave');
const fs = require('fs');
const { DATA_DIR, db, getSetting, setSetting, hashPassword, verifyPassword, taipeiToEpoch, taipeiDateStr, TZ_OFFSET } = require('./db');

const app = express();

// ---------- 反向代理設定（決定如何從 X-Forwarded-For 取得真實 IP） ----------
// TRUST_PROXY 可設為：數字（代理層數，例如 1）、true、或 IP/網段清單（例如 loopback）
// 未設定時：在 Render / Railway 上預設信任 1 層代理；本機預設只信任 127.0.0.1（本機反向代理）
function trustProxySetting() {
  const v = process.env.TRUST_PROXY;
  if (v !== undefined && v !== '') {
    if (/^\d+$/.test(v)) return Number(v);
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }
  if (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) return 1;
  return 'loopback';
}
app.set('trust proxy', trustProxySetting());
const clientIp = (req) => checks.normalizeIp(req.ip || req.socket.remoteAddress);

app.use(express.json({ limit: '8mb' })); // 請假附件以 base64 上傳（上限 5MB）
app.use(express.static(path.join(__dirname, 'public')));

const DAY = 24 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (ts) => { const d = new Date(ts + TZ_OFFSET); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const fmtDateTime = (ts) => `${taipeiDateStr(ts)} ${fmtTime(ts)}`;
const todayStr = () => taipeiDateStr(Date.now());
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const weekday = (dateStr) => WEEK[new Date(dateStr + 'T00:00:00Z').getUTCDay()];
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return `${Math.floor(m / 60)} 小時 ${m % 60} 分`; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');

function audit(action, detail) {
  db.prepare('INSERT INTO audit_log(at,action,detail) VALUES(?,?,?)').run(Date.now(), action, detail);
}

// ---------- Session ----------
function createSession(kind, employeeId, ttlMs) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions(token,kind,employee_id,expires_at) VALUES(?,?,?,?)').run(token, kind, employeeId ?? null, Date.now() + ttlMs);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return token;
}
function getSession(token, kind) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=? AND kind=?').get(token, kind);
  if (!s || s.expires_at < Date.now()) return null;
  return s;
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
function cookie(req, name) {
  const c = req.headers.cookie || '';
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function requireEmployee(req, res, next) {
  const s = getSession(bearer(req), 'employee');
  if (!s) return res.status(401).json({ error: '請重新登入' });
  const emp = db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(s.employee_id);
  if (!emp) return res.status(401).json({ error: '帳號已停用，請洽管理員' });
  req.employee = emp;
  next();
}
function requireAdmin(req, res, next) {
  const s = getSession(cookie(req, 'admin_token') || bearer(req), 'admin');
  if (!s) return res.status(401).json({ error: '請先登入管理後台' });
  next();
}

// 簡易防暴力破解：同一 IP + 對象 連續失敗 5 次鎖 5 分鐘
const failures = new Map();
function checkLock(key) {
  const f = failures.get(key);
  return f && f.count >= 5 && Date.now() - f.last < 5 * 60000;
}
function addFail(key) {
  const f = failures.get(key) || { count: 0, last: 0 };
  if (Date.now() - f.last > 5 * 60000) f.count = 0;
  f.count++; f.last = Date.now(); failures.set(key, f);
}

// ---------- 工時計算 ----------
function getSettings() {
  return {
    work_start: getSetting('work_start'),
    standard_hours: Number(getSetting('standard_hours')),
    late_grace_min: Number(getSetting('late_grace_min')),
    company_name: getSetting('company_name'),
    lunch_enabled: getSetting('lunch_enabled') === '1',
    lunch_start: getSetting('lunch_start'),
    lunch_end: getSetting('lunch_end'),
  };
}

// 打卡地點限制設定與狀態
function getCheckSettings() {
  const lat = getSetting('loc_lat'), lng = getSetting('loc_lng');
  const allow = getSetting('net_allowlist') || '';
  const parsed = checks.parseAllowlist(allow);
  const c = {
    net_check_enabled: getSetting('net_check_enabled') === '1',
    net_allowlist: allow,
    net_configured: parsed.entries.length > 0,
    loc_check_enabled: getSetting('loc_check_enabled') === '1',
    loc_lat: lat === '' ? null : Number(lat),
    loc_lng: lng === '' ? null : Number(lng),
    loc_radius: Number(getSetting('loc_radius')) || 150,
    loc_max_accuracy: Number(getSetting('loc_max_accuracy')) || 100,
  };
  c.loc_configured = Number.isFinite(c.loc_lat) && Number.isFinite(c.loc_lng) && lat !== '' && lng !== '';
  // 只有「已開啟且已設定」才會實際檢查，避免尚未設定就把所有人鎖在外面
  c.net_enforced = c.net_check_enabled && c.net_configured;
  c.loc_enforced = c.loc_check_enabled && c.loc_configured;
  c.warnings = [];
  if (c.net_check_enabled && !c.net_configured) c.warnings.push('已開啟「公司網路檢查」，但尚未設定允許的 IP，目前不會檢查。');
  if (c.loc_check_enabled && !c.loc_configured) c.warnings.push('已開啟「公司位置檢查」，但尚未設定公司座標，目前不會檢查。');
  return c;
}

const LOC_ERRORS = {
  denied: '您拒絕了定位權限。請到手機的「設定 → 隱私權 → 定位服務」或瀏覽器網站設定中，允許此網站使用位置，再重新整理頁面。',
  unavailable: '無法取得您的位置，請確認手機已開啟定位服務（GPS）後再試一次。',
  timeout: '定位逾時，請移動到窗邊或訊號較好的地方，再試一次。',
  insecure: '定位功能需要 HTTPS 安全連線，請使用 https:// 開頭的網址開啟打卡頁，或洽管理員。',
  unsupported: '此瀏覽器不支援定位功能，請改用 Chrome 或 Safari。',
};

// 伺服器端驗證打卡條件；回傳要寫入資料庫的欄位與拒絕原因
function evaluatePunch(req, body) {
  const c = getCheckSettings();
  const ip = clientIp(req);
  const r = { ip, lat: null, lng: null, accuracy: null, distance_m: null, ip_ok: null, loc_ok: null, reasons: [], notes: [] };
  if (c.net_enforced) {
    r.ip_ok = checks.ipAllowed(ip, c.net_allowlist) ? 1 : 0;
    if (!r.ip_ok) r.reasons.push(`請連上公司 WiFi 後再打卡（目前連線 IP：${ip}）`);
  } else r.notes.push('未檢查網路');
  const loc = body.location;
  if (loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))) {
    r.lat = Number(loc.lat); r.lng = Number(loc.lng);
    r.accuracy = Number.isFinite(Number(loc.accuracy)) ? Math.round(Number(loc.accuracy)) : null;
    if (c.loc_configured) r.distance_m = Math.round(checks.haversine(c.loc_lat, c.loc_lng, r.lat, r.lng));
  }
  if (c.loc_enforced) {
    if (r.lat === null) {
      r.loc_ok = 0;
      r.reasons.push(LOC_ERRORS[body.loc_error] || '無法取得您的位置，請允許定位後再試一次。');
    } else if (Math.abs(r.lat) > 90 || Math.abs(r.lng) > 180) {
      r.loc_ok = 0; r.reasons.push('位置資料不正確，請重新整理後再試。');
    } else if (r.accuracy === null || r.accuracy > c.loc_max_accuracy) {
      r.loc_ok = 0;
      r.reasons.push(`定位不夠精確（誤差約 ${r.accuracy ?? '?'} 公尺，需在 ${c.loc_max_accuracy} 公尺內）。請開啟 GPS／Wi-Fi 定位，移動到窗邊後再試一次。`);
    } else if (r.distance_m > c.loc_radius) {
      r.loc_ok = 0;
      r.reasons.push(`您目前距離公司約 ${checks.fmtDist(r.distance_m)}，需在 ${c.loc_radius} 公尺內才能打卡。`);
    } else r.loc_ok = 1;
  } else r.notes.push('未檢查位置');
  return r;
}

function loadPunches(from, to, employeeId) {
  const start = taipeiToEpoch(from, '00:00');
  const end = taipeiToEpoch(to, '00:00') + DAY;
  let sql = `SELECT p.*, e.name FROM punches p JOIN employees e ON e.id=p.employee_id WHERE p.ts>=? AND p.ts<?`;
  const args = [start, end];
  if (employeeId) { sql += ' AND p.employee_id=?'; args.push(Number(employeeId)); }
  sql += ' ORDER BY p.ts ASC, p.id ASC';
  return db.prepare(sql).all(...args);
}

// 已核准（或指定狀態）且與日期區間重疊的請假
function loadLeaves(from, to, employeeId, statuses = ['approved']) {
  let sql = `SELECT l.*, e.name FROM leave_requests l JOIN employees e ON e.id=l.employee_id WHERE l.end_ts>? AND l.start_ts<? AND l.status IN (${statuses.map(() => '?').join(',')})`;
  const args = [taipeiToEpoch(from, '00:00'), taipeiToEpoch(to, '00:00') + DAY, ...statuses];
  if (employeeId) { sql += ' AND l.employee_id=?'; args.push(Number(employeeId)); }
  return db.prepare(sql + ' ORDER BY l.start_ts').all(...args);
}
// 把請假拆成「員工＋日期」的時段
function leaveDayMap(leaves, settings, range) {
  const map = new Map();
  for (const l of leaves || []) {
    for (const d of L.calcLeave(l.start_ts, l.end_ts, settings).days) {
      if (range && (d.date < range.from || d.date > range.to)) continue;
      const key = `${l.employee_id}|${d.date}`;
      if (!map.has(key)) map.set(key, { employee_id: l.employee_id, name: l.name, date: d.date, hours: 0, items: [] });
      const m = map.get(key);
      m.hours = +(m.hours + d.hours).toFixed(2);
      m.items.push({ id: l.id, type_name: l.type_name, from: d.from, to: d.to, full: d.full, hours: d.hours, start_ts: d.start_ts, end_ts: d.end_ts,
        text: `${l.type_name} ${d.full ? '全天' : l.mode === 'am' ? '上午' : l.mode === 'pm' ? '下午' : `${d.from}～${d.to}`}` });
    }
  }
  return map;
}

function computeDaily(punches, settings, leaves, range) {
  const leaveMap = leaveDayMap(leaves, settings, range);
  const groups = new Map();
  for (const p of punches) {
    const date = taipeiDateStr(p.ts);
    const key = `${p.employee_id}|${date}`;
    if (!groups.has(key)) groups.set(key, { employee_id: p.employee_id, name: p.name, date, punches: [] });
    groups.get(key).punches.push(p);
  }
  const rows = [];
  for (const g of groups.values()) {
    // 午休時段：與上班區間重疊的部分不計入工時
    const lunchS = settings.lunch_enabled ? taipeiToEpoch(g.date, settings.lunch_start) : 0;
    const lunchE = settings.lunch_enabled ? taipeiToEpoch(g.date, settings.lunch_end) : 0;
    const segment = (a, b) => Math.max(0, b - a) - (settings.lunch_enabled ? Math.max(0, Math.min(b, lunchE) - Math.max(a, lunchS)) : 0);
    let worked = 0, openIn = null, firstIn = null, lastOut = null, issues = [], edited = false;
    for (const p of g.punches) {
      if (p.edited || p.source === 'admin') edited = true;
      if (p.type === 'in') {
        if (firstIn === null) firstIn = p.ts;
        if (openIn !== null) issues.push('重複上班打卡');
        else openIn = p.ts;
      } else {
        lastOut = p.ts;
        if (openIn === null) issues.push('缺上班打卡');
        else { worked += segment(openIn, p.ts); openIn = null; }
      }
    }
    const missingOut = openIn !== null;
    // 今天仍在上班中：工時計算到目前為止
    if (missingOut && g.date === todayStr()) worked += segment(openIn, Math.max(openIn, Date.now()));
    if (missingOut && g.date !== todayStr()) issues.push('未打下班卡');
    let late = false, lateMin = 0;
    const lv = leaveMap.get(`${g.employee_id}|${g.date}`);
    if (firstIn !== null) {
      // 請假時段內不算遲到：應到時間往後延到請假結束（遇到午休再延到午休結束）
      const startTs = expectedStart(g.date, settings, lv);
      if (startTs !== null) {
        const diffMin = Math.floor((firstIn - startTs) / 60000);
        if (diffMin > settings.late_grace_min) { late = true; lateMin = diffMin; }
      }
    }
    const stdMs = settings.standard_hours * 3600000;
    const overtime = Math.max(0, worked - stdMs);
    rows.push({
      employee_id: g.employee_id, name: g.name, date: g.date, weekday: weekday(g.date),
      first_in: firstIn !== null ? fmtTime(firstIn) : '',
      last_out: lastOut !== null ? fmtTime(lastOut) : '',
      working_now: missingOut && g.date === todayStr(),
      worked_ms: worked, worked_hours: +(worked / 3600000).toFixed(2), worked_text: fmtDur(worked),
      overtime_ms: overtime, overtime_hours: +(overtime / 3600000).toFixed(2), overtime_text: overtime ? fmtDur(overtime) : '',
      late, late_min: lateMin, edited, issues: [...new Set(issues)],
      ...leaveFields(lv),
    });
  }
  // 只有請假、沒有打卡的日子也列出來（不算缺勤）
  for (const [key, lv] of leaveMap) {
    if (groups.has(key)) continue;
    rows.push({
      employee_id: lv.employee_id, name: lv.name, date: lv.date, weekday: weekday(lv.date), first_in: '', last_out: '', working_now: false,
      worked_ms: 0, worked_hours: 0, worked_text: fmtDur(0), overtime_ms: 0, overtime_hours: 0, overtime_text: '',
      late: false, late_min: 0, edited: false, issues: [], ...leaveFields(lv), leave_only: true,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name.localeCompare(b.name, 'zh-Hant')));
  return rows;
}

function expectedStart(date, settings, lv) {
  const w = L.workWindow(date, settings);
  let t = w.ws;
  if (!lv) return t;
  for (let changed = true; changed;) {
    changed = false;
    for (const it of lv.items) if (it.start_ts <= t && it.end_ts > t) { t = it.end_ts; changed = true; }
    if (w.ls !== null && t >= w.ls && t < w.le) { t = w.le; changed = true; }
    if (t >= w.we) return null; // 整天請假
  }
  return t;
}
function leaveFields(lv) {
  if (!lv) return { leave_hours: 0, leave_text: '', leave_items: [], leave_only: false };
  return { leave_hours: lv.hours, leave_text: lv.items.map((i) => i.text).join('、'), leave_items: lv.items, leave_only: false };
}

function punchView(p) {
  return {
    id: p.id, employee_id: p.employee_id, name: p.name, type: p.type, type_text: p.type === 'in' ? '上班' : '下班',
    ts: p.ts, date: taipeiDateStr(p.ts), time: fmtTime(p.ts), weekday: weekday(taipeiDateStr(p.ts)),
    source: p.source, edited: !!p.edited, edit_note: p.edit_note || '',
    ip: p.ip || '', lat: p.lat, lng: p.lng, accuracy: p.accuracy, distance_m: p.distance_m,
    ip_ok: p.ip_ok, loc_ok: p.loc_ok, check_note: p.check_note || '',
  };
}

// ---------- 員工端 API ----------
app.get('/api/public/info', (req, res) => {
  const s = getSettings();
  const c = getCheckSettings();
  res.json({ company_name: s.company_name, work_start: s.work_start, server_time: Date.now(), require_network: c.net_enforced, require_location: c.loc_enforced, max_accuracy: c.loc_max_accuracy });
});
app.get('/api/public/employees', (req, res) => {
  res.json(db.prepare('SELECT id, name FROM employees WHERE active=1 ORDER BY id').all());
});
app.post('/api/login', (req, res) => {
  const { employee_id, pin } = req.body || {};
  const key = `emp|${req.ip}|${employee_id}`;
  if (checkLock(key)) return res.status(429).json({ error: '錯誤次數過多，請 5 分鐘後再試' });
  const emp = db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(Number(employee_id));
  if (!emp || String(pin) !== emp.pin) { addFail(key); return res.status(401).json({ error: 'PIN 碼錯誤' }); }
  failures.delete(key);
  const token = createSession('employee', emp.id, 30 * DAY);
  res.json({ token, employee: { id: emp.id, name: emp.name } });
});
app.post('/api/logout', (req, res) => {
  const t = bearer(req); if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  res.json({ ok: true });
});

function employeeStatus(emp) {
  const today = todayStr();
  const todays = loadPunches(today, today, emp.id);
  const last = todays[todays.length - 1];
  const settings = getSettings();
  const from = taipeiDateStr(Date.now() - 13 * DAY);
  const recent = computeDaily(loadPunches(from, today, emp.id), settings, loadLeaves(from, today, emp.id), { from, to: today });
  const recentPunches = loadPunches(from, today, emp.id).reverse().slice(0, 30).map(punchView);
  return {
    employee: { id: emp.id, name: emp.name },
    today, today_weekday: weekday(today),
    status: !last ? 'none' : last.type === 'in' ? 'in' : 'out',
    today_punches: todays.map(punchView),
    today_summary: recent.find((r) => r.date === today) || null,
    recent, recent_punches: recentPunches, settings: { work_start: settings.work_start, standard_hours: settings.standard_hours },
  };
}
function networkStatus(req) {
  const c = getCheckSettings();
  const ip = clientIp(req);
  return { require_network: c.net_enforced, require_location: c.loc_enforced, ip, network_ok: c.net_enforced ? checks.ipAllowed(ip, c.net_allowlist) : null };
}
app.get('/api/me', requireEmployee, (req, res) => res.json({ ...employeeStatus(req.employee), checks: networkStatus(req) }));
app.post('/api/punch', requireEmployee, (req, res) => {
  const { type } = req.body || {};
  if (!['in', 'out'].includes(type)) return res.status(400).json({ error: '打卡類型錯誤' });
  const today = todayStr();
  const todays = loadPunches(today, today, req.employee.id);
  const last = todays[todays.length - 1];
  if (type === 'in' && last && last.type === 'in') return res.status(409).json({ error: `您今天 ${fmtTime(last.ts)} 已經打過上班卡了` });
  if (type === 'out' && (!last || last.type === 'out')) return res.status(409).json({ error: '您還沒打上班卡，無法打下班卡' });
  const now = Date.now();
  const ev = evaluatePunch(req, req.body || {});
  if (ev.reasons.length) {
    db.prepare('INSERT INTO blocked_attempts(employee_id,type,ts,ip,lat,lng,accuracy,distance_m,ip_ok,loc_ok,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(req.employee.id, type, now, ev.ip, ev.lat, ev.lng, ev.accuracy, ev.distance_m, ev.ip_ok, ev.loc_ok, ev.reasons.join('；'));
    return res.status(403).json({ error: ev.reasons.join('\n'), blocked: true, reasons: ev.reasons, ip: ev.ip, distance_m: ev.distance_m, accuracy: ev.accuracy });
  }
  db.prepare("INSERT INTO punches(employee_id,type,ts,source,created_at,ip,lat,lng,accuracy,distance_m,ip_ok,loc_ok,check_note) VALUES(?,?,?,'self',?,?,?,?,?,?,?,?,?)")
    .run(req.employee.id, type, now, now, ev.ip, ev.lat, ev.lng, ev.accuracy, ev.distance_m, ev.ip_ok, ev.loc_ok, ev.notes.join('、'));
  res.json({ ok: true, message: `${type === 'in' ? '上班' : '下班'}打卡成功 ${fmtTime(now)}`, ...employeeStatus(req.employee), checks: networkStatus(req) });
});

// ---------- 管理端 API ----------
app.post('/api/admin/login', (req, res) => {
  const key = `admin|${req.ip}`;
  if (checkLock(key)) return res.status(429).json({ error: '錯誤次數過多，請 5 分鐘後再試' });
  if (!verifyPassword(String(req.body?.password || ''), getSetting('admin_password'))) { addFail(key); return res.status(401).json({ error: '密碼錯誤' }); }
  failures.delete(key);
  const token = createSession('admin', null, 12 * 3600000);
  res.setHeader('Set-Cookie', `admin_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${12 * 3600}`);
  res.json({ ok: true, default_password: verifyPassword('admin1234', getSetting('admin_password')) });
});
app.post('/api/admin/logout', (req, res) => {
  const t = cookie(req, 'admin_token'); if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  res.setHeader('Set-Cookie', 'admin_token=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.use('/api/admin', requireAdmin);

app.get('/api/admin/me', (req, res) => res.json({ ok: true, default_password: verifyPassword('admin1234', getSetting('admin_password')), settings: getSettings(), checks: getCheckSettings(), leave_pending: db.prepare("SELECT COUNT(*) c FROM leave_requests WHERE status='pending'").get().c }));
// 管理員目前連線的 IP（給「使用目前連線的 IP」按鈕與診斷用）
app.get('/api/admin/my-ip', (req, res) => {
  const ip = clientIp(req);
  res.json({ ip, suggestion: checks.suggestEntry(ip), is_private: checks.isPrivateIp(ip), socket_ip: checks.normalizeIp(req.socket.remoteAddress), x_forwarded_for: req.headers['x-forwarded-for'] || '', trust_proxy: String(app.get('trust proxy')) });
});
app.put('/api/admin/checks', (req, res) => {
  const b = req.body || {};
  const on = (v) => v === true || v === '1' || v === 1;
  const allow = String(b.net_allowlist || '').trim();
  const parsed = checks.parseAllowlist(allow);
  if (parsed.errors.length) return res.status(400).json({ error: `以下 IP 格式不正確：${parsed.errors.join('、')}` });
  const latS = String(b.loc_lat ?? '').trim(), lngS = String(b.loc_lng ?? '').trim();
  if ((latS === '') !== (lngS === '')) return res.status(400).json({ error: '緯度與經度需同時填寫' });
  if (latS !== '') {
    const lat = Number(latS), lng = Number(lngS);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return res.status(400).json({ error: '緯度需介於 -90 到 90' });
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return res.status(400).json({ error: '經度需介於 -180 到 180' });
  }
  const radius = Number(b.loc_radius);
  if (!(radius >= 20 && radius <= 5000)) return res.status(400).json({ error: '允許範圍需介於 20～5000 公尺' });
  const acc = Number(b.loc_max_accuracy);
  if (!(acc >= 10 && acc <= 2000)) return res.status(400).json({ error: '定位精確度上限需介於 10～2000 公尺' });
  setSetting('net_check_enabled', on(b.net_check_enabled) ? '1' : '0');
  setSetting('net_allowlist', allow);
  setSetting('loc_check_enabled', on(b.loc_check_enabled) ? '1' : '0');
  setSetting('loc_lat', latS); setSetting('loc_lng', lngS);
  setSetting('loc_radius', String(Math.round(radius))); setSetting('loc_max_accuracy', String(Math.round(acc)));
  const c = getCheckSettings();
  audit('修改打卡限制', `公司網路檢查：${c.net_check_enabled ? '開' : '關'}（${parsed.entries.length} 筆 IP）；公司位置檢查：${c.loc_check_enabled ? '開' : '關'}${c.loc_configured ? `（${latS}, ${lngS}，範圍 ${c.loc_radius} 公尺）` : '（未設定座標）'}`);
  res.json({ ok: true, checks: c });
});

// 今日總覽
app.get('/api/admin/overview', (req, res) => {
  const today = todayStr();
  const settings = getSettings();
  const daily = computeDaily(loadPunches(today, today), settings, loadLeaves(today, today), { from: today, to: today });
  const emps = db.prepare('SELECT id, name, is_sample FROM employees WHERE active=1 ORDER BY id').all();
  const list = emps.map((e) => {
    const d = daily.find((r) => r.employee_id === e.id);
    const status = !d ? 'none' : d.leave_only ? 'leave' : d.working_now ? 'in' : 'out';
    return { ...e, status, first_in: d?.first_in || '', last_out: d?.last_out || '', late: !!d?.late, late_min: d?.late_min || 0, worked_text: d && !d.leave_only ? d.worked_text : '', leave_text: d?.leave_text || '', leave_hours: d?.leave_hours || 0 };
  });
  // 本月累計（給儀表板統計卡）
  const monthFrom = today.slice(0, 8) + '01';
  const monthDaily = computeDaily(loadPunches(monthFrom, today), settings, loadLeaves(monthFrom, today), { from: monthFrom, to: today });
  const month = {
    from: monthFrom,
    hours: +(monthDaily.reduce((a, r) => a + r.worked_ms, 0) / 3600000).toFixed(1),
    overtime: +(monthDaily.reduce((a, r) => a + r.overtime_ms, 0) / 3600000).toFixed(1),
    late: monthDaily.filter((r) => r.late).length,
    issues: monthDaily.filter((r) => r.issues.length).length,
    leave_hours: +monthDaily.reduce((a, r) => a + r.leave_hours, 0).toFixed(1),
  };
  const leavePending = db.prepare("SELECT COUNT(*) c FROM leave_requests WHERE status='pending'").get().c;
  const blockedToday = db.prepare('SELECT COUNT(*) c FROM blocked_attempts WHERE ts>=?').get(taipeiToEpoch(today, '00:00')).c;
  res.json({ month, leave_pending: leavePending, on_leave: list.filter((x) => x.leave_text).length, blocked_today: blockedToday, checks: getCheckSettings(), today, weekday: weekday(today), total: emps.length, in_now: list.filter((x) => x.status === 'in').length, arrived: list.filter((x) => x.first_in).length, late: list.filter((x) => x.late).length, list });
});

// 員工管理
app.get('/api/admin/employees', (req, res) => {
  res.json(db.prepare('SELECT id,name,pin,note,is_sample,created_at FROM employees WHERE active=1 ORDER BY id').all());
});
function validateEmp(body, id) {
  const name = String(body.name || '').trim();
  const pin = String(body.pin || '').trim();
  if (!name) return '請輸入姓名';
  if (name.length > 30) return '姓名太長';
  if (!/^\d{4}$/.test(pin)) return 'PIN 碼必須是 4 位數字';
  const dup = db.prepare('SELECT id FROM employees WHERE name=? AND active=1 AND id<>?').get(name, id || 0);
  if (dup) return '已有同名員工，請加上區別（例如 王小明-門市）';
  return null;
}
app.post('/api/admin/employees', (req, res) => {
  const err = validateEmp(req.body || {}); if (err) return res.status(400).json({ error: err });
  const r = db.prepare('INSERT INTO employees(name,pin,note,created_at) VALUES(?,?,?,?)').run(req.body.name.trim(), String(req.body.pin).trim(), String(req.body.note || ''), Date.now());
  audit('新增員工', `新增員工「${req.body.name.trim()}」`);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.put('/api/admin/employees/:id', (req, res) => {
  const id = Number(req.params.id);
  const emp = db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(id);
  if (!emp) return res.status(404).json({ error: '找不到員工' });
  const err = validateEmp(req.body || {}, id); if (err) return res.status(400).json({ error: err });
  db.prepare('UPDATE employees SET name=?, pin=?, note=? WHERE id=?').run(req.body.name.trim(), String(req.body.pin).trim(), String(req.body.note || ''), id);
  if (String(req.body.pin).trim() !== emp.pin) db.prepare("DELETE FROM sessions WHERE kind='employee' AND employee_id=?").run(id);
  audit('修改員工', `修改員工「${emp.name}」${emp.name !== req.body.name.trim() ? `→「${req.body.name.trim()}」` : ''}${String(req.body.pin).trim() !== emp.pin ? '（已變更 PIN）' : ''}`);
  res.json({ ok: true });
});
app.delete('/api/admin/employees/:id', (req, res) => {
  const id = Number(req.params.id);
  const emp = db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(id);
  if (!emp) return res.status(404).json({ error: '找不到員工' });
  // 軟刪除：保留歷史打卡紀錄
  db.prepare('UPDATE employees SET active=0 WHERE id=?').run(id);
  db.prepare("DELETE FROM sessions WHERE kind='employee' AND employee_id=?").run(id);
  audit('移除員工', `移除員工「${emp.name}」（歷史打卡紀錄保留）`);
  res.json({ ok: true });
});

// 紀錄查詢
function rangeFromQuery(q) {
  const to = isDate(q.to) ? q.to : todayStr();
  const from = isDate(q.from) ? q.from : taipeiDateStr(taipeiToEpoch(to, '00:00') - 6 * DAY);
  return from <= to ? { from, to } : { from: to, to: from };
}
app.get('/api/admin/records', (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const punches = loadPunches(from, to, req.query.employee_id || null);
  const daily = computeDaily(punches, getSettings(), loadLeaves(from, to, req.query.employee_id || null), { from, to });
  const totals = {
    days: daily.filter((r) => !r.leave_only).length,
    leave_hours: +daily.reduce((s, r) => s + r.leave_hours, 0).toFixed(2),
    worked_hours: +(daily.reduce((s, r) => s + r.worked_ms, 0) / 3600000).toFixed(2),
    overtime_hours: +(daily.reduce((s, r) => s + r.overtime_ms, 0) / 3600000).toFixed(2),
    late_count: daily.filter((r) => r.late).length,
    issue_count: daily.filter((r) => r.issues.length).length,
  };
  res.json({ from, to, daily, punches: punches.slice().reverse().map(punchView), totals, blocked: loadBlocked(from, to, req.query.employee_id || null).reverse() });
});

function loadBlocked(from, to, employeeId) {
  let sql = 'SELECT b.*, e.name FROM blocked_attempts b JOIN employees e ON e.id=b.employee_id WHERE b.ts>=? AND b.ts<?';
  const args = [taipeiToEpoch(from, '00:00'), taipeiToEpoch(to, '00:00') + DAY];
  if (employeeId) { sql += ' AND b.employee_id=?'; args.push(Number(employeeId)); }
  return db.prepare(sql + ' ORDER BY b.ts ASC').all(...args).map((b) => ({ ...b, date: taipeiDateStr(b.ts), time: fmtTime(b.ts), weekday: weekday(taipeiDateStr(b.ts)), type_text: b.type === 'in' ? '上班' : '下班' }));
}

// 補登 / 修正打卡
app.post('/api/admin/punches', (req, res) => {
  const { employee_id, type, date, time, reason } = req.body || {};
  const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(Number(employee_id));
  if (!emp) return res.status(400).json({ error: '請選擇員工' });
  if (!['in', 'out'].includes(type)) return res.status(400).json({ error: '請選擇上班或下班' });
  if (!isDate(date) || !isTime(time)) return res.status(400).json({ error: '日期或時間格式錯誤' });
  if (!String(reason || '').trim()) return res.status(400).json({ error: '請填寫補登原因' });
  const ts = taipeiToEpoch(date, time);
  const note = `管理員於 ${fmtDateTime(Date.now())} 補登：${String(reason).trim()}`;
  const r = db.prepare("INSERT INTO punches(employee_id,type,ts,source,edited,edit_note,created_at,ip,check_note) VALUES(?,?,?,'admin',1,?,?,?,?)").run(emp.id, type, ts, note, Date.now(), clientIp(req), '管理員補登，不受網路／位置限制');
  audit('補登打卡', `${emp.name} ${date} ${time} ${type === 'in' ? '上班' : '下班'}｜原因：${String(reason).trim()}`);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.put('/api/admin/punches/:id', (req, res) => {
  const p = db.prepare('SELECT p.*, e.name FROM punches p JOIN employees e ON e.id=p.employee_id WHERE p.id=?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: '找不到這筆紀錄' });
  const { type, date, time, reason } = req.body || {};
  if (!['in', 'out'].includes(type)) return res.status(400).json({ error: '請選擇上班或下班' });
  if (!isDate(date) || !isTime(time)) return res.status(400).json({ error: '日期或時間格式錯誤' });
  if (!String(reason || '').trim()) return res.status(400).json({ error: '請填寫修改原因' });
  const ts = taipeiToEpoch(date, time);
  const before = `${p.type === 'in' ? '上班' : '下班'} ${fmtDateTime(p.ts)}`;
  const after = `${type === 'in' ? '上班' : '下班'} ${date} ${time}`;
  const note = `管理員於 ${fmtDateTime(Date.now())} 修改：${before} → ${after}｜原因：${String(reason).trim()}`;
  const newNote = p.edit_note ? `${p.edit_note}\n${note}` : note;
  db.prepare("UPDATE punches SET type=?, ts=?, edited=1, edit_note=?, check_note=CASE WHEN check_note LIKE '%管理員修改%' THEN check_note ELSE trim(coalesce(check_note,'') || ' 管理員修改，不受網路／位置限制') END WHERE id=?").run(type, ts, newNote, p.id);
  audit('修改打卡', `${p.name}：${before} → ${after}｜原因：${String(reason).trim()}`);
  res.json({ ok: true });
});
app.delete('/api/admin/punches/:id', (req, res) => {
  const p = db.prepare('SELECT p.*, e.name FROM punches p JOIN employees e ON e.id=p.employee_id WHERE p.id=?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: '找不到這筆紀錄' });
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: '請填寫刪除原因' });
  db.prepare('DELETE FROM punches WHERE id=?').run(p.id);
  audit('刪除打卡', `${p.name} ${p.type === 'in' ? '上班' : '下班'} ${fmtDateTime(p.ts)}｜原因：${reason}`);
  res.json({ ok: true });
});
app.get('/api/admin/audit', (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all().map((a) => ({ ...a, at_text: fmtDateTime(a.at) })));
});

// 設定
app.put('/api/admin/settings', (req, res) => {
  const { work_start, standard_hours, late_grace_min, company_name, lunch_enabled, lunch_start, lunch_end } = req.body || {};
  if (!isTime(work_start)) return res.status(400).json({ error: '上班時間格式錯誤（例如 09:00）' });
  const lunchOn = lunch_enabled === true || lunch_enabled === '1' || lunch_enabled === 1;
  if (lunchOn && (!isTime(lunch_start) || !isTime(lunch_end) || lunch_start >= lunch_end)) return res.status(400).json({ error: '午休時間設定錯誤（結束需晚於開始）' });
  const sh = Number(standard_hours);
  if (!(sh > 0 && sh <= 24)) return res.status(400).json({ error: '標準工時須介於 0～24 小時' });
  const g = Number(late_grace_min || 0);
  if (!(g >= 0 && g <= 120)) return res.status(400).json({ error: '遲到寬限須介於 0～120 分鐘' });
  setSetting('work_start', work_start); setSetting('standard_hours', sh); setSetting('late_grace_min', g);
  setSetting('company_name', String(company_name || '').trim() || '我的公司');
  setSetting('lunch_enabled', lunchOn ? '1' : '0');
  if (lunchOn) { setSetting('lunch_start', lunch_start); setSetting('lunch_end', lunch_end); }
  audit('修改設定', `上班時間 ${work_start}、標準工時 ${sh} 小時、遲到寬限 ${g} 分鐘、午休${lunchOn ? ` ${lunch_start}～${lunch_end} 不計工時` : '不扣除'}`);
  res.json({ ok: true, settings: getSettings() });
});
app.put('/api/admin/password', (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!verifyPassword(String(old_password || ''), getSetting('admin_password'))) return res.status(400).json({ error: '目前密碼錯誤' });
  if (String(new_password || '').length < 6) return res.status(400).json({ error: '新密碼至少 6 個字元' });
  setSetting('admin_password', hashPassword(String(new_password)));
  audit('變更密碼', '管理員密碼已變更');
  res.json({ ok: true });
});

// 匯出
app.get('/api/admin/export', async (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const punches = loadPunches(from, to, req.query.employee_id || null);
  const settings = getSettings();
  const exLeaves = loadLeaves(from, to, req.query.employee_id || null);
  const daily = computeDaily(punches, settings, exLeaves, { from, to }).sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name, 'zh-Hant') : a.date < b.date ? -1 : 1));
  const dailyHeader = ['日期', '星期', '員工', '上班時間', '下班時間', '工時（小時）', '加班（小時）', '遲到', '遲到分鐘', '異常', '有修改/補登', '請假', '請假（小時）'];
  const dailyRows = daily.map((r) => [r.date, r.weekday, r.name, r.first_in, r.last_out, r.worked_hours, r.overtime_hours, r.late ? '是' : '', r.late ? r.late_min : '', r.issues.join('、') || (r.working_now ? '上班中' : ''), r.edited ? '是' : '', r.leave_text, r.leave_hours || '']);
  const okText = (v) => (v === 1 ? '通過' : v === 0 ? '未通過' : '未檢查');
  const pHeader = ['日期', '星期', '時間', '員工', '類型', '來源', 'IP', '網路檢查', '緯度', '經度', '定位誤差（公尺）', '距公司（公尺）', '位置檢查', '檢查備註', '修改註記'];
  const pRows = punches.map(punchView).map((p) => [p.date, p.weekday, p.time, p.name, p.type_text, p.source === 'admin' ? '管理員補登' : '員工打卡', p.ip, p.source === 'admin' ? '管理員略過' : okText(p.ip_ok), p.lat ?? '', p.lng ?? '', p.accuracy ?? '', p.distance_m ?? '', p.source === 'admin' ? '管理員略過' : okText(p.loc_ok), p.check_note, p.edit_note]);
  const fname = `打卡紀錄_${from}_${to}`;
  if (format === 'csv') {
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = '\uFEFF' + [dailyHeader, ...dailyRows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(fname)}.csv`);
    return res.send(csv);
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = '員工打卡系統';
  const s1 = wb.addWorksheet('每日工時');
  s1.addRow([`${settings.company_name}　打卡紀錄 ${from} ～ ${to}（上班時間 ${settings.work_start}，標準工時 ${settings.standard_hours} 小時，${settings.lunch_enabled ? `午休 ${settings.lunch_start}～${settings.lunch_end} 不計工時` : '午休不扣除'}，時區 Asia/Taipei）`]);
  s1.mergeCells(1, 1, 1, dailyHeader.length);
  s1.addRow(dailyHeader).font = { bold: true };
  dailyRows.forEach((r) => {
    const row = s1.addRow(r);
    if (r[7] === '是') row.getCell(8).font = { color: { argb: 'FFD93025' }, bold: true };
  });
  const totalWorked = +(daily.reduce((s, r) => s + r.worked_ms, 0) / 3600000).toFixed(2);
  const totalOT = +(daily.reduce((s, r) => s + r.overtime_ms, 0) / 3600000).toFixed(2);
  s1.addRow(['合計', '', '', '', '', totalWorked, totalOT, daily.filter((r) => r.late).length + ' 次']).font = { bold: true };
  [12, 6, 14, 10, 10, 12, 12, 8, 10, 16, 12, 18, 12].forEach((w, i) => (s1.getColumn(i + 1).width = w));
  s1.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };

  // 每人合計
  const s3 = wb.addWorksheet('個人合計');
  const typeNames = db.prepare('SELECT name FROM leave_types ORDER BY sort, id').all().map((t) => t.name);
  exLeaves.forEach((l) => { if (!typeNames.includes(l.type_name)) typeNames.push(l.type_name); });
  s3.addRow(['員工', '出勤天數', '總工時（小時）', '加班（小時）', '遲到次數', '異常天數', ...typeNames.map((n) => `${n}（小時）`), '請假合計（小時）']).font = { bold: true };
  const per = new Map();
  daily.forEach((r) => {
    const x = per.get(r.name) || { v: [r.name, 0, 0, 0, 0, 0], lv: Object.fromEntries(typeNames.map((n) => [n, 0])) };
    if (!r.leave_only) x.v[1]++;
    x.v[2] += r.worked_ms / 3600000; x.v[3] += r.overtime_ms / 3600000; x.v[4] += r.late ? 1 : 0; x.v[5] += r.issues.length ? 1 : 0;
    r.leave_items.forEach((it) => { x.lv[it.type_name] = (x.lv[it.type_name] || 0) + it.hours; });
    per.set(r.name, x);
  });
  per.forEach((x) => {
    const lvs = typeNames.map((n) => +(x.lv[n] || 0).toFixed(2));
    s3.addRow([x.v[0], x.v[1], +x.v[2].toFixed(2), +x.v[3].toFixed(2), x.v[4], x.v[5], ...lvs, +lvs.reduce((a, b) => a + b, 0).toFixed(2)]);
  });
  [14, 10, 14, 12, 10, 10, ...typeNames.map(() => 11), 14].forEach((w, i) => (s3.getColumn(i + 1).width = w));

  const s2 = wb.addWorksheet('打卡明細');
  s2.addRow(pHeader).font = { bold: true };
  pRows.forEach((r) => s2.addRow(r));
  [12, 6, 8, 14, 8, 12, 18, 10, 11, 11, 10, 10, 10, 26, 60].forEach((w, i) => (s2.getColumn(i + 1).width = w));

  const s4 = wb.addWorksheet('被拒絕的打卡');
  s4.addRow(['日期', '星期', '時間', '員工', '類型', 'IP', '網路檢查', '緯度', '經度', '定位誤差（公尺）', '距公司（公尺）', '位置檢查', '拒絕原因']).font = { bold: true };
  loadBlocked(from, to, req.query.employee_id || null).forEach((b) => s4.addRow([b.date, b.weekday, b.time, b.name, b.type_text, b.ip, okText(b.ip_ok), b.lat ?? '', b.lng ?? '', b.accuracy ?? '', b.distance_m ?? '', okText(b.loc_ok), b.reason]));
  [12, 6, 8, 14, 8, 18, 10, 11, 11, 10, 10, 10, 60].forEach((w, i) => (s4.getColumn(i + 1).width = w));

  const s5 = wb.addWorksheet('請假紀錄');
  s5.addRow(['申請時間', '員工', '假別', '期間', '開始', '結束', '時數（小時）', '狀態', '原因', '審核意見', '審核時間', '附件']).font = { bold: true };
  loadLeaves(from, to, req.query.employee_id || null, ['pending', 'approved', 'rejected', 'cancelled']).map(leaveView).forEach((l) => {
    const row = s5.addRow([l.created_text, l.name, l.type_name, l.label, l.start_text, l.end_text, l.hours, l.status_text, l.reason, l.admin_comment, l.decided_text, l.attachment_name]);
    const color = { approved: 'FF1C7A4C', rejected: 'FFB42318', pending: 'FF995509', cancelled: 'FF66716D' }[l.status];
    row.getCell(8).font = { color: { argb: color }, bold: true };
  });
  [17, 14, 8, 22, 17, 17, 12, 9, 30, 24, 17, 20].forEach((w, i) => (s5.getColumn(i + 1).width = w));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

// =========================================================
// 請假
// =========================================================
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const STATUS_TEXT = { pending: '待審核', approved: '已核准', rejected: '已退回', cancelled: '已取消' };
const MODE_TEXT = { full: '全天', am: '上午', pm: '下午', hours: '指定時間' };
function hoursText(h, std) {
  if (!h) return '0 小時';
  if (std && Math.abs(h / std - Math.round(h / std)) < 1e-9) return `${Math.round(h / std)} 天（${h} 小時）`;
  return `${h} 小時`;
}
function leaveView(l) {
  const s = getSettings();
  const emp = l.name ? null : db.prepare('SELECT name FROM employees WHERE id=?').get(l.employee_id);
  return {
    id: l.id, employee_id: l.employee_id, name: l.name || emp?.name || '', type_id: l.type_id, type_name: l.type_name, deduct_annual: !!l.deduct_annual,
    mode: l.mode, mode_text: MODE_TEXT[l.mode], start_ts: l.start_ts, end_ts: l.end_ts,
    start_date: taipeiDateStr(l.start_ts), end_date: taipeiDateStr(l.end_ts - 1),
    start_text: fmtDateTime(l.start_ts), end_text: fmtDateTime(l.end_ts),
    label: L.leaveLabel(l), hours: l.hours, hours_text: hoursText(l.hours, s.standard_hours),
    days: L.calcLeave(l.start_ts, l.end_ts, s).days.map((d) => ({ date: d.date, hours: d.hours, from: d.from, to: d.to, full: d.full })),
    reason: l.reason, has_attachment: !!l.attachment, attachment_name: l.attachment_name || '', attachment_mime: l.attachment_mime || '',
    status: l.status, status_text: STATUS_TEXT[l.status], admin_comment: l.admin_comment || '',
    created_text: fmtDateTime(l.created_at), decided_text: l.decided_at ? fmtDateTime(l.decided_at) : '',
  };
}
function yearRange() { const y = todayStr().slice(0, 4); return { y, start: taipeiToEpoch(`${y}-01-01`, '00:00'), end: taipeiToEpoch(`${Number(y) + 1}-01-01`, '00:00') }; }
function annualBalance(empId) {
  const emp = db.prepare('SELECT annual_leave_hours, hire_date FROM employees WHERE id=?').get(empId);
  const { y, start, end } = yearRange();
  const sum = (st) => db.prepare('SELECT COALESCE(SUM(hours),0) h FROM leave_requests WHERE employee_id=? AND deduct_annual=1 AND status=? AND start_ts>=? AND start_ts<?').get(empId, st, start, end).h;
  const quota = Number(emp?.annual_leave_hours || 0), used = +sum('approved').toFixed(2), pending = +sum('pending').toFixed(2);
  const std = getSettings().standard_hours;
  return { year: y, quota_hours: quota, used_hours: used, pending_hours: pending, remaining_hours: +(quota - used).toFixed(2), available_hours: +(quota - used - pending).toFixed(2),
    quota_text: hoursText(quota, std), remaining_text: hoursText(+(quota - used).toFixed(2), std), std_hours: std, hire_date: emp?.hire_date || '' };
}
function overlapping(empId, start, end, exceptId) {
  return db.prepare("SELECT * FROM leave_requests WHERE employee_id=? AND status IN ('pending','approved') AND start_ts<? AND end_ts>? AND id<>?").get(empId, end, start, exceptId || 0);
}
function sniffMime(buf) {
  const hex = buf.subarray(0, 12).toString('hex');
  const ascii = buf.subarray(0, 12).toString('latin1');
  if (hex.startsWith('ffd8ff')) return ['image/jpeg', 'jpg'];
  if (hex.startsWith('89504e47')) return ['image/png', 'png'];
  if (ascii.startsWith('GIF8')) return ['image/gif', 'gif'];
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return ['image/webp', 'webp'];
  if (ascii.slice(4, 8) === 'ftyp' && /^(heic|heix|mif1|msf1|hevc|heim|heis)$/.test(ascii.slice(8, 12))) return ['image/heic', 'heic'];
  if (ascii.startsWith('%PDF')) return ['application/pdf', 'pdf'];
  return null;
}
function leaveSettingsForClient() {
  const s = getSettings();
  const w = L.workWindow(todayStr(), s);
  return { work_start: s.work_start, work_end: fmtTime(w.we), standard_hours: s.standard_hours, lunch_enabled: s.lunch_enabled, lunch_start: s.lunch_start, lunch_end: s.lunch_end,
    am: `${fmtTime(w.ws)}～${fmtTime(w.amEnd)}`, pm: `${fmtTime(w.pmStart)}～${fmtTime(w.we)}` };
}

// ---- 員工 ----
app.get('/api/leaves', requireEmployee, (req, res) => {
  const list = db.prepare('SELECT l.*, e.name FROM leave_requests l JOIN employees e ON e.id=l.employee_id WHERE l.employee_id=? ORDER BY l.start_ts DESC LIMIT 60').all(req.employee.id);
  res.json({
    types: db.prepare('SELECT id, name, deduct_annual, needs_attachment FROM leave_types WHERE active=1 ORDER BY sort, id').all(),
    requests: list.map(leaveView), balance: annualBalance(req.employee.id), work: leaveSettingsForClient(),
  });
});
app.post('/api/leaves/preview', requireEmployee, (req, res) => {
  const s = getSettings();
  const r = L.rangeFromForm(req.body || {}, s);
  if (r.error) return res.status(400).json({ error: r.error });
  const c = L.calcLeave(r.start, r.end, s);
  res.json({ hours: c.hours, hours_text: hoursText(c.hours, s.standard_hours), days: c.days.map((d) => ({ date: d.date, weekday: weekday(d.date), hours: d.hours, from: d.from, to: d.to })), label: L.leaveLabel({ start_ts: r.start, end_ts: r.end, mode: r.mode }) });
});
app.post('/api/leaves', requireEmployee, (req, res) => {
  const b = req.body || {};
  const s = getSettings();
  const type = db.prepare('SELECT * FROM leave_types WHERE id=? AND active=1').get(Number(b.type_id));
  if (!type) return res.status(400).json({ error: '請選擇假別' });
  const r = L.rangeFromForm(b, s);
  if (r.error) return res.status(400).json({ error: r.error });
  const c = L.calcLeave(r.start, r.end, s);
  if (c.hours <= 0) return res.status(400).json({ error: '所選時間不含上班時段（週六、週日或下班時間），請重新選擇' });
  const reason = String(b.reason || '').trim();
  if (!reason) return res.status(400).json({ error: '請填寫請假原因' });
  if (reason.length > 500) return res.status(400).json({ error: '原因請在 500 字以內' });
  const ov = overlapping(req.employee.id, r.start, r.end);
  if (ov) return res.status(409).json({ error: `與已申請的假期重疊（${ov.type_name} ${L.leaveLabel(ov)}，${STATUS_TEXT[ov.status]}）` });
  if (type.deduct_annual) {
    const bal = annualBalance(req.employee.id);
    if (c.hours > bal.available_hours + 1e-9) return res.status(400).json({ error: `特休可用時數不足：目前可用 ${Math.max(0, bal.available_hours)} 小時（含待審核扣除），本次需要 ${c.hours} 小時` });
  }
  // 附件
  let file = null;
  if (b.attachment && b.attachment.data) {
    const m = String(b.attachment.data).match(/^data:[^;]*;base64,(.*)$/s);
    const buf = Buffer.from(m ? m[1] : String(b.attachment.data), 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: '附件不能超過 5MB' });
    const sniff = sniffMime(buf);
    if (!sniff) return res.status(400).json({ error: '附件只接受圖片（JPG、PNG、HEIC 等）或 PDF' });
    const fname = `leave-${Date.now()}-${require('crypto').randomBytes(6).toString('hex')}.${sniff[1]}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
    file = { fname, mime: sniff[0], name: String(b.attachment.name || `附件.${sniff[1]}`).slice(0, 120) };
  }
  const info = db.prepare(`INSERT INTO leave_requests(employee_id,type_id,type_name,deduct_annual,mode,start_ts,end_ts,hours,reason,attachment,attachment_name,attachment_mime,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(req.employee.id, type.id, type.name, type.deduct_annual ? 1 : 0, r.mode, r.start, r.end, c.hours, reason, file?.fname || '', file?.name || '', file?.mime || '', Date.now());
  res.json({ ok: true, id: info.lastInsertRowid, message: `已送出 ${type.name} ${hoursText(c.hours, s.standard_hours)}，等待審核` });
});
app.post('/api/leaves/:id/cancel', requireEmployee, (req, res) => {
  const l = db.prepare('SELECT * FROM leave_requests WHERE id=? AND employee_id=?').get(Number(req.params.id), req.employee.id);
  if (!l) return res.status(404).json({ error: '找不到這筆請假' });
  if (l.status !== 'pending') return res.status(400).json({ error: `這筆請假${STATUS_TEXT[l.status]}，無法取消；如需更改請洽管理員` });
  db.prepare("UPDATE leave_requests SET status='cancelled', cancelled_at=? WHERE id=?").run(Date.now(), l.id);
  audit('取消請假', `${req.employee.name} 取消 ${l.type_name} ${L.leaveLabel(l)}（${l.hours} 小時）`);
  res.json({ ok: true });
});
function sendAttachment(res, l) {
  if (!l || !l.attachment) return res.status(404).json({ error: '沒有附件' });
  const fp = path.join(UPLOAD_DIR, path.basename(l.attachment));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: '附件檔案不存在' });
  res.setHeader('Content-Type', l.attachment_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="attachment"; filename*=UTF-8''${encodeURIComponent(l.attachment_name || 'attachment')}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(fp).pipe(res);
}
app.get('/api/leaves/:id/attachment', requireEmployee, (req, res) => sendAttachment(res, db.prepare('SELECT * FROM leave_requests WHERE id=? AND employee_id=?').get(Number(req.params.id), req.employee.id)));

// ---- 管理員 ----
app.get('/api/admin/leaves', (req, res) => {
  const q = req.query;
  let sql = 'SELECT l.*, e.name FROM leave_requests l JOIN employees e ON e.id=l.employee_id WHERE 1=1';
  const args = [];
  const st = String(q.status || 'all').split(',').filter((x) => STATUS_TEXT[x]);
  if (st.length) { sql += ` AND l.status IN (${st.map(() => '?').join(',')})`; args.push(...st); }
  if (isDate(q.from)) { sql += ' AND l.end_ts>?'; args.push(taipeiToEpoch(q.from, '00:00')); }
  if (isDate(q.to)) { sql += ' AND l.start_ts<?'; args.push(taipeiToEpoch(q.to, '00:00') + DAY); }
  if (q.employee_id) { sql += ' AND l.employee_id=?'; args.push(Number(q.employee_id)); }
  if (q.type_id) { sql += ' AND l.type_id=?'; args.push(Number(q.type_id)); }
  sql += q.status === 'pending' ? ' ORDER BY l.start_ts ASC' : ' ORDER BY l.start_ts DESC';
  const rows = db.prepare(sql + ' LIMIT 500').all(...args).map((l) => {
    const v = leaveView(l);
    if (l.deduct_annual) v.balance = annualBalance(l.employee_id);
    return v;
  });
  res.json({ leaves: rows, pending: db.prepare("SELECT COUNT(*) c FROM leave_requests WHERE status='pending'").get().c });
});
function decide(req, res, status) {
  const l = db.prepare('SELECT l.*, e.name FROM leave_requests l JOIN employees e ON e.id=l.employee_id WHERE l.id=?').get(Number(req.params.id));
  if (!l) return res.status(404).json({ error: '找不到這筆請假' });
  if (l.status !== 'pending') return res.status(400).json({ error: `這筆請假已${STATUS_TEXT[l.status].replace('已', '')}，無法再審核` });
  const comment = String(req.body?.comment || '').trim().slice(0, 300);
  if (status === 'approved') {
    const ov = db.prepare("SELECT * FROM leave_requests WHERE employee_id=? AND status='approved' AND start_ts<? AND end_ts>? AND id<>?").get(l.employee_id, l.end_ts, l.start_ts, l.id);
    if (ov) return res.status(409).json({ error: `與已核准的假期重疊（${ov.type_name} ${L.leaveLabel(ov)}）` });
    if (l.deduct_annual) {
      const bal = annualBalance(l.employee_id);
      if (l.hours > bal.remaining_hours + 1e-9) return res.status(400).json({ error: `${l.name} 的特休剩餘 ${bal.remaining_hours} 小時，不足 ${l.hours} 小時。請先到「特休額度」調整，或退回此申請。` });
    }
  }
  db.prepare('UPDATE leave_requests SET status=?, admin_comment=?, decided_at=? WHERE id=?').run(status, comment, Date.now(), l.id);
  const bal = l.deduct_annual && status === 'approved' ? annualBalance(l.employee_id) : null;
  audit(status === 'approved' ? '核准請假' : '退回請假', `${l.name} ${l.type_name} ${L.leaveLabel(l)}（${l.hours} 小時）${comment ? `｜意見：${comment}` : ''}${bal ? `｜特休剩餘 ${bal.remaining_hours} 小時` : ''}`);
  res.json({ ok: true, balance: bal });
}
app.post('/api/admin/leaves/:id/approve', (req, res) => decide(req, res, 'approved'));
app.post('/api/admin/leaves/:id/reject', (req, res) => decide(req, res, 'rejected'));
// 撤銷已核准的請假（例如臨時不休了）：改為已取消，特休自動退回
app.post('/api/admin/leaves/:id/revoke', (req, res) => {
  const l = db.prepare('SELECT l.*, e.name FROM leave_requests l JOIN employees e ON e.id=l.employee_id WHERE l.id=?').get(Number(req.params.id));
  if (!l) return res.status(404).json({ error: '找不到這筆請假' });
  if (l.status !== 'approved') return res.status(400).json({ error: '只有已核准的請假可以撤銷' });
  const reason = String(req.body?.comment || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ error: '請填寫撤銷原因' });
  db.prepare("UPDATE leave_requests SET status='cancelled', admin_comment=?, cancelled_at=? WHERE id=?").run(`管理員撤銷：${reason}`, Date.now(), l.id);
  const bal = l.deduct_annual ? annualBalance(l.employee_id) : null;
  audit('撤銷請假', `${l.name} ${l.type_name} ${L.leaveLabel(l)}（${l.hours} 小時）｜原因：${reason}${bal ? `｜特休剩餘 ${bal.remaining_hours} 小時` : ''}`);
  res.json({ ok: true, balance: bal });
});
app.get('/api/admin/leaves/:id/attachment', (req, res) => sendAttachment(res, db.prepare('SELECT * FROM leave_requests WHERE id=?').get(Number(req.params.id))));

// 假別
app.get('/api/admin/leave-types', (req, res) => res.json(db.prepare('SELECT * FROM leave_types ORDER BY sort, id').all()));
function validateType(b, id) {
  const name = String(b.name || '').trim();
  if (!name) return '請輸入假別名稱';
  if (name.length > 12) return '假別名稱請在 12 字以內';
  if (db.prepare('SELECT id FROM leave_types WHERE name=? AND id<>?').get(name, id || 0)) return '已有同名假別';
  return null;
}
app.post('/api/admin/leave-types', (req, res) => {
  const b = req.body || {}; const err = validateType(b); if (err) return res.status(400).json({ error: err });
  const sort = (db.prepare('SELECT MAX(sort) m FROM leave_types').get().m || 0) + 1;
  db.prepare('INSERT INTO leave_types(name,deduct_annual,needs_attachment,active,sort) VALUES(?,?,?,1,?)').run(b.name.trim(), b.deduct_annual ? 1 : 0, b.needs_attachment ? 1 : 0, sort);
  audit('新增假別', `新增假別「${b.name.trim()}」${b.deduct_annual ? '（扣特休）' : ''}`);
  res.json({ ok: true });
});
app.put('/api/admin/leave-types/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM leave_types WHERE id=?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: '找不到假別' });
  const b = { name: t.name, deduct_annual: !!t.deduct_annual, needs_attachment: !!t.needs_attachment, active: !!t.active, ...(req.body || {}) };
  const err = validateType(b, t.id); if (err) return res.status(400).json({ error: err });
  db.prepare('UPDATE leave_types SET name=?, deduct_annual=?, needs_attachment=?, active=? WHERE id=?').run(String(b.name).trim(), b.deduct_annual ? 1 : 0, b.needs_attachment ? 1 : 0, b.active ? 1 : 0, t.id);
  audit('修改假別', `假別「${t.name}」${t.name !== String(b.name).trim() ? `→「${String(b.name).trim()}」` : ''}：${b.active ? '啟用' : '停用'}${b.deduct_annual ? '、扣特休' : ''}${b.needs_attachment ? '、建議附證明' : ''}`);
  res.json({ ok: true });
});

// 特休額度
app.get('/api/admin/leave-balances', (req, res) => {
  const today = todayStr();
  const emps = db.prepare('SELECT id, name, is_sample, hire_date FROM employees WHERE active=1 ORDER BY id').all();
  res.json(emps.map((e) => ({ ...e, ...annualBalance(e.id), statutory: L.statutoryAnnualDays(e.hire_date, today) })));
});
app.put('/api/admin/leave-balances/:id', (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(Number(req.params.id));
  if (!emp) return res.status(404).json({ error: '找不到員工' });
  const q = Number(req.body?.quota_hours);
  if (!Number.isFinite(q) || q < 0 || q > 2000) return res.status(400).json({ error: '特休額度需介於 0～2000 小時' });
  const hire = String(req.body?.hire_date || '').trim();
  if (hire && (!isDate(hire) || hire > todayStr())) return res.status(400).json({ error: '到職日格式錯誤或晚於今天' });
  const before = annualBalance(emp.id);
  db.prepare('UPDATE employees SET annual_leave_hours=?, hire_date=? WHERE id=?').run(+q.toFixed(2), hire, emp.id);
  const after = annualBalance(emp.id);
  audit('調整特休額度', `${emp.name}：${before.year} 年特休額度 ${before.quota_hours} → ${after.quota_hours} 小時（已用 ${after.used_hours}、剩餘 ${after.remaining_hours}）${hire !== (emp.hire_date || '') ? `｜到職日 ${emp.hire_date || '未填'} → ${hire || '未填'}` : ''}`);
  res.json({ ok: true, balance: after });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`員工打卡系統已啟動：http://localhost:${PORT}　（管理後台：/admin）`));
}
module.exports = { app, computeDaily };

// 資料庫：SQLite（better-sqlite3）
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'clockin.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin TEXT NOT NULL,
  note TEXT DEFAULT '',
  is_sample INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS punches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  type TEXT NOT NULL CHECK (type IN ('in','out')),
  ts INTEGER NOT NULL,            -- epoch 毫秒（UTC）
  source TEXT DEFAULT 'self',     -- self = 員工自行打卡, admin = 管理員補登
  edited INTEGER DEFAULT 0,
  edit_note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_punches_emp_ts ON punches(employee_id, ts);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- admin / employee
  employee_id INTEGER,
  expires_at INTEGER NOT NULL
);
`);

// 資料表升級：打卡地點檢查欄位
const punchCols = db.prepare('PRAGMA table_info(punches)').all().map((c) => c.name);
[
  ['ip', 'TEXT'], ['lat', 'REAL'], ['lng', 'REAL'], ['accuracy', 'REAL'], ['distance_m', 'REAL'],
  ['ip_ok', 'INTEGER'],   // 1 通過 / 0 未通過 / NULL 未檢查
  ['loc_ok', 'INTEGER'],
  ['check_note', "TEXT DEFAULT ''"],
  ['work_mode', "TEXT DEFAULT ''"], // '' 一般 / wfh 居家上班 / trip 公差（已核准當天）
  ['offsite', 'INTEGER DEFAULT 0'],  // 1 = 異地打卡（下班放寬規則：不在公司網路也不在公司範圍內）
].forEach(([c, t]) => { if (!punchCols.includes(c)) db.exec(`ALTER TABLE punches ADD COLUMN ${c} ${t}`); });
db.exec(`
CREATE TABLE IF NOT EXISTS blocked_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ip TEXT, lat REAL, lng REAL, accuracy REAL, distance_m REAL,
  ip_ok INTEGER, loc_ok INTEGER,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocked_ts ON blocked_attempts(ts);
`);

// 請假功能
const empCols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
if (!empCols.includes('annual_leave_hours')) db.exec('ALTER TABLE employees ADD COLUMN annual_leave_hours REAL DEFAULT 0');
if (!empCols.includes('hire_date')) db.exec("ALTER TABLE employees ADD COLUMN hire_date TEXT DEFAULT ''");
db.exec(`
CREATE TABLE IF NOT EXISTS leave_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  deduct_annual INTEGER DEFAULT 0,   -- 1 = 從特休額度扣除
  needs_attachment INTEGER DEFAULT 0, -- 建議附證明（僅提示，不強制）
  active INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  type_id INTEGER NOT NULL REFERENCES leave_types(id),
  type_name TEXT NOT NULL,
  deduct_annual INTEGER DEFAULT 0,
  mode TEXT NOT NULL,                 -- full / am / pm / hours
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  hours REAL NOT NULL,
  reason TEXT NOT NULL,
  attachment TEXT DEFAULT '',         -- 存放於 DATA_DIR/uploads 的檔名
  attachment_name TEXT DEFAULT '',
  attachment_mime TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending / approved / rejected / cancelled
  admin_comment TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  cancelled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_leave_emp ON leave_requests(employee_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests(status);
`);
// 居家上班／公差：沿用請假的申請與審核流程，但不是假（kind 不是 leave、不扣時數）
const ltCols = db.prepare('PRAGMA table_info(leave_types)').all().map((c) => c.name);
if (!ltCols.includes('kind')) db.exec("ALTER TABLE leave_types ADD COLUMN kind TEXT DEFAULT 'leave'");
const lrCols = db.prepare('PRAGMA table_info(leave_requests)').all().map((c) => c.name);
if (!lrCols.includes('kind')) db.exec("ALTER TABLE leave_requests ADD COLUMN kind TEXT DEFAULT 'leave'");
if (!lrCols.includes('destination')) db.exec("ALTER TABLE leave_requests ADD COLUMN destination TEXT DEFAULT ''");
if (db.prepare('SELECT COUNT(*) c FROM leave_types').get().c === 0) {
  const ins = db.prepare('INSERT INTO leave_types(name,deduct_annual,needs_attachment,sort) VALUES(?,?,?,?)');
  [['特休', 1, 0], ['事假', 0, 0], ['病假', 0, 1], ['生理假', 0, 0], ['婚假', 0, 1], ['喪假', 0, 1], ['公假', 0, 1], ['其他', 0, 0]]
    .forEach(([n, d, a], i) => ins.run(n, d, a, i + 1));
}
for (const [kind, name, sort] of [['wfh', '居家上班', 101], ['trip', '公差', 102]]) {
  if (!db.prepare('SELECT id FROM leave_types WHERE kind=?').get(kind)) db.prepare('INSERT INTO leave_types(name,deduct_annual,needs_attachment,active,sort,kind) VALUES(?,0,0,1,?,?)').run(name, sort, kind);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

// 預設設定
if (!getSetting('admin_password')) setSetting('admin_password', hashPassword(process.env.ADMIN_PASSWORD || 'admin1234'));
if (!getSetting('work_start')) setSetting('work_start', '09:00');
if (!getSetting('standard_hours')) setSetting('standard_hours', '8');
if (!getSetting('late_grace_min')) setSetting('late_grace_min', '0');
if (!getSetting('lunch_start')) setSetting('lunch_start', '12:00');
if (!getSetting('lunch_end')) setSetting('lunch_end', '13:00');
if (!getSetting('lunch_enabled')) setSetting('lunch_enabled', '1');
// 打卡地點限制（預設全部關閉）
const defaults = { net_check_enabled: '0', net_allowlist: '', loc_check_enabled: '0', loc_lat: '', loc_lng: '', loc_radius: '150', loc_max_accuracy: '100',
  out_rule: 'relaxed', out_radius: '300' }; // 下班打卡規則：relaxed 放寬（公司網路或公司 300 公尺內，否則標記異地打卡）／strict 同上班
for (const [k, v] of Object.entries(defaults)) if (getSetting(k) === undefined) setSetting(k, v);
if (!getSetting('company_name')) setSetting('company_name', '我的公司');

// 示範資料（僅在第一次啟動、沒有任何員工時建立）
const TZ_OFFSET = 8 * 3600 * 1000;
function taipeiToEpoch(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - TZ_OFFSET;
}
function taipeiDateStr(epoch) {
  return new Date(epoch + TZ_OFFSET).toISOString().slice(0, 10);
}

if (db.prepare('SELECT COUNT(*) c FROM employees').get().c === 0 && process.env.NO_SAMPLE !== '1') {
  const now = Date.now();
  const insE = db.prepare('INSERT INTO employees(name,pin,note,is_sample,created_at) VALUES(?,?,?,1,?)');
  const ids = [
    insE.run('示範員工A', '1111', '示範資料，可刪除', now).lastInsertRowid,
    insE.run('示範員工B', '2222', '示範資料，可刪除', now).lastInsertRowid,
    insE.run('示範員工C', '3333', '示範資料，可刪除', now).lastInsertRowid,
  ];
  const insP = db.prepare("INSERT INTO punches(employee_id,type,ts,source,created_at) VALUES(?,?,?,'self',?)");
  // 取最近 3 個工作日（不含今天）
  const days = [];
  let t = now - 24 * 3600 * 1000;
  while (days.length < 3) {
    const wd = new Date(t + TZ_OFFSET).getUTCDay();
    if (wd !== 0 && wd !== 6) days.unshift(taipeiDateStr(t));
    t -= 24 * 3600 * 1000;
  }
  const plan = [
    // [員工 index, 上班, 下班]
    [0, '08:52', '18:05'], [1, '09:12', '18:10'], [2, '08:58', '19:45'],
    [0, '08:47', '17:58'], [1, '08:59', '18:02'], [2, '09:25', '18:30'],
    [0, '09:03', '20:15'], [1, '08:55', null],    [2, '08:50', '18:00'],
  ];
  plan.forEach(([ei, tin, tout], i) => {
    const day = days[Math.floor(i / 3)];
    insP.run(ids[ei], 'in', taipeiToEpoch(day, tin), now);
    if (tout) insP.run(ids[ei], 'out', taipeiToEpoch(day, tout), now);
  });
  // 示範特休額度與到職日
  const setBal = db.prepare('UPDATE employees SET annual_leave_hours=?, hire_date=? WHERE id=?');
  setBal.run(7 * 8, '2025-03-03', ids[0]); setBal.run(10 * 8, '2024-02-01', ids[1]); setBal.run(3 * 8, '2026-03-02', ids[2]);
  // 示範請假（一筆已核准、一筆待審核、一筆已退回、今天一筆半天假）
  {
    const L = require('./leave');
    const st = {
      work_start: getSetting('work_start'), standard_hours: Number(getSetting('standard_hours')),
      lunch_enabled: getSetting('lunch_enabled') === '1', lunch_start: getSetting('lunch_start'), lunch_end: getSetting('lunch_end'),
    };
    const tid = (n) => db.prepare('SELECT id FROM leave_types WHERE name=?').get(n).id;
    const nextWorkday = (d, n = 1) => { let x = d; let k = 0; while (k < n) { x = L.addDays(x, 1); if (!L.isWeekend(x)) k++; } return x; };
    const today0 = taipeiDateStr(now);
    const insL = db.prepare(`INSERT INTO leave_requests(employee_id,type_id,type_name,deduct_annual,mode,start_ts,end_ts,hours,reason,status,admin_comment,created_at,decided_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const addLeave = (emp, type, form, reason, status, comment, createdAgoDays) => {
      const r = L.rangeFromForm(form, st); const c = L.calcLeave(r.start, r.end, st);
      const created = now - createdAgoDays * 24 * 3600 * 1000;
      insL.run(emp, tid(type), type, type === '特休' ? 1 : 0, form.mode, r.start, r.end, c.hours, reason, status, comment, created, status === 'pending' ? null : created + 3600 * 1000);
    };
    const nw5 = nextWorkday(today0, 5), nw6 = nextWorkday(today0, 6);
    addLeave(ids[0], '特休', { mode: 'full', start_date: nw5, end_date: nw6 }, '家庭旅遊', 'approved', '玩得開心！', 3);
    addLeave(ids[1], '病假', { mode: 'full', start_date: nextWorkday(today0, 2) }, '預約門診回診', 'pending', '', 0);
    addLeave(ids[1], '事假', { mode: 'full', start_date: days[1] }, '處理私人事務', 'rejected', '當天人手不足，請改天再請', 6);
    if (!L.isWeekend(today0)) addLeave(ids[2], '事假', { mode: 'am', start_date: today0 }, '上午到銀行辦理貸款', 'approved', '', 2);
    // 示範居家上班／公差（不扣時數）
    const insW = db.prepare(`INSERT INTO leave_requests(employee_id,type_id,type_name,deduct_annual,mode,start_ts,end_ts,hours,reason,status,admin_comment,created_at,decided_at,kind,destination)
      VALUES(?,?,?,0,'full',?,?,0,?,?,?,?,?,?,?)`);
    const addWork = (emp, kind, from, to, reason, status, dest, createdAgoDays) => {
      const t = db.prepare('SELECT id, name FROM leave_types WHERE kind=?').get(kind);
      const created = now - createdAgoDays * 24 * 3600 * 1000;
      insW.run(emp, t.id, t.name, taipeiToEpoch(from, '00:00'), taipeiToEpoch(L.addDays(to, 1), '00:00'), reason, status, '', created, status === 'pending' ? null : created + 3600 * 1000, kind, dest);
    };
    addWork(ids[1], 'wfh', today0, today0, '水電師傅到家維修，在家處理客戶信件與報表', 'approved', '', 1);
    addWork(ids[2], 'trip', nextWorkday(today0, 3), nextWorkday(today0, 4), '拜訪客戶、參加展覽', 'pending', '台中世貿中心', 0);
  }
  // 今天的示範打卡（只建立已經過去的時間，避免出現未來時間）
  const today = taipeiDateStr(now);
  const todayWd = new Date(now + TZ_OFFSET).getUTCDay();
  if (todayWd !== 0 && todayWd !== 6) {
    [[0, '08:51'], [1, '09:07']].forEach(([ei, tin]) => {
      const ts = taipeiToEpoch(today, tin);
      if (ts < now) insP.run(ids[ei], 'in', ts, now);
    });
    // 示範員工B 今天居家上班：打卡記錄 GPS
    db.prepare("UPDATE punches SET work_mode='wfh', lat=25.0418, lng=121.5654, accuracy=18, check_note='居家上班（已記錄 GPS）' WHERE employee_id=? AND ts=?").run(ids[1], taipeiToEpoch(today, '09:07'));
  }
  // 示範異地打卡：最近一個工作日 示範員工A 的下班卡在外面打
  db.prepare("UPDATE punches SET offsite=1, ip='111.250.12.34', ip_ok=0, lat=25.0478, lng=121.5170, accuracy=25, check_note='異地打卡：非公司網路，距公司範圍外' WHERE employee_id=? AND type='out' AND ts=?")
    .run(ids[0], taipeiToEpoch(days[2], '20:15'));
}

module.exports = { DATA_DIR, db, getSetting, setSetting, hashPassword, verifyPassword, taipeiToEpoch, taipeiDateStr, TZ_OFFSET };

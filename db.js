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

// 薪資統整：員工薪資設定、假別給薪比例、每月調整項與確認（鎖定）
if (!empCols.includes('pay_type')) db.exec("ALTER TABLE employees ADD COLUMN pay_type TEXT DEFAULT 'monthly'"); // monthly 月薪 / hourly 時薪
if (!empCols.includes('pay_amount')) db.exec('ALTER TABLE employees ADD COLUMN pay_amount REAL DEFAULT 0');
if (!empCols.includes('pay_items')) db.exec("ALTER TABLE employees ADD COLUMN pay_items TEXT DEFAULT '[]'"); // [{kind:'allow'|'deduct', name, amount}]
if (!empCols.includes('pay_note')) db.exec("ALTER TABLE employees ADD COLUMN pay_note TEXT DEFAULT ''");
// 假別給薪比例預設值（勞基法、勞工請假規則、性別平等工作法）；可在「薪資統整 → 薪資設定」修改
function defaultPay(name) {
  if (/病假/.test(name) && !/公傷/.test(name)) return [0.5, 30];   // 普通傷病假：一年 30 日內半薪
  if (/生理假/.test(name)) return [0.5, null];                       // 生理假：減半發給
  if (/事假|家庭照顧/.test(name)) return [0, null];                  // 事假、家庭照顧假：不給薪
  if (/其他/.test(name)) return [0, null];                           // 「其他」：預設不給薪，請依實際情況調整
  return [1, null];                                                  // 特休、婚假、喪假、公假、產假、產檢、陪產、公傷病假…：照給
}
if (!ltCols.includes('pay_ratio')) {
  db.exec('ALTER TABLE leave_types ADD COLUMN pay_ratio REAL DEFAULT 1');
  db.exec('ALTER TABLE leave_types ADD COLUMN pay_cap_days REAL');   // 每年給薪上限（天），超過部分不給薪；NULL = 無上限
  for (const t of db.prepare("SELECT id, name FROM leave_types WHERE kind='leave'").all()) {
    const [r, cap] = defaultPay(t.name);
    db.prepare('UPDATE leave_types SET pay_ratio=?, pay_cap_days=? WHERE id=?').run(r, cap, t.id);
  }
}
db.exec(`
CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,               -- YYYY-MM
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  kind TEXT NOT NULL,                -- add 加項（獎金等）/ deduct 扣項
  label TEXT NOT NULL,
  amount REAL NOT NULL,              -- 正數
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payadj ON payroll_adjustments(month, employee_id);
CREATE TABLE IF NOT EXISTS payroll_months (
  month TEXT PRIMARY KEY,            -- YYYY-MM
  confirmed_at INTEGER NOT NULL,
  snapshot TEXT NOT NULL             -- 確認當下的試算結果（JSON），確認後不再重新計算
);
`);

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
const defaults = { payroll_late_deduct: '0', payroll_ot_unit: '1', payroll_clip_early: '1', net_check_enabled: '0', net_allowlist: '', loc_check_enabled: '0', loc_lat: '', loc_lng: '', loc_radius: '150', loc_max_accuracy: '100',
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

  // 示範薪資設定（數值僅為示範，請依實際情況修改）
  const setPay = db.prepare('UPDATE employees SET pay_type=?, pay_amount=?, pay_items=?, pay_note=? WHERE id=?');
  const demoNote = '示範數值，勞健保自付額請依投保級距自行填寫';
  setPay.run('monthly', 32000, JSON.stringify([{ kind: 'allow', name: '伙食津貼', amount: 2400 }, { kind: 'deduct', name: '勞保自付額', amount: 802 }, { kind: 'deduct', name: '健保自付額', amount: 509 }]), demoNote, ids[0]);
  setPay.run('monthly', 38000, JSON.stringify([{ kind: 'allow', name: '伙食津貼', amount: 2400 }, { kind: 'allow', name: '職務加給', amount: 1500 }, { kind: 'deduct', name: '勞保自付額', amount: 955 }, { kind: 'deduct', name: '健保自付額', amount: 592 }]), demoNote, ids[1]);
  setPay.run('hourly', 196, JSON.stringify([{ kind: 'deduct', name: '勞保自付額', amount: 297 }]), demoNote, ids[2]);

  // 示範歷史出勤：上個月 1 日起到最近 3 個工作日之前，讓「薪資統整」有完整月份可看
  {
    const L = require('./leave');
    const st = { work_start: getSetting('work_start'), standard_hours: Number(getSetting('standard_hours')), lunch_enabled: getSetting('lunch_enabled') === '1', lunch_start: getSetting('lunch_start'), lunch_end: getSetting('lunch_end') };
    const t0 = taipeiDateStr(now);
    const [ty, tm] = t0.split('-').map(Number);
    const prevMonth = new Date(Date.UTC(ty, tm - 2, 1)).toISOString().slice(0, 7);
    const hist = [];
    for (let d = `${prevMonth}-01`; d < days[0]; d = L.addDays(d, 1)) if (!L.isWeekend(d)) hist.push(d);
    const pd = hist.filter((d) => d.startsWith(prevMonth));
    const rnd = (a, b) => { let h = 2166136261; for (const c of `${a}|${b}`) h = Math.imul(h ^ c.codePointAt(0), 16777619); return ((h >>> 0) % 1000) / 1000; };
    const hm = (base, add) => { const [h, m] = base.split(':').map(Number); const t = h * 60 + m + Math.round(add); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
    const special = {
      // [員工 index]：{ 日期: [上班, 下班] 或 null（請假不打卡） }
      0: { [pd[2]]: ['08:55', '20:10'], [pd[4]]: ['08:52', '17:40'], [pd[9]]: ['13:00', '18:02'], [pd[11]]: ['08:50', '19:35'], [pd[17]]: ['08:58', '21:00'] },
      1: { [pd[1]]: ['09:21', '18:03'], [pd[6]]: null, [pd[8]]: ['08:57', '19:05'], [pd[13]]: ['09:16', '18:00'], [pd[16]]: ['08:55', '12:00'] },
      2: { [pd[5]]: ['08:55', '19:40'], [pd[12]]: null, [pd[14]]: ['08:58', '20:30'], [pd[15]]: ['08:56', '18:20'] },
    };
    const base = [['08:44', 16, '18:00', 5], ['08:48', 14, '18:00', 4], ['08:52', 8, '18:00', 4]];
    const insH = db.prepare("INSERT INTO punches(employee_id,type,ts,source,created_at) VALUES(?,?,?,'self',?)");
    for (const d of hist) {
      ids.forEach((id, ei) => {
        let pair = [hm(base[ei][0], rnd(ei, d) * base[ei][1]), hm(base[ei][2], rnd(d, ei) * base[ei][3])];
        if (special[ei] && Object.prototype.hasOwnProperty.call(special[ei], d)) pair = special[ei][d];
        if (!pair) return;
        insH.run(id, 'in', taipeiToEpoch(d, pair[0]), now); insH.run(id, 'out', taipeiToEpoch(d, pair[1]), now);
      });
    }
    // 示範員工C 上個月第一個週六支援盤點（休息日加班）
    let sat = `${prevMonth}-01`; while (new Date(sat + 'T00:00:00Z').getUTCDay() !== 6) sat = L.addDays(sat, 1);
    insH.run(ids[2], 'in', taipeiToEpoch(sat, '10:00'), now); insH.run(ids[2], 'out', taipeiToEpoch(sat, '20:30'), now);
    // 已核准的假：B 病假一天（半薪）、A 事假上午（不給薪）、B 事假下午、C 公假一天（照給）
    const tid = (n) => db.prepare("SELECT id FROM leave_types WHERE name=? AND kind='leave'").get(n).id;
    const insL = db.prepare(`INSERT INTO leave_requests(employee_id,type_id,type_name,deduct_annual,mode,start_ts,end_ts,hours,reason,status,admin_comment,created_at,decided_at)
      VALUES(?,?,?,?,?,?,?,?,?,'approved','',?,?)`);
    const addL = (emp, type, form, reason) => {
      if (!form.start_date) return;
      const r = L.rangeFromForm(form, st); const c = L.calcLeave(r.start, r.end, st);
      const created = taipeiToEpoch(form.start_date, '08:00') - 3 * 24 * 3600 * 1000;
      insL.run(emp, tid(type), type, type === '特休' ? 1 : 0, form.mode, r.start, r.end, c.hours, reason, created, created + 3600 * 1000);
    };
    addL(ids[1], '病假', { mode: 'full', start_date: pd[6] }, '感冒發燒就醫');
    addL(ids[0], '事假', { mode: 'am', start_date: pd[9] }, '辦理戶籍資料');
    addL(ids[1], '事假', { mode: 'pm', start_date: pd[16] }, '小孩學校家長會');
    addL(ids[2], '公假', { mode: 'full', start_date: pd[12] }, '後備軍人教育召集');
    // B 上個月一天居家上班（已核准，打卡有 GPS）
    if (pd[3]) {
      const w = db.prepare("SELECT id, name FROM leave_types WHERE kind='wfh'").get();
      db.prepare(`INSERT INTO leave_requests(employee_id,type_id,type_name,deduct_annual,mode,start_ts,end_ts,hours,reason,status,admin_comment,created_at,decided_at,kind,destination)
        VALUES(?,?,?,0,'full',?,?,0,?,'approved','',?,?,'wfh','')`).run(ids[1], w.id, w.name, taipeiToEpoch(pd[3], '00:00'), taipeiToEpoch(L.addDays(pd[3], 1), '00:00'), '等待冷氣安裝，在家處理報表', now, now);
      db.prepare("UPDATE punches SET work_mode='wfh', lat=25.0418, lng=121.5654, accuracy=15, check_note='居家上班（已記錄 GPS）' WHERE employee_id=? AND ts>=? AND ts<?").run(ids[1], taipeiToEpoch(pd[3], '00:00'), taipeiToEpoch(L.addDays(pd[3], 1), '00:00'));
    }
    // C 上個月一次異地下班卡
    if (pd[15]) db.prepare("UPDATE punches SET offsite=1, ip='101.12.34.56', ip_ok=0, lat=25.0330, lng=121.5654, accuracy=30, check_note='異地打卡：非公司網路，距公司範圍外' WHERE employee_id=? AND type='out' AND ts=?").run(ids[2], taipeiToEpoch(pd[15], '18:20'));
    // 示範調整項：B 上個月績效獎金
    db.prepare('INSERT INTO payroll_adjustments(month,employee_id,kind,label,amount,note,created_at) VALUES(?,?,?,?,?,?,?)').run(prevMonth, ids[1], 'add', '績效獎金', 2000, '示範：第三季專案達標', now);
  }
}

module.exports = { defaultPay, DATA_DIR, db, getSetting, setSetting, hashPassword, verifyPassword, taipeiToEpoch, taipeiDateStr, TZ_OFFSET };

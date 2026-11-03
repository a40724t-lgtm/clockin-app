// 國定假日行事曆（勞基法第 37 條）＋公司調整
//
// 內建資料：holidays/tw-holidays.json，由 scripts/build-holidays.js 從行政院人事行政總處（DGPA）
//   「中華民國政府行政機關辦公日曆表」開放資料產生（https://data.gov.tw/dataset/14718）。
// 法源：
//   勞動基準法第 37 條 — 內政部所定應放假之紀念日、節日、勞動節…均應休假。
//   紀念日及節日實施條例（114/05/28 公布施行）第 4、6 條 — 16 日應放假日（含小年夜、教師節、光復節、行憲紀念日）。
//     https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=D0020095
//   勞動基準法施行細則第 23 條之 1 — 國定假日遇例假、休息日應予補假，補假期日由勞雇雙方協商排定。
//     https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0030002&flno=23-1
//   勞動基準法第 39 條 — 休假日工資照給；經勞工同意於休假日工作者，工資應加倍發給。
//   勞動部 104/04/23 勞動條1字第1040130697號函 — 國定假日得經勞工「個人」同意與工作日對調（調移），調移後原日為正常工作日。
//
// 日別種類（kind）：
//   statutory  國定假日（落在週六日者 weekend=true，由補假日放假）
//   makeup     國定假日遇週末之補假（預設比照 DGPA 公告日期；可再調移）
//   swap_in    勞資協商調移後的放假日（具國定假日性質）
//   swap_out   被調移走的原國定假日／補假，當天為正常工作日
//   custom     公司自訂假日（公司給的有薪假，不具國定假日性質）
//   bridge     政府「調整放假」日：民間預設照常上班，公司可選擇比照放假（adopted）
//   gov_workday 政府「補行上班」日：僅適用政府機關，民間不適用（僅顯示）
const fs = require('fs');
const path = require('path');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'holidays', 'tw-holidays.json'), 'utf8'));
const KIND_TEXT = { statutory: '國定假日', makeup: '補假', swap_in: '調移放假', swap_out: '調移上班', custom: '公司自訂假日', bridge: '政府彈性放假', gov_workday: '政府補行上班' };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const isWeekend = (d) => [0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay());
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

module.exports = function createHolidays(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS holiday_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,            -- custom 公司自訂假日 / bridge 比照政府調整放假 / swap 勞資協商調移
    date TEXT NOT NULL,            -- custom、bridge：該日；swap：原國定假日（或補假）日期
    to_date TEXT DEFAULT '',       -- swap：調移後的放假日
    name TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_holiday_changes ON holiday_changes(kind, date);
  `);

  let cache = null;
  function build() {
    if (cache) return cache;
    const map = new Map();   // date → info（有效的行事曆）
    const base = new Map();  // date → 原始資料
    for (const [y, v] of Object.entries(DATA.years)) for (const h of v.holidays) base.set(h.date, { ...h, year: Number(y) });
    for (const h of base.values()) {
      const info = { date: h.date, name: h.name, kind: h.type, weekend: isWeekend(h.date), source: 'dgpa' };
      if (h.type === 'statutory') Object.assign(info, { off: true, paid_holiday: !info.weekend, note: info.weekend ? '適逢週末，另於補假日放假' : '' });
      else if (h.type === 'makeup') Object.assign(info, { off: true, paid_holiday: true, for_date: h.for_date, note: h.for_date ? `${md(h.for_date)} 國定假日適逢週末之補假` : '國定假日補假' });
      else if (h.type === 'bridge') Object.assign(info, { off: false, paid_holiday: false, adopted: false, note: '政府調整放假，民間企業預設照常上班' });
      else if (h.type === 'gov_workday') Object.assign(info, { off: false, paid_holiday: false, note: '政府補行上班日，民間企業不適用' });
      map.set(h.date, info);
    }
    for (const c of db.prepare('SELECT * FROM holiday_changes ORDER BY id').all()) {
      if (c.kind === 'custom') map.set(c.date, { date: c.date, name: c.name || '公司自訂假日', kind: 'custom', off: true, paid_holiday: false, weekend: isWeekend(c.date), source: 'company', change_id: c.id, note: c.note || '' });
      else if (c.kind === 'bridge') { const b = map.get(c.date); if (b && b.kind === 'bridge') Object.assign(b, { off: true, adopted: true, change_id: c.id, note: '比照政府調整放假（公司給假）' }); }
      else if (c.kind === 'swap') {
        const o = map.get(c.date); if (!o) continue;
        map.set(c.date, { date: c.date, name: o.name, kind: 'swap_out', off: false, paid_holiday: false, weekend: false, source: 'company', change_id: c.id, to_date: c.to_date, orig_kind: o.kind, note: `已調移至 ${md(c.to_date)}（週${WEEK[new Date(c.to_date + 'T00:00:00Z').getUTCDay()]}）放假，本日照常上班${c.note ? `｜${c.note}` : ''}` });
        map.set(c.to_date, { date: c.to_date, name: `${o.name}（調移）`, kind: 'swap_in', off: true, paid_holiday: true, weekend: false, source: 'company', change_id: c.id, from_date: c.date, note: `由 ${md(c.date)} 調移${c.note ? `｜${c.note}` : ''}` });
      }
    }
    for (const v of map.values()) v.kind_text = KIND_TEXT[v.kind];
    cache = map;
    return map;
  }
  const invalidate = () => { cache = null; };

  // 某日的行事曆資訊（沒有則 null）
  const info = (date) => build().get(date) || null;
  // 平日是否放假（請假不計、不算遲到）：國定假日、補假、調移放假、公司自訂、採用的彈性放假
  const isOffWeekday = (date) => { const x = info(date); return !!(x && x.off && !x.weekend); };
  function between(from, to) {
    return [...build().values()].filter((x) => x.date >= from && x.date <= to).sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  const years = () => {
    const ys = new Set(Object.keys(DATA.years).map(Number));
    for (const c of db.prepare('SELECT date, to_date FROM holiday_changes').all()) { ys.add(Number(c.date.slice(0, 4))); if (c.to_date) ys.add(Number(c.to_date.slice(0, 4))); }
    return [...ys].sort();
  };
  const published = (y) => !!DATA.years[String(y)];
  const sourceOf = (y) => DATA.years[String(y)]?.source || '';

  // ---- 管理 ----
  function addCustom(date, name, note) {
    if (!isDate(date)) return { error: '請選擇日期' };
    name = String(name || '').trim();
    if (!name) return { error: '請填寫假日名稱（例如：公司週年慶）' };
    if (name.length > 20) return { error: '假日名稱請在 20 字以內' };
    if (isWeekend(date)) return { error: '週六、日本來就是休息日，不需要設定公司假日' };
    const x = info(date);
    if (x && x.off) return { error: `${md(date)} 已經是「${x.name}」放假日` };
    if (x && x.kind === 'swap_out') return { error: `${md(date)} 是調移上班日，請先取消調移` };
    db.prepare("INSERT INTO holiday_changes(kind,date,name,note,created_at) VALUES('custom',?,?,?,?)").run(date, name, String(note || '').trim().slice(0, 100), Date.now());
    invalidate();
    return { ok: true, text: `新增公司自訂假日 ${date}「${name}」` };
  }
  function setBridge(date, adopt) {
    const x = info(date);
    if (!x || x.kind !== 'bridge') return { error: '這一天不是政府調整放假日' };
    if (adopt) db.prepare("INSERT OR IGNORE INTO holiday_changes(kind,date,created_at) VALUES('bridge',?,?)").run(date, Date.now());
    else db.prepare("DELETE FROM holiday_changes WHERE kind='bridge' AND date=?").run(date);
    invalidate();
    return { ok: true, text: `${date}「${x.name}」${adopt ? '比照政府放假' : '改為照常上班'}` };
  }
  function swap(date, toDate, note) {
    const x = info(date);
    if (!x || !['statutory', 'makeup'].includes(x.kind)) return { error: '只有國定假日或補假可以調移' };
    if (x.weekend) return { error: '這個國定假日落在週末，請改為調移它的補假日' };
    if (!isDate(toDate)) return { error: '請選擇調移後的放假日' };
    if (toDate === date) return { error: '調移日期不能和原日期相同' };
    if (isWeekend(toDate)) return { error: '調移後的放假日必須是原本要上班的平日（週一至週五）' };
    const y = info(toDate);
    if (y && (y.off || y.kind === 'swap_out')) return { error: `${md(toDate)} 已經是「${y.name}」，請選其他工作日` };
    db.prepare("INSERT INTO holiday_changes(kind,date,to_date,note,created_at) VALUES('swap',?,?,?,?)").run(date, toDate, String(note || '').trim().slice(0, 100), Date.now());
    invalidate();
    return { ok: true, text: `「${x.name}」${date} 調移至 ${toDate} 放假${note ? `｜${note}` : ''}` };
  }
  function remove(id) {
    const c = db.prepare('SELECT * FROM holiday_changes WHERE id=?').get(Number(id));
    if (!c) return { error: '找不到這筆設定' };
    db.prepare('DELETE FROM holiday_changes WHERE id=?').run(c.id);
    invalidate();
    return { ok: true, change: c, text: c.kind === 'custom' ? `刪除公司自訂假日 ${c.date}「${c.name}」` : c.kind === 'swap' ? `取消調移：${c.date} → ${c.to_date}` : `${c.date} 取消比照政府放假` };
  }
  const changeById = (id) => db.prepare('SELECT * FROM holiday_changes WHERE id=?').get(Number(id));

  return { info, isOffWeekday, between, years, published, sourceOf, addCustom, setBridge, swap, remove, changeById, invalidate, KIND_TEXT, about: DATA.about };
};
module.exports.KIND_TEXT = KIND_TEXT;

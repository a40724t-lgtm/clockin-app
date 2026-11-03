// 請假時數計算與特休年資（純函式，不碰資料庫）
const TZ_OFFSET = 8 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const H = 3600 * 1000;
const toEpoch = (date, time) => { const [y, m, d] = date.split('-').map(Number); const [hh, mm] = time.split(':').map(Number); return Date.UTC(y, m - 1, d, hh, mm) - TZ_OFFSET; };
const dateOf = (ts) => new Date(ts + TZ_OFFSET).toISOString().slice(0, 10);
const timeOf = (ts) => new Date(ts + TZ_OFFSET).toISOString().slice(11, 16);
const addDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isWeekend = (date) => { const w = new Date(date + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6; };
// 平日放假判斷（國定假日、補假、調移放假、公司自訂假日）；由 server.js 以 holidays.js 設定
let offWeekday = () => false;
const setOffWeekday = (fn) => { offWeekday = typeof fn === 'function' ? fn : () => false; };
const isOffDay = (date) => isWeekend(date) || offWeekday(date);

// 某天的上班時段：上班時間 → 上班時間 + 標準工時（+ 午休，若午休落在其中）
function workWindow(date, s) {
  const ws = toEpoch(date, s.work_start);
  let we = ws + s.standard_hours * H;
  let ls = null, le = null;
  if (s.lunch_enabled) {
    ls = toEpoch(date, s.lunch_start); le = toEpoch(date, s.lunch_end);
    if (ls >= ws && ls < we) we += le - ls; else { ls = null; le = null; }
  }
  // 半天分界：有午休用午休，沒有則取標準工時的一半
  const amEnd = ls ?? ws + (s.standard_hours / 2) * H;
  const pmStart = le ?? amEnd;
  return { ws, we, ls, le, amEnd, pmStart };
}

// 計算 [startTs, endTs) 內的請假時數（只算上班時段、扣午休、跳過週六日與國定假日等放假日）
// 回傳 skipped：區間內被略過的平日放假日（給畫面顯示「國定假日不計入」）
function calcLeave(startTs, endTs, s) {
  const days = [], skipped = [];
  if (!(endTs > startTs)) return { hours: 0, days, skipped };
  for (let d = dateOf(startTs); d <= dateOf(endTs - 1); d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    if (offWeekday(d)) { skipped.push(d); continue; }
    const w = workWindow(d, s);
    const a = Math.max(startTs, w.ws), b = Math.min(endTs, w.we);
    if (b <= a) continue;
    let ms = b - a;
    if (w.ls !== null) ms -= Math.max(0, Math.min(b, w.le) - Math.max(a, w.ls));
    if (ms > 0) days.push({ date: d, hours: +(ms / H).toFixed(2), from: timeOf(a), to: timeOf(b), full: a <= w.ws && b >= w.we, start_ts: a, end_ts: b });
  }
  return { hours: +days.reduce((x, y) => x + y.hours, 0).toFixed(2), days, skipped };
}

// 依表單模式轉成起訖時間
// mode: full（全天，可跨多日）/ am（上午）/ pm（下午）/ hours（指定時間）
function rangeFromForm(f, s) {
  const isDate = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x || '');
  const isTime = (x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x || '');
  const mode = f.mode;
  if (!isDate(f.start_date)) return { error: '請選擇開始日期' };
  if (mode === 'full') {
    const end = f.end_date || f.start_date;
    if (!isDate(end)) return { error: '請選擇結束日期' };
    if (end < f.start_date) return { error: '結束日期不能早於開始日期' };
    return { start: workWindow(f.start_date, s).ws, end: workWindow(end, s).we, mode };
  }
  if (mode === 'am' || mode === 'pm') {
    const w = workWindow(f.start_date, s);
    return mode === 'am' ? { start: w.ws, end: w.amEnd, mode } : { start: w.pmStart, end: w.we, mode };
  }
  if (mode === 'hours') {
    const endDate = f.end_date || f.start_date;
    if (!isTime(f.start_time) || !isTime(f.end_time) || !isDate(endDate)) return { error: '請選擇開始與結束時間' };
    const start = toEpoch(f.start_date, f.start_time), end = toEpoch(endDate, f.end_time);
    if (end <= start) return { error: '結束時間必須晚於開始時間' };
    return { start, end, mode };
  }
  return { error: '請選擇請假時段' };
}

// 顯示用文字
function leaveLabel(l) {
  const sd = dateOf(l.start_ts), ed = dateOf(l.end_ts - 1);
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  if (l.mode === 'am') return `${md(sd)} 上午`;
  if (l.mode === 'pm') return `${md(sd)} 下午`;
  if (l.mode === 'full') return sd === ed ? `${md(sd)} 全天` : `${md(sd)} ～ ${md(ed)} 全天`;
  return sd === dateOf(l.end_ts) ? `${md(sd)} ${timeOf(l.start_ts)}～${timeOf(l.end_ts)}` : `${md(sd)} ${timeOf(l.start_ts)} ～ ${md(dateOf(l.end_ts))} ${timeOf(l.end_ts)}`;
}

// 勞基法第 38 條特休天數（依「今天」的年資，週年制）
// 6 個月以上未滿 1 年：3 天；1 年：7 天；2 年：10 天；3、4 年：14 天；5～9 年：15 天；10 年以上每年加 1 天，最多 30 天
function statutoryAnnualDays(hireDate, onDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hireDate || '')) return null;
  const [hy, hm, hd] = hireDate.split('-').map(Number);
  const [ty, tm, td] = onDate.split('-').map(Number);
  let months = (ty - hy) * 12 + (tm - hm) - (td < hd ? 1 : 0);
  if (months < 6) return { days: 0, years: 0, months, note: '年資未滿 6 個月' };
  const years = Math.floor(months / 12);
  let days;
  if (years < 1) days = 3; else if (years < 2) days = 7; else if (years < 3) days = 10;
  else if (years < 5) days = 14; else if (years < 10) days = 15; else days = Math.min(30, 15 + (years - 9));
  return { days, years, months, note: years < 1 ? '年資滿 6 個月' : `年資滿 ${years} 年` };
}

module.exports = { setOffWeekday, isOffDay, calcLeave, rangeFromForm, workWindow, leaveLabel, statutoryAnnualDays, dateOf, timeOf, addDays, isWeekend, toEpoch };

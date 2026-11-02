// 共用工具
const TZ = 'Asia/Taipei';
let serverOffset = 0; // 伺服器時間 - 本機時間
function nowMs() { return Date.now() + serverOffset; }
function fmtClock(ms) {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(ms);
}
function fmtLongDate(ms) {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(ms);
}
function taipeiParts(ms) {
  const o = {};
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(ms).forEach((p) => (o[p.type] = p.value));
  return o;
}
function taipeiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(nowMs());
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// 通知（toast）：右上／頂部堆疊，含圖示，可多則同時顯示
function toast(msg, kind = '') {
  let wrap = document.querySelector('.toasts');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toasts'; wrap.setAttribute('role', 'status'); wrap.setAttribute('aria-live', 'polite'); document.body.appendChild(wrap); }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  const ic = kind === 'ok' ? 'check' : kind === 'err' ? 'alertCircle' : 'info';
  el.innerHTML = `<span class="toast-ic">${icon(ic, 18)}</span><span class="toast-msg"></span>`;
  el.querySelector('.toast-msg').textContent = msg;
  wrap.appendChild(el);
  while (wrap.children.length > 3) wrap.firstChild.remove();
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 250); }, kind === 'err' ? 4200 : 2800);
}
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error(data.error || '發生錯誤，請稍後再試'); err.status = res.status; err.data = data; throw err; }
  return data;
}
// 頭像：取名字最後的英數字，或最後兩個中文字
function avatarText(name) {
  const n = String(name || '').trim();
  const m = n.match(/[A-Za-z0-9]$/);
  if (m) return m[0].toUpperCase();
  return n.length >= 3 ? n.slice(-2) : n;
}
function avatarHue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) % 360; return h; }
function avatar(name, size = 'md') {
  return `<span class="avatar av-${size}" style="--h:${avatarHue(name)}" aria-hidden="true">${esc(avatarText(name))}</span>`;
}
function greetingInfo() {
  const h = Number(taipeiParts(nowMs()).hour);
  if (h < 11) return { text: '早安', icon: 'sunrise' };
  if (h < 18) return { text: '午安', icon: 'sun' };
  return { text: '晚安', icon: 'moon' };
}

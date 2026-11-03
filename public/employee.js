const $ = (id) => document.getElementById(id);
let token = localStorage.getItem('emp_token');
let me = null;
let pinEmp = null, pin = '';
hydrateIcons();

function auth() { return { Authorization: 'Bearer ' + token }; }
function show(view) {
  ['pickView', 'pinView', 'mainView'].forEach((v) => $(v).classList.toggle('hidden', v !== view));
  $('logoutBtn').classList.toggle('hidden', view !== 'mainView');
  $('statusLine').classList.toggle('hidden', view !== 'mainView');
  renderGreeting();
}

// ---------- 時鐘 ----------
function tick() {
  const n = nowMs(); const t = fmtClock(n);
  $('clockTime').innerHTML = `<span class="hm">${t.slice(0, 5)}</span><span class="sec">${t.slice(5)}</span>`;
  $('clockDate').textContent = fmtLongDate(n);
}
setInterval(tick, 1000);
function renderGreeting() {
  const g = greetingInfo();
  $('heroGreet').innerHTML = me && !$('mainView').classList.contains('hidden')
    ? `${icon(g.icon, 18)}<span>${g.text}，<b>${esc(me.employee.name)}</b></span>`
    : `${icon(g.icon, 18)}<span>${g.text}！今天也辛苦了</span>`;
}

async function init() {
  try {
    const info = await api('/api/public/info');
    serverOffset = info.server_time - Date.now();
    $('company').textContent = info.company_name;
  } catch (e) {}
  tick();
  if (token) {
    try { me = await api('/api/me', { headers: auth() }); renderMain(); show('mainView'); return; }
    catch (e) { localStorage.removeItem('emp_token'); token = null; }
  }
  showPick();
}

// ---------- 選擇姓名 / PIN ----------
async function showPick() {
  me = null;
  const list = await api('/api/public/employees');
  $('names').innerHTML = list.length ? list.map((e) => `<button class="name-btn" data-id="${e.id}" data-name="${esc(e.name)}">${avatar(e.name)}<span>${esc(e.name)}</span></button>`).join('')
    : `<div class="card empty" style="grid-column:1/-1"><span class="empty-ic">${icon('users', 26)}</span><b>尚未建立員工</b>請管理員先到後台新增員工。</div>`;
  document.querySelectorAll('.name-btn').forEach((b) => b.onclick = () => {
    pinEmp = { id: b.dataset.id, name: b.dataset.name }; pin = '';
    $('pinName').textContent = pinEmp.name; $('pinAvatar').innerHTML = avatar(pinEmp.name, 'lg');
    renderDots(); show('pinView');
  });
  show('pickView');
}
function renderDots() { [...$('pinDots').children].forEach((s, i) => s.classList.toggle('on', i < pin.length)); }
$('keypad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '返回', '0', '刪除'].map((k) => {
  if (k === '返回') return `<button class="fn" data-k="返回" aria-label="返回"><span>${icon('chevronLeft', 22)}返回</span></button>`;
  if (k === '刪除') return `<button class="fn" data-k="刪除" aria-label="刪除"><span>${icon('backspace', 22)}刪除</span></button>`;
  return `<button data-k="${k}">${k}</button>`;
}).join('');
$('keypad').onclick = async (e) => {
  const btn = e.target.closest('[data-k]'); if (!btn) return;
  const k = btn.dataset.k;
  if (k === '返回') return showPick();
  if (k === '刪除') { pin = pin.slice(0, -1); return renderDots(); }
  if (pin.length >= 4) return;
  pin += k; renderDots();
  if (pin.length === 4) {
    try {
      const r = await api('/api/login', { method: 'POST', body: { employee_id: pinEmp.id, pin } });
      token = r.token; localStorage.setItem('emp_token', token);
      me = await api('/api/me', { headers: auth() }); renderMain(); show('mainView');
    } catch (err) {
      toast(err.message, 'err'); $('pinDots').classList.add('shake');
      setTimeout(() => { $('pinDots').classList.remove('shake'); pin = ''; renderDots(); }, 450);
    }
  }
};

// ---------- 打卡條件 ----------
const KIND_IC = { wfh: 'home', trip: 'briefcase' };
function renderChecks() {
  const c = me.checks || {};
  const pills = [];
  if (c.arrangement) {
    // 已核准居家上班／公差：不需公司 WiFi，改為記錄 GPS
    const a = c.arrangement;
    pills.push(`<span class="pill ${a.kind}">${icon(KIND_IC[a.kind])}今天為${esc(a.text)}${a.destination ? `<span class="sub">（${esc(a.destination)}）</span>` : ''}，打卡將記錄 GPS 位置</span>`);
    if (!window.isSecureContext) pills.push(`<span class="pill bad">${icon('pin')}非 HTTPS 連線，無法定位</span>`);
    $('checkCard').innerHTML = pills.join('');
    $('checkCard').classList.remove('hidden');
    return;
  }
  if (c.pending_arrangement) pills.push(`<span class="pill neutral">${icon('hourglass')}今天的${esc(c.pending_arrangement.text)}申請審核中<span class="sub">（核准前仍依公司規定打卡）</span></span>`);
  if (c.require_network) pills.push(c.network_ok
    ? `<span class="pill ok">${icon('wifi')}已連上公司網路</span>`
    : `<span class="pill bad">${icon('wifiOff')}目前未連上公司 WiFi<span class="sub">（IP：${esc(c.ip)}）</span></span>`);
  if (c.require_location) pills.push(window.isSecureContext
    ? `<span class="pill neutral">${icon('pin')}打卡時會確認位置</span>`
    : `<span class="pill bad">${icon('pin')}非 HTTPS 連線，無法定位</span>`);
  if (c.relaxed_out && me.status === 'in' && c.network_ok === false) pills.push(`<span class="pill neutral">${icon('logout')}下班打卡不在公司也可以，會標記為「異地打卡」</span>`);
  $('checkCard').innerHTML = pills.join('');
  $('checkCard').classList.toggle('hidden', !pills.length);
}
function showBlocked(reasons) {
  if (!reasons || !reasons.length) { $('blockCard').classList.add('hidden'); return; }
  const remote = me && me.checks && me.checks.arrangement;
  $('blockCard').innerHTML = `<h4>${icon('ban')}無法打卡</h4><ul>${reasons.map((r) => `<li>${icon(/WiFi|IP/.test(r) ? 'wifiOff' : 'pin', 16)}<span>${esc(r)}</span></li>`).join('')}</ul>
    <div class="tip">${remote ? `${esc(remote.text)}打卡需要定位：請在手機「設定 → 隱私權 → 定位服務」或瀏覽器的網站設定中，允許此網站使用位置，再按一次。` : '若您確實在公司，請改善上述狀況後再按一次；仍無法打卡請通知管理員補登。'}</div>`;
  $('blockCard').classList.remove('hidden');
  // 讓重新渲染時保留動畫
  $('blockCard').style.animation = 'none'; void $('blockCard').offsetWidth; $('blockCard').style.animation = '';
}
const GEO_MSG = {
  denied: '您拒絕了定位權限，請到手機設定或瀏覽器網站設定中允許此網站使用位置。',
  unavailable: '無法取得您的位置，請確認手機已開啟定位服務（GPS）。',
  timeout: '定位逾時，請移動到窗邊或訊號較好的地方再試一次。',
  insecure: '定位功能需要 HTTPS 安全連線，請使用 https:// 開頭的網址。',
  unsupported: '此瀏覽器不支援定位功能。',
};
function getLocation() {
  return new Promise((resolve) => {
    if (!window.isSecureContext) return resolve({ loc_error: 'insecure' });
    if (!navigator.geolocation) return resolve({ loc_error: 'unsupported' });
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ location: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } }),
      (err) => resolve({ loc_error: err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}
function busy(text) {
  let el = document.querySelector('.busy');
  if (!text) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.className = 'busy'; document.body.appendChild(el); }
  el.innerHTML = `<div class="busy-card"><div class="spinner"></div><div>${esc(text)}</div></div>`;
}

// ---------- 主畫面 ----------
function workBadges(x) {
  return (x.work_mode ? `<span class="badge b-${x.work_mode}">${icon(KIND_IC[x.work_mode])}${x.work_mode === 'wfh' ? '居家' : '公差'}</span>` : '')
    + (x.offsite ? `<span class="badge b-offsite">${icon('mapPinOff')}異地打卡</span>` : '');
}
const addDaysStr = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function holBadge(h) {
  if (!h) return '';
  return h.off ? `<span class="badge b-holiday" title="${esc(h.kind_text)}">${icon('flag')}${esc(h.name)}</span>` : `<span class="badge b-neutral" title="${esc(h.note || '')}">${icon('repeat')}調移上班</span>`;
}
function renderMain() {
  renderChecks();
  renderGreeting();
  $('hello').textContent = `${me.employee.name}，${greetingInfo().text}！`;
  const s = me.today_summary;
  const lastIn = [...me.today_punches].reverse().find((p) => p.type === 'in');
  const lastOut = [...me.today_punches].reverse().find((p) => p.type === 'out');
  let html = '';
  if (me.status === 'none') html = '<span class="chip"><span class="dot"></span>今天尚未打卡</span>';
  else if (me.status === 'in') html = `<span class="chip on"><span class="dot"></span>上班中<span class="sub">自 ${lastIn.time} 開始</span></span>`;
  else html = `<span class="chip off"><span class="dot"></span>已下班<span class="sub">今日工時 ${s ? s.worked_text : ''}</span></span>`;
  if (s && s.late) html += `<span class="chip late">${icon('alertCircle', 15)}遲到 ${s.late_min} 分鐘</span>`;
  if (s && s.leave_text) html += `<span class="chip leave">${icon('palm', 15)}今日請假<span class="sub">${esc(s.leave_text)}</span></span>`;
  const th = me.today_holiday;
  if (th) html += `<span class="chip holiday">${icon(th.off ? 'flag' : 'repeat', 15)}${th.off ? `今天放假・${esc(th.name)}` : '調移上班日'}</span>`;
  const arr = me.checks && me.checks.arrangement;
  if (arr) html += `<span class="chip ${arr.kind}">${icon(KIND_IC[arr.kind], 15)}${esc(arr.text)}</span>`;
  $('statusLine').innerHTML = html;

  $('btnIn').disabled = me.status === 'in';
  $('btnOut').disabled = me.status !== 'in';
  $('btnInSub').textContent = me.status === 'in' ? `已於 ${lastIn.time} 上班` : me.status === 'out' ? '再次上班' : '開始工作';
  $('btnOutSub').textContent = me.status === 'in' ? '結束工作' : me.status === 'out' ? `已於 ${lastOut.time} 下班` : '請先打上班卡';

  $('todayList').innerHTML = me.today_punches.length ? `<ul class="timeline">${me.today_punches.map((p) => `
    <li><span class="tl-dot ${p.type}">${icon(p.type === 'in' ? 'login' : 'logout', 13)}</span>
      <span class="tl-time">${p.time}</span>
      <span class="tl-text">${p.type_text}打卡</span>
      ${p.edited ? `<span class="badge b-neutral">${icon('pencil')}管理員修改</span>` : '<span class="badge b-success">本人打卡</span>'}${workBadges(p)}</li>`).join('')}</ul>`
    : `<div class="empty" style="padding:22px 8px"><span class="empty-ic">${icon('clock', 24)}</span>今天還沒有打卡紀錄</div>`;

  const std = (me.settings && me.settings.standard_hours) || 8;
  // 最近 14 天：打卡／請假紀錄＋放假日（國定假日、補假、公司假日）
  const holMap = new Map((me.holidays || []).map((h) => [h.date, h]));
  const seen = new Set(me.recent.map((r) => r.date));
  const past = [...me.recent, ...(me.holidays || []).filter((h) => h.off && !h.weekend && h.date <= me.today && !seen.has(h.date) && h.date >= addDaysStr(me.today, -13)).map((h) => ({ date: h.date, weekday: h.weekday, holiday_only: true, holiday: h }))]
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  $('recentHint').textContent = past.length ? `共 ${past.length} 天` : '';
  $('recentList').innerHTML = past.length ? past.map((r) => {
    const [, lm, ld] = r.date.split('-');
    const hb = holBadge(r.holiday || holMap.get(r.date));
    if (r.holiday_only) return `<div class="day is-hol">
      <div class="day-date"><span class="md">${Number(lm)}/${Number(ld)}</span><span class="wd">週${r.weekday}</span></div>
      <div style="min-width:0"><div class="day-times">${icon('flag', 14)}${esc(r.holiday.name)}</div><div class="bar"><i style="width:0"></i></div></div>
      <div class="day-right"><div class="day-hours">放假</div><div class="badges">${hb}</div></div>
    </div>`;
    if (r.leave_only) return `<div class="day">
      <div class="day-date"><span class="md">${Number(lm)}/${Number(ld)}</span><span class="wd">週${r.weekday}</span></div>
      <div style="min-width:0"><div class="day-times">${icon('palm', 14)}${esc(r.leave_text)}</div><div class="bar"><i class="used" style="width:${Math.min(100, (r.leave_hours / std) * 100)}%"></i></div></div>
      <div class="day-right"><div class="day-hours">請假</div><div class="badges"><span class="badge b-accent">${r.leave_hours}h</span></div></div>
    </div>`;
    const pct = Math.min(100, (r.worked_hours / std) * 100);
    const [, m, d] = r.date.split('-');
    const badges = [
      hb,
      r.late ? `<span class="badge b-danger">${icon('alertCircle')}遲到 ${r.late_min} 分</span>` : '',
      r.overtime_ms ? `<span class="badge b-info">${icon('trend')}加班 ${r.overtime_hours}h</span>` : '',
      ...r.issues.map((i) => `<span class="badge b-warning">${icon('alert')}${esc(i)}</span>`),
      r.working_now ? '<span class="badge b-success"><span class="dot"></span>上班中</span>' : '',
      r.leave_text ? `<span class="badge b-accent">${icon('palm')}${esc(r.leave_text)}</span>` : '',
      workBadges(r),
    ].join('');
    return `<div class="day">
      <div class="day-date"><span class="md">${Number(m)}/${Number(d)}</span><span class="wd">週${r.weekday}</span></div>
      <div style="min-width:0">
        <div class="day-times">${icon('login', 14)}${r.first_in || '--:--'}<span class="muted">→</span>${r.last_out || (r.working_now ? '上班中' : '--:--')}</div>
        <div class="bar"><i class="${r.overtime_ms ? 'ot' : ''}" style="width:${pct}%"></i></div>
      </div>
      <div class="day-right"><div class="day-hours">${r.worked_text.replace(' 小時 ', 'h ').replace(' 分', 'm')}</div>${badges ? `<div class="badges">${badges}</div>` : ''}</div>
    </div>`;
  }).join('') : `<div class="card empty"><span class="empty-ic">${icon('calendar', 24)}</span>最近沒有打卡紀錄</div>`;
  if (!lv) loadLeave();
}

// ---------- 打卡 ----------
function askConfirm(type) {
  return new Promise((resolve) => {
    const isIn = type === 'in';
    $('confirmIc').className = 's-ic ' + type; $('confirmIc').innerHTML = icon(isIn ? 'login' : 'logout', 28);
    $('confirmTitle').textContent = isIn ? '確認上班打卡' : '確認下班打卡';
    $('confirmTime').textContent = fmtClock(nowMs()).slice(0, 5);
    const c = me.checks || {};
    $('confirmNote').textContent = c.arrangement ? `今天為${c.arrangement.text}，按下確認後會記錄您的 GPS 位置` : c.location_for && c.location_for[type] ? '按下確認後會取得您的位置' : fmtLongDate(nowMs());
    $('confirmOk').className = 'btn ' + (isIn ? '' : 'go-out');
    $('confirmSheet').classList.remove('hidden');
    $('confirmOk').focus();
    const done = (v) => { $('confirmSheet').classList.add('hidden'); $('confirmOk').onclick = $('confirmCancel').onclick = $('confirmSheet').onclick = null; resolve(v); };
    $('confirmOk').onclick = () => done(true);
    $('confirmCancel').onclick = () => done(false);
    $('confirmSheet').onclick = (e) => { if (e.target === $('confirmSheet')) done(false); };
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('confirmSheet').classList.contains('hidden')) $('confirmCancel').click();
  else if (!$('leaveSheet').classList.contains('hidden')) closeLeaveForm();
});
// 通用確認面板（取消請假等）
function askSheet({ ic, tone, title, big, note, ok, okCls }) {
  return new Promise((resolve) => {
    $('confirmIc').className = 's-ic ' + (tone || ''); $('confirmIc').innerHTML = icon(ic, 28);
    $('confirmTitle').textContent = title;
    $('confirmTime').className = 's-big'; $('confirmTime').textContent = big || '';
    $('confirmNote').textContent = note || '';
    $('confirmOk').className = 'btn ' + (okCls || ''); $('confirmOk').textContent = ok;
    $('confirmCancel').textContent = '返回';
    $('confirmSheet').classList.remove('hidden'); $('confirmCancel').focus();
    const done = (v) => {
      $('confirmSheet').classList.add('hidden'); $('confirmOk').onclick = $('confirmCancel').onclick = $('confirmSheet').onclick = null;
      $('confirmTime').className = 's-time'; $('confirmOk').textContent = '確認打卡'; $('confirmCancel').textContent = '取消';
      resolve(v);
    };
    $('confirmOk').onclick = () => done(true);
    $('confirmCancel').onclick = () => done(false);
    $('confirmSheet').onclick = (e) => { if (e.target === $('confirmSheet')) done(false); };
  });
}

function celebrate(type, message) {
  const isIn = type === 'in';
  const s = me.today_summary;
  const time = (message.match(/\d{2}:\d{2}/) || [''])[0];
  const badges = [];
  if (isIn && s && s.late) badges.push(`<span class="badge b-danger">${icon('alertCircle')}遲到 ${s.late_min} 分鐘</span>`);
  if (isIn && s && !s.late) badges.push(`<span class="badge b-success">${icon('check')}準時</span>`);
  if (!isIn && s) badges.push(`<span class="badge b-brand">${icon('timer')}今日工時 ${s.worked_text}</span>`);
  if (celebrate.extra && celebrate.extra.offsite) badges.push(`<span class="badge b-offsite">${icon('mapPinOff')}已記錄為異地打卡</span>`);
  if (celebrate.extra && celebrate.extra.work_mode) badges.push(`<span class="badge b-${celebrate.extra.work_mode}">${icon(KIND_IC[celebrate.extra.work_mode])}${celebrate.extra.work_mode === 'wfh' ? '居家上班' : '公差'}・已記錄 GPS</span>`);
  $('successOverlay').innerHTML = `<div class="success-card ${type}">
    <svg class="ring" viewBox="0 0 104 104" aria-hidden="true"><circle class="bgc" cx="52" cy="52" r="48"/><circle cx="52" cy="52" r="48"/><path d="M34 53 l12 12 l24 -26"/></svg>
    <h3>${isIn ? '上班打卡成功' : '下班打卡成功'}</h3>
    <div class="s-time">${time}</div>
    <p>${isIn ? '祝您今天工作順利！' : '辛苦了，好好休息！'}</p>
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
  </div>`;
  $('successOverlay').classList.remove('hidden');
  $('successOverlay').classList.add('show');
  const css = getComputedStyle(document.documentElement), P = css.getPropertyValue('--c-primary').trim() || '#8F6E56', A = css.getPropertyValue('--c-accent').trim() || '#A06357';
  const colors = isIn ? [P, A, P, '#E8DCD2'] : [A, P, A, '#E8DCD2'];
  const conf = document.createElement('div'); conf.className = 'confetti';
  conf.innerHTML = Array.from({ length: 26 }, (_, i) => {
    const a = (i / 26) * Math.PI * 2, dist = 140 + Math.random() * 120;
    return `<i style="background:${colors[i % colors.length]};--x:${Math.cos(a) * dist}px;--y:${Math.sin(a) * dist - 40}px;--r:${Math.random() * 540}deg;animation-delay:${0.35 + Math.random() * .15}s"></i>`;
  }).join('');
  document.body.appendChild(conf);
  const close = () => { $('successOverlay').classList.add('hidden'); $('successOverlay').classList.remove('show'); conf.remove(); };
  $('successOverlay').onclick = close;
  clearTimeout(celebrate.t); celebrate.t = setTimeout(close, 2600);
}

async function punch(type) {
  if (!(await askConfirm(type))) return;
  $('btnIn').disabled = $('btnOut').disabled = true;
  showBlocked(null);
  try {
    const body = { type };
    const c = me.checks || {};
    if (c.location_for ? c.location_for[type] : c.require_location) {
      busy(c.arrangement ? '正在記錄您的 GPS 位置…' : '正在確認您的位置…');
      Object.assign(body, await getLocation());
      busy(null);
      if (body.loc_error && (!c.location_required || c.location_required[type])) toast(GEO_MSG[body.loc_error], 'err');
    }
    const r = await api('/api/punch', { method: 'POST', headers: auth(), body });
    me = r; renderMain(); celebrate.extra = { offsite: r.offsite, work_mode: r.work_mode }; celebrate(type, r.message);
    if (navigator.vibrate) navigator.vibrate([30, 40, 60]);
  } catch (e) {
    busy(null);
    if (e.data && e.data.blocked) { showBlocked(e.data.reasons); toast('打卡未成功，請看下方說明', 'err'); }
    else toast(e.message, 'err');
    if (e.status === 401) { localStorage.removeItem('emp_token'); token = null; return showPick(); }
    try { me = await api('/api/me', { headers: auth() }); renderMain(); } catch (_) {}
  }
}
$('btnIn').onclick = () => punch('in');
$('btnOut').onclick = () => punch('out');
$('logoutBtn').onclick = async () => {
  try { await api('/api/logout', { method: 'POST', headers: auth() }); } catch (e) {}
  localStorage.removeItem('emp_token'); token = null; me = null; lv = null; showBlocked(null); setTab('punch'); showPick();
};
// 回到頁面時更新狀態（例如手機螢幕關閉後再打開）
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden && token) { try { me = await api('/api/me', { headers: auth() }); renderMain(); if (curTab === 'leave') loadLeave(); } catch (e) {} }
});

// =========================================================
// 請假
// =========================================================
let curTab = 'punch', lv = null, lfFile = null, previewSeq = 0, previewOk = false;
const STATUS_BADGE = { pending: ['b-warning', 'hourglass'], approved: ['b-success', 'check'], rejected: ['b-danger', 'x'], cancelled: ['b-neutral', 'undo'] };
const WD = ['日', '一', '二', '三', '四', '五', '六'];
const mdw = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${m}/${dd}（${WD[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]}）`; };
function fmtH(h) { const std = (lv && lv.balance.std_hours) || 8; if (!h) return '0 小時'; const d = h / std; return Number.isInteger(d) ? `${d} 天` : Math.abs(h) >= std ? `${Math.floor(d)} 天 ${+(h - Math.floor(d) * std).toFixed(2)} 小時` : `${h} 小時`; }

function setTab(t) {
  curTab = t;
  document.querySelectorAll('[data-etab]').forEach((b) => { const on = b.dataset.etab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  $('punchPane').classList.toggle('hidden', t !== 'punch');
  $('leavePane').classList.toggle('hidden', t !== 'leave');
  $('slipPane').classList.toggle('hidden', t !== 'slip');
  if (t === 'leave') loadLeave();
  if (t === 'slip') loadSlips();
}
document.querySelectorAll('[data-etab]').forEach((b) => b.onclick = () => setTab(b.dataset.etab));

async function loadLeave() {
  try { lv = await api('/api/leaves', { headers: auth() }); renderLeave(); }
  catch (e) { if (e.status === 401) { localStorage.removeItem('emp_token'); token = null; return showPick(); } toast(e.message, 'err'); }
}
function whenText(l) {
  if (l.kind && l.kind !== 'leave') return l.start_date === l.end_date ? `${mdw(l.start_date)} 全天` : `${mdw(l.start_date)} ～ ${mdw(l.end_date)}`;
  if (l.mode === 'full') return l.start_date === l.end_date ? `${mdw(l.start_date)} 全天` : `${mdw(l.start_date)} ～ ${mdw(l.end_date)} 全天`;
  if (l.mode === 'am' || l.mode === 'pm') { const d = l.days[0]; return `${mdw(l.start_date)} ${l.mode_text}${d ? `（${d.from}～${d.to}）` : ''}`; }
  const st = l.start_text.slice(11), et = l.end_text.slice(11);
  return l.start_date === l.end_text.slice(0, 10) ? `${mdw(l.start_date)} ${st}～${et}` : `${mdw(l.start_date)} ${st} ～ ${mdw(l.end_text.slice(0, 10))} ${et}`;
}
function renderHolUp() {
  const up = (me && me.holidays || []).filter((h) => h.off && !h.weekend && h.date >= me.today).slice(0, 4);
  $('holUp').classList.toggle('hidden', !up.length);
  $('holUp').innerHTML = up.length ? `<div class="hu-t">${icon('flag', 16)}近期放假日<span class="muted">不需請假</span></div><div class="hu-list">${up.map((h) => `<span class="hu-i"><b>${esc(mdw(h.date))}</b>${esc(h.name)}</span>`).join('')}</div>` : '';
}
function renderLeave() {
  renderHolUp();
  const b = lv.balance;
  const pend = lv.requests.filter((r) => r.status === 'pending').length;
  $('leavePendCount').textContent = pend || '';
  if (b.quota_hours > 0) {
    const used = Math.min(100, (b.used_hours / b.quota_hours) * 100), pp = Math.min(100 - used, (b.pending_hours / b.quota_hours) * 100);
    $('balCard').innerHTML = `<div class="bal-top"><span class="bal-ic">${icon('palm', 24)}</span>
        <div><div class="bal-l">${b.year} 年特休剩餘</div><div class="bal-num">${fmtH(b.remaining_hours)}<small>${b.remaining_hours} 小時</small></div></div></div>
      <div class="bar" style="margin:0;height:8px" aria-hidden="true"><i class="used" style="width:${used}%"></i><i class="pend" style="left:${used}%;width:${pp}%"></i></div>
      <div class="bal-meta"><span>年度額度 <b>${fmtH(b.quota_hours)}</b></span><span>已使用 <b>${fmtH(b.used_hours)}</b></span>${b.pending_hours ? `<span>審核中 <b>${fmtH(b.pending_hours)}</b></span>` : ''}</div>`;
  } else {
    $('balCard').innerHTML = `<div class="bal-top"><span class="bal-ic">${icon('palm', 24)}</span><div><div class="bal-l">${b.year} 年特休</div><div style="font-weight:600">尚未設定特休額度</div><div class="help" style="margin:0">如有疑問請洽管理員</div></div></div>`;
  }
  $('leaveHint').textContent = lv.requests.length ? `共 ${lv.requests.length} 筆` : '';
  $('leaveList').innerHTML = lv.requests.length ? lv.requests.map((l) => {
    const [bc, bi] = STATUS_BADGE[l.status];
    const work = l.kind && l.kind !== 'leave';
    return `<article class="card leave-item ${l.status}">
      <div class="lv-head">
        <span class="lv-ic ${work ? l.kind : l.deduct_annual ? 'annual' : ''}">${icon(work ? KIND_IC[l.kind] : l.deduct_annual ? 'palm' : 'calendar', 20)}</span>
        <div style="min-width:0"><div class="lv-title">${esc(l.type_name)} <span class="muted">· ${esc(l.hours_text)}</span></div><div class="lv-when">${esc(whenText(l))}</div></div>
        <span class="badge ${bc}">${icon(bi)}${l.status_text}</span>
      </div>
      ${l.destination ? `<div class="lv-dest">${icon('navigation', 14)}${esc(l.destination)}</div>` : ''}
      <div class="lv-reason">${esc(l.reason)}</div>
      ${l.admin_comment ? `<div class="lv-comment ${l.status === 'rejected' ? 'rej' : ''}">${icon('message', 16)}<span><b>${esc(l.decided_by || '管理員')}：</b>${esc(l.admin_comment)}</span></div>` : ''}
      <div class="lv-foot"><span class="meta">申請於 ${esc(l.created_text)}${l.decided_by && (l.status === 'approved' || l.status === 'rejected') ? `<br>${l.status === 'approved' ? '核准' : '退回'}：${esc(l.decided_by)}・${esc(l.decided_text)}` : ''}</span><span class="grow"></span>
        ${l.has_attachment ? `<button class="btn ghost sm" data-att="${l.id}">${icon('paperclip', 16)}查看附件</button>` : ''}
        ${l.status === 'pending' ? `<button class="btn danger-ghost sm" data-cancel="${l.id}">${icon('undo', 16)}取消申請</button>` : ''}
      </div>
    </article>`;
  }).join('') : `<div class="card empty"><span class="empty-ic">${icon('calendar', 24)}</span><b>還沒有申請紀錄</b>按上方按鈕即可申請請假、居家上班或公差</div>`;
  $('leaveList').querySelectorAll('[data-cancel]').forEach((btn) => btn.onclick = () => cancelLeave(Number(btn.dataset.cancel)));
  $('leaveList').querySelectorAll('[data-att]').forEach((btn) => btn.onclick = () => openAttachment(Number(btn.dataset.att)));
}
async function cancelLeave(id) {
  const l = lv.requests.find((x) => x.id === id);
  const ok = await askSheet({ ic: 'undo', tone: 'danger', title: `取消這筆${l.kind && l.kind !== 'leave' ? l.type_name : '請假'}申請？`, big: `${l.type_name} · ${l.hours_text}`, note: whenText(l), ok: '確定取消', okCls: 'go-danger' });
  if (!ok) return;
  try { await api(`/api/leaves/${id}/cancel`, { method: 'POST', headers: auth() }); toast('已取消申請', 'ok'); loadLeave(); }
  catch (e) { toast(e.message, 'err'); loadLeave(); }
}
async function openAttachment(id) {
  const w = window.open('', '_blank');
  try {
    const r = await fetch(`/api/leaves/${id}/attachment`, { headers: auth() });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '無法開啟附件');
    const url = URL.createObjectURL(await r.blob());
    if (w) w.location = url; else location.href = url;
  } catch (e) { if (w) w.close(); toast(e.message, 'err'); }
}

// ---- 申請表單 ----
function nextWorkday() { let d = taipeiToday(); do { d = addDays(d, 1); } while ([0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay())); return d; }
function curKind() { return (document.querySelector('input[name=lfKind]:checked') || {}).value || 'leave'; }
function workType(kind) { return (lv.work_types || []).find((t) => t.kind === kind); }
function formVal() {
  const kind = curKind();
  if (kind !== 'leave') {
    const t = workType(kind);
    return { kind, type_id: t ? t.id : 0, mode: 'full', start_date: $('lfStart').value, end_date: $('lfEnd').value || $('lfStart').value, reason: $('lfReason').value.trim(), destination: kind === 'trip' ? $('lfDest').value.trim() : '' };
  }
  const mode = (document.querySelector('input[name=lfMode]:checked') || {}).value;
  return { kind, type_id: Number((document.querySelector('input[name=lfType]:checked') || {}).value || 0), mode, start_date: $('lfStart').value,
    end_date: mode === 'full' ? ($('lfEnd').value || $('lfStart').value) : '', start_time: $('lfStartT').value, end_time: $('lfEndT').value, reason: $('lfReason').value.trim() };
}
function selectedType() { const id = formVal().type_id; return lv.types.find((t) => t.id === id); }
const KIND_FORM = {
  leave: { title: '申請請假', ic: 'calendarPlus', reason: '請假原因', ph: '例如：家庭旅遊、身體不適就醫' },
  wfh: { title: '申請居家上班', ic: 'home', reason: '事由', ph: '例如：家中有事需在家，遠端處理報表與客戶信件' },
  trip: { title: '申請公差', ic: 'briefcase', reason: '公差事由', ph: '例如：拜訪客戶、參加展覽、外出送貨' },
};
function syncForm() {
  const f = formVal();
  const kf = KIND_FORM[f.kind];
  $('leaveSheetTitle').textContent = kf.title;
  $('leaveSheet').querySelector('.fs-head .s-ic').className = `s-ic ${f.kind}`;
  $('leaveSheet').querySelector('.fs-head .s-ic').innerHTML = icon(kf.ic, 22);
  $('lfReasonLabel').textContent = kf.reason; $('lfReason').placeholder = kf.ph;
  const work = f.kind !== 'leave';
  $('lfTypeField').classList.toggle('hidden', work); $('lfModeField').classList.toggle('hidden', work); $('lfAttField').classList.toggle('hidden', work);
  $('lfDestField').classList.toggle('hidden', f.kind !== 'trip');
  if (work) {
    $('leaveWorkHint').textContent = '不扣假，算正常出勤；核准後當天打卡免連公司 WiFi，但需開啟定位（GPS）';
    $('lfEndWrap').classList.remove('hidden'); $('lfTimes').classList.add('hidden'); $('lfDates').classList.add('row2');
    $('lfStartLabel').textContent = '開始日期';
    if ($('lfEnd').value && $('lfEnd').value < $('lfStart').value) $('lfEnd').value = $('lfStart').value;
    $('lfEnd').min = $('lfStart').value;
    $('lfTypeHint').classList.add('hidden');
    return preview();
  }
  const w = lv.work; $('leaveWorkHint').textContent = `上班 ${w.work_start}～${w.work_end}${w.lunch_enabled ? `，午休 ${w.lunch_start}～${w.lunch_end}` : ''}`;
  $('lfEndWrap').classList.toggle('hidden', f.mode !== 'full');
  $('lfTimes').classList.toggle('hidden', f.mode !== 'hours');
  $('lfDates').classList.toggle('row2', f.mode === 'full');
  $('lfStartLabel').textContent = f.mode === 'full' ? '開始日期' : '日期';
  if (f.mode === 'full' && $('lfEnd').value && $('lfEnd').value < $('lfStart').value) $('lfEnd').value = $('lfStart').value;
  $('lfEnd').min = $('lfStart').value;
  const t = selectedType();
  $('lfTypeHint').classList.toggle('hidden', !t || (!t.needs_attachment && !t.deduct_annual));
  if (t) $('lfTypeHint').innerHTML = t.deduct_annual ? `${icon('info', 14)} 特休會從年度額度扣除，目前可用 ${fmtH(Math.max(0, lv.balance.available_hours))}` : `${icon('paperclip', 14)} 建議附上證明文件`;
  preview();
}
let pvTimer = null;
function preview() { clearTimeout(pvTimer); pvTimer = setTimeout(doPreview, 180); }
async function doPreview() {
  const f = formVal(); const seq = ++previewSeq; const box = $('lfPreview');
  previewOk = false;
  if (f.kind !== 'leave') {
    if (!f.start_date) { box.className = 'preview-box'; box.innerHTML = `<div class="muted">${icon('calendar', 16)} 選好日期後會顯示天數</div>`; return; }
    try {
      const r = await api('/api/leaves/preview', { method: 'POST', headers: auth(), body: f });
      if (seq !== previewSeq) return;
      previewOk = true;
      box.className = `preview-box ${f.kind}`;
      box.innerHTML = `<div class="pv-total">${icon(KIND_IC[f.kind], 18)}${f.kind === 'wfh' ? '居家上班' : '公差'} ${r.days_count} 天</div>
        <div class="pv-days"><div><span>${esc(r.days.length > 1 ? `${mdw(r.days[0].date)} ～ ${mdw(r.days[r.days.length - 1].date)}` : mdw(r.days[0].date))}</span><span>不扣假</span></div></div>
        <div class="pv-bal">${icon('pin', 14)} 核准後，這些日子打卡不需公司 WiFi，但必須允許定位（記錄 GPS）</div>`;
    } catch (e) { if (seq !== previewSeq) return; box.className = 'preview-box err'; box.innerHTML = `<div class="pv-total">${icon('alertCircle', 18)}${esc(e.message)}</div>`; }
    return;
  }
  if (!f.mode || !f.start_date || (f.mode === 'hours' && (!f.start_time || !f.end_time))) { box.className = 'preview-box'; box.innerHTML = `<div class="muted">${icon('timer', 16)} 選好日期後會自動計算時數</div>`; return; }
  try {
    const r = await api('/api/leaves/preview', { method: 'POST', headers: auth(), body: f });
    if (seq !== previewSeq) return;
    const t = selectedType();
    if (!r.hours) { box.className = 'preview-box err'; box.innerHTML = `<div class="pv-total">${icon('alertCircle', 18)}所選時間不含上班時段</div><div>${r.holidays_skipped && r.holidays_skipped.length ? `${r.holidays_skipped.map((x) => esc(x.name)).join('、')}放假，` : ''}週六、週日、國定假日與下班時間不需要請假</div>`; return; }
    previewOk = true;
    let bal = '';
    if (t && t.deduct_annual) {
      const after = +(lv.balance.available_hours - r.hours).toFixed(2);
      bal = after < 0 ? `<div class="pv-bal bad">${icon('alertCircle', 14)} 特休可用 ${fmtH(Math.max(0, lv.balance.available_hours))}，不足本次 ${fmtH(r.hours)}</div>`
        : `<div class="pv-bal">送出後特休可用：${fmtH(lv.balance.available_hours)} → <b>${fmtH(after)}</b></div>`;
    }
    box.className = 'preview-box';
    box.innerHTML = `<div class="pv-total">${icon('timer', 18)}共 ${esc(r.hours_text)}</div>
      ${r.days.length > 1 || f.mode !== 'full' ? `<div class="pv-days">${r.days.map((d) => `<div><span>${mdw(d.date)} ${d.from}～${d.to}</span><span>${d.hours} 小時</span></div>`).join('')}</div>` : `<div class="pv-days"><div><span>${mdw(r.days[0].date)} ${r.days[0].from}～${r.days[0].to}</span><span>扣除午休</span></div></div>`}
      ${r.holidays_skipped && r.holidays_skipped.length ? `<div class="pv-bal">${icon('flag', 14)} 已略過放假日：${r.holidays_skipped.map((x) => `${esc(mdw(x.date))} ${esc(x.name)}`).join('、')}（不計請假）</div>` : ''}
      ${bal}`;
  } catch (e) { if (seq !== previewSeq) return; box.className = 'preview-box err'; box.innerHTML = `<div class="pv-total">${icon('alertCircle', 18)}${esc(e.message)}</div>`; }
}
function openLeaveForm(kind = 'leave') {
  if (!lv) return;
  const w = lv.work;
  openLeaveForm.from = kind === 'leave' ? 'newLeave' : 'newWork';
  const kinds = [['leave', '請假', 'palm'], ...(lv.work_types || []).map((t) => [t.kind, t.name, KIND_IC[t.kind]])];
  if (!kinds.some((k) => k[0] === kind)) kind = 'leave';
  $('lfKinds').innerHTML = kinds.map(([v, t, ic]) => `<label class="opt kind-${v}"><input type="radio" name="lfKind" value="${v}" ${v === kind ? 'checked' : ''}><span>${icon(ic, 18)}${esc(t)}</span></label>`).join('');
  $('lfDest').value = '';
  $('lfTypes').innerHTML = lv.types.map((t, i) => `<label class="opt"><input type="radio" name="lfType" value="${t.id}" ${i === 0 ? 'checked' : ''}><span>${esc(t.name)}</span></label>`).join('');
  $('lfModes').innerHTML = [['full', '全天', ''], ['am', '上午', w.am], ['pm', '下午', w.pm], ['hours', '指定時間', '']]
    .map(([v, t, sub], i) => `<label class="opt"><input type="radio" name="lfMode" value="${v}" ${i === 0 ? 'checked' : ''}><span>${t}${sub ? `<small>${sub}</small>` : ''}</span></label>`).join('');
  const d = kind === 'leave' ? nextWorkday() : taipeiToday();
  $('lfStart').value = d; $('lfEnd').value = d; $('lfStart').min = addDays(taipeiToday(), -60);
  $('lfStartT').value = w.work_start; $('lfEndT').value = w.lunch_enabled ? w.lunch_start : w.work_end;
  $('lfReason').value = ''; clearFile();
  $('leaveSheet').classList.remove('hidden');
  $('leaveForm').scrollTop = 0;
  syncForm();
  setTimeout(() => { const c = document.querySelector('input[name=lfKind]:checked'); if (c) c.focus(); }, 50);
}
function closeLeaveForm() { $('leaveSheet').classList.add('hidden'); $(openLeaveForm.from || 'newLeave').focus(); }
function clearFile() { lfFile = null; $('lfFile').value = ''; $('lfFileChosen').classList.add('hidden'); $('lfFilePick').classList.remove('hidden'); }
$('lfFile').onchange = () => {
  const f = $('lfFile').files[0]; if (!f) return clearFile();
  if (f.size > 5 * 1024 * 1024) { toast('附件不能超過 5MB，請壓縮或改拍一張', 'err'); return clearFile(); }
  if (!/^image\/|application\/pdf/.test(f.type) && !/\.(heic|heif|pdf|jpe?g|png|gif|webp)$/i.test(f.name)) { toast('附件只接受圖片或 PDF', 'err'); return clearFile(); }
  lfFile = f; $('lfFileName').textContent = `${f.name}（${f.size >= 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB'}）`;
  $('lfFileChosen').classList.remove('hidden'); $('lfFilePick').classList.add('hidden');
};
$('lfFileClear').onclick = clearFile;
$('newLeave').onclick = () => openLeaveForm('leave');
$('newWork').onclick = () => openLeaveForm('wfh');
$('lfCancel').onclick = closeLeaveForm;
$('leaveSheet').onclick = (e) => { if (e.target === $('leaveSheet')) closeLeaveForm(); };
$('leaveForm').addEventListener('change', syncForm);
['lfStart', 'lfEnd', 'lfStartT', 'lfEndT'].forEach((id) => $(id).addEventListener('input', syncForm));
const readFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('讀取附件失敗')); r.readAsDataURL(f); });
$('leaveForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = formVal();
  if (!f.type_id) return toast(f.kind === 'leave' ? '請選擇假別' : '目前未開放此申請類型', 'err');
  if (!f.reason) { $('lfReason').focus(); return toast(`請填寫${KIND_FORM[f.kind].reason}`, 'err'); }
  const btn = $('lfSubmit'); btn.disabled = true;
  try {
    if (lfFile && f.kind === 'leave') f.attachment = { name: lfFile.name, data: await readFile(lfFile) };
    const r = await api('/api/leaves', { method: 'POST', headers: auth(), body: f });
    closeLeaveForm(); toast(r.message, 'ok'); await loadLeave();
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; }
};

init();

// =========================================================
// 我的薪資單（只顯示公司已確認的月份）
// =========================================================
async function loadSlips() {
  $('slipList').innerHTML = '<div class="card empty-card muted">載入中…</div>';
  try {
    const r = await api('/api/payslips', { headers: auth() });
    $('slipHint').textContent = r.list.length ? `共 ${r.list.length} 份` : '';
    $('slipNote').innerHTML = `${icon('info', 14)} 只會顯示公司已確認的月份。${r.protected ? `PDF 已加密保護，${esc(r.password_hint)}。` : ''}試算僅供參考，請以會計／勞動法規為準。`;
    $('slipList').innerHTML = r.list.map((x) => `<div class="card slip-item"><span class="s-ic">${icon('fileText', 22)}</span>
      <div class="slip-main"><div class="slip-t">${esc(x.label)} 薪資單</div><div class="slip-s">實發 NT$ ${Math.round(x.net).toLocaleString('en-US')}・確認於 ${esc(x.confirmed_text.slice(0, 10))}</div></div>
      <button class="btn secondary sm" data-slip="${x.month}" aria-label="下載 ${esc(x.label)} 薪資單 PDF">${icon('download', 16)}下載 PDF</button></div>`).join('')
      || `<div class="card empty-card"><span class="s-ic">${icon('wallet', 26)}</span><b>目前還沒有薪資單</b><span class="muted">公司確認每月薪資後，就可以在這裡下載 PDF。</span></div>`;
    $('slipList').querySelectorAll('[data-slip]').forEach((b) => b.onclick = () => downloadSlip(b.dataset.slip, b));
  } catch (e) { if (e.status === 401) { localStorage.removeItem('emp_token'); token = null; return showPick(); } $('slipList').innerHTML = ''; toast(e.message, 'err'); }
}
async function downloadSlip(month, btn) {
  btn.disabled = true;
  try {
    const res = await fetch(`/api/payslips/${month}.pdf`, { headers: auth() });
    if (!res.ok) { let msg = '下載失敗'; try { msg = (await res.json()).error || msg; } catch (e) {} throw Object.assign(new Error(msg), { status: res.status }); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `薪資單_${month}_${(me && me.employee && me.employee.name) || ''}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('已下載薪資單', 'ok');
  } catch (e) { if (e.status === 401) { localStorage.removeItem('emp_token'); token = null; return showPick(); } toast(e.message, 'err'); }
  finally { btn.disabled = false; }
}

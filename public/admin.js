const $ = (id) => document.getElementById(id);
let employees = [];
let lastRecords = null;
hydrateIcons();

async function init() {
  try { const info = await api('/api/public/info'); serverOffset = info.server_time - Date.now(); } catch (e) {}
  try { const me = await api('/api/admin/me'); enter(me); }
  catch (e) { $('loginView').classList.remove('hidden'); $('loginPw').focus(); }
}
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/api/admin/login', { method: 'POST', body: { password: $('loginPw').value } }); const me = await api('/api/admin/me'); enter(me); }
  catch (err) { toast(err.message, 'err'); $('loginPw').select(); }
};
function enter(me) {
  $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden');
  $('pwWarn').classList.toggle('hidden', !me.default_password);
  showCheckWarn(me.checks);
  $('sideTitle').textContent = me.settings.company_name;
  setLeaveCount(me.leave_pending);
  const t = taipeiToday(); $('fTo').value = t; $('fFrom').value = addDays(t, -6);
  loadEmployees().then(() => go('overview'));
}
$('logout').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }); location.reload(); };

document.querySelectorAll('.side a[data-page]').forEach((a) => a.onclick = () => go(a.dataset.page));
document.querySelectorAll('[data-goto]').forEach((a) => a.onclick = () => go(a.dataset.goto));
function go(page) {
  document.querySelectorAll('.side a[data-page]').forEach((a) => { a.classList.toggle('active', a.dataset.page === page); a.toggleAttribute('aria-current', a.dataset.page === page); });
  document.querySelectorAll('[data-sec]').forEach((s) => s.classList.toggle('hidden', s.dataset.sec !== page));
  window.scrollTo({ top: 0 });
  ({ overview: loadOverview, records: loadRecords, leave: loadLeavePage, employees: renderEmployees, settings: loadSettings, audit: loadAudit })[page]();
}
function handle(err) { if (err.status === 401) { toast('登入逾時，請重新登入', 'err'); setTimeout(() => location.reload(), 800); } else toast(err.message, 'err'); }

// ---------- 共用片段 ----------
const B = {
  late: (m) => `<span class="badge b-danger">${icon('alertCircle')}遲到 ${m} 分</span>`,
  ot: (t) => `<span class="badge b-info">${icon('trend')}${t}</span>`,
  issue: (t) => `<span class="badge b-warning">${icon('alert')}${esc(t)}</span>`,
  working: () => '<span class="badge b-success"><span class="dot"></span>上班中</span>',
  done: () => '<span class="badge b-neutral"><span class="dot"></span>已下班</span>',
  none: () => '<span class="badge b-neutral" style="opacity:.75">未打卡</span>',
  edited: () => `<span class="badge b-neutral">${icon('pencil')}有修改</span>`,
  normal: () => `<span class="badge b-success">${icon('check')}正常</span>`,
  sample: () => '<span class="badge b-accent">示範</span>',
  leave: (t) => `<span class="badge b-accent">${icon('palm')}${esc(t)}</span>`,
  onLeave: () => `<span class="badge b-accent">${icon('palm')}請假</span>`,
  type: (t, text) => `<span class="badge ${t === 'in' ? 'b-brand' : 'b-accent'}">${icon(t === 'in' ? 'login' : 'logout')}${text}</span>`,
};
function emptyRow(cols, title, text, ic = 'inbox') {
  return `<tr><td colspan="${cols}" style="background:var(--surface)"><div class="empty"><span class="empty-ic">${icon(ic, 24)}</span><b>${title}</b>${text || ''}</div></td></tr>`;
}
function showCheckWarn(c) {
  const w = (c && c.warnings) || [];
  $('checkWarn').innerHTML = `${icon('alert', 18)}<div>${w.map((x) => esc(x)).join('<br>')} 請到「<a href="#" data-goto-settings>設定 → 打卡地點限制</a>」完成設定。</div>`;
  $('checkWarn').classList.toggle('hidden', !w.length);
  const link = $('checkWarn').querySelector('[data-goto-settings]'); if (link) link.onclick = (e) => { e.preventDefault(); go('settings'); };
  $('checksWarnBox').innerHTML = `${icon('alert', 18)}<div>${w.map((x) => esc(x)).join('<br>')}</div>`;
  $('checksWarnBox').classList.toggle('hidden', !w.length);
}
const okBadge = (v, okText, badText) => (v === 1 ? `<span class="badge b-success">${icon('check')}${okText}</span>` : v === 0 ? `<span class="badge b-danger">${icon('x')}${badText}</span>` : '<span class="badge b-neutral">未檢查</span>');
function netCell(p) {
  if (p.source === 'admin') return `<span class="badge b-neutral">${icon('shield')}管理員略過</span><span class="sub mono">${esc(p.ip)}</span>`;
  return `${okBadge(p.ip_ok, '公司網路', '非公司網路')}<span class="sub mono">${esc(p.ip || '—')}</span>`;
}
function locCell(p) {
  if (p.source === 'admin') return `<span class="badge b-neutral">${icon('shield')}管理員略過</span>`;
  const map = p.lat != null ? ` · <a href="https://www.google.com/maps?q=${p.lat},${p.lng}" target="_blank" rel="noopener">地圖</a>` : '';
  const dist = p.distance_m != null ? `距公司 ${p.distance_m} 公尺` : p.lat != null ? '已定位' : '';
  const acc = p.accuracy != null ? `，誤差 ±${p.accuracy}` : '';
  return `${okBadge(p.loc_ok, '在範圍內', '不在範圍')}${dist || map ? `<span class="sub">${dist}${acc}${map}</span>` : ''}`;
}
const dateCell = (d, w) => `${d.slice(5).replace('-', '/')}<span class="muted">（${w}）</span>`;

// ---------- 今日總覽 ----------
async function loadOverview() {
  try {
    const o = await api('/api/admin/overview');
    $('ovTitle').textContent = `${o.today.replace(/-/g, '/')}（星期${o.weekday}）・資料即時更新`;
    $('stTotal').textContent = o.total; $('stArrived').textContent = o.arrived; $('stIn').textContent = o.in_now; $('stLate').textContent = o.late;
    $('stLeavePend').textContent = o.leave_pending; $('stOnLeave').textContent = o.on_leave; setLeaveCount(o.leave_pending);
    $('stLeaveFlag').innerHTML = o.leave_pending ? '<span class="badge b-warning">待處理</span>' : '';
    $('stMonthH').textContent = o.month.hours; $('stMonthOT').textContent = o.month.overtime; $('stBlocked').textContent = o.blocked_today;
    const st = { none: B.none(), in: B.working(), out: B.done(), leave: B.onLeave() };
    $('ovBody').innerHTML = o.list.map((x) => `<tr>
      <td><span class="who">${avatar(x.name, 'sm')}${esc(x.name)} ${x.is_sample ? B.sample() : ''}</span></td><td>${st[x.status]}</td>
      <td class="num">${x.first_in || '<span class="muted">—</span>'}</td><td class="num">${x.last_out || '<span class="muted">—</span>'}</td>
      <td class="num">${x.worked_text || '<span class="muted">—</span>'}</td><td><span class="badges">${x.late ? B.late(x.late_min) : ''}${x.leave_text ? B.leave(x.leave_text) : ''}</span></td></tr>`).join('')
      || emptyRow(6, '尚無員工', '請到「員工管理」新增員工', 'users');
    const c = o.checks;
    const row = (ic, title, on, configured, detail) => `<div class="mini-item"><span class="s-ic" style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:${on && configured ? 'var(--success-bg)' : 'var(--surface-3)'};color:${on && configured ? 'var(--success)' : 'var(--muted)'}">${icon(ic, 18)}</span>
      <div class="grow"><div class="t">${title}</div><div class="d">${detail}</div></div>
      ${on ? (configured ? '<span class="badge b-success">已啟用</span>' : '<span class="badge b-warning">未設定</span>') : '<span class="badge b-neutral">關閉</span>'}</div>`;
    const ipCount = c.net_allowlist.split('\n').filter((l) => l.replace(/#.*/, '').trim()).length;
    $('ovChecks').innerHTML = row('wifi', '公司網路', c.net_check_enabled, c.net_configured, c.net_configured ? `${ipCount} 組允許的 IP` : '尚未設定 IP')
      + row('pin', '公司位置', c.loc_check_enabled, c.loc_configured, c.loc_configured ? `範圍 ${c.loc_radius} 公尺內` : '尚未設定座標');
    $('ovMonthSub').textContent = `${o.month.from.replace(/-/g, '/')} 起累計`;
    $('ovMonth').innerHTML = `
      <div class="mini-item"><div class="grow"><div class="t">遲到次數</div></div><b>${o.month.late} 次</b></div>
      <div class="mini-item"><div class="grow"><div class="t">缺卡／異常</div></div><b>${o.month.issues} 天</b></div>
      <div class="mini-item"><div class="grow"><div class="t">已核准請假</div></div><b>${o.month.leave_hours} 小時</b></div>`;
  } catch (e) { handle(e); }
}

// ---------- 打卡紀錄 ----------
function fillEmpSelect() {
  const cur = $('fEmp').value;
  $('fEmp').innerHTML = '<option value="">全部員工</option>' + employees.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  $('fEmp').value = cur;
}
function query() { return `from=${$('fFrom').value}&to=${$('fTo').value}&employee_id=${$('fEmp').value}`; }
async function loadRecords() {
  try {
    const r = await api('/api/admin/records?' + query());
    lastRecords = r;
    $('tDays').textContent = r.totals.days; $('tHours').textContent = r.totals.worked_hours; $('tOT').textContent = r.totals.overtime_hours;
    $('tLate').textContent = r.totals.late_count; $('tIssue').textContent = r.totals.issue_count; $('tLeave').textContent = r.totals.leave_hours;
    $('dailyBody').innerHTML = r.daily.map((d) => {
      const tags = [d.late ? B.late(d.late_min) : '', d.working_now ? B.working() : '', ...d.issues.map(B.issue), d.edited ? B.edited() : '', d.leave_text ? B.leave(`${d.leave_text} ${d.leave_hours}h`) : ''].join('');
      return `<tr>
      <td class="num">${dateCell(d.date, d.weekday)}</td><td><span class="who">${avatar(d.name, 'sm')}${esc(d.name)}</span></td>
      <td class="num">${d.first_in || '<span class="muted">—</span>'}</td><td class="num">${d.last_out || '<span class="muted">—</span>'}</td>
      <td class="num">${d.leave_only ? '<span class="muted">—</span>' : `<b>${d.worked_text}</b><span class="sub">${d.worked_hours} 小時</span>`}</td>
      <td>${d.overtime_ms ? B.ot(d.overtime_text) : '<span class="muted">—</span>'}</td>
      <td><span class="badges">${tags || B.normal()}</span></td></tr>`;
    }).join('') || emptyRow(7, '此區間沒有紀錄', '試著調整日期範圍或員工', 'calendar');
    $('punchBody').innerHTML = r.punches.map((p) => `<tr>
      <td class="num">${dateCell(p.date, p.weekday)}</td><td class="num"><b>${p.time}</b></td><td><span class="who">${avatar(p.name, 'sm')}${esc(p.name)}</span></td>
      <td>${B.type(p.type, p.type_text)}</td>
      <td>${netCell(p)}</td><td>${locCell(p)}</td>
      <td class="wrap">${p.source === 'admin' ? '<b>管理員補登</b>' : '員工打卡'}${p.edit_note ? `<span class="note">${esc(p.edit_note)}</span>` : ''}</td>
      <td><div class="cell-actions"><button class="btn secondary sm icon-only" data-edit="${p.id}" title="修改" aria-label="修改這筆打卡">${icon('pencil', 16)}</button><button class="btn danger-ghost sm icon-only" data-del="${p.id}" title="刪除" aria-label="刪除這筆打卡">${icon('trash', 16)}</button></div></td></tr>`).join('')
      || emptyRow(8, '此區間沒有紀錄', '試著調整日期範圍或員工', 'clock');
    $('blockedCount').textContent = r.blocked.length ? r.blocked.length : '';
    $('blockedBody').innerHTML = r.blocked.map((b) => `<tr><td class="num">${dateCell(b.date, b.weekday)}</td><td class="num"><b>${b.time}</b></td><td><span class="who">${avatar(b.name, 'sm')}${esc(b.name)}</span></td>
      <td>${B.type(b.type, b.type_text)}</td><td>${netCell(b)}</td><td>${locCell(b)}</td>
      <td class="wrap" style="color:var(--danger)">${esc(b.reason)}</td></tr>`).join('') || emptyRow(7, '沒有被拒絕的打卡', '此區間所有打卡都符合條件', 'shield');
    $('punchBody').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => editPunch(r.punches.find((p) => p.id == b.dataset.edit)));
    $('punchBody').querySelectorAll('[data-del]').forEach((b) => b.onclick = () => delPunch(r.punches.find((p) => p.id == b.dataset.del)));
  } catch (e) { handle(e); }
}
$('fSearch').onclick = () => { markQuick(null); loadRecords(); };
['fFrom', 'fTo', 'fEmp'].forEach((id) => $(id).onchange = () => { if (id !== 'fEmp') markQuick(null); loadRecords(); });
function markQuick(q) { document.querySelectorAll('[data-quick]').forEach((b) => b.classList.toggle('on', b.dataset.quick === q)); }
document.querySelectorAll('[data-quick]').forEach((b) => b.onclick = () => {
  const t = taipeiToday(); const q = b.dataset.quick;
  if (q === 'today') { $('fFrom').value = t; $('fTo').value = t; }
  if (q === 'week') { $('fFrom').value = addDays(t, -6); $('fTo').value = t; }
  if (q === 'month') { $('fFrom').value = t.slice(0, 8) + '01'; $('fTo').value = t; }
  if (q === 'lastmonth') { const first = t.slice(0, 8) + '01'; const lastEnd = addDays(first, -1); $('fFrom').value = lastEnd.slice(0, 8) + '01'; $('fTo').value = lastEnd; }
  markQuick(q); loadRecords();
});
markQuick('week');
document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
  $('tabDaily').classList.toggle('hidden', b.dataset.tab !== 'daily'); $('tabPunches').classList.toggle('hidden', b.dataset.tab !== 'punches'); $('tabBlocked').classList.toggle('hidden', b.dataset.tab !== 'blocked');
});
$('expXlsx').onclick = () => { location.href = '/api/admin/export?format=xlsx&' + query(); toast('正在下載 Excel…'); };
$('expCsv').onclick = () => { location.href = '/api/admin/export?format=csv&' + query(); toast('正在下載 CSV…'); };

// ---------- 對話框 ----------
function modal(html, onSubmit, opts = {}) {
  $('modal').innerHTML = `<div class="modal-head"><span class="m-ic ${opts.danger ? 'danger' : ''}">${icon(opts.icon || 'pencil', 20)}</span><h3 id="modalTitle">${opts.title || ''}</h3></div>${html}`;
  $('modal').setAttribute('aria-labelledby', 'modalTitle');
  $('modalBg').classList.remove('hidden');
  const form = $('modal').querySelector('form');
  $('modal').querySelector('[data-cancel]').onclick = closeModal;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try { await onSubmit(form); closeModal(); } catch (err) { handle(err); } finally { btn.disabled = false; }
  };
  const first = form.querySelector('input:not([type=hidden]),select'); if (first) first.focus();
}
function closeModal() { $('modalBg').classList.add('hidden'); }
$('modalBg').onclick = (e) => { if (e.target === $('modalBg')) closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modalBg').classList.contains('hidden')) closeModal(); });
const actions = (okText, danger) => `<div class="actions"><button type="button" class="btn secondary" data-cancel>取消</button><button class="btn ${danger ? 'danger' : ''}" type="submit">${okText}</button></div>`;

function punchForm(p, withEmp) {
  return `<form class="form-grid">
    ${withEmp ? `<div><label>員工</label><select name="employee_id" required><option value="">請選擇</option>${employees.map((e) => `<option value="${e.id}" ${$('fEmp').value == e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></div>`
      : `<div class="summary-box"><span class="who">${avatar(p.name, 'sm')}${esc(p.name)}</span></div>`}
    <div><label>類型</label><select name="type"><option value="in" ${p.type === 'in' ? 'selected' : ''}>上班</option><option value="out" ${p.type === 'out' ? 'selected' : ''}>下班</option></select></div>
    <div class="row2"><div><label>日期</label><input type="date" name="date" value="${p.date}" required></div><div><label>時間</label><input type="time" name="time" value="${p.time}" required></div></div>
    <div><label>原因（必填，會留下紀錄）</label><input type="text" name="reason" placeholder="例如：忘記打卡、手機沒電" required></div>
    <p class="help" style="margin:0">管理員補登與修改不受公司網路／位置限制，並會在紀錄上註明。</p>
    ${actions('儲存')}</form>`;
}
const formData = (f) => Object.fromEntries(new FormData(f).entries());
$('addPunch').onclick = () => modal(punchForm({ type: 'in', date: $('fTo').value || taipeiToday(), time: '09:00' }, true), async (f) => {
  await api('/api/admin/punches', { method: 'POST', body: formData(f) }); toast('已補登', 'ok'); loadRecords();
}, { title: '補登打卡', icon: 'plus' });
function editPunch(p) {
  modal(punchForm(p, false), async (f) => { await api('/api/admin/punches/' + p.id, { method: 'PUT', body: formData(f) }); toast('已修改', 'ok'); loadRecords(); }, { title: '修改打卡', icon: 'pencil' });
}
function delPunch(p) {
  modal(`<form class="form-grid"><div class="summary-box"><span class="who">${avatar(p.name, 'sm')}${esc(p.name)}</span><div class="muted" style="margin-top:6px">${p.date} ${p.time}　${p.type_text}</div></div>
    <div><label>刪除原因（必填）</label><input type="text" name="reason" required></div>${actions('刪除', true)}</form>`,
  async (f) => { await api('/api/admin/punches/' + p.id, { method: 'DELETE', body: formData(f) }); toast('已刪除', 'ok'); loadRecords(); }, { title: '刪除打卡紀錄', icon: 'trash', danger: true });
}

// ---------- 員工管理 ----------
async function loadEmployees() { try { employees = await api('/api/admin/employees'); fillEmpSelect(); fillLeaveEmpSelects(); } catch (e) { handle(e); } }
async function renderEmployees() {
  await loadEmployees();
  $('empBody').innerHTML = employees.map((e) => `<tr><td><span class="who">${avatar(e.name, 'sm')}${esc(e.name)} ${e.is_sample ? B.sample() : ''}</span></td>
    <td><span class="pin-pill">${esc(e.pin)}</span></td><td class="muted">${esc(e.note) || '—'}</td>
    <td><div class="cell-actions"><button class="btn secondary sm" data-eedit="${e.id}">${icon('pencil', 15)}編輯</button><button class="btn danger-ghost sm" data-edel="${e.id}">${icon('trash', 15)}移除</button></div></td></tr>`).join('')
    || emptyRow(4, '還沒有員工', '按右上角「新增員工」開始建立', 'users');
  $('empBody').querySelectorAll('[data-eedit]').forEach((b) => b.onclick = () => empModal(employees.find((e) => e.id == b.dataset.eedit)));
  $('empBody').querySelectorAll('[data-edel]').forEach((b) => b.onclick = () => {
    const e = employees.find((x) => x.id == b.dataset.edel);
    modal(`<form class="form-grid"><p style="margin:0">確定要移除「<b>${esc(e.name)}</b>」嗎？移除後將無法打卡，但歷史打卡紀錄會保留。</p>${actions('移除', true)}</form>`,
      async () => { await api('/api/admin/employees/' + e.id, { method: 'DELETE' }); toast('已移除', 'ok'); renderEmployees(); }, { title: '移除員工', icon: 'trash', danger: true });
  });
}
function empModal(e) {
  const isNew = !e; e = e || { name: '', pin: String(Math.floor(1000 + Math.random() * 9000)), note: '' };
  modal(`<form class="form-grid">
    <div><label>姓名</label><input type="text" name="name" value="${esc(e.name)}" required maxlength="30"></div>
    <div><label>PIN 碼（4 位數字，員工打卡時使用）</label><input type="text" name="pin" value="${esc(e.pin)}" inputmode="numeric" pattern="\\d{4}" maxlength="4" required class="mono" style="letter-spacing:.3em"></div>
    <div><label>備註（選填）</label><input type="text" name="note" value="${esc(e.note)}" placeholder="例如：門市、兼職"></div>
    ${actions('儲存')}</form>`,
  async (f) => {
    if (isNew) await api('/api/admin/employees', { method: 'POST', body: formData(f) });
    else await api('/api/admin/employees/' + e.id, { method: 'PUT', body: formData(f) });
    toast('已儲存', 'ok'); renderEmployees();
  }, { title: isNew ? '新增員工' : '編輯員工', icon: isNew ? 'plus' : 'user' });
}
$('addEmp').onclick = () => empModal(null);

// ---------- 設定 ----------
async function loadSettings() {
  try { const me = await api('/api/admin/me'); const s = me.settings;
    $('sCompany').value = s.company_name; $('sStart').value = s.work_start; $('sGrace').value = s.late_grace_min; $('sHours').value = s.standard_hours;
    fillChecks(me.checks);
    $('sLunchOn').checked = s.lunch_enabled; $('sLunchS').value = s.lunch_start; $('sLunchE').value = s.lunch_end; syncLunch();
  } catch (e) { handle(e); }
}
$('setForm').onsubmit = async (e) => {
  e.preventDefault();
  try { const r = await api('/api/admin/settings', { method: 'PUT', body: { company_name: $('sCompany').value, work_start: $('sStart').value, late_grace_min: $('sGrace').value, standard_hours: $('sHours').value, lunch_enabled: $('sLunchOn').checked, lunch_start: $('sLunchS').value, lunch_end: $('sLunchE').value } });
    $('sideTitle').textContent = r.settings.company_name; toast('設定已儲存', 'ok'); } catch (err) { handle(err); }
};
function syncLunch() { $('sLunchS').disabled = $('sLunchE').disabled = !$('sLunchOn').checked; }
$('sLunchOn').onchange = syncLunch;
$('pwForm').onsubmit = async (e) => {
  e.preventDefault();
  if ($('pwNew').value !== $('pwNew2').value) return toast('兩次輸入的新密碼不一致', 'err');
  try { await api('/api/admin/password', { method: 'PUT', body: { old_password: $('pwOld').value, new_password: $('pwNew').value } });
    toast('密碼已變更', 'ok'); e.target.reset(); $('pwWarn').classList.add('hidden'); } catch (err) { handle(err); }
};

// ---------- 打卡地點限制 ----------
function syncCheckBlocks() {
  document.querySelectorAll('#checksForm .check-block').forEach((b) => b.style.opacity = '');
  $('cNetOn').closest('.check-block').classList.toggle('is-on', $('cNetOn').checked);
  $('cLocOn').closest('.check-block').classList.toggle('is-on', $('cLocOn').checked);
}
$('cNetOn').onchange = $('cLocOn').onchange = syncCheckBlocks;
function fillChecks(c) {
  $('cNetOn').checked = c.net_check_enabled; $('cAllow').value = c.net_allowlist;
  $('cLocOn').checked = c.loc_check_enabled;
  $('cLat').value = c.loc_lat ?? ''; $('cLng').value = c.loc_lng ?? '';
  $('cRadius').value = c.loc_radius; $('cAcc').value = c.loc_max_accuracy;
  updateMapLink(); showCheckWarn(c); syncCheckBlocks();
  api('/api/admin/my-ip').then((r) => {
    $('myIpInfo').innerHTML = `${icon('globe', 16)}您目前的 IP：<b>${esc(r.ip)}</b>${r.is_private ? '<span class="muted">（內部 IP；部署到雲端後才會看到公司對外 IP）</span>' : ''}`;
    $('myIpInfo').dataset.suggest = r.suggestion;
  }).catch(() => {});
}
function updateMapLink() {
  const lat = parseFloat($('cLat').value), lng = parseFloat($('cLng').value);
  const ok = Number.isFinite(lat) && Number.isFinite(lng);
  $('mapLink').classList.toggle('hidden', !ok);
  if (ok) $('mapLink').href = `https://www.google.com/maps?q=${lat},${lng}`;
}
$('cLat').oninput = $('cLng').oninput = updateMapLink;
$('useMyIp').onclick = async () => {
  try {
    const r = await api('/api/admin/my-ip');
    const lines = $('cAllow').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (lines.some((l) => l.replace(/#.*/, '').trim() === r.suggestion)) return toast('這個 IP 已經在清單中了');
    lines.push(`${r.suggestion}  # ${taipeiToday()} 加入`);
    $('cAllow').value = lines.join('\n');
    toast(`已加入 ${r.suggestion}，記得按「儲存打卡限制」`, 'ok');
  } catch (e) { handle(e); }
};
$('useMyLoc').onclick = () => {
  if (!window.isSecureContext) return toast('定位需要 HTTPS 連線（或 localhost），請改用 https 網址開啟後台', 'err');
  if (!navigator.geolocation) return toast('此瀏覽器不支援定位', 'err');
  $('myLocInfo').textContent = '正在取得位置…';
  navigator.geolocation.getCurrentPosition((pos) => {
    $('cLat').value = pos.coords.latitude.toFixed(6); $('cLng').value = pos.coords.longitude.toFixed(6);
    $('myLocInfo').textContent = `已取得目前位置（誤差約 ±${Math.round(pos.coords.accuracy)} 公尺），記得按「儲存打卡限制」`;
    updateMapLink();
  }, (err) => {
    const m = err.code === 1 ? '您拒絕了定位權限，請在瀏覽器網站設定中允許位置' : err.code === 3 ? '定位逾時，請再試一次' : '無法取得位置，請確認已開啟定位服務';
    $('myLocInfo').textContent = ''; toast(m, 'err');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
};
$('checksForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/admin/checks', { method: 'PUT', body: { net_check_enabled: $('cNetOn').checked, net_allowlist: $('cAllow').value, loc_check_enabled: $('cLocOn').checked, loc_lat: $('cLat').value, loc_lng: $('cLng').value, loc_radius: $('cRadius').value, loc_max_accuracy: $('cAcc').value } });
    showCheckWarn(r.checks); toast('打卡限制已儲存', 'ok');
  } catch (err) { handle(err); }
};

// ---------- 修改紀錄 ----------
const AUDIT_IC = { 新增員工: 'plus', 修改員工: 'user', 移除員工: 'trash', 補登打卡: 'plus', 修改打卡: 'pencil', 刪除打卡: 'trash', 修改設定: 'sliders', 修改打卡限制: 'shield', 變更密碼: 'key',
  核准請假: 'calendarCheck', 退回請假: 'calendarX', 撤銷請假: 'undo', 取消請假: 'undo', 調整特休額度: 'palm', 新增假別: 'tag', 修改假別: 'tag' };
async function loadAudit() {
  try { const list = await api('/api/admin/audit');
    $('auditBody').innerHTML = list.map((a) => `<tr><td class="num muted">${a.at_text}</td><td><span class="badge ${/刪除|移除|退回|撤銷/.test(a.action) ? 'b-danger' : /核准/.test(a.action) ? 'b-success' : /請假|特休|假別/.test(a.action) ? 'b-accent' : 'b-brand'}">${icon(AUDIT_IC[a.action] || 'edit3')}${esc(a.action)}</span></td><td class="wrap">${esc(a.detail)}</td></tr>`).join('')
      || emptyRow(3, '尚無修改紀錄', '管理員的變更會記錄在這裡', 'history');
  } catch (e) { handle(e); }
}

// =========================================================
// 請假
// =========================================================
let leaveTypes = [], curLtab = 'pending', calMonth = null, pendCache = [];
const LV_BADGE = { pending: ['b-warning', 'hourglass'], approved: ['b-success', 'check'], rejected: ['b-danger', 'x'], cancelled: ['b-neutral', 'undo'] };
const lvStatus = (l) => `<span class="badge ${LV_BADGE[l.status][0]}">${icon(LV_BADGE[l.status][1])}${l.status_text}</span>`;
const WDS = ['日', '一', '二', '三', '四', '五', '六'];
const wdOf = (d) => WDS[new Date(d + 'T00:00:00Z').getUTCDay()];
const mdw = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}（${wdOf(d)}）`;
function lvWhen(l) {
  if (l.mode === 'full') return l.start_date === l.end_date ? `${mdw(l.start_date)} 全天` : `${mdw(l.start_date)} ～ ${mdw(l.end_date)}`;
  const d = l.days[0];
  if (l.mode === 'am' || l.mode === 'pm') return `${mdw(l.start_date)} ${l.mode_text}${d ? ` ${d.from}～${d.to}` : ''}`;
  const et = l.end_text.slice(0, 10);
  return et === l.start_date ? `${mdw(l.start_date)} ${l.start_text.slice(11)}～${l.end_text.slice(11)}` : `${mdw(l.start_date)} ${l.start_text.slice(11)} ～ ${mdw(et)} ${l.end_text.slice(11)}`;
}
function setLeaveCount(n) {
  $('navLeaveCount').textContent = n ? n : '';
  $('lvPendTab').textContent = n ? n : '';
}
$('stLeaveCard').onclick = () => { go('leave'); setLtab('pending'); };
function fillLeaveEmpSelects() {
  ['lfEmp', 'calEmp'].forEach((id) => { const cur = $(id).value; $(id).innerHTML = '<option value="">全部員工</option>' + employees.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join(''); $(id).value = cur; });
}
function setLtab(t) {
  curLtab = t;
  document.querySelectorAll('[data-ltab]').forEach((b) => { const on = b.dataset.ltab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  document.querySelectorAll('[data-lpane]').forEach((p) => p.classList.toggle('hidden', p.dataset.lpane !== t));
  ({ pending: loadPending, list: loadLeaveList, cal: loadCal, setup: loadSetup })[t]();
}
document.querySelectorAll('[data-ltab]').forEach((b) => b.onclick = () => setLtab(b.dataset.ltab));
async function loadLeavePage() {
  try { leaveTypes = await api('/api/admin/leave-types'); } catch (e) { return handle(e); }
  const cur = $('lfType').value;
  $('lfType').innerHTML = '<option value="">全部假別</option>' + leaveTypes.map((t) => `<option value="${t.id}">${esc(t.name)}${t.active ? '' : '（停用）'}</option>`).join('');
  $('lfType').value = cur;
  if (!$('lfFrom').value) { const t = taipeiToday(); $('lfFrom').value = addDays(t, -30); $('lfTo').value = addDays(t, 60); }
  setLtab(curLtab);
}
function balInline(l) {
  if (!l.balance) return '';
  const b = l.balance, after = +(b.remaining_hours - l.hours).toFixed(2);
  return l.status === 'pending'
    ? `<span class="bal-inline ${after < 0 ? 'bad' : ''}">${icon('palm', 15)}特休剩餘 ${b.remaining_hours} 小時${after < 0 ? '，不足' : ` → 核准後 ${after} 小時`}</span>`
    : `<span class="bal-inline">${icon('palm', 15)}特休剩餘 ${b.remaining_hours} 小時</span>`;
}
function attBtn(l, label = true) {
  return l.has_attachment ? `<a class="btn ghost sm" href="/api/admin/leaves/${l.id}/attachment" target="_blank" rel="noopener" title="${esc(l.attachment_name)}">${icon('paperclip', 15)}${label ? '附件' : ''}</a>` : '';
}
async function loadPending() {
  try {
    const r = await api('/api/admin/leaves?status=pending');
    pendCache = r.leaves; setLeaveCount(r.pending);
    $('pendList').innerHTML = r.leaves.map((l) => `<article class="card pend-card">
      <div class="pend-main">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span class="who">${avatar(l.name, 'md')}<span>${esc(l.name)}<span class="sub" style="font-weight:400">申請於 ${esc(l.created_text)}</span></span></span></div>
        <div class="pend-facts"><span><span class="badge ${l.deduct_annual ? 'b-accent' : 'b-brand'}">${esc(l.type_name)}</span></span><span>${icon('calendar', 16)}<b>${esc(lvWhen(l))}</b></span><span>${icon('timer', 16)}${esc(l.hours_text)}</span></div>
        <div class="lv-reason">${esc(l.reason)}</div>
        <div class="badges">${balInline(l)}${attBtn(l)}</div>
      </div>
      <div class="pend-actions">
        <button class="btn" data-approve="${l.id}">${icon('check', 18)}核准</button>
        <button class="btn danger-ghost" data-reject="${l.id}">${icon('x', 18)}退回</button>
      </div></article>`).join('')
      || `<div class="card empty"><span class="empty-ic">${icon('calendarCheck', 24)}</span><b>沒有待審核的請假</b>員工送出申請後會出現在這裡</div>`;
    bindDecide($('pendList'), r.leaves);
  } catch (e) { handle(e); }
}
function bindDecide(root, list) {
  root.querySelectorAll('[data-approve]').forEach((b) => b.onclick = () => decideModal(list.find((l) => l.id == b.dataset.approve), 'approve'));
  root.querySelectorAll('[data-reject]').forEach((b) => b.onclick = () => decideModal(list.find((l) => l.id == b.dataset.reject), 'reject'));
}
function decideModal(l, kind) {
  const ok = kind === 'approve';
  modal(`<form class="form-grid">
    <div class="summary-box"><span class="who">${avatar(l.name, 'sm')}${esc(l.name)}</span>
      <div style="margin-top:8px;display:grid;gap:4px"><div><b>${esc(l.type_name)}</b>・${esc(lvWhen(l))}</div><div class="muted">${esc(l.hours_text)}・${esc(l.reason)}</div></div></div>
    ${ok && l.balance ? `<div>${balInline(l)}</div>` : ''}
    <div><label for="dComment">${ok ? '給員工的備註（選填）' : '退回原因（選填，員工看得到）'}</label><input type="text" id="dComment" name="comment" maxlength="300" placeholder="${ok ? '例如：已安排代理人' : '例如：當天人手不足，請改天再請'}"></div>
    ${actions(ok ? '核准' : '退回', !ok)}</form>`,
  async (f) => {
    const r = await api(`/api/admin/leaves/${l.id}/${kind}`, { method: 'POST', body: formData(f) });
    toast(ok ? `已核准 ${l.name} 的${l.type_name}${r.balance ? `，特休剩餘 ${r.balance.remaining_hours} 小時` : ''}` : `已退回 ${l.name} 的${l.type_name}申請`, 'ok');
    refreshLeaveViews();
  }, { title: ok ? '核准請假' : '退回請假', icon: ok ? 'calendarCheck' : 'calendarX', danger: !ok });
}
function revokeModal(l) {
  modal(`<form class="form-grid">
    <div class="summary-box"><span class="who">${avatar(l.name, 'sm')}${esc(l.name)}</span>
      <div style="margin-top:8px"><b>${esc(l.type_name)}</b>・${esc(lvWhen(l))}・${esc(l.hours_text)}</div></div>
    <p style="margin:0">撤銷後這筆請假會改為「已取消」${l.deduct_annual ? '，特休時數會退回給員工' : ''}；員工會看到撤銷原因。</p>
    <div><label for="rvComment">撤銷原因（必填）</label><input type="text" id="rvComment" name="comment" maxlength="300" required placeholder="例如：員工表示當天會正常上班"></div>
    ${actions('撤銷請假', true)}</form>`,
  async (f) => {
    const r = await api(`/api/admin/leaves/${l.id}/revoke`, { method: 'POST', body: formData(f) });
    toast(`已撤銷 ${l.name} 的${l.type_name}${r.balance ? `，特休剩餘 ${r.balance.remaining_hours} 小時` : ''}`, 'ok'); refreshLeaveViews();
  }, { title: '撤銷已核准的請假', icon: 'undo', danger: true });
}
function refreshLeaveViews() {
  ({ pending: loadPending, list: loadLeaveList, cal: loadCal, setup: loadSetup })[curLtab]();
  api('/api/admin/leaves?status=pending').then((r) => setLeaveCount(r.pending)).catch(() => {});
}
async function loadLeaveList() {
  const q = new URLSearchParams({ status: $('lfStatus').value || 'all', from: $('lfFrom').value, to: $('lfTo').value, employee_id: $('lfEmp').value, type_id: $('lfType').value });
  try {
    const r = await api('/api/admin/leaves?' + q);
    $('lvBody').innerHTML = r.leaves.map((l) => `<tr>
      <td><span class="who">${avatar(l.name, 'sm')}${esc(l.name)}</span></td>
      <td><span class="badge ${l.deduct_annual ? 'b-accent' : 'b-brand'}">${esc(l.type_name)}</span></td>
      <td class="num">${esc(lvWhen(l))}<span class="sub">申請於 ${esc(l.created_text)}</span></td>
      <td class="num"><b>${l.hours}</b> 小時</td>
      <td class="wrap" style="min-width:120px">${esc(l.reason)}</td>
      <td>${lvStatus(l)}${l.decided_text ? `<span class="sub">${esc(l.decided_text)}</span>` : ''}</td>
      <td class="wrap" style="min-width:120px">${l.admin_comment ? esc(l.admin_comment) : '<span class="muted">—</span>'}</td>
      <td><div class="cell-actions">${attBtn(l, false)}${l.status === 'approved' ? `<button class="btn secondary sm icon-only" data-revoke="${l.id}" title="撤銷" aria-label="撤銷 ${esc(l.name)} 的${esc(l.type_name)}">${icon('undo', 16)}</button>` : ''}${l.status === 'pending' ? `<button class="btn sm icon-only" data-approve="${l.id}" title="核准" aria-label="核准 ${esc(l.name)} 的${esc(l.type_name)}">${icon('check', 16)}</button><button class="btn danger-ghost sm icon-only" data-reject="${l.id}" title="退回" aria-label="退回 ${esc(l.name)} 的${esc(l.type_name)}">${icon('x', 16)}</button>` : ''}</div></td></tr>`).join('')
      || emptyRow(8, '沒有符合條件的請假', '試著調整日期、員工或狀態', 'calendar');
    bindDecide($('lvBody'), r.leaves);
    $('lvBody').querySelectorAll('[data-revoke]').forEach((b) => b.onclick = () => revokeModal(r.leaves.find((l) => l.id == b.dataset.revoke)));
  } catch (e) { handle(e); }
}
['lfFrom', 'lfTo', 'lfEmp', 'lfType', 'lfStatus'].forEach((id) => $(id).onchange = loadLeaveList);

// 行事曆
async function loadCal() {
  if (!calMonth) calMonth = taipeiToday().slice(0, 7);
  const [y, m] = calMonth.split('-').map(Number);
  $('calTitle').textContent = `${y} 年 ${m} 月`;
  const first = `${calMonth}-01`;
  const gridStart = addDays(first, -new Date(first + 'T00:00:00Z').getUTCDay());
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${calMonth}-${String(lastDay).padStart(2, '0')}`;
  const gridEnd = addDays(last, 6 - new Date(last + 'T00:00:00Z').getUTCDay());
  const status = $('calPend').checked ? 'approved,pending' : 'approved';
  try {
    const r = await api(`/api/admin/leaves?status=${status}&from=${gridStart}&to=${gridEnd}&employee_id=${$('calEmp').value}`);
    const byDay = {};
    r.leaves.forEach((l) => l.days.forEach((d) => (byDay[d.date] = byDay[d.date] || []).push({ l, d })));
    const today = taipeiToday();
    let html = WDS.map((w) => `<div class="cal-wd">${w}</div>`).join('');
    for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) {
      const wd = new Date(d + 'T00:00:00Z').getUTCDay();
      const evs = byDay[d] || [];
      const cls = ['cal-day', wd === 0 || wd === 6 ? 'wknd' : '', d.slice(0, 7) !== calMonth ? 'out' : '', d === today ? 'today' : ''].join(' ');
      html += `<div class="${cls}"><div class="cal-n"><b>${Number(d.slice(8))}</b>${evs.length > 1 ? `<span class="muted" style="font-size:11px;font-weight:500">${evs.length} 人</span>` : ''}</div>
        ${evs.slice(0, 3).map(({ l, d: dd }) => `<button type="button" class="cal-ev ${l.status} ${l.deduct_annual ? 'annual' : ''}" data-ev="${l.id}" title="${esc(`${l.name} ${l.type_name} ${dd.from}～${dd.to}（${l.status_text}）`)}">${esc(l.name.replace('示範員工', ''))} ${esc(l.type_name)}${dd.full ? '' : l.mode === 'am' ? ' 上午' : l.mode === 'pm' ? ' 下午' : ` ${dd.from}`}</button>`).join('')}
        ${evs.length > 3 ? `<span class="cal-more">還有 ${evs.length - 3} 筆</span>` : ''}</div>`;
    }
    $('calGrid').innerHTML = html;
    $('calGrid').querySelectorAll('[data-ev]').forEach((b) => b.onclick = () => leaveDetail(r.leaves.find((l) => l.id == b.dataset.ev)));
  } catch (e) { handle(e); }
}
function leaveDetail(l) {
  modal(`<form class="form-grid">
    <div class="summary-box"><span class="who">${avatar(l.name, 'sm')}${esc(l.name)}</span>
      <div style="margin-top:8px;display:grid;gap:6px"><div><b>${esc(l.type_name)}</b>・${esc(lvWhen(l))}</div><div class="muted">${esc(l.hours_text)}</div><div>${esc(l.reason)}</div>
      <div class="badges">${lvStatus(l)}${balInline(l)}${attBtn(l)}</div>
      ${l.admin_comment ? `<div class="muted">審核意見：${esc(l.admin_comment)}</div>` : ''}</div></div>
    <div class="actions">${l.status === 'pending'
      ? `<button type="button" class="btn secondary" data-cancel>關閉</button><button type="button" class="btn danger-ghost" data-d="reject">${icon('x', 16)}退回</button><button type="submit" class="btn">${icon('check', 16)}核准</button>`
      : `<button type="button" class="btn secondary" data-cancel>關閉</button><button type="submit" class="btn hidden">關閉</button>`}</div></form>`,
  async () => { if (l.status === 'pending') setTimeout(() => decideModal(l, 'approve'), 0); }, { title: '請假內容', icon: 'calendar' });
  const rj = $('modal').querySelector('[data-d=reject]'); if (rj) rj.onclick = () => { closeModal(); decideModal(l, 'reject'); };
}
$('calPrev').onclick = () => { const [y, m] = calMonth.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); calMonth = d.toISOString().slice(0, 7); loadCal(); };
$('calNext').onclick = () => { const [y, m] = calMonth.split('-').map(Number); const d = new Date(Date.UTC(y, m, 1)); calMonth = d.toISOString().slice(0, 7); loadCal(); };
$('calToday').onclick = () => { calMonth = taipeiToday().slice(0, 7); loadCal(); };
$('calEmp').onchange = loadCal; $('calPend').onchange = loadCal;

// 特休額度與假別
async function loadSetup() {
  try {
    const [bals, types] = await Promise.all([api('/api/admin/leave-balances'), api('/api/admin/leave-types')]);
    leaveTypes = types;
    $('balBody').innerHTML = bals.map((b) => {
      const s = b.statutory;
      const sug = s ? `${s.days} 天<span class="sub">${esc(s.note)}</span>` : '<span class="muted">未填到職日</span>';
      const fmt = (h) => `${h} 小時<span class="sub">${+(h / b.std_hours).toFixed(2)} 天</span>`;
      return `<tr><td><span class="who">${avatar(b.name, 'sm')}${esc(b.name)} ${b.is_sample ? B.sample() : ''}</span></td>
        <td class="num">${b.hire_date ? b.hire_date.replace(/-/g, '/') : '<span class="muted">—</span>'}</td>
        <td class="num">${sug}</td>
        <td class="num"><b>${fmt(b.quota_hours)}</b></td><td class="num">${fmt(b.used_hours)}</td>
        <td class="num">${b.pending_hours ? `<span style="color:var(--warning)">${b.pending_hours} 小時</span>` : '<span class="muted">—</span>'}</td>
        <td class="num"><span class="badge ${b.remaining_hours > 0 ? 'b-accent' : 'b-neutral'}">${b.remaining_hours} 小時</span><span class="sub">${+(b.remaining_hours / b.std_hours).toFixed(2)} 天</span></td>
        <td><div class="cell-actions"><button class="btn secondary sm" data-bal="${b.id}">${icon('pencil', 15)}調整</button></div></td></tr>`;
    }).join('') || emptyRow(8, '尚無員工', '請先到「員工管理」新增員工', 'users');
    $('balBody').querySelectorAll('[data-bal]').forEach((btn) => btn.onclick = () => balModal(bals.find((b) => b.id == btn.dataset.bal)));
    $('typeBody').innerHTML = types.map((t) => `<tr class="type-row"><td><b>${esc(t.name)}</b></td>
      <td>${t.deduct_annual ? `<span class="badge b-accent">${icon('palm')}扣特休</span>` : '<span class="muted">—</span>'}</td>
      <td>${t.needs_attachment ? `<span class="badge b-info">${icon('paperclip')}建議附證明</span>` : '<span class="muted">—</span>'}</td>
      <td>${t.active ? '<span class="badge b-success"><span class="dot"></span>啟用中</span>' : '<span class="badge b-neutral">已停用</span>'}</td>
      <td><div class="cell-actions"><button class="btn secondary sm" data-tedit="${t.id}">${icon('pencil', 15)}編輯</button>
        <button class="btn ${t.active ? 'danger-ghost' : 'soft'} sm" data-ttoggle="${t.id}">${t.active ? `${icon('ban', 15)}停用` : `${icon('check', 15)}啟用`}</button></div></td></tr>`).join('');
    $('typeBody').querySelectorAll('[data-tedit]').forEach((b) => b.onclick = () => typeModal(types.find((t) => t.id == b.dataset.tedit)));
    $('typeBody').querySelectorAll('[data-ttoggle]').forEach((b) => b.onclick = async () => {
      const t = types.find((x) => x.id == b.dataset.ttoggle);
      try { await api('/api/admin/leave-types/' + t.id, { method: 'PUT', body: { active: !t.active } }); toast(`已${t.active ? '停用' : '啟用'}「${t.name}」`, 'ok'); loadSetup(); } catch (e) { handle(e); }
    });
  } catch (e) { handle(e); }
}
function balModal(b) {
  const s = b.statutory;
  modal(`<form class="form-grid">
    <div class="summary-box"><span class="who">${avatar(b.name, 'sm')}${esc(b.name)}</span><div class="muted" style="margin-top:6px">${b.year} 年已核准使用 ${b.used_hours} 小時${b.pending_hours ? `、審核中 ${b.pending_hours} 小時` : ''}</div></div>
    <div><label for="bHire">到職日（用來計算勞基法建議天數）</label><input type="date" id="bHire" name="hire_date" value="${esc(b.hire_date)}" max="${taipeiToday()}"></div>
    <div class="inline-actions"><span class="help" style="margin:0" id="bSug"></span><button type="button" class="btn soft sm" id="bUseSug">${icon('scale', 15)}套用建議</button></div>
    <div class="row2">
      <div><label for="bDays">年度特休（天）</label><input type="number" id="bDays" min="0" max="250" step="0.5" value="${+(b.quota_hours / b.std_hours).toFixed(2)}"></div>
      <div><label for="bHours">＝ 小時</label><input type="number" id="bHours" name="quota_hours" min="0" max="2000" step="0.5" value="${b.quota_hours}" required></div>
    </div>
    <p class="help" style="margin:0">1 天 = 標準工時 ${b.std_hours} 小時。額度變更會記錄在「修改紀錄」。</p>
    ${actions('儲存')}</form>`,
  async (f) => {
    const r = await api('/api/admin/leave-balances/' + b.id, { method: 'PUT', body: formData(f) });
    toast(`已更新 ${b.name} 的特休額度，剩餘 ${r.balance.remaining_hours} 小時`, 'ok'); loadSetup();
  }, { title: '調整特休額度', icon: 'palm' });
  const std = b.std_hours;
  const sugDays = () => {
    const h = $('bHire').value; if (!h) return null;
    const [hy, hm, hd] = h.split('-').map(Number), [ty, tm, td] = taipeiToday().split('-').map(Number);
    const months = (ty - hy) * 12 + (tm - hm) - (td < hd ? 1 : 0);
    if (months < 6) return { days: 0, note: '年資未滿 6 個月' };
    const y = Math.floor(months / 12);
    const days = y < 1 ? 3 : y < 2 ? 7 : y < 3 ? 10 : y < 5 ? 14 : y < 10 ? 15 : Math.min(30, 15 + (y - 9));
    return { days, note: y < 1 ? '年資滿 6 個月' : `年資滿 ${y} 年` };
  };
  const showSug = () => { const x = sugDays(); $('bSug').innerHTML = x ? `依勞基法第 38 條：${x.note}，建議 <b>${x.days} 天</b>` : '填入到職日後可顯示建議天數'; $('bUseSug').disabled = !x; };
  $('bHire').oninput = showSug; showSug();
  $('bUseSug').onclick = () => { const x = sugDays(); if (!x) return; $('bDays').value = x.days; $('bHours').value = x.days * std; };
  $('bDays').oninput = () => { $('bHours').value = +(Number($('bDays').value || 0) * std).toFixed(2); };
  $('bHours').oninput = () => { $('bDays').value = +(Number($('bHours').value || 0) / std).toFixed(2); };
}
function typeModal(t) {
  const isNew = !t; t = t || { name: '', deduct_annual: 0, needs_attachment: 0 };
  modal(`<form class="form-grid">
    <div><label for="tName">假別名稱</label><input type="text" id="tName" name="name" value="${esc(t.name)}" maxlength="12" required placeholder="例如：家庭照顧假"></div>
    <label class="switch-row" for="tDeduct"><input type="checkbox" class="switch" id="tDeduct" ${t.deduct_annual ? 'checked' : ''}><span><span class="t">從特休額度扣除</span><br><span class="d">核准後會扣該員工的年度特休</span></span></label>
    <label class="switch-row" for="tAtt"><input type="checkbox" class="switch" id="tAtt" ${t.needs_attachment ? 'checked' : ''}><span><span class="t">建議附證明</span><br><span class="d">申請表會提示員工上傳證明（不強制）</span></span></label>
    ${actions('儲存')}</form>`,
  async () => {
    const body = { name: $('tName').value, deduct_annual: $('tDeduct').checked, needs_attachment: $('tAtt').checked };
    if (isNew) await api('/api/admin/leave-types', { method: 'POST', body }); else await api('/api/admin/leave-types/' + t.id, { method: 'PUT', body });
    toast('假別已儲存', 'ok'); loadSetup();
  }, { title: isNew ? '新增假別' : '編輯假別', icon: 'tag' });
}
$('addType').onclick = () => typeModal(null);

init();

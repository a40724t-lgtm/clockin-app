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
  const act = document.querySelector('.side a.active');
  if (act && matchMedia('(max-width: 900px)').matches) act.scrollIntoView({ inline: 'center', block: 'nearest' });
  ({ overview: loadOverview, records: loadRecords, leave: loadLeavePage, payroll: loadPayrollPage, holidays: loadHolidays, employees: renderEmployees, settings: loadSettings, audit: loadAudit })[page]();
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
  holiday: (h) => (h ? `<span class="badge ${h.off ? 'b-holiday' : 'b-neutral'}" title="${esc(h.kind_text)}">${icon(h.off ? 'flag' : 'repeat')}${esc(h.off ? h.name : '調移上班')}</span>` : ''),
  leave: (t) => `<span class="badge b-accent">${icon('palm')}${esc(t)}</span>`,
  onLeave: () => `<span class="badge b-accent">${icon('palm')}請假</span>`,
  wfh: () => `<span class="badge b-wfh">${icon('home')}居家</span>`,
  trip: (d) => `<span class="badge b-trip">${icon('briefcase')}公差${d ? `・${esc(d)}` : ''}</span>`,
  offsite: (n) => `<span class="badge b-offsite">${icon('mapPinOff')}異地打卡${n > 1 ? ` ${n} 次` : ''}</span>`,
  type: (t, text) => `<span class="badge ${t === 'in' ? 'b-brand' : 'b-accent'}">${icon(t === 'in' ? 'login' : 'logout')}${text}</span>`,
};
// 手機版：表格改為卡片，依表頭替每個儲存格加上標籤（data-label）
function labelTable(tb) {
  const heads = [...tb.closest('table').querySelectorAll('thead th')].map((th) => th.textContent.trim());
  tb.querySelectorAll(':scope > tr').forEach((tr) => {
    const tds = [...tr.children];
    if (tds.length === 1 && tds[0].colSpan > 1) { tds[0].classList.add('full'); return; }
    tds.forEach((td, i) => td.setAttribute('data-label', heads[i] || ''));
  });
}
document.querySelectorAll('table.stack > tbody').forEach((tb) => { labelTable(tb); new MutationObserver(() => labelTable(tb)).observe(tb, { childList: true }); });
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
  if (p.work_mode) return `<span class="badge b-${p.work_mode}">${icon(KIND_IC[p.work_mode])}${p.work_mode_text}・免檢查</span><span class="sub mono">${esc(p.ip || '—')}</span>`;
  if (p.source === 'admin') return `<span class="badge b-neutral">${icon('shield')}管理員略過</span><span class="sub mono">${esc(p.ip)}</span>`;
  return `${okBadge(p.ip_ok, '公司網路', '非公司網路')}<span class="sub mono">${esc(p.ip || '—')}</span>`;
}
function locCell(p) {
  if (p.source === 'admin') return `<span class="badge b-neutral">${icon('shield')}管理員略過</span>`;
  const map = p.lat != null ? ` · <a href="https://www.google.com/maps?q=${p.lat},${p.lng}" target="_blank" rel="noopener">地圖</a>` : '';
  const dist = p.distance_m != null ? `距公司 ${p.distance_m} 公尺` : p.lat != null ? '已定位' : '';
  const acc = p.accuracy != null ? `，誤差 ±${p.accuracy}` : '';
  if (p.work_mode) return `${p.lat != null ? `<span class="badge b-success">${icon('pin')}已記錄 GPS</span>` : '<span class="badge b-danger">未記錄 GPS</span>'}${dist || map ? `<span class="sub">${dist}${acc}${map}</span>` : ''}`;
  if (p.offsite && p.lat == null) return `<span class="badge b-offsite">${icon('mapPinOff')}GPS 無法取得</span>`;
  return `${okBadge(p.loc_ok, '在範圍內', '不在範圍')}${dist || map ? `<span class="sub">${dist}${acc}${map}</span>` : ''}`;
}
const KIND_IC = { wfh: 'home', trip: 'briefcase', leave: 'palm' };
const workTag = (x) => (x.work_mode === 'wfh' ? B.wfh() : x.work_mode === 'trip' ? B.trip(x.destination) : '') + (x.offsite ? B.offsite(x.offsite_count || 1) : '');
// 打卡位置的地圖連結（Google Maps）
function locLinks(locs) {
  if (!locs || !locs.length) return '';
  return `<span class="loc-links">${locs.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener" class="${l.offsite ? 'off' : ''}" title="誤差 ±${l.accuracy ?? '?'} 公尺">${icon('pin')}${l.type === 'in' ? '上班' : '下班'} ${l.time} 地圖</a>`).join('')}</span>`;
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
      <td class="num">${x.worked_text || '<span class="muted">—</span>'}</td><td><span class="badges">${x.late ? B.late(x.late_min) : ''}${x.leave_text ? B.leave(x.leave_text) : ''}${workTag(x)}</span>${locLinks(x.locs)}</td></tr>`).join('')
      || emptyRow(6, '尚無員工', '請到「員工管理」新增員工', 'users');
    const c = o.checks;
    const row = (ic, title, on, configured, detail) => `<div class="mini-item"><span class="s-ic" style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:${on && configured ? 'var(--success-bg)' : 'var(--surface-3)'};color:${on && configured ? 'var(--success)' : 'var(--muted)'}">${icon(ic, 18)}</span>
      <div class="grow"><div class="t">${title}</div><div class="d">${detail}</div></div>
      ${on ? (configured ? '<span class="badge b-success">已啟用</span>' : '<span class="badge b-warning">未設定</span>') : '<span class="badge b-neutral">關閉</span>'}</div>`;
    const ipCount = c.net_allowlist.split('\n').filter((l) => l.replace(/#.*/, '').trim()).length;
    $('ovChecks').innerHTML = row('wifi', '公司網路', c.net_check_enabled, c.net_configured, c.net_configured ? `${ipCount} 組允許的 IP` : '尚未設定 IP')
      + row('pin', '公司位置', c.loc_check_enabled, c.loc_configured, c.loc_configured ? `範圍 ${c.loc_radius} 公尺內` : '尚未設定座標')
      + `<div class="mini-item"><span class="s-ic" style="display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--surface-3);color:var(--text-2)">${icon('logout', 18)}</span><div class="grow"><div class="t">下班打卡</div><div class="d">${c.out_rule === 'strict' ? '與上班相同' : `公司網路或 ${c.out_radius} 公尺內；否則標記異地`}</div></div><span class="badge ${c.out_rule === 'strict' ? 'b-neutral' : 'b-info'}">${c.out_rule === 'strict' ? '嚴格' : '放寬'}</span></div>`;
    $('ovMonthSub').textContent = `${o.month.from.replace(/-/g, '/')} 起累計`;
    $('ovMonth').innerHTML = `
      <div class="mini-item"><div class="grow"><div class="t">遲到次數</div></div><b>${o.month.late} 次</b></div>
      <div class="mini-item"><div class="grow"><div class="t">缺卡／異常</div></div><b>${o.month.issues} 天</b></div>
      <div class="mini-item"><div class="grow"><div class="t">已核准請假</div></div><b>${o.month.leave_hours} 小時</b></div>
      <div class="mini-item"><div class="grow"><div class="t">居家上班／公差</div><div class="d">今天 ${o.remote_today} 人</div></div><b>${o.month.remote_days} 人日</b></div>
      <div class="mini-item"><div class="grow"><div class="t">異地打卡</div><div class="d">今天 ${o.offsite_today} 人</div></div><b style="${o.month.offsite ? 'color:var(--danger)' : ''}">${o.month.offsite} 次</b></div>`;
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
    $('tLate').textContent = r.totals.late_count; $('tIssue').textContent = r.totals.issue_count; $('tLeave').textContent = r.totals.leave_hours; $('tOffsite').textContent = r.totals.offsite_count;
    $('dailyBody').innerHTML = r.daily.map((d) => {
      const tags = [B.holiday(d.holiday), workTag(d), d.late ? B.late(d.late_min) : '', d.working_now ? B.working() : '', ...d.issues.map(B.issue), d.edited ? B.edited() : '', d.leave_text ? B.leave(`${d.leave_text} ${d.leave_hours}h`) : ''].join('');
      return `<tr class="${d.offsite ? 'row-offsite' : ''}">
      <td class="num">${dateCell(d.date, d.weekday)}</td><td><span class="who">${avatar(d.name, 'sm')}${esc(d.name)}</span></td>
      <td class="num">${d.first_in || '<span class="muted">—</span>'}</td><td class="num">${d.last_out || '<span class="muted">—</span>'}</td>
      <td class="num">${d.leave_only ? '<span class="muted">—</span>' : `<b>${d.worked_text}</b><span class="sub">${d.worked_hours} 小時</span>`}</td>
      <td>${d.overtime_ms ? B.ot(d.overtime_text) : '<span class="muted">—</span>'}</td>
      <td><span class="badges">${tags || B.normal()}</span>${locLinks(d.locs)}</td></tr>`;
    }).join('') || emptyRow(7, '此區間沒有紀錄', '試著調整日期範圍或員工', 'calendar');
    $('punchBody').innerHTML = r.punches.map((p) => `<tr class="${p.offsite ? 'row-offsite' : ''}">
      <td class="num">${dateCell(p.date, p.weekday)}</td><td class="num"><b>${p.time}</b></td><td><span class="who">${avatar(p.name, 'sm')}${esc(p.name)}</span></td>
      <td><span class="badges">${B.type(p.type, p.type_text)}${p.offsite ? B.offsite(1) : ''}</span></td>
      <td>${netCell(p)}</td><td>${locCell(p)}</td>
      <td class="wrap">${p.source === 'admin' ? '<b>管理員補登</b>' : '員工打卡'}${p.check_note && (p.offsite || p.work_mode) ? `<span class="note">${esc(p.check_note)}</span>` : ''}${p.edit_note ? `<span class="note">${esc(p.edit_note)}</span>` : ''}</td>
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
  $('modal').classList.remove('wide');
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
function closeModal() { $('modalBg').classList.add('hidden'); $('modal').classList.remove('wide'); }
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
    <td><span class="pin-pill">${esc(e.pin)}</span></td><td class="nid-cell">${e.has_national_id ? `<span class="nid-mask mono" title="已加密儲存，僅顯示部分號碼">${esc(e.national_id_masked)}</span>` : `<span class="badge b-warning" title="${esc(e.national_id_error || '未登錄身分證字號就無法寄送加密的 PDF 薪資單')}">${e.national_id_error ? '需重新輸入' : '未登錄'}</span>`}</td><td class="email-cell">${e.email ? `${esc(e.email)}${isDemoEmail(e.email) ? ' <span class="badge b-neutral" title="example.com 為示範用保留網域，系統不會寄出">示範地址</span>' : ''}` : '<span class="badge b-warning">未填寫</span>'}</td><td class="muted">${esc(e.note) || '—'}</td>
    <td><div class="cell-actions"><button class="btn secondary sm" data-eedit="${e.id}">${icon('pencil', 15)}編輯</button><button class="btn danger-ghost sm" data-edel="${e.id}">${icon('trash', 15)}移除</button></div></td></tr>`).join('')
    || emptyRow(6, '還沒有員工', '按右上角「新增員工」開始建立', 'users');
  $('empBody').querySelectorAll('[data-eedit]').forEach((b) => b.onclick = () => empModal(employees.find((e) => e.id == b.dataset.eedit)));
  $('empBody').querySelectorAll('[data-edel]').forEach((b) => b.onclick = () => {
    const e = employees.find((x) => x.id == b.dataset.edel);
    modal(`<form class="form-grid"><p style="margin:0">確定要移除「<b>${esc(e.name)}</b>」嗎？移除後將無法打卡，但歷史打卡紀錄會保留。</p>${actions('移除', true)}</form>`,
      async () => { await api('/api/admin/employees/' + e.id, { method: 'DELETE' }); toast('已移除', 'ok'); renderEmployees(); }, { title: '移除員工', icon: 'trash', danger: true });
  });
}
function empModal(e, after) {
  const isNew = !e; e = e || { name: '', pin: String(Math.floor(1000 + Math.random() * 9000)), note: '', email: '' };
  modal(`<form class="form-grid">
    <div><label>姓名</label><input type="text" name="name" value="${esc(e.name)}" required maxlength="30"></div>
    <div><label>PIN 碼（4 位數字，員工打卡時使用）</label><input type="text" name="pin" value="${esc(e.pin)}" inputmode="numeric" pattern="\\d{4}" maxlength="4" required class="mono" style="letter-spacing:.3em"></div>
    <div><label for="empNid">身分證字號（PDF 薪資單開啟密碼）</label><input type="text" id="empNid" name="national_id" value="" maxlength="12" class="mono nid-input" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${e.has_national_id ? `已登錄 ${esc(e.national_id_masked)}，留空表示不變更` : '例如 A123456789'}" aria-describedby="empNidHelp">
      <p class="help" id="empNidHelp" style="margin:4px 0 0">${icon('lock', 13)} 加密儲存，後台只顯示部分號碼。寄出的 PDF 薪資單密碼為身分證字號（英文大寫）。也可填新式居留證號（第 2 碼為 8 或 9）。</p>
      ${e.has_national_id ? '<label class="check-inline" style="margin-top:6px"><input type="checkbox" name="clear_national_id" value="1">清除已登錄的身分證字號</label>' : ''}</div>
    <div><label for="empEmail">Email（選填，用來寄送 PDF 薪資單）</label><input type="email" id="empEmail" name="email" value="${esc(e.email || '')}" maxlength="120" placeholder="例如：wang@gmail.com" spellcheck="false" autocomplete="off">
      ${isDemoEmail(e.email) ? '<p class="help" style="margin:4px 0 0">目前是示範地址（example.com 為保留網域，系統不會寄出），請改成員工真正的 Email。</p>' : ''}</div>
    <div><label>備註（選填）</label><input type="text" name="note" value="${esc(e.note)}" placeholder="例如：門市、兼職"></div>
    ${actions('儲存')}</form>`,
  async (f) => {
    if (isNew) await api('/api/admin/employees', { method: 'POST', body: formData(f) });
    else await api('/api/admin/employees/' + e.id, { method: 'PUT', body: formData(f) });
    toast('已儲存', 'ok');
    if (after) { loadEmployees(); setTimeout(after, 0); } else renderEmployees();
  }, { title: isNew ? '新增員工' : '編輯員工', icon: isNew ? 'plus' : 'user' });
  const nid = $('empNid');
  if (nid) nid.oninput = () => { const p = nid.selectionStart; nid.value = nid.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); try { nid.setSelectionRange(p, p); } catch {} };
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
  $(c.out_rule === 'strict' ? 'outStrict' : 'outRelaxed').checked = true; $('cOutRadius').value = c.out_radius; syncOutRule();
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
function syncOutRule() { $('cOutRadius').disabled = $('outStrict').checked; }
$('outStrict').onchange = $('outRelaxed').onchange = syncOutRule;
$('checksForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/admin/checks', { method: 'PUT', body: { net_check_enabled: $('cNetOn').checked, net_allowlist: $('cAllow').value, loc_check_enabled: $('cLocOn').checked, loc_lat: $('cLat').value, loc_lng: $('cLng').value, loc_radius: $('cRadius').value, loc_max_accuracy: $('cAcc').value, out_rule: $('outStrict').checked ? 'strict' : 'relaxed', out_radius: $('cOutRadius').value } });
    showCheckWarn(r.checks); toast('打卡限制已儲存', 'ok');
  } catch (err) { handle(err); }
};

// ---------- 修改紀錄 ----------
const AUDIT_IC = { 新增員工: 'plus', 修改員工: 'user', 移除員工: 'trash', 補登打卡: 'plus', 修改打卡: 'pencil', 刪除打卡: 'trash', 修改設定: 'sliders', 修改打卡限制: 'shield', 變更密碼: 'key',
  核准請假: 'calendarCheck', 修改薪資設定: 'banknote', 修改薪資規則: 'scale', 薪資調整: 'wallet', 確認薪資: 'lock', 解除薪資確認: 'unlock', 退回請假: 'calendarX', 撤銷請假: 'undo', 取消請假: 'undo', 調整特休額度: 'palm', 新增假別: 'tag', 修改假別: 'tag', 寄送薪資單: 'send', 修改寄信設定: 'mail', 寄送測試信: 'send' };
async function loadAudit() {
  try { const list = await api('/api/admin/audit');
    $('auditBody').innerHTML = list.map((a) => `<tr><td class="num muted">${a.at_text}</td><td><span class="badge ${/刪除|移除|退回|撤銷/.test(a.action) ? 'b-danger' : /核准/.test(a.action) ? 'b-success' : /請假|特休|假別/.test(a.action) ? 'b-accent' : /薪資|寄信|測試信/.test(a.action) ? 'b-info' : 'b-brand'}">${icon(AUDIT_IC[a.action] || 'edit3')}${esc(a.action)}</span></td><td class="wrap">${esc(a.detail)}</td></tr>`).join('')
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
const isWork = (l) => l.kind && l.kind !== 'leave';
const typeBadge = (l) => `<span class="badge ${isWork(l) ? `b-${l.kind}` : l.deduct_annual ? 'b-accent' : 'b-brand'}">${isWork(l) ? icon(KIND_IC[l.kind]) : ''}${esc(l.type_name)}</span>`;
function lvWhen(l) {
  if (isWork(l)) return l.start_date === l.end_date ? `${mdw(l.start_date)} 全天` : `${mdw(l.start_date)} ～ ${mdw(l.end_date)}`;
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
        <div class="pend-facts"><span>${typeBadge(l)}</span><span>${icon('calendar', 16)}<b>${esc(lvWhen(l))}</b></span><span>${icon('timer', 16)}${esc(l.hours_text)}</span>${l.destination ? `<span>${icon('navigation', 16)}${esc(l.destination)}</span>` : ''}</div>
        <div class="lv-reason">${esc(l.reason)}</div>
        <div class="badges">${balInline(l)}${attBtn(l)}${isWork(l) ? `<span class="help" style="margin:0">${icon('info', 14)} 核准後當天打卡免公司網路／位置檢查，但需記錄 GPS；不扣假</span>` : ''}</div>
      </div>
      <div class="pend-actions">
        <button class="btn" data-approve="${l.id}">${icon('check', 18)}核准</button>
        <button class="btn danger-ghost" data-reject="${l.id}">${icon('x', 18)}退回</button>
      </div></article>`).join('')
      || `<div class="card empty"><span class="empty-ic">${icon('calendarCheck', 24)}</span><b>沒有待審核的申請</b>員工送出請假、居家上班或公差申請後會出現在這裡</div>`;
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
      <div style="margin-top:8px;display:grid;gap:4px"><div><b>${esc(l.type_name)}</b>・${esc(lvWhen(l))}${l.destination ? `・${esc(l.destination)}` : ''}</div><div class="muted">${esc(l.hours_text)}・${esc(l.reason)}</div></div></div>
    ${ok && l.balance ? `<div>${balInline(l)}</div>` : ''}
    <div><label for="dComment">${ok ? '給員工的備註（選填）' : '退回原因（選填，員工看得到）'}</label><input type="text" id="dComment" name="comment" maxlength="300" placeholder="${ok ? '例如：已安排代理人' : '例如：當天人手不足，請改天再請'}"></div>
    ${actions(ok ? '核准' : '退回', !ok)}</form>`,
  async (f) => {
    const r = await api(`/api/admin/leaves/${l.id}/${kind}`, { method: 'POST', body: formData(f) });
    toast(ok ? `已核准 ${l.name} 的${l.type_name}${isWork(l) ? '，當天打卡改為記錄 GPS' : ''}${r.balance ? `，特休剩餘 ${r.balance.remaining_hours} 小時` : ''}` : `已退回 ${l.name} 的${l.type_name}申請`, 'ok');
    refreshLeaveViews();
  }, { title: `${ok ? '核准' : '退回'}${isWork(l) ? l.type_name : '請假'}`, icon: ok ? 'calendarCheck' : 'calendarX', danger: !ok });
}
function revokeModal(l) {
  modal(`<form class="form-grid">
    <div class="summary-box"><span class="who">${avatar(l.name, 'sm')}${esc(l.name)}</span>
      <div style="margin-top:8px"><b>${esc(l.type_name)}</b>・${esc(lvWhen(l))}・${esc(l.hours_text)}</div></div>
    <p style="margin:0">撤銷後這筆${isWork(l) ? l.type_name : '請假'}會改為「已取消」${l.deduct_annual ? '，特休時數會退回給員工' : ''}${isWork(l) ? '，當天打卡恢復公司網路／位置檢查' : ''}；員工會看到撤銷原因。</p>
    <div><label for="rvComment">撤銷原因（必填）</label><input type="text" id="rvComment" name="comment" maxlength="300" required placeholder="例如：員工表示當天會正常上班"></div>
    ${actions(isWork(l) ? '撤銷' : '撤銷請假', true)}</form>`,
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
      <td>${typeBadge(l)}${l.destination ? `<span class="sub">${esc(l.destination)}</span>` : ''}</td>
      <td class="num">${esc(lvWhen(l))}<span class="sub">申請於 ${esc(l.created_text)}</span></td>
      <td class="num">${isWork(l) ? `<span class="muted">${l.days.length} 天・不扣假</span>` : `<b>${l.hours}</b> 小時`}</td>
      <td class="wrap" style="min-width:120px">${esc(l.reason)}</td>
      <td>${lvStatus(l)}${l.decided_text ? `<span class="sub">${esc(l.decided_text)}</span>` : ''}</td>
      <td class="wrap" style="min-width:120px">${l.admin_comment ? esc(l.admin_comment) : '<span class="muted">—</span>'}</td>
      <td><div class="cell-actions">${attBtn(l, false)}${l.status === 'approved' ? `<button class="btn secondary sm icon-only" data-revoke="${l.id}" title="撤銷" aria-label="撤銷 ${esc(l.name)} 的${esc(l.type_name)}">${icon('undo', 16)}</button>` : ''}${l.status === 'pending' ? `<button class="btn sm icon-only" data-approve="${l.id}" title="核准" aria-label="核准 ${esc(l.name)} 的${esc(l.type_name)}">${icon('check', 16)}</button><button class="btn danger-ghost sm icon-only" data-reject="${l.id}" title="退回" aria-label="退回 ${esc(l.name)} 的${esc(l.type_name)}">${icon('x', 16)}</button>` : ''}</div></td></tr>`).join('')
      || emptyRow(8, '沒有符合條件的申請', '試著調整日期、員工或狀態', 'calendar');
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
      const hol = (r.holidays || []).find((h) => h.date === d);
      const cls = ['cal-day', wd === 0 || wd === 6 ? 'wknd' : '', hol && hol.off ? 'hol' : '', d.slice(0, 7) !== calMonth ? 'out' : '', d === today ? 'today' : ''].join(' ');
      html += `<div class="${cls}"><div class="cal-n"><b>${Number(d.slice(8))}</b>${hol ? `<span class="cal-hol" title="${esc(hol.kind_text)}${hol.note ? `：${esc(hol.note)}` : ''}">${esc(hol.off ? hol.name : '調移上班')}</span>` : ''}${evs.length > 1 ? `<span class="muted" style="font-size:11px;font-weight:500">${evs.length} 人</span>` : ''}</div>
        ${evs.slice(0, 3).map(({ l, d: dd }) => `<button type="button" class="cal-ev ${l.status} ${isWork(l) ? l.kind : l.deduct_annual ? 'annual' : ''}" data-ev="${l.id}" title="${esc(`${l.name} ${l.type_name}${l.destination ? `（${l.destination}）` : ''} ${isWork(l) ? '全天' : `${dd.from}～${dd.to}`}（${l.status_text}）`)}">${isWork(l) ? icon(KIND_IC[l.kind], 12) : ''}${esc(l.name.replace('示範員工', ''))} ${esc(isWork(l) ? (l.kind === 'wfh' ? '居家' : '公差') : l.type_name)}${dd.full ? '' : l.mode === 'am' ? ' 上午' : l.mode === 'pm' ? ' 下午' : ` ${dd.from}`}</button>`).join('')}
        ${evs.length > 3 ? `<span class="cal-more">還有 ${evs.length - 3} 筆</span>` : ''}</div>`;
    }
    $('calGrid').innerHTML = html;
    $('calGrid').querySelectorAll('[data-ev]').forEach((b) => b.onclick = () => leaveDetail(r.leaves.find((l) => l.id == b.dataset.ev)));
  } catch (e) { handle(e); }
}
function leaveDetail(l) {
  modal(`<form class="form-grid">
    <div class="summary-box"><span class="who">${avatar(l.name, 'sm')}${esc(l.name)}</span>
      <div style="margin-top:8px;display:grid;gap:6px"><div><b>${esc(l.type_name)}</b>・${esc(lvWhen(l))}</div><div class="muted">${esc(l.hours_text)}${l.destination ? `・地點：${esc(l.destination)}` : ''}</div><div>${esc(l.reason)}</div>
      <div class="badges">${lvStatus(l)}${balInline(l)}${attBtn(l)}</div>
      ${l.admin_comment ? `<div class="muted">審核意見：${esc(l.admin_comment)}</div>` : ''}</div></div>
    <div class="actions">${l.status === 'pending'
      ? `<button type="button" class="btn secondary" data-cancel>關閉</button><button type="button" class="btn danger-ghost" data-d="reject">${icon('x', 16)}退回</button><button type="submit" class="btn">${icon('check', 16)}核准</button>`
      : `<button type="button" class="btn secondary" data-cancel>關閉</button><button type="submit" class="btn hidden">關閉</button>`}</div></form>`,
  async () => { if (l.status === 'pending') setTimeout(() => decideModal(l, 'approve'), 0); }, { title: isWork(l) ? `${l.type_name}申請` : '請假內容', icon: isWork(l) ? KIND_IC[l.kind] : 'calendar' });
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
    $('typeBody').innerHTML = types.map((t) => t.kind && t.kind !== 'leave' ? `<tr class="type-row"><td><b>${icon(KIND_IC[t.kind], 15)} ${esc(t.name)}</b><span class="sub">系統內建・不算請假、不扣時數</span></td>
      <td><span class="muted">—</span></td><td><span class="muted">—</span></td>
      <td>${t.active ? '<span class="badge b-success"><span class="dot"></span>啟用中</span>' : '<span class="badge b-neutral">已停用</span>'}</td>
      <td><div class="cell-actions"><button class="btn ${t.active ? 'danger-ghost' : 'soft'} sm" data-ttoggle="${t.id}">${t.active ? `${icon('ban', 15)}停用` : `${icon('check', 15)}啟用`}</button></div></td></tr>` : `<tr class="type-row"><td><b>${esc(t.name)}</b></td>
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

// =========================================================
// 薪資統整
// =========================================================
const isDemoEmail = (e) => /@(.+\.)?(example\.(com|net|org)|[^@]*\.(example|test|invalid|localhost))$/i.test(String(e || '').trim());
let payMonth = null, payCur = null, curPtab = 'sum', paySet = null;
const NT = (n) => Math.round(n || 0).toLocaleString('en-US');
const ntd = (n) => `NT$ ${NT(n)}`;
const hrs = (h) => (h ? `${+(+h).toFixed(2)} 小時` : '0');
function defaultPayMonth() {
  const t = taipeiToday();
  if (Number(t.slice(8)) > 10) return t.slice(0, 7);
  const [y, m] = t.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}
function shiftMonth(m, n) { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm - 1 + n, 1)).toISOString().slice(0, 7); }
function setPtab(t) {
  curPtab = t;
  document.querySelectorAll('[data-ptab]').forEach((b) => { const on = b.dataset.ptab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  document.querySelectorAll('[data-ppane]').forEach((p) => p.classList.toggle('hidden', p.dataset.ppane !== t));
  $('payActions').classList.toggle('hidden', t !== 'sum');
  (t === 'sum' ? loadPayroll : loadPaySettings)();
}
document.querySelectorAll('[data-ptab]').forEach((b) => b.onclick = () => setPtab(b.dataset.ptab));
function loadPayrollPage() { if (!payMonth) payMonth = defaultPayMonth(); $('payMonth').value = payMonth; setPtab(curPtab); }
$('payMonth').onchange = () => { if (/^\d{4}-\d{2}$/.test($('payMonth').value)) { payMonth = $('payMonth').value; loadPayroll(); } };
$('payPrev').onclick = () => { payMonth = shiftMonth(payMonth, -1); $('payMonth').value = payMonth; loadPayroll(); };
$('payNext').onclick = () => { payMonth = shiftMonth(payMonth, 1); $('payMonth').value = payMonth; loadPayroll(); };
$('payExport').onclick = () => { location.href = `/api/admin/payroll/${payMonth}/export`; toast('正在下載 Excel…'); };
$('payZip').onclick = () => { if (!payCur || !payCur.employees.length) return toast('這個月份沒有薪資資料', 'err'); location.href = `/api/admin/payroll/${payMonth}/payslips.zip`; toast('正在下載全部 PDF（zip）…'); };
$('paySend').onclick = () => openSendDialog(null);
let paySends = null;
function sendStatus(id) {
  const r = paySends && paySends.recipients.find((x) => x.id === id);
  if (!r) return '';
  if (r.last_sent) return `<span class="send-st ok">${icon('check', 12)} 已寄送 ${esc(r.last_sent.at_text.slice(5))}${r.sent_count > 1 ? `（${r.sent_count} 次）` : ''}</span>`;
  if (r.last && r.last.status === 'failed') return `<span class="send-st err" title="${esc(r.last.error)}">${icon('alertCircle', 12)} 寄送失敗</span>`;
  if (r.state === 'no_email') return '<span class="send-st muted">未填 Email</span>';
  if (r.state === 'demo') return '<span class="send-st muted">示範地址</span>';
  return '<span class="send-st muted">尚未寄送</span>';
}

function leaveCell(e) {
  if (!e.leaves.length) return '<span class="muted">—</span>';
  return `<div class="pay-leaves">${e.leaves.map((l) => `<span class="pl ${l.effect < 0 ? 'neg' : l.effect > 0 ? 'pos' : ''}"><b>${esc(l.type_name)}</b> ${+l.hours} 小時・${esc(l.ratio_text)}<em>${esc(l.effect_text)}</em></span>`).join('')}</div>`;
}
async function loadPayroll() {
  const month = payMonth;
  try {
    const [p, sends] = await Promise.all([api('/api/admin/payroll?month=' + month), api(`/api/admin/payroll/${month}/sends`).catch(() => null)]);
    if (month !== payMonth) return;
    payCur = p; paySends = sends;
    $('paySend').disabled = !p.employees.length; $('payZip').disabled = !p.employees.length;
    $('paySend').title = p.confirmed ? '' : '確認本月薪資後才能寄送';
    const [y, m] = month.split('-').map(Number);
    $('payStatus').innerHTML = (p.confirmed ? `<span class="badge b-success">${icon('lock')}已確認・${esc(p.confirmed_text)}</span>` : `<span class="badge b-warning">${icon('hourglass')}試算中・未確認</span>`)
      + (p.in_progress && !p.confirmed ? `<span class="badge b-neutral">${icon('info')}本月尚未結束</span>` : '');
    $('payGen').textContent = p.confirmed ? `${y} 年 ${m} 月・確認時的試算結果` : `${y} 年 ${m} 月・${p.from.slice(5).replace('-', '/')}～${p.to.slice(5).replace('-', '/')}`;
    $('payConfirm').innerHTML = p.confirmed ? `${icon('unlock', 18)}解除確認` : `${icon('lock', 18)}確認 ${m} 月薪資`;
    $('payConfirm').className = p.confirmed ? 'btn secondary' : 'btn';
    $('pNet').textContent = NT(p.totals.net); $('pGross').textContent = NT(p.totals.gross);
    $('pOT').textContent = NT(p.totals.ot_pay); $('pOTl').textContent = `加班費・${+p.totals.ot_hours} 小時`;
    $('pLeave').textContent = NT(p.totals.leave_deduct); $('pLeavel').textContent = `請假扣薪・請假 ${+p.totals.leave_hours} 小時`;
    const offs = (p.holidays || []).filter((h) => h.off && !h.weekend);
    $('payHol').innerHTML = offs.length || p.totals.holiday_pay ? `<span class="ph-l">${icon('flag', 16)}本月放假日</span>${offs.map((h) => `<span class="badge ${h.paid_holiday ? 'b-holiday' : 'b-neutral'}">${esc(Number(h.date.slice(5, 7)) + '/' + Number(h.date.slice(8)))} ${esc(h.name)}</span>`).join('') || '<span class="muted">無</span>'}${p.totals.holiday_pay ? `<span class="ph-sum">國定假日加給／照給合計 <b>${ntd(p.totals.holiday_pay)}</b></span>` : ''}` : '';
    $('payHol').classList.toggle('hidden', !$('payHol').innerHTML);
    $('payBody').innerHTML = p.employees.map((e) => `<tr>
      <td class="wrap pay-who"><span class="who">${avatar(e.name, 'sm')}<span>${esc(e.name)} ${e.is_sample ? B.sample() : ''}<span class="sub" style="font-weight:400"><span class="badge ${e.pay_type === 'hourly' ? 'b-info' : 'b-brand'}">${e.pay_type_text}</span> ${ntd(e.pay_amount)}${e.pay_type === 'monthly' ? `・時薪 ${e.hourly_rate}` : ''}</span>${e.warnings.length ? `<span class="sub" style="color:var(--warning);font-weight:500">${icon('alert', 13)} ${esc(e.warnings[0])}</span>` : ''}</span></span></td>
      <td class="num"><b>${e.work_days}</b> 天・${+e.worked_hours} 小時<span class="sub">計薪 ${+e.paid_hours} 小時${e.weekend_days ? `・休息日 ${e.weekend_days} 天` : ''}</span></td>
      <td class="num">${e.ot.total ? `<b>${+e.ot.total}</b> 小時<span class="sub">平日 ${+e.ot.wd1}＋${+e.ot.wd2}${e.ot.rest_total ? `・休息日 ${+e.ot.rest_total}` : ''}</span><span class="sub">${ntd(e.ot.pay)}</span>` : '<span class="muted">—</span>'}</td>
      <td><span class="badges pay-st">${holBadge(e)}${e.late_count ? `<span class="badge b-danger">${icon('alertCircle')}遲到 ${e.late_count} 次 ${e.late_min} 分</span>` : ''}${e.early_count ? `<span class="badge b-warning">${icon('logout')}早退 ${e.early_count} 次 ${e.early_min} 分</span>` : ''}${e.offsite_count ? B.offsite(e.offsite_count) : ''}${e.wfh_days ? `<span class="badge b-wfh">${icon('home')}居家 ${e.wfh_days} 天</span>` : ''}${e.trip_days ? `<span class="badge b-trip">${icon('briefcase')}公差 ${e.trip_days} 天</span>` : ''}${!e.late_count && !e.early_count && !e.offsite_count && !e.wfh_days && !e.trip_days && !holBadge(e) ? B.normal() : ''}</span>${e.late_deduct ? `<span class="sub" style="color:var(--danger)">遲到／早退扣 ${ntd(e.late_deduct)}</span>` : ''}</td>
      <td class="wrap">${leaveCell(e)}</td>
      <td class="num r">${NT(e.gross)}</td><td class="num r neg">${e.deduct_total ? '−' + NT(e.deduct_total) : '0'}</td>
      <td class="num r"><b class="pay-net">${NT(e.net)}</b></td>
      <td><div class="cell-actions"><button class="btn secondary sm" data-pdetail="${e.id}">${icon('list', 15)}明細</button><a class="btn ghost sm icon-only" href="/api/admin/payroll/${month}/payslip/${e.id}.pdf" title="下載 PDF 薪資單" aria-label="下載 ${esc(e.name)} 的 PDF 薪資單">${icon('fileDown', 16)}</a><button class="btn ghost sm icon-only" data-psend="${e.id}" title="寄送薪資單" aria-label="寄送薪資單給 ${esc(e.name)}">${icon('send', 16)}</button></div>${sendStatus(e.id)}</td></tr>`).join('')
      || emptyRow(9, '這個月份沒有薪資資料', '沒有出勤紀錄，或員工在此月份之後才建立', 'wallet');
    $('payCards').innerHTML = p.employees.map((e) => payCard(e, month)).join('')
      || `<div class="card"><div class="empty"><span class="empty-ic">${icon('wallet', 24)}</span><b>這個月份沒有薪資資料</b>沒有出勤紀錄，或員工在此月份之後才建立</div></div>`;
    document.querySelectorAll('#payBody [data-pdetail], #payCards [data-pdetail]').forEach((b) => b.onclick = () => payDetail(p.employees.find((x) => x.id == b.dataset.pdetail)));
    $('payCards').querySelectorAll('[data-psend]').forEach((b) => b.onclick = () => openSendDialog([Number(b.dataset.psend)]));
    $('payBody').querySelectorAll('[data-psend]').forEach((b) => b.onclick = () => openSendDialog([Number(b.dataset.psend)]));
  } catch (e) { handle(e); }
}
function holBadge(e) {
  const h = e.holiday; if (!h) return '';
  return (h.worked_days ? `<span class="badge b-holiday" title="國定假日出勤 ${h.worked_days} 天・加給 NT$ ${NT(h.extra_pay)}">${icon('flag')}國定假日 ${h.worked_days} 天</span>` : '')
    + (h.paid_off_days ? `<span class="badge b-holiday" title="國定假日放假照給 ${h.paid_off_days} 天・NT$ ${NT(h.paid_off_pay)}">${icon('flag')}照給 ${h.paid_off_days} 天</span>` : '');
}
function attBadges(e) {
  return `${holBadge(e)}${e.late_count ? `<span class="badge b-danger">${icon('alertCircle')}遲到 ${e.late_count} 次 ${e.late_min} 分</span>` : ''}${e.early_count ? `<span class="badge b-warning">${icon('logout')}早退 ${e.early_count} 次 ${e.early_min} 分</span>` : ''}${e.offsite_count ? B.offsite(e.offsite_count) : ''}${e.wfh_days ? `<span class="badge b-wfh">${icon('home')}居家 ${e.wfh_days} 天</span>` : ''}${e.trip_days ? `<span class="badge b-trip">${icon('briefcase')}公差 ${e.trip_days} 天</span>` : ''}${!e.late_count && !e.early_count && !e.offsite_count && !e.wfh_days && !e.trip_days && !holBadge(e) ? B.normal() : ''}`;
}
// 手機版：每位員工一張卡片（顯示表格的所有欄位）
function payCard(e, month) {
  return `<article class="card pay-card">
    <header class="pc-head"><span class="who">${avatar(e.name, 'sm')}<span><b>${esc(e.name)}</b> ${e.is_sample ? B.sample() : ''}<span class="sub"><span class="badge ${e.pay_type === 'hourly' ? 'b-info' : 'b-brand'}">${e.pay_type_text}</span> ${ntd(e.pay_amount)}${e.pay_type === 'monthly' ? `・時薪 ${e.hourly_rate}` : ''}</span></span></span>
      <div class="pc-net"><span>實發</span><b>${NT(e.net)}</b></div></header>
    ${e.warnings.map((w) => `<p class="pc-warn">${icon('alert', 14)} ${esc(w)}</p>`).join('')}
    <dl class="pc-grid">
      <div><dt>出勤／工時</dt><dd><b>${e.work_days}</b> 天・${+e.worked_hours} 小時<span class="sub">計薪 ${+e.paid_hours} 小時${e.weekend_days ? `・休息日 ${e.weekend_days} 天` : ''}</span></dd></div>
      <div><dt>加班</dt><dd>${e.ot.total ? `<b>${+e.ot.total}</b> 小時・${ntd(e.ot.pay)}<span class="sub">平日 ${+e.ot.wd1}＋${+e.ot.wd2}${e.ot.rest_total ? `・休息日 ${+e.ot.rest_total}` : ''}</span>` : '<span class="muted">—</span>'}</dd></div>
      <div><dt>應發</dt><dd class="num">${NT(e.gross)}</dd></div>
      <div><dt>應扣</dt><dd class="num neg">${e.deduct_total ? '−' + NT(e.deduct_total) : '0'}</dd></div>
    </dl>
    <div class="pc-sec"><div class="pc-l">出勤狀況</div><span class="badges">${attBadges(e)}</span>${e.late_deduct ? `<span class="sub" style="color:var(--danger)">遲到／早退扣 ${ntd(e.late_deduct)}</span>` : ''}</div>
    <div class="pc-sec"><div class="pc-l">請假與薪資影響</div>${leaveCell(e)}</div>
    <footer class="pc-foot">${sendStatus(e.id) || '<span></span>'}
      <div class="pc-acts"><button class="btn secondary sm" data-pdetail="${e.id}">${icon('list', 15)}明細</button><a class="btn secondary sm" href="/api/admin/payroll/${month}/payslip/${e.id}.pdf">${icon('fileDown', 15)}下載 PDF</a><button class="btn secondary sm" data-psend="${e.id}">${icon('send', 15)}寄送</button></div></footer>
  </article>`;
}
function payLines(lines, sign) {
  return lines.map((l) => `<tr><td>${esc(l.label)}${l.adj_id && !payCur.confirmed ? ` <button type="button" class="btn danger-ghost sm icon-only" data-deladj="${l.adj_id}" title="刪除" aria-label="刪除調整項 ${esc(l.label)}">${icon('trash', 14)}</button>` : ''}<span class="sub">${esc(l.detail)}</span></td><td class="num r ${sign < 0 ? 'neg' : ''}">${sign < 0 ? '−' : ''}${NT(l.amount)}</td></tr>`).join('')
    || `<tr><td colspan="2" class="muted">無</td></tr>`;
}
function payDetail(e) {
  const locked = payCur.confirmed;
  modal(`<form class="form-grid">
    <div class="summary-box pay-sum"><span class="who">${avatar(e.name, 'sm')}${esc(e.name)} <span class="badge ${e.pay_type === 'hourly' ? 'b-info' : 'b-brand'}">${e.pay_type_text} ${ntd(e.pay_amount)}</span></span>
      <div class="muted" style="margin-top:6px">${esc(payCur.month)}・出勤 ${e.work_days} 天・工時 ${+e.worked_hours} 小時（計薪 ${+e.paid_hours}）・加班 ${+e.ot.total} 小時${e.late_count ? `・遲到 ${e.late_count} 次 ${e.late_min} 分` : ''}${e.early_count ? `・早退 ${e.early_count} 次 ${e.early_min} 分` : ''}</div>
      ${e.warnings.map((w) => `<div style="color:var(--warning);margin-top:4px">${icon('alert', 14)} ${esc(w)}</div>`).join('')}</div>
    <div class="pay-cols">
      <div><div class="label">應發項目</div><table class="pay-lines"><tbody>${payLines(e.earn, 1)}</tbody><tfoot><tr><td>應發合計</td><td class="num r">${NT(e.gross)}</td></tr></tfoot></table></div>
      <div><div class="label">應扣項目</div><table class="pay-lines"><tbody>${payLines(e.deduct, -1)}</tbody><tfoot><tr><td>應扣合計</td><td class="num r neg">−${NT(e.deduct_total)}</td></tr></tfoot></table></div>
    </div>
    <div class="pay-netline"><span>實發金額</span><b>${ntd(e.net)}</b></div>
    ${e.holiday && (e.holiday.worked.length || e.holiday.paid_off.length) ? `<div><div class="label">國定假日</div><div class="pay-leaves">${e.holiday.worked.map((h) => `<span class="pl pos"><b>${mdw(h.date)} ${esc(h.name)}</b> 出勤 ${+h.worked_h} 小時<em>${e.pay_type === 'monthly' ? '加給一日工資' : `加給 ${+h.in8_h} 小時`}</em></span>`).join('')}${e.holiday.paid_off.map((h) => `<span class="pl pos"><b>${mdw(h.date)} ${esc(h.name)}</b> 放假<em>照給 ${+h.hours} 小時</em></span>`).join('')}</div></div>` : ''}
    ${e.leaves.length ? `<div><div class="label">請假</div>${leaveCell(e)}${e.leaves.filter((l) => l.cap_note).map((l) => `<p class="help" style="margin:4px 0 0">${esc(l.type_name)}：${esc(l.cap_note)}${l.over_cap_hours ? `，超過上限 ${l.over_cap_hours} 小時不給薪` : ''}</p>`).join('')}</div>` : ''}
    ${locked ? `<div class="alert info">${icon('lock', 18)}<div>此月份已確認鎖定，若要調整請先「解除確認」。</div></div>` : `
    <fieldset class="pay-adj"><legend>新增獎金／其他加扣項</legend>
      <div class="row2"><div><label for="adjKind">類型</label><select id="adjKind" name="kind"><option value="add">加項（獎金等）</option><option value="deduct">扣項</option></select></div>
        <div><label for="adjAmt">金額（NT$）</label><input type="number" id="adjAmt" name="amount" min="1" step="1" required inputmode="numeric"></div></div>
      <div class="row2"><div><label for="adjLabel">項目名稱</label><input type="text" id="adjLabel" name="label" maxlength="20" required placeholder="例如：全勤獎金、借支"></div>
        <div><label for="adjNote">備註（選填）</label><input type="text" id="adjNote" name="note" maxlength="200" placeholder="例如：10 月業績達標"></div></div>
    </fieldset>`}
    <p class="help" style="margin:0">${icon('info', 14)} 試算僅供參考，請以會計／勞動法規為準。</p>
    <div class="actions"><a class="btn ghost" href="/api/admin/payroll/${payCur.month}/payslip/${e.id}.pdf">${icon('fileDown', 16)}下載 PDF</a><button type="button" class="btn ghost" data-dsend>${icon('send', 16)}寄送</button><span style="flex:1"></span><button type="button" class="btn secondary" data-cancel>關閉</button>${locked ? '<button type="submit" class="btn hidden">關閉</button>' : `<button type="submit" class="btn">${icon('plus', 16)}加入調整項</button>`}</div>
  </form>`,
  async (f) => {
    if (locked) return;
    await api(`/api/admin/payroll/${payCur.month}/adjustments`, { method: 'POST', body: { ...formData(f), employee_id: e.id } });
    toast('已加入調整項', 'ok'); await loadPayroll(); reopenDetail(e.id);
  }, { title: `${e.name}・薪資明細`, icon: 'wallet' });
  $('modal').classList.add('wide'); if (document.activeElement) document.activeElement.blur(); $('modal').scrollTop = 0;
  $('modal').querySelector('[data-dsend]').onclick = () => { closeModal(); openSendDialog([e.id]); };
  $('modal').querySelectorAll('[data-deladj]').forEach((b) => b.onclick = async () => {
    try { await api(`/api/admin/payroll/${payCur.month}/adjustments/${b.dataset.deladj}`, { method: 'DELETE' }); toast('已刪除調整項', 'ok'); await loadPayroll(); reopenDetail(e.id); } catch (err) { handle(err); }
  });
}
function reopenDetail(id) { const x = payCur && payCur.employees.find((y) => y.id === id); if (x) setTimeout(() => payDetail(x), 0); }
$('payConfirm').onclick = () => {
  if (!payCur) return;
  const [, m] = payCur.month.split('-').map(Number);
  if (payCur.confirmed) {
    modal(`<form class="form-grid"><p style="margin:0">解除確認後，${m} 月薪資會依最新的打卡、請假與薪資設定重新試算。</p>
      <div><label for="ucReason">解除原因（必填，會記錄在修改紀錄）</label><input type="text" id="ucReason" name="reason" required maxlength="200" placeholder="例如：補登 10/15 打卡後需重算"></div>${actions('解除確認', true)}</form>`,
    async (f) => { await api(`/api/admin/payroll/${payCur.month}/unconfirm`, { method: 'POST', body: formData(f) }); toast(`已解除 ${m} 月確認`, 'ok'); loadPayroll(); }, { title: '解除薪資確認', icon: 'unlock', danger: true });
  } else {
    modal(`<form class="form-grid"><div class="summary-box">${payCur.month}・${payCur.employees.length} 人・實發合計 <b>${ntd(payCur.totals.net)}</b></div>
      <p style="margin:0">確認後此月份會鎖定，保留目前的試算結果；之後修改打卡、請假或薪資設定都不會改變已確認的金額（需要時可解除確認）。</p>
      ${payCur.in_progress ? `<div class="alert warn">${icon('alert', 18)}<div>本月尚未結束，確認後後續的打卡不會計入。</div></div>` : ''}
      <p class="help" style="margin:0">試算僅供參考，請以會計／勞動法規為準。</p>${actions('確認並鎖定')}</form>`,
    async () => { await api(`/api/admin/payroll/${payCur.month}/confirm`, { method: 'POST' }); toast(`${m} 月薪資已確認`, 'ok'); loadPayroll(); }, { title: `確認 ${m} 月薪資`, icon: 'lock' });
  }
};

// 薪資設定
async function loadPaySettings() {
  loadMailSettings();
  try {
    const r = await api('/api/admin/payroll/settings'); paySet = r;
    const itemsOf = (e, k) => e.pay_items.filter((i) => i.kind === k).map((i) => `<span class="sub" style="margin:0">${esc(i.name)} ${NT(i.amount)}</span>`).join('') || '<span class="muted">—</span>';
    $('paySetBody').innerHTML = r.employees.map((e) => {
      const low = e.pay_amount && (e.pay_type === 'monthly' ? e.pay_amount < r.min_wage.monthly : e.pay_amount < r.min_wage.hourly);
      return `<tr><td><span class="who">${avatar(e.name, 'sm')}${esc(e.name)} ${e.is_sample ? B.sample() : ''}</span></td>
      <td><span class="badge ${e.pay_type === 'hourly' ? 'b-info' : 'b-brand'}">${e.pay_type === 'hourly' ? '時薪' : '月薪'}</span></td>
      <td class="num r">${e.pay_amount ? `<b>${ntd(e.pay_amount)}</b>${e.pay_type === 'monthly' ? `<span class="sub">時薪 ${(e.pay_amount / 240).toFixed(2)}</span>` : `<span class="sub">每小時・國定假日照給 ${e.holiday_hours == null ? r.standard_hours : +e.holiday_hours} 小時</span>`}` : '<span class="badge b-warning">尚未設定</span>'}${low ? `<span class="sub" style="color:var(--danger)">低於基本工資</span>` : ''}</td>
      <td>${itemsOf(e, 'allow')}</td><td>${itemsOf(e, 'deduct')}</td>
      <td class="wrap muted">${esc(e.pay_note) || '—'}</td>
      <td><div class="cell-actions"><button class="btn secondary sm" data-payedit="${e.id}">${icon('pencil', 15)}編輯</button></div></td></tr>`;
    }).join('') || emptyRow(7, '尚無員工', '請先到「員工管理」新增員工', 'users');
    $('paySetBody').querySelectorAll('[data-payedit]').forEach((b) => b.onclick = () => payEmpModal(r.employees.find((e) => e.id == b.dataset.payedit)));
    $('prLate').checked = r.rules.late_deduct; $('prClip').checked = r.rules.clip_early; $('prUnit').value = String(r.rules.ot_unit);
    try { const me = await api('/api/admin/me'); $('prStart').textContent = me.settings.work_start; } catch (e) {}
    const opt = (v) => ({ 1: '照給（100%）', 0.5: '半薪（50%）', 0: '不給薪（0%）' }[v] || `${Math.round(v * 100)}%`);
    $('prTypes').innerHTML = r.leave_types.map((t) => {
      const preset = [1, 0.5, 0].includes(+t.pay_ratio);
      return `<tr data-tid="${t.id}"><td><b>${esc(t.name)}</b>${t.active ? '' : ' <span class="badge b-neutral">停用</span>'}</td>
      <td><div class="inline-actions" style="flex-wrap:nowrap"><select class="pr-ratio" aria-label="${esc(t.name)} 給薪比例" style="width:auto;min-width:140px"><option value="1">照給（100%）</option><option value="0.5">半薪（50%）</option><option value="0">不給薪（0%）</option><option value="custom">自訂…</option></select>
        <input type="number" class="pr-custom ${preset ? 'hidden' : ''}" min="0" max="100" step="1" value="${Math.round(t.pay_ratio * 100)}" aria-label="${esc(t.name)} 自訂給薪百分比" style="width:84px"><span class="pr-pct ${preset ? 'hidden' : ''}">%</span></div></td>
      <td><input type="number" class="pr-cap" min="0" max="366" step="0.5" value="${t.pay_cap_days ?? ''}" placeholder="無上限" aria-label="${esc(t.name)} 每年給薪上限天數" style="width:110px"></td>
      <td class="muted">${opt(t.default_ratio)}${t.default_cap ? `・每年 ${t.default_cap} 天` : ''}</td></tr>`;
    }).join('');
    $('prTypes').querySelectorAll('tr').forEach((tr) => {
      const t = r.leave_types.find((x) => x.id == tr.dataset.tid);
      const sel = tr.querySelector('.pr-ratio');
      sel.value = [1, 0.5, 0].includes(+t.pay_ratio) ? String(+t.pay_ratio) : 'custom';
      sel.onchange = () => { const c = sel.value === 'custom'; tr.querySelector('.pr-custom').classList.toggle('hidden', !c); tr.querySelector('.pr-pct').classList.toggle('hidden', !c); };
    });
  } catch (e) { handle(e); }
}
// ---------- 寄送薪資單 ----------
function infoModal(html, title, ic = 'info', okText = '知道了', onOk = null) {
  modal(`<form class="form-grid">${html}<div class="actions"><button type="button" class="btn secondary" data-cancel>關閉</button>${onOk ? `<button type="submit" class="btn">${okText}</button>` : `<button type="submit" class="btn hidden">關閉</button>`}</div></form>`, async () => { if (onOk) onOk(); }, { title, icon: ic });
}
async function openSendDialog(ids) {
  if (!payCur) return;
  const month = payCur.month, [y, m] = month.split('-').map(Number);
  let d;
  try { d = await api(`/api/admin/payroll/${month}/sends`); } catch (e) { return handle(e); }
  if (!d.confirmed) return infoModal(`<div class="alert warn">${icon('lock', 18)}<div><b>${y} 年 ${m} 月薪資尚未確認。</b><br>為避免寄出還會變動的金額，只有「已確認」的月份可以寄送薪資單。請先檢查無誤後按「確認 ${m} 月薪資」。</div></div>`, '寄送薪資單', 'send');
  if (!d.smtp.configured) return infoModal(`<div class="alert warn">${icon('mail', 18)}<div><b>尚未完成寄信設定。</b><br>請到「薪資設定」填寫 SMTP 主機、帳號密碼與寄件者 Email（可使用公司的 Gmail）。</div></div>`, '寄送薪資單', 'send', '前往寄信設定', () => { setPtab('set'); setTimeout(() => $('mailForm').scrollIntoView({ behavior: 'smooth' }), 300); });
  const list = d.recipients.filter((r) => !ids || ids.includes(r.id));
  const EMAIL_OK = (v) => /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(v) && !isDemoEmail(v);
  const can = (r) => EMAIL_OK(r.email) && !r.no_national_id;
  const stBadge = (r) => r.no_national_id ? `<span class="badge b-warning" title="${esc(r.note)}">${icon('lock')}未登錄身分證字號，無法寄送</span>`
    : !can(r) ? ''
    : r.last_sent ? `<span class="badge b-warning">${icon('alert')}已於 ${esc(r.last_sent.at_text.slice(5))} 寄過</span>`
    : r.last && r.last.status === 'failed' ? `<span class="badge b-danger">${icon('alertCircle')}上次失敗</span>` : `<span class="badge b-success">${icon('send')}將寄送</span>`;
  const row = (r) => `<div class="rc-row ${can(r) ? '' : 'dis'}" data-row="${r.id}">
      <label class="rc-ck"><input type="checkbox" data-rid="${r.id}" ${can(r) ? (r.last_sent ? '' : 'checked') : 'disabled'} aria-label="寄給 ${esc(r.name)}"></label>
      <span class="rc-main"><span class="rc-top"><span class="who">${avatar(r.name, 'sm')}<b>${esc(r.name)}</b></span><span class="rc-net num">${NT(r.net)}</span></span>
        <span class="rc-emw"><input type="email" class="rc-email" data-eid="${r.id}" value="${can(r) ? esc(r.email) : ''}" placeholder="輸入 Email" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${esc(r.name)} 的 Email"><span class="rc-saved" aria-live="polite"></span></span>
        <span class="rc-st">${stBadge(r)}</span></span></div>`;
  const pwText = { id: '密碼為身分證字號（英文大寫）', fixed: '固定密碼', none: '不加密' }[d.pdf_password_mode];
  const noIds = list.filter((r) => r.no_national_id);
  const saving = new Map();
  modal(`<form class="form-grid send-form" novalidate>
    <dl class="send-meta"><dt>月份</dt><dd>${y} 年 ${m} 月（已確認）</dd><dt>寄件者</dt><dd>${esc(d.smtp.from)}</dd><dt>主旨</dt><dd>${esc(d.subject)}</dd><dt>附件</dt><dd>PDF 薪資單・開啟密碼：${pwText}</dd></dl>
    ${noIds.length ? `<div class="alert warn" id="sdNoId">${icon('lock', 18)}<div><b>${noIds.map((r) => esc(r.name)).join('、')}</b> 尚未登錄身分證字號，無法產生加密的薪資單，這次不會寄給${noIds.length > 1 ? '他們' : '這位員工'}。<br><a href="#" id="sdGoEmp">前往「員工管理」補上身分證字號</a></div></div>` : ''}
    <div><div class="label">收件人</div>
    <div class="rc-list">${list.map(row).join('') || '<p class="muted" style="margin:12px">沒有員工</p>'}</div></div>
    <div class="alert warn hidden" id="sdDup">${icon('alert', 18)}<div id="sdDupText"></div></div>
    <p class="help" style="margin:0">寄出後無法收回。已寄過的員工預設不勾選，避免重複寄送。</p>
    <div class="actions"><button type="button" class="btn secondary" data-cancel>取消</button><button type="submit" class="btn" id="sdGo">${icon('send', 16)}確認寄送</button></div>
  </form>`, async (f) => {
    await Promise.all([...saving.values()]);
    if (f.querySelector('.rc-email.err')) throw new Error('有 Email 尚未儲存成功，請檢查');
    const chosen = [...f.querySelectorAll('[data-rid]:checked')].map((x) => Number(x.dataset.rid));
    if (!chosen.length) throw new Error('請至少勾選一位員工');
    const force = chosen.some((id) => list.find((r) => r.id === id).last_sent);
    $('sdGo').innerHTML = `${icon('hourglass', 16)}寄送中…`;
    const r = await api(`/api/admin/payroll/${month}/send`, { method: 'POST', body: { employee_ids: chosen, force } });
    setTimeout(() => showSendResult(r, month), 0);
    loadPayroll();
  }, { title: ids && ids.length === 1 ? `寄送薪資單給 ${list[0] ? list[0].name : ''}` : `寄送 ${m} 月薪資單`, icon: 'send' });
  $('modal').classList.add('wide');
  if (document.activeElement) document.activeElement.blur(); $('modal').scrollTop = 0;
  if ($('sdGoEmp')) $('sdGoEmp').onclick = (ev) => { ev.preventDefault(); closeModal(); go('employees'); };
  // 直接在視窗中編輯 Email：格式正確（且不是示範網域）就能勾選，離開欄位時自動存到員工資料
  const refreshRow = (r) => {
    const el = $('modal').querySelector(`[data-row="${r.id}"]`), ck = el.querySelector('[data-rid]');
    const ok = can(r), was = !ck.disabled;
    el.classList.toggle('dis', !ok); ck.disabled = !ok;
    if (!ok) ck.checked = false; else if (!was) ck.checked = !r.last_sent;
    el.querySelector('.rc-st').innerHTML = stBadge(r);
  };
  $('modal').querySelectorAll('.rc-email').forEach((inp) => {
    const r = list.find((x) => x.id == inp.dataset.eid);
    let savedVal = can(r) ? r.email : '';
    inp.oninput = () => { r.email = inp.value.trim(); inp.classList.remove('err'); inp.classList.toggle('bad', !!r.email && !EMAIL_OK(r.email)); refreshRow(r); sync(); };
    inp.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); } };
    inp.onchange = () => {
      const v = inp.value.trim();
      if (v === savedVal || (v && !EMAIL_OK(v))) return;
      const tip = inp.parentElement.querySelector('.rc-saved'); tip.innerHTML = icon('hourglass', 14);
      const job = api(`/api/admin/employees/${r.id}/email`, { method: 'PUT', body: { email: v } })
        .then(() => { savedVal = v; tip.innerHTML = icon('check', 14); tip.title = '已儲存'; loadEmployees(); })
        .catch((e) => { inp.classList.add('err'); tip.innerHTML = ''; handle(e); })
        .finally(() => saving.delete(r.id));
      saving.set(r.id, job);
    };
  });
  const sync = () => {
    const ck = [...$('modal').querySelectorAll('[data-rid]:checked')];
    const dup = ck.map((x) => list.find((r) => r.id == x.dataset.rid)).filter((r) => r.last_sent);
    $('sdDup').classList.toggle('hidden', !dup.length);
    $('sdDupText').innerHTML = dup.length ? `<b>${dup.map((r) => esc(r.name)).join('、')}</b> 已經寄過本月薪資單，確認後會<b>再寄一次</b>。` : '';
    $('sdGo').disabled = !ck.length;
    $('sdGo').innerHTML = `${icon('send', 16)}${ck.length ? `確認寄送 ${ck.length} 封` : '請勾選收件人'}`;
  };
  $('modal').querySelectorAll('[data-rid]').forEach((x) => x.onchange = sync); sync();
}
function showSendResult(r, month) {
  const lab = { sent: ['b-success', 'check', '已寄出'], failed: ['b-danger', 'alertCircle', '失敗'], skipped: ['b-neutral', 'info', '略過'] };
  infoModal(`<div class="alert ${r.failed ? 'danger' : 'ok'}">${icon(r.failed ? 'alertCircle' : 'check', 18)}<div>寄出 <b>${r.sent}</b> 封${r.failed ? `，失敗 <b>${r.failed}</b> 封` : ''}${r.skipped ? `，略過 ${r.skipped} 位` : ''}。</div></div>
    <div class="send-wrap"><table class="send-list"><tbody>${r.results.map((x) => `<tr><td><b>${esc(x.name)}</b><div class="em muted">${esc(x.email) || '—'}</div></td><td><span class="badge ${lab[x.status][0]}">${icon(lab[x.status][1])}${lab[x.status][2]}</span>${x.error ? `<div class="help" style="margin:4px 0 0">${esc(x.error)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>`, `${month} 寄送結果`, 'send');
}

// ---------- 寄信設定 ----------
let mailCfg = null;
const PRESETS = { gmail: { host: 'smtp.gmail.com', port: 465, secure: '1' }, m365: { host: 'smtp.office365.com', port: 587, secure: '0' } };
function mailBody() {
  return { host: $('mHost').value.trim(), port: Number($('mPort').value), secure: $('mSecure').value === '1', user: $('mUser').value.trim(), password: $('mPass').value, clear_password: $('mPassClear').checked,
    from_name: $('mFromName').value.trim(), from_addr: $('mFromAddr').value.trim(), subject: $('mSubject').value, body: $('mBody').value,
    pdf_password_mode: (document.querySelector('input[name=mPw]:checked') || {}).value || 'id', pdf_password_fixed: $('mFixed').value };
}
function mailMsg(kind, html) { const el = $('mailResult'); el.className = `alert ${kind}`; el.innerHTML = `${icon(kind === 'ok' ? 'check' : kind === 'info' ? 'hourglass' : 'alertCircle', 18)}<div>${html}</div>`; }
async function loadMailSettings() {
  try {
    const c = mailCfg = await api('/api/admin/smtp');
    $('mHost').value = c.host; $('mPort').value = c.port; $('mSecure').value = c.secure ? '1' : '0'; $('mUser').value = c.user;
    $('mPass').value = ''; $('mPass').placeholder = c.has_password ? '已設定（不會顯示），留空表示不變更' : '尚未設定';
    $('mPassClear').checked = false; $('mPassClearWrap').classList.toggle('hidden', !c.has_password || c.env);
    $('mFromName').value = c.from_name || c.company_name || ''; $('mFromAddr').value = c.from_addr; $('mSubject').value = c.subject; $('mBody').value = c.body;
    document.querySelectorAll('input[name=mPw]').forEach((x) => (x.checked = x.value === c.pdf_password_mode));
    $('mFixed').value = ''; $('mFixed').placeholder = c.has_fixed_password ? '已設定（不會顯示），留空表示不變更' : '尚未設定';
    syncMailPw();
    $('mailEnv').classList.toggle('hidden', !c.env);
    ['mHost', 'mPort', 'mSecure', 'mUser', 'mPass'].forEach((id) => ($(id).disabled = c.env)); $('mailPresets').classList.toggle('hidden', c.env);
    $('mailResult').classList.add('hidden');
  } catch (e) { handle(e); }
}
function syncMailPw() { $('mFixedWrap').classList.toggle('hidden', ((document.querySelector('input[name=mPw]:checked') || {}).value) !== 'fixed'); }
document.querySelectorAll('input[name=mPw]').forEach((x) => (x.onchange = syncMailPw));
document.querySelectorAll('[data-preset]').forEach((b) => b.onclick = () => {
  const p = PRESETS[b.dataset.preset]; $('mHost').value = p.host; $('mPort').value = p.port; $('mSecure').value = p.secure;
  if (!$('mFromAddr').value && $('mUser').value.includes('@')) $('mFromAddr').value = $('mUser').value;
  toast(`已套用 ${b.textContent} 設定，請填寫帳號與密碼`, 'ok');
});
$('mUser').onchange = () => { if (!$('mFromAddr').value && $('mUser').value.includes('@')) $('mFromAddr').value = $('mUser').value.trim(); };
$('mPort').onchange = () => { if ($('mPort').value === '465') $('mSecure').value = '1'; else if (['587', '25', '2525'].includes($('mPort').value)) $('mSecure').value = '0'; };
$('mBodyReset').onclick = () => { if (mailCfg) $('mBody').value = mailCfg.default_body; };
$('mailForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const btn = ev.submitter || $('mailForm').querySelector('[type=submit]'); btn.disabled = true;
  try { await api('/api/admin/smtp', { method: 'PUT', body: mailBody() }); toast('寄信設定已儲存', 'ok'); await loadMailSettings(); } catch (err) { handle(err); } finally { btn.disabled = false; }
};
$('mailVerify').onclick = async () => {
  const b = mailBody();
  if (!b.host && !(mailCfg && mailCfg.env)) return mailMsg('danger', '請先填寫 SMTP 主機');
  $('mailVerify').disabled = true; mailMsg('info', `正在連線 ${esc(b.host || mailCfg.host)}:${esc(b.port || mailCfg.port)}…（不會寄出任何信件）`);
  try {
    const r = await api('/api/admin/smtp/verify', { method: 'POST', body: b });
    mailMsg(r.ok ? 'ok' : 'danger', `<b>${esc(r.message)}</b><br><span style="opacity:.85">${esc(r.host)}:${r.port}・${r.secure ? 'SSL/TLS' : 'STARTTLS／不加密'}・${r.ms} 毫秒・未寄出任何信件</span>`);
  } catch (err) { mailMsg('danger', esc(err.message)); } finally { $('mailVerify').disabled = false; }
};
$('mailTest').onclick = () => {
  if (!mailCfg || !mailCfg.configured) return mailMsg('danger', '請先填寫 SMTP 主機與寄件者 Email，並按「儲存寄信設定」');
  modal(`<form class="form-grid"><p style="margin:0">會用目前<b>已儲存</b>的設定寄一封測試信（不含薪資資料），確認寄信設定正確。</p>
    <div><label for="mtTo">收件 Email</label><input type="email" id="mtTo" name="to" required value="${esc(mailCfg.from_addr || '')}" spellcheck="false"></div>${actions('寄送測試信')}</form>`,
  async (f) => { const r = await api('/api/admin/smtp/test', { method: 'POST', body: formData(f) }); toast(r.message, 'ok'); mailMsg('ok', esc(r.message)); }, { title: '寄送測試信', icon: 'send' });
};
$('payRulesForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const leave_types = [...$('prTypes').querySelectorAll('tr')].map((tr) => {
    const sel = tr.querySelector('.pr-ratio').value;
    return { id: Number(tr.dataset.tid), pay_ratio: sel === 'custom' ? Number(tr.querySelector('.pr-custom').value || 0) / 100 : Number(sel), pay_cap_days: tr.querySelector('.pr-cap').value };
  });
  try { await api('/api/admin/payroll/rules', { method: 'PUT', body: { late_deduct: $('prLate').checked, clip_early: $('prClip').checked, ot_unit: Number($('prUnit').value), leave_types } }); toast('計算規則已儲存', 'ok'); loadPaySettings(); } catch (err) { handle(err); }
};
function payItemRow(it = { kind: 'allow', name: '', amount: '' }) {
  return `<div class="pay-item"><select class="pi-kind" aria-label="類型"><option value="allow" ${it.kind !== 'deduct' ? 'selected' : ''}>津貼（加）</option><option value="deduct" ${it.kind === 'deduct' ? 'selected' : ''}>扣項（減）</option></select>
    <input type="text" class="pi-name" maxlength="20" value="${esc(it.name)}" placeholder="例如：伙食津貼、勞保自付額" aria-label="名稱">
    <input type="number" class="pi-amt" min="0" step="1" value="${esc(it.amount)}" placeholder="金額" aria-label="金額" inputmode="numeric">
    <button type="button" class="btn danger-ghost sm icon-only" data-pirm title="移除" aria-label="移除這一項">${icon('trash', 15)}</button></div>`;
}
function payEmpModal(e) {
  modal(`<form class="form-grid">
    <div class="summary-box"><span class="who">${avatar(e.name, 'sm')}${esc(e.name)} ${e.is_sample ? B.sample() : ''}</span></div>
    <div><div class="label">計薪方式</div><div class="opt-grid" style="grid-template-columns:1fr 1fr" role="radiogroup" aria-label="計薪方式">
      <label class="opt"><input type="radio" name="pay_type" value="monthly" ${e.pay_type !== 'hourly' ? 'checked' : ''}><span>月薪<small>固定月薪，請假依假別扣薪</small></span></label>
      <label class="opt"><input type="radio" name="pay_type" value="hourly" ${e.pay_type === 'hourly' ? 'checked' : ''}><span>時薪<small>依實際工時計薪</small></span></label></div></div>
    <div><label for="peAmt" id="peAmtL">金額</label><input type="number" id="peAmt" name="pay_amount" min="0" step="1" value="${e.pay_amount || ''}" required inputmode="numeric"><p class="help" id="peHint"></p></div>
    <div id="peHolWrap"><label for="peHol">國定假日照給時數（每日）</label><input type="number" id="peHol" min="0" max="12" step="0.5" value="${e.holiday_hours ?? ''}" placeholder="${paySet.standard_hours || 8}（依標準工時）" inputmode="decimal">
      <p class="help">原約定平日每天工作幾小時；平日遇國定假日放假時照給「時薪 × 此時數」。沒有固定排班的兼職請填 0（國定假日未出勤不給薪，出勤仍加倍）。</p></div>
    <div><div class="label">固定津貼／固定扣項（每月）</div><div id="peItems" class="pay-items">${e.pay_items.map(payItemRow).join('')}</div>
      <button type="button" class="btn soft sm" id="peAdd" style="margin-top:8px">${icon('plus', 15)}新增一項</button>
      <p class="help">勞保、健保自付額請依投保級距手動填寫（系統不自動計算）。</p></div>
    <div><label for="peNote">備註（選填）</label><input type="text" id="peNote" name="pay_note" maxlength="100" value="${esc(e.pay_note)}"></div>
    ${actions('儲存')}</form>`,
  async (f) => {
    const items = [...$('peItems').querySelectorAll('.pay-item')].map((r) => ({ kind: r.querySelector('.pi-kind').value, name: r.querySelector('.pi-name').value, amount: r.querySelector('.pi-amt').value }));
    await api('/api/admin/payroll/employees/' + e.id, { method: 'PUT', body: { pay_type: f.querySelector('[name=pay_type]:checked').value, pay_amount: $('peAmt').value, pay_note: $('peNote').value, pay_items: items, holiday_hours: $('peHol').value } });
    toast(`已更新 ${e.name} 的薪資設定`, 'ok'); loadPaySettings();
  }, { title: '薪資設定', icon: 'banknote' });
  const mw = paySet.min_wage;
  const sync = () => {
    const h = $('modal').querySelector('[name=pay_type]:checked').value === 'hourly';
    $('peAmtL').textContent = h ? '時薪（NT$／小時）' : '月薪（NT$）';
    $('peHolWrap').classList.toggle('hidden', !h);
    const v = Number($('peAmt').value || 0);
    $('peHint').innerHTML = (h ? `${mw.year} 年基本工資時薪 NT$ ${mw.hourly}` : `換算時薪 ${v ? (v / 240).toFixed(2) : '—'}（月薪 ÷ 30 ÷ 8）・${mw.year} 年基本工資月薪 NT$ ${NT(mw.monthly)}`)
      + (v && v < (h ? mw.hourly : mw.monthly) ? '　<b style="color:var(--danger)">低於基本工資</b>' : '');
  };
  $('modal').querySelectorAll('[name=pay_type]').forEach((x) => x.onchange = sync); $('peAmt').oninput = sync; sync();
  const bindRm = () => $('peItems').querySelectorAll('[data-pirm]').forEach((b) => b.onclick = () => b.closest('.pay-item').remove());
  $('peAdd').onclick = () => { $('peItems').insertAdjacentHTML('beforeend', payItemRow()); bindRm(); $('peItems').lastElementChild.querySelector('.pi-name').focus(); };
  bindRm();
}

// =========================================================
// 國定假日
// =========================================================
let holYear = null, holCur = null;
const HOL_BADGE = { statutory: 'b-holiday', makeup: 'b-holiday', swap_in: 'b-holiday', custom: 'b-accent', swap_out: 'b-neutral', bridge: 'b-neutral', gov_workday: 'b-neutral' };
async function loadHolidays() {
  try {
    const r = await api('/api/admin/holidays' + (holYear ? `?year=${holYear}` : ''));
    holCur = r; holYear = r.year;
    $('holYear').textContent = `${r.year} 年`;
    $('holPrev').disabled = r.year <= r.years[0]; $('holNext').disabled = r.year >= r.years[r.years.length - 1];
    const sm = r.summary;
    $('holSum').innerHTML = `<span class="badge b-holiday">${icon('flag')}國定假日 ${sm.statutory} 日</span><span class="badge b-holiday">補假 ${sm.makeup} 日</span>${sm.swaps ? `<span class="badge b-neutral">${icon('repeat')}調移 ${sm.swaps}</span>` : ''}${sm.custom ? `<span class="badge b-accent">公司自訂 ${sm.custom}</span>` : ''}<span class="badge b-neutral">平日放假共 ${sm.weekday_off} 天</span>`;
    $('holNote').innerHTML = r.published ? '' : `<div class="alert info">${icon('info', 18)}<div>人事行政總處尚未公告 ${r.year} 年辦公日曆表（或系統尚未更新），目前只顯示公司自訂假日。公告後執行 <code>node scripts/build-holidays.js ${r.year - 1911}</code> 更新。</div></div>`;
    const byMonth = new Map();
    for (const h of r.list) { const m = Number(h.date.slice(5, 7)); if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(h); }
    $('holList').innerHTML = [...byMonth].map(([m, hs]) => `<section class="card hol-month"><h3>${m} 月</h3>${hs.map(holRow).join('')}</section>`).join('')
      || `<div class="card"><div class="empty"><span class="empty-ic">${icon('flag', 24)}</span><b>${r.year} 年尚無假日資料</b>可按右上角新增公司自訂假日</div></div>`;
    $('holList').querySelectorAll('[data-hswap]').forEach((b) => b.onclick = () => holSwap(r.list.find((x) => x.date === b.dataset.hswap)));
    $('holList').querySelectorAll('[data-hdel]').forEach((b) => b.onclick = () => holDelete(r.list.find((x) => String(x.change_id) === b.dataset.hdel)));
    $('holList').querySelectorAll('[data-hbridge]').forEach((b) => b.onchange = async () => {
      try { await api('/api/admin/holidays/bridge/' + b.dataset.hbridge, { method: 'PUT', body: { adopt: b.checked } }); toast(b.checked ? '已設為比照放假' : '已改為照常上班', 'ok'); loadHolidays(); } catch (err) { b.checked = !b.checked; handle(err); }
    });
  } catch (e) { handle(e); }
}
function holRow(h) {
  const [, mm, dd] = h.date.split('-');
  let act = '';
  if (h.locked) act = `<span class="badge b-neutral" title="該月薪資已確認">${icon('lock')}已鎖定</span>`;
  else if ((h.kind === 'statutory' || h.kind === 'makeup') && !h.weekend) act = `<button class="btn secondary sm" data-hswap="${h.date}">${icon('repeat', 15)}調移</button>`;
  else if (h.kind === 'swap_out' || h.kind === 'swap_in') act = `<button class="btn ghost sm" data-hdel="${h.change_id}">${icon('undo', 15)}取消調移</button>`;
  else if (h.kind === 'custom') act = `<button class="btn danger-ghost sm" data-hdel="${h.change_id}">${icon('trash', 15)}刪除</button>`;
  else if (h.kind === 'bridge') act = `<label class="switch-row hol-sw"><input type="checkbox" class="switch" data-hbridge="${h.date}" ${h.adopted ? 'checked' : ''}><span class="d">比照放假</span></label>`;
  const kindText = h.kind === 'statutory' && h.weekend ? '國定假日・逢週末' : h.kind_text;
  return `<div class="hol-row ${h.off ? '' : 'is-work'} ${h.weekend ? 'is-wknd' : ''}">
    <div class="hol-date"><b>${Number(mm)}/${Number(dd)}</b><span>週${h.weekday}</span></div>
    <div class="hol-main"><div class="hol-name">${esc(h.name)}</div><div class="hol-meta"><span class="badge ${HOL_BADGE[h.kind]}">${esc(kindText)}</span>${h.note ? `<span class="hol-note">${esc(h.note)}</span>` : ''}</div></div>
    <div class="hol-act">${act}</div></div>`;
}
function holSwap(h) {
  modal(`<form class="form-grid">
    <div class="summary-box"><b>${esc(h.name)}</b>・${mdw(h.date)}</div>
    <div class="alert warn">${icon('alert', 18)}<div>調移需經勞工<b>個人同意</b>（勞動部 104/04/23 函釋）。調移後 ${mdw(h.date)} 照常上班、出勤不加倍；新的日期放假並具國定假日性質，該日出勤仍加倍發給。此設定套用全體員工。</div></div>
    <div><label for="hsTo">改到哪一天放假（原本要上班的平日）</label><input type="date" id="hsTo" name="to_date" required min="${h.date.slice(0, 4)}-01-01" max="${Number(h.date.slice(0, 4)) + 1}-12-31"></div>
    <div><label for="hsNote">備註（選填）</label><input type="text" id="hsNote" name="note" maxlength="100" placeholder="例如：全體同仁同意，與 10/12 對調"></div>
    ${actions('確認調移')}</form>`,
  async (f) => { await api('/api/admin/holidays/swap', { method: 'POST', body: { date: h.date, ...formData(f) } }); toast('已調移', 'ok'); loadHolidays(); }, { title: '調移國定假日', icon: 'repeat' });
}
function holDelete(h) {
  const swap = h.kind === 'swap_in' || h.kind === 'swap_out';
  modal(`<form class="form-grid"><p style="margin:0">${swap ? `取消調移後，${esc(h.name.replace('（調移）', ''))}會回到原本的日期放假。` : `確定刪除公司自訂假日「${esc(h.name)}」（${mdw(h.date)}）？當天會改為正常上班日。`}</p>${actions(swap ? '取消調移' : '刪除', true)}</form>`,
    async () => { await api('/api/admin/holidays/changes/' + h.change_id, { method: 'DELETE' }); toast(swap ? '已取消調移' : '已刪除', 'ok'); loadHolidays(); }, { title: swap ? '取消調移' : '刪除公司自訂假日', icon: swap ? 'undo' : 'trash', danger: true });
}
$('holPrev').onclick = () => { holYear = holCur.years[holCur.years.indexOf(holYear) - 1] || holYear - 1; loadHolidays(); };
$('holNext').onclick = () => { holYear = holCur.years[holCur.years.indexOf(holYear) + 1] || holYear + 1; loadHolidays(); };
$('holAdd').onclick = () => modal(`<form class="form-grid">
    <div><label for="hcDate">日期</label><input type="date" id="hcDate" name="date" required value="${holYear && String(holYear) !== taipeiToday().slice(0, 4) ? `${holYear}-01-02` : taipeiToday()}"></div>
    <div><label for="hcName">假日名稱</label><input type="text" id="hcName" name="name" required maxlength="20" placeholder="例如：公司週年慶、尾牙隔天"></div>
    <div><label for="hcNote">備註（選填）</label><input type="text" id="hcNote" name="note" maxlength="100"></div>
    <p class="help" style="margin:0">${icon('info', 14)} 公司自訂假日為公司給的有薪假：當天不需請假、不算遲到；月薪照給，時薪人員不另計（如要給薪請用薪資調整）。不具國定假日性質，出勤依平日計。</p>
    ${actions('新增')}</form>`,
  async (f) => { await api('/api/admin/holidays/custom', { method: 'POST', body: formData(f) }); toast('已新增公司自訂假日', 'ok'); holYear = Number(f.date.value.slice(0, 4)); loadHolidays(); }, { title: '新增公司自訂假日', icon: 'flag' });

init();

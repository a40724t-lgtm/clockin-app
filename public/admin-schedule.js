// =========================================================
// 排班（管理員：全部員工；主管：自己的團隊）
// 點格子 → 選班別 → 立即存檔（草稿）；按底部「發布」後員工才看得到
// =========================================================
const SCH = { view: 'week', anchor: null, dept: '', data: null, tab: 'cal' };
const schMobile = matchMedia('(max-width: 760px)');
const WD_ORDER = ['一', '二', '三', '四', '五', '六', '日'];
const WD_SUN = ['日', '一', '二', '三', '四', '五', '六'];
const mondayOf = (d) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return addDays(d, -((w + 6) % 7)); };
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const monthEnd = (m) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10); };
const wdOfD = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const isWkend = (d) => { const w = wdOfD(d); return w === 0 || w === 6; };
const K = (e, d) => `${e}|${d}`;
const hm = (t) => (t.endsWith(':00') ? String(Number(t.slice(0, 2))) : t.replace(/^0/, ''));
const fitsStaff = (t, emp) => !t.applies || t.applies === 'all' || t.applies === emp.staff;

function schRange() {
  if (SCH.view === 'week') return { from: SCH.anchor, to: addDays(SCH.anchor, 6) };
  const first = SCH.anchor.slice(0, 8) + '01', last = monthEnd(SCH.anchor.slice(0, 7));
  return { from: first, to: last, first, last };
}
function setStab(t) {
  if (t === 'hol' && ROLE !== 'owner') t = 'cal';
  if (!['cal', 'staff', 'tpl', 'hol'].includes(t)) t = 'cal';
  SCH.tab = t; closePick();
  document.querySelectorAll('[data-stab]').forEach((b) => { const on = b.dataset.stab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  document.querySelectorAll('[data-spane]').forEach((p) => p.classList.toggle('hidden', p.dataset.spane !== t));
  if (t === 'cal') loadSchedule();
  if (t === 'staff') loadStaff();
  if (t === 'tpl') loadTemplates();
  if (t === 'hol') loadHolidays();
}
document.querySelectorAll('[data-stab]').forEach((b) => b.onclick = () => setStab(b.dataset.stab));
function loadSchedulePage(tab) {
  if (!SCH.anchor) SCH.anchor = mondayOf(taipeiToday());
  $('schHead').textContent = ROLE === 'manager' ? '點格子選班別就排好；按「發布」後您團隊的員工才看得到' : '點員工、選班別，排好一天；按「發布」後員工才看得到';
  setStab(tab || (SCH.tab === 'hol' && ROLE !== 'owner' ? 'cal' : SCH.tab));
}

async function loadSchedule() {
  const { from, to } = schRange();
  try {
    const r = await api(`/api/admin/schedule?from=${from}&to=${to}`);
    SCH.data = r;
    r.E = new Map(r.entries.map((x) => [K(x.employee_id, x.date), x]));
    r.P = new Map(r.published.map((x) => [K(x.employee_id, x.date), x]));
    r.L = new Map(); for (const l of r.leaves) { const k = K(l.employee_id, l.date); if (!r.L.has(k)) r.L.set(k, []); r.L.get(k).push(l); }
    r.H = new Map(r.holidays.map((h) => [h.date, h]));
    r.W = new Map(); for (const w of r.warnings) { const k = K(w.employee_id, w.date); if (!r.W.has(k)) r.W.set(k, []); r.W.get(k).push(w); }
    r.O = new Map((r.dayoff || []).map((o) => [K(o.employee_id, o.date), o]));
    const depts = [...new Set(r.employees.map((e) => e.department).filter(Boolean))];
    $('schDept').innerHTML = `<option value="">${ROLE === 'manager' ? '我的團隊' : '全部'}（${r.employees.length} 人）</option>` + depts.map((d) => `<option ${d === SCH.dept ? 'selected' : ''}>${esc(d)}</option>`).join('');
    $('schDept').classList.toggle('hidden', depts.length < 2);
    if (!depts.includes(SCH.dept)) SCH.dept = '';
    renderSchedule();
  } catch (e) { handle(e); }
}
const schEmps = () => SCH.data.employees.filter((e) => !SCH.dept || e.department === SCH.dept);
const sameEntry = (a, b) => (!a && !b) || (a && b && ['kind', 'start', 'end', 'break_min', 'name', 'note'].every((k) => a[k] === b[k]));
const isClosedDay = (d) => { const h = SCH.data.H.get(d); return !!(h && h.off && h.kind === 'custom'); };
const fullLeave = (k) => (SCH.data.L.get(k) || []).find((l) => l.kind === 'leave');

function chip(x, opts = {}) {
  if (x.kind === 'rest' || x.kind === 'regular') return `<span class="sc sc-off"><b>${x.kind === 'regular' ? '例' : '休'}</b></span>`;
  if (x.kind === 'leave') return '<span class="sc sc-leave"><b>假</b></span>';
  return `<span class="sc sc-${esc(x.color || 'primary')}"><b>${esc(x.name)}</b>${opts.short ? '' : `<span>${hm(x.start)}–${x.overnight ? '翌' : ''}${hm(x.end)}</span>`}</span>`;
}
// 一格的狀態
function cellState(emp, d) {
  const r = SCH.data, k = K(emp.id, d);
  const x = r.E.get(k), p = r.P.get(k), lv = r.L.get(k) || [], w = r.W.get(k) || [], o = r.O.get(k), h = r.H.get(d);
  return { k, x, p, lv, w, o, h, closed: isClosedDay(d), leave: fullLeave(k), dirty: !sameEntry(x, p) };
}
function cellHtml(emp, d) {
  const c = cellState(emp, d);
  let inner;
  if (c.x) inner = chip(c.x);
  else if (c.leave) inner = chip({ kind: 'leave' });
  else if (c.closed) inner = '<span class="cl">公休</span>';
  else inner = `<span class="plus">${icon('plus', 14)}</span>`;
  const marks = [
    c.x && c.leave ? '<span class="mk-c lv">假</span>' : '',
    c.o && !c.closed ? `<span class="mk-c no" title="${esc(c.o.text)}">不可</span>` : '',
    c.w.length ? `<span class="mk-c warn" title="${esc(c.w.map((y) => y.text).join('\n'))}">!</span>` : '',
    c.dirty ? '<span class="mk-c dirty" title="尚未發布"></span>' : c.x ? `<span class="mk-c pub" title="已發布">${icon('check', 9)}</span>` : '',
  ].join('');
  const label = [emp.name, mdw(d), c.x ? (c.x.kind === 'shift' ? c.x.name : c.x.kind_text) : c.leave ? '請假' : c.closed ? '公休' : '未排', c.o ? '不可排班' : '', c.w.length ? `${c.w.length} 項提醒` : '', c.x ? (c.dirty ? '未發布' : '已發布') : c.dirty ? '已清除未發布' : ''].filter(Boolean).join('，');
  return `<button type="button" class="sg-cell ${c.closed ? 'is-closed' : ''} ${c.o ? 'is-off' : ''}" data-ce="${emp.id}" data-cd="${d}" aria-label="${esc(label)}">${inner}${marks}</button>`;
}
// 每位員工：上幾天・休幾天（月檢視 + 正職每月休假目標）
function empCount(emp, days) {
  const r = SCH.data; let work = 0, off = 0, lv = 0;
  for (const d of days) {
    const k = K(emp.id, d), x = r.E.get(k);
    if (x && x.kind === 'shift') work++;
    else if (x) off++;
    else if (fullLeave(k)) lv++;
    else if (isClosedDay(d)) off++;
  }
  return { work, off, lv };
}
function renderSchedule() {
  const r = SCH.data, { from, to } = schRange(), month = SCH.view === 'month';
  $('schTitle').textContent = month ? `${Number(from.slice(0, 4))} 年 ${Number(from.slice(5, 7))} 月` : `${md(from)} ～ ${md(to)}`;
  $('schSub').textContent = month ? '' : `${from.slice(0, 4)} 年・週一至週日`;
  document.querySelectorAll('[data-sview]').forEach((b) => { const on = b.dataset.sview === SCH.view; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  $('schCopy').classList.toggle('hidden', month); $('schReset').classList.toggle('hidden', month);
  $('schLegend').innerHTML = `<span class="lg"><span class="mk mk-dirty"></span>未發布</span><span class="lg"><span class="mk mk-pub">${icon('check', 9)}</span>已發布</span><span class="lg"><span class="mk-c warn" style="position:static">!</span>勞基法提醒</span><span class="lg"><span class="mk-c no" style="position:static;transform:none">不可</span>不可排班</span>`;
  const emps = schEmps();
  const hid = r.hidden_employees || [];
  $('schHidden').innerHTML = hid.length ? `<p class="sch-hidden">不排班（不顯示）：${hid.map((e) => esc(e.name)).join('、')}・<button type="button" data-gostaff>到「人員」調整</button></p>` : '';
  $('schHidden').querySelectorAll('[data-gostaff]').forEach((b) => b.onclick = () => setStab('staff'));
  if (!emps.length) { $('schCal').innerHTML = `<div class="card"><div class="empty"><span class="empty-ic">${icon('users', 24)}</span><b>沒有排班中的員工</b>${ROLE === 'manager' ? '您的團隊目前沒有排班中的員工' : '請先到「員工管理」新增員工，或在「人員」開啟排班'}</div></div>`; renderFoot([]); return; }
  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const today = taipeiToday(), min = r.min_staff;
  const head = days.map((d) => {
    const h = r.H.get(d), closed = isClosedDay(d);
    const n = emps.filter((e) => { const x = r.E.get(K(e.id, d)); return x && x.kind === 'shift'; }).length;
    const low = !closed && min && n < min;
    const hc = closed ? '<span class="hc closed">公休</span>' : `<span class="hc ${low ? 'low' : ''}" title="${low ? `少於每日最少 ${min} 人` : '當天上班人數'}">${n}人</span>`;
    return `<div class="sg-head ${isWkend(d) ? 'is-wk' : ''} ${d === today ? 'is-today' : ''} ${closed ? 'is-closed' : ''}" role="columnheader" aria-label="${mdw(d)}，${closed ? '公休' : `${n} 人上班${low ? '，人數不足' : ''}`}${h && !closed ? `，${esc(h.name)}` : ''}"><span class="dw">${month ? WD_SUN[wdOfD(d)] : `週${WD_SUN[wdOfD(d)]}`}</span><b>${month ? '' : `<span class="mo">${Number(d.slice(5, 7))}/</span>`}${Number(d.slice(8))}</b>${h && !closed ? `<span class="hn">${esc(h.off ? h.name : '補班')}</span>` : ''}${hc}</div>`;
  }).join('');
  const rows = emps.map((e) => {
    const c = empCount(e, days);
    const tgt = month && e.staff === 'full' && e.monthly_off != null ? e.monthly_off : null;
    const bad = tgt != null && c.off !== tgt;
    const cnt = `<span class="cnt ${bad ? 'bad' : ''}" ${bad ? `title="每月休假目標 ${tgt} 天，目前排 ${c.off} 天（${c.off > tgt ? '太多' : '太少'}）"` : ''}>上${c.work}・休${c.off}${tgt != null ? `/${tgt}` : ''}${c.lv ? `・假${c.lv}` : ''}</span>`;
    return `<div class="sg-emp" role="rowheader">${avatar(e.name, 'sm')}<span class="en"><b>${esc(e.name)}</b><span class="sub"><span class="st-tag ${e.staff}">${esc(e.staff_text)}</span>${cnt}</span></span></div>${days.map((d) => cellHtml(e, d)).join('')}`;
  }).join('');
  const sc = $('schCal').querySelector('.sch-scroll'), keepX = sc ? sc.scrollLeft : 0;
  $('schCal').innerHTML = `<div class="sch-scroll"><div class="sg ${month ? 'month' : 'week'}" role="grid" aria-label="${month ? '月班表' : '週班表'}" style="--nd:${days.length}${month ? ';--cw:46px' : ''}">
    <div class="sg-head sg-corner">員工<span class="muted">${month ? '本月' : '本週'}</span></div>${head}${rows}</div></div>`;
  $('schCal').querySelector('.sch-scroll').scrollLeft = keepX;
  $('schCal').querySelectorAll('[data-ce]').forEach((b) => b.onclick = () => openPick(b));
  renderFoot(emps, days);
}
// 底部：一行提醒摘要＋一顆大的發布按鈕
function renderFoot(emps, days = []) {
  const r = SCH.data, ids = new Set(emps.map((e) => e.id)), dset = new Set(days);
  const warns = r.warnings.filter((w) => ids.has(w.employee_id) && dset.has(w.date));
  const nameOf = (id) => (r.employees.find((e) => e.id === id) || {}).name || '';
  const weeks = r.weeks.filter((w) => days.some((d) => d >= w.week_start && d <= w.week_end));
  // 未發布的格子（所有可管理的員工）
  const dirtyIn = (w) => { let n = 0; const keys = new Set([...r.E.keys(), ...r.P.keys()]); for (const k of keys) { const d = k.split('|')[1]; if (d >= w.week_start && d <= w.week_end && !sameEntry(r.E.get(k), r.P.get(k))) n++; } return n; };
  const todo = weeks.map((w) => ({ w, n: dirtyIn(w) })).filter((x) => x.n);
  const total = todo.reduce((a, x) => a + x.n, 0), anyPub = weeks.some((w) => w.published_count);
  const month = SCH.view === 'month';
  let btn;
  if (total) btn = `<button class="btn big" id="schPubBtn">${icon('send', 18)}${month ? `發布本月（${todo.length} 週・${total} 格未發布）` : `發布本週（${total} 格未發布）`}</button>`;
  else if (anyPub) btn = `<button class="btn big done" id="schPubBtn" aria-disabled="true">${icon('check', 18)}${month ? '本月班表都已發布' : '本週已發布'}</button>`;
  else btn = `<button class="btn big done" id="schPubBtn" aria-disabled="true">${icon('send', 18)}排好班後就可以發布</button>`;
  $('schFoot').innerHTML = `${warns.length ? `<button type="button" class="sch-warnline" id="schWarnBtn">${icon('scale', 16)}<b>提醒 ${warns.length}</b><span>${esc(nameOf(warns[0].employee_id))} ${md(warns[0].date)} ${esc(warns[0].text)}</span>${icon('chevronRight', 16)}</button>` : ''}
    <div class="sch-pubrow">${btn}${!month && anyPub ? '<button class="btn ghost sm" id="schUnpub">取消發布</button>' : ''}</div>`;
  if ($('schWarnBtn')) $('schWarnBtn').onclick = () => modal(`<form class="form-grid"><ul class="w-ul" style="padding-left:18px;margin:0">${warns.map((w) => `<li><b>${esc(nameOf(w.employee_id))}・${mdw(w.date)}</b><br>${esc(w.text)}</li>`).join('')}</ul><p class="help" style="margin:0">提醒不會擋存檔或發布，請確認是否需要調整。</p><div class="actions"><button type="button" class="hidden" data-cancel></button><button class="btn" type="submit">知道了</button></div></form>`, async () => {}, { title: `勞基法提醒 ${warns.length} 項`, icon: 'scale' });
  if (total) $('schPubBtn').onclick = () => publishWeeks(todo, warns.length);
  if ($('schUnpub')) $('schUnpub').onclick = () => modal(`<form class="form-grid"><p style="margin:0">取消發布後，員工看不到 ${md(SCH.anchor)}～${md(addDays(SCH.anchor, 6))} 的班表，打卡紀錄改回依上班時間設定判斷遲到。</p>${actions('取消發布', true)}</form>`,
    async () => { await api('/api/admin/schedule/publish', { method: 'POST', body: { week_start: SCH.anchor, unpublish: true } }); toast('已取消發布', 'ok'); loadSchedule(); }, { title: '取消發布', icon: 'undo', danger: true });
}
function publishWeeks(todo, nw) {
  const range = todo.length === 1 ? `${md(todo[0].w.week_start)}～${md(todo[0].w.week_end)}` : `${todo.length} 週`;
  modal(`<form class="form-grid"><p style="margin:0">發布 ${range} 的班表給${ROLE === 'manager' ? '您團隊的' : ''}員工。員工會在打卡頁「班表」看到，打卡紀錄也會依此判斷遲到與早退。</p>
    ${nw ? `<div class="alert warn">${icon('scale', 18)}<div>還有 <b>${nw}</b> 項勞基法提醒，仍可發布。</div></div>` : ''}${actions('發布')}</form>`,
  async () => { for (const { w } of todo) await api('/api/admin/schedule/publish', { method: 'POST', body: { week_start: w.week_start } }); toast('已發布，員工可以看到班表', 'ok'); loadSchedule(); },
  { title: '發布班表', icon: 'send' });
}

// ---------- 點格子：班別選單（立即存檔） ----------
let pickAt = null;
function closePick() {
  const p = $('schPick'), bg = $('schPickBg'); if (p) p.remove(); if (bg) bg.remove();
  document.querySelectorAll('.sg-cell.is-picked').forEach((c) => c.classList.remove('is-picked'));
  if (pickAt) { const c = document.querySelector(`[data-ce="${pickAt.emp}"][data-cd="${pickAt.d}"]`); pickAt = null; if (c) c.focus({ preventScroll: true }); }
}
function openPick(cell) {
  closePick();
  const r = SCH.data, emp = r.employees.find((e) => e.id == cell.dataset.ce), d = cell.dataset.cd; if (!emp) return;
  const c = cellState(emp, d);
  pickAt = { emp: emp.id, d }; cell.classList.add('is-picked');
  const tpls = r.templates.filter((t) => fitsStaff(t, emp));
  const cur = c.x ? (c.x.kind === 'shift' ? `t${c.x.template_id}` : 'rest') : '';
  const notes = [
    c.closed ? `${icon('flag', 13)}公休（${esc(c.h.name)}）` : c.h && c.h.off ? `${icon('flag', 13)}${esc(c.h.name)}：出勤需經同意，工資加倍` : '',
    c.leave ? `${icon('palm', 13)}已核准${esc(c.leave.type_name)}${c.leave.full ? '' : '（部分時段）'}` : '',
    c.o ? `${icon('ban', 13)}${esc(c.o.text)}` : '',
    ...c.w.map((w) => `${icon('alert', 13)}${esc(w.text)}`),
  ].filter(Boolean);
  const canToggleOff = d > taipeiToday() && (!c.o || c.o.kind === 'date');
  const bg = document.createElement('div'); bg.className = 'pick-bg'; bg.id = 'schPickBg'; bg.onclick = closePick;
  const p = document.createElement('div'); p.className = 'sch-pick'; p.id = 'schPick'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', `${emp.name} ${mdw(d)} 選擇班別`);
  p.innerHTML = `<div class="pk-head">${avatar(emp.name, 'sm')}<b>${esc(emp.name)}</b><span class="st-tag ${emp.staff}">${esc(emp.staff_text)}</span><span class="muted">${mdw(d)}</span><button type="button" class="btn ghost sm icon-only x" data-pkx aria-label="關閉">${icon('x', 18)}</button></div>
    ${notes.length ? `<div class="pk-notes">${notes.map((n) => `<span>${n}</span>`).join('')}</div>` : ''}
    <div class="pk-chips">${tpls.map((t) => `<button type="button" class="pk" data-pk="t${t.id}" aria-pressed="${cur === `t${t.id}`}" aria-label="${esc(t.name)} ${t.start} 到 ${t.end}">${chip({ ...t, kind: 'shift' })}</button>`).join('')}
      <button type="button" class="pk" data-pk="rest" aria-pressed="${cur === 'rest'}" aria-label="休">${chip({ kind: 'rest' })}</button>
      <button type="button" class="pk" data-pk="clear" aria-label="清除"><span class="sc sc-none"><b>清除</b></span></button></div>
    <div class="pk-foot"><span>${tpls.length < r.templates.length ? `只顯示${esc(emp.staff_text)}可排的班別` : '點一下就存好'}</span>${canToggleOff ? `<button type="button" class="btn ghost sm" data-pkoff>${icon('ban', 14)}${c.o ? '取消不可排班' : '代填不可排班'}</button>` : ''}</div>`;
  document.body.append(bg, p);
  if (!schMobile.matches) {
    const rc = cell.getBoundingClientRect(), pw = p.offsetWidth, ph = p.offsetHeight;
    let left = Math.min(Math.max(8, rc.left + rc.width / 2 - pw / 2), innerWidth - pw - 8);
    let top = rc.bottom + 6; if (top + ph > innerHeight - 8) top = Math.max(8, rc.top - ph - 6);
    Object.assign(p.style, { left: `${left}px`, top: `${top}px` });
  }
  p.querySelector('[data-pkx]').onclick = closePick;
  p.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePick(); } });
  (p.querySelector('[aria-pressed="true"]') || p.querySelector('[data-pk]')).focus({ preventScroll: true });
  p.querySelectorAll('[data-pk]').forEach((b) => b.onclick = async () => {
    const v = b.dataset.pk, item = { employee_id: emp.id, date: d };
    if (v.startsWith('t')) Object.assign(item, { kind: 'shift', template_id: Number(v.slice(1)) }); else item.kind = v;
    p.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    try {
      const res = await api('/api/admin/schedule/entries', { method: 'PUT', body: { items: [item] } });
      const t = v.startsWith('t') ? r.templates.find((y) => `t${y.id}` === v) : null;
      const what = t ? `已排${t.name}` : v === 'rest' ? '已排休' : '已清除';
      const mine = res.warnings.filter((w) => w.employee_id === emp.id && w.date === d && item.kind === 'shift');
      closePick();
      toast(mine.length ? `${what}・提醒：${mine[0].text}${mine.length > 1 ? `（另 ${mine.length - 1} 項）` : ''}` : `${emp.name} ${md(d)} ${what}`, mine.length ? '' : 'ok');
      await loadSchedule();
    } catch (e) { handle(e); p.querySelectorAll('button').forEach((x) => { x.disabled = false; }); }
  });
  const off = p.querySelector('[data-pkoff]');
  if (off) off.onclick = async () => {
    try { await api(`/api/admin/employees/${emp.id}/dayoff/${d}`, { method: 'PUT', body: { off: !c.o } }); closePick(); toast(c.o ? '已取消不可排班' : `已代填 ${emp.name} ${md(d)} 不可排班`, 'ok'); loadSchedule(); } catch (e) { handle(e); }
  };
}
addEventListener('resize', () => { if ($('schPick') && !schMobile.matches) closePick(); });

// ---------- 工具列 ----------
$('schPrev').onclick = () => { closePick(); SCH.anchor = SCH.view === 'week' ? addDays(SCH.anchor, -7) : `${shiftMonth(SCH.anchor.slice(0, 7), -1)}-01`; loadSchedule(); };
$('schNext').onclick = () => { closePick(); SCH.anchor = SCH.view === 'week' ? addDays(SCH.anchor, 7) : `${shiftMonth(SCH.anchor.slice(0, 7), 1)}-01`; loadSchedule(); };
$('schToday').onclick = () => { const t = taipeiToday(); SCH.anchor = SCH.view === 'week' ? mondayOf(t) : t.slice(0, 8) + '01'; loadSchedule(); };
document.querySelectorAll('[data-sview]').forEach((b) => b.onclick = () => {
  if (b.dataset.sview === SCH.view) return;
  SCH.view = b.dataset.sview;
  const t = taipeiToday();
  SCH.anchor = SCH.view === 'month' ? addDays(SCH.anchor, 3).slice(0, 8) + '01' : (SCH.anchor.slice(0, 7) === t.slice(0, 7) ? mondayOf(t) : mondayOf(SCH.anchor));
  loadSchedule();
});
$('schDept').onchange = () => { SCH.dept = $('schDept').value; renderSchedule(); };
schMobile.addEventListener('change', () => { closePick(); if (SCH.data && SCH.tab === 'cal') renderSchedule(); });

$('schCopy').onclick = () => {
  const src = addDays(SCH.anchor, -7), emps = schEmps(), r = SCH.data;
  const have = emps.reduce((a, e) => a + Array.from({ length: 7 }, (_, i) => r.E.has(K(e.id, addDays(SCH.anchor, i)))).filter(Boolean).length, 0);
  const go = (overwrite) => copyWeek(src, overwrite);
  if (!have) return go(false).catch(handle);
  modal(`<form class="form-grid"><p style="margin:0">本週已經排了 <b>${have}</b> 格。要用上週（${md(src)}～${md(addDays(src, 6))}）的班表覆蓋嗎？公休日會略過。</p>
    <div class="actions"><button type="button" class="btn secondary" data-cancel>取消</button><button type="button" class="btn secondary" id="cpFill">只補空白</button><button class="btn danger" type="submit">覆蓋</button></div></form>`,
  async () => go(true), { title: '複製上週', icon: 'repeat' });
  $('cpFill').onclick = async () => { closeModal(); try { await go(false); } catch (e) { handle(e); } };
};
async function copyWeek(source_week, overwrite) {
  const employee_ids = SCH.dept ? schEmps().map((e) => e.id) : undefined;
  const r = await api('/api/admin/schedule/copy', { method: 'POST', body: { source_week, target_weeks: [SCH.anchor], overwrite, employee_ids } });
  toast(r.copied ? `已複製上週 ${r.copied} 格${r.skipped ? `，保留已排的 ${r.skipped} 格` : ''}${r.closed ? `，略過公休 ${r.closed} 格` : ''}` : '上週沒有可複製的班', r.copied ? 'ok' : '');
  loadSchedule();
}
$('schReset').onclick = () => {
  const w = SCH.data.weeks.find((x) => x.week_start === SCH.anchor) || {};
  modal(`<form class="form-grid"><p style="margin:0">${w.published_count ? '把本週還沒發布的變更全部還原，回到上次發布的班表。' : '本週還沒發布過，重設會清空本週所有排好的班。'}${ROLE === 'manager' ? '（只影響您的團隊）' : ''}</p>${actions('重設', true)}</form>`,
  async () => { await api('/api/admin/schedule/reset', { method: 'POST', body: { week_start: SCH.anchor } }); toast('已重設本週', 'ok'); loadSchedule(); },
  { title: '重設本週', icon: 'undo', danger: true });
};

// ---------- 人員：排班中、固定休假日、每月休假天數、代填不可排班 ----------
async function loadStaff() {
  try {
    const list = await api('/api/admin/employees');
    $('stfList').innerHTML = list.map((e) => `<div class="card stf ${e.scheduling ? '' : 'is-hidden'}" data-sid="${e.id}">
      <div class="stf-top">${avatar(e.name, 'sm')}<span class="en"><b>${esc(e.name)}</b><span class="sub"><span class="st-tag ${e.staff}">${e.staff === 'part' ? '工讀' : '正職'}</span>${esc(e.department || '')}</span></span>
        <label class="sw-sched"><input type="checkbox" class="switch" data-sched ${e.scheduling ? 'checked' : ''} aria-label="${esc(e.name)} 排班中"><span>${e.scheduling ? '排班中' : '不排班'}</span></label></div>
      <div class="stf-row"><span class="lbl">固定休假日</span><div class="wd7" role="group" aria-label="${esc(e.name)} 固定休假日">${WD_SUN.map((w, i) => `<button type="button" data-wd="${i}" aria-pressed="${e.fixed_off.includes(i)}" aria-label="週${w}">${w}</button>`).join('')}</div></div>
      <div class="stf-row">${e.staff === 'full' ? `<label class="mo-in">每月休假<input type="number" inputmode="numeric" min="0" max="31" data-mo value="${e.monthly_off ?? ''}" placeholder="—" aria-label="${esc(e.name)} 每月休假天數">天</label>` : '<span class="help">工讀：不限休假天數</span>'}
        <button type="button" class="btn ghost sm" data-dates style="margin-left:auto">${icon('calendarX', 15)}不可排班日</button></div>
    </div>`).join('') || `<div class="card"><div class="empty"><span class="empty-ic">${icon('users', 24)}</span><b>沒有員工</b></div></div>`;
    $('stfList').querySelectorAll('[data-sid]').forEach((card) => {
      const e = list.find((x) => x.id == card.dataset.sid);
      const save = async (body, msg) => { try { const r = await api(`/api/admin/employees/${e.id}/schedule-prefs`, { method: 'PUT', body }); Object.assign(e, r); toast(msg, 'ok'); return r; } catch (err) { handle(err); return null; } };
      card.querySelector('[data-sched]').onchange = async (ev) => {
        const on = ev.target.checked, r = await save({ scheduling: on }, on ? `${e.name} 排班中` : `${e.name} 不排班（不會出現在班表）`);
        if (!r) { ev.target.checked = !on; return; }
        card.classList.toggle('is-hidden', !on); ev.target.nextElementSibling.textContent = on ? '排班中' : '不排班';
      };
      card.querySelectorAll('[data-wd]').forEach((b) => b.onclick = async () => {
        const i = Number(b.dataset.wd), set = new Set(e.fixed_off); set.has(i) ? set.delete(i) : set.add(i);
        const r = await save({ fixed_off: [...set] }, `${e.name} 固定休假日：${[...set].sort().map((x) => `週${WD_SUN[x]}`).join('、') || '無'}`);
        if (r) card.querySelectorAll('[data-wd]').forEach((x) => x.setAttribute('aria-pressed', r.fixed_off.includes(Number(x.dataset.wd))));
      });
      const mo = card.querySelector('[data-mo]');
      if (mo) mo.onchange = async () => { const r = await save({ monthly_off: mo.value === '' ? null : Number(mo.value) }, mo.value === '' ? `${e.name} 不檢查每月休假` : `${e.name} 每月休假 ${mo.value} 天`); if (!r) mo.value = e.monthly_off ?? ''; };
      card.querySelector('[data-dates]').onclick = () => dayoffModal(e);
    });
  } catch (e) { handle(e); }
}
// 代填不可排班日（月曆，點一下就存）
function dayoffModal(emp) {
  let m = taipeiToday().slice(0, 7);
  modal(`<form class="form-grid"><div id="doBox"></div><p class="help" style="margin:0">點未來的日子切換「不可排班」，立即存檔；淺色為每週固定休假日。</p><div class="actions"><button type="button" class="hidden" data-cancel></button><button class="btn" type="submit">完成</button></div></form>`,
    async () => { if (SCH.tab === 'cal') loadSchedule(); }, { title: `${emp.name}・不可排班日`, icon: 'calendarX' });
  const draw = async () => {
    try {
      const from = `${m}-01`, to = monthEnd(m);
      const r = await api(`/api/admin/schedule?from=${from}&to=${to}&employee_id=${emp.id}`);
      const dates = new Set((r.dayoff || []).filter((o) => o.kind === 'date').map((o) => o.date));
      $('doBox').innerHTML = dayoffCal(m, dates, emp.fixed_off, taipeiToday());
      $('doBox').querySelector('[data-mprev]').onclick = () => { m = shiftMonth(m, -1); draw(); };
      $('doBox').querySelector('[data-mnext]').onclick = () => { m = shiftMonth(m, 1); draw(); };
      $('doBox').querySelectorAll('[data-dd]').forEach((b) => b.onclick = async () => {
        const d = b.dataset.dd, on = !dates.has(d);
        try { await api(`/api/admin/employees/${emp.id}/dayoff/${d}`, { method: 'PUT', body: { off: on } }); toast(`${md(d)} ${on ? '不可排班' : '已取消'}`, 'ok'); draw(); } catch (e) { handle(e); }
      });
    } catch (e) { handle(e); }
  };
  draw();
}
// 共用月曆（管理員代填用；員工端有自己的版本）
function dayoffCal(m, dates, fixed, today) {
  const first = `${m}-01`, last = monthEnd(m), pad = wdOfD(first), cells = [];
  for (let i = 0; i < pad; i++) cells.push('<span></span>');
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const fx = fixed.includes(wdOfD(d)), on = dates.has(d), past = d <= today;
    cells.push(`<button type="button" class="do-day ${on ? 'on' : fx ? 'fixed' : ''} ${d === today ? 'today' : ''}" ${past ? 'disabled' : `data-dd="${d}"`} aria-pressed="${on}" aria-label="${mdw(d)}${on ? '，不可排班' : fx ? '，固定休假日' : ''}">${Number(d.slice(8))}${on ? '<small>不可</small>' : fx ? '<small>固定</small>' : ''}</button>`);
  }
  return `<div class="do-cal"><div class="do-nav"><button type="button" class="btn secondary sm icon-only" data-mprev aria-label="上個月">${icon('chevronLeft', 18)}</button><b>${Number(m.slice(0, 4))} 年 ${Number(m.slice(5))} 月</b><button type="button" class="btn secondary sm icon-only" data-mnext aria-label="下個月">${icon('chevronRight', 18)}</button></div>
    <div class="do-grid">${WD_SUN.map((w) => `<span class="wh">${w}</span>`).join('')}${cells.join('')}</div>
    <div class="do-legend"><span><i class="l-on"></i>不可排班</span><span><i class="l-fx"></i>固定休假日</span></div></div>`;
}

// ---------- 班別 ----------
const COLOR_NAME = { primary: '奶茶', 'primary-deep': '深奶茶', 'primary-soft': '淺奶茶', sand: '沙色', accent: '玫瑰', 'accent-soft': '淺玫瑰', text: '可可', 'text-soft': '淺灰' };
const APPLIES_TEXT = { full: '正職班', part: '工讀班', all: '都可以' };
let tplCache = null;
async function loadTemplates() {
  try {
    const r = await api('/api/admin/shift-templates'); tplCache = r;
    const owner = ROLE === 'owner';
    $('minStaff').innerHTML = `<label for="msIn"><b>每日最少上班人數</b></label>${owner ? `<input type="number" id="msIn" inputmode="numeric" min="1" max="99" value="${r.min_staff ?? ''}" placeholder="—"> 人` : `<b>${r.min_staff ? `${r.min_staff} 人` : '不檢查'}</b>`}
      <p class="help">班表每天上方會顯示上班人數，少於這個數字時以重點色提醒；空白＝不檢查。公休日不檢查。</p>`;
    if (owner) $('msIn').onchange = async () => { try { const x = await api('/api/admin/schedule/settings', { method: 'PUT', body: { min_staff: $('msIn').value === '' ? null : Number($('msIn').value) } }); toast(x.min_staff ? `每日最少 ${x.min_staff} 人` : '不檢查每日人數', 'ok'); } catch (e) { handle(e); } };
    $('tplList').innerHTML = r.templates.map((t) => `<div class="card tpl-row ${t.active ? '' : 'is-off'}">
      ${chip({ ...t, kind: 'shift' }, { short: true })}
      <div class="tpl-main"><b>${t.start} – ${t.overnight ? '翌日 ' : ''}${t.end}</b><span class="muted"><span class="st-tag ${t.applies === 'part' ? 'part' : ''}">${esc(t.applies_text)}</span> ${t.hours} 小時${t.overnight ? '・跨夜' : ''}${t.active ? '' : '・已停用'}</span></div>
      <button class="btn secondary sm owner-only" data-tedit="${t.id}">${icon('pencil', 15)}修改</button></div>`).join('')
      || `<div class="card"><div class="empty"><span class="empty-ic">${icon('clock', 24)}</span><b>還沒有班別</b>按「新增班別」建立早班、晚班等常用時段</div></div>`;
    $('tplList').querySelectorAll('[data-tedit]').forEach((b) => b.onclick = () => tplModal(r.templates.find((t) => t.id == b.dataset.tedit)));
  } catch (e) { handle(e); }
}
function tplModal(t) {
  const colors = (tplCache && tplCache.colors) || Object.keys(COLOR_NAME), c0 = t ? t.color : 'primary', a0 = t ? t.applies : 'all';
  modal(`<form class="form-grid">
    <div><label for="tpN">班別名稱</label><input type="text" id="tpN" name="name" maxlength="10" required value="${esc(t ? t.name : '')}" placeholder="例如：早班、晚班"></div>
    <div class="row2">
      <div><label for="tpS">上班</label><input type="time" id="tpS" name="start" required value="${t ? t.start : '09:00'}"></div>
      <div><label for="tpE">下班</label><input type="time" id="tpE" name="end" required value="${t ? t.end : '18:00'}"></div>
    </div>
    <p class="help" id="tpHint" style="margin:0"></p>
    <fieldset class="seg3"><legend>適用</legend>${['full', 'part', 'all'].map((v) => `<label><input type="radio" name="applies" value="${v}" ${v === a0 ? 'checked' : ''}><span>${APPLIES_TEXT[v]}</span></label>`).join('')}</fieldset>
    <fieldset class="swatches"><legend>顏色</legend>${colors.map((c) => `<label class="sw"><input type="radio" name="color" value="${c}" ${c === c0 ? 'checked' : ''}><span class="sc sc-${c}"><b>${COLOR_NAME[c] || c}</b></span></label>`).join('')}</fieldset>
    ${t ? `<label class="switch-row"><input type="checkbox" class="switch" name="active" ${t.active ? 'checked' : ''}><span class="d">啟用（停用後排班時不會出現，已排的班不受影響）</span></label>` : ''}
    ${actions(t ? '儲存' : '新增')}</form>`,
  async (f) => {
    const body = { name: f.name.value, start: f.start.value, end: f.end.value, color: f.color.value, applies: f.applies.value, break_min: t ? t.break_min : 0 };
    if (t) body.active = f.active.checked;
    await api('/api/admin/shift-templates' + (t ? `/${t.id}` : ''), { method: t ? 'PUT' : 'POST', body });
    toast(t ? '班別已更新' : '已新增班別', 'ok'); loadTemplates();
  }, { title: t ? '修改班別' : '新增班別', icon: 'clock' });
  const f = $('modal').querySelector('form');
  const hint = () => {
    const [sh, sm] = f.start.value.split(':').map(Number), [eh, em] = f.end.value.split(':').map(Number);
    if (Number.isNaN(sh) || Number.isNaN(eh)) return;
    let m = eh * 60 + em - (sh * 60 + sm); const night = m <= 0; if (night) m += 1440;
    const h = +((m - (t ? t.break_min : 0)) / 60).toFixed(2);
    $('tpHint').innerHTML = `${icon('info', 14)} ${h} 小時${night ? '・跨夜班（隔天下班）' : ''}${h > 12 ? '・超過 12 小時' : ''}`;
  };
  ['start', 'end'].forEach((n) => f[n].addEventListener('input', hint)); hint();
}
$('tplAdd').onclick = () => tplModal(null);

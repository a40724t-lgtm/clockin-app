// =========================================================
// 排班（管理員：全部員工；主管：自己的團隊）＋ 假日設定（管理員）
// =========================================================
const SCH = { view: 'week', anchor: null, day: null, dept: '', data: null, tab: 'cal' };
const schMobile = matchMedia('(max-width: 760px)');
const WD_ORDER = ['一', '二', '三', '四', '五', '六', '日'];
const mondayOf = (d) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return addDays(d, -((w + 6) % 7)); };
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const monthEnd = (m) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10); };
const isWkend = (d) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6; };
const K = (e, d) => `${e}|${d}`;

function schRange() {
  if (SCH.view === 'week') return { from: SCH.anchor, to: addDays(SCH.anchor, 6) };
  const first = SCH.anchor.slice(0, 8) + '01', last = monthEnd(SCH.anchor.slice(0, 7));
  return { from: mondayOf(first), to: addDays(mondayOf(last), 6), first, last };
}
function setStab(t) {
  if (t === 'hol' && ROLE !== 'owner') t = 'cal';
  SCH.tab = t;
  document.querySelectorAll('[data-stab]').forEach((b) => { const on = b.dataset.stab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  document.querySelectorAll('[data-spane]').forEach((p) => p.classList.toggle('hidden', p.dataset.spane !== t));
  if (t === 'cal') loadSchedule();
  if (t === 'tpl') loadTemplates();
  if (t === 'hol') loadHolidays();
}
document.querySelectorAll('[data-stab]').forEach((b) => b.onclick = () => setStab(b.dataset.stab));
function loadSchedulePage(tab) {
  if (!SCH.anchor) { SCH.day = taipeiToday(); SCH.anchor = mondayOf(SCH.day); }
  $('schHead').textContent = ROLE === 'manager' ? '安排您團隊的班表；發布後員工才看得到，打卡紀錄會依班表判斷遲到與早退' : '安排每週班表，發布後員工才看得到；打卡紀錄會依班表判斷遲到與早退';
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
    r.T = new Map(r.templates.map((t) => [t.id, t]));
    const depts = [...new Set(r.employees.map((e) => e.department).filter(Boolean))];
    $('schDept').innerHTML = `<option value="">${ROLE === 'manager' ? '我的團隊' : '全部部門'}（${r.employees.length} 人）</option>` + depts.map((d) => `<option ${d === SCH.dept ? 'selected' : ''}>${esc(d)}</option>`).join('');
    $('schDept').classList.toggle('hidden', depts.length < 2);
    if (!depts.includes(SCH.dept)) SCH.dept = '';
    renderSchedule();
  } catch (e) { handle(e); }
}
const schEmps = () => SCH.data.employees.filter((e) => !SCH.dept || e.department === SCH.dept);
const sameEntry = (a, b) => (!a && !b) || (a && b && ['kind', 'start', 'end', 'break_min', 'name', 'note'].every((k) => a[k] === b[k]));

function chip(x, opts = {}) {
  if (!x) return opts.empty ? `<span class="sc-empty">${icon('plus', 14)}</span>` : '';
  if (x.kind === 'rest') return '<span class="sc sc-off"><b>休息日</b></span>';
  if (x.kind === 'regular') return '<span class="sc sc-reg"><b>例假</b></span>';
  return `<span class="sc sc-${esc(x.color || 'primary')}"><b>${esc(x.name)}</b>${opts.short ? '' : `<span>${x.start}–${x.overnight ? '翌' : ''}${x.end}</span>`}</span>`;
}
function cellInner(emp, d, opts = {}) {
  const r = SCH.data, k = K(emp.id, d), x = r.E.get(k), lv = r.L.get(k) || [], w = r.W.get(k) || [];
  const changed = !sameEntry(x, r.P.get(k)) && r.weeks.find((wk) => d >= wk.week_start && d <= wk.week_end)?.published_count;
  return `${chip(x, { empty: true, short: opts.short })}
    ${lv.map((l) => `<span class="sc-tag ${l.kind !== 'leave' ? 'is-work' : ''}">${icon(l.kind === 'wfh' ? 'home' : l.kind === 'trip' ? 'briefcase' : 'palm', 12)}${esc(l.type_name)}${l.full ? '' : '（部分）'}</span>`).join('')}
    ${w.length ? `<span class="sc-warn" title="${esc(w.map((y) => y.text).join('\n'))}">${icon('alert', 12)}${w.length > 1 ? w.length : ''}<span class="sr-only">勞基法提醒：${esc(w.map((y) => y.text).join('；'))}</span></span>` : ''}
    ${changed ? '<span class="sc-dirty" role="img" aria-label="尚未發布的變更" title="尚未發布的變更"></span>' : ''}`;
}
const holChip = (h, cls = '') => (h ? `<span class="sch-hol ${h.off ? '' : 'is-work'} ${cls}" title="${esc(h.kind_text)}">${icon(h.off ? 'flag' : 'repeat', 12)}${esc(h.off ? h.name : h.kind === 'bridge' ? `${h.name}（照常上班）` : '調移上班')}</span>` : '');

function renderSchedule() {
  const r = SCH.data, { from, to, first, last } = schRange();
  const month = SCH.view === 'month';
  $('schTitle').textContent = month ? `${Number(SCH.anchor.slice(0, 4))} 年 ${Number(SCH.anchor.slice(5, 7))} 月` : `${md(from)} ～ ${md(to)}`;
  $('schSub').textContent = month ? '' : `${from.slice(0, 4)} 年・週一至週日`;
  document.querySelectorAll('[data-sview]').forEach((b) => { const on = b.dataset.sview === SCH.view; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  ['schCopy', 'schRepeat'].forEach((id) => $(id).classList.toggle('hidden', month));
  // 發布狀態
  const hasAny = (w) => w.published_count || r.entries.some((x) => x.date >= w.week_start && x.date <= w.week_end);
  const weeks = month ? r.weeks.filter((w) => w.week_end >= first && w.week_start <= last && hasAny(w)) : r.weeks;
  $('schPub').innerHTML = weeks.map((w) => {
    const st = w.status === 'published' ? `<span class="badge b-brand">${icon('check')}已發布</span>` : w.status === 'changed' ? `<span class="badge b-warning">${icon('alert')}已發布・有 ${w.changed} 項未發布變更</span>` : `<span class="badge b-neutral">${icon('pencil')}草稿・員工看不到</span>`;
    return `<div class="pub-row ${w.status}"><div class="pub-txt">${month ? `<b>${md(w.week_start)}～${md(w.week_end)}</b>` : ''}${st}${w.published_text ? `<span class="muted">${esc(w.published_text)}</span>` : ''}</div>
      <div class="pub-act">${w.published_count ? `<button class="btn ghost sm" data-unpub="${w.week_start}">取消發布</button>` : ''}${w.status !== 'published' ? `<button class="btn sm" data-pub="${w.week_start}">${icon('send', 15)}${w.published_count ? '重新發布' : '發布本週'}</button>` : ''}</div></div>`;
  }).join('');
  $('schPub').querySelectorAll('[data-pub]').forEach((b) => b.onclick = () => publishWeek(b.dataset.pub, false));
  $('schPub').querySelectorAll('[data-unpub]').forEach((b) => b.onclick = () => publishWeek(b.dataset.unpub, true));
  // 提醒
  const emps = schEmps(), ids = new Set(emps.map((e) => e.id));
  const warns = r.warnings.filter((w) => ids.has(w.employee_id) && (!month || (w.date >= first && w.date <= last)));
  const nameOf = (id) => (r.employees.find((e) => e.id === id) || {}).name || '';
  $('schWarn').innerHTML = warns.length ? `<details class="card sch-warns" ${warns.length <= (schMobile.matches ? 2 : 8) ? 'open' : ''}><summary>${icon('scale', 18)}<b>勞基法提醒 ${warns.length} 項</b><span class="muted">不會擋存檔，請確認是否需要調整</span></summary>
    <ul>${warns.map((w, i) => `<li><button type="button" data-wi="${i}"><span class="w-when">${esc(nameOf(w.employee_id))}・${mdw(w.date)}</span><span class="w-text">${esc(w.text)}</span></button></li>`).join('')}</ul></details>` : '';
  $('schWarn').querySelectorAll('[data-wi]').forEach((b) => b.onclick = () => { const w = warns[b.dataset.wi]; cellEditor(r.employees.find((e) => e.id === w.employee_id), w.date); });
  // 圖例
  $('schLegend').innerHTML = r.templates.map((t) => `<span class="lg">${chip({ ...t, kind: 'shift' }, { short: true })}<span>${t.start}–${t.overnight ? '翌' : ''}${t.end}</span></span>`).join('')
    + `<span class="lg">${chip({ kind: 'rest' })}</span><span class="lg">${chip({ kind: 'regular' })}</span><span class="lg"><span class="sc-tag">${icon('palm', 12)}請假</span></span><span class="lg">${holChip({ off: true, name: '國定假日' })}</span><span class="lg"><span class="sc-dirty static"></span>未發布變更</span>`;
  if (!emps.length) { $('schCal').innerHTML = `<div class="card"><div class="empty"><span class="empty-ic">${icon('users', 24)}</span><b>沒有可排班的員工</b>${ROLE === 'manager' ? '您的團隊目前沒有在職員工' : '請先到「員工管理」新增員工'}</div></div>`; return; }
  if (month) renderMonth(emps, first, last, from, to);
  else if (schMobile.matches) renderWeekMobile(emps, from);
  else renderWeekGrid(emps, from);
}
function bindCells(root) {
  root.querySelectorAll('[data-ce]').forEach((b) => b.onclick = () => cellEditor(SCH.data.employees.find((e) => e.id == b.dataset.ce), b.dataset.cd));
  root.querySelectorAll('[data-hgo]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); holYear = Number(b.dataset.hgo.slice(0, 4)); setStab('hol'); });
}
function weekHours(emp, from) {
  let h = 0; for (let i = 0; i < 7; i++) { const x = SCH.data.E.get(K(emp.id, addDays(from, i))); if (x && x.kind === 'shift') h += x.hours; }
  return +h.toFixed(2);
}
function renderWeekGrid(emps, from) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i)), r = SCH.data, today = taipeiToday();
  $('schCal').innerHTML = `<div class="sch-grid card" role="grid" aria-label="週班表">
    <div class="sg-head sg-corner">員工<span class="muted">本週工時</span></div>
    ${days.map((d, i) => { const h = r.H.get(d); return `<div class="sg-head ${h && h.off ? 'is-hol' : ''} ${isWkend(d) ? 'is-wk' : ''} ${d === today ? 'is-today' : ''}"><span class="dw">週${WD_ORDER[i]}</span><b>${md(d)}</b>${h ? (ROLE === 'owner' ? `<button type="button" class="hol-link" data-hgo="${d}">${holChip(h)}</button>` : holChip(h)) : ''}</div>`; }).join('')}
    ${emps.map((e) => `<div class="sg-emp"><span class="who">${avatar(e.name, 'sm')}<span><b>${esc(e.name)}</b><span class="sub">${esc(e.department || '')}${e.department ? '・' : ''}${weekHours(e, from)} 小時</span></span></span></div>
      ${days.map((d) => { const h = r.H.get(d); return `<button type="button" class="sg-cell ${h && h.off ? 'is-hol' : ''} ${isWkend(d) ? 'is-wk' : ''}" data-ce="${e.id}" data-cd="${d}" aria-label="${esc(e.name)} ${mdw(d)}">${cellInner(e, d)}</button>`; }).join('')}`).join('')}
  </div>`;
  bindCells($('schCal'));
}
function renderWeekMobile(emps, from) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i)), r = SCH.data, today = taipeiToday();
  if (!days.includes(SCH.day)) SCH.day = days.includes(today) ? today : from;
  const d = SCH.day, h = r.H.get(d);
  const count = (x) => emps.filter((e) => { const y = r.E.get(K(e.id, x)); return y && y.kind === 'shift'; }).length;
  $('schCal').innerHTML = `<div class="sch-strip" role="tablist" aria-label="選擇日期">${days.map((x, i) => { const hh = r.H.get(x); const nw = emps.reduce((a, e) => a + (r.W.get(K(e.id, x)) || []).length, 0);
      return `<button type="button" role="tab" aria-selected="${x === d}" class="${x === d ? 'on' : ''} ${hh && hh.off ? 'is-hol' : ''} ${x === today ? 'is-today' : ''}" data-day="${x}"><span>週${WD_ORDER[i]}</span><b>${Number(x.slice(8))}</b><i>${count(x) ? `${count(x)} 人` : '—'}</i>${nw ? '<em class="sw-dot" aria-label="有提醒"></em>' : ''}</button>`; }).join('')}</div>
    <div class="sch-day" id="schDay">
      <div class="sd-head"><b>${mdw(d)}</b>${h ? (ROLE === 'owner' ? `<button type="button" class="hol-link" data-hgo="${d}">${holChip(h)}</button>` : holChip(h)) : ''}<span class="muted">左右滑動切換日期</span></div>
      ${emps.map((e) => `<button type="button" class="sd-row" data-ce="${e.id}" data-cd="${d}"><span class="who">${avatar(e.name, 'sm')}<span><b>${esc(e.name)}</b><span class="sub">${esc(e.department || '')}${e.department ? '・' : ''}本週 ${weekHours(e, from)} 小時</span></span></span><span class="sd-cell">${cellInner(e, d)}</span></button>`).join('')}
    </div>`;
  $('schCal').querySelectorAll('[data-day]').forEach((b) => b.onclick = () => { SCH.day = b.dataset.day; renderWeekMobile(emps, from); });
  const box = $('schDay'); let sx = null, sy = null;
  box.addEventListener('touchstart', (ev) => { sx = ev.touches[0].clientX; sy = ev.touches[0].clientY; }, { passive: true });
  box.addEventListener('touchend', (ev) => {
    if (sx === null) return; const dx = ev.changedTouches[0].clientX - sx, dy = ev.changedTouches[0].clientY - sy; sx = null;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
    const i = days.indexOf(d) + (dx < 0 ? 1 : -1);
    if (i < 0) { SCH.anchor = addDays(SCH.anchor, -7); SCH.day = addDays(d, -1); loadSchedule(); }
    else if (i > 6) { SCH.anchor = addDays(SCH.anchor, 7); SCH.day = addDays(d, 1); loadSchedule(); }
    else { SCH.day = days[i]; renderWeekMobile(emps, from); }
  });
  bindCells($('schCal'));
}
function renderMonth(emps, first, last, from, to) {
  const r = SCH.data, today = taipeiToday(), cells = [];
  for (let d = from; d <= to; d = addDays(d, 1)) cells.push(d);
  const MAX = 4;
  $('schCal').innerHTML = `<div class="sch-month card"><div class="mh">${WD_ORDER.map((w) => `<span>${w}</span>`).join('')}</div><div class="mg">
    ${cells.map((d) => {
      const h = r.H.get(d), out = d < first || d > last;
      const items = emps.map((e) => ({ e, x: r.E.get(K(e.id, d)), lv: r.L.get(K(e.id, d)), w: r.W.get(K(e.id, d)) })).filter((y) => y.x || y.lv);
      const nw = items.reduce((a, y) => a + (y.w || []).length, 0);
      return `<button type="button" class="mc ${out ? 'out' : ''} ${h && h.off ? 'is-hol' : ''} ${d === today ? 'is-today' : ''}" data-mday="${d}" aria-label="${mdw(d)}，${items.length} 人有安排">
        <span class="mc-top"><b>${Number(d.slice(8))}</b>${nw ? `<span class="sc-warn">${icon('alert', 11)}${nw}</span>` : ''}</span>${h ? holChip(h, 'mini') : ''}
        <span class="mc-list">${items.slice(0, MAX).map(({ e, x, lv }) => `<span class="mi">${x ? `<i class="dot sc-${x.kind === 'shift' ? esc(x.color) : x.kind === 'rest' ? 'off' : 'reg'}"></i>` : `<i class="dot sc-leave"></i>`}<span class="mi-n">${esc(e.name)}</span><span class="mi-s">${x ? esc(x.kind === 'shift' ? x.name : x.kind_text) : esc(lv[0].type_name)}</span></span>`).join('')}${items.length > MAX ? `<span class="mi more">還有 ${items.length - MAX} 人</span>` : ''}</span>
        <span class="mc-dots" aria-hidden="true">${items.slice(0, 6).map(({ x }) => `<i class="dot sc-${x ? (x.kind === 'shift' ? esc(x.color) : x.kind === 'rest' ? 'off' : 'reg') : 'leave'}"></i>`).join('')}</span></button>`;
    }).join('')}</div></div><p class="help">點日期切換到該週，逐日排班。</p>`;
  $('schCal').querySelectorAll('[data-mday]').forEach((b) => b.onclick = () => { SCH.view = 'week'; SCH.day = b.dataset.mday; SCH.anchor = mondayOf(SCH.day); loadSchedule(); });
}

// 單格編輯
function cellEditor(emp, d) {
  if (!emp) return;
  const r = SCH.data, k = K(emp.id, d), x = r.E.get(k), p = r.P.get(k), lv = r.L.get(k) || [], h = r.H.get(d), w = r.W.get(k) || [];
  const cur = x ? (x.kind === 'shift' ? (x.template_id && r.T.has(x.template_id) ? `t${x.template_id}` : 'custom') : x.kind) : 'clear';
  const opt = (v, inner, extra = '') => `<label class="sopt ${extra}"><input type="radio" name="pick" value="${v}" ${cur === v ? 'checked' : ''}><span>${inner}</span></label>`;
  modal(`<form class="form-grid sch-edit">
    <div class="summary-box"><span class="who">${avatar(emp.name, 'sm')}<b>${esc(emp.name)}</b></span>・${mdw(d)}</div>
    ${h ? `<div class="alert ${h.off ? 'warn' : 'info'}">${icon('flag', 18)}<div><b>${esc(h.name)}</b>（${esc(h.kind_text)}）${h.off ? '：放假日。若需出勤請先取得勞工同意，國定假日出勤工資加倍。' : '：照常上班日。'}</div></div>` : ''}
    ${lv.map((l) => `<div class="alert ${l.kind === 'leave' ? 'warn' : 'info'}">${icon(l.kind === 'leave' ? 'palm' : 'home', 18)}<div>已核准<b>${esc(l.type_name)}</b>${l.full ? '（全天）' : '（部分時段）'}</div></div>`).join('')}
    <fieldset class="sopts"><legend>班別</legend>
      ${r.templates.map((t) => opt(`t${t.id}`, `${chip({ ...t, kind: 'shift' }, { short: true })}<small>${t.start}–${t.overnight ? '翌日 ' : ''}${t.end}・${t.hours}h</small>`)).join('')}
      ${opt('custom', `<span class="sc sc-text-soft"><b>自訂時間</b></span><small>單次調整</small>`)}
      ${opt('rest', `${chip({ kind: 'rest' })}<small>可經同意出勤</small>`)}
      ${opt('regular', `${chip({ kind: 'regular' })}<small>每 7 日 1 日</small>`)}
      ${opt('clear', `<span class="sc sc-none"><b>不排班</b></span><small>清除</small>`)}
    </fieldset>
    <div class="row3 sch-custom ${cur === 'custom' ? '' : 'hidden'}">
      <div><label for="ceS">上班</label><input type="time" id="ceS" name="start" value="${x && x.kind === 'shift' ? x.start : '09:00'}"></div>
      <div><label for="ceE">下班</label><input type="time" id="ceE" name="end" value="${x && x.kind === 'shift' ? x.end : '18:00'}"></div>
      <div><label for="ceB">休息（分）</label><input type="number" id="ceB" name="break_min" min="0" max="240" step="5" value="${x && x.kind === 'shift' ? x.break_min : 60}"></div>
    </div>
    <div><label for="ceN">備註（選填）</label><input type="text" id="ceN" name="note" maxlength="60" value="${esc(x ? x.note : '')}" placeholder="例如：支援倉儲、教育訓練"></div>
    ${w.length ? `<div class="alert warn">${icon('scale', 18)}<div><b>勞基法提醒</b><ul class="w-ul">${w.map((y) => `<li>${esc(y.text)}</li>`).join('')}</ul></div></div>` : ''}
    ${p && !sameEntry(x, p) ? `<p class="help" style="margin:0">${icon('info', 14)} 員工目前看到的是已發布的：${p.kind === 'shift' ? `${esc(p.name)} ${p.start}–${p.end}` : esc(p.kind_text)}；重新發布後才會更新。</p>` : ''}
    ${actions('儲存（草稿）')}</form>`,
  async (f) => {
    const v = f.pick.value, item = { employee_id: emp.id, date: d, note: f.note.value };
    if (v.startsWith('t')) Object.assign(item, { kind: 'shift', template_id: Number(v.slice(1)) });
    else if (v === 'custom') Object.assign(item, { kind: 'shift', start: f.start.value, end: f.end.value, break_min: Number(f.break_min.value || 0) });
    else item.kind = v;
    await saveItems([item]);
  }, { title: '排班', icon: 'calendar' });
  const f = $('modal').querySelector('form');
  f.querySelectorAll('input[name=pick]').forEach((i) => i.onchange = () => f.querySelector('.sch-custom').classList.toggle('hidden', f.pick.value !== 'custom'));
}
async function saveItems(items, msg = '已儲存為草稿') {
  const r = await api('/api/admin/schedule/entries', { method: 'PUT', body: { items } });
  toast(r.warnings.length ? `${msg}・有 ${r.warnings.length} 項勞基法提醒` : msg, r.warnings.length ? '' : 'ok');
  loadSchedule();
}
async function publishWeek(w, unpublish) {
  const r = SCH.data, wk = r.weeks.find((x) => x.week_start === w);
  const ids = new Set(r.employees.map((e) => e.id));
  const nw = r.warnings.filter((x) => ids.has(x.employee_id) && x.date >= w && x.date <= wk.week_end).length;
  modal(`<form class="form-grid"><p style="margin:0">${unpublish ? `取消發布後，員工將看不到 ${md(w)}～${md(wk.week_end)} 的班表，打卡紀錄改回依上班時間設定判斷遲到。` : `發布 ${md(w)}～${md(wk.week_end)} 的班表給${ROLE === 'manager' ? '您團隊的' : '全部'} ${r.employees.length} 位員工。員工會在打卡頁「班表」看到，打卡紀錄也會依此判斷遲到與早退。`}</p>
    ${!unpublish && nw ? `<div class="alert warn">${icon('scale', 18)}<div>這週還有 <b>${nw}</b> 項勞基法提醒，仍可發布。</div></div>` : ''}${actions(unpublish ? '取消發布' : '發布', unpublish)}</form>`,
  async () => { await api('/api/admin/schedule/publish', { method: 'POST', body: { week_start: w, unpublish } }); toast(unpublish ? '已取消發布' : '已發布，員工可以看到這週班表', 'ok'); loadSchedule(); },
  { title: unpublish ? '取消發布班表' : '發布班表', icon: unpublish ? 'undo' : 'send', danger: unpublish });
}

// 工具列
$('schPrev').onclick = () => { if (SCH.view === 'week') { SCH.anchor = addDays(SCH.anchor, -7); SCH.day = addDays(SCH.day || SCH.anchor, -7); } else { const m = shiftMonth(SCH.anchor.slice(0, 7), -1); SCH.anchor = `${m}-01`; } loadSchedule(); };
$('schNext').onclick = () => { if (SCH.view === 'week') { SCH.anchor = addDays(SCH.anchor, 7); SCH.day = addDays(SCH.day || SCH.anchor, 7); } else { const m = shiftMonth(SCH.anchor.slice(0, 7), 1); SCH.anchor = `${m}-01`; } loadSchedule(); };
$('schToday').onclick = () => { SCH.day = taipeiToday(); SCH.anchor = SCH.view === 'week' ? mondayOf(SCH.day) : SCH.day.slice(0, 8) + '01'; loadSchedule(); };
document.querySelectorAll('[data-sview]').forEach((b) => b.onclick = () => {
  if (b.dataset.sview === SCH.view) return;
  SCH.view = b.dataset.sview;
  SCH.anchor = SCH.view === 'month' ? (SCH.day || SCH.anchor).slice(0, 8) + '01' : mondayOf(SCH.day && SCH.day.slice(0, 7) === SCH.anchor.slice(0, 7) ? SCH.day : SCH.anchor);
  loadSchedule();
});
$('schDept').onchange = () => { SCH.dept = $('schDept').value; renderSchedule(); };
$('schHolBtn').onclick = () => { holYear = Number((SCH.day || SCH.anchor).slice(0, 4)); setStab('hol'); };
schMobile.addEventListener('change', () => { if (SCH.data && SCH.tab === 'cal' && !$('appView').classList.contains('hidden')) renderSchedule(); });

$('schCopy').onclick = () => {
  const src = addDays(SCH.anchor, -7);
  modal(`<form class="form-grid"><p style="margin:0">把上週（${md(src)}～${md(addDays(src, 6))}）的班表複製到本週（${md(SCH.anchor)}～${md(addDays(SCH.anchor, 6))}）${SCH.dept ? `，只複製「${esc(SCH.dept)}」` : ''}。複製後是草稿，確認後再發布。</p>
    <label class="switch-row"><input type="checkbox" class="switch" name="overwrite"><span class="d">覆蓋本週已排好的班</span></label>${actions('複製')}</form>`,
  async (f) => copyWeeks(src, [SCH.anchor], f.overwrite.checked), { title: '複製上週班表', icon: 'repeat' });
};
$('schRepeat').onclick = () => {
  modal(`<form class="form-grid"><p style="margin:0">把本週（${md(SCH.anchor)}～${md(addDays(SCH.anchor, 6))}）的班表當作固定模式，重複套用到之後幾週${SCH.dept ? `（只套用「${esc(SCH.dept)}」）` : ''}。</p>
    <div><label for="rpN">套用週數</label><select id="rpN" name="n">${[1, 2, 3, 4, 6, 8, 12].map((n) => `<option value="${n}" ${n === 4 ? 'selected' : ''}>之後 ${n} 週（到 ${md(addDays(SCH.anchor, 7 * n + 6))}）</option>`).join('')}</select></div>
    <label class="switch-row"><input type="checkbox" class="switch" name="overwrite"><span class="d">覆蓋已排好的班</span></label>${actions('套用')}</form>`,
  async (f) => copyWeeks(SCH.anchor, Array.from({ length: Number(f.n.value) }, (_, i) => addDays(SCH.anchor, 7 * (i + 1))), f.overwrite.checked), { title: '重複套用週班表', icon: 'calendarCheck' });
};
async function copyWeeks(source_week, target_weeks, overwrite) {
  const employee_ids = SCH.dept ? schEmps().map((e) => e.id) : undefined;
  const r = await api('/api/admin/schedule/copy', { method: 'POST', body: { source_week, target_weeks, overwrite, employee_ids } });
  toast(`已複製 ${r.copied} 筆${r.skipped ? `，略過已排的 ${r.skipped} 筆` : ''}${r.warnings.length ? `・有 ${r.warnings.length} 項提醒` : ''}`, 'ok');
  loadSchedule();
}
$('schBulk').onclick = () => {
  const r = SCH.data, { from, to, first, last } = schRange(), emps = schEmps();
  const a = SCH.view === 'month' ? first : from, b = SCH.view === 'month' ? last : to;
  modal(`<form class="form-grid sch-edit">
    <div class="summary-box">套用範圍：${mdw(a)}～${mdw(b)}</div>
    <fieldset class="chk-grid"><legend>員工</legend>${emps.map((e) => `<label class="chk"><input type="checkbox" name="emp" value="${e.id}" checked><span>${esc(e.name)}</span></label>`).join('')}</fieldset>
    <fieldset class="chk-grid days"><legend>星期</legend>${WD_ORDER.map((w, i) => `<label class="chk"><input type="checkbox" name="wd" value="${(i + 1) % 7}" ${i < 5 ? 'checked' : ''}><span>${w}</span></label>`).join('')}</fieldset>
    <fieldset class="sopts"><legend>排成</legend>
      ${r.templates.map((t, i) => `<label class="sopt"><input type="radio" name="pick" value="t${t.id}" ${i === 0 ? 'checked' : ''}><span>${chip({ ...t, kind: 'shift' }, { short: true })}<small>${t.start}–${t.overnight ? '翌日 ' : ''}${t.end}</small></span></label>`).join('')}
      <label class="sopt"><input type="radio" name="pick" value="rest"><span>${chip({ kind: 'rest' })}</span></label>
      <label class="sopt"><input type="radio" name="pick" value="regular"><span>${chip({ kind: 'regular' })}</span></label>
      <label class="sopt"><input type="radio" name="pick" value="clear"><span><span class="sc sc-none"><b>清除</b></span></span></label>
    </fieldset>
    <label class="switch-row"><input type="checkbox" class="switch" name="skip" checked><span class="d">略過國定假日與已核准請假的日子</span></label>
    <label class="switch-row"><input type="checkbox" class="switch" name="keep"><span class="d">只排空白的日子（不覆蓋已排的班）</span></label>
    ${actions('批次套用')}</form>`,
  async (f) => {
    const ids = [...f.querySelectorAll('input[name=emp]:checked')].map((i) => Number(i.value));
    const wds = new Set([...f.querySelectorAll('input[name=wd]:checked')].map((i) => Number(i.value)));
    const v = f.pick.value, items = [];
    for (let d = a; d <= b; d = addDays(d, 1)) {
      if (!wds.has(new Date(d + 'T00:00:00Z').getUTCDay())) continue;
      for (const id of ids) {
        const k = K(id, d);
        if (f.skip.checked && v.startsWith('t') && ((r.H.get(d) || {}).off || (r.L.get(k) || []).some((l) => l.kind === 'leave'))) continue;
        if (f.keep.checked && r.E.has(k)) continue;
        items.push({ employee_id: id, date: d, ...(v.startsWith('t') ? { kind: 'shift', template_id: Number(v.slice(1)) } : { kind: v }) });
      }
    }
    if (!items.length) throw new Error('沒有符合條件的日子');
    await saveItems(items, `已批次排 ${items.length} 格（草稿）`);
  }, { title: '批次排班', icon: 'calendarPlus' });
};

// 班別
const COLOR_NAME = { primary: '奶茶', 'primary-soft': '淺奶茶', accent: '玫瑰', 'accent-soft': '淺玫瑰', text: '可可', 'text-soft': '淺可可' };
let tplCache = null;
async function loadTemplates() {
  try {
    const r = await api('/api/admin/shift-templates'); tplCache = r;
    $('tplList').innerHTML = r.templates.map((t) => `<div class="card tpl-row ${t.active ? '' : 'is-off'}">
      ${chip({ ...t, kind: 'shift' }, { short: true })}
      <div class="tpl-main"><b>${t.start} – ${t.overnight ? '翌日 ' : ''}${t.end}</b><span class="muted">休息 ${t.break_min} 分・工時 ${t.hours} 小時${t.overnight ? '・跨夜' : ''}${t.active ? '' : '・已停用'}</span></div>
      <button class="btn secondary sm owner-only" data-tedit="${t.id}">${icon('pencil', 15)}修改</button></div>`).join('')
      || `<div class="card"><div class="empty"><span class="empty-ic">${icon('clock', 24)}</span><b>還沒有班別</b>按「新增班別」建立早班、晚班等常用時段</div></div>`;
    $('tplList').querySelectorAll('[data-tedit]').forEach((b) => b.onclick = () => tplModal(r.templates.find((t) => t.id == b.dataset.tedit)));
  } catch (e) { handle(e); }
}
function tplModal(t) {
  const colors = (tplCache && tplCache.colors) || Object.keys(COLOR_NAME), c0 = t ? t.color : 'primary';
  modal(`<form class="form-grid">
    <div><label for="tpN">班別名稱</label><input type="text" id="tpN" name="name" maxlength="10" required value="${esc(t ? t.name : '')}" placeholder="例如：早班、晚班、全天"></div>
    <div class="row3">
      <div><label for="tpS">上班</label><input type="time" id="tpS" name="start" required value="${t ? t.start : '09:00'}"></div>
      <div><label for="tpE">下班</label><input type="time" id="tpE" name="end" required value="${t ? t.end : '18:00'}"></div>
      <div><label for="tpB">休息（分）</label><input type="number" id="tpB" name="break_min" min="0" max="240" step="5" value="${t ? t.break_min : 60}"></div>
    </div>
    <p class="help" id="tpHint" style="margin:0"></p>
    <fieldset class="swatches"><legend>顏色（奶茶色系）</legend>${colors.map((c) => `<label class="sw"><input type="radio" name="color" value="${c}" ${c === c0 ? 'checked' : ''}><span class="sc sc-${c}"><b>${COLOR_NAME[c] || c}</b></span></label>`).join('')}</fieldset>
    ${t ? `<label class="switch-row"><input type="checkbox" class="switch" name="active" ${t.active ? 'checked' : ''}><span class="d">啟用（停用後排班時不會出現，已排的班不受影響）</span></label>` : ''}
    ${actions(t ? '儲存' : '新增')}</form>`,
  async (f) => {
    const body = { ...formData(f), break_min: Number(f.break_min.value || 0) };
    if (t) body.active = f.active.checked;
    await api('/api/admin/shift-templates' + (t ? `/${t.id}` : ''), { method: t ? 'PUT' : 'POST', body });
    toast(t ? '班別已更新' : '已新增班別', 'ok'); loadTemplates();
  }, { title: t ? '修改班別' : '新增班別', icon: 'clock' });
  const f = $('modal').querySelector('form');
  const hint = () => {
    const [sh, sm] = f.start.value.split(':').map(Number), [eh, em] = f.end.value.split(':').map(Number);
    if (Number.isNaN(sh) || Number.isNaN(eh)) return;
    let m = eh * 60 + em - (sh * 60 + sm); const night = m <= 0; if (night) m += 1440;
    const h = +((m - Number(f.break_min.value || 0)) / 60).toFixed(2);
    $('tpHint').innerHTML = `${icon('info', 14)} 工時 ${h} 小時${night ? '・跨夜班（隔天下班）' : ''}${h > 12 ? '・超過 12 小時' : ''}`;
  };
  ['start', 'end', 'break_min'].forEach((n) => f[n].addEventListener('input', hint)); hint();
}
$('tplAdd').onclick = () => tplModal(null);

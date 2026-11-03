// 薪資單（列印用）
hydrateIcons();
const q = new URLSearchParams(location.search);
const month = /^\d{4}-\d{2}$/.test(q.get('month') || '') ? q.get('month') : taipeiToday().slice(0, 7);
const NT = (n) => Math.round(n || 0).toLocaleString('en-US');
const h = (x) => +(+x || 0).toFixed(2);
let data = null;
// 國定假日出勤／照給明細
function holTable(e) {
  const H = e.holiday; if (!H) return '';
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  const rows = [...(H.worked || []).map((x) => [x.date, x.name, `出勤 ${h(x.worked_h)} 小時`, e.pay_type === 'monthly' ? '加給一日工資' : `加給 ${h(x.in8_h)} 小時`]),
    ...(H.paid_off || []).map((x) => [x.date, x.name, '放假', `照給 ${h(x.hours)} 小時`])].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .reduce((acc, r) => { const last = acc[acc.length - 1]; if (last && last[0] === r[0]) last[3] += `、${r[3]}`; else acc.push([...r]); return acc; }, []);
  if (!rows.length) return '';
  return `<table class="hol"><thead><tr><th>日期</th><th>國定假日</th><th>出勤</th><th class="r">薪資</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${md(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td class="r">${esc(r[3])}</td></tr>`).join('')}</tbody></table>`;
}
function slip(e, p) {
  const [y, m] = p.month.split('-').map(Number);
  const rows = (lines, neg) => lines.map((l) => `<tr><td>${esc(l.label)}<small>${esc(l.detail)}</small></td><td class="r">${neg ? '−' : ''}${NT(l.amount)}</td></tr>`).join('') || '<tr><td colspan="2" style="color:#78837f">無</td></tr>';
  return `<article class="slip">
    <div class="slip-head"><div><div class="co">${esc(p.company_name)}</div><h2>薪資單</h2></div>
      <div style="text-align:right"><div style="font-size:18px;font-weight:700">${y} 年 ${m} 月</div>
      <span class="stamp ${p.confirmed ? 'ok' : 'draft'}">${p.confirmed ? `已確認 ${esc(p.confirmed_text)}` : '試算（未確認）'}</span></div></div>
    <div class="slip-meta">
      <div><span>員工</span><b>${esc(e.name)}</b></div>
      <div><span>計薪方式</span><b>${e.pay_type_text} NT$ ${NT(e.pay_amount)}${e.pay_type === 'hourly' ? '／小時' : ''}</b></div>
      <div><span>換算時薪</span><b>${e.hourly_rate}</b></div>
      <div><span>計薪期間</span><b>${p.from.replace(/-/g, '/')}～${p.to.replace(/-/g, '/')}</b></div>
      <div><span>出勤天數</span><b>${e.work_days} 天${e.weekend_days ? `（休息日 ${e.weekend_days}）` : ''}</b></div>
      <div><span>工時（計薪）</span><b>${h(e.worked_hours)}（${h(e.paid_hours)}）小時</b></div>
    </div>
    <div class="slip-cols">
      <table><thead><tr><th>應發項目</th><th class="r">金額</th></tr></thead><tbody>${rows(e.earn)}</tbody><tfoot><tr><td>應發合計</td><td class="r">${NT(e.gross)}</td></tr></tfoot></table>
      <table><thead><tr><th>應扣項目</th><th class="r">金額</th></tr></thead><tbody>${rows(e.deduct, true)}</tbody><tfoot><tr><td>應扣合計</td><td class="r">−${NT(e.deduct_total)}</td></tr></tfoot></table>
    </div>
    <div class="net"><span>實發金額</span><b>NT$ ${NT(e.net)}</b></div>
    <div class="att">
      <div><span>平日加班</span>${h(e.ot.weekday_total)} 小時</div>
      <div><span>休息日加班</span>${h(e.ot.rest_total)} 小時</div>
      <div><span>遲到／早退</span>${e.late_count} 次 ${e.late_min} 分／${e.early_count} 次 ${e.early_min} 分</div>
      <div><span>異地打卡／居家／公差</span>${e.offsite_count} 次／${e.wfh_days} 天／${e.trip_days} 天</div>
    </div>
    ${e.leaves.length ? `<table><thead><tr><th>假別</th><th class="r">時數</th><th>給薪</th><th class="r">對薪資影響</th></tr></thead><tbody>${e.leaves.map((l) => `<tr><td>${esc(l.type_name)}${l.over_cap_hours ? `<small>超過每年上限 ${l.over_cap_hours} 小時不給薪</small>` : ''}</td><td class="r">${h(l.hours)} 小時</td><td>${esc(l.ratio_text)}</td><td class="r">${esc(l.effect_text)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${holTable(e)}
    <div class="disc">※ ${esc(p.disclaimer)}加班費依勞基法第 24 條計算（月薪換算時薪＝月薪÷30÷8）；週六、日上班以休息日加班計；國定假日出勤 8 小時內工資加倍發給（勞基法第 39 條）。</div>
    <div class="sign"><span>製表</span><span>核准</span><span>員工簽收</span></div>
  </article>`;
}
function render() {
  const id = document.getElementById('slipEmp').value;
  const list = data.employees.filter((e) => !id || String(e.id) === id);
  document.getElementById('slips').innerHTML = list.map((e) => slip(e, data)).join('') || '<div class="card empty"><b>沒有資料</b></div>';
  const [y, m] = month.split('-').map(Number);
  document.getElementById('slipTitle').textContent = `${y} 年 ${m} 月薪資單${id ? '' : `（全部 ${list.length} 人）`}`;
  const u = new URL(location.href); if (id) u.searchParams.set('employee_id', id); else u.searchParams.delete('employee_id'); history.replaceState(null, '', u);
}
(async () => {
  try {
    data = await api('/api/admin/payroll?month=' + month);
    const sel = document.getElementById('slipEmp');
    sel.innerHTML = '<option value="">全部員工</option>' + data.employees.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
    sel.value = q.get('employee_id') || '';
    sel.onchange = render; render();
  } catch (e) {
    document.getElementById('slips').innerHTML = `<div class="card empty"><b>${esc(e.status === 401 ? '請先登入管理後台' : e.message)}</b><a class="btn" href="/admin">前往登入</a></div>`;
  }
})();
document.getElementById('slipPrint').onclick = () => window.print();

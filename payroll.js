// 薪資統整（試算）— 依打卡、請假、居家上班／公差資料計算每月薪資
// 試算僅供參考，請以會計／勞動法規為準。
const H = 3600 * 1000;
const RATES = { wd: [1.34, 1.67], rest: [1.34, 1.67, 2.67] }; // 勞基法第 24 條：平日延長工時；休息日（第 24 條第 2 項）
// 國定假日（勞基法第 37、39 條）：
//  ・月薪：國定假日工資已含在月薪內；經同意出勤者，8 小時內加給一日工資（月薪 ÷ 30），不論實際時數。
//  ・時薪：原約定工作日適逢國定假日→放假、工資照給（時薪 × 原約定時數）；出勤者另加發一倍（時薪 × 實際工時，8 小時內）。
//    原約定無出勤義務（holiday_hours = 0）者未出勤不給薪，出勤仍加倍。
//  ・超過 8 小時部分依第 24 條第 1 項延長工時（前 2 小時 ×1.34、再 2 小時 ×1.67）。
//  參考：勞動部「時薪制勞工的權益」https://www.mol.gov.tw/1607/28162/28166/28180/28182/28188/29022/
//        勞動部新聞稿「國定假日應依法給假給薪，協商調移假日亦屬可行」https://www.mol.gov.tw/announcement/2099/13623/
const HOLIDAY_DAY_DIVISOR = 30;   // 一日工資＝月薪 ÷ 30
const HOLIDAY_IN_HOURS = 8;       // 第 39 條加倍發給的範圍（8 小時內）
const MIN_WAGE = { year: 2026, monthly: 29500, hourly: 196 };  // 基本工資（提示用）
const MONTHLY_DIVISOR = 240;                                    // 月薪換算時薪：月薪 ÷ 30 ÷ 8
const DISCLAIMER = '試算僅供參考，請以會計／勞動法規為準。';
const PAY_TYPE_TEXT = { monthly: '月薪', hourly: '時薪' };
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '');
const r2 = (n) => Math.round(n * 100) / 100;
const money = (n) => Math.round(n);
const NT0 = (n) => Math.round(n || 0).toLocaleString('en-US');
const fmtMoney = (n) => `NT$ ${Math.round(n).toLocaleString('en-US')}`;
const ratioText = (r) => (r >= 1 ? '照給' : r === 0.5 ? '半薪' : r <= 0 ? '不給薪' : `給 ${Math.round(r * 100)}%`);

module.exports = function registerPayroll(ctx) {
  const { app, db, getSetting, setSetting, getSettings, loadPunches, loadLeaves, loadArrangements, computeDaily, arrangementMap, taipeiToEpoch, taipeiDateStr, L, audit, ExcelJS, todayStr, weekday, fmtTime, fmtDateTime, KIND_TEXT, path, defaultPay, HOL } = ctx;

  function monthRange(month) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}`, year: y };
  }
  function payRules() {
    return {
      late_deduct: getSetting('payroll_late_deduct') === '1',
      ot_unit: [1, 15, 30, 60].includes(Number(getSetting('payroll_ot_unit'))) ? Number(getSetting('payroll_ot_unit')) : 1,
      clip_early: getSetting('payroll_clip_early') !== '0',
    };
  }
  const parseItems = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  const leaveTypeRows = () => db.prepare("SELECT id, name, active, pay_ratio, pay_cap_days, deduct_annual FROM leave_types WHERE kind='leave' ORDER BY sort, id").all();

  // 某員工某假別在 [fromTs, toTs) 期間內已核准的請假時數（只算上班日的上班時段）
  function leaveHoursBetween(empId, typeId, fromTs, toTs, s) {
    let h = 0;
    for (const l of db.prepare("SELECT * FROM leave_requests WHERE employee_id=? AND type_id=? AND kind='leave' AND status='approved' AND end_ts>? AND start_ts<?").all(empId, typeId, fromTs, toTs)) {
      h += L.calcLeave(Math.max(l.start_ts, fromTs), Math.min(l.end_ts, toTs), s).hours;
    }
    return h;
  }

  function computePayroll(month) {
    const { from, to, year } = monthRange(month);
    const s = getSettings();
    const rules = payRules();
    const unitMs = rules.ot_unit * 60000;
    const floorU = (ms) => Math.floor(Math.max(0, ms) / unitMs) * unitMs;
    const stdMs = s.standard_hours * H;
    const startTs = taipeiToEpoch(from, '00:00'), endTs = taipeiToEpoch(to, '00:00') + 24 * H;
    // 有出勤或請假的員工一定列入；沒有資料的在職員工，若建立時間／到職日晚於該月則不列入
    const hasData = new Set([...db.prepare('SELECT DISTINCT employee_id id FROM punches WHERE ts>=? AND ts<?').all(startTs, endTs), ...db.prepare("SELECT DISTINCT employee_id id FROM leave_requests WHERE status='approved' AND end_ts>? AND start_ts<?").all(startTs, endTs)].map((x) => x.id));
    const emps = db.prepare('SELECT * FROM employees ORDER BY id').all()
      .filter((e) => hasData.has(e.id) || (e.active && e.created_at < endTs && !(e.hire_date && e.hire_date > to)));
    const punches = loadPunches(from, to);
    const leaves = loadLeaves(from, to);
    const arrs = loadArrangements(from, to);
    const daily = computeDaily(punches, s, leaves, { from, to }, arrs);
    const arrMap = arrangementMap(arrs, { from, to });
    const types = new Map(leaveTypeRows().map((t) => [t.id, t]));
    const adjAll = db.prepare('SELECT * FROM payroll_adjustments WHERE month=? ORDER BY id').all(month);
    const today = todayStr();
    const inProgress = to >= today && from <= today;

    const list = emps.map((e) => {
      const payType = e.pay_type === 'hourly' ? 'hourly' : 'monthly';
      const amount = Number(e.pay_amount) || 0;
      const rate = payType === 'monthly' ? amount / MONTHLY_DIVISOR : amount;
      const items = parseItems(e.pay_items);
      const warnings = [];
      if (!amount) warnings.push('尚未設定薪資，請到「薪資設定」填寫');
      else if (payType === 'monthly' && amount < MIN_WAGE.monthly) warnings.push(`月薪低於 ${MIN_WAGE.year} 年基本工資 NT$ ${MIN_WAGE.monthly.toLocaleString('en-US')}`);
      else if (payType === 'hourly' && amount < MIN_WAGE.hourly) warnings.push(`時薪低於 ${MIN_WAGE.year} 年基本工資 NT$ ${MIN_WAGE.hourly}`);
      const myPunches = punches.filter((p) => p.employee_id === e.id);
      const rows = daily.filter((r) => r.employee_id === e.id).sort((a, b) => (a.date < b.date ? -1 : 1));
      const holSched = payType === 'hourly' ? (e.holiday_hours == null || e.holiday_hours === '' ? s.standard_hours : Math.max(0, Number(e.holiday_hours) || 0)) : null;
      const hol = { worked_days: 0, in8_ms: 0, list: [] };
      const t = { work_days: 0, weekend_days: 0, worked_ms: 0, paid_ms: 0, wd1: 0, wd2: 0, rs1: 0, rs2: 0, rs3: 0, late_count: 0, late_min: 0, early_count: 0, early_min: 0, offsite: 0, missing: 0 };
      const days = [];
      for (const r of rows) {
        const wknd = L.isWeekend(r.date);
        const hinfo = HOL ? HOL.info(r.date) : null;
        const statHol = !!(hinfo && hinfo.paid_holiday && !wknd);   // 國定假日／補假／調移放假（平日）
        const offDay = !!(hinfo && hinfo.off && !wknd);              // 含公司自訂假日、採用的彈性放假
        const dayP = myPunches.filter((p) => taipeiDateStr(p.ts) === r.date);
        const firstIn = dayP.find((p) => p.type === 'in');
        const outs = dayP.filter((p) => p.type === 'out');
        const lastOut = outs[outs.length - 1];
        const d = { date: r.date, weekday: r.weekday, weekend: wknd, first_in: r.first_in, last_out: r.last_out, worked_h: 0, paid_h: 0, ot1_h: 0, ot2_h: 0, rest1_h: 0, rest2_h: 0, rest3_h: 0, late_min: 0, early_min: 0,
          leave_text: r.leave_text, work_mode_text: r.work_mode_text, offsite: r.offsite_count, notes: [...r.issues], holiday: hinfo && (hinfo.off || hinfo.kind === 'swap_out') ? hinfo.name : '', holiday_kind: hinfo ? hinfo.kind : '', holiday_extra: 0 };
        if (!r.leave_only) {
          let worked = r.worked_ms;
          t.worked_ms += worked; d.worked_h = r2(worked / H);
          if (!wknd && !offDay && rules.clip_early && firstIn) {
            const ws = L.workWindow(r.date, s).ws;
            const early = Math.min(Math.max(0, ws - firstIn.ts), worked);
            if (early >= 60000) { worked -= early; d.notes.push(`提早 ${Math.round(early / 60000)} 分到班不計`); }
          }
          if (wknd) {
            const h = floorU(worked);
            const a = Math.min(h, 2 * H), b = Math.min(Math.max(h - 2 * H, 0), 6 * H), c = Math.max(h - 8 * H, 0);
            t.rs1 += a; t.rs2 += b; t.rs3 += c; t.paid_ms += h; t.weekend_days++;
            Object.assign(d, { paid_h: r2(h / H), rest1_h: r2(a / H), rest2_h: r2(b / H), rest3_h: r2(c / H) });
            d.notes.unshift('休息日加班');
          } else if (statHol) {
            // 國定假日出勤：8 小時內加倍發給；超過 8 小時依平日延長工時計
            const capMs = HOLIDAY_IN_HOURS * H;
            const in8 = Math.min(worked, capMs);
            const ot = floorU(worked - capMs);
            const a = Math.min(ot, 2 * H), b = Math.max(ot - 2 * H, 0);
            t.wd1 += a; t.wd2 += b; t.paid_ms += in8 + ot;
            if (worked > 0) { hol.worked_days++; hol.in8_ms += in8; }
            Object.assign(d, { paid_h: r2((in8 + ot) / H), ot1_h: r2(a / H), ot2_h: r2(b / H) });
            d.notes.unshift(`國定假日出勤（${hinfo.name}）`);
            hol.list.push({ date: r.date, name: hinfo.name, worked_h: r2(worked / H), in8_h: r2(in8 / H) });
          } else {
            if (offDay) d.notes.unshift(`${hinfo.kind_text}出勤（${hinfo.name}），依平日計`);
            const ot = floorU(worked - stdMs);
            const a = Math.min(ot, 2 * H), b = Math.max(ot - 2 * H, 0);
            const paid = Math.min(worked, stdMs) + ot;
            t.wd1 += a; t.wd2 += b; t.paid_ms += paid;
            Object.assign(d, { paid_h: r2(paid / H), ot1_h: r2(a / H), ot2_h: r2(b / H) });
            if (r.late && !offDay) { t.late_count++; t.late_min += r.late_min; d.late_min = r.late_min; }
            // 早退：最後一次下班卡早於應下班時間（請假、午休時段往前扣）
            if (!offDay && lastOut && !r.working_now && !r.issues.includes('未打下班卡')) {
              const w = L.workWindow(r.date, s);
              let end = w.we;
              for (let changed = true; changed;) {
                changed = false;
                for (const it of r.leave_items || []) if (it.start_ts < end && it.end_ts >= end) { end = it.start_ts; changed = true; }
                if (w.ls !== null && end > w.ls && end <= w.le) { end = w.ls; changed = true; }
              }
              const em = Math.floor((end - lastOut.ts) / 60000);
              if (em > 0) { t.early_count++; t.early_min += em; d.early_min = em; }
            }
          }
          t.work_days++;
          if (r.issues.length) t.missing++;
        }
        t.offsite += r.offsite_count || 0;
        days.push(d);
      }
      // 居家上班／公差天數（已核准）
      let wfh = 0, trip = 0;
      for (const [k, v] of arrMap) if (k.startsWith(`${e.id}|`)) { if (v.kind === 'wfh') wfh++; else if (v.kind === 'trip') trip++; }

      // 請假（依假別）
      const byType = new Map();
      for (const l of leaves.filter((x) => x.employee_id === e.id)) {
        const h = L.calcLeave(Math.max(l.start_ts, startTs), Math.min(l.end_ts, endTs), s).hours;
        if (!h) continue;
        const x = byType.get(l.type_id) || { type_id: l.type_id, type_name: l.type_name, hours: 0 };
        x.hours = r2(x.hours + h); byType.set(l.type_id, x);
      }
      const leaveRows = [...byType.values()].map((x) => {
        const ty = types.get(x.type_id) || { pay_ratio: defaultPay(x.type_name)[0], pay_cap_days: defaultPay(x.type_name)[1], name: x.type_name };
        const ratio = Math.min(1, Math.max(0, Number(ty.pay_ratio ?? 1)));
        let atRatio = x.hours, over = 0, capNote = '';
        if (ty.pay_cap_days != null && ty.pay_cap_days !== '') {
          const capH = Number(ty.pay_cap_days) * s.standard_hours;
          const usedBefore = leaveHoursBetween(e.id, x.type_id, taipeiToEpoch(`${year}-01-01`, '00:00'), startTs, s);
          const remain = Math.max(0, capH - usedBefore);
          atRatio = Math.min(x.hours, remain); over = r2(x.hours - atRatio);
          capNote = `今年此前已請 ${r2(usedBefore)} 小時，每年 ${ty.pay_cap_days} 天內${ratioText(ratio)}`;
        }
        let effect = 0;
        if (payType === 'monthly') effect = -money(atRatio * rate * (1 - ratio) + over * rate);
        else effect = money(atRatio * rate * ratio);
        return { ...x, ratio, ratio_text: ratioText(ratio), over_cap_hours: over, cap_days: ty.pay_cap_days ?? null, cap_note: capNote, effect,
          effect_text: payType === 'monthly' ? (effect ? `扣 ${fmtMoney(-effect)}` : '不扣薪') : (effect ? `給 ${fmtMoney(effect)}` : '不給薪') };
      });

      // 金額
      const earn = [], deduct = [];
      const H_ = (ms) => r2(ms / H);
      const rateTxt = r2(rate);
      if (payType === 'monthly') earn.push({ label: '本薪（月薪）', detail: `時薪換算 ${fmtMoney(amount)} ÷ 30 ÷ 8 = ${rateTxt}`, amount: money(amount) });
      else earn.push({ label: '工時薪資', detail: `${H_(t.paid_ms)} 小時 × ${rateTxt}`, amount: money(H_(t.paid_ms) * rate) });
      const otParts = payType === 'monthly'
        ? [['平日加班（前 2 小時 ×1.34）', t.wd1, RATES.wd[0]], ['平日加班（第 3 小時起 ×1.67）', t.wd2, RATES.wd[1]], ['休息日加班（前 2 小時 ×1.34）', t.rs1, RATES.rest[0]], ['休息日加班（第 3～8 小時 ×1.67）', t.rs2, RATES.rest[1]], ['休息日加班（第 9 小時起 ×2.67）', t.rs3, RATES.rest[2]]]
        : [['平日加班加成（前 2 小時 +0.34）', t.wd1, RATES.wd[0] - 1], ['平日加班加成（第 3 小時起 +0.67）', t.wd2, RATES.wd[1] - 1], ['休息日加班加成（前 2 小時 +0.34）', t.rs1, RATES.rest[0] - 1], ['休息日加班加成（第 3～8 小時 +0.67）', t.rs2, RATES.rest[1] - 1], ['休息日加班加成（第 9 小時起 +1.67）', t.rs3, RATES.rest[2] - 1]];
      let otPay = 0;
      for (const [label, ms, k] of otParts) {
        if (!ms) continue;
        const amt = money(H_(ms) * rate * k); otPay += amt;
        earn.push({ label, detail: `${H_(ms)} 小時 × ${rateTxt} × ${r2(k)}`, amount: amt, group: 'ot' });
      }
      // 國定假日
      const holLines = [];
      let holExtra = 0, holPaidOff = 0, holPaidOffH = 0, holPaidOffDays = 0;
      if (HOL && hol.worked_days) {
        if (payType === 'monthly') {
          const dayWage = amount / HOLIDAY_DAY_DIVISOR;
          holExtra = money(hol.worked_days * dayWage);
          holLines.push({ label: '國定假日出勤加給', detail: `${hol.worked_days} 天 × 一日工資（${fmtMoney(amount)} ÷ 30 = ${r2(dayWage)}）；8 小時內加倍發給`, amount: holExtra, group: 'holiday' });
          for (const x of hol.list) if (x.worked_h > 0) { const dd = days.find((y) => y.date === x.date); if (dd) dd.holiday_extra = money(dayWage); }
        } else {
          holExtra = money(H_(hol.in8_ms) * rate);
          holLines.push({ label: '國定假日出勤加給', detail: `${H_(hol.in8_ms)} 小時 × ${rateTxt}（${hol.worked_days} 天，8 小時內加倍發給）`, amount: holExtra, group: 'holiday' });
          for (const x of hol.list) { const dd = days.find((y) => y.date === x.date); if (dd) dd.holiday_extra = money(x.in8_h * rate); }
        }
      }
      // 時薪：原約定工作日適逢國定假日 → 工資照給（時薪 × 原約定時數，扣掉當天已出勤時數）
      const holOffList = [];
      if (HOL && payType === 'hourly' && holSched > 0) {
        const until = inProgress ? today : to;
        const lastPunch = myPunches.length ? taipeiDateStr(myPunches[myPunches.length - 1].ts) : '';
        for (const h of HOL.between(from, until)) {
          if (!h.paid_holiday || h.weekend) continue;
          if (e.hire_date && h.date < e.hire_date) continue;
          if (!e.active && (!lastPunch || h.date > lastPunch)) continue;
          const w = hol.list.find((x) => x.date === h.date);
          const hrs = r2(Math.max(0, holSched - (w ? w.in8_h : 0)));
          if (hrs <= 0) continue;
          holPaidOffDays++; holPaidOffH = r2(holPaidOffH + hrs);
          holOffList.push({ date: h.date, name: h.name, hours: hrs });
        }
        if (holPaidOffH) {
          holPaidOff = money(holPaidOffH * rate);
          holLines.push({ label: '國定假日照給', detail: `${holPaidOffDays} 天、${holPaidOffH} 小時 × ${rateTxt}（原約定每日 ${holSched} 小時）`, amount: holPaidOff, group: 'holiday' });
        }
      }
      earn.push(...holLines);
      let leaveEffect = 0;
      for (const lv of leaveRows) {
        leaveEffect += lv.effect;
        if (payType === 'hourly' && lv.effect) earn.push({ label: `${lv.type_name}（${lv.ratio_text}）`, detail: `${r2(lv.hours - lv.over_cap_hours)} 小時 × ${rateTxt} × ${lv.ratio}`, amount: lv.effect, group: 'leave' });
        if (payType === 'monthly' && lv.effect) deduct.push({ label: `${lv.type_name}扣薪（${lv.ratio_text}）`, detail: `${r2(lv.hours - lv.over_cap_hours)} 小時 × ${rateTxt} × ${r2(1 - lv.ratio)}${lv.over_cap_hours ? `；超過每年 ${lv.cap_days} 天 ${lv.over_cap_hours} 小時不給薪` : ''}`, amount: -lv.effect, group: 'leave' });
      }
      let lateDeduct = 0;
      if (rules.late_deduct && payType === 'monthly' && (t.late_min + t.early_min) > 0) {
        lateDeduct = money(((t.late_min + t.early_min) / 60) * rate);
        deduct.push({ label: '遲到／早退扣薪（依分鐘比例）', detail: `${t.late_min + t.early_min} 分鐘 ÷ 60 × ${rateTxt}`, amount: lateDeduct, group: 'late' });
      }
      for (const it of items) {
        const amt = money(Number(it.amount) || 0); if (!amt) continue;
        (it.kind === 'deduct' ? deduct : earn).push({ label: String(it.name || (it.kind === 'deduct' ? '固定扣項' : '津貼')), detail: it.kind === 'deduct' ? '固定扣項' : '固定津貼', amount: amt, group: 'fixed' });
      }
      const adjs = adjAll.filter((a) => a.employee_id === e.id).map((a) => ({ id: a.id, kind: a.kind, label: a.label, amount: money(a.amount), note: a.note || '' }));
      for (const a of adjs) (a.kind === 'deduct' ? deduct : earn).push({ label: a.label, detail: a.note || '手動調整', amount: a.amount, group: 'adj', adj_id: a.id });
      const gross = earn.reduce((x, y) => x + y.amount, 0);
      const dsum = deduct.reduce((x, y) => x + y.amount, 0);
      if (e.hire_date && e.hire_date > from && e.hire_date <= to && payType === 'monthly') warnings.push(`本月 ${e.hire_date.slice(5).replace('-', '/')} 到職，月薪未按比例計算，請自行調整`);
      if (t.missing) warnings.push(`有 ${t.missing} 天打卡異常（缺卡），工時可能不完整`);
      if (gross - dsum < 0) warnings.unshift('實發金額為負數，請確認扣項');
      return {
        id: e.id, name: e.name, is_sample: !!e.is_sample, active: !!e.active, pay_type: payType, pay_type_text: PAY_TYPE_TEXT[payType], pay_amount: amount, hourly_rate: rateTxt, pay_note: e.pay_note || '',
        work_days: t.work_days, weekend_days: t.weekend_days, worked_hours: H_(t.worked_ms), paid_hours: H_(t.paid_ms),
        ot: { wd1: H_(t.wd1), wd2: H_(t.wd2), rest1: H_(t.rs1), rest2: H_(t.rs2), rest3: H_(t.rs3), weekday_total: H_(t.wd1 + t.wd2), rest_total: H_(t.rs1 + t.rs2 + t.rs3), total: H_(t.wd1 + t.wd2 + t.rs1 + t.rs2 + t.rs3), pay: otPay },
        late_count: t.late_count, late_min: t.late_min, early_count: t.early_count, early_min: t.early_min, late_deduct: lateDeduct,
        offsite_count: t.offsite, wfh_days: wfh, trip_days: trip, missing_days: t.missing,
        holiday: { worked_days: hol.worked_days, in8_hours: H_(hol.in8_ms), extra_pay: holExtra, paid_off_days: holPaidOffDays, paid_off_hours: holPaidOffH, paid_off_pay: holPaidOff, sched_hours: holSched, worked: hol.list, paid_off: holOffList },
        leaves: leaveRows, leave_hours: r2(leaveRows.reduce((x, y) => x + y.hours, 0)), leave_effect: leaveEffect,
        earn, deduct, adjustments: adjs, gross, deduct_total: dsum, net: gross - dsum, warnings, days,
      };
    });
    const sum = (f) => list.reduce((x, y) => x + f(y), 0);
    return {
      month, from, to, in_progress: inProgress, generated_at: Date.now(), generated_text: fmtDateTime(Date.now()),
      company_name: s.company_name, rules: { ...rules, holiday_day_divisor: HOLIDAY_DAY_DIVISOR, holiday_in_hours: HOLIDAY_IN_HOURS, rates: RATES, min_wage: MIN_WAGE, monthly_divisor: MONTHLY_DIVISOR, standard_hours: s.standard_hours, work_start: s.work_start },
      disclaimer: DISCLAIMER,
      totals: { employees: list.length, gross: sum((x) => x.gross), deduct: sum((x) => x.deduct_total), net: sum((x) => x.net), ot_hours: r2(sum((x) => x.ot.total)), ot_pay: sum((x) => x.ot.pay), leave_hours: r2(sum((x) => x.leave_hours)), leave_deduct: -sum((x) => (x.pay_type === 'monthly' ? x.leave_effect : 0)), holiday_pay: sum((x) => x.holiday.extra_pay + x.holiday.paid_off_pay), holiday_days: sum((x) => x.holiday.worked_days) },
      holidays: HOL ? HOL.between(from, to).filter((h) => h.off || h.kind === 'swap_out').map((h) => ({ date: h.date, name: h.name, kind: h.kind, kind_text: h.kind_text, off: !!h.off, paid_holiday: !!h.paid_holiday, weekend: !!h.weekend })) : [],
      employees: list,
    };
  }

  function getPayroll(month) {
    const row = db.prepare('SELECT * FROM payroll_months WHERE month=?').get(month);
    if (row) { const snap = JSON.parse(row.snapshot); return { ...snap, confirmed: true, confirmed_at: row.confirmed_at, confirmed_text: fmtDateTime(row.confirmed_at) }; }
    return { ...computePayroll(month), confirmed: false };
  }
  const isLocked = (month) => !!db.prepare('SELECT 1 FROM payroll_months WHERE month=?').get(month);

  // ---------- API ----------
  app.get('/api/admin/payroll/settings', (req, res) => {
    const emps = db.prepare('SELECT id, name, is_sample, pay_type, pay_amount, pay_items, pay_note, holiday_hours FROM employees WHERE active=1 ORDER BY id').all()
      .map((e) => ({ ...e, pay_type: e.pay_type === 'hourly' ? 'hourly' : 'monthly', pay_items: parseItems(e.pay_items), is_sample: !!e.is_sample }));
    res.json({ employees: emps, leave_types: leaveTypeRows().map((t) => ({ ...t, default_ratio: defaultPay(t.name)[0], default_cap: defaultPay(t.name)[1] })), rules: payRules(), min_wage: MIN_WAGE, rates: RATES, disclaimer: DISCLAIMER, standard_hours: getSettings().standard_hours });
  });
  app.put('/api/admin/payroll/employees/:id', (req, res) => {
    const emp = db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(Number(req.params.id));
    if (!emp) return res.status(404).json({ error: '找不到員工' });
    const b = req.body || {};
    const type = b.pay_type === 'hourly' ? 'hourly' : b.pay_type === 'monthly' ? 'monthly' : null;
    if (!type) return res.status(400).json({ error: '請選擇計薪方式（月薪或時薪）' });
    const amt = Number(b.pay_amount);
    const max = type === 'monthly' ? 10000000 : 100000;
    if (!Number.isFinite(amt) || amt < 0 || amt > max) return res.status(400).json({ error: type === 'monthly' ? '月薪金額需介於 0～10,000,000' : '時薪金額需介於 0～100,000' });
    const raw = Array.isArray(b.pay_items) ? b.pay_items : [];
    if (raw.length > 12) return res.status(400).json({ error: '津貼與扣項最多 12 筆' });
    const items = [];
    for (const it of raw) {
      const name = String(it.name || '').trim(), a = Number(it.amount);
      if (!name && !a) continue;
      if (!name) return res.status(400).json({ error: '請填寫津貼／扣項名稱' });
      if (name.length > 20) return res.status(400).json({ error: '名稱請在 20 字以內' });
      if (!Number.isFinite(a) || a < 0 || a > 1000000) return res.status(400).json({ error: `「${name}」金額需介於 0～1,000,000` });
      items.push({ kind: it.kind === 'deduct' ? 'deduct' : 'allow', name, amount: Math.round(a) });
    }
    const note = String(b.pay_note || '').trim().slice(0, 100);
    // 時薪人員國定假日照給時數：空白＝依標準工時；0＝無固定排班
    let holH = emp.holiday_hours;
    if (b.holiday_hours !== undefined) {
      if (b.holiday_hours === '' || b.holiday_hours === null) holH = null;
      else {
        holH = Number(b.holiday_hours);
        if (!Number.isFinite(holH) || holH < 0 || holH > 12) return res.status(400).json({ error: '國定假日照給時數需介於 0～12 小時' });
        holH = Math.round(holH * 100) / 100;
      }
    }
    db.prepare('UPDATE employees SET pay_type=?, pay_amount=?, pay_items=?, pay_note=?, holiday_hours=? WHERE id=?').run(type, Math.round(amt * 100) / 100, JSON.stringify(items), note, holH, emp.id);
    const desc = (x) => `${PAY_TYPE_TEXT[x.t]} ${fmtMoney(x.a)}${x.items.length ? `；${x.items.map((i) => `${i.kind === 'deduct' ? '扣' : '加'}${i.name} ${i.amount}`).join('、')}` : ''}`;
    audit('修改薪資設定', `${emp.name}：${desc({ t: emp.pay_type === 'hourly' ? 'hourly' : 'monthly', a: emp.pay_amount || 0, items: parseItems(emp.pay_items) })} → ${desc({ t: type, a: amt, items })}`);
    res.json({ ok: true });
  });
  app.put('/api/admin/payroll/rules', (req, res) => {
    const b = req.body || {};
    const unit = Number(b.ot_unit);
    if (![1, 15, 30, 60].includes(unit)) return res.status(400).json({ error: '加班計算單位只能是 1、15、30 或 60 分鐘' });
    const lt = Array.isArray(b.leave_types) ? b.leave_types : [];
    const types = new Map(leaveTypeRows().map((t) => [t.id, t]));
    const updates = [];
    for (const x of lt) {
      const t = types.get(Number(x.id)); if (!t) continue;
      const ratio = Number(x.pay_ratio);
      if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return res.status(400).json({ error: `「${t.name}」給薪比例需介於 0～100%` });
      const capRaw = x.pay_cap_days;
      const cap = capRaw === null || capRaw === undefined || capRaw === '' ? null : Number(capRaw);
      if (cap !== null && (!Number.isFinite(cap) || cap < 0 || cap > 366)) return res.status(400).json({ error: `「${t.name}」每年給薪上限需介於 0～366 天` });
      updates.push([t, ratio, cap]);
    }
    setSetting('payroll_late_deduct', b.late_deduct ? '1' : '0');
    setSetting('payroll_ot_unit', String(unit));
    setSetting('payroll_clip_early', b.clip_early === false ? '0' : '1');
    for (const [t, ratio, cap] of updates) db.prepare('UPDATE leave_types SET pay_ratio=?, pay_cap_days=? WHERE id=?').run(ratio, cap, t.id);
    audit('修改薪資規則', `遲到／早退扣薪：${b.late_deduct ? '開（依分鐘比例）' : '關'}；加班計算單位 ${unit} 分鐘；提早到班${b.clip_early === false ? '計入' : '不計入'}工時${updates.length ? `；假別給薪：${updates.map(([t, r, c]) => `${t.name} ${ratioText(r)}${c != null ? `（每年 ${c} 天內）` : ''}`).join('、')}` : ''}`);
    res.json({ ok: true, rules: payRules() });
  });
  app.get('/api/admin/payroll', (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : todayStr().slice(0, 7);
    res.json(getPayroll(month));
  });
  app.post('/api/admin/payroll/:month/adjustments', (req, res) => {
    const month = req.params.month;
    if (!isMonth(month)) return res.status(400).json({ error: '月份格式錯誤' });
    if (isLocked(month)) return res.status(409).json({ error: '這個月份已確認並鎖定，請先解除確認再調整' });
    const b = req.body || {};
    const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(Number(b.employee_id));
    if (!emp) return res.status(400).json({ error: '找不到員工' });
    const kind = b.kind === 'deduct' ? 'deduct' : 'add';
    const label = String(b.label || '').trim();
    if (!label) return res.status(400).json({ error: '請填寫項目名稱（例如：獎金）' });
    if (label.length > 20) return res.status(400).json({ error: '項目名稱請在 20 字以內' });
    const amt = Number(b.amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 10000000) return res.status(400).json({ error: '金額需大於 0' });
    const note = String(b.note || '').trim().slice(0, 200);
    db.prepare('INSERT INTO payroll_adjustments(month,employee_id,kind,label,amount,note,created_at) VALUES(?,?,?,?,?,?,?)').run(month, emp.id, kind, label, Math.round(amt), note, Date.now());
    audit('薪資調整', `${month} ${emp.name}：${kind === 'deduct' ? '扣項' : '加項'}「${label}」${fmtMoney(amt)}${note ? `｜${note}` : ''}`);
    res.json({ ok: true });
  });
  app.delete('/api/admin/payroll/:month/adjustments/:id', (req, res) => {
    const a = db.prepare('SELECT a.*, e.name FROM payroll_adjustments a JOIN employees e ON e.id=a.employee_id WHERE a.id=? AND a.month=?').get(Number(req.params.id), req.params.month);
    if (!a) return res.status(404).json({ error: '找不到這筆調整' });
    if (isLocked(a.month)) return res.status(409).json({ error: '這個月份已確認並鎖定，請先解除確認再調整' });
    db.prepare('DELETE FROM payroll_adjustments WHERE id=?').run(a.id);
    audit('薪資調整', `${a.month} ${a.name}：刪除${a.kind === 'deduct' ? '扣項' : '加項'}「${a.label}」${fmtMoney(a.amount)}`);
    res.json({ ok: true });
  });
  app.post('/api/admin/payroll/:month/confirm', (req, res) => {
    const month = req.params.month;
    if (!isMonth(month)) return res.status(400).json({ error: '月份格式錯誤' });
    if (isLocked(month)) return res.status(409).json({ error: '這個月份已經確認過了' });
    const p = computePayroll(month);
    db.prepare('INSERT INTO payroll_months(month,confirmed_at,snapshot) VALUES(?,?,?)').run(month, Date.now(), JSON.stringify(p));
    audit('確認薪資', `${month} 薪資已確認並鎖定：${p.employees.length} 人，實發合計 ${fmtMoney(p.totals.net)}`);
    res.json({ ok: true, payroll: getPayroll(month) });
  });
  app.post('/api/admin/payroll/:month/unconfirm', (req, res) => {
    const month = req.params.month;
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: '請填寫解除確認的原因' });
    if (!isLocked(month)) return res.status(404).json({ error: '這個月份尚未確認' });
    db.prepare('DELETE FROM payroll_months WHERE month=?').run(month);
    audit('解除薪資確認', `${month} 解除確認，將依最新資料重新試算｜原因：${reason}`);
    res.json({ ok: true });
  });

  // Excel：統整表＋每位員工的薪資明細
  app.get('/api/admin/payroll/:month/export', async (req, res) => {
    const month = req.params.month;
    if (!isMonth(month)) return res.status(400).json({ error: '月份格式錯誤' });
    const p = getPayroll(month);
    const wb = new ExcelJS.Workbook(); wb.creator = '員工打卡系統';
    const bold = { bold: true };
    const head = (ws, n) => { const r = ws.lastRow; r.font = bold; r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } }; return n; };
    const NT = '#,##0';
    const s1 = wb.addWorksheet('薪資統整');
    s1.addRow([`${p.company_name}　${month} 薪資統整（試算）${p.confirmed ? `　已確認 ${p.confirmed_text}` : '　未確認'}`]).font = { bold: true, size: 14 };
    s1.addRow([`⚠ ${DISCLAIMER}　月薪換算時薪＝月薪÷30÷8；平日加班前 2 小時 ×1.34、第 3 小時起 ×1.67；休息日（週六、日）加班前 2 小時 ×1.34、第 3～8 小時 ×1.67、第 9 小時起 ×2.67；國定假日出勤 8 小時內加倍發給（月薪加給月薪÷30、時薪加給時數×時薪），時薪人員國定假日照給原約定時數。`]).font = { color: { argb: 'FFB42318' } };
    const cols = ['員工', '計薪方式', '月薪／時薪', '出勤天數', '其中休息日', '實際工時', '計薪工時', '平日加班前2h', '平日加班3h起', '休息日加班', '加班費', '國定假日加給／照給', '遲到次數', '遲到分鐘', '早退次數', '早退分鐘', '異地打卡', '居家（天）', '公差（天）', '請假（小時）', '請假扣薪／給薪', '應發合計', '應扣合計', '實發金額', '備註'];
    s1.addRow(cols); head(s1);
    for (const e of p.employees) {
      const row = s1.addRow([e.name, e.pay_type_text, e.pay_amount, e.work_days, e.weekend_days, e.worked_hours, e.paid_hours, e.ot.wd1, e.ot.wd2, e.ot.rest_total, e.ot.pay, e.holiday.extra_pay + e.holiday.paid_off_pay, e.late_count, e.late_min, e.early_count, e.early_min, e.offsite_count, e.wfh_days, e.trip_days, e.leave_hours, e.leave_effect, e.gross, e.deduct_total, e.net, e.warnings.join('；')]);
      [3, 11, 12, 21, 22, 23, 24].forEach((c) => (row.getCell(c).numFmt = NT));
      row.getCell(24).font = bold;
      if (e.offsite_count) row.getCell(17).font = { color: { argb: 'FFB42318' }, bold: true };
    }
    const tsum = (f) => r2(p.employees.reduce((x, y) => x + f(y), 0));
    const tr = s1.addRow(['合計', '', '', tsum((e) => e.work_days), tsum((e) => e.weekend_days), tsum((e) => e.worked_hours), tsum((e) => e.paid_hours), tsum((e) => e.ot.wd1), tsum((e) => e.ot.wd2), tsum((e) => e.ot.rest_total), p.totals.ot_pay, p.totals.holiday_pay, '', '', '', '', '', '', '', p.totals.leave_hours, '', p.totals.gross, p.totals.deduct, p.totals.net]);
    tr.font = bold; [11, 12, 22, 23, 24].forEach((c) => (tr.getCell(c).numFmt = NT));
    [14, 9, 11, 9, 10, 10, 10, 12, 12, 11, 11, 14, 9, 9, 9, 9, 9, 9, 9, 11, 14, 12, 12, 12, 40].forEach((w, i) => (s1.getColumn(i + 1).width = w));
    s1.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }];

    const used = new Set(['薪資統整']);
    for (const e of p.employees) {
      let nm = `${e.name}`.replace(/[\[\]:*?/\\]/g, '').slice(0, 24) || `員工${e.id}`;
      let sheetName = `明細-${nm}`; let k = 2; while (used.has(sheetName)) sheetName = `明細-${nm}-${k++}`; used.add(sheetName);
      const ws = wb.addWorksheet(sheetName);
      ws.addRow([`${p.company_name}　薪資明細　${month}`]).font = { bold: true, size: 14 };
      ws.addRow([`員工：${e.name}　計薪方式：${e.pay_type_text} ${fmtMoney(e.pay_amount)}　換算時薪：${e.hourly_rate}　${p.confirmed ? `已確認 ${p.confirmed_text}` : '未確認（試算）'}`]);
      ws.addRow([`⚠ ${DISCLAIMER}`]).font = { color: { argb: 'FFB42318' } };
      ws.addRow([]);
      ws.addRow(['應發項目', '說明', '金額']); head(ws);
      e.earn.forEach((l) => { const r = ws.addRow([l.label, l.detail, l.amount]); r.getCell(3).numFmt = NT; });
      const g = ws.addRow(['應發合計', '', e.gross]); g.font = bold; g.getCell(3).numFmt = NT;
      ws.addRow([]);
      ws.addRow(['應扣項目', '說明', '金額']); head(ws);
      e.deduct.forEach((l) => { const r = ws.addRow([l.label, l.detail, l.amount]); r.getCell(3).numFmt = NT; });
      const dd = ws.addRow(['應扣合計', '', e.deduct_total]); dd.font = bold; dd.getCell(3).numFmt = NT;
      ws.addRow([]);
      const n = ws.addRow(['實發金額', '', e.net]); n.font = { bold: true, size: 13 }; n.getCell(3).numFmt = NT;
      ws.addRow([]);
      ws.addRow(['出勤摘要', '']); head(ws);
      [['出勤天數', `${e.work_days} 天（其中休息日 ${e.weekend_days} 天）`], ['實際工時／計薪工時', `${e.worked_hours}／${e.paid_hours} 小時`], ['平日加班', `前 2 小時 ${e.ot.wd1} h、第 3 小時起 ${e.ot.wd2} h`], ['休息日加班', `前 2 小時 ${e.ot.rest1} h、3～8 小時 ${e.ot.rest2} h、9 小時起 ${e.ot.rest3} h`],
        ['遲到', `${e.late_count} 次，共 ${e.late_min} 分`], ['早退', `${e.early_count} 次，共 ${e.early_min} 分`], ['異地打卡', `${e.offsite_count} 次`], ['居家上班／公差', `${e.wfh_days} 天／${e.trip_days} 天`], ['國定假日', `出勤 ${e.holiday.worked_days} 天（加給 NT$ ${NT0(e.holiday.extra_pay)}）${e.pay_type === 'hourly' ? `、照給 ${e.holiday.paid_off_days} 天 ${e.holiday.paid_off_hours} 小時（NT$ ${NT0(e.holiday.paid_off_pay)}）` : ''}`]].forEach((r) => ws.addRow(r));
      if (e.leaves.length) {
        ws.addRow([]);
        ws.addRow(['假別', '時數（小時）', '給薪', '對薪資影響', '說明']); head(ws);
        e.leaves.forEach((l) => ws.addRow([l.type_name, l.hours, l.ratio_text, l.effect_text, [l.over_cap_hours ? `超過上限 ${l.over_cap_hours} 小時不給薪` : '', l.cap_note].filter(Boolean).join('；')]));
      }
      ws.addRow([]);
      ws.addRow(['日期', '星期', '上班', '下班', '實際工時', '計薪工時', '平日加班前2h', '平日加班3h起', '休息日加班', '遲到（分）', '早退（分）', '請假', '工作型態', '異地打卡', '國定假日', '備註']); head(ws);
      e.days.forEach((d) => {
        const r = ws.addRow([d.date, d.weekday, d.first_in, d.last_out, d.worked_h, d.paid_h, d.ot1_h || '', d.ot2_h || '', r2(d.rest1_h + d.rest2_h + d.rest3_h) || '', d.late_min || '', d.early_min || '', d.leave_text, d.work_mode_text, d.offsite ? `${d.offsite} 次` : '', d.holiday || '', d.notes.join('、')]);
        if (d.weekend) r.getCell(2).font = { color: { argb: 'FF2C56B0' }, bold: true };
      });
      [26, 46, 12, 12, 10, 10, 12, 12, 11, 10, 10, 18, 10, 10, 16, 30].forEach((w, i) => (ws.getColumn(i + 1).width = w));
    }
    const fname = `薪資統整_${month}${p.confirmed ? '' : '_試算'}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${month}.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}.xlsx`);
    await wb.xlsx.write(res); res.end();
  });

  app.get('/admin/payslip', (req, res) => res.sendFile(path.join(__dirname, 'public', 'payslip.html')));
  return { computePayroll, getPayroll };
};

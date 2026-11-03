// 薪資單 PDF（伺服器端產生，使用 pdfkit＋內嵌 Noto Sans TC 字型子集，不需要瀏覽器）
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const FONT_R = fs.readFileSync(path.join(__dirname, 'fonts', 'NotoSansTC-Regular.ttf'));
const FONT_B = fs.readFileSync(path.join(__dirname, 'fonts', 'NotoSansTC-Bold.ttf'));
const NT = (n) => Math.round(n || 0).toLocaleString('en-US');
const h2 = (x) => +(+x || 0).toFixed(2);
// 奶茶／莫蘭迪三色：主色 #8F6E56、文字 #3E3833、重點色 #A06357（其餘為文字色的淡化）
const C = { text: '#3E3833', muted: '#787470', line: '#e2ddd8', soft: '#f4f0ed', brand: '#8F6E56', danger: '#A06357', ok: '#8F6E56', warn: '#A06357' };

// p：薪資統整結果（getPayroll）；e：其中一位員工；opts.password：PDF 開啟密碼（選填）
function buildPayslipPdf(p, e, opts = {}) {
  return new Promise((resolve, reject) => {
    const enc = opts.password ? { userPassword: String(opts.password), ownerPassword: require('crypto').randomBytes(16).toString('hex'), permissions: { printing: 'highResolution', copying: false, modifying: false, annotating: false } } : {};
    const [y, m] = p.month.split('-').map(Number);
    const doc = new PDFDocument({ size: 'A4', margin: 40, pdfVersion: '1.7', ...enc, info: { Title: `${p.company_name} ${y} 年 ${m} 月薪資單 ${e.name}`, Author: p.company_name, Subject: '薪資單', Creator: '員工打卡系統' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('R', FONT_R); doc.registerFont('B', FONT_B);
    const L = 40, R = 555, W = R - L;
    const txt = (s, x, yy, o = {}) => doc.font(o.bold ? 'B' : 'R').fontSize(o.size || 10).fillColor(o.color || C.text).text(String(s ?? ''), x, yy, { width: o.width, align: o.align || 'left', lineBreak: o.lineBreak !== false, lineGap: o.lineGap || 0 });
    const ensure = (need) => { if (doc.y + need > 800) { doc.addPage(); doc.y = 40; } };

    // 標題
    txt(p.company_name, L, 40, { size: 10, color: C.muted });
    txt('薪資單', L, 54, { size: 22, bold: true });
    txt(`${y} 年 ${m} 月`, L, 46, { size: 16, bold: true, width: W, align: 'right' });
    const stamp = p.confirmed ? `已確認 ${p.confirmed_text}` : '試算（未確認）';
    doc.font('B').fontSize(8.5);
    const sw = doc.widthOfString(stamp) + 14;
    doc.roundedRect(R - sw, 68, sw, 16, 4).lineWidth(0.8).strokeColor(p.confirmed ? C.ok : C.warn).stroke();
    txt(stamp, R - sw, 71.5, { size: 8.5, bold: true, color: p.confirmed ? C.ok : C.warn, width: sw, align: 'center' });
    doc.moveTo(L, 92).lineTo(R, 92).lineWidth(1.6).strokeColor(C.text).stroke();

    // 基本資料
    const meta = [
      ['員工', e.name], ['計薪方式', `${e.pay_type_text} NT$ ${NT(e.pay_amount)}${e.pay_type === 'hourly' ? '／小時' : ''}`], ['換算時薪', String(e.hourly_rate)],
      ['計薪期間', `${p.from.replace(/-/g, '/')}～${p.to.replace(/-/g, '/')}`], ['出勤天數', `${e.work_days} 天${e.weekend_days ? `（休息日 ${e.weekend_days}）` : ''}`], ['工時（計薪）', `${h2(e.worked_hours)}（${h2(e.paid_hours)}）小時`],
    ];
    const cw = W / 3;
    meta.forEach(([k, v], i) => { const x = L + (i % 3) * cw, yy = 104 + Math.floor(i / 3) * 34; txt(k, x, yy, { size: 8, color: C.muted }); txt(v, x, yy + 11, { size: 10.5, bold: true, width: cw - 8 }); });

    // 應發／應扣
    const top = 178, gap = 16, tw = (W - gap) / 2;
    const table = (x, title, lines, total, neg) => {
      let yy = top;
      doc.rect(x, yy, tw, 20).fill(C.soft);
      txt(title, x + 8, yy + 5, { size: 8.5, bold: true, color: '#3E3833' }); txt('金額', x, yy + 5, { size: 8.5, bold: true, color: '#3E3833', width: tw - 8, align: 'right' });
      yy += 20;
      const rows = lines.length ? lines : [{ label: '無', detail: '', amount: null }];
      for (const l of rows) {
        doc.font('R').fontSize(9.5); const lh = doc.heightOfString(l.label, { width: tw - 80 });
        doc.font('R').fontSize(7.5); const dh = l.detail ? doc.heightOfString(l.detail, { width: tw - 16 }) : 0;
        const rh = Math.max(20, 8 + lh + (dh ? dh + 2 : 0) + 4);
        txt(l.label, x + 8, yy + 5, { size: 9.5, width: tw - 80, color: l.amount === null ? C.muted : C.text });
        if (l.amount !== null) txt(`${neg ? '−' : ''}${NT(l.amount)}`, x, yy + 5, { size: 9.5, width: tw - 8, align: 'right' });
        if (l.detail) txt(l.detail, x + 8, yy + 7 + lh, { size: 7.5, color: '#787470', width: tw - 16 });
        yy += rh;
        doc.moveTo(x, yy).lineTo(x + tw, yy).lineWidth(0.5).strokeColor('#ebe7e3').stroke();
      }
      doc.moveTo(x, yy).lineTo(x + tw, yy).lineWidth(0.8).strokeColor('#c5bdb6').stroke();
      txt(`${title.replace('項目', '')}合計`, x + 8, yy + 6, { size: 10, bold: true });
      txt(`${neg ? '−' : ''}${NT(total)}`, x, yy + 6, { size: 10, bold: true, width: tw - 8, align: 'right' });
      return yy + 24;
    };
    const y1 = table(L, '應發項目', e.earn, e.gross, false);
    const y2 = table(L + tw + gap, '應扣項目', e.deduct, e.deduct_total, true);
    doc.y = Math.max(y1, y2) + 10;

    // 實發
    ensure(60);
    let yy = doc.y;
    doc.roundedRect(L, yy, W, 46, 8).lineWidth(1.6).strokeColor(C.text).stroke();
    txt('實發金額', L + 16, yy + 15, { size: 13, bold: true });
    txt(`NT$ ${NT(e.net)}`, L, yy + 9, { size: 22, bold: true, width: W - 16, align: 'right' });
    doc.y = yy + 60;

    // 出勤摘要
    ensure(50);
    yy = doc.y;
    const att = [['平日加班', `${h2(e.ot.weekday_total)} 小時`], ['休息日加班', `${h2(e.ot.rest_total)} 小時`], ['遲到／早退', `${e.late_count} 次 ${e.late_min} 分／${e.early_count} 次 ${e.early_min} 分`], ['異地打卡／居家／公差', `${e.offsite_count} 次／${e.wfh_days} 天／${e.trip_days} 天`]];
    const aw = (W - 24) / 4;
    att.forEach(([k, v], i) => { const x = L + i * (aw + 8); doc.roundedRect(x, yy, aw, 38, 6).fill('#f7f4f1'); txt(k, x + 8, yy + 6, { size: 7.5, color: C.muted, width: aw - 16 }); txt(v, x + 8, yy + 19, { size: 9, width: aw - 16 }); });
    doc.y = yy + 50;

    // 請假
    if (e.leaves.length) {
      ensure(30 + e.leaves.length * 20);
      yy = doc.y;
      const cols = [[L + 8, 150, 'left', '假別'], [L + 160, 80, 'right', '時數'], [L + 260, 90, 'left', '給薪'], [L + 350, W - 358, 'right', '對薪資影響']];
      doc.rect(L, yy, W, 20).fill(C.soft);
      cols.forEach(([x, w, a, t]) => txt(t, x, yy + 5, { size: 8.5, bold: true, color: '#3E3833', width: w, align: a }));
      yy += 20;
      for (const l of e.leaves) {
        const vals = [l.type_name + (l.over_cap_hours ? `（超過上限 ${l.over_cap_hours} 小時不給薪）` : ''), `${h2(l.hours)} 小時`, l.ratio_text, l.effect_text];
        cols.forEach(([x, w, a], i) => txt(vals[i], x, yy + 5, { size: 9, width: w, align: a }));
        yy += 20; doc.moveTo(L, yy).lineTo(R, yy).lineWidth(0.5).strokeColor('#ebe7e3').stroke();
      }
      doc.y = yy + 12;
    }

    // 國定假日（勞基法第 37、39 條）
    const hol = e.holiday ? [...(e.holiday.worked || []).map((x) => [x.date, x.name, `出勤 ${h2(x.worked_h)} 小時`, e.pay_type === 'monthly' ? '加給一日工資' : `加給 ${h2(x.in8_h)} 小時`]),
      ...(e.holiday.paid_off || []).map((x) => [x.date, x.name, '放假', `照給 ${h2(x.hours)} 小時`])].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .reduce((acc, r) => { const last = acc[acc.length - 1]; if (last && last[0] === r[0]) last[3] += `、${r[3]}`; else acc.push([...r]); return acc; }, []) : [];
    if (hol.length) {
      ensure(30 + hol.length * 20);
      yy = doc.y;
      const cols = [[L + 8, 70, 'left', '日期'], [L + 80, 220, 'left', '國定假日'], [L + 300, 100, 'left', '出勤'], [L + 400, W - 408, 'right', '薪資']];
      doc.rect(L, yy, W, 20).fill(C.soft);
      cols.forEach(([x, w, a, t]) => txt(t, x, yy + 5, { size: 8.5, bold: true, color: C.text, width: w, align: a }));
      yy += 20;
      for (const r of hol) {
        const vals = [r[0].slice(5).replace('-', '/'), r[1], r[2], r[3]];
        cols.forEach(([x, w, a], i) => txt(vals[i], x, yy + 5, { size: 9, width: w, align: a, lineBreak: false }));
        yy += 20; doc.moveTo(L, yy).lineTo(R, yy).lineWidth(0.5).strokeColor('#ebe7e3').stroke();
      }
      doc.y = yy + 12;
    }

    // 免責與說明
    ensure(60);
    txt(`※ ${p.disclaimer}加班費依勞基法第 24 條計算（月薪換算時薪＝月薪÷30÷8）；週六、日上班以休息日加班計；國定假日出勤 8 小時內工資加倍發給（勞基法第 39 條）。`, L, doc.y, { size: 8.5, color: C.danger, width: W, lineGap: 2 });
    doc.moveDown(0.6);
    txt('本薪資單為個人資料，請妥善保管，勿轉寄他人。如對內容有疑問，請與公司聯絡。', L, doc.y, { size: 8, color: C.muted, width: W });
    // 頁尾
    doc.page.margins.bottom = 0;
    txt(`${p.company_name}・員工打卡系統產生於 ${opts.generated_text || p.generated_text || ''}`, L, 806, { size: 7, color: '#a59d96', width: W, align: 'right', lineBreak: false });
    doc.end();
  });
}

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'employee';
const payslipFileName = (month, name) => `薪資單_${month}_${safeName(name)}.pdf`;

module.exports = { buildPayslipPdf, payslipFileName };

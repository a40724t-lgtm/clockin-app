// 由行政院人事行政總處（DGPA）「中華民國政府行政機關辦公日曆表」開放資料產生 holidays/tw-holidays.json
//
// 資料來源（政府資料開放授權條款-第1版）：
//   https://data.gov.tw/dataset/14718 ／ https://www.dgpa.gov.tw/informationlist?uid=30
//   欄位：西元日期、星期、是否放假（0 上班、2 放假）、備註
// 法源（民間企業適用）：
//   勞動基準法第 37 條：內政部所定應放假之紀念日、節日、勞動節及其他中央主管機關指定應放假日，均應休假。
//   紀念日及節日實施條例（114/05/28 公布施行）第 4、5、6、8 條：https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=D0020095
//     應放假日共 16 日：開國紀念日、和平紀念日、孔子誕辰紀念日（教師節）、國慶日、臺灣光復暨金門古寧頭大捷紀念日、行憲紀念日、
//     除夕及春節（小年夜起至正月初三，共 5 日）、兒童節、清明節、勞動節、端午節、中秋節。
//     （原住民族歲時祭儀 3 日僅適用原住民族勞工，由原民會另行公告，不在本表；請以「公司自訂假日」加入。）
//   勞動基準法施行細則第 23 條之 1：國定假日遇例假、休息日應予補假，補假期日由勞雇雙方協商排定（本表預設比照 DGPA 補假日）。
//   DGPA 的「調整放假」（彈性放假）與「補行上班」僅適用政府機關，民間企業預設不適用（本表標記為 bridge / gov_workday）。
//
// 用法：node scripts/build-holidays.js 115 116   （民國年；需可連網）
const fs = require('fs');
const path = require('path');

const DATASET = 'https://data.gov.tw/api/v2/rest/dataset/14718';
// 勞基法第 37 條適用之應放假日（DGPA 備註名稱 → 標準名稱）
const STATUTORY = {
  開國紀念日: '開國紀念日', 和平紀念日: '和平紀念日', 小年夜: '小年夜', 農曆除夕: '除夕', 除夕: '除夕', 春節: '春節',
  兒童節: '兒童節', 清明節: '清明節', 勞動節: '勞動節', 端午節: '端午節', 中秋節: '中秋節',
  '孔子誕辰紀念日/教師節': '教師節（孔子誕辰紀念日）', 教師節: '教師節（孔子誕辰紀念日）', 國慶日: '國慶日',
  臺灣光復暨金門古寧頭大捷紀念日: '臺灣光復暨金門古寧頭大捷紀念日', 行憲紀念日: '行憲紀念日',
};
const EXPECTED = 16; // 每年應有 16 個國定假日（春節 3 日、除夕、小年夜各算 1 日）

function parseCsv(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).slice(1).map((l) => l.split(',').map((x) => x.trim()))
    .map(([d, w, off, note]) => ({ date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, weekday: w, off: off === '2', note: note || '' }));
}
const isWeekend = (d) => [0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay());
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

function classify(rows, nextYearFirst) {
  const out = [];
  const statutory = rows.filter((r) => r.off && STATUTORY[r.note]);
  for (const r of rows) {
    if (r.off && STATUTORY[r.note]) {
      out.push({ date: r.date, name: STATUTORY[r.note], type: 'statutory', weekend: isWeekend(r.date) });
    } else if (r.off && r.note === '補假') {
      // 找出這個補假對應的週末國定假日（前後 10 天內，尚未被配對者）
      const used = new Set(out.filter((x) => x.type === 'makeup').map((x) => x.for_date));
      const cands = [...statutory, ...(nextYearFirst || [])].filter((h) => isWeekend(h.date) && !used.has(h.date) && Math.abs((new Date(h.date) - new Date(r.date)) / 864e5) <= 10)
        .sort((a, b) => (a.date < b.date ? -1 : 1)); // 依日期順序配對（最早未配對的週末國定假日）
      const h = cands[0];
      out.push({ date: r.date, name: h ? `${STATUTORY[h.note]}補假` : '補假', type: 'makeup', for_date: h ? h.date : null });
    } else if (r.off && !isWeekend(r.date)) {
      out.push({ date: r.date, name: r.note || '調整放假', type: 'bridge' });
    } else if (!r.off && isWeekend(r.date)) {
      out.push({ date: r.date, name: r.note || '補行上班', type: 'gov_workday' });
    }
  }
  return out;
}

(async () => {
  const years = process.argv.slice(2).map(Number);
  if (!years.length) { console.error('用法：node scripts/build-holidays.js 115 116'); process.exit(1); }
  const meta = await (await fetch(DATASET)).json();
  const dist = (meta.result || meta).distribution;
  const file = path.join(__dirname, '..', 'holidays', 'tw-holidays.json');
  const json = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { years: {} };
  const raw = {};
  for (const roc of [...years, Math.max(...years) + 1]) {
    const d = dist.find((x) => x.resourceDescription === `${roc}年中華民國政府行政機關辦公日曆表`);
    if (!d) { if (years.includes(roc)) console.warn(`找不到 ${roc} 年資料`); continue; }
    raw[roc] = { url: d.resourceDownloadUrl, rows: parseCsv(await (await fetch(d.resourceDownloadUrl)).text()) };
  }
  for (const roc of years) {
    if (!raw[roc]) continue;
    // 隔年元旦若逢週末，補假可能落在本年 12 月（例：2028/1/1 週六 → 2027/12/31 補假）；隔年資料未公布時以固定日期推算
    const ny = `${roc + 1912}-01-01`;
    const next = raw[roc + 1] ? raw[roc + 1].rows.filter((r) => r.off && STATUTORY[r.note] && r.date === ny) : [{ date: ny, note: '開國紀念日' }];
    const list = classify(raw[roc].rows, next);
    const n = list.filter((x) => x.type === 'statutory').length;
    if (n !== EXPECTED) console.warn(`⚠ ${roc + 1911} 年國定假日 ${n} 日（預期 ${EXPECTED} 日），請人工確認`);
    json.years[String(roc + 1911)] = { source: raw[roc].url, roc_year: roc, holidays: list };
    console.log(`${roc + 1911}: 國定假日 ${n}、補假 ${list.filter((x) => x.type === 'makeup').length}、調整放假 ${list.filter((x) => x.type === 'bridge').length}、補行上班 ${list.filter((x) => x.type === 'gov_workday').length}`);
  }
  json.about = {
    title: '臺灣國定假日（勞基法第 37 條）與補假',
    dataset: 'https://data.gov.tw/dataset/14718',
    publisher: '行政院人事行政總處 政府行政機關辦公日曆表',
    law: ['勞動基準法第 37 條、第 39 條', '紀念日及節日實施條例（114/05/28 公布施行）第 4、6、8 條', '勞動基準法施行細則第 23 條之 1（補假）'],
    note: 'statutory＝勞基法國定假日；makeup＝國定假日遇週末之補假（預設比照 DGPA）；bridge＝政府調整放假（民間預設不放）；gov_workday＝政府補行上班日（民間不適用）。',
    generated_at: new Date().toISOString().slice(0, 10),
  };
  json.years = Object.fromEntries(Object.entries(json.years).sort());
  fs.writeFileSync(file, JSON.stringify(json, null, 1) + '\n');
})();

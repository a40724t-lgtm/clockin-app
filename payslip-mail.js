// 薪資單 PDF 下載與 Email 寄送（SMTP 設定、寄送紀錄、員工自行下載）
const nodemailer = require('nodemailer');
const { buildPayslipPdf, payslipFileName } = require('./payslip-pdf');
const { makeZip } = require('./zip');
const PII = require('./pii');

const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const monthText = (m) => { const [y, mm] = m.split('-').map(Number); return `${y} 年 ${mm} 月`; };
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
// RFC 2606 保留給測試／示範的網域：系統不會真的寄出
const isDemoEmail = (e) => /@(.+\.)?(example\.(com|net|org)|[^@]*\.(example|test|invalid|localhost))$/i.test(String(e || '').trim());
// PDF 密碼模式：id 身分證字號（預設）／fixed 固定密碼／none 不加密（舊的 pin 模式已移除，啟動時自動改為 id）
const PW_MODES = ['none', 'id', 'fixed'];
const NO_ID_NOTE = '尚未登錄身分證字號，無法加密薪資單，請到「員工管理」補上';
const PASS_TEXT = {
  none: '',
  id: '為保護您的個人資料，PDF 已加密，開啟密碼為您的身分證字號（英文大寫，例如 A123456789）。',
  fixed: '為保護您的個人資料，PDF 已加密，開啟密碼請洽公司管理員。',
};

module.exports = function registerPayslipMail(ctx) {
  const { app, db, getSetting, setSetting, getSettings, audit, fmtDateTime, getPayroll, requireEmployee, DEFAULT_MAIL_BODY } = ctx;
  const envMode = () => !!process.env.SMTP_HOST;

  // ---------- 設定 ----------
  function smtpConfig() {
    if (envMode()) {
      const port = Number(process.env.SMTP_PORT || 465);
      return {
        source: 'env', host: process.env.SMTP_HOST, port,
        secure: process.env.SMTP_SECURE ? /^(1|true|yes|ssl)$/i.test(process.env.SMTP_SECURE) : port === 465,
        user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '',
        from_name: process.env.SMTP_FROM_NAME || getSetting('smtp_from_name') || '',
        from_addr: process.env.SMTP_FROM || getSetting('smtp_from_addr') || process.env.SMTP_USER || '',
      };
    }
    return {
      source: 'settings', host: getSetting('smtp_host') || '', port: Number(getSetting('smtp_port') || 465), secure: getSetting('smtp_secure') !== '0',
      user: getSetting('smtp_user') || '', pass: getSetting('smtp_pass') || '',
      from_name: getSetting('smtp_from_name') || '', from_addr: getSetting('smtp_from_addr') || getSetting('smtp_user') || '',
    };
  }
  function mailSettings() {
    const mode = PW_MODES.includes(getSetting('pdf_password_mode')) ? getSetting('pdf_password_mode') : 'id';
    return { subject: getSetting('mail_subject') || '【{公司}】{月份} 薪資單', body: getSetting('mail_body') || DEFAULT_MAIL_BODY, pdf_password_mode: mode, pdf_password_fixed: getSetting('pdf_password_fixed') || '' };
  }
  function publicSmtp() {
    const c = smtpConfig(), m = mailSettings();
    return {
      env: c.source === 'env', host: c.host, port: c.port, secure: c.secure, user: c.user, has_password: !!c.pass,
      from_name: c.from_name, from_addr: c.from_addr, configured: !!(c.host && c.from_addr),
      subject: m.subject, body: m.body, default_body: DEFAULT_MAIL_BODY, pdf_password_mode: m.pdf_password_mode, has_fixed_password: !!m.pdf_password_fixed,
      company_name: getSettings().company_name,
    };
  }
  const makeTransport = (c, extra = {}) => nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure, auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    connectionTimeout: 12000, greetingTimeout: 10000, socketTimeout: 30000, ...extra,
  });
  const transportFor = (c) => makeTransport(c);
  function friendlyError(err) {
    const code = err && (err.code || ''), msg = String((err && err.message) || err || '');
    if (code === 'EAUTH' || /auth|535|534/i.test(msg)) return `登入失敗：帳號或密碼錯誤（Gmail 請使用「應用程式密碼」，不是一般登入密碼）｜${msg}`;
    if (['ETIMEDOUT', 'ECONNREFUSED', 'ESOCKET', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code) || /timeout|ECONN|unreach/i.test(msg)) return `無法連線到 SMTP 伺服器（可能是主機、連接埠錯誤，或主機商封鎖對外寄信連接埠）｜${msg}`;
    if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(msg)) return `找不到 SMTP 伺服器，請檢查主機名稱｜${msg}`;
    if (/wrong version number|ssl|tls/i.test(msg)) return `加密方式不符：465 請開啟 SSL/TLS，587 請關閉（改用 STARTTLS）｜${msg}`;
    return msg || '寄送失敗';
  }
  const fill = (tpl, vars) => String(tpl || '').replace(/\{(姓名|月份|公司|密碼說明|實發金額)\}/g, (_, k) => vars[k] ?? '');
  const fromHeader = (c) => (c.from_name ? { name: c.from_name, address: c.from_addr } : c.from_addr);

  const nationalIdOf = (empId) => {
    const row = db.prepare('SELECT national_id_enc FROM employees WHERE id=?').get(empId);
    const v = row && row.national_id_enc ? PII.tryDecrypt(row.national_id_enc) : null;
    return v && PII.validateNationalId(v).ok ? v.toUpperCase() : null;
  };
  // 回傳 PDF 開啟密碼；需要加密卻沒有密碼時丟出錯誤（絕不退回用 PIN 或不加密）
  function pdfPassword(empId) {
    const m = mailSettings();
    if (m.pdf_password_mode === 'id') {
      const v = nationalIdOf(empId);
      if (!v) { const err = new Error(NO_ID_NOTE); err.code = 'NO_NATIONAL_ID'; throw err; }
      return v;
    }
    if (m.pdf_password_mode === 'fixed') {
      if (!m.pdf_password_fixed) { const err = new Error('尚未設定 PDF 固定密碼'); err.code = 'NO_FIXED_PASSWORD'; throw err; }
      return m.pdf_password_fixed;
    }
    return null;
  }
  async function pdfFor(p, e, protect) {
    return buildPayslipPdf(p, e, { password: protect ? pdfPassword(e.id) : null, generated_text: fmtDateTime(Date.now()) });
  }
  function lastSends(month) {
    const rows = db.prepare('SELECT * FROM payslip_sends WHERE month=? ORDER BY id').all(month);
    const by = {};
    for (const r of rows) {
      const cur = by[r.employee_id] || (by[r.employee_id] = { employee_id: r.employee_id, sent_count: 0, last: null, last_sent: null, history: [] });
      const item = { id: r.id, email: r.email, status: r.status, error: r.error, at: r.created_at, at_text: fmtDateTime(r.created_at) };
      cur.history.push(item); cur.last = item;
      if (r.status === 'sent') { cur.sent_count++; cur.last_sent = item; }
    }
    return by;
  }
  const logSend = (month, empId, email, status, error = '', messageId = '') =>
    db.prepare('INSERT INTO payslip_sends(month,employee_id,email,status,error,message_id,created_at) VALUES(?,?,?,?,?,?,?)').run(month, empId, email || '', status, String(error || '').slice(0, 500), messageId || '', Date.now());

  // ---------- SMTP 設定 API ----------
  app.get('/api/admin/smtp', (req, res) => res.json(publicSmtp()));
  app.put('/api/admin/smtp', (req, res) => {
    const b = req.body || {};
    const port = Number(b.port);
    const subject = String(b.subject ?? '').trim(), body = String(b.body ?? '');
    const mode = PW_MODES.includes(b.pdf_password_mode) ? b.pdf_password_mode : 'id';
    const fromAddr = String(b.from_addr || '').trim();
    if (!envMode()) {
      if (b.host && !/^[a-z0-9.-]+$/i.test(String(b.host).trim())) return res.status(400).json({ error: 'SMTP 主機名稱格式錯誤' });
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: '連接埠必須是 1～65535 的數字' });
    }
    if (fromAddr && !EMAIL_RE.test(fromAddr)) return res.status(400).json({ error: '寄件者 Email 格式錯誤' });
    if (!subject) return res.status(400).json({ error: '請填寫信件主旨' });
    if (subject.length > 200 || body.length > 5000) return res.status(400).json({ error: '主旨或內文太長' });
    if (mode === 'fixed' && !String(b.pdf_password_fixed || '').trim() && !getSetting('pdf_password_fixed')) return res.status(400).json({ error: '請設定 PDF 固定密碼' });
    if (!envMode()) {
      setSetting('smtp_host', String(b.host || '').trim()); setSetting('smtp_port', String(port)); setSetting('smtp_secure', b.secure ? '1' : '0');
      setSetting('smtp_user', String(b.user || '').trim());
      if (b.clear_password) setSetting('smtp_pass', '');
      else if (typeof b.password === 'string' && b.password !== '') {
        // Gmail 應用程式密碼常以「abcd efgh ijkl mnop」顯示，自動去掉空白
        const pw = b.password.trim();
        setSetting('smtp_pass', /^[a-z]{4}( [a-z]{4}){3}$/i.test(pw) ? pw.replace(/ /g, '') : b.password);
      }
    }
    setSetting('smtp_from_name', String(b.from_name || '').trim().slice(0, 60)); setSetting('smtp_from_addr', fromAddr);
    setSetting('mail_subject', subject); setSetting('mail_body', body); setSetting('pdf_password_mode', mode);
    if (mode === 'fixed' && String(b.pdf_password_fixed || '').trim()) setSetting('pdf_password_fixed', String(b.pdf_password_fixed).trim());
    audit('修改寄信設定', `SMTP ${envMode() ? '（使用環境變數）' : `${String(b.host || '').trim() || '未設定'}:${port}${b.secure ? ' SSL' : ''}`}｜寄件者 ${fromAddr || '未設定'}｜PDF 密碼：${{ none: '不加密', id: '員工身分證字號', fixed: '固定密碼' }[mode]}`);
    res.json({ ok: true, smtp: publicSmtp() });
  });
  // 測試連線：只做 SMTP 連線＋（若有帳密）登入檢查，不寄出任何信件。可帶入尚未儲存的表單值；auth=false 只測試連接埠
  app.post('/api/admin/smtp/verify', async (req, res) => {
    const b = req.body || {}, saved = smtpConfig();
    const c = envMode() || !b.host ? { ...saved } : { host: String(b.host).trim(), port: Number(b.port) || 465, secure: !!b.secure, user: String(b.user || '').trim(), pass: b.password ? String(b.password) : saved.pass };
    if (!c.host) return res.status(400).json({ error: '請先填寫 SMTP 主機' });
    if (b.auth === false) c.user = '';
    const t0 = Date.now();
    const tr = makeTransport(c);
    try {
      await tr.verify();
      res.json({ ok: true, ms: Date.now() - t0, host: c.host, port: c.port, secure: c.secure, auth: !!c.user, message: c.user ? '連線與登入成功，可以寄信' : '已成功連線到 SMTP 伺服器（未登入）' });
    } catch (e) {
      // 未提供帳密時，伺服器回覆「需要登入」代表連接埠是通的
      const needAuth = !c.user && /auth|530|login/i.test(String(e.message));
      res.json({ ok: needAuth, ms: Date.now() - t0, host: c.host, port: c.port, secure: c.secure, auth: !!c.user, code: e.code || '', message: needAuth ? '已成功連線到 SMTP 伺服器（尚未登入）' : friendlyError(e) });
    } finally { tr.close(); }
  });
  app.post('/api/admin/smtp/test', async (req, res) => {
    const to = String(req.body?.to || '').trim();
    if (!EMAIL_RE.test(to)) return res.status(400).json({ error: '請輸入正確的收件 Email' });
    if (isDemoEmail(to)) return res.status(400).json({ error: '這是示範用的保留網域（例如 example.com），無法收信' });
    const c = smtpConfig();
    if (!c.host || !c.from_addr) return res.status(400).json({ error: '請先完成 SMTP 主機與寄件者設定並儲存' });
    const company = getSettings().company_name;
    const tr = transportFor(c);
    try {
      const info = await tr.sendMail({ from: fromHeader(c), to, subject: `【${company}】測試信：薪資單寄送設定`, text: `這是一封測試信。\n\n收到這封信，代表打卡系統的寄信設定正確，可以寄送薪資單。\n\n寄件伺服器：${c.host}:${c.port}\n${company}` });
      audit('寄送測試信', `寄送測試信到 ${to}：成功`);
      res.json({ ok: true, message_id: info.messageId, message: `測試信已寄出到 ${to}` });
    } catch (e) {
      audit('寄送測試信', `寄送測試信到 ${to}：失敗（${String(e.message).slice(0, 120)}）`);
      res.status(502).json({ error: friendlyError(e) });
    } finally { tr.close && tr.close(); }
  });

  // ---------- 薪資單 PDF ----------
  app.get('/api/admin/payroll/:month/payslip/:id.pdf', async (req, res) => {
    const month = req.params.month;
    if (!isMonth(month)) return res.status(400).json({ error: '月份格式錯誤' });
    const p = getPayroll(month);
    const e = p.employees.find((x) => x.id === Number(req.params.id));
    if (!e) return res.status(404).json({ error: '這位員工本月沒有薪資資料' });
    // 管理員下載的檔案不加密（公司留存用）；寄給員工與員工自行下載的檔案依設定加密
    let buf;
    try { buf = await pdfFor(p, e, req.query.protect === '1'); } catch (err) { if (err.code) return res.status(409).json({ error: `${e.name}：${err.message}` }); throw err; }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="payslip-${month}-${e.id}.pdf"; filename*=UTF-8''${encodeURIComponent(payslipFileName(month, e.name))}`);
    res.end(buf);
  });
  app.get('/api/admin/payroll/:month/payslips.zip', async (req, res) => {
    const month = req.params.month;
    if (!isMonth(month)) return res.status(400).json({ error: '月份格式錯誤' });
    const p = getPayroll(month);
    if (!p.employees.length) return res.status(404).json({ error: '這個月份沒有薪資資料' });
    const files = [];
    for (const e of p.employees) files.push({ name: payslipFileName(month, e.name), data: await pdfFor(p, e, false) });
    const fname = `薪資單_${month}${p.confirmed ? '' : '_試算'}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="payslips-${month}.zip"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.end(makeZip(files));
  });

  // ---------- 寄送 ----------
  function recipients(month, p) {
    const sends = lastSends(month);
    const idMode = mailSettings().pdf_password_mode === 'id';
    return p.employees.map((e) => {
      const row = db.prepare('SELECT email, active FROM employees WHERE id=?').get(e.id) || {};
      const email = String(row.email || '').trim();
      const s = sends[e.id];
      let state = 'ready', note = '';
      const noId = idMode && !nationalIdOf(e.id);
      if (!email) { state = 'no_email'; note = '未填 Email，請到「員工管理」補上'; }
      else if (!EMAIL_RE.test(email)) { state = 'bad_email'; note = 'Email 格式錯誤'; }
      else if (isDemoEmail(email)) { state = 'demo'; note = '示範用保留網域，不會寄出'; }
      if (noId && (state === 'ready' || state === 'demo')) { state = 'no_id'; note = NO_ID_NOTE; }
      return { id: e.id, name: e.name, is_sample: !!e.is_sample, net: e.net, email, state, note, no_national_id: noId, sent_count: s ? s.sent_count : 0, last_sent: s ? s.last_sent : null, last: s ? s.last : null };
    });
  }
  app.get('/api/admin/payroll/:month/sends', (req, res) => {
    const month = req.params.month;
    if (!isMonth(month)) return res.status(400).json({ error: '月份格式錯誤' });
    const p = getPayroll(month);
    const c = smtpConfig(), m = mailSettings();
    res.json({ month, confirmed: !!p.confirmed, smtp: { configured: !!(c.host && c.from_addr), host: c.host, port: c.port, from: c.from_name ? `${c.from_name} <${c.from_addr}>` : c.from_addr, env: c.source === 'env' }, subject: fill(m.subject, { 姓名: '（員工姓名）', 月份: monthText(month), 公司: p.company_name }), pdf_password_mode: m.pdf_password_mode, recipients: recipients(month, p) });
  });
  let sending = false;
  app.post('/api/admin/payroll/:month/send', async (req, res) => {
    const month = req.params.month;
    if (!isMonth(month)) return res.status(400).json({ error: '月份格式錯誤' });
    const p = getPayroll(month);
    if (!p.confirmed) return res.status(409).json({ error: '這個月份尚未確認，請先按「確認本月薪資」再寄送' });
    const c = smtpConfig();
    if (!c.host || !c.from_addr) return res.status(400).json({ error: '尚未完成寄信設定，請到「薪資設定」填寫 SMTP 與寄件者' });
    const ids = Array.isArray(req.body?.employee_ids) ? req.body.employee_ids.map(Number) : [];
    if (!ids.length) return res.status(400).json({ error: '請選擇要寄送的員工' });
    const all = recipients(month, p);
    const list = ids.map((id) => all.find((r) => r.id === id)).filter(Boolean);
    if (list.length !== ids.length) return res.status(400).json({ error: '有員工不在本月薪資名單中' });
    const dup = list.filter((r) => r.sent_count > 0);
    if (dup.length && !req.body.force) return res.status(409).json({ error: `${dup.map((r) => r.name).join('、')} 已經寄過本月薪資單，如要重寄請勾選「重新寄送」`, already: dup.map((r) => ({ id: r.id, name: r.name, at: r.last_sent.at_text })) });
    if (sending) return res.status(429).json({ error: '正在寄送中，請稍候再試' });
    sending = true;
    const m = mailSettings(), results = [];
    const tr = transportFor(c);
    try {
      for (const r of list) {
        if (r.state !== 'ready') { logSend(month, r.id, r.email, 'skipped', r.note); results.push({ id: r.id, name: r.name, email: r.email, status: 'skipped', error: r.note }); continue; }
        const e = p.employees.find((x) => x.id === r.id);
        try {
          const pdf = await pdfFor(p, e, true);
          const vars = { 姓名: e.name, 月份: monthText(month), 公司: p.company_name, 密碼說明: PASS_TEXT[m.pdf_password_mode] || '', 實發金額: `NT$ ${Math.round(e.net).toLocaleString('en-US')}` };
          const info = await tr.sendMail({
            from: fromHeader(c), to: { name: e.name, address: r.email }, subject: fill(m.subject, vars),
            text: fill(m.body, vars).replace(/\n{3,}/g, '\n\n'),
            attachments: [{ filename: payslipFileName(month, e.name), content: pdf, contentType: 'application/pdf' }],
          });
          logSend(month, r.id, r.email, 'sent', '', info.messageId);
          results.push({ id: r.id, name: r.name, email: r.email, status: 'sent' });
        } catch (err) {
          const msg = friendlyError(err);
          logSend(month, r.id, r.email, 'failed', msg);
          results.push({ id: r.id, name: r.name, email: r.email, status: 'failed', error: msg });
          if (['EAUTH', 'ETIMEDOUT', 'ECONNREFUSED', 'EDNS', 'ESOCKET'].includes(err.code)) {
            // 連線或登入失敗時，後面的也不會成功：停止並記錄
            for (const rest of list.slice(list.indexOf(r) + 1)) { logSend(month, rest.id, rest.email, 'failed', '前一封寄送失敗，已停止'); results.push({ id: rest.id, name: rest.name, email: rest.email, status: 'failed', error: '前一封寄送失敗，已停止' }); }
            break;
          }
        }
      }
    } finally { sending = false; tr.close && tr.close(); }
    const n = (s) => results.filter((x) => x.status === s).length;
    audit('寄送薪資單', `${month} 薪資單：寄出 ${n('sent')} 封${n('failed') ? `，失敗 ${n('failed')} 封` : ''}${n('skipped') ? `，略過 ${n('skipped')} 位` : ''}｜${results.map((x) => `${x.name}${{ sent: '✓', failed: '✗', skipped: '（略過）' }[x.status]}`).join('、')}`);
    res.json({ ok: true, sent: n('sent'), failed: n('failed'), skipped: n('skipped'), results });
  });

  // ---------- 員工：我的薪資單 ----------
  app.get('/api/payslips', requireEmployee, (req, res) => {
    const rows = db.prepare('SELECT month, confirmed_at, snapshot FROM payroll_months ORDER BY month DESC').all();
    const list = [];
    for (const r of rows) {
      const e = JSON.parse(r.snapshot).employees.find((x) => x.id === req.employee.id);
      if (e) list.push({ month: r.month, label: monthText(r.month), net: e.net, confirmed_text: fmtDateTime(r.confirmed_at) });
    }
    res.json({ list, protected: mailSettings().pdf_password_mode !== 'none', password_hint: { none: '', id: '開啟密碼為您的身分證字號（英文大寫）', fixed: '開啟密碼請洽管理員' }[mailSettings().pdf_password_mode] });
  });
  app.get('/api/payslips/:month.pdf', requireEmployee, async (req, res) => {
    const month = req.params.month;
    if (!isMonth(month)) return res.status(400).json({ error: '月份格式錯誤' });
    const row = db.prepare('SELECT * FROM payroll_months WHERE month=?').get(month);
    if (!row) return res.status(404).json({ error: '這個月份的薪資尚未確認' });
    const p = getPayroll(month);
    const e = p.employees.find((x) => x.id === req.employee.id);
    if (!e) return res.status(404).json({ error: '找不到您這個月的薪資單' });
    let buf;
    try { buf = await pdfFor(p, e, true); } catch (err) { if (err.code) return res.status(409).json({ error: err.code === 'NO_NATIONAL_ID' ? '公司尚未登錄您的身分證字號，無法產生加密薪資單，請聯絡管理員' : err.message }); throw err; }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="payslip-${month}.pdf"; filename*=UTF-8''${encodeURIComponent(payslipFileName(month, e.name))}`);
    res.end(buf);
  });

  return { smtpConfig, isDemoEmail, EMAIL_RE };
};

// 打卡地點限制：公司網路（IP 白名單）與公司位置（GPS 距離）
const net = require('net');

// 去掉 IPv4-mapped IPv6 前綴（::ffff:1.2.3.4 → 1.2.3.4）
function normalizeIp(ip) {
  if (!ip) return '';
  ip = String(ip).trim();
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIPv4(ip.slice(7))) return ip.slice(7);
  return ip;
}

// 解析白名單：每行一個 IP 或 CIDR，# 後為註解
function parseAllowlist(text) {
  const entries = [], errors = [];
  String(text || '').split(/[\n,]+/).forEach((raw) => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const [addr, bits] = line.split('/');
    const ip = normalizeIp(addr);
    const ver = net.isIP(ip);
    if (!ver) return errors.push(line);
    if (bits !== undefined) {
      const n = Number(bits);
      const max = ver === 4 ? 32 : 128;
      if (!/^\d+$/.test(bits) || n < 0 || n > max) return errors.push(line);
      entries.push({ ip, prefix: n, ver });
    } else entries.push({ ip, prefix: null, ver });
  });
  return { entries, errors };
}

function ipAllowed(ip, allowlistText) {
  ip = normalizeIp(ip);
  const ver = net.isIP(ip);
  if (!ver) return false;
  const bl = new net.BlockList();
  for (const e of parseAllowlist(allowlistText).entries) {
    const type = e.ver === 4 ? 'ipv4' : 'ipv6';
    if (e.prefix === null) bl.addAddress(e.ip, type);
    else bl.addSubnet(e.ip, e.prefix, type);
  }
  return bl.check(ip, ver === 4 ? 'ipv4' : 'ipv6');
}

// 建議加入白名單的寫法：IPv4 用單一位址；IPv6 位址常會輪替，用 /64 網段
function suggestEntry(ip) {
  ip = normalizeIp(ip);
  if (net.isIPv4(ip) || isPrivateIp(ip)) return ip;
  if (net.isIPv6(ip)) {
    // 展開成 8 組再取前 4 組
    const [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined && tail ? tail.split(':') : [];
    const full = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':').replace(/(:0)+$/, '') + '::/64';
  }
  return ip;
}

function isPrivateIp(ip) {
  ip = normalizeIp(ip);
  const bl = new net.BlockList();
  ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10'].forEach((c) => { const [a, b] = c.split('/'); bl.addSubnet(a, Number(b), 'ipv4'); });
  bl.addSubnet('fc00::', 7, 'ipv6'); bl.addSubnet('fe80::', 10, 'ipv6'); bl.addAddress('::1', 'ipv6');
  const v = net.isIP(ip);
  return v ? bl.check(ip, v === 4 ? 'ipv4' : 'ipv6') : false;
}

// 兩點距離（公尺），haversine 公式
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${Math.round(m)} 公尺`);


// ---------- 取得員工真實 IP（經過 Cloudflare / 負載平衡器等多層代理時） ----------
// Cloudflare 對外公布的邊緣節點網段（https://www.cloudflare.com/ips/）
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
];
const cfList = new net.BlockList();
CLOUDFLARE_RANGES.forEach((c) => { const [a, b] = c.split('/'); cfList.addSubnet(a, Number(b), net.isIPv4(a) ? 'ipv4' : 'ipv6'); });
function isCloudflareIp(ip) {
  ip = normalizeIp(ip);
  const v = net.isIP(ip);
  return v ? cfList.check(ip, v === 4 ? 'ipv4' : 'ipv6') : false;
}

const firstHeader = (h) => normalizeIp(String(Array.isArray(h) ? h[0] : h || '').split(',')[0]);
// X-Forwarded-For 中最左邊（最接近使用者）的公開 IP
function leftmostPublicXff(xff) {
  const list = String(Array.isArray(xff) ? xff.join(',') : xff || '').split(',').map(normalizeIp).filter((x) => net.isIP(x));
  return list.find((x) => !isPrivateIp(x)) || '';
}

// mode（環境變數 CLIENT_IP_HEADER）：
//   auto（預設）— 連線來自 Cloudflare 時，依序用 CF-Connecting-IP → True-Client-IP → X-Forwarded-For 最左邊的公開 IP；
//                 否則用 Express 依 TRUST_PROXY 算出的 req.ip（避免沒有 Cloudflare 時被員工偽造標頭繞過 WiFi 檢查）
//   none / req.ip — 一律用 req.ip
//   x-forwarded-for — X-Forwarded-For 最左邊的公開 IP
//   其他任何標頭名稱（如 cf-connecting-ip、true-client-ip、x-real-ip）— 一律讀該標頭
// 回傳 { ip, source }
function resolveClientIp(headers, reqIp, mode) {
  headers = headers || {};
  reqIp = normalizeIp(reqIp);
  mode = String(mode || 'auto').trim().toLowerCase();
  const valid = (x) => (net.isIP(x) ? x : '');
  if (mode === 'none' || mode === 'req.ip') return { ip: reqIp, source: 'req.ip' };
  if (mode === 'x-forwarded-for') {
    const x = leftmostPublicXff(headers['x-forwarded-for']);
    return x ? { ip: x, source: 'x-forwarded-for' } : { ip: reqIp, source: 'req.ip' };
  }
  if (mode !== 'auto') {
    const x = valid(firstHeader(headers[mode]));
    return x ? { ip: x, source: mode } : { ip: reqIp, source: 'req.ip' };
  }
  // auto：只有在連線確實經過 Cloudflare 時才相信這些標頭
  if (isCloudflareIp(reqIp)) {
    for (const h of ['cf-connecting-ip', 'true-client-ip']) {
      const x = valid(firstHeader(headers[h]));
      if (x) return { ip: x, source: h };
    }
    const x = leftmostPublicXff(headers['x-forwarded-for']);
    if (x && !isCloudflareIp(x)) return { ip: x, source: 'x-forwarded-for' };
  }
  return { ip: reqIp, source: 'req.ip' };
}

module.exports = { resolveClientIp, isCloudflareIp, leftmostPublicXff, normalizeIp, parseAllowlist, ipAllowed, suggestEntry, isPrivateIp, haversine, fmtDist };

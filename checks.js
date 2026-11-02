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

module.exports = { normalizeIp, parseAllowlist, ipAllowed, suggestEntry, isPrivateIp, haversine, fmtDist };

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = 3000;
const NORD_CACHE_PATH = path.join(os.homedir(), 'AppData', 'Local', 'NordVPN', 'servers_v2.json');

// وقتی برنامه به صورت exe پکیج میشه، __dirname داخل app.asar هست و نمیشه
// فایل نوشت. userData (AppData\\Roaming\\NordVPN Dashboard) همیشه writable هست.
const _electron = (() => { try { return require('electron'); } catch { return {}; } })();
const _app = _electron.app || null;

const USER_DATA_DIR = (() => {
  if (_app) {
    try { return _app.getPath('userData'); } catch {}
  }
  return path.join(os.homedir(), 'AppData', 'Roaming', 'NordVPN Dashboard');
})();

try { if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true }); } catch {}

const OWN_CACHE_FILE = path.join(USER_DATA_DIR, 'servers_cache.json');
const CACHE_TTL_MS   = 12 * 60 * 60 * 1000;

// مسیر فایل HTML — در حالت پکیج‌شده داخل resources/app قرار داره
const HTML_FILE = (() => {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'app', 'nordvpn_dashboard.html') : null,
    path.join(__dirname, 'nordvpn_dashboard.html'),
  ].filter(Boolean);
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } })
    || candidates[candidates.length - 1];
})();

// ==================== Technology map ====================
const TECH_ID_MAP = {
  3:  'OpenVPN UDP',
  5:  'OpenVPN TCP',
  35: 'WireGuard',
  51: 'NordWhisper',
  11: 'OpenVPN UDP (obfusc.)',
  13: 'OpenVPN TCP (obfusc.)',
  21: 'HTTP Proxy',
  23: 'SOCKS5 Proxy',
  42: 'Dedicated IP',
  45: 'Onion',
};
const GROUP_P2P_IDS = new Set([15]);

// ==================== Station IP map ====================
const stationMap = {}; // hostname -> real IP

function loadStationMap() {
  try {
    const raw = fs.readFileSync(NORD_CACHE_PATH, 'utf8');
    const json = JSON.parse(raw);
    const servers = json.Servers || json.servers || [];
    let count = 0;
    servers.forEach(s => {
      const host = s.HostName || s.hostname;
      const ip   = s.Station  || s.station;
      if (host && ip) { stationMap[host] = ip; count++; }
    });
    console.log(`✓ station map: ${count} سرور`);
  } catch (e) {
    console.error('station map error:', e.message);
  }
}

// ==================== Ping & port testing ====================

// ICMP ping از طریق ping.exe
function icmpPing(target, timeoutMs = 3000) {
  return new Promise((resolve) => {
    // مسیر کامل ping.exe برای کار کردن در محیط پکیج‌شده Electron
    const pingExe = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe')
      : 'ping';
    const pingCmd = process.platform === 'win32'
      ? `"${pingExe}" -n 1 -w ${timeoutMs} ${target}`
      : `ping -c 1 -W ${Math.ceil(timeoutMs/1000)} ${target}`;
    exec(pingCmd,
      { timeout: timeoutMs + 2000 },
      (err, stdout) => {
        if (!stdout) return resolve(null);
        const m = stdout.match(/Average\s*=\s*(\d+)ms/i)
                || stdout.match(/[Tt]ime[<=](\d+)ms/);
        if (m) return resolve(parseInt(m[1]));
        if (/TTL=/i.test(stdout)) return resolve(1);
        resolve(null);
      });
  });
}

// TCP connect — مستقیم‌ترین تست دسترسی
function tcpTest(ip, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const net = require('net');
    const s = new net.Socket();
    let done = false;
    const start = Date.now();
    const finish = (ms) => { if (done) return; done = true; s.destroy(); resolve(ms); };
    s.setTimeout(timeoutMs);
    s.connect(port, ip, () => finish(Date.now() - start));
    s.on('timeout', () => finish(null));
    s.on('error', () => finish(null));
  });
}

// ==================== VPN deep probe ====================
// مشکل در ایران: ISP با DPI پورت 443 رو TCP SYN قبول میکنه ولی TLS دیتا رو drop میکنه.
// راه‌حل: TLS handshake کامل با Node's tls module — اگه TLS ServerHello اومد = سرور accessible.
// NordVPN روی پورت 443 یک TLS listener داره (OpenVPN TCP / NordWhisper).
// اگه DPI باشه، tls.connect یا timeout میشه یا ECONNRESET قبل از ServerHello.

function tlsProbe(ip, port, hostname, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const tls = require('tls');
    const start = Date.now();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok ? Date.now() - start : null);
    };

    const sock = tls.connect({
      host: ip,
      port,
      servername: hostname,          // SNI — مهمه برای NordVPN
      rejectUnauthorized: false,     // cert خودشونه، verify نمیکنیم
      timeout: timeoutMs,
    });

    // TLS handshake کامل شد = سرور واقعاً accessible
    sock.on('secureConnect', () => finish(true));

    // هر error قبل از secureConnect
    sock.on('error', () => finish(false));
    sock.on('timeout', () => finish(false));
  });
}

// UDP probe برای WireGuard (پورت 51820)
// WireGuard handshake اول میفرسته، اگه جواب اومد = accessible
function udpProbe(ip, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const dgram = require('dgram');
    const start = Date.now();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { client.close(); } catch {}
      resolve(ok ? Date.now() - start : null);
    };

    const client = dgram.createSocket('udp4');

    // WireGuard handshake initiation (4 بایت اول: type=1, reserved=0,0,0)
    const wgInit = Buffer.from([0x01, 0x00, 0x00, 0x00, ...Array(144).fill(0)]);

    client.on('message', () => finish(true));   // هر جوابی = accessible
    client.on('error', () => finish(false));

    setTimeout(() => finish(false), timeoutMs);

    client.send(wgInit, port, ip, (err) => {
      if (err) finish(false);
    });
  });
}

// پینگ + تشخیص واقعی accessibility برای ایران — نسخه موازی (سریع‌تر)
// همه probe‌ها همزمان اجرا میشن؛ اولین جواب مثبت برنده‌ست.
// اگه هیچ VPN probe جواب نداد، TCP SYN و ICMP رو هم چک میکنیم.
async function bestPing(hostname) {
  const realIP = stationMap[hostname] || hostname;

  // ---- مرحله ۱: همه VPN probe‌ها موازی ----
  // هر probe یا {ms, method} برمیگردونه یا null
  const vpnProbes = [
    tlsProbe(realIP, 443,   hostname, 3000).then(ms => ms !== null ? { ms, method: 'tls443',   vpnAccessible: true } : null),
    tlsProbe(realIP, 80,    hostname, 3000).then(ms => ms !== null ? { ms, method: 'tls80',    vpnAccessible: true } : null),
    tlsProbe(realIP, 1194,  hostname, 3000).then(ms => ms !== null ? { ms, method: 'tls1194',  vpnAccessible: true } : null),
    udpProbe(realIP, 51820,          2000).then(ms => ms !== null ? { ms, method: 'wg51820',  vpnAccessible: true } : null),
  ];

  // race که null رو skip کنه — اولین non-null جواب رو برمیگردونه
  const vpnResult = await Promise.all(vpnProbes).then(results => results.find(r => r !== null) || null);
  if (vpnResult) return vpnResult;

  // ---- مرحله ۲: TCP SYN — DPI detection ----
  const tcp443 = await tcpTest(realIP, 443, 1500);
  if (tcp443 !== null) return { ms: tcp443, method: 'tcp443-syn', vpnAccessible: false };

  // ---- مرحله ۳: ICMP — IP زنده‌ست ولی VPN بلاکه ----
  const icmp = await icmpPing(realIP, 2000);
  if (icmp !== null) return { ms: icmp, method: 'icmp', vpnAccessible: false };

  return { ms: null, method: null, vpnAccessible: false };
}

// ==================== Cache: NordVPN local ====================
function readNordLocalCache() {
  try {
    if (!fs.existsSync(NORD_CACHE_PATH)) return null;
    const raw = fs.readFileSync(NORD_CACHE_PATH, 'utf8');
    const json = JSON.parse(raw);
    const servers = json.Servers || json.servers;
    if (!servers) return null;

    const locations   = json.Locations   || json.locations   || [];
    const groups      = json.Groups      || json.groups      || [];
    const technologies= json.Technologies|| json.technologies|| [];

    const locMap  = Object.fromEntries((locations).map(l => [l.Id||l.id, l]));
    const grpMap  = Object.fromEntries((groups).map(g => [g.Id||g.id, g]));
    const techMap = {};
    technologies.forEach(t => {
      const id = t.Id||t.id;
      techMap[id] = t.identifier || TECH_ID_MAP[id] || null;
    });

    const CONTINENT_NAMES = new Set([
      'Europe','The Americas','Asia Pacific',
      'Africa, the Middle East and India','Africa'
    ]);

    const converted = servers
      .filter(s => (s.Status||s.status||'').toLowerCase() === 'online')
      .map(s => {
        const locIds = s.location_ids || [];
        const loc    = locMap[locIds[0]];
        const country= loc ? (loc.Country||loc.country) : null;
        const city   = country ? (country.city||country.City) : null;

        const techIds = (s.Technologies||s.technologies||[])
          .filter(t => (t.Status||t.status||'').toLowerCase() === 'online')
          .map(t => t.Id||t.id);

        const protocols = [...new Set(
          techIds.map(id => TECH_ID_MAP[id]).filter(Boolean)
        )];

        const gIds = s.group_ids || [];
        const p2p  = gIds.some(id => GROUP_P2P_IDS.has(id));
        const grpTitles = gIds.map(id => grpMap[id]?.Title||grpMap[id]?.title).filter(Boolean);
        const continent = grpTitles.find(t => CONTINENT_NAMES.has(t)) || 'Other';

        return {
          id: s.Id||s.id,
          hostname: s.HostName||s.hostname,
          station:  s.Station||s.station,
          name: s.Name||s.name,
          load: s.Load ?? s.load ?? 0,
          status: 'online',
          locations: country ? [{
            country: { name: country.Name||country.name, code: country.Code||country.code },
            city: city ? { name: city.name||city.Name } : undefined,
          }] : [],
          technologies: techIds.map(id => ({ identifier: TECH_ID_MAP[id]||String(id), status:'online' })),
          protocols,
          groups: grpTitles.map(title => ({ title, identifier: p2p ? 'legacy_p2p' : title })),
          p2p,
          continent,
        };
      })
      .filter(s => s.locations.length > 0);

    return { servers: converted, source: 'nord-local-cache', count: converted.length };
  } catch (e) {
    console.error('readNordLocalCache:', e.message);
    return null;
  }
}

// ==================== Cache: own ====================
function readOwnCache() {
  try {
    if (!fs.existsSync(OWN_CACHE_FILE)) return null;
    const obj = JSON.parse(fs.readFileSync(OWN_CACHE_FILE, 'utf8'));
    if (Date.now() - (obj.timestamp||0) > CACHE_TTL_MS) return null;
    return obj;
  } catch { return null; }
}

function writeOwnCache(servers, countries) {
  try {
    fs.writeFileSync(OWN_CACHE_FILE,
      JSON.stringify({ timestamp: Date.now(), servers, countries }), 'utf8');
    console.log(`✓ own cache: ${servers.length} سرور`);
  } catch (e) { console.error('writeOwnCache:', e.message); }
}

// fetch بدون auth (برای سرورهای عمومی)
function fetchPublic(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Parse error')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ==================== helpers ====================
function buildCountriesFromServers(servers) {
  const map = {};
  servers.forEach(s => {
    const code = s.locations?.[0]?.country?.code;
    const name = s.locations?.[0]?.country?.name;
    if (!code) return;
    if (!map[code]) map[code] = { id: code, name, code, continent: s.continent };
  });
  return Object.values(map);
}

function sendJSON(res, status, obj, headers = {}) {
  // guard: اگه قبلاً header فرستاده شده چیزی نفرست
  if (res.headersSent) return;
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(obj));
}

// ==================== وضعیت اتصال از log نورد ====================
async function getConnectionStatus() {
  try {
    // جدیدترین log رو بخون
    const logDir = path.join(os.homedir(), 'AppData', 'Local', 'NordVPN', 'logs');
    const today  = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const logFile = path.join(logDir, `app-${today}.log`);

    if (!fs.existsSync(logFile)) return { connected: false, source: 'no-log' };

    // آخرین 200 خط رو بخون (سریع‌تر از کل فایل)
    const { execSync } = require('child_process');
    const tail = execSync(
      `powershell -NoProfile -Command "Get-Content '${logFile}' -Tail 300"`,
      { timeout: 5000 }
    ).toString();

    // جستجو برای آخرین "Connected" state
    const lines = tail.split('\n').reverse();

    // دنبال سرور متصل بگرد
    for (const line of lines) {
      // فرمت: [VpnConnectionStateService] VpnConnectionState change: Connected
      if (line.includes('VpnConnectionState change: Connected')) {
        // سرور رو از خطوط قبلی پیدا کن
        const idx = lines.indexOf(line);
        const ctx = lines.slice(idx, idx + 30).join('\n');
        const hostMatch = ctx.match(/([a-z]{2}\d+\.nordvpn\.com)/i);
        const protoMatch = ctx.match(/OpenVPN|WireGuard|NordWhisper|IKEv2/i);
        if (hostMatch) {
          return {
            connected: true,
            hostname: hostMatch[1],
            protocol: protoMatch ? protoMatch[0] : null,
            displayName: hostToDisplay(hostMatch[1]),
          };
        }
      }
    }

    // اگه Disconnected پیدا شد
    for (const line of lines) {
      if (line.includes('VpnConnectionState change: Disconnected')) {
        return { connected: false, source: 'log' };
      }
    }

    return { connected: false, source: 'unknown' };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

function hostToDisplay(hostname) {
  // de1280.nordvpn.com -> Germany #1280
  const m = hostname.match(/^([a-z]{2})(\d+)\.nordvpn\.com$/i);
  if (!m) return hostname;
  const countryNames = {
    de:'Germany', us:'United States', gb:'United Kingdom', nl:'Netherlands',
    fr:'France', ch:'Switzerland', se:'Sweden', no:'Norway', fi:'Finland',
    jp:'Japan', sg:'Singapore', ca:'Canada', au:'Australia', it:'Italy',
    es:'Spain', pl:'Poland', ro:'Romania', be:'Belgium', at:'Austria',
    cz:'Czech Republic', hu:'Hungary', dk:'Denmark', nz:'New Zealand',
    hk:'Hong Kong', kr:'South Korea', br:'Brazil', mx:'Mexico', in:'India',
    il:'Israel', ae:'UAE', tr:'Turkey', ua:'Ukraine', vn:'Vietnam',
    id:'Indonesia', th:'Thailand', tw:'Taiwan', bg:'Bulgaria',
    rs:'Serbia', gr:'Greece', pt:'Portugal', is:'Iceland',
    lv:'Latvia', lt:'Lithuania', ee:'Estonia', za:'South Africa',
  };
  const country = countryNames[m[1].toLowerCase()] || m[1].toUpperCase();
  return `${country} #${parseInt(m[2])}`;
}

// ==================== HTTP server ====================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  let pathname = '', query = {};
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    pathname = u.pathname;
    query = Object.fromEntries(u.searchParams);
  } catch { pathname = req.url.split('?')[0]; }

  // ---- صفحه اصلی ----
  if (pathname === '/' || pathname === '/dashboard.html' || pathname === '/nordvpn_dashboard.html') {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(data);
    });
    return;
  }

  // ---- سرورها ----
  if (pathname === '/api/servers/recommendations') {
    const nord = readNordLocalCache();
    if (nord) {
      return sendJSON(res, 200, nord.servers, { 'X-Data-Source': 'nord-local-cache' });
    }
    const own = readOwnCache();
    if (own?.servers) {
      return sendJSON(res, 200, own.servers, { 'X-Data-Source': 'own-cache' });
    }
    fetchPublic('https://api.nordvpn.com/v1/servers/recommendations?limit=5000')
      .then(data => {
        writeOwnCache(data, []);
        sendJSON(res, 200, data, { 'X-Data-Source': 'live-api' });
      })
      .catch(e => sendJSON(res, 503, { error: e.message }));
    return;
  }

  // ---- آمار ----
  if (pathname === '/api/servers/stats') {
    fetchPublic('https://api.nordvpn.com/v1/servers/stats')
      .then(data => sendJSON(res, 200, data))
      .catch(() => sendJSON(res, 200, { users: 0, connections: 0 }));
    return;
  }

  // ---- کشورها ----
  if (pathname === '/api/servers/countries') {
    const nord = readNordLocalCache();
    if (nord) return sendJSON(res, 200, buildCountriesFromServers(nord.servers));
    const own = readOwnCache();
    if (own?.countries?.length) return sendJSON(res, 200, own.countries);
    fetchPublic('https://api.nordvpn.com/v1/servers/countries')
      .then(data => sendJSON(res, 200, data))
      .catch(() => sendJSON(res, 200, []));
    return;
  }

  // ---- پینگ ----
  if (pathname === '/api/ping') {
    const hostname = query.host;
    if (!hostname) return sendJSON(res, 400, { error: 'Missing host' });
    const realIP = stationMap[hostname] || null;

    bestPing(hostname)
      .then(({ ms, method, vpnAccessible }) => {
        sendJSON(res, 200, { host: hostname, realIP, ms, method, vpnAccessible });
      })
      .catch(() => sendJSON(res, 200, { host: hostname, realIP, ms: null, method: null, vpnAccessible: false }));
    return;
  }

  // ---- وضعیت منابع داده ----
  if (pathname === '/api/data/status') {
    const nordExists = fs.existsSync(NORD_CACHE_PATH);
    const nordStat   = nordExists ? fs.statSync(NORD_CACHE_PATH) : null;
    return sendJSON(res, 200, {
      nordLocalCache: {
        exists: nordExists,
        sizeKB: nordStat ? Math.round(nordStat.size/1024) : 0,
        ageMinutes: nordStat ? Math.round((Date.now()-nordStat.mtime)/60000) : null,
        count: nordExists ? (readNordLocalCache()?.count || 0) : 0,
      },
    });
  }

  // ---- refresh دستی (با VPN فعال) ----
  if (pathname === '/api/cache/refresh') {
    fetchPublic('https://api.nordvpn.com/v1/servers/recommendations?limit=5000')
      .then(servers => {
        fetchPublic('https://api.nordvpn.com/v1/servers/countries')
          .then(countries => {
            writeOwnCache(servers, countries);
            sendJSON(res, 200, { ok: true, servers: servers.length });
          })
          .catch(() => {
            writeOwnCache(servers, []);
            sendJSON(res, 200, { ok: true, servers: servers.length });
          });
      })
      .catch(e => sendJSON(res, 503, { ok: false, error: e.message }));
    return;
  }

  // ---- وضعیت اتصال فعلی: از IP عمومی و log نورد ----
  if (pathname === '/api/connection/status') {
    getConnectionStatus()
      .then(status => sendJSON(res, 200, status))
      .catch(() => sendJSON(res, 200, { connected: false }));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`✓ سرور: http://localhost:${PORT}/dashboard.html`);
  if (fs.existsSync(NORD_CACHE_PATH)) {
    const stat = fs.statSync(NORD_CACHE_PATH);
    const ageMin = Math.round((Date.now()-stat.mtime)/60000);
    console.log(`✓ cache نورد: ${Math.round(stat.size/1024)} KB — ${ageMin} دقیقه پیش`);
    loadStationMap();
  } else {
    console.log(`⚠ cache نورد پیدا نشد`);
  }
});

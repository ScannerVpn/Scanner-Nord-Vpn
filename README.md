# 🛡️ NordVPN Server Dashboard

A desktop dashboard for monitoring NordVPN servers — built specifically for users in **censored/restricted regions** (Iran, China, Russia, etc.) where standard VPN detection methods give false positives due to DPI (Deep Packet Inspection).

> **یک داشبورد دسکتاپ برای مانیتورینگ سرورهای NordVPN — طراحی‌شده برای کاربران در ایران و کشورهایی که ISP با DPI سرویس‌های VPN رو فیلتر میکنه.**

---

## ✨ Features

- 📡 **Real VPN accessibility check** — uses full TLS handshake (not just TCP SYN) to detect whether a server is actually reachable through censorship filters
- 🌍 **Browse all NordVPN servers** by country, load, latency, and supported protocols
- ⚡ **Live ping** — checks TLS 443, TLS 80, WireGuard UDP 51820, TCP 1194 in order
- 🔴🟡🟢 **Smart badges** — clearly shows `✓VPN` (accessible), `⚠DPI` (filtered), or `✕VPN` (blocked)
- 🔄 **Auto-refresh** from NordVPN's public API with local cache fallback
- 🖥️ **Electron desktop app** — runs as a standalone window, no browser needed

---

## 🧠 How VPN Detection Works

Standard ping tools only test TCP SYN — this is unreliable in Iran because ISPs accept the TCP handshake but silently drop VPN traffic (DPI).

This dashboard performs a **full TLS handshake** via Node's `tls.connect()`:

```
TLS 443  →  TLS 80  →  WireGuard UDP 51820  →  TLS 1194  →  TCP SYN (⚠DPI)  →  ICMP (✕VPN)
```

Only when the server completes a TLS handshake does it show `✓VPN`. If the handshake times out after a successful TCP connect, it's marked `⚠DPI`.

---

## 📦 Installation

### Requirements
- [Node.js](https://nodejs.org) v18 or newer
- Windows / macOS / Linux

### Steps

```bash
# Clone the repo
git clone https://github.com/ScannerVpn/Scanner-Nord-Vpn.git
cd Scanner-Nord-Vpn

# Install dependencies
npm install

# Run as Electron desktop app
npm start

# Or run just the backend server (open http://localhost:3000/dashboard.html in browser)
npm run dev
```

---

## 🗂️ Project Structure

```
nordvpn-dashboard/
├── main.js                  # Electron entry point
├── server.js                # Backend proxy + ping engine
├── nordvpn_dashboard.html   # Frontend UI
├── package.json
└── README.md
```

### `server.js` — Backend Proxy

Runs on `http://localhost:3000` and exposes these endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /dashboard.html` | Serves the UI |
| `GET /api/servers` | Returns cached server list from NordVPN API |
| `GET /api/data/status` | Cache age and record count |
| `GET /api/ping?host=de123.nordvpn.com` | Full VPN accessibility probe for one server |
| `POST /api/cache/refresh` | Force re-fetch from NordVPN API |

### `nordvpn_dashboard.html` — Frontend

Single-file HTML/JS/CSS dashboard. No build step, no npm packages — runs directly in the Electron window.

---

## 🔍 Ping / Accessibility Logic

```js
// 1. Full TLS handshake on port 443
// 2. Full TLS handshake on port 80  (less blocked in Iran)
// 3. WireGuard UDP probe on port 51820
// 4. Full TLS handshake on port 1194
// 5. Plain TCP SYN on port 443      → marked ⚠DPI (likely filtered)
// 6. ICMP ping                      → marked ✕VPN (IP alive, VPN blocked)
```

The result badge:
- **`✓VPN`** — TLS handshake succeeded, server is reachable
- **`⚠DPI`** — TCP connects but TLS is dropped — DPI filtering suspected
- **`✕VPN`** — IP is alive (ICMP) but VPN ports are fully blocked

---

## 📸 Screenshots

> *(Add screenshots here)*

---

## ⚠️ Notes

- This tool uses **NordVPN's public API** — no account or credentials required.
- The proxy runs on `localhost` only — it is **not exposed to the internet**.
- Server data is cached locally and refreshed every 12 hours.
- Results depend on your ISP and network conditions at the time of the ping.

> ### 🔴 مهم — قبل از ping گرفتن VPN رو خاموش کن
> نتایج فقط وقتی معتبره که **VPN کاملاً خاموش باشه**.
> اگه VPN روشن باشه، همه سرورها `✓VPN` نشون میدن چون ترافیک از طریق خود VPN رد میشه و فیلتر ISP دور زده میشه — نتیجه واقعی نیست.
> 
> **روش درست:** VPN رو ببند ← برنامه رو باز کن ← ping بگیر ← سرورهایی که `✓VPN` دارن رو توی اپ NordVPN امتحان کن.

---

## 🏗️ Build (Distributable .exe / .dmg)

```bash
npm run dist
```

Output will be in the `dist/` folder.

---

## 📱 Android (Termux)

میتونی همین داشبورد رو روی گوشی اندروید هم اجرا کنی — بدون نیاز به root یا نصب apk خاص.

### نصب Termux
از [F-Droid](https://f-droid.org/packages/com.termux/) دانلود کن (نه Google Play).

### اجرا

```bash
# آپدیت پکیج‌ها
pkg update && pkg upgrade

# نصب Node.js و git
pkg install nodejs git

# کلون پروژه
git clone https://github.com/ScannerVpn/Scanner-Nord-Vpn.git
cd Scanner-Nord-Vpn

# نصب dependencies
npm install

# اجرای سرور
node server.js
```

بعد مرورگر گوشی رو باز کن و برو:
```
http://localhost:3000/dashboard.html
```

### ⚠️ نکته
- **TLS probe** کاملاً کار میکنه — نتایج `✓VPN` و `⚠DPI` دقیق هستن
- **ICMP ping** بدون root کار نمیکنه — سرورهایی که فقط ICMP دارن `✕VPN` نشون میده (نرمالِ)
- برای اجرای پس‌زمینه از `nohup node server.js &` استفاده کن

---

## 📄 License

MIT

# 🛡️ NordVPN Server Dashboard

داشبورد مانیتورینگ سرورهای NordVPN — طراحی‌شده برای کاربران **ایران، چین، روسیه** و کشورهایی که ISP با DPI سرویس‌های VPN رو فیلتر میکنه.

> A dashboard for monitoring NordVPN servers — built for users in censored regions where ISPs use Deep Packet Inspection to block VPN traffic.

---

## ✨ ویژگی‌ها

- 📡 **تست واقعی دسترسی VPN** — TLS handshake کامل (نه فقط TCP SYN)
- 🌍 **مشاهده همه سرورهای NordVPN** بر اساس کشور، load، latency و پروتکل
- ⚡ **پینگ موازی** — همه پورت‌ها همزمان تست میشن (سریع‌تر)
- ⛔ **دکمه Stop** — هر لحظه میتونی اسکن رو متوقف کنی
- 🔴🟡🟢 **نشانگر هوشمند** — `✓VPN` (دسترسی کامل)، `⚠DPI` (فیلتر شده)، `✕VPN` (بلاک کامل)
- 🔄 **Cache محلی** — از cache نصب‌شده NordVPN استفاده میکنه، بدون نیاز به اینترنت

---

## 🧠 چطور کار میکنه

ابزارهای معمولی فقط TCP SYN تست میکنن — در ایران ISP این handshake رو قبول میکنه ولی بعد TLS رو drop میکنه (DPI).

این داشبورد **TLS handshake کامل** انجام میده:

```
TLS 443 ⟐
TLS 80  ⟐ → همه موازی — اولین جواب مثبت = نتیجه
TLS 1194⟐
WG UDP  ⟐
         ↓ اگه همه fail شدن
TCP SYN → ⚠DPI (فیلتر احتمالی)
ICMP    → ✕VPN (IP زنده، VPN بلاکه)
```

| نشانگر | معنی |
|--------|------|
| `✓VPN` | TLS handshake موفق — سرور واقعاً accessible |
| `⚠DPI` | TCP وصل شد ولی TLS drop شد — فیلتر DPI |
| `✕VPN` | IP زنده‌ست ولی VPN کاملاً بلاکه |

---

## 📦 نصب و اجرا

### پیش‌نیاز
- [Node.js](https://nodejs.org) نسخه ۱۸ یا بالاتر

### ویندوز — راحت‌ترین روش

```bash
git clone https://github.com/ScannerVpn/Scanner-Nord-Vpn.git
cd Scanner-Nord-Vpn
npm install
```

بعد **دابل‌کلیک روی `Start.bat`** — سرور بالا میاد و مرورگر پیش‌فرض باز میشه.

### اجرای دستی (همه سیستم‌عامل‌ها)

```bash
# ترمینال اول — سرور
node server.js

# مرورگر رو باز کن
http://localhost:3000/dashboard.html
```

---

## 📱 اجرا روی اندروید (Termux)

میتونی همین داشبورد رو روی گوشی اندروید اجرا کنی — بدون root.

### نصب Termux

از [GitHub](https://github.com/termux/termux-app/releases)
یا [Google Play](https://play.google.com/store/apps/details?id=com.termux) دانلود کن.
### مراحل

```bash
# آپدیت و نصب پیش‌نیازها
pkg update && pkg upgrade -y
pkg install nodejs git -y

# کلون و نصب
git clone https://github.com/ScannerVpn/Scanner-Nord-Vpn.git
cd Scanner-Nord-Vpn
npm install

# اجرا
node server.js
```

بعد مرورگر گوشی رو باز کن:
```
http://localhost:3000/dashboard.html
```

### اجرا در پس‌زمینه (بدون بسته شدن با Termux)

```bash
# نصب tmux
pkg install tmux -y

# یه session جدید بساز
tmux new -s nord

# سرور رو start کن
node server.js

# از session خارج بشو بدون بستنش: Ctrl+B بعد D
# برای برگشتن:
tmux attach -t nord
```

### ⚠️ نکات مهم Termux

- **TLS probe** کاملاً کار میکنه — نتایج `✓VPN` و `⚠DPI` دقیق هستن
- **ICMP ping** بدون root کار **نمیکنه** — این نرماله، چون Termux دسترسی raw socket نداره. سرورهایی که فقط از ICMP جواب میدن `✕VPN` نشون میده ولی ممکنه واقعاً accessible باشن — به نتایج `✓VPN` و `⚠DPI` اعتماد کن
- اگه خطای `EACCES` برای UDP گرفتی، WireGuard probe کار نمیکنه — باقی probe‌ها سالمن

---

## 🗂️ ساختار پروژه

```
nordvpn-dashboard/
├── main.js                  # Electron entry point (اختیاری)
├── server.js                # Backend proxy + ping engine
├── nordvpn_dashboard.html   # Frontend UI
├── Start.bat                # راه‌انداز یک‌کلیکی ویندوز
└── package.json
```

### API endpoints

| Endpoint | توضیح |
|----------|-------|
| `GET /dashboard.html` | صفحه اصلی |
| `GET /api/servers/recommendations` | لیست سرورها |
| `GET /api/ping?host=de123.nordvpn.com` | تست دسترسی یه سرور |
| `GET /api/data/status` | وضعیت cache |
| `POST /api/cache/refresh` | بروزرسانی از API نورد (با VPN) |

---

## ⚠️ نکته مهم — قبل از ping

> **VPN رو کاملاً خاموش کن** قبل از اینکه ping بگیری.
>
> اگه VPN روشن باشه، همه سرورها `✓VPN` نشون میدن چون ترافیک از داخل تونل رد میشه — نتیجه واقعی نیست.
>
> **روش درست:** VPN ببند ← سرور start کن ← ping بگیر ← سرورهای `✓VPN` رو توی اپ NordVPN امتحان کن

---

## 📄 License

MIT

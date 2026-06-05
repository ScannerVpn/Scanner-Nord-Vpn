@echo off
cd /d "%~dp0"
echo Starting NordVPN Dashboard...

:: سرور رو در پس‌زمینه start کن
start "" /B node server.js

:: صبر کن سرور بالا بیاد
timeout /t 2 /nobreak >nul

:: مرورگر پیش‌فرض رو باز کن
start "" "http://localhost:3000/dashboard.html"
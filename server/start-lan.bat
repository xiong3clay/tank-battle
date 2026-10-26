@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo ============================================
echo  坦克大战 · 自建服务器（局域网）
echo  启动后，同一 WiFi 下的设备打开下面打印的地址
echo ============================================
node server\relay.js --port 8000 --root .
pause

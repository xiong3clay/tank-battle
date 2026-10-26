@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
if not exist "server\bin" mkdir "server\bin"
if not exist "server\bin\cloudflared.exe" (
  echo [1/3] 首次运行，正在下载 cloudflared（约 40MB，需外网）...
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'server\bin\cloudflared.exe' -UseBasicParsing"
  if not exist "server\bin\cloudflared.exe" (
    echo 下载失败。请手动下载 cloudflared.exe 放到 server\bin\ 后重试。
    pause
    exit /b 1
  )
)
echo [2/3] 启动本地服务器（端口 8000）...
start "tank-battle-server" cmd /c "node server\relay.js --port 8000 --root ."
timeout /t 2 >nul
echo [3/3] 开启公网隧道（首次约 10 秒，会打印 https://xxx.trycloudflare.com）...
echo 把这个 https 地址发给对方，双方打开同一个地址即可。
echo.
server\bin\cloudflared.exe tunnel --url http://localhost:8000 --no-autoupdate

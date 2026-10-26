# 坦克大战 · 一键开服务器
#
# 功能：
#   1) 启动本地中继服务器（server/relay.js，端口默认 8000）
#   2) 启动 cloudflared 公网隧道，拿到 https://xxx.trycloudflare.com 地址
#   3) 把地址打印出来 + 复制到剪贴板 + 自动用浏览器打开
#   4) 运行期间阻止电脑因空闲休眠；关掉窗口即停止服务器与隧道
#
# 用法（一般通过桌面快捷方式双击）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File "…\server\open-server.ps1"
#   参数：-Port 8000  -NoTunnel（只开局域网）  -HoldSeconds 30（自检用，自动退出）
#         -NoBrowser（不自动开浏览器）

param(
  [int]$Port = 8000,
  [switch]$NoTunnel,
  [int]$HoldSeconds = 0,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
# 控制台输出交给系统默认代码页（中文 Windows 为 936），避免乱码

$serverDir = $PSScriptRoot
$repo = Split-Path -Parent $serverDir
$dataDir = Join-Path $env:LOCALAPPDATA 'tank-battle'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$logPath = Join-Path $dataDir 'tunnel.log'

function Write-Step($msg) { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "[+] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Get-LanIp {
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -ExpandProperty IPAddress
  return ($ips | Select-Object -First 1)
}

# ---------- 防休眠 ----------
$keepAwake = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class TbKeepAwake {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
'@ -ErrorAction Stop
  # ES_CONTINUOUS(0x80000000) | ES_SYSTEM_REQUIRED(0x1) —— 阻止系统休眠，但允许关屏
  [void][TbKeepAwake]::SetThreadExecutionState([uint32]0x80000001)
  $keepAwake = $true
} catch { $keepAwake = $false }

$startedServer = $null
$startedTunnel = $null

try {
  Write-Host ''
  Write-Host '  坦克大战 · 开服务器' -ForegroundColor Green
  Write-Host '  ------------------------------' -ForegroundColor DarkGray
  Write-Host ''

  # ---------- 1. Node ----------
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warn2 '找不到 node 命令。请先安装 Node.js（https://nodejs.org）。'
    if ($HoldSeconds -eq 0) { Read-Host '按回车退出' }
    exit 1
  }

  # ---------- 2. 本地服务器 ----------
  if (Test-Health) {
    Write-Ok "本地服务器已经在 $Port 端口运行，直接复用"
  } else {
    Write-Step "启动本地服务器（端口 $Port）..."
    $startedServer = Start-Process -FilePath 'node' -ArgumentList "server\relay.js", '--port', "$Port", '--root', '.' `
      -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $dataDir 'server-out.log') `
      -RedirectStandardError (Join-Path $dataDir 'server-err.log')
    $ok = $false
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 300
      if (Test-Health) { $ok = $true; break }
    }
    if (-not $ok) {
      Write-Warn2 "服务器没起来，看看日志：$dataDir\server-err.log"
      if ($HoldSeconds -eq 0) { Read-Host '按回车退出' }
      exit 1
    }
    Write-Ok "本地服务器已启动（pid $($startedServer.Id)）"
  }

  $lanIp = Get-LanIp
  $lanUrl = if ($lanIp) { "http://${lanIp}:$Port/" } else { "http://127.0.0.1:$Port/" }
  Write-Host ''
  Write-Host "  局域网地址（同一 WiFi 可直接用）：$lanUrl" -ForegroundColor White
  Write-Host ''

  # ---------- 3. 公网隧道 ----------
  $publicUrl = $null
  if (-not $NoTunnel) {
    $cf = Join-Path $serverDir 'bin\cloudflared.exe'
    if (-not (Test-Path $cf)) {
      Write-Step '首次运行，正在下载 cloudflared（约 40MB）...'
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cf) | Out-Null
      try {
        Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' `
          -OutFile $cf -UseBasicParsing -TimeoutSec 600
      } catch {
        Write-Warn2 "cloudflared 下载失败：$($_.Exception.Message)"
        Write-Warn2 '可以只用上面的局域网地址；或在能上网时重试。'
      }
    }

    if (Test-Path $cf) {
      Write-Step '开启公网隧道（首次约 10 秒）...'
      Remove-Item $logPath -ErrorAction SilentlyContinue
      $startedTunnel = Start-Process -FilePath $cf `
        -ArgumentList 'tunnel', '--url', "http://localhost:$Port", '--no-autoupdate' `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardError $logPath -RedirectStandardOutput (Join-Path $dataDir 'tunnel-out.log')

      for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 800
        if (Test-Path $logPath) {
          $m = Select-String -Path $logPath -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue | Select-Object -First 1
          if ($m) { $publicUrl = $m.Matches[0].Value; break }
        }
      }

      if ($publicUrl) {
        Write-Ok '公网隧道已建立'
        # 本机 DNS 可能解析不到（校园网常见），只做提示，不影响隧道本身
        try {
          $chk = Invoke-WebRequest -Uri "$publicUrl/health" -UseBasicParsing -TimeoutSec 8
          if ($chk.StatusCode -ne 200) { throw 'bad' }
        } catch {
          Write-Warn2 '本机暂时解析不到这个域名（校园网 DNS 偶发），隧道本身通常是好的'
          Write-Warn2 '手机打不开时：切到手机流量重试，或把手机 DNS 换成 223.5.5.5'
        }
      } else {
        Write-Warn2 '没拿到公网地址（隧道可能失败）。本次只能使用局域网地址。'
      }
    }
  }

  # ---------- 4. 输出地址 ----------
  Write-Host ''
  Write-Host '  ==============================================' -ForegroundColor DarkGray
  if ($publicUrl) {
    Write-Host '   发给对方的公网地址（每次启动都会变）：' -ForegroundColor Gray
    Write-Host ''
    Write-Host "   $publicUrl" -ForegroundColor Green
    Write-Host ''
    Write-Host '   同一 WiFi 下的备用地址：' -ForegroundColor Gray
    Write-Host "   $lanUrl" -ForegroundColor White
  } else {
    Write-Host '   本次可用的地址（局域网）：' -ForegroundColor Gray
    Write-Host ''
    Write-Host "   $lanUrl" -ForegroundColor Green
    Write-Host ''
    Write-Host '   （未开启公网隧道，异地无法访问）' -ForegroundColor DarkGray
  }
  Write-Host '  ==============================================' -ForegroundColor DarkGray
  Write-Host ''

  $shareUrl = if ($publicUrl) { $publicUrl } else { $lanUrl }
  Set-Content -Path (Join-Path $dataDir 'url.txt') -Value $shareUrl -Encoding UTF8
  try { Set-Clipboard -Value $shareUrl; Write-Ok '地址已复制到剪贴板' } catch { Write-Warn2 '复制到剪贴板失败，请手动复制上面的地址' }

  Write-Host ''
  Write-Host '  使用提示：' -ForegroundColor Gray
  Write-Host '   · 手机上打开这个地址 → 右上角「双人对战」→ 选「自建服务器」→ 输同一房间号' -ForegroundColor DarkGray
  Write-Host '   · 浏览器里打开 /health 可以看到当前在线房间数' -ForegroundColor DarkGray
  if ($keepAwake) { Write-Host '   · 运行期间已阻止电脑空闲休眠（关屏不影响）' -ForegroundColor DarkGray }
  Write-Host '   · 关掉这个窗口 = 停止服务器与隧道' -ForegroundColor DarkGray
  Write-Host ''

  if (-not $NoBrowser -and $publicUrl) {
    try { Start-Process $publicUrl } catch {}
  }

  if ($HoldSeconds -gt 0) {
    Write-Host "  （自检模式：$HoldSeconds 秒后自动退出）" -ForegroundColor DarkGray
    Start-Sleep -Seconds $HoldSeconds
  } else {
    Write-Host '  按 Ctrl+C 或直接关窗口即可停止。' -ForegroundColor Yellow
    while ($true) { Start-Sleep -Seconds 3600 }
  }
}
finally {
  if ($startedTunnel) { try { Stop-Process -Id $startedTunnel.Id -Force -ErrorAction SilentlyContinue } catch {} }
  if ($startedServer) { try { Stop-Process -Id $startedServer.Id -Force -ErrorAction SilentlyContinue } catch {} }
  if ($keepAwake) { try { [void][TbKeepAwake]::SetThreadExecutionState([uint32]0x80000000) } catch {} }
  Write-Host ''
  Write-Host '  服务器已停止。' -ForegroundColor DarkGray
}

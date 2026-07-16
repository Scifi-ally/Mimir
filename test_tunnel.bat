@echo off
setlocal enabledelayedexpansion
set "SCRIPT_DIR=C:\Users\sahaj\Desktop\Mimir\"
set "TUNNEL_PORT=3000"

set "CF_URL="
for /l %%i in (1,1,20) do (
    if "!CF_URL!"=="" (
        for /f "tokens=*" %%a in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '%SCRIPT_DIR%.codex-logs\trade.tunnel.err.log') { (Get-Content '%SCRIPT_DIR%.codex-logs\trade.tunnel.err.log' -ErrorAction SilentlyContinue | Select-String 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | Select-Object -First 1).Matches[0].Value }" 2^>nul') do set "CF_URL=%%a"
        if "!CF_URL!"=="" ping -n 2 127.0.0.1 >nul
    )
)
if not "!CF_URL!"=="" (
    echo   [OK] New Tunnel           !CF_URL! -^> localhost:%TUNNEL_PORT%
) else (
    echo   [X] Tunnel failed — check .codex-logs\trade.tunnel.err.log
)

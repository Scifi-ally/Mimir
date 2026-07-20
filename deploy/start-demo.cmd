@echo off
REM ── Mimir demo launcher ──────────────────────────────────────────────
REM Starts all four pieces in separate windows, in dependency order.
REM Prereqs (one-time): cloudflared tunnel login / create / route dns
REM (see deploy\HOSTING.md). If the AI service uses a venv, activate it
REM in the "AI Service" window or edit that line.

cd /d "%~dp0.."

echo [1/4] AI service (port 8001)...
start "Mimir AI Service" cmd /k "cd backend\ai_service && python main.py"

echo [2/4] Backend (port 5000)...
start "Mimir Backend" cmd /k "cd backend && npm run dev"

echo [3/4] Frontend production preview (port 3000)...
start "Mimir Frontend" cmd /k "cd frontend && npx vite build && npx vite preview"

echo [4/4] Cloudflare tunnel (mimir.dpdns.org)...
start "Mimir Tunnel" cmd /k "cloudflared tunnel --config deploy\cloudflared-config.yml run mimir"

echo.
echo All four windows launched. Give the backend ~30s to boot, then check:
echo   local:  http://localhost:3000
echo   public: https://mimir.dpdns.org
echo.
echo Remember: authorize the Upstox token before market open (backend log
echo prints the auth URL, or use the login button in the app).
pause

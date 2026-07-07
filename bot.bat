@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

:: Define ESC character for ANSI colors
for /F %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "C_RESET=!ESC![0m"
set "C_GREEN=!ESC![38;2;74;222;128m"
set "C_CYAN=!ESC![38;2;103;232;249m"
set "C_PURPLE=!ESC![38;2;168;130;255m"
set "C_RED=!ESC![38;2;248;113;113m"
set "C_YELLOW=!ESC![38;2;250;204;21m"
set "C_GRAY=!ESC![38;2;115;115;115m"
set "C_WHITE=!ESC![38;2;245;245;245m"
set "C_DIM=!ESC![2m"
set "C_BOLD=!ESC![1m"
set "C_BLUE=!ESC![38;2;96;165;250m"

set "SCRIPT_DIR=%~dp0"
set "STATE_FILE=%SCRIPT_DIR%.codex-logs\trade.running"
set "BACKEND_PID_FILE=%SCRIPT_DIR%.codex-logs\trade.backend.pid"
set "ENGINE_PID_FILE=%SCRIPT_DIR%.codex-logs\trade.engine.pid"
set "AI_PID_FILE=%SCRIPT_DIR%.codex-logs\trade.ai.pid"
set "FRONTEND_PID_FILE=%SCRIPT_DIR%.codex-logs\trade.frontend.pid"

pushd "%SCRIPT_DIR%" 2>nul || ( echo Error: Could not find project. & exit /b 1 )
set "PROJECT_DIR=%CD%"
popd

if not exist "%PROJECT_DIR%\.codex-logs" mkdir "%PROJECT_DIR%\.codex-logs" >nul 2>&1
if exist "%PROJECT_DIR%\.codex-logs\menu_top.txt" del /f /q "%PROJECT_DIR%\.codex-logs\menu_top.txt" >nul 2>&1

set "ACTION=%~1"
if /i "%ACTION%"=="start" goto start
if /i "%ACTION%"=="stop" goto stop
if /i "%ACTION%"=="status" goto status
if /i "%ACTION%"=="restart" goto restart
if /i "%ACTION%"=="tunnel" goto tunnel
if /i "%ACTION%"=="tunnel-stop" goto tunnel_stop
if "%ACTION%"=="" goto menu

echo !C_CYAN!Usage: bot [start^|stop^|status^|restart^|tunnel ^<port^>^|tunnel-stop]!C_RESET!
exit /b 1

:print_banner
echo.
echo.
echo  !C_PURPLE! /\    /\ !C_RESET!
echo  !C_BLUE! //\  /\\ !C_RESET!  !C_WHITE!!C_BOLD!MIMIR!C_RESET!
echo  !C_CYAN! // \/ \\ !C_RESET!  !C_GRAY!Intelligent Market Analysis Engine!C_RESET!
echo  !C_CYAN! //    \\ !C_RESET!  !C_DIM!!C_GRAY!v2.0!C_RESET!
echo.
exit /b 0

:toggle
call :isRunning
if "%RUNNING%"=="1" goto stop
goto start

:start
call :isRunning
if "%RUNNING%"=="1" (
    echo !C_YELLOW!  ^> Already running.!C_RESET! !C_DIM!!C_GRAY!Use "bot stop" first.!C_RESET!
    goto status
)
call :print_banner
echo !C_GRAY!  --------------------------------------!C_RESET!
echo !C_WHITE!  ^> !C_GREEN!Initializing Engine...!C_RESET!
:: Clean up any leftover zombie processes to prevent file locking issues
call node "%SCRIPT_DIR%scripts\kill-zombies.mjs" >nul 2>&1
:: Remove stale literal %STATE_FILE% junk file from a previous script version
if exist "%SCRIPT_DIR%%%STATE_FILE%%" del /f /q "%SCRIPT_DIR%%%STATE_FILE%%" >nul 2>&1
> "%STATE_FILE%" echo running

:: Find Node.js path (Portable or Global)
set "NODE_CMD=node"
if exist "%PROJECT_DIR%\.portable\node\node.exe" set "NODE_CMD=%PROJECT_DIR%\.portable\node\node.exe"

:: Find Python path (Portable or .venv)
set "PYTHON_CMD="
if exist "%PROJECT_DIR%\.portable\python\python.exe" set "PYTHON_CMD=%PROJECT_DIR%\.portable\python\python.exe"
if "%PYTHON_CMD%"=="" if exist "%PROJECT_DIR%\.venv\Scripts\python.exe" set "PYTHON_CMD=%PROJECT_DIR%\.venv\Scripts\python.exe"
if "%PYTHON_CMD%"=="" if exist "%PROJECT_DIR%\..\.venv\Scripts\python.exe" set "PYTHON_CMD=%PROJECT_DIR%\..\.venv\Scripts\python.exe"

if "%PYTHON_CMD%"=="" (
    echo !C_RED!  [X] Python not found!C_RESET!
    echo !C_DIM!!C_GRAY!    Run scripts\setup_portable.ps1 to install!C_RESET!
    goto stop
)

:: AI service launch is deferred below (after backend build) so model-loading
:: overlaps with the PostgreSQL + build steps for faster total startup.

:: Check for Portable PostgreSQL
if exist "%PROJECT_DIR%\.portable\pgsql\bin\pg_ctl.exe" (
    echo !C_GRAY!    +-- !C_DIM!Starting portable PostgreSQL...!C_RESET!
    "%PROJECT_DIR%\.portable\pgsql\bin\pg_ctl.exe" start -D "%PROJECT_DIR%\.portable\pgsql\data" -o "-p 5433" >nul 2>&1
    
    :: Wait for Postgres to be ready
    call :wait_pg
    
    :: Override DATABASE_URL so the node processes connect to the portable DB
    set "DATABASE_URL=postgresql://postgres:postgres@localhost:5433/upstox_bot"
    
    :: Automatically create the database and run migrations/setup
    set "PGPASSWORD=postgres"
    "%PROJECT_DIR%\.portable\pgsql\bin\createdb.exe" -h localhost -p 5433 -U postgres upstox_bot >nul 2>&1
    echo !C_GRAY!    +-- !C_DIM!Running database migrations...!C_RESET!
    call !NODE_CMD! "%PROJECT_DIR%\backend\dist\migrate.mjs" >nul 2>&1
)

:: Start Backend processes (API Server + Trading Engine) in hidden PowerShell windows and capture PIDs
echo !C_GRAY!    +-- !C_DIM!Compiling backend...!C_RESET!
call !NODE_CMD! "%PROJECT_DIR%\backend\build.mjs" >nul 2>&1
echo !C_GRAY!    \-- !C_DIM!Starting backend ^& trading engine...!C_RESET!
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\run-detached.ps1" -FilePath "!NODE_CMD!" -ArgumentList "--enable-source-maps ./dist/index.mjs" -WorkingDirectory "%PROJECT_DIR%\backend" -PidFile "!BACKEND_PID_FILE!" -LogOut "!BACKEND_PID_FILE!.out.log" -LogErr "!BACKEND_PID_FILE!.err.log"

:: Start AI Service *after* backend build so model-loading overlaps with prior steps.
:: HF_HUB_OFFLINE=1 forces HuggingFace to use cached models only (skips ~150s of HTTP checks).
echo !C_GRAY!    +-- !C_DIM!Starting AI service...!C_RESET!
set "HF_HUB_OFFLINE=1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\run-detached.ps1" -FilePath "!PYTHON_CMD!" -ArgumentList "-u main.py" -WorkingDirectory "%PROJECT_DIR%\backend\ai_service" -PidFile "!AI_PID_FILE!" -LogOut "!AI_PID_FILE!.out.log" -LogErr "!AI_PID_FILE!.err.log"

echo !C_GRAY!    +-- !C_DIM!Starting frontend...!C_RESET!
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\run-detached.ps1" -FilePath "!NODE_CMD!" -ArgumentList "%PROJECT_DIR%\node_modules\vite\bin\vite.js preview" -WorkingDirectory "%PROJECT_DIR%\frontend" -PidFile "!FRONTEND_PID_FILE!" -LogOut "!FRONTEND_PID_FILE!.out.log" -LogErr "!FRONTEND_PID_FILE!.err.log"

:: Start Cloudflare Tunnel in the background (generates a fresh random URL)
set "CF_CMD=%PROJECT_DIR%\.portable\cloudflared.exe"
if exist "!CF_CMD!" (
    echo !C_GRAY!    +-- !C_DIM!Starting Cloudflare tunnel...!C_RESET!
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\run-detached.ps1" -FilePath "!CF_CMD!" -ArgumentList "tunnel --url http://localhost:3000" -WorkingDirectory "%PROJECT_DIR%" -PidFile "%SCRIPT_DIR%.codex-logs\trade.tunnel.pid" -LogOut "%SCRIPT_DIR%.codex-logs\trade.tunnel.out.log" -LogErr "%SCRIPT_DIR%.codex-logs\trade.tunnel.err.log"
)

:: Wait for ports to become active to verify launch success
set "BACKEND_OK=0"
set "AI_OK=0"
for /l %%i in (1,1,60) do (
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":5000" ^| findstr /C:"LISTENING" 2^>nul') do (
        if not "%%p"=="" if %%p neq 0 set "BACKEND_OK=1"
    )
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":8001" ^| findstr /C:"LISTENING" 2^>nul') do (
        if not "%%p"=="" if %%p neq 0 set "AI_OK=1"
    )
    if "!BACKEND_OK!"=="1" if "!AI_OK!"=="1" goto startup_check_done
    ping -n 2 127.0.0.1 >nul
)
:startup_check_done

echo.
echo !C_GRAY!  --------------------------------------!C_RESET!

if "%AI_OK%"=="0" (
    echo !C_RED!  [X] AI Service          failed :8001!C_RESET!
    echo !C_DIM!!C_GRAY!    Check .codex-logs for details!C_RESET!
) else (
    echo !C_GREEN!  [OK] !C_WHITE!AI Service!C_RESET!!C_GRAY!          http://localhost:8001!C_RESET!
)

if "%BACKEND_OK%"=="0" (
    echo !C_RED!  [X] Backend API         failed :5000!C_RESET!
    echo !C_DIM!!C_GRAY!    Check .codex-logs for details!C_RESET!
) else (
    echo !C_GREEN!  [OK] !C_WHITE!Backend API!C_RESET!!C_GRAY!         http://localhost:5000!C_RESET!
    echo !C_GREEN!  [OK] !C_WHITE!Frontend!C_RESET!!C_GRAY!            http://localhost:3000!C_RESET!
)

:: Extract cloudflared tunnel URL from stderr log (it prints there)
set "CF_URL="
for /l %%i in (1,1,15) do (
    if "!CF_URL!"=="" (
        for /f "tokens=*" %%a in ('powershell -NoProfile -Command "if (Test-Path '%SCRIPT_DIR%.codex-logs\trade.tunnel.err.log') { (Get-Content '%SCRIPT_DIR%.codex-logs\trade.tunnel.err.log' -ErrorAction SilentlyContinue | Select-String 'https://\S+trycloudflare\.com' | Select-Object -First 1).Matches[0].Value }" 2^>nul') do set "CF_URL=%%a"
        if "!CF_URL!"=="" ping -n 2 127.0.0.1 >nul
    )
)

if not "!CF_URL!"=="" (
    echo !C_PURPLE!  [OK] !C_WHITE!Public Web!C_RESET!!C_GRAY!          !CF_URL!!C_RESET!
)

echo.
echo !C_GRAY!  --------------------------------------!C_RESET!
echo !C_DIM!!C_GRAY!  !C_WHITE!bot stop!C_GRAY! shut down  !C_WHITE!bot tunnel!C_GRAY! new link  !C_WHITE!bot tunnel-stop!C_GRAY! kill tunnel!C_RESET!
goto :eof

:tunnel
set "TUNNEL_PORT=%~2"
if "%TUNNEL_PORT%"=="" set "TUNNEL_PORT=3000"
set "CF_CMD=%PROJECT_DIR%\.portable\cloudflared.exe"
if not exist "!CF_CMD!" (
    echo !C_RED!  [X] cloudflared not found at .portable\cloudflared.exe!C_RESET!
    goto :eof
)
echo !C_YELLOW!  ^> Generating new tunnel link on port %TUNNEL_PORT%...!C_RESET!
:: Kill existing tunnel
call :killPidFromFile "%SCRIPT_DIR%.codex-logs\trade.tunnel.pid" "Cloudflare Tunnel"
taskkill /im cloudflared.exe /f >nul 2>&1
if exist "%SCRIPT_DIR%.codex-logs\trade.tunnel.err.log" del /f /q "%SCRIPT_DIR%.codex-logs\trade.tunnel.err.log" >nul 2>&1
ping -n 2 127.0.0.1 >nul
:: Start new tunnel
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\run-detached.ps1" -FilePath "!CF_CMD!" -ArgumentList "tunnel --url http://localhost:%TUNNEL_PORT%" -WorkingDirectory "%PROJECT_DIR%" -PidFile "%SCRIPT_DIR%.codex-logs\trade.tunnel.pid" -LogOut "%SCRIPT_DIR%.codex-logs\trade.tunnel.out.log" -LogErr "%SCRIPT_DIR%.codex-logs\trade.tunnel.err.log"
:: Wait for URL to appear in logs
set "CF_URL="
for /l %%i in (1,1,20) do (
    if "!CF_URL!"=="" (
        for /f "tokens=*" %%a in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '%SCRIPT_DIR%.codex-logs\trade.tunnel.err.log') { (Get-Content '%SCRIPT_DIR%.codex-logs\trade.tunnel.err.log' -ErrorAction SilentlyContinue | Select-String 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | Select-Object -First 1).Matches[0].Value }" 2^>nul') do set "CF_URL=%%a"
        if "!CF_URL!"=="" ping -n 2 127.0.0.1 >nul
    )
)
if not "!CF_URL!"=="" (
    echo !C_GREEN!  [OK] !C_WHITE!New Tunnel!C_RESET!!C_GRAY!           !CF_URL! -> localhost:%TUNNEL_PORT%!C_RESET!
) else (
    echo !C_RED!  [X] Tunnel failed — check .codex-logs\trade.tunnel.err.log!C_RESET!
)
goto :eof

:tunnel_stop
echo !C_YELLOW!  ^> Stopping tunnel...!C_RESET!
call :killPidFromFile "%SCRIPT_DIR%.codex-logs\trade.tunnel.pid" "Cloudflare Tunnel"
taskkill /im cloudflared.exe /f >nul 2>&1
if exist "C:\Program Files\Tailscale\tailscale.exe" (
    "C:\Program Files\Tailscale\tailscale.exe" funnel reset >nul 2>&1
    "C:\Program Files\Tailscale\tailscale.exe" serve reset >nul 2>&1
)
echo !C_GREEN!  [OK] Tunnel stopped.!C_RESET!
goto :eof

:restart
call :stop_impl
echo !C_GRAY!    Waiting for ports to release...!C_RESET!
ping -n 3 127.0.0.1 >nul
goto start

:status
call :isRunning
if "%RUNNING%"=="1" (
    echo !C_GREEN!  [OK] !C_WHITE!Status!C_RESET!!C_GRAY!              running!C_RESET!
) else (
    echo !C_YELLOW!  [-] !C_WHITE!Status!C_RESET!!C_GRAY!              stopped!C_RESET!
)
goto :eof

:stop
call :stop_impl
goto :eof

:stop_impl
echo !C_YELLOW!  ^> Stopping Engine...!C_RESET!

if exist "%STATE_FILE%" del /f /q "%STATE_FILE%" >nul 2>&1
set "STOPPED=0"

call :killPidFromFile "%AI_PID_FILE%" "AI microservice"
call :killPidFromFile "%BACKEND_PID_FILE%" "backend api server"
call :killPidFromFile "%ENGINE_PID_FILE%" "trading engine"
call :killPidFromFile "%FRONTEND_PID_FILE%" "frontend"

:: Stop Portable PostgreSQL if it exists
if exist "%PROJECT_DIR%\.portable\pgsql\bin\pg_ctl.exe" (
    echo !C_GRAY!    +-- !C_DIM!Stopping PostgreSQL...!C_RESET!
    "%PROJECT_DIR%\.portable\pgsql\bin\pg_ctl.exe" stop -D "%PROJECT_DIR%\.portable\pgsql\data" >nul 2>&1
)

:: Kill Cloudflare tunnel
call :killPidFromFile "%SCRIPT_DIR%.codex-logs\trade.tunnel.pid" "Cloudflare Tunnel"
taskkill /im cloudflared.exe /f >nul 2>&1
if exist "C:\Program Files\Tailscale\tailscale.exe" "C:\Program Files\Tailscale\tailscale.exe" serve reset >nul 2>&1
:: Terminate any remaining zombie node/python processes from the project
call node "%SCRIPT_DIR%scripts\kill-zombies.mjs" >nul 2>&1

:: Clean up orphaned processes on known ports (deduplicate PIDs to avoid double-kill)
set "_KILLED_PIDS="
for %%P in (3000 8001 5000) do (
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":%%P" ^| findstr /C:"LISTENING" 2^>nul') do (
        if not "%%p"=="" if %%p neq 0 (
            echo !_KILLED_PIDS! | findstr /C:"[%%p]" >nul 2>&1
            if !errorlevel! NEQ 0 (
                taskkill /f /t /pid %%p >nul 2>&1
                if !errorlevel! EQU 0 (
                    echo !C_GRAY!    +-- !C_DIM!Stopped orphaned process PID %%p on port %%P!C_RESET!
                    set "STOPPED=1"
                    set "_KILLED_PIDS=!_KILLED_PIDS![%%p]"
                )
            )
        )
    )
)
set "_KILLED_PIDS="


if "%STOPPED%"=="0" (
  echo !C_GRAY!    No active processes were found.!C_RESET!
)
echo !C_GREEN!  [OK] Stopped.!C_RESET!
goto :eof

:isRunning
set "RUNNING=0"
set "BACKEND_RUNNING=0"
set "FRONTEND_RUNNING=0"
set "AI_RUNNING=0"

if exist "%BACKEND_PID_FILE%" (
    set /p BPID=<"%BACKEND_PID_FILE%"
    if not "!BPID!"=="" (
        tasklist /fi "pid eq !BPID!" 2>nul | findstr "!BPID!" >nul
        if !errorlevel! EQU 0 set "BACKEND_RUNNING=1"
    )
)

if exist "%AI_PID_FILE%" (
    set /p AIPID=<"%AI_PID_FILE%"
    if not "!AIPID!"=="" (
        tasklist /fi "pid eq !AIPID!" 2>nul | findstr "!AIPID!" >nul
        if !errorlevel! EQU 0 set "AI_RUNNING=1"
    )
)

:: Bot is running if both backend and AI processes are alive
if "%BACKEND_RUNNING%"=="1" if "%AI_RUNNING%"=="1" (
    set "RUNNING=1"
)

:: Double check netstat as fallback
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":5000" ^| findstr /C:"LISTENING" 2^>nul') do (
    if not "%%p"=="" if %%p neq 0 set "RUNNING=1"
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":8001" ^| findstr /C:"LISTENING" 2^>nul') do (
    if not "%%p"=="" if %%p neq 0 set "RUNNING=1"
)
exit /b 0

:killPidFromFile
set "PIDFILE=%~1"
set "LABEL=%~2"
if not exist "%PIDFILE%" exit /b 0
set /p PID=<"%PIDFILE%"
if "%PID%"=="" (
  del /f /q "%PIDFILE%" >nul 2>&1
  exit /b 0
)

tasklist /fi "pid eq %PID%" 2>nul | findstr "%PID%" >nul
if !errorlevel! EQU 0 (
  taskkill /f /t /pid %PID% >nul 2>&1
  if !errorlevel! EQU 0 (
    echo !C_GRAY!    +-- !C_DIM!Stopped %LABEL% PID %PID%!C_RESET!
    set "STOPPED=1"
  )
)
del /f /q "%PIDFILE%" >nul 2>&1
exit /b 0

:wait_pg
for /l %%i in (1,1,30) do (
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":5433" ^| findstr /C:"LISTENING" 2^>nul') do (
        if not "%%p"=="" if %%p neq 0 exit /b 0
    )
    ping -n 2 127.0.0.1 >nul
)
exit /b 0

:menu
call :isRunning
echo.
echo !C_GRAY!  ======================================!C_RESET!
if "%RUNNING%"=="1" (
    echo     !C_GREEN!Status: [RUNNING]!C_RESET! Bot is active.
) else (
    echo     !C_RED!Status: [STOPPED]!C_RESET! Bot is not running.
)
echo !C_GRAY!  ======================================!C_RESET!
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\menu.ps1" -Running "!BOT_RUNNING!"
set "MENU_OPT=!errorlevel!"

if "!MENU_OPT!"=="0" goto :eof
if "!MENU_OPT!"=="6" (
    call :tunnel_stop
    goto menu
)
if "!MENU_OPT!"=="5" (
    call :tunnel
    goto menu
)
if "!MENU_OPT!"=="4" (
    call :status
    goto menu
)
if "!MENU_OPT!"=="3" (
    call :restart
    goto menu
)
if "!MENU_OPT!"=="2" (
    call :stop
    goto menu
)
if "!MENU_OPT!"=="1" (
    call :start
    goto menu
)
goto menu

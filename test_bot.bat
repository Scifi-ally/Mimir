@echo off
setlocal enabledelayedexpansion

:: Define ESC character for ANSI colors
for /F %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "C_RESET=!ESC![0m"
set "C_GREEN=!ESC![32m"
set "C_CYAN=!ESC![36m"
set "C_PURPLE=!ESC![35m"
set "C_RED=!ESC![31m"
set "C_YELLOW=!ESC![33m"
set "C_GRAY=!ESC![90m"

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

set "ACTION=%~1"
if /i "%ACTION%"=="start" goto start
if /i "%ACTION%"=="stop" goto stop
if /i "%ACTION%"=="status" goto status
if /i "%ACTION%"=="restart" goto restart
if "%ACTION%"=="" goto toggle

echo !C_CYAN!Usage: bot [start^|stop^|status^|restart]!C_RESET!
exit /b 1

:print_banner
echo !C_CYAN!  __  __ _           _      !C_RESET!
echo !C_CYAN! ^|  \/  (_)         (_)     !C_RESET!
echo !C_CYAN! ^| \  / ^|_ _ __ ___  _ _ __ !C_RESET!
echo !C_CYAN! ^| ^|\/^| ^| ^| '_ ` _ \^| ^| '__^|!C_RESET!
echo !C_CYAN! ^| ^|  ^| ^| ^| ^| ^| ^| ^| ^| ^| ^|   !C_RESET!
echo !C_CYAN! ^|_^|  ^|_^|_^|_^| ^|_^| ^|_^|_^|_^|   !C_RESET!
echo !C_PURPLE!      Upstox Trading Bot!C_RESET!
echo.
exit /b 0

:toggle
call :isRunning
if "%RUNNING%"=="1" goto stop
goto start

:start
call :isRunning
if "%RUNNING%"=="1" (
    echo !C_YELLOW![bot] Already running. Use "bot stop" first.!C_RESET!
    goto status
)
call :print_banner
echo !C_GREEN![bot] Starting Mimir...!C_RESET!
:: Clean up any leftover zombie processes to prevent file locking issues
call node "%SCRIPT_DIR%scripts\kill-zombies.mjs" >nul 2>&1
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
    echo [ERROR] Python portable or virtual environment not found.
    echo Please run scripts\setup_portable.ps1 to install the portable runtime!
    goto stop
)

:: Start AI Service in hidden PowerShell window and capture PID
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '!PYTHON_CMD!' -ArgumentList '-u main.py' -WorkingDirectory '%PROJECT_DIR%\backend\ai_service' -RedirectStandardOutput '!AI_PID_FILE!.out.log' -RedirectStandardError '!AI_PID_FILE!.err.log' -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id > '!AI_PID_FILE!'"

:: Check for Portable PostgreSQL
if exist "%PROJECT_DIR%\.portable\pgsql\bin\pg_ctl.exe" (
    echo !C_GRAY![bot] Starting portable PostgreSQL server...!C_RESET!
    "%PROJECT_DIR%\.portable\pgsql\bin\pg_ctl.exe" start -D "%PROJECT_DIR%\.portable\pgsql\data" -o "-p 5433" >nul 2>&1
    
    :: Wait for Postgres to be ready
    for /l %%i in (1,1,30) do (
        for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":5433" ^| findstr /C:"LISTENING" 2^>nul') do (
            if not "%%p"=="" if %%p neq 0 goto :pg_ready
        )
        ping -n 2 127.0.0.1 >nul
    )
    :pg_ready
    
    :: Override DATABASE_URL so the node processes connect to the portable DB
    set "DATABASE_URL=postgresql://postgres:postgres@localhost:5433/upstox_bot"
    
    :: Automatically create the database and run migrations/setup
    "%PROJECT_DIR%\.portable\pgsql\bin\createdb.exe" -h localhost -p 5433 -U postgres upstox_bot >nul 2>&1
    echo !C_GRAY![bot] Running database setup scripts...!C_RESET!
    call !NODE_CMD! "%PROJECT_DIR%\backend\dist\migrate.mjs" >nul 2>&1
)

:: Start Backend processes (API Server + Trading Engine) in hidden PowerShell windows and capture PIDs
echo !C_GRAY![bot] Compiling backend...!C_RESET!
call !NODE_CMD! "%PROJECT_DIR%\backend\build.mjs" >nul 2>&1
echo !C_GRAY![bot] Starting backend and trading engine...!C_RESET!
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '!NODE_CMD!' -ArgumentList '--enable-source-maps ./dist/index.mjs' -WorkingDirectory '%PROJECT_DIR%\backend' -RedirectStandardOutput '!BACKEND_PID_FILE!.out.log' -RedirectStandardError '!BACKEND_PID_FILE!.err.log' -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id > '!BACKEND_PID_FILE!'"

:: Start Tailscale Funnel in the background
start /min "Tailscale Funnel" "C:\Program Files\Tailscale\tailscale.exe" funnel 3000

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
    if "%BACKEND_OK%"=="1" if "%AI_OK%"=="1" goto startup_check_done
    ping -n 2 127.0.0.1 >nul
)
:startup_check_done

if "%AI_OK%"=="0" (
    echo !C_RED![ERROR] AI Service failed to start on port 8001.!C_RESET!
    echo !C_RED!Check logs in .codex-logs!C_RESET!
) else (
    echo !C_GREEN![OK]!C_RESET! AI Service: http://localhost:8001
)

if "%BACKEND_OK%"=="0" (
    echo !C_RED![ERROR] Backend failed to start on port 5000.!C_RESET!
    echo !C_RED!Check logs in .codex-logs!C_RESET!
) else (
    echo !C_GREEN![OK]!C_RESET! Backend API: http://localhost:5000
    echo !C_GREEN![OK]!C_RESET! Frontend:    http://localhost:3000
)

for /f "delims=" %%a in ('powershell -NoProfile -Command "((& 'C:\Program Files\Tailscale\tailscale.exe' status --json 2>$null) | ConvertFrom-Json).Self.DNSName.TrimEnd('.')" 2^>nul') do set "TS_DNS=%%a"

if not "!TS_DNS!"=="" (
    echo !C_GREEN![OK]!C_RESET! Public Web:  https://!TS_DNS!
)
echo.
echo !C_GRAY!Use "bot stop" to stop.!C_RESET!
goto :eof

:restart
call :stop_impl
echo !C_GRAY!  Waiting for ports to release...!C_RESET!
timeout /t 2 /nobreak >nul
goto start

:status
call :isRunning
if "%RUNNING%"=="1" (
    echo !C_GREEN![bot] Status: running!C_RESET!
) else (
    echo !C_YELLOW![bot] Status: stopped!C_RESET!
)
goto :eof

:stop
call :stop_impl
goto :eof

:stop_impl
echo !C_YELLOW![bot] Stopping Mimir...!C_RESET!

if exist "%STATE_FILE%" del /f /q "%STATE_FILE%" >nul 2>&1
set "STOPPED=0"

call :killPidFromFile "%AI_PID_FILE%" "AI microservice"
call :killPidFromFile "%BACKEND_PID_FILE%" "backend api server"
call :killPidFromFile "%ENGINE_PID_FILE%" "trading engine"

:: Stop Portable PostgreSQL if it exists
if exist "%PROJECT_DIR%\.portable\pgsql\bin\pg_ctl.exe" (
    echo !C_GRAY![bot] Stopping portable PostgreSQL server...!C_RESET!
    "%PROJECT_DIR%\.portable\pgsql\bin\pg_ctl.exe" stop -D "%PROJECT_DIR%\.portable\pgsql\data" >nul 2>&1
)

:: Kill Tailscale funnel
taskkill /fi "windowtitle eq Tailscale Funnel*" >nul 2>&1
:: Terminate any remaining zombie node/python processes from the project
call node "%SCRIPT_DIR%scripts\kill-zombies.mjs" >nul 2>&1

:: Clean up port 8001 (AI Service)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":8001" ^| findstr /C:"LISTENING" 2^>nul') do (
    if not "%%p"=="" if %%p neq 0 (
        taskkill /f /t /pid %%p >nul 2>&1
        if !errorlevel! EQU 0 (
          echo !C_GRAY!  Stopped orphaned AI process PID %%p!C_RESET!
          set "STOPPED=1"
        )
    )
)

:: Clean up port 5000 (Backend)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":5000" ^| findstr /C:"LISTENING" 2^>nul') do (
    if not "%%p"=="" if %%p neq 0 (
        taskkill /f /t /pid %%p >nul 2>&1
        if !errorlevel! EQU 0 (
          echo !C_GRAY!  Stopped orphaned backend process PID %%p!C_RESET!
          set "STOPPED=1"
        )
    )
)


if "%STOPPED%"=="0" (
  echo !C_GRAY!  No active bot processes were running.!C_RESET!
)
echo !C_GREEN![OK] Stopped.!C_RESET!
goto :eof

:isRunning
set "RUNNING=0"
set "BACKEND_RUNNING=0"
set "ENGINE_RUNNING=0"
set "FRONTEND_RUNNING=0"
set "AI_RUNNING=0"

if exist "%BACKEND_PID_FILE%" (
    set /p BPID=<"%BACKEND_PID_FILE%"
    if not "!BPID!"=="" (
        tasklist /fi "pid eq !BPID!" 2>nul | findstr "!BPID!" >nul
        if !errorlevel! EQU 0 set "BACKEND_RUNNING=1"
    )
)

if exist "%ENGINE_PID_FILE%" (
    set /p EPID=<"%ENGINE_PID_FILE%"
    if not "!EPID!"=="" (
        tasklist /fi "pid eq !EPID!" 2>nul | findstr "!EPID!" >nul
        if !errorlevel! EQU 0 set "ENGINE_RUNNING=1"
    )
)

if exist "%AI_PID_FILE%" (
    set /p AIPID=<"%AI_PID_FILE%"
    if not "!AIPID!"=="" (
        tasklist /fi "pid eq !AIPID!" 2>nul | findstr "!AIPID!" >nul
        if !errorlevel! EQU 0 set "AI_RUNNING=1"
    )
)

if "%BACKEND_RUNNING%"=="1" if "%ENGINE_RUNNING%"=="1" if "%AI_RUNNING%"=="1" (
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
    echo !C_GRAY!  Stopped %LABEL% PID %PID%!C_RESET!
    set "STOPPED=1"
  )
)
del /f /q "%PIDFILE%" >nul 2>&1
exit /b 0

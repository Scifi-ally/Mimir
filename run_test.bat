@echo on
setlocal enabledelayedexpansion
set "SCRIPT_DIR=%~dp0"
set "STATE_FILE=%SCRIPT_DIR%.codex-logs\trade.running"
set "PROJECT_DIR=%CD%"
set "AI_PID_FILE=%SCRIPT_DIR%.codex-logs\trade.ai.pid"

echo Start test

:: Find Node.js path (Portable or Global)
set "NODE_CMD=node"
if exist "%PROJECT_DIR%\.portable\node\node.exe" set "NODE_CMD=%PROJECT_DIR%\.portable\node\node.exe"

:: Find Python path (Portable or .venv)
set "PYTHON_CMD="
if exist "%PROJECT_DIR%\.portable\python\python.exe" set "PYTHON_CMD=%PROJECT_DIR%\.portable\python\python.exe"
if "%PYTHON_CMD%"=="" if exist "%PROJECT_DIR%\.venv\Scripts\python.exe" set "PYTHON_CMD=%PROJECT_DIR%\.venv\Scripts\python.exe"
if "%PYTHON_CMD%"=="" if exist "%PROJECT_DIR%\..\.venv\Scripts\python.exe" set "PYTHON_CMD=%PROJECT_DIR%\..\.venv\Scripts\python.exe"

echo Python cmd is !PYTHON_CMD!

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '!PYTHON_CMD!' -ArgumentList '-u main.py' -WorkingDirectory '%PROJECT_DIR%\backend\ai_service' -RedirectStandardOutput '!AI_PID_FILE!.out.log' -RedirectStandardError '!AI_PID_FILE!.err.log' -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id > '!AI_PID_FILE!'"

echo End test

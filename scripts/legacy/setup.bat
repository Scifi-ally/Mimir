@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

:: Define ESC character for ANSI colors
for /F %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"
set "C_RESET=!ESC![0m"
set "C_CYAN=!ESC![38;2;103;232;249m"
set "C_WHITE=!ESC![38;2;245;245;245m"
set "C_GRAY=!ESC![38;2;115;115;115m"
set "C_RED=!ESC![38;2;248;113;113m"

echo !C_WHITE!  ======================================!C_RESET!
echo !C_CYAN!         MIMIR PORTABLE SETUP           !C_RESET!
echo !C_WHITE!  ======================================!C_RESET!
echo !C_GRAY!  This script will automatically download and configure all dependencies!C_RESET!
echo !C_GRAY!  (Node.js, Python, PostgreSQL, Redis) locally in the .portable folder.!C_RESET!
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup_portable.ps1"

if !errorlevel! NEQ 0 (
    echo.
    echo !C_RED!  [X] Setup encountered an error. Please check the logs above.!C_RESET!
    pause
    exit /b 1
)

echo.
echo !C_CYAN!  ======================================!C_RESET!
echo !C_WHITE!  SETUP COMPLETE!!C_RESET!
echo !C_CYAN!  ======================================!C_RESET!
echo !C_GRAY!  You can now start the bot by running: !C_WHITE!bot.bat start!C_RESET!
echo.
pause

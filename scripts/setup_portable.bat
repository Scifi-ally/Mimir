@echo off
echo ==============================================================
echo UpstoxBot Portable Runtime Setup
echo ==============================================================
echo This will download Node.js and Python locally into the pendrive.
echo Please ensure you have a stable internet connection.
echo.
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0setup_portable.ps1"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Setup failed.
    pause
    exit /b %ERRORLEVEL%
)
echo.
echo [OK] Setup completed successfully!
pause

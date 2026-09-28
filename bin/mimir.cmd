@echo off
setlocal
set "BIN_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%BIN_DIR%mimir.ps1" %*
exit /b %ERRORLEVEL%

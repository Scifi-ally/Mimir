@echo off
setlocal
set "ROOT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT_DIR%bin\mimir.ps1" %*
exit /b %ERRORLEVEL%

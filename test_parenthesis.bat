@echo off
setlocal enabledelayedexpansion
for /l %%i in (1,1,1) do (
    for /f "tokens=*" %%a in ('powershell -Command "if (1) { Write-Host 'Hello' }"') do set "A=%%a"
)
echo !A!

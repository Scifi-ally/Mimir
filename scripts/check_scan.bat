@echo off
setlocal enabledelayedexpansion

:loop
for /f %%A in ('powershell -Command "try { (curl.exe -s 'http://localhost:5000/api/system/offhours-scan' | ConvertFrom-Json).running } catch { 'error' }"') do (
    set running=%%A
)

echo [%date% %time%] Running: !running!

if "!running!"=="False" (
    echo Scan completed! Getting final results...
    powershell -Command "curl.exe -s 'http://localhost:5000/api/system/offhours-scan' | ConvertFrom-Json | ConvertTo-Json"
    goto end
)

if "!running!"=="error" (
    echo Connection error, retrying...
)

timeout /t 3 /nobreak
goto loop

:end
echo Done
pause

@echo off
set "AI_OK=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":8001" ^| findstr /C:"LISTENING" 2^>nul') do (
    if not "%%p"=="" if %%p neq 0 set "AI_OK=1"
    echo PID found: %%p
)
echo AI_OK is %AI_OK%

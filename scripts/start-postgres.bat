@echo off
set "SCRIPT_DIR=%~dp0"
set "PG_BIN=%SCRIPT_DIR%..\.portable\pgsql\bin\postgres.exe"
set "PG_DATA=%SCRIPT_DIR%..\.portable\pgsql\data"
if exist "%PG_DATA%\postmaster.pid" del /f /q "%PG_DATA%\postmaster.pid" >nul 2>&1
"%PG_BIN%" -D "%PG_DATA%" -p 5433

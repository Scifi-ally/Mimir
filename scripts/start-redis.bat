@echo off
REM Portable Redis, mirroring scripts\start-postgres.bat.
REM Bundled under .portable\redis so the app has a real cache/pubsub without a
REM system-wide install. Windows has no maintained in-tree Redis; Memurai's MSI
REM needs admin elevation, so the zip build is used instead.
set "SCRIPT_DIR=%~dp0"
set "REDIS_DIR=%SCRIPT_DIR%..\.portable\redis"
"%REDIS_DIR%\redis-server.exe" --port 6379 --bind 127.0.0.1 --appendonly yes --dir "%REDIS_DIR%"

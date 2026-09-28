# Downloads the portable Redis build into .portable\redis.
#
# Windows has no maintained in-tree Redis, and Memurai's MSI needs admin
# elevation that this script cannot assume. The zip build runs from a plain
# directory, matching how Postgres is already vendored under .portable\pgsql.
#
# Run once:  powershell -ExecutionPolicy Bypass -File scripts\install-redis.ps1
# Then start: powershell -ExecutionPolicy Bypass -File scripts\start-mimir-desktop.ps1
#
# NOTE: intentionally ASCII-only (see start-mimir-desktop.ps1 for why).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root ".portable\redis"

if (Test-Path (Join-Path $dest "redis-server.exe")) {
    Write-Host "Redis already present at $dest" -ForegroundColor DarkGray
    exit 0
}

$version = "5.0.14.1"
$url = "https://github.com/tporadowski/redis/releases/download/v$version/Redis-x64-$version.zip"
$zip = Join-Path $env:TEMP "mimir-redis-$version.zip"

Write-Host "Downloading Redis $version ..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 300

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Archive -Path $zip -DestinationPath $dest -Force
Remove-Item $zip -Force -ErrorAction SilentlyContinue

if (-not (Test-Path (Join-Path $dest "redis-server.exe"))) {
    Write-Host "FAILED: redis-server.exe not found after extraction" -ForegroundColor Red
    exit 1
}

Write-Host "Installed Redis $version to $dest" -ForegroundColor Green
Write-Host "Start the stack with: scripts\start-mimir-desktop.ps1" -ForegroundColor Cyan

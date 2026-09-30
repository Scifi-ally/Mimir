# Starts the full Mimir stack for the desktop app, in dependency order.
#
# Why this exists: bringing the app up previously meant starting Postgres,
# Redis, the AI service and the backend by hand, in the right order, with the
# portable Postgres needing its bin directory on PATH before it would start.
# Any step missed produced a confusing partial failure (silently degraded
# caches, ECONNREFUSED spam, or a backend that dies on boot).
#
# Everything here is idempotent: a service already listening is left alone, so
# this is safe to re-run.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\start-mimir-desktop.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start-mimir-desktop.ps1 -NoDesktop
#
# NOTE: intentionally ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless it carries a UTF-8 BOM, so non-ASCII characters corrupt the parse.

param(
    [switch]$NoDesktop
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot

function Test-Port([int]$Port) {
    return $null -ne (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq $Port } | Select-Object -First 1)
}

function Wait-Port([int]$Port, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $Port) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

# Poll for a process by name instead of sleeping a fixed amount. The previous
# `Start-Sleep -Seconds 20` was wrong in both directions: it gave up on a cold
# Rust build that needs minutes, and it made a warm start wait 20s for a window
# that was already up.
function Wait-Process([string]$Name, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $p = Get-Process -Name $Name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p) { return $p }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

$script:Timings = @{}

Write-Host ""
Write-Host "Mimir desktop launcher" -ForegroundColor Cyan
Write-Host "----------------------" -ForegroundColor Cyan

# --- 1 & 2. Postgres and Redis, started together ---------------------------
# These two are completely independent - neither talks to the other, and
# neither is a prerequisite for the AI service. The launcher used to start
# Postgres, block until it was listening, then start Redis and block again,
# so the slower of the two was pure added latency. Both are now kicked off
# first and awaited together.
#
# Postgres still needs its bin directory on PATH or every child dies with
# STATUS_DLL_INIT_FAILED (0xC0000142).
$dataStart = Get-Date

$pgStarted = $false
if (Test-Port 5433) {
    Write-Host "[1/5] Postgres already listening on 5433" -ForegroundColor DarkGray
} else {
    $pgBin = Join-Path $root ".portable\pgsql\bin"
    $pgData = Join-Path $root ".portable\pgsql\data"
    if ((Test-Path (Join-Path $pgBin "postgres.exe")) -and (Test-Path $pgData)) {
        $env:Path = "$pgBin;$env:Path"
        Write-Host "[1/5] Starting portable Postgres on 5433..." -ForegroundColor Cyan
        Start-Process -FilePath (Join-Path $pgBin "postgres.exe") `
            -ArgumentList "-D", $pgData, "-p", "5433" `
            -WindowStyle Hidden | Out-Null
        $pgStarted = $true
    } else {
        Write-Host "[1/5] Postgres binaries/data missing" -ForegroundColor Red
    }
}

# Without Redis the backend logs an unhandled ECONNREFUSED roughly every 5s and
# the cache/pubsub layer is dead.
$redisStarted = $false
if (Test-Port 6379) {
    Write-Host "[2/5] Redis already listening on 6379" -ForegroundColor DarkGray
} else {
    $redisDir = Join-Path $root ".portable\redis"
    if (Test-Path (Join-Path $redisDir "redis-server.exe")) {
        Write-Host "[2/5] Starting portable Redis on 6379..." -ForegroundColor Cyan
        Start-Process -FilePath (Join-Path $redisDir "redis-server.exe") `
            -ArgumentList "--port", "6379", "--bind", "127.0.0.1", "--appendonly", "yes", "--dir", $redisDir `
            -WindowStyle Hidden | Out-Null
        $redisStarted = $true
    } else {
        Write-Host "[2/5] Redis missing - run scripts\install-redis.ps1 once" -ForegroundColor Red
    }
}

if ($pgStarted -or $redisStarted) {
    if ($pgStarted) {
        if (Wait-Port 5433 40) { Write-Host "      postgres ready" -ForegroundColor Green }
        else { Write-Host "      postgres FAILED - check .portable\pgsql\data" -ForegroundColor Red }
    }
    if ($redisStarted) {
        if (Wait-Port 6379 25) { Write-Host "      redis ready" -ForegroundColor Green }
        else { Write-Host "      redis FAILED to start" -ForegroundColor Red }
    }
    $script:Timings["datastores"] = [math]::Round(((Get-Date) - $dataStart).TotalSeconds, 1)
}

# --- 3. AI service ----------------------------------------------------------
if (Test-Port 8001) {
    Write-Host "[3/5] AI service already listening on 8001" -ForegroundColor DarkGray
} else {
    $py = Join-Path $root ".venv\Scripts\python.exe"
    if (-not (Test-Path $py)) { $py = "python" }
    $aiDir = Join-Path $root "backend\ai_service"
    Write-Host "[3/5] Starting AI service on 8001 (first load pulls the models)..." -ForegroundColor Cyan
    Start-Process -FilePath $py `
        -ArgumentList "-m", "uvicorn", "main:app", "--app-dir", $aiDir, "--host", "127.0.0.1", "--port", "8001" `
        -WorkingDirectory $aiDir -WindowStyle Hidden | Out-Null
    if (Wait-Port 8001 180) { Write-Host "      ready" -ForegroundColor Green }
    else { Write-Host "      still starting - give it another minute" -ForegroundColor Yellow }
}

# --- 4. Backend -------------------------------------------------------------
if (Test-Port 5000) {
    Write-Host "[4/5] Backend already listening on 5000" -ForegroundColor DarkGray
} else {
    Write-Host "[4/5] Starting backend on 5000..." -ForegroundColor Cyan
    Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev" `
        -WorkingDirectory (Join-Path $root "backend") -WindowStyle Hidden | Out-Null
    if (Wait-Port 5000 120) { Write-Host "      ready" -ForegroundColor Green }
    else { Write-Host "      FAILED - see backend output" -ForegroundColor Red }
}

# --- 5. Desktop shell -------------------------------------------------------
# The Tauri shell starts Vite itself and reuses whatever is already listening.
if ($NoDesktop) {
    Write-Host "[5/5] Skipping desktop shell (-NoDesktop)" -ForegroundColor DarkGray
} else {
    $desktopStart = Get-Date
    $sysroot = (rustc --print sysroot 2>$null)
    if ($sysroot -and $sysroot.Contains(" ") -and (Test-Path "C:\rust-sysroot")) {
        # GNU ld receives the sysroot glob unquoted and splits on the spaces.
        $env:RUSTFLAGS = "--sysroot C:\rust-sysroot"
    }
    $env:CARGO_TARGET_DIR = Join-Path $root "frontend\src-tauri\target"
    Write-Host "[5/5] Launching the desktop app..." -ForegroundColor Cyan
    Start-Process -FilePath "npm.cmd" -ArgumentList "run", "tauri:dev" `
        -WorkingDirectory (Join-Path $root "frontend") -WindowStyle Hidden | Out-Null
    # Poll for the actual process. A cold Rust build takes minutes, so the old
    # fixed 20s sleep reported "app not detected" on every first build while
    # still burning 20s on a warm start where the window was already up.
    $app = Wait-Process "mimir" 420
    if ($app) {
        Write-Host "      app running (pid $($app.Id))" -ForegroundColor Green
    } else {
        Write-Host "      app not detected within 7 min - a Rust build is probably still running" -ForegroundColor Yellow
        Write-Host "      or failed; run 'npm run tauri:dev' in frontend\ to see the error" -ForegroundColor Yellow
    }
    $script:Timings["desktop"] = [math]::Round(((Get-Date) - $desktopStart).TotalSeconds, 1)
}

Write-Host ""
Write-Host "Status:" -ForegroundColor Cyan
foreach ($p in @(5433, 6379, 8001, 5000, 3000)) {
    $label = switch ($p) { 5433 { "postgres" } 6379 { "redis" } 8001 { "ai" } 5000 { "backend" } 3000 { "vite" } }
    $state = if (Test-Port $p) { "UP" } else { "down" }
    $color = if ($state -eq "UP") { "Green" } else { "DarkGray" }
    Write-Host ("  {0,-9} {1,5}  {2}" -f $label, $p, $state) -ForegroundColor $color
}

if ($script:Timings.Count -gt 0) {
    Write-Host ""
    Write-Host "Startup timings:" -ForegroundColor Cyan
    foreach ($k in @("datastores", "desktop")) {
        if ($script:Timings.ContainsKey($k)) {
            Write-Host ("  {0,-12} {1,6} s" -f $k, $script:Timings[$k]) -ForegroundColor DarkGray
        }
    }
}
Write-Host ""

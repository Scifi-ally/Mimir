# Stops the Mimir stack started by scripts\start-mimir-desktop.ps1.
#
# Why this exists: without it, restarting means hunting for four processes by
# hand, and killing the wrong node.exe takes down unrelated work. The launcher
# is idempotent, so a clean stop is what makes a re-run fast and predictable.
#
# Postgres and Redis are stopped last and only if this script is the one that
# would have started them, so a shared dev machine keeps its datastores.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\stop-mimir.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\stop-mimir.ps1 -KeepData
#
# NOTE: intentionally ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless it carries a UTF-8 BOM, so non-ASCII characters corrupt the parse.

param(
    # Leave Postgres and Redis running (they outlive the app between sessions).
    [switch]$KeepData
)

$ErrorActionPreference = "Continue"
$root = (Split-Path -Parent $PSScriptRoot).ToLower()

function Stop-ByName([string]$Name, [string]$Label) {
    $procs = @(Get-Process -Name $Name -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) {
        Write-Host ("  {0,-10} not running" -f $Label) -ForegroundColor DarkGray
        return
    }
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
    }
    Write-Host ("  {0,-10} stopped {1} process(es)" -f $Label, $procs.Count) -ForegroundColor Green
}

Write-Host ""
Write-Host "Mimir stop" -ForegroundColor Cyan
Write-Host "-----------" -ForegroundColor Cyan

# The desktop shell and the backend both run under node.exe, and vite runs under
# node.exe too. Stopping the desktop first lets its child tree unwind before the
# backend goes.
Write-Host "app and services:" -ForegroundColor Cyan
Stop-ByName "mimir" "app"
Stop-ByName "node" "node"

# The AI service is a python process running uvicorn, so it survives a kill of
# every Node process. It was left running by the first version of this script,
# which meant a restart silently kept the OLD code - exactly what happened
# after the health-reporting changes: the service answered with the previous
# field names while the working tree held the new ones.
#
# Scoped to processes whose command line names this repo, so an unrelated
# python process on the machine is never touched.
$repoNeedle = $root
$ours = @(
    Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($repoNeedle) }
)
if ($ours.Count -eq 0) {
    Write-Host ("  {0,-10} not running" -f "ai (python)") -ForegroundColor DarkGray
} else {
    foreach ($p in $ours) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
    }
    Write-Host ("  {0,-10} stopped {1} process(es)" -f "ai (python)", $ours.Count) -ForegroundColor Green
}

# Give the OS a moment to release the listening sockets before anything probes
# them, otherwise a restart can see a port still in TIME_WAIT as occupied.
Start-Sleep -Seconds 2

if (-not $KeepData) {
    Write-Host "datastores:" -ForegroundColor Cyan
    # Postgres is stopped gracefully on purpose. Force-killing it leaves a stale
    # postmaster.pid and a cluster that holds port 5433 while refusing every
    # connection - the launcher then reports "UP", and the backend dies on boot
    # with a connection timeout that points nowhere useful.
    $pgBin = Join-Path $root ".portable\pgsql\bin"
    $pgData = Join-Path $root ".portable\pgsql\data"
    $pgctl = Join-Path $pgBin "pg_ctl.exe"
    if ((Test-Path $pgctl) -and (Test-Path $pgData)) {
        $env:Path = "$pgBin;$env:Path"
        & $pgctl -D $pgData -m fast -w -t 30 stop 2>&1 | Out-Null
        $pidFile = Join-Path $pgData "postmaster.pid"
        if (Test-Path $pidFile) {
            # Only removed if pg_ctl left it behind; a live cluster still needs it.
            Start-Sleep -Milliseconds 500
            if (Test-Path $pidFile) {
                Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
                Write-Host "  postgres    stopped (stale pid cleared)" -ForegroundColor Green
            }
        } else {
            Write-Host "  postgres    stopped" -ForegroundColor Green
        }
    } else {
        Stop-ByName "postgres" "postgres"
    }
    Stop-ByName "redis-server" "redis"
} else {
    Write-Host "datastores: kept (-KeepData)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Stopped. Run scripts\start-mimir-desktop.ps1 to start again." -ForegroundColor Cyan
Write-Host ""

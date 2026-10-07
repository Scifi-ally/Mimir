<#
.SYNOPSIS
    Mimir Global CLI Launcher
.DESCRIPTION
    Controls the Mimir Algorithmic Trading Platform and launches the desktop/web app from any directory.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Action = "help",

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ESC = [char]27
$C_RESET = "$ESC[0m"
$C_GREEN = "$ESC[38;2;74;222;128m"
$C_CYAN = "$ESC[38;2;103;232;249m"
$C_PURPLE = "$ESC[38;2;168;130;255m"
$C_RED = "$ESC[38;2;248;113;113m"
$C_YELLOW = "$ESC[38;2;250;204;21m"
$C_GRAY = "$ESC[38;2;115;115;115m"
$C_WHITE = "$ESC[38;2;245;245;245m"
$C_BOLD = "$ESC[1m"
$C_DIM = "$ESC[2m"

# Locate project root directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path "$ScriptDir\..\bot.bat") {
    $MimirDir = (Resolve-Path "$ScriptDir\..").Path
} elseif ($env:MIMIR_DIR -and (Test-Path "$env:MIMIR_DIR\bot.bat")) {
    $MimirDir = (Resolve-Path "$env:MIMIR_DIR").Path
} elseif (Test-Path "C:\Users\Scifi-ally\Desktop\Mimir\bot.bat") {
    $MimirDir = "C:\Users\Scifi-ally\Desktop\Mimir"
} else {
    Write-Host "$C_RED[X] Could not locate Mimir project directory!$C_RESET"
    Write-Host "$C_GRAY    Please set MIMIR_DIR environment variable pointing to the Mimir folder.$C_RESET"
    exit 1
}

function Show-Banner {
    Write-Host "$C_WHITE  ======================================$C_RESET"
    Write-Host "$C_CYAN       MIMIR TRADING SYSTEM v2.5       $C_RESET"
    Write-Host "$C_WHITE  ======================================$C_RESET"
}

function Test-PortListening([int]$Port) {
    $tcp = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return [bool]$tcp
}

function Get-MimirStatus {
    $backend = Test-PortListening 5000
    $ai = Test-PortListening 8001
    $frontend = Test-PortListening 3000
    $db = Test-PortListening 5433
    $redis = Test-PortListening 6379
    return @{
        Backend = $backend
        AI = $ai
        Frontend = $frontend
        DB = $db
        Redis = $redis
        Running = ($backend -and $ai -and $frontend -and $db -and $redis)
    }
}

function Start-MimirServices {
    $status = Get-MimirStatus
    if ($status.Running) {
        Write-Host "$C_GREEN  [OK] All Mimir services (DB, Redis, AI, Backend, Frontend) are active.$C_RESET"
        return $true
    }

    Write-Host "$C_CYAN  > Starting Mimir background engines (PostgreSQL, Redis, AI, Backend, Frontend)...$C_RESET"
    Push-Location $MimirDir
    try {
        & cmd.exe /c "bot.bat start --headless"
    } finally {
        Pop-Location
    }

    # Verify ports
    Start-Sleep -Seconds 2
    $status = Get-MimirStatus
    if (-not $status.Backend) {
        Write-Host "$C_YELLOW  [*] Waiting for Backend API on :5000...$C_RESET"
        for ($i = 0; $i -lt 15; $i++) {
            Start-Sleep -Seconds 1
            if (Test-PortListening 5000) { break }
        }
    }
    return (Test-PortListening 5000)
}

function Show-Help {
    Show-Banner
    Write-Host ""
    Write-Host "$C_BOLD$C_WHITE  USAGE:$C_RESET"
    Write-Host "    $C_CYAN mimir start$C_RESET               Start trading engine and launch native desktop app"
    Write-Host "    $C_CYAN mimir start --web$C_RESET         Start trading engine and open web browser UI"
    Write-Host "    $C_CYAN mimir start --headless$C_RESET    Start trading engine in background only (no UI)"
    Write-Host "    $C_CYAN mimir desktop$C_RESET             Launch native Tauri desktop app window directly"
    Write-Host "    $C_CYAN mimir web$C_RESET                 Open web terminal at http://localhost:3000"
    Write-Host ""
    Write-Host "$C_BOLD$C_WHITE  MANAGEMENT:$C_RESET"
    Write-Host "    $C_CYAN mimir stop$C_RESET                Stop all engines, microservices, and processes"
    Write-Host "    $C_CYAN mimir status$C_RESET              Check health of all ports and services"
    Write-Host "    $C_CYAN mimir restart$C_RESET             Restart all services"
    Write-Host "    $C_CYAN mimir tunnel$C_RESET              Create Cloudflare/ngrok public tunnel"
    Write-Host "    $C_CYAN mimir tunnel-stop$C_RESET         Kill active public tunnel"
    Write-Host "    $C_CYAN mimir logs$C_RESET                Show recent execution and server logs"
    Write-Host "    $C_CYAN mimir menu$C_RESET                Open the interactive terminal menu"
    Write-Host ""
}

# Normalize Action
$Action = $Action.ToLower()

switch -Regex ($Action) {
    "^(start)$" {
        $isWeb = $RemainingArgs -match "(--web|-w|--browser|-browser)"
        $isHeadless = $RemainingArgs -match "(--headless|-b|--services|-s|--background)"
        $isDetach = $RemainingArgs -match "(--detach|-d|--detached)"

        Show-Banner
        $servicesOk = Start-MimirServices
        if (-not $servicesOk) {
            Write-Host "$C_RED  [X] Failed to verify backend startup. Check logs with 'mimir logs'.$C_RESET"
            exit 1
        }

        if ($isHeadless) {
            Write-Host "$C_GREEN  [OK] Mimir services active in background (Backend :5000, AI :8001, Frontend :3000, DB :5433, Redis :6379).$C_RESET"
            Write-Host "$C_DIM$C_GRAY  Use 'mimir desktop' to open UI or 'mimir stop' to shut down.$C_RESET"
            exit 0
        }

        if ($isWeb) {
            Write-Host "$C_GREEN  [OK] Opening Mimir Web Dashboard: http://localhost:3000$C_RESET"
            Start-Process "http://localhost:3000"
            exit 0
        }

        # DEFAULT: Launch Native Tauri Desktop App Window
        Write-Host "$C_CYAN  > Launching Mimir Desktop Application (Tauri v2)...$C_RESET"
        $tauriExe = Join-Path $MimirDir "frontend\src-tauri\target\debug\mimir.exe"
        if (Test-Path $tauriExe) {
            Start-Process -FilePath $tauriExe -WorkingDirectory (Join-Path $MimirDir "frontend\src-tauri")
            Write-Host "$C_GREEN  [OK] Native Mimir Desktop window launched.$C_RESET"
        } else {
            Push-Location $MimirDir
            try {
                Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm --prefix frontend run tauri:dev" -WorkingDirectory $MimirDir
                Write-Host "$C_GREEN  [OK] Native Mimir Desktop window starting via Tauri...$C_RESET"
            } finally {
                Pop-Location
            }
        }
        break
    }

    "^(desktop|app)$" {
        Show-Banner
        Start-MimirServices | Out-Null
        Write-Host "$C_CYAN  > Launching Mimir Desktop Application (Tauri v2)...$C_RESET"
        $tauriExe = Join-Path $MimirDir "frontend\src-tauri\target\debug\mimir.exe"
        if (Test-Path $tauriExe) {
            Start-Process -FilePath $tauriExe -WorkingDirectory (Join-Path $MimirDir "frontend\src-tauri")
            Write-Host "$C_GREEN  [OK] Native Mimir Desktop window launched.$C_RESET"
        } else {
            Push-Location $MimirDir
            try {
                Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm --prefix frontend run tauri:dev" -WorkingDirectory $MimirDir
                Write-Host "$C_GREEN  [OK] Native Mimir Desktop window starting via Tauri...$C_RESET"
            } finally {
                Pop-Location
            }
        }
        break
    }

    "^(web|browser)$" {
        Show-Banner
        Start-MimirServices | Out-Null
        Write-Host "$C_GREEN  [OK] Opening http://localhost:3000 in your browser...$C_RESET"
        Start-Process "http://localhost:3000"
        break
    }

    "^(stop)$" {
        Show-Banner
        Push-Location $MimirDir
        try {
            & cmd.exe /c "bot.bat stop"
        } finally {
            Pop-Location
        }
        break
    }

    "^(status)$" {
        Show-Banner
        $status = Get-MimirStatus
        Write-Host ""
        if ($status.DB) {
            Write-Host "  $C_GREEN[OK]$C_RESET $C_WHITE Database (PostgreSQL):  $C_RESET$C_CYAN port 5433$C_RESET"
        } else {
            Write-Host "  $C_RED[--]$C_RESET $C_GRAY Database (PostgreSQL):   offline (:5433)$C_RESET"
        }

        if ($status.Redis) {
            Write-Host "  $C_GREEN[OK]$C_RESET $C_WHITE Cache (Redis):          $C_RESET$C_CYAN port 6379$C_RESET"
        } else {
            Write-Host "  $C_RED[--]$C_RESET $C_GRAY Cache (Redis):           offline (:6379)$C_RESET"
        }

        if ($status.AI) {
            Write-Host "  $C_GREEN[OK]$C_RESET $C_WHITE AI Service (Laya/Jev):  $C_RESET$C_CYAN http://localhost:8001$C_RESET"
        } else {
            Write-Host "  $C_RED[--]$C_RESET $C_GRAY AI Service (Laya/Jev):   offline (:8001)$C_RESET"
        }

        if ($status.Backend) {
            Write-Host "  $C_GREEN[OK]$C_RESET $C_WHITE Backend API Server:     $C_RESET$C_CYAN http://localhost:5000$C_RESET"
        } else {
            Write-Host "  $C_RED[--]$C_RESET $C_GRAY Backend API Server:      offline (:5000)$C_RESET"
        }

        if ($status.Frontend) {
            Write-Host "  $C_GREEN[OK]$C_RESET $C_WHITE Frontend UI:            $C_RESET$C_CYAN http://localhost:3000$C_RESET"
        } else {
            Write-Host "  $C_RED[--]$C_RESET $C_GRAY Frontend UI:             offline (:3000)$C_RESET"
        }
        Write-Host ""
        break
    }

    "^(restart)$" {
        Show-Banner
        Push-Location $MimirDir
        try {
            & cmd.exe /c "bot.bat restart"
        } finally {
            Pop-Location
        }
        break
    }

    "^(tunnel)$" {
        Push-Location $MimirDir
        try {
            & cmd.exe /c "bot.bat tunnel"
        } finally {
            Pop-Location
        }
        break
    }

    "^(tunnel-stop)$" {
        Push-Location $MimirDir
        try {
            & cmd.exe /c "bot.bat tunnel-stop"
        } finally {
            Pop-Location
        }
        break
    }

    "^(logs)$" {
        $logDir = "$MimirDir\.codex-logs"
        if (Test-Path $logDir) {
            Write-Host "$C_CYAN  === Recent Logs in .codex-logs ===$C_RESET"
            Get-ChildItem -Path $logDir -Filter "*.log" | ForEach-Object {
                Write-Host "$C_YELLOW$($_.Name) ($([math]::Round($_.Length/1KB, 1)) KB):$C_RESET"
                Get-Content $_.FullName -Tail 5 -ErrorAction SilentlyContinue | ForEach-Object {
                    Write-Host "  $C_GRAY$_$C_RESET"
                }
                Write-Host ""
            }
        } else {
            Write-Host "$C_YELLOW  No .codex-logs folder found.$C_RESET"
        }
        break
    }

    "^(menu)$" {
        Push-Location $MimirDir
        try {
            & cmd.exe /c "bot.bat menu"
        } finally {
            Pop-Location
        }
        break
    }

    default {
        Show-Help
        break
    }
}

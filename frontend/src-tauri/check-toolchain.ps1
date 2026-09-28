# Desktop toolchain preflight for the Tauri shell.
#
# Building the desktop app on Windows needs an MSVC linker + Windows SDK, because
# the default x86_64-pc-windows-gnu toolchain's GNU ld.exe cannot link the Tauri
# binary ("export ordinal too large"). Without the SDK the failure appears about
# eight minutes into a build as a cryptic linker error, so this check runs first
# and reports exactly what is missing.
#
# Usage:
#   npm --prefix frontend run desktop:doctor
#   powershell -ExecutionPolicy Bypass -File frontend/src-tauri/check-toolchain.ps1
#
# NOTE: intentionally ASCII-only. Windows PowerShell 5.1 reads .ps1 files as ANSI
# unless they carry a UTF-8 BOM, so non-ASCII characters (em dashes, smart
# quotes) corrupt the parse. Do not add them to this file.

$ErrorActionPreference = "Continue"
$script:ok = $true

function Write-Ok   ($m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Warn ($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Bad  ($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:ok = $false }

Write-Host ""
Write-Host "Mimir desktop toolchain preflight" -ForegroundColor Cyan
Write-Host "-----------------------------------" -ForegroundColor Cyan

# [1/4] Rust toolchains
Write-Host ""
Write-Host "[1/4] Rust toolchains"
$rustc = Get-Command rustc -ErrorAction SilentlyContinue
if (-not $rustc) {
    Write-Bad "rustc not found. Install from https://rustup.rs/"
} else {
    Write-Ok "rustc present"
    $v = (rustc -vV) -join "`n"
    # NOTE: do not name this $host - it is a reserved PowerShell automatic variable.
    $rustHost = [regex]::Match($v, 'host: (\S+)').Groups[1].Value
    if ($rustHost -eq "x86_64-pc-windows-msvc") {
        Write-Ok "active toolchain is MSVC (correct for Tauri on Windows)"
    } else {
        Write-Warn "active toolchain is $rustHost"
    }
    $msvc = (& rustup toolchain list 2>$null) -match "stable-x86_64-pc-windows-msvc"
    if ($msvc) {
        Write-Ok "stable-x86_64-pc-windows-msvc toolchain installed"
    } else {
        Write-Bad "stable-x86_64-pc-windows-msvc NOT installed"
        Write-Host "         Fix: rustup toolchain install stable-x86_64-pc-windows-msvc"
    }
}

# [2/4] MSVC linker (the actual blocker)
Write-Host ""
Write-Host "[2/4] MSVC linker + Windows SDK"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = $null
if (Test-Path $vswhere) {
    $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
}
if ($vsPath) {
    Write-Ok "Visual Studio / Build Tools found"
    $toolsRoot = Join-Path $vsPath "VC\Tools\MSVC"
    $latest = Get-ChildItem $toolsRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($latest) {
        Write-Ok "MSVC toolset present ($($latest.Name))"
    } else {
        Write-Bad "MSVC toolset missing inside the install path"
    }
} else {
    Write-Bad "Visual Studio Build Tools NOT found - this is the blocker."
    Write-Host "         GNU ld cannot link Tauri (export ordinals exceed 65535)."
    Write-Host "         Install the free C++ build tools:"
    Write-Host "           winget install Microsoft.VisualStudio.2022.BuildTools --override --wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    Write-Host "         Then re-run this check."
}

# [3/4] Node toolchain
Write-Host ""
Write-Host "[3/4] Node toolchain"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $ver = node -v
    $maj = [int]($ver.TrimStart('v').Split('.')[0])
    if ($maj -ge 20) {
        Write-Ok "node $ver"
    } else {
        Write-Bad "node $ver is too old (need 20 or newer)"
    }
} else {
    Write-Bad "node not found"
}

# npm hoists @tauri-apps/cli to the workspace ROOT node_modules, so check both
# the frontend-local and the root location before reporting it missing.
$repoRootForCli = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$cliCandidates = @(
    (Join-Path $PSScriptRoot "..\node_modules\@tauri-apps\cli"),
    (Join-Path $repoRootForCli "node_modules\@tauri-apps\cli")
)
$cliFound = $false
foreach ($c in $cliCandidates) {
    if (Test-Path $c) { $cliFound = $true; break }
}
if ($cliFound) {
    Write-Ok "Tauri CLI installed"
} else {
    Write-Warn "Tauri CLI missing - run: npm install"
}

# [4/4] Project state
Write-Host ""
Write-Host "[4/4] Project"
$distIndex = Join-Path $PSScriptRoot "..\dist\index.html"
if (Test-Path $distIndex) {
    Write-Ok "frontend built (dist/index.html present)"
} else {
    Write-Warn "frontend not built - the Tauri build will run it automatically"
}

# src-tauri -> frontend -> repo root
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$pyExe = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (Test-Path $pyExe) {
    Write-Ok "AI service venv present (.venv)"
} else {
    Write-Warn "no .venv - the app will fall back to 'python' on PATH for the AI service"
}

if (Test-Path (Join-Path $repoRoot "backend\package.json")) {
    Write-Ok "backend present"
} else {
    Write-Bad "backend/package.json missing - the desktop app cannot start the API"
}

Write-Host ""
if ($script:ok) {
    Write-Host "RESULT: ready - run:  npm run desktop" -ForegroundColor Green
    exit 0
} else {
    Write-Host "RESULT: not ready - fix the FAIL items above, then re-run." -ForegroundColor Red
    exit 1
}

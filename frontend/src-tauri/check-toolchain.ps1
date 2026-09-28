# Desktop toolchain preflight for the Tauri shell.
#
# Building the desktop app on Windows does NOT require the MSVC toolchain. The
# original version of this check claimed GNU ld could not link Tauri
# ("export ordinal too large"), which was a misdiagnosis: the real cause was the
# mobile-only `cdylib` crate-type in src-tauri/Cargo.toml, which must export every
# symbol and therefore overruns PE's 65535 export-ordinal cap. With `cdylib`
# removed the default GNU toolchain links the desktop binary correctly.
#
# The remaining GNU requirement is a space-free sysroot, because ld receives the
# rustc sysroot glob unquoted. This check verifies that and reports the one-line
# junction fix when it is needed.
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

# [2/4] Linker
#
# MSVC is the conventional path, but it is NOT required. The GNU toolchain links
# the desktop binary fine now that the mobile-only `cdylib` crate-type is gone
# from src-tauri/Cargo.toml - `cdylib` must export every symbol, which is what
# blew past PE's 65535 export-ordinal cap ("too many exported symbols"). The
# desktop app links the plain `lib` (rlib) target, so GNU ld is sufficient.
#
# The one real GNU-toolchain requirement is a sysroot path with no spaces. If
# rustc lives under something like "C:\Program Files\Rust stable GNU 1.98", ld
# receives the sysroot glob unquoted and fails with
# "could not open 'C:\Program'" / "could not open 'Files\Rust'". A space-free
# junction (below) fixes it without moving the toolchain.
Write-Host ""
Write-Host "[2/4] Linker + Windows SDK"

$sysroot = (rustc --print sysroot) 2>$null
$sysrootHasSpace = $false
if ($sysroot) { $sysrootHasSpace = $sysroot.Contains(" ") }

$spaceFreeSysroot = "C:\rust-sysroot"
$sysrootOk = $false
if ($sysroot) {
    if (-not $sysrootHasSpace) {
        $sysrootOk = $true
        Write-Ok "sysroot is space-free ($sysroot)"
    } elseif (Test-Path $spaceFreeSysroot) {
        $sysrootOk = $true
        Write-Ok "space-free sysroot junction present ($spaceFreeSysroot)"
        Write-Host "         Use:  set RUSTFLAGS=--sysroot $spaceFreeSysroot"
    } else {
        Write-Bad "rustc sysroot contains spaces, which breaks GNU ld: $sysroot"
        Write-Host "         Fix (no reinstall needed):"
        Write-Host "           New-Item -ItemType Junction -Path $spaceFreeSysroot -Target `"$sysroot`""
        Write-Host "         Then set RUSTFLAGS=--sysroot $spaceFreeSysroot and re-run."
    }
}

# Confirm the desktop binary actually links, rather than assuming.
if ($sysrootOk) {
    Write-Ok "GNU ld is sufficient for the desktop target (cdylib removed from Cargo.toml)"
} else {
    Write-Host "         Or install the free C++ build tools and use the MSVC toolchain:"
    Write-Host "           winget install Microsoft.VisualStudio.2022.BuildTools --override --wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
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

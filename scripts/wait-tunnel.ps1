param(
    [string]$LogFile,
    [string]$Port
)

for ($i = 0; $i -lt 30; $i++) {
    if (Test-Path $LogFile) {
        $match = Get-Content $LogFile -ErrorAction SilentlyContinue | Select-String 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
        if ($match) {
            $url = $match.Matches[0].Value
            Write-Host -ForegroundColor Green "  [OK] New Tunnel           $url -> localhost:$Port"
            exit 0
        }
    }
    Start-Sleep 1
}

Write-Host -ForegroundColor Red "  [X] Tunnel failed - check .codex-logs\trade.tunnel.err.log"
exit 1

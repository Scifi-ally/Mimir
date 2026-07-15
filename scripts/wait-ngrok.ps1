param(
    [string]$Port
)

for ($i = 0; $i -lt 30; $i++) {
    try {
        $response = Invoke-RestMethod -Uri http://127.0.0.1:4040/api/tunnels -ErrorAction Stop
        if ($response -and $response.tunnels -and $response.tunnels.Count -gt 0) {
            $url = $response.tunnels[0].public_url
            Write-Host -ForegroundColor Green "  [OK] New Tunnel           $url -> localhost:$Port"
            exit 0
        }
    } catch {
        # API not up yet, ignore and retry
    }
    Start-Sleep 1
}

Write-Host -ForegroundColor Red "  [X] Tunnel failed - ngrok API did not respond in time."
exit 1

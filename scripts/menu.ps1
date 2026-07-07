param($Running)

$ESC = [char]27
$C_RESET = "$ESC[0m"
$C_GREEN = "$ESC[38;2;74;222;128m"
$C_CYAN = "$ESC[38;2;103;232;249m"
$C_PURPLE = "$ESC[38;2;168;130;255m"
$C_RED = "$ESC[38;2;248;113;113m"
$C_GRAY = "$ESC[38;2;115;115;115m"
$C_WHITE = "$ESC[38;2;245;245;245m"
$C_DIM = "$ESC[2m"
$C_BOLD = "$ESC[1m"
$C_BLUE = "$ESC[38;2;96;165;250m"

$options = @(
    "Exit",
    "Start",
    "Stop",
    "Restart",
    "Status",
    "Tunnel",
    "Stop Tunnel"
)

$selectedIndex = 1

Write-Host ""
# Store the cursor position so we can overwrite just the menu section
$startTop = [Console]::CursorTop

while ($true) {
    [Console]::SetCursorPosition(0, $startTop)
    
    Write-Host "$C_GRAY  ======================================$C_RESET"
    if ($Running -eq "1") {
        Write-Host "    $C_GREEN`Status: [RUNNING]$C_RESET Bot is active.   "
    } else {
        Write-Host "    $C_RED`Status: [STOPPED]$C_RESET Bot is not running.   "
    }
    Write-Host "$C_GRAY  ======================================$C_RESET"
    Write-Host ""

    for ($i = 0; $i -lt $options.Length; $i++) {
        if ($i -eq $selectedIndex) {
            Write-Host "  $C_WHITE> $C_CYAN$($options[$i])$C_RESET                      "
        } else {
            Write-Host "    $C_GRAY$($options[$i])$C_RESET                      "
        }
    }
    
    Write-Host ""
    Write-Host "  $C_DIM${C_GRAY}Use Up/Down arrows to navigate, Enter to select$C_RESET"

    $key = [Console]::ReadKey($true).Key
    if ($key -eq 'UpArrow') {
        $selectedIndex = [math]::Max(0, $selectedIndex - 1)
    } elseif ($key -eq 'DownArrow') {
        $selectedIndex = [math]::Min($options.Length - 1, $selectedIndex + 1)
    } elseif ($key -eq 'Enter') {
        break
    }
}
Write-Host ""
exit $selectedIndex

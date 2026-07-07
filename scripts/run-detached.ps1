param(
    [Parameter(Mandatory=$true)]
    [string]$FilePath,

    [Parameter(Mandatory=$false)]
    [string]$ArgumentList = "",

    [Parameter(Mandatory=$true)]
    [string]$WorkingDirectory,

    [Parameter(Mandatory=$true)]
    [string]$PidFile,

    [Parameter(Mandatory=$true)]
    [string]$LogOut,

    [Parameter(Mandatory=$true)]
    [string]$LogErr
)

# Escape internal double quotes for cmd.exe
$ArgumentList = $ArgumentList -replace '"', '\"'

# We use cmd.exe to handle output redirection, because Win32_Process doesn't natively redirect IO.
# The outermost quotes are for cmd.exe /c
$cmdArgs = "/c `"`"$FilePath`" $ArgumentList > `"$LogOut`" 2> `"$LogErr`"`""

$startup = ([wmiclass]"Win32_ProcessStartup").CreateInstance()
$startup.ShowWindow = 0 # SW_HIDE

# Win32_Process Create completely detaches the process from the Windows Terminal / Console Job Object,
# meaning it will survive if the user closes the command prompt window.
$result = Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList "cmd.exe $cmdArgs", $WorkingDirectory, $startup

if ($result.ReturnValue -eq 0) {
    # The PID returned is for cmd.exe. 
    # Because bot.bat uses `taskkill /f /t /pid`, killing this cmd.exe PID will also kill the Node/Python child tree!
    $result.ProcessId | Out-File -FilePath $PidFile -Encoding ASCII
} else {
    Write-Error "Failed to start detached process. ReturnCode: $($result.ReturnValue)"
}

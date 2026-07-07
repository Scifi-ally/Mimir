$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PortableDir = Join-Path $ProjectRoot ".portable"

Write-Host "Creating .portable directory at $PortableDir..."
if (!(Test-Path $PortableDir)) {
    New-Item -ItemType Directory -Path $PortableDir | Out-Null
}

# --- Node.js Portable Setup ---
$NodeDir = Join-Path $PortableDir "node"
if (!(Test-Path $NodeDir)) {
    Write-Host "Downloading Node.js v20.12.2 Portable..."
    $NodeZip = Join-Path $PortableDir "node.zip"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.12.2/node-v20.12.2-win-x64.zip" -OutFile $NodeZip
    Write-Host "Extracting Node.js..."
    Expand-Archive -Path $NodeZip -DestinationPath $PortableDir -Force
    Rename-Item -Path (Join-Path $PortableDir "node-v20.12.2-win-x64") -NewName "node"
    Remove-Item -Path $NodeZip -Force
    Write-Host "Node.js portable ready."
} else {
    Write-Host "Node.js portable already exists."
}

# --- Python Portable Setup ---
$PythonDir = Join-Path $PortableDir "python"
if (!(Test-Path $PythonDir)) {
    Write-Host "Downloading Python 3.11.8 Embeddable..."
    $PythonZip = Join-Path $PortableDir "python.zip"
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.11.8/python-3.11.8-embed-amd64.zip" -OutFile $PythonZip
    Write-Host "Extracting Python..."
    New-Item -ItemType Directory -Path $PythonDir | Out-Null
    Expand-Archive -Path $PythonZip -DestinationPath $PythonDir -Force
    Remove-Item -Path $PythonZip -Force

    Write-Host "Configuring Python for pip (uncommenting import site)..."
    $PthFile = Join-Path $PythonDir "python311._pth"
    $PthContent = Get-Content $PthFile
    $PthContent = $PthContent -replace "#import site", "import site"
    Set-Content -Path $PthFile -Value $PthContent

    Write-Host "Downloading and installing pip..."
    $GetPipFile = Join-Path $PortableDir "get-pip.py"
    Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $GetPipFile
    $PythonExe = Join-Path $PythonDir "python.exe"
    & $PythonExe $GetPipFile
    Remove-Item -Path $GetPipFile -Force

    Write-Host "Installing project requirements (this will take a while)..."
    $RequirementsFile = Join-Path $ProjectRoot "backend\ai_service\requirements.txt"
    & $PythonExe -m pip install -r $RequirementsFile

    Write-Host "Python portable ready."
} else {
    Write-Host "Python portable already exists."
}

# --- PostgreSQL Portable Setup ---
$PgsqlDir = Join-Path $PortableDir "pgsql"
if (!(Test-Path $PgsqlDir)) {
    Write-Host "Downloading PostgreSQL 16.2 Portable..."
    $PgsqlZip = Join-Path $PortableDir "pgsql.zip"
    # Download the official EnterpriseDB binaries
    Invoke-WebRequest -Uri "https://get.enterprisedb.com/postgresql/postgresql-16.2-1-windows-x64-binaries.zip" -OutFile $PgsqlZip
    Write-Host "Extracting PostgreSQL..."
    Expand-Archive -Path $PgsqlZip -DestinationPath $PortableDir -Force
    Remove-Item -Path $PgsqlZip -Force

    # The zip extracts a folder named "pgsql"
    Write-Host "Initializing Database Cluster..."
    $InitDbExe = Join-Path $PgsqlDir "bin\initdb.exe"
    $DataDir = Join-Path $PgsqlDir "data"
    
    # Run initdb to create the cluster. Use a superuser name 'postgres' and no password or simple password
    $PassFile = Join-Path $PortableDir "pg_pass.txt"
    "postgres" | Out-File -FilePath $PassFile -Encoding ASCII
    & $InitDbExe -D $DataDir -U postgres -A md5 --pwfile=$PassFile
    Remove-Item -Path $PassFile -Force
    
    Write-Host "PostgreSQL portable ready."
} else {
    Write-Host "PostgreSQL portable already exists."
}

Write-Host "Setup complete! You can now use bot.bat to start the bot on any laptop."

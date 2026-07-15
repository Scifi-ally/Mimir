$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PortableDir = Join-Path $ProjectRoot ".portable"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

Write-Host "Creating .portable directory at $PortableDir..."
if (!(Test-Path $PortableDir)) {
    New-Item -ItemType Directory -Path $PortableDir | Out-Null
}

# --- Node.js Portable Setup ---
$NodeDir = Join-Path $PortableDir "node"
if (!(Test-Path $NodeDir)) {
    Write-Host "Downloading Node.js v20.12.2 Portable..."
    $NodeZip = Join-Path $PortableDir "node.zip"
    curl.exe -fL "https://nodejs.org/dist/v20.12.2/node-v20.12.2-win-x64.zip" -o $NodeZip
    if (!(Test-Path $NodeZip) -or (Get-Item $NodeZip).Length -eq 0) {
        Write-Host "Error: Download failed, Node.js zip is empty or missing." -ForegroundColor Red
        exit 1
    }
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
    curl.exe -fL "https://www.python.org/ftp/python/3.11.8/python-3.11.8-embed-amd64.zip" -o $PythonZip
    if (!(Test-Path $PythonZip) -or (Get-Item $PythonZip).Length -eq 0) {
        Write-Host "Error: Download failed, Python zip is empty or missing." -ForegroundColor Red
        exit 1
    }
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
    curl.exe -fL "https://get.enterprisedb.com/postgresql/postgresql-16.2-1-windows-x64-binaries.zip" -o $PgsqlZip
    if (!(Test-Path $PgsqlZip) -or (Get-Item $PgsqlZip).Length -eq 0) {
        Write-Host "Error: Download failed, PostgreSQL zip is empty or missing." -ForegroundColor Red
        exit 1
    }
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

# --- Redis Portable Setup ---
$RedisDir = Join-Path $PortableDir "redis"
if (!(Test-Path $RedisDir)) {
    Write-Host "Downloading Redis 5.0.14 Portable for Windows..."
    $RedisZip = Join-Path $PortableDir "redis.zip"
    # Using tporadowski's Redis port for Windows
    curl.exe -fL "https://github.com/tporadowski/redis/releases/download/v5.0.14.1/Redis-x64-5.0.14.1.zip" -o $RedisZip
    if (!(Test-Path $RedisZip) -or (Get-Item $RedisZip).Length -eq 0) {
        Write-Host "Error: Download failed, Redis zip is empty or missing." -ForegroundColor Red
        exit 1
    }
    Write-Host "Extracting Redis..."
    New-Item -ItemType Directory -Path $RedisDir | Out-Null
    Expand-Archive -Path $RedisZip -DestinationPath $RedisDir -Force
    Remove-Item -Path $RedisZip -Force
    Write-Host "Redis portable ready."
} else {
    Write-Host "Redis portable already exists."
}

# --- ENV Initialization ---
Write-Host "Checking .env files..."
$EnvFile = Join-Path $ProjectRoot ".env"
$EnvLocalFile = Join-Path $ProjectRoot ".env.local"
$EnvExampleFile = Join-Path $ProjectRoot ".env.example"

if (!(Test-Path $EnvExampleFile)) {
    Write-Host "Warning: .env.example not found. Creating a basic .env file..."
    "UPSTOXBOT_ADMIN_TOKEN=your_secure_token_here" | Out-File -FilePath $EnvFile -Encoding ASCII
} else {
    if (!(Test-Path $EnvFile)) {
        Write-Host "Creating .env from .env.example..."
        Copy-Item -Path $EnvExampleFile -Destination $EnvFile
    }
    if (!(Test-Path $EnvLocalFile)) {
        Write-Host "Creating .env.local from .env.example..."
        Copy-Item -Path $EnvExampleFile -Destination $EnvLocalFile
    }
}

# --- NPM Install ---
Write-Host "Installing NPM dependencies for the project..."
$NpmExe = Join-Path $NodeDir "npm.cmd"
if (!(Test-Path $NpmExe)) {
    # Fallback to global npm if portable npm isn't found (though it should be there)
    $NpmExe = "npm"
}
Write-Host "Running npm install in $ProjectRoot..."
Set-Location -Path $ProjectRoot
& $NpmExe install
if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: npm install encountered issues. You might need to run it manually." -ForegroundColor Yellow
}

Write-Host "Setup complete! You can now use bot.bat (or setup.bat) to start the bot on any laptop."

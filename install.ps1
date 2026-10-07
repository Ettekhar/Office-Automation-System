# ============================================================
#  Maintenance Mailer - Auto Installer
#  Run this on any Windows PC to install & launch the mailer.
#
#  Basic (Setup Wizard on first run):
#    irm https://raw.githubusercontent.com/Ettekhar/Office-Automation-System/main/install.ps1 | iex
#
#  With credentials baked in (from the dashboard "Generate Command" button):
#    $env:MAILER_CREDS='<base64>'; irm https://...install.ps1 | iex
# ============================================================

$REPO_URL    = "https://github.com/Ettekhar/Office-Automation-System.git"
$NODE_URL    = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
$NODE_MSI    = "$env:TEMP\node-installer.msi"

function Write-Step($msg) { Write-Host ""; Write-Host "  >> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!]  $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "    [X]  $msg" -ForegroundColor Red }
function Write-Utf8NoBom($path, $text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

Clear-Host
Write-Host ""
Write-Host "  ========================================================" -ForegroundColor Magenta
Write-Host "          MAINTENANCE MAILER - AUTO INSTALLER             " -ForegroundColor Magenta
Write-Host "  ========================================================" -ForegroundColor Magenta
Write-Host ""

# -- Step 0: Determine Target Directory ----------------------
# If current folder is already the project, use it!
$currentDir = (Get-Location).Path
$isCurrentDirProject = (Test-Path "$currentDir\src\server.js") -and (Test-Path "$currentDir\package.json")

if ($isCurrentDirProject) {
    $INSTALL_DIR = $currentDir
    Write-Host "  [DIR] Using existing project folder: $INSTALL_DIR" -ForegroundColor Gray
} else {
    $INSTALL_DIR = "$env:USERPROFILE\maintenance-mailer"
}

# -- Detect baked-in credentials -----------------------------
$hasCreds = $env:MAILER_CREDS -and $env:MAILER_CREDS.Length -gt 10
if ($hasCreds) {
    Write-Host "  [KEY] Credentials detected - setup wizard will be skipped." -ForegroundColor Green
    Write-Host ""
}

# -- Step 1: Check / Install Node.js -------------------------
Write-Step "Checking Node.js..."

$nodeInstalled = $false
try {
    $nodeVer = & node --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $nodeVer) { Write-OK "Node.js found: $nodeVer"; $nodeInstalled = $true }
} catch {}

if (-not $nodeInstalled) {
    Write-Warn "Node.js not found. Downloading installer..."
    try {
        Invoke-WebRequest -Uri $NODE_URL -OutFile $NODE_MSI -UseBasicParsing
        Write-Host "    Installing Node.js (this may take a minute)..." -ForegroundColor Gray
        Start-Process msiexec.exe -ArgumentList "/i `"$NODE_MSI`" /quiet /norestart" -Wait
        Remove-Item $NODE_MSI -Force -ErrorAction SilentlyContinue
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")
        $nodeVer = & node --version 2>$null
        Write-OK "Node.js installed: $nodeVer"
    } catch {
        Write-Fail "Failed to install Node.js automatically."
        Write-Host "  Please install manually from: https://nodejs.org" -ForegroundColor Yellow
        Read-Host "  Press Enter to open nodejs.org"
        Start-Process "https://nodejs.org/en/download"
        exit 1
    }
}

# -- Step 2: Check Git ---------------------------------------
Write-Step "Checking Git..."
$gitInstalled = $false
try {
    $gitVer = & git --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $gitVer) { Write-OK "Git found: $gitVer"; $gitInstalled = $true }
} catch {}
if (-not $gitInstalled) { Write-Warn "Git not found - will download via ZIP if needed." }

# -- Step 3: Check / Download / Update project ---------------
Write-Step "Setting up project at: $INSTALL_DIR"

$projectFilesExist = (Test-Path "$INSTALL_DIR\src\server.js") -and (Test-Path "$INSTALL_DIR\package.json")

if ($projectFilesExist) {
    Write-OK "Project files already exist - skipping download."
    if (Test-Path "$INSTALL_DIR\.git") {
        Write-Host "    Checking for updates from GitHub..." -ForegroundColor Gray
        try {
            & git -C $INSTALL_DIR pull --ff-only 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { Write-OK "Project updated from GitHub" }
        } catch {}
    }
} elseif ($gitInstalled) {
    Write-Host "    Cloning from GitHub..." -ForegroundColor Gray
    try {
        & git clone --quiet $REPO_URL $INSTALL_DIR 2>$null
        if ($LASTEXITCODE -ne 0 -or (-not (Test-Path "$INSTALL_DIR\package.json"))) {
            throw "git clone failed"
        }
        Write-OK "Project cloned successfully"
    } catch {
        Write-Warn "Git clone failed - trying ZIP download fallback..."
        $ZIP_URL     = "https://github.com/Ettekhar/Office-Automation-System/archive/refs/heads/main.zip"
        $ZIP_FILE    = "$env:TEMP\mailer-main.zip"
        $EXTRACT_DIR = "$env:TEMP\mailer-extract"
        try {
            Invoke-WebRequest -Uri $ZIP_URL -OutFile $ZIP_FILE -UseBasicParsing
            if (Test-Path $EXTRACT_DIR) { Remove-Item $EXTRACT_DIR -Recurse -Force -ErrorAction SilentlyContinue }
            Expand-Archive -Path $ZIP_FILE -DestinationPath $EXTRACT_DIR -Force
            $extracted = Get-ChildItem $EXTRACT_DIR | Select-Object -First 1
            if (-not (Test-Path $INSTALL_DIR)) { New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null }
            Copy-Item "$($extracted.FullName)\*" $INSTALL_DIR -Recurse -Force
            Remove-Item $ZIP_FILE    -Force -ErrorAction SilentlyContinue
            Remove-Item $EXTRACT_DIR -Recurse -Force -ErrorAction SilentlyContinue
            Write-OK "Project downloaded via ZIP"
        } catch { Write-Fail "Download failed: $_"; Read-Host "Press Enter to exit"; exit 1 }
    }
} else {
    $ZIP_URL     = "https://github.com/Ettekhar/Office-Automation-System/archive/refs/heads/main.zip"
    $ZIP_FILE    = "$env:TEMP\mailer-main.zip"
    $EXTRACT_DIR = "$env:TEMP\mailer-extract"
    Write-Host "    Downloading ZIP from GitHub..." -ForegroundColor Gray
    try {
        Invoke-WebRequest -Uri $ZIP_URL -OutFile $ZIP_FILE -UseBasicParsing
        if (Test-Path $EXTRACT_DIR) { Remove-Item $EXTRACT_DIR -Recurse -Force -ErrorAction SilentlyContinue }
        Expand-Archive -Path $ZIP_FILE -DestinationPath $EXTRACT_DIR -Force
        $extracted = Get-ChildItem $EXTRACT_DIR | Select-Object -First 1
        if (-not (Test-Path $INSTALL_DIR)) { New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null }
        Copy-Item "$($extracted.FullName)\*" $INSTALL_DIR -Recurse -Force
        Remove-Item $ZIP_FILE    -Force -ErrorAction SilentlyContinue
        Remove-Item $EXTRACT_DIR -Recurse -Force -ErrorAction SilentlyContinue
        Write-OK "Project downloaded via ZIP"
    } catch { Write-Fail "Download failed: $_"; Read-Host "Press Enter to exit"; exit 1 }
}

# -- Step 4: npm install --------------------------------------
Write-Step "Checking Node.js dependencies..."
$nmDir = Join-Path $INSTALL_DIR "node_modules"
if (-not (Test-Path $nmDir)) {
    Write-Host "    Running npm install (this only happens once)..." -ForegroundColor Gray
    Push-Location $INSTALL_DIR
    & npm install --no-audit --no-fund 2>$null | Out-Null
    Pop-Location
    Write-OK "Dependencies installed"
} else {
    Write-OK "Dependencies already installed"
}

# -- Step 5: Inject credentials (if baked in) ----------------
if ($hasCreds) {
    Write-Step "Injecting credentials..."
    try {
        $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:MAILER_CREDS))
        $creds   = $decoded | ConvertFrom-Json

        # Write service-account.json if included
        $saJson = $creds._SA_JSON
        if ($saJson) {
            $saPath = Join-Path $INSTALL_DIR "service-account.json"
            Write-Utf8NoBom $saPath $saJson
            Write-OK "service-account.json written"
        }

        # Build .env from credential keys
        $envPath    = Join-Path $INSTALL_DIR ".env"
        $envLines   = @("# Auto-generated by Maintenance Mailer installer", "GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./service-account.json", "")
        $credProps  = $creds.PSObject.Properties | Where-Object { $_.Name -notlike '_*' }
        $dbVars     = @{}
        foreach ($prop in $credProps) {
            $envLines += "$($prop.Name)=$($prop.Value)"
            $dbVars[$prop.Name] = $prop.Value
        }
        $envText = $envLines -join [System.Environment]::NewLine
        Write-Utf8NoBom $envPath $envText
        Write-OK ".env written with $($credProps.Count) credential(s)"

        # Save to database (data/mailer-credentials.json)
        $dataDir = Join-Path $INSTALL_DIR "data"
        if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
        $saParsed = $null
        if ($saJson) {
            try { $saParsed = $saJson | ConvertFrom-Json } catch {}
        }
        $dbPayload = @{
            updatedAt = (Get-Date -Format "o")
            description = "OfficeOS Mailer & Integration Credentials Database"
            vars = $dbVars
            serviceAccount = $saParsed
        }
        $jsonPayload = $dbPayload | ConvertTo-Json -Depth 10
        Write-Utf8NoBom (Join-Path $dataDir "mailer-credentials.json") $jsonPayload
        Write-OK "Database credentials written (data/mailer-credentials.json)"

        # Write setup-complete flag so wizard is skipped
        Write-Utf8NoBom (Join-Path $dataDir ".setup-complete") (Get-Date -Format "o")
        Write-OK "Setup wizard skipped (credentials already configured)"
    } catch {
        Write-Warn "Could not inject credentials: $_"
        Write-Warn "The setup wizard will open in your browser instead."
    }
}

# -- Step 6: Desktop shortcut ---------------------------------
Write-Step "Checking desktop shortcut..."
try {
    $batContent = "@echo off`r`ncd /d `"%~dp0`"`r`nstart /b cmd /c `"timeout /t 2 >nul ^&^& start http://localhost:3000`"`r`nnode src/server.js`r`npause"
    $batPath    = Join-Path $INSTALL_DIR "START-HERE.bat"
    if (-not (Test-Path $batPath)) { $batContent | Set-Content -Path $batPath -Encoding ASCII }

    $shortcutPath = "$env:USERPROFILE\Desktop\Maintenance Mailer.lnk"
    if (-not (Test-Path $shortcutPath)) {
        $wsh = New-Object -ComObject WScript.Shell
        $sc  = $wsh.CreateShortcut($shortcutPath)
        $sc.TargetPath       = $batPath
        $sc.WorkingDirectory = $INSTALL_DIR
        $sc.Description      = "Launch Maintenance Mailer"
        $sc.IconLocation     = "shell32.dll,12"
        $sc.Save()
        Write-OK "Desktop shortcut created"
    } else {
        Write-OK "Desktop shortcut already exists"
    }
} catch { Write-Warn "Could not create shortcut (non-critical): $_" }

# -- Step 7: Launch -------------------------------------------
Write-Host ""
Write-Host "  ========================================================" -ForegroundColor Green
Write-Host "      SETUP COMPLETE - LAUNCHING NOW                      " -ForegroundColor Green
Write-Host "  ========================================================" -ForegroundColor Green
Write-Host ""

# Check if server is already running on port 3000
$serverRunning = $false
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $async = $tcp.BeginConnect("127.0.0.1", 3000, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(800, $false)
    if ($ok -and $tcp.Connected) {
        $tcp.EndConnect($async)
        $serverRunning = $true
    }
    $tcp.Close()
} catch {}

if ($serverRunning) {
    Write-OK "Server is already running on http://localhost:3000"
    Write-Host "  Opening dashboard in your browser..." -ForegroundColor Green
    Start-Process "http://localhost:3000"
    Write-Host ""
    Write-Host "  All done! Everything is up to date." -ForegroundColor Cyan
    return
}

if ($hasCreds) {
    Write-Host "  Dashboard opens at: http://localhost:3000" -ForegroundColor White
} else {
    Write-Host "  First-run Setup Wizard opens at: http://localhost:3000/setup" -ForegroundColor White
    Write-Host "  Follow the 3 steps to enter your credentials." -ForegroundColor Gray
}
Write-Host ""
Write-Host "  Press Ctrl+C in this window to stop the server." -ForegroundColor Gray
Write-Host ""

Start-Job -ScriptBlock { Start-Sleep 3; Start-Process "http://localhost:3000" } | Out-Null

Push-Location $INSTALL_DIR
& node src/server.js
Pop-Location

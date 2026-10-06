# ============================================================
#  Maintenance Mailer — Auto Installer
#  Run this on any Windows PC to install & launch the mailer.
#
#  One-liner to download and run this script:
#  irm https://raw.githubusercontent.com/Ettekhar/Office-Automation-System/main/install.ps1 | iex
# ============================================================

$ErrorActionPreference = "Stop"
$REPO_URL  = "https://github.com/Ettekhar/Office-Automation-System.git"
$INSTALL_DIR = "$env:USERPROFILE\maintenance-mailer"
$NODE_URL  = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi"
$NODE_MSI  = "$env:TEMP\node-installer.msi"

function Write-Step($msg) {
    Write-Host ""
    Write-Host "  ► $msg" -ForegroundColor Cyan
}

function Write-OK($msg) {
    Write-Host "    ✅ $msg" -ForegroundColor Green
}

function Write-Warn($msg) {
    Write-Host "    ⚠  $msg" -ForegroundColor Yellow
}

function Write-Fail($msg) {
    Write-Host "    ❌ $msg" -ForegroundColor Red
}

Clear-Host
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "  ║       MAINTENANCE MAILER — AUTO INSTALLER            ║" -ForegroundColor Magenta
Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Magenta
Write-Host ""

# ── Step 1: Check / Install Node.js ─────────────────────────
Write-Step "Checking Node.js..."

$nodeInstalled = $false
try {
    $nodeVer = & node --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-OK "Node.js found: $nodeVer"
        $nodeInstalled = $true
    }
} catch {}

if (-not $nodeInstalled) {
    Write-Warn "Node.js not found. Downloading installer..."
    Write-Host "    Downloading from $NODE_URL ..." -ForegroundColor Gray

    try {
        Invoke-WebRequest -Uri $NODE_URL -OutFile $NODE_MSI -UseBasicParsing
        Write-Host "    Installing Node.js (this may take a minute)..." -ForegroundColor Gray
        Start-Process msiexec.exe -ArgumentList "/i `"$NODE_MSI`" /quiet /norestart" -Wait
        Remove-Item $NODE_MSI -Force -ErrorAction SilentlyContinue

        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")

        $nodeVer = & node --version 2>&1
        Write-OK "Node.js installed: $nodeVer"
    } catch {
        Write-Fail "Failed to install Node.js automatically."
        Write-Host ""
        Write-Host "  Please install Node.js manually from: https://nodejs.org" -ForegroundColor Yellow
        Write-Host "  Then run this script again." -ForegroundColor Yellow
        Write-Host ""
        Read-Host "  Press Enter to open nodejs.org in your browser"
        Start-Process "https://nodejs.org/en/download"
        exit 1
    }
}

# ── Step 2: Check / Install Git ─────────────────────────────
Write-Step "Checking Git..."

$gitInstalled = $false
try {
    $gitVer = & git --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-OK "Git found: $gitVer"
        $gitInstalled = $true
    }
} catch {}

if (-not $gitInstalled) {
    Write-Warn "Git not found — will download ZIP instead."
}

# ── Step 3: Download / Update the project ───────────────────
Write-Step "Setting up project at: $INSTALL_DIR"

if (Test-Path "$INSTALL_DIR\.git") {
    Write-Host "    Project already exists — pulling latest updates..." -ForegroundColor Gray
    try {
        & git -C $INSTALL_DIR pull --ff-only 2>&1 | Out-Null
        Write-OK "Project updated from GitHub"
    } catch {
        Write-Warn "Git pull failed — continuing with existing files"
    }
} elseif ($gitInstalled) {
    Write-Host "    Cloning from GitHub..." -ForegroundColor Gray
    if (Test-Path $INSTALL_DIR) {
        Remove-Item $INSTALL_DIR -Recurse -Force
    }
    & git clone $REPO_URL $INSTALL_DIR 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Git clone failed. Check your internet connection."
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-OK "Project downloaded"
} else {
    # Fallback: download ZIP from GitHub
    $ZIP_URL = "https://github.com/Ettekhar/Office-Automation-System/archive/refs/heads/main.zip"
    $ZIP_FILE = "$env:TEMP\mailer-main.zip"
    $EXTRACT_DIR = "$env:TEMP\mailer-extract"

    Write-Host "    Downloading ZIP from GitHub..." -ForegroundColor Gray
    try {
        Invoke-WebRequest -Uri $ZIP_URL -OutFile $ZIP_FILE -UseBasicParsing
        if (Test-Path $EXTRACT_DIR) { Remove-Item $EXTRACT_DIR -Recurse -Force }
        Expand-Archive -Path $ZIP_FILE -DestinationPath $EXTRACT_DIR -Force

        $extracted = Get-ChildItem $EXTRACT_DIR | Select-Object -First 1
        if (Test-Path $INSTALL_DIR) { Remove-Item $INSTALL_DIR -Recurse -Force }
        Move-Item $extracted.FullName $INSTALL_DIR

        Remove-Item $ZIP_FILE -Force -ErrorAction SilentlyContinue
        Remove-Item $EXTRACT_DIR -Recurse -Force -ErrorAction SilentlyContinue
        Write-OK "Project downloaded via ZIP"
    } catch {
        Write-Fail "Download failed: $_"
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# ── Step 4: npm install ──────────────────────────────────────
Write-Step "Installing Node.js dependencies..."

$nmDir = Join-Path $INSTALL_DIR "node_modules"
if (-not (Test-Path $nmDir)) {
    Write-Host "    Running npm install (this only happens once)..." -ForegroundColor Gray
    Push-Location $INSTALL_DIR
    & npm install --silent 2>&1 | Out-Null
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "npm install failed."
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-OK "Dependencies installed"
} else {
    Write-OK "Dependencies already installed"
}

# ── Step 5: Create desktop shortcut ─────────────────────────
Write-Step "Creating desktop shortcut..."

try {
    $shortcutPath = "$env:USERPROFILE\Desktop\Maintenance Mailer.lnk"
    $batPath = Join-Path $INSTALL_DIR "START-HERE.bat"

    # Copy START-HERE.bat if it doesn't exist (older install)
    if (-not (Test-Path $batPath)) {
        @'
@echo off
cd /d "%~dp0"
start /b cmd /c "timeout /t 2 >nul && start http://localhost:3000"
node src/server.js
pause
'@ | Set-Content $batPath
    }

    $wsh = New-Object -ComObject WScript.Shell
    $sc  = $wsh.CreateShortcut($shortcutPath)
    $sc.TargetPath       = $batPath
    $sc.WorkingDirectory = $INSTALL_DIR
    $sc.Description      = "Launch Maintenance Mailer"
    $sc.IconLocation     = "shell32.dll,12"
    $sc.Save()
    Write-OK "Desktop shortcut created"
} catch {
    Write-Warn "Could not create shortcut (non-critical): $_"
}

# ── Step 6: Launch ───────────────────────────────────────────
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║   ✅  INSTALLATION COMPLETE — LAUNCHING NOW          ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  The app will open at: http://localhost:3000" -ForegroundColor White
Write-Host "  If first run → Setup Wizard will guide you through credentials." -ForegroundColor Gray
Write-Host ""
Write-Host "  Press Ctrl+C in the server window to stop the server." -ForegroundColor Gray
Write-Host ""

# Open browser after 3s
Start-Job -ScriptBlock {
    Start-Sleep 3
    Start-Process "http://localhost:3000"
} | Out-Null

# Start the server
Push-Location $INSTALL_DIR
& node src/server.js
Pop-Location

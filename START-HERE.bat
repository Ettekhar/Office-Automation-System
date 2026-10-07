@echo off
title Maintenance Mailer — Local Server
color 0A

echo.
echo ============================================================
echo   MAINTENANCE MAILER  —  Local Email Server
echo ============================================================
echo.

:: Check if Node.js is installed
where node >nul 2>&1
if errorlevel 1 (
    color 0C
    echo [ERROR] Node.js is NOT installed on this PC.
    echo.
    echo  Please download and install Node.js from:
    echo  https://nodejs.org/en/download  (LTS version)
    echo.
    echo  After installing, run this file again.
    pause
    start https://nodejs.org/en/download
    exit /b 1
)

:: Show Node version
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  Node.js detected: %NODE_VER%

:: Check if node_modules exists; install if missing
if not exist "node_modules\" (
    echo.
    echo  [SETUP] node_modules not found. Installing dependencies...
    echo  This only happens once. Please wait...
    echo.
    call npm install
    if errorlevel 1 (
        color 0C
        echo.
        echo [ERROR] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo.
    echo  Dependencies installed successfully!
)

:: Check if .env exists
if not exist ".env" (
    color 0E
    echo.
    echo  [WARNING] No .env file found!
    echo  Copying .env.example to .env ...
    copy ".env.example" ".env" >nul
    echo.
    echo  Please open .env and fill in your SMTP credentials before sending.
    echo  (The server will still start, but emails won't send without valid SMTP config.)
    echo.
    timeout /t 4 >nul
    color 0A
)

echo.
echo  Starting server...
echo.
echo  Once started, the dashboard opens at:
echo  ^> http://localhost:3000
echo.
echo  Email Reports tab:
echo  ^> http://localhost:3000/mailer
echo.
echo  Press Ctrl+C to stop the server.
echo ============================================================
echo.

:: Open browser after a short delay (2 seconds)
start /b cmd /c "timeout /t 2 >nul && start http://localhost:3000"

:: Start the dashboard server
node src/server.js

echo.
echo  Server stopped.
pause

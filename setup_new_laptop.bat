@echo off
setlocal enabledelayedexpansion
title Maliban Printer System - New Laptop Setup

echo ========================================================
echo   MALIBAN IT - PRINTER SYSTEM NEW LAPTOP SETUP
echo ========================================================
echo.

:: Check for Administrator privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Administrator privileges required!
    echo     Please right-click this file and select "Run as administrator".
    echo.
    pause
    exit /b 1
)

:: Navigate to project directory
cd /d "%~dp0"
echo [*] Project Directory: %~dp0
echo.

:: 1. Check Node.js
echo [*] Step 1/6: Checking Node.js installation...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [-] Node.js is NOT installed.
    echo [*] Attempting automatic installation via winget...
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    if %errorlevel% neq 0 (
        echo [!] Failed to install Node.js automatically.
        echo     Please manually install Node.js LTS from: https://nodejs.org/
        pause
        exit /b 1
    )
    echo [+] Node.js installed. Please restart this script after the installer completes.
    pause
    exit /b 0
) else (
    for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
    for /f "tokens=*" %%v in ('npm -v') do set NPM_VER=%%v
    echo [+] Node.js is installed (!NODE_VER!) with npm (!NPM_VER!).
)
echo.

:: 2. Configure PowerShell Execution Policy & WinRM
echo [*] Step 2/6: Configuring PowerShell Execution Policy and WinRM...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force; winrm quickconfig -q; Enable-PSRemoting -Force; Set-Item WSMan:\localhost\Client\TrustedHosts -Value '*' -Force; Restart-Service WinRM"
if %errorlevel% equ 0 (
    echo [+] WinRM and Remote PowerShell configured successfully.
) else (
    echo [!] Notice: WinRM configuration returned code %errorlevel%.
)
echo.

:: 3. Setup .env file
echo [*] Step 3/6: Checking configuration file (.env)...
if not exist .env (
    if exist .env.example (
        copy .env.example .env >nul
        echo [+] Created .env from .env.example
    ) else (
        echo [!] Warning: .env.example not found.
    )
) else (
    echo [+] .env configuration file exists.
)
echo.

:: 4. Install Dependencies
echo [*] Step 4/6: Installing project dependencies (npm install)...
call npm install
if %errorlevel% neq 0 (
    echo [-] npm install encountered an error. Please check your internet connection.
    pause
    exit /b 1
)
echo [+] Dependencies installed successfully.
echo.

:: 5. Initialize Database
echo [*] Step 5/6: Initializing and seeding database...
call npm run seed
echo.

:: 6. Run System Verification Tests
echo [*] Step 6/6: Running self-test suite...
call npm test
if %errorlevel% neq 0 (
    echo [!] Unit tests encountered issues. Review log above.
) else (
    echo [+] All system tests passed.
)
echo.

echo ========================================================
echo   SETUP COMPLETED!
echo ========================================================
echo You can now double-click "start_system.bat" to run the system.
echo.
pause

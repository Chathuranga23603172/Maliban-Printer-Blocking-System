@echo off
title Maliban Printer Tracking System
cd /d "%~dp0"

:: Ensure Node.js path is available even if shell hasn't refreshed environment
if exist "%LOCALAPPDATA%\Programs\nodejs" (
    set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"
)
if exist "C:\Program Files\nodejs" (
    set "PATH=C:\Program Files\nodejs;%PATH%"
)

echo ========================================================
echo   MALIBAN IT - PRINT MANAGEMENT & RESTRICTION SYSTEM
echo ========================================================
echo.
echo [*] Starting server at http://localhost:3000
echo [*] Supervisor Portal: http://localhost:3000/
echo [*] IT Admin Portal:   http://localhost:3000/admin
echo ========================================================
echo.

:: Automatically open Supervisor portal in default browser after a brief delay
start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"

:: Start Node.js server
call npm start
pause

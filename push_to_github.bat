@echo off
title Push Maliban Printer Blocking System to GitHub
color 0b
echo ======================================================================
echo   MALIBAN IT - PUSH PROJECT TO GITHUB
echo ======================================================================
echo   Repository: https://github.com/Chathuranga23603172/Maliban-Printer-Blocking-System.git
echo   Branch:     main
echo   Account:    Chathuranga23603172 (it23603172@my.sliit.lk)
echo ======================================================================
echo.
echo Pushing committed code to GitHub...
echo (If a browser window opens, click 'Sign In / Authorize' to complete login)
echo.

git push -u origin main

if %ERRORLEVEL% equ 0 (
    echo.
    echo [SUCCESS] Code successfully pushed to GitHub!
    echo View repository at: https://github.com/Chathuranga23603172/Maliban-Printer-Blocking-System
) else (
    echo.
    echo [NOTICE] If authentication failed or requested a token:
    echo 1. Generate a GitHub Personal Access Token at: https://github.com/settings/tokens (select 'repo' scope)
    echo 2. Run: git remote set-url origin https://^<YOUR_TOKEN^>@github.com/Chathuranga23603172/Maliban-Printer-Blocking-System.git
    echo 3. Run: git push -u origin main
)

echo.
pause

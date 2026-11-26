@echo off
setlocal
title Test PC Connection & WinRM - Maliban IT
cd /d "%~dp0"

echo ========================================================
echo   TEST REMOTE WORKSTATION WINRM / SPOOLER ACCESS
echo ========================================================
echo.
set /p TARGET_PC="Enter PC Hostname or IP to test (e.g. FIN-PC01): "

if "%TARGET_PC%"=="" (
    echo [!] No PC name entered. Exiting.
    pause
    exit /b 1
)

echo.
echo [*] Testing connection to %TARGET_PC%...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Write-Host '[1/3] Testing WinRM Port 5985...' -ForegroundColor Cyan; " ^
    "$port = Test-NetConnection -ComputerName '%TARGET_PC%' -Port 5985 -WarningAction SilentlyContinue; " ^
    "if ($port.TcpTestSucceeded) { Write-Host '  [+] Port 5985 OPEN' -ForegroundColor Green } else { Write-Host '  [-] Port 5985 CLOSED or BLOCKED by Firewall' -ForegroundColor Red }; " ^
    "Write-Host '`n[2/3] Testing WinRM Protocol (Test-WsMan)...' -ForegroundColor Cyan; " ^
    "try { Test-WsMan -ComputerName '%TARGET_PC%' -ErrorAction Stop | Out-Null; Write-Host '  [+] WinRM service responded OK' -ForegroundColor Green } catch { Write-Host ('  [-] WinRM Failed: ' + $_.Exception.Message) -ForegroundColor Red }; " ^
    "Write-Host '`n[3/3] Querying Spooler Service Status...' -ForegroundColor Cyan; " ^
    "try { $svc = Invoke-Command -ComputerName '%TARGET_PC%' -ScriptBlock { Get-Service -Name Spooler } -ErrorAction Stop; Write-Host ('  [+] Spooler Status: ' + $svc.Status + ' (Startup: ' + $svc.StartType + ')') -ForegroundColor Green } catch { Write-Host ('  [-] Invoke-Command Failed: ' + $_.Exception.Message) -ForegroundColor Red }"

echo.
pause

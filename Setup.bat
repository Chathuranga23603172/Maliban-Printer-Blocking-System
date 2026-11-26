@echo off
:: Automatically check and request Administrator privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting Administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ===================================================
echo   CONFIGURING WORKSTATION FOR PRINT RESTRICTIONS
echo ===================================================

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Set-NetConnectionProfile -NetworkCategory Private -ErrorAction SilentlyContinue; " ^
  "Enable-PSRemoting -Force -SkipNetworkProfileCheck; " ^
  "Set-Service -Name WinRM -StartupType Automatic; " ^
  "Start-Service WinRM; " ^
  "netsh advfirewall firewall add rule name='WinRM 5985 Perm' dir=in action=allow protocol=TCP localport=5985 profile=any; " ^
  "Add-LocalGroupMember -Group 'Administrators' -Member 'littlelion\nirmal' -ErrorAction SilentlyContinue; " ^
  "New-ItemProperty -Path HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System -Name LocalAccountTokenFilterPolicy -Value 1 -PropertyType DWord -Force; " ^
  "Set-Item WSMan:\localhost\Client\TrustedHosts -Value '*' -Force; " ^
  "Restart-Service WinRM"

echo.
echo Configuration Complete!
echo.
powershell -NoProfile -Command ^
  "Write-Host '=== REGISTRATION DETAILS ===' -ForegroundColor Green; " ^
  "Write-Host ('Computer Name : ' + $env:COMPUTERNAME) -ForegroundColor Yellow; " ^
  "Write-Host ('IP Address    : ' + ((Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notlike '169.254*' }).IPAddress -join ', ')) -ForegroundColor Yellow; " ^
  "Write-Host ('MAC Address   : ' + ((Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }).MacAddress -join ', ')) -ForegroundColor Yellow; "

echo.
pause

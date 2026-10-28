@echo off
setlocal enabledelayedexpansion
title FamilyTrip dev launcher

REM ============================================================
REM  FamilyTrip local dev launcher
REM  Double-click before testing in WeChat DevTools.
REM  Starts MySQL (3306) then backend (3000), each in its own window.
REM
REM  Idempotent: if a port is ALREADY listening, that step is skipped,
REM  so double-clicking twice (or while another copy runs) is safe.
REM
REM  Keep both windows open. Closing one stops that service.
REM  All text is ASCII on purpose: non-ASCII in .cmd breaks on GBK.
REM ============================================================

set "MYSQLD=C:\wb_mysql843\mysql-8.4.3-winx64\bin\mysqld.exe"
set "MYSQLDATA=C:\wb_mysql843\mysql-8.4.3-winx64\data"
set "PROJ=%~dp0"
set "LAN=10.23.30.90"

echo ==============================================
echo   FamilyTrip local dev launcher
echo ==============================================
echo.

REM ---------- 1) MySQL ----------
netstat -ano | findstr /R ":3306 .*LISTENING" >nul 2>&1
if not errorlevel 1 goto :mysql_up

echo [1/2] Starting MySQL on port 3306 ...
start "FamilyTrip MySQL" "%MYSQLD%" --datadir="%MYSQLDATA%" --port=3306
goto :mysql_wait

:mysql_up
echo [1/2] MySQL already listening on 3306 - skip start.
goto :mysql_ready

:mysql_wait
echo     waiting for 3306 to accept connections ...
set /a W=0
:mysql_poll
set /a W+=1
netstat -ano | findstr /R ":3306 .*LISTENING" >nul 2>&1
if not errorlevel 1 goto :mysql_ready
if !W! GEQ 25 goto :mysql_slow
timeout /t 1 /nobreak >nul
goto :mysql_poll

:mysql_slow
echo [WARN] 3306 not ready after 25s. Starting backend anyway;
echo        if it logs "Can't reach database server", restart it.
goto :backend

:mysql_ready
echo     MySQL is ready.
echo.

REM ---------- 2) Backend ----------
REM  If 3000 is taken, try to stop the holder so THIS window owns the service.
REM  If taskkill is denied (sandboxed process), the script says so explicitly.
:backend
set "P3000="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R ":3000 .*LISTENING"') do if not defined P3000 set "P3000=%%p"
if not defined P3000 goto :backend_start

echo [2/2] Port 3000 is in use by PID !P3000! - trying to take over ...
taskkill /PID !P3000! /F >nul 2>&1
if errorlevel 1 goto :backend_blocked
timeout /t 2 /nobreak >nul
echo       stopped. starting our own instance ...
goto :backend_start

:backend_blocked
echo       [WARN] Could not stop PID !P3000! (owned by another session).
echo              Ask the assistant to stop it, then run this file again.
goto :report

:backend_start
echo [2/2] Starting backend on port 3000 ...
start "FamilyTrip Server" /D "%PROJ%apps\server" cmd /k "npx tsx src/main.ts"
timeout /t 6 /nobreak >nul
goto :report

:report
echo.
echo Local  : http://127.0.0.1:3000/health
echo Device : http://%LAN%:3000/health
echo.
echo If the LAN IP changed, rebuild the client with the new IP:
echo   cd apps\client
echo   set API_BASE_URL=http://NEW-IP:3000/api
echo   npx taro build --type weapp
echo.
echo Both windows must stay open while testing.
pause

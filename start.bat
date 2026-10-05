@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Whale Bridge

rem --- 1. Node.js ---
where node >nul 2>&1
if errorlevel 1 goto no_node

rem --- 2. Dependencies: install on first run, after an update or if electron is missing ---
set "NEED_INSTALL=0"
if not exist "node_modules\electron\dist\electron.exe" set "NEED_INSTALL=1"
fc /b "package.json" "node_modules\.package.stamp" >nul 2>&1
if errorlevel 1 set "NEED_INSTALL=1"

if "%NEED_INSTALL%"=="1" (
  echo Installing dependencies. This is only needed on the first run or after an update.
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 goto install_failed
  copy /y "package.json" "node_modules\.package.stamp" >nul
)

if not exist "node_modules\electron\dist\electron.exe" goto install_failed

rem --- 3. Launch detached; this console closes right after ---
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:no_node
echo Node.js was not found.
where winget >nul 2>&1
if errorlevel 1 goto manual_node
choice /c YN /m "Install Node.js LTS now with winget"
if errorlevel 2 goto manual_node
winget install -e --id OpenJS.NodeJS.LTS
echo.
echo Done. Close this window and run start.bat again.
pause
exit /b 0

:manual_node
echo Install Node.js LTS from https://nodejs.org and run start.bat again.
pause
exit /b 1

:install_failed
echo.
echo Installation failed. Check your internet connection and try again.
pause
exit /b 1

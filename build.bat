@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Whale Bridge - Windows Build

echo ========================================
echo Whale Bridge - Windows release build
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js LTS first.
  pause
  exit /b 1
)

if not exist "node_modules\electron-builder\bin\electron-builder.js" (
  echo Installing build dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo.
echo Running tests...
call npm test
if errorlevel 1 (
  echo.
  echo Tests failed. Build cancelled.
  pause
  exit /b 1
)

echo.
echo Building NSIS installer and portable version...
call npm run build:win
if errorlevel 1 (
  echo.
  echo Build failed.
  pause
  exit /b 1
)

echo.
echo Build complete. Files are in the release folder.
pause
exit /b 0

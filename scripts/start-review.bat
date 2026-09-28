@echo off
rem Cleanery review launcher (this PC only). Closing this window stops the program. Saved work is kept.
chcp 65001 >nul
title Cleanery Review - close this window to quit
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please tell CodeD.
  pause
  exit /b 1
)
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3200 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  start "" "http://127.0.0.1:3200/admin/review"
  exit /b 0
)
start "" /b cmd /c "timeout /t 2 >nul & start http://127.0.0.1:3200/admin/review"
node scripts\dev-server.js --port 3200 --review-local
timeout /t 5 >nul

@echo off
rem Cleanery review screen launcher (local dev server, file-backed store). Close this window to stop.
title Cleanery review - close this window to stop
cd /d "%~dp0.."
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3200 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  start "" "http://127.0.0.1:3200/admin/review"
  exit /b
)
start "" /b cmd /c "timeout /t 2 >nul & start http://127.0.0.1:3200/admin/review"
node scripts\dev-server.js --port 3200
pause

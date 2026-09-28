@echo off
chcp 65001 >nul
rem 크리너리 상담검토 실행기 (이 PC 전용). 이 창을 닫으면 검토 프로그램이 종료됩니다. 저장한 내용은 남습니다.
title 크리너리 상담검토 - 이 창을 닫으면 종료됩니다
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 가 설치돼 있지 않아 실행할 수 없습니다. 코드디에게 알려 주세요.
  pause
  exit /b 1
)
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3200 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  rem 이미 실행 중이면 화면만 다시 엽니다
  start "" "http://127.0.0.1:3200/admin/review"
  exit /b 0
)
start "" /b cmd /c "timeout /t 2 >nul & start http://127.0.0.1:3200/admin/review"
node scripts\dev-server.js --port 3200 --review-local
echo.
echo 검토 프로그램이 종료됐습니다. 이 창은 닫으셔도 됩니다.
timeout /t 5 >nul

# 크리너리 상담검토 프로그램 설치/업데이트 (이 PC 전용)
# - 프로그램 파일: %LOCALAPPDATA%\Cleanery Review\app  (설치할 때마다 새로 복사, 비밀키 .env 는 복사하지 않음)
# - 검토 기록:     %LOCALAPPDATA%\Cleanery Review\review-store.json + backups\  (설치·업데이트가 절대 건드리지 않음)
# - 바탕화면 바로가기: "크리너리 상담검토 열기"
param([string]$TargetHome = (Join-Path $env:LOCALAPPDATA 'Cleanery Review'), [string]$Desktop = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot
$app = Join-Path $TargetHome 'app'
$staging = Join-Path $TargetHome ('app-new-' + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Force $TargetHome | Out-Null
New-Item -ItemType Directory -Force $staging | Out-Null
foreach ($d in 'api', 'handlers', 'lib', 'admin-pages', 'public', 'review', 'scripts') {
  Copy-Item (Join-Path $src $d) (Join-Path $staging $d) -Recurse
}
Copy-Item (Join-Path $src 'package.json') $staging
# 바꿔치기: 새 폴더를 다 만든 뒤 교체 (도중 실패해도 기존 app 은 그대로)
# 실행 중인 검토 프로그램(이 app 폴더에서 돈 node·cmd 창)을 먼저 닫습니다 — 저장한 내용은 파일에 있으므로 안전
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and (($_.Name -eq 'node.exe' -and $_.CommandLine -match '--review-local') -or ($_.Name -eq 'cmd.exe' -and ($_.CommandLine.Contains($app) -or $_.CommandLine -match 'start-review\.bat'))) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
Get-ChildItem $TargetHome -Directory | Where-Object { $_.Name -like 'app-new-*' -and $_.FullName -ne $staging } | ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path $app) {
  $old = 'app-old-' + (Get-Date -Format 'yyyyMMddHHmmss')
  for ($i = 0; $i -lt 10; $i++) {
    try { Rename-Item $app -NewName $old -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 700; if ($i -eq 9) { throw "검토 프로그램 창이 열려 있어 업데이트하지 못했습니다. 검토 프로그램 창을 닫고 다시 실행해 주세요." } }
  }
}
Rename-Item $staging -NewName 'app'
Get-ChildItem $TargetHome -Directory | Where-Object { $_.Name -like 'app-old-*' } | Sort-Object Name -Descending | Select-Object -Skip 2 | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut((Join-Path $Desktop '크리너리 상담검토 열기.lnk'))
$lnk.TargetPath = Join-Path $app 'scripts\start-review.bat'
$lnk.WorkingDirectory = $app
$lnk.WindowStyle = 7   # 최소화된 창으로 실행
$lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,23"
$lnk.Description = '크리너리 가상 상담 검토 (이 PC 전용)'
$lnk.Save()
"설치 완료: $app"
"바로가기: " + (Join-Path $Desktop '크리너리 상담검토 열기.lnk')

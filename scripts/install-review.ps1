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
if (Test-Path $app) { Rename-Item $app -NewName ('app-old-' + (Get-Date -Format 'yyyyMMddHHmmss')) }
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

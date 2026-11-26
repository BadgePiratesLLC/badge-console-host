# Windows one-line install. Downloads the release .exe, registers it to
# start on login via Task Scheduler, and starts it now. No terminal needed
# again after this.
#
# Usage (once a release exists), from an ordinary (non-admin) PowerShell:
#   iwr https://raw.githubusercontent.com/BadgePiratesLLC/badge-console-host/main/install/install.ps1 -UseBasicParsing | iex

$ErrorActionPreference = 'Stop'
$repo = 'BadgePiratesLLC/badge-console-host'
$installDir = Join-Path $env:USERPROFILE '.badge-console-host\bin'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$url = "https://github.com/$repo/releases/latest/download/badge-console-host-windows.exe"
$exePath = Join-Path $installDir 'badge-console-host.exe'
Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $exePath -UseBasicParsing

Write-Host 'Registering to start on login...'
& $exePath --install-autostart

Write-Host 'Starting now...'
Start-Process -FilePath $exePath -WindowStyle Hidden

Write-Host ''
Write-Host 'Done. Open http://127.0.0.1:4173 in your browser to finish setup.'

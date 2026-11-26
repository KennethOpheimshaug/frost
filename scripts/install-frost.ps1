<#
.SYNOPSIS
  Builds Frost, installs it for the current user and creates Start menu + Desktop shortcuts
  that you can pin to the taskbar.

.DESCRIPTION
  1. (optional) git pull                       -Update
  2. npm install + a release build of Frost
  3. copies Frost.exe to %LOCALAPPDATA%\Programs\Frost
     (so you can rebuild while Frost is running, and the shortcut path never changes)
  4. creates "Frost" shortcuts in the Start menu and on the Desktop

  Run it again any time to update your installed Frost.

.EXAMPLE
  .\Frost.cmd                  # build and install
  .\Frost.cmd -Update          # git pull first, then build and install
  .\Frost.cmd -NoDesktop       # no Desktop shortcut
  .\Frost.cmd -Launch          # start Frost when done
#>
param(
  [switch]$Update,
  [switch]$NoDesktop,
  [switch]$Launch
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$installDir = Join-Path $env:LOCALAPPDATA "Programs\Frost"
$installedExe = Join-Path $installDir "Frost.exe"

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "Missing '$cmd'. $hint" -ForegroundColor Red
    exit 1
  }
}

Need "node" "Install Node.js 20+ from https://nodejs.org"
Need "npm" "Install Node.js 20+ from https://nodejs.org"
Need "cargo" "Install Rust from https://rustup.rs (and the Visual Studio C++ Build Tools)"

Push-Location $repo
try {
  if ($Update) {
    Step "Pulling the latest Frost"
    git pull --ff-only
  }

  if ($Update -or -not (Test-Path "node_modules")) {
    Step "Installing npm packages"
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
  }

  Step "Building Frost (release). The first build takes several minutes."
  npm run tauri build -- --no-bundle
  if ($LASTEXITCODE -ne 0) { throw "The build failed. See the messages above." }

  $built = Join-Path $repo "src-tauri\target\release\frost.exe"
  if (-not (Test-Path $built)) { throw "Build finished but $built was not found." }

  Step "Installing to $installDir"
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  $running = Get-Process -Name "Frost" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installedExe }
  if ($running) {
    Write-Host "Frost is running. Close it to finish updating..." -ForegroundColor Yellow
    $running | Wait-Process
  }
  Copy-Item $built $installedExe -Force

  Step "Creating shortcuts"
  $shell = New-Object -ComObject WScript.Shell
  $targets = @([Environment]::GetFolderPath("Programs"))
  if (-not $NoDesktop) { $targets += [Environment]::GetFolderPath("Desktop") }
  foreach ($dir in $targets) {
    $lnk = $shell.CreateShortcut((Join-Path $dir "Frost.lnk"))
    $lnk.TargetPath = $installedExe
    $lnk.WorkingDirectory = $installDir
    $lnk.IconLocation = "$installedExe,0"
    $lnk.Description = "Frost IDE"
    $lnk.Save()
    Write-Host "  $dir\Frost.lnk"
  }

  Write-Host ""
  Write-Host "Frost is installed." -ForegroundColor Green
  Write-Host "Pin it: open the Start menu, type 'Frost', right-click it and choose 'Pin to taskbar'."
  Write-Host "(Windows doesn't let scripts pin to the taskbar, so this one click is manual.)"
  Write-Host "Update later by running Frost.cmd -Update."

  if ($Launch) { Start-Process $installedExe }
}
catch {
  Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
finally {
  Pop-Location
}

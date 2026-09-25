# RefThing launcher. Double-click the .bat files in the repo root instead of
# running this directly:
#   RefThing.bat      -> -Mode app  : the standalone desktop app (release exe)
#   RefThing Dev.bat  -> -Mode dev  : the Tauri dev window with hot reload
#
# The standalone app rebuilds itself first whenever any source file is newer
# than the exe, so it never launches stale code. It keeps its boards in
# %APPDATA%\com.refthing.app; dev mode uses the repo's .\data folder.

param(
    [ValidateSet('app', 'dev')]
    [string]$Mode = 'app',
    [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Stop-WithMessage([string]$message) {
    Write-Host ''
    Write-Host $message -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}

# The desktop app embeds the RefThing server on 7171 (and dev mode also runs
# Vite on 5173). Anything already listening there means another RefThing is up.
function Assert-PortFree([int]$port, [string]$what) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($listener) {
        $owner = (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue).ProcessName
        Stop-WithMessage ("Port $port ($what) is already in use by '$owner' (PID $($listener.OwningProcess)).`n" +
            "Close the other RefThing (app window, 'npm run dev', or 'RefThing Dev') and try again.")
    }
}

if ($Mode -eq 'dev') {
    Assert-PortFree 7171 'RefThing server'
    Assert-PortFree 5173 'Vite dev server'
    Write-Host 'Starting the RefThing dev window (Vite + embedded server, hot reload).'
    Write-Host 'The first start compiles the Rust side and can take a few minutes.'
    Write-Host 'Close this console (or the app window) to stop everything.'
    Write-Host ''
    & npm.cmd run dev:app
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage "Dev app exited with code $LASTEXITCODE." }
    exit 0
}

# --- standalone app -----------------------------------------------------------
$exe = Join-Path $root 'src-tauri\target\release\refthing-app.exe'
$sources = @(
    'frontend\src', 'frontend\index.html', 'frontend\package.json', 'frontend\vite.config.ts',
    'backend\crates', 'backend\migrations', 'backend\Cargo.toml', 'backend\Cargo.lock',
    'src-tauri\src', 'src-tauri\Cargo.toml', 'src-tauri\tauri.conf.json', 'src-tauri\icons'
) | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ }

# Recurse into directories only: Windows PowerShell's -Recurse on a FILE path
# searches that file's whole parent folder for the name — here the multi-GB
# target\ build folders, which cost ~30s per launch.
$newest = @(
    $sources | Where-Object { Test-Path $_ -PathType Container } |
        ForEach-Object { Get-ChildItem -Path $_ -Recurse -File -ErrorAction SilentlyContinue }
    $sources | Where-Object { Test-Path $_ -PathType Leaf } | ForEach-Object { Get-Item $_ }
) | Sort-Object LastWriteTime -Descending | Select-Object -First 1

$stale = $Rebuild -or -not (Test-Path $exe) -or
    ($newest -and $newest.LastWriteTime -gt (Get-Item $exe).LastWriteTime)

if ($stale) {
    if (Test-Path $exe) {
        Write-Host "Sources changed since the last build ($($newest.FullName.Substring($root.Length + 1)))."
    } else {
        Write-Host 'No standalone build yet.'
    }
    Write-Host 'Building the standalone app (release build + installer; several minutes the first time)...'
    Write-Host ''
    & npm.cmd run build:app
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exe)) {
        Stop-WithMessage 'The build failed - see the output above.'
    }
    # Touch the exe so a build that cargo decided was up to date still counts.
    (Get-Item $exe).LastWriteTime = Get-Date
    Write-Host ''
    Write-Host "Installer: src-tauri\target\release\bundle\nsis\" -ForegroundColor DarkGray
}

Assert-PortFree 7171 'RefThing server'
Write-Host 'Launching RefThing...'
Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)

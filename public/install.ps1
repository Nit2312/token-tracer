# Token Tracer — One-Line Windows Bootstrapper (run ONCE per developer machine)
#
# After this runs, the daemon handles all future updates automatically.
# You never need to re-run this script after a new release is published.
#
# Usage:
#   $ApiKey="av_live_YOUR_KEY"; iex (irm https://token-tracer-three.vercel.app/install.ps1)
#
# Optional: set $ServerUrl before running to use a custom backend URL.

param(
  [string]$ApiKey = $env:TOKEN_TRACER_KEY,
  [string]$ServerUrl = "https://token-tracer-three.vercel.app",
  [int]$IntervalMin = 60
)

# Also accept bare $ApiKey / $key variables set in the calling scope
if (-not $ApiKey) { $ApiKey = (Get-Variable 'key' -ErrorAction SilentlyContinue)?.Value }
if (-not $ApiKey) { $ApiKey = (Get-Variable 'ApiKey' -ErrorAction SilentlyContinue)?.Value }

if (-not $ApiKey) {
    Write-Error "❌ Error: API key is required."
    Write-Host "Usage: `$ApiKey='av_live_YOUR_KEY'; iex (irm $ServerUrl/install.ps1)"
    exit 1
}

# ── Require Node.js v18+ ──────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "❌ Node.js is not installed. Please install from https://nodejs.org (v18+)."
    exit 1
}
$nodeVersion = (node -e "process.stdout.write(process.versions.node)").Split('.')[0]
if ([int]$nodeVersion -lt 18) {
    Write-Error "❌ Node.js v18+ required (found v$(node --version)). Please upgrade."
    exit 1
}
$NodePath = (Get-Command node).Source

# ── Prepare install directory ─────────────────────────────────────────────────
$TargetDir = Join-Path $env:USERPROFILE ".token-tracer"
New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null

Write-Host "📦 Bootstrapping Token Tracer daemon in $TargetDir ..."

# ── Write config.json ──────────────────────────────────────────────────────────
$ConfigPath = Join-Path $TargetDir "config.json"
@{
    apiUrl      = $ServerUrl
    apiKey      = $ApiKey
    intervalMin = $IntervalMin
} | ConvertTo-Json | Set-Content -Path $ConfigPath -Force -Encoding UTF8

# ── Download daemon ────────────────────────────────────────────────────────────
$DaemonPath = Join-Path $TargetDir "sync-daemon.mjs"
Write-Host "⬇️  Downloading daemon ..."
Invoke-RestMethod -Uri "$ServerUrl/sync-daemon.mjs" -OutFile $DaemonPath

# ── Launcher VBS (runs Node hidden, no console window) ────────────────────────
$StatePath     = Join-Path $TargetDir "sync-state.json"
$SyncLog       = Join-Path $TargetDir "sync.log"
$UpdateLog     = Join-Path $TargetDir "update.log"

$VbsPath = Join-Path $TargetDir "run-daemon.vbs"
$VbsContent = @"
CreateObject("Wscript.Shell").Run "node `"`"$DaemonPath`"`" --config `"`"$ConfigPath`"`" --state `"`"$StatePath`"`" --log `"`"$SyncLog`"`" --update-log `"`"$UpdateLog`"`"", 0, False
"@
Set-Content -Path $VbsPath -Value $VbsContent -Force -Encoding ASCII

# ── Register in Windows Startup folder ────────────────────────────────────────
$StartupFolder = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
$ShortcutPath  = Join-Path $StartupFolder "TokenTracer.lnk"

$WshShell  = New-Object -ComObject WScript.Shell
$Shortcut  = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath   = "wscript.exe"
$Shortcut.Arguments    = "`"$VbsPath`""
$Shortcut.WindowStyle  = 7   # Minimized / hidden
$Shortcut.Description  = "Token Tracer Background Sync Daemon"
$Shortcut.Save()

# ── Stop any existing daemon process, then start fresh ────────────────────────
Write-Host "🔄 Starting daemon ..."
Get-WmiObject Win32_Process |
    Where-Object { $_.CommandLine -like "*sync-daemon.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Process "wscript.exe" -ArgumentList "`"$VbsPath`"" -WindowStyle Hidden

Write-Host ""
Write-Host "=========================================================="
Write-Host "  ✅ Token Tracer bootstrapped successfully!"
Write-Host "  🔄 Daemon is running and will self-update automatically."
Write-Host "  📁 Install dir : $TargetDir"
Write-Host "  📜 Sync log    : $SyncLog"
Write-Host "  🔄 Update log  : $UpdateLog"
Write-Host "  ℹ️  This is the last time you ever need to run this script."
Write-Host "=========================================================="

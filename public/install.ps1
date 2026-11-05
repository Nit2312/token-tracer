# Token Tracer - One-Line Windows Bootstrapper
#
# Safe to re-run any time (re-installs / repairs the daemon with the same key).
# Works on Windows PowerShell 5.1 and PowerShell 7+.
#
# Usage:
#   $env:TOKEN_TRACER_KEY="av_live_YOUR_KEY"; iex (irm https://token-tracer-three.vercel.app/install.ps1)
#
# Optional: set $ServerUrl before running to use a custom backend URL.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 can mis-decode UTF-8
# when piped through irm/iex, and a stray smart-quote byte breaks parsing.
# NOTE: no param() block and no `exit` - this is run through iex in the user's
# own session, where `exit` would close their terminal.

function Install-TokenTracer {
    # Read optional caller variables via Get-Variable: a plain $global:Foo throws when
    # Foo is undefined if the user's session has Set-StrictMode on (e.g. VS Code terminal).
    function Get-CallerVar([string]$Name) {
        $v = Get-Variable -Name $Name -Scope Global -ErrorAction SilentlyContinue
        if ($v) { return $v.Value }
        return $null
    }

    $Server = "https://token-tracer-three.vercel.app"
    $Interval = 60
    $customServer = Get-CallerVar 'ServerUrl'
    $customInterval = Get-CallerVar 'IntervalMin'
    if ($customServer)   { $Server = [string]$customServer }
    if ($customInterval) { $Interval = [int]$customInterval }

    # Accept the key from $env:TOKEN_TRACER_KEY, or a bare $ApiKey / $key variable
    $Key = $env:TOKEN_TRACER_KEY
    if (-not $Key) { $Key = Get-CallerVar 'ApiKey' }
    if (-not $Key) { $Key = Get-CallerVar 'key' }

    if (-not $Key) {
        Write-Host "ERROR: API key is required." -ForegroundColor Red
        Write-Host "Usage: `$env:TOKEN_TRACER_KEY='av_live_YOUR_KEY'; iex (irm $Server/install.ps1)"
        return
    }

    # Older Windows defaults to TLS 1.0/1.1, which Vercel rejects
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

    # -- Require Node.js v18+ ---------------------------------------------------
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: Node.js is not installed. Install v18+ from https://nodejs.org, reopen PowerShell, and run this again." -ForegroundColor Red
        return
    }
    $nodeMajor = [int](node -e "process.stdout.write(process.versions.node.split('.')[0])")
    if ($nodeMajor -lt 18) {
        Write-Host "ERROR: Node.js v18+ required (found v$nodeMajor). Please upgrade." -ForegroundColor Red
        return
    }

    # -- Prepare install directory ----------------------------------------------
    $TargetDir = Join-Path $env:USERPROFILE ".token-tracer"
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Write-Host "Bootstrapping Token Tracer daemon in $TargetDir ..."

    $ConfigPath = Join-Path $TargetDir "config.json"
    $StatePath  = Join-Path $TargetDir "sync-state.json"
    $SyncLog    = Join-Path $TargetDir "sync.log"
    $UpdateLog  = Join-Path $TargetDir "update.log"

    # -- Was this PC set up for a DIFFERENT user before? ------------------------
    # If so, the history already on disk belongs to them, so we do a "fresh start" below.
    # Set $env:TOKEN_TRACER_IMPORT_HISTORY="1" to upload the existing history anyway.
    $OldKey = $null
    if (Test-Path $ConfigPath) {
        try { $OldKey = (Get-Content $ConfigPath -Raw | ConvertFrom-Json).apiKey } catch {}
    }
    $FreshStart = ($OldKey -and ($OldKey -ne $Key) -and ($env:TOKEN_TRACER_IMPORT_HISTORY -ne "1"))

    # -- Stop any existing daemon before replacing its files --------------------
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*sync-daemon.mjs*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    # -- Write config.json (overwrites any previous key) ------------------------
    $configJson = @{
        apiUrl      = $Server
        apiKey      = $Key
        intervalMin = $Interval
    } | ConvertTo-Json
    # Write UTF-8 WITHOUT a BOM: Windows PowerShell 5.1's `Set-Content -Encoding UTF8` adds one,
    # and Node's JSON.parse rejects it, so the daemon would see an empty config.
    [System.IO.File]::WriteAllText($ConfigPath, $configJson, (New-Object System.Text.UTF8Encoding($false)))

    # -- Download daemon --------------------------------------------------------
    $DaemonPath = Join-Path $TargetDir "sync-daemon.mjs"
    Write-Host "Downloading daemon ..."
    try {
        Invoke-WebRequest -Uri "$Server/sync-daemon.mjs" -OutFile $DaemonPath -UseBasicParsing -ErrorAction Stop
    } catch {
        Write-Host "ERROR: could not download the daemon from $Server ($($_.Exception.Message))" -ForegroundColor Red
        return
    }

    # -- Fresh start for a reused PC: skip (do not upload) sessions already on disk --
    if ($FreshStart) {
        Write-Host "This PC was set up for a different user before - starting fresh."
        if (-not (Select-String -Path $DaemonPath -Pattern "--baseline" -SimpleMatch -Quiet)) {
            Write-Host "ERROR: the downloaded daemon does not support fresh start yet. Aborting so the previous user's history is not uploaded. Ask the admin to deploy the latest version." -ForegroundColor Red
            return
        }
        & node $DaemonPath --baseline --state $StatePath --log $SyncLog
    }

    # -- Launcher VBS (runs Node hidden, no console window) ---------------------
    $VbsPath = Join-Path $TargetDir "run-daemon.vbs"
    $VbsContent = @"
CreateObject("Wscript.Shell").Run "node `"`"$DaemonPath`"`" --config `"`"$ConfigPath`"`" --state `"`"$StatePath`"`" --log `"`"$SyncLog`"`" --update-log `"`"$UpdateLog`"`"", 0, False
"@
    Set-Content -Path $VbsPath -Value $VbsContent -Force -Encoding ASCII

    # -- Register in Windows Startup folder -------------------------------------
    $StartupFolder = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
    $ShortcutPath  = Join-Path $StartupFolder "TokenTracer.lnk"

    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath  = "wscript.exe"
    $Shortcut.Arguments   = "`"$VbsPath`""
    $Shortcut.WindowStyle = 7   # Minimized / hidden
    $Shortcut.Description = "Token Tracer Background Sync Daemon"
    $Shortcut.Save()

    # -- Start fresh ------------------------------------------------------------
    Write-Host "Starting daemon ..."
    Start-Process "wscript.exe" -ArgumentList "`"$VbsPath`"" -WindowStyle Hidden

    Write-Host ""
    Write-Host "=========================================================="
    Write-Host "  Token Tracer installed successfully."
    Write-Host "  The daemon is running and will self-update automatically."
    Write-Host "  Install dir : $TargetDir"
    Write-Host "  Sync log    : $SyncLog"
    Write-Host "  Update log  : $UpdateLog"
    Write-Host "=========================================================="
}

Install-TokenTracer

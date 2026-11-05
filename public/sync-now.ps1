# Token Tracer - push data to the server right now (Windows) and show the result.
#
# Usage:
#   iex (irm https://token-tracer-three.vercel.app/sync-now.ps1)
#
# Optional: $env:TOKEN_TRACER_FORCE="1" re-sends every session, not just new ones.
#
# NOTE: keep this file ASCII-only and free of `exit` (it runs via iex in the user's session).

function Sync-TokenTracerNow {
    $Dir       = Join-Path $env:USERPROFILE ".token-tracer"
    $Daemon    = Join-Path $Dir "sync-daemon.mjs"
    $Config    = Join-Path $Dir "config.json"
    $State     = Join-Path $Dir "sync-state.json"
    $Log       = Join-Path $Dir "sync.log"
    $UpdateLog = Join-Path $Dir "update.log"

    if (-not (Test-Path $Daemon) -or -not (Test-Path $Config)) {
        Write-Host "ERROR: Token Tracer is not installed on this PC ($Dir not found). Run the install command first." -ForegroundColor Red
        return
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: Node.js not found. Install v18+ from https://nodejs.org and reopen PowerShell." -ForegroundColor Red
        return
    }

    if ($env:TOKEN_TRACER_FORCE -eq "1") {
        $State = Join-Path $env:TEMP "token-tracer-force-state.json"
        Remove-Item $State -Force -ErrorAction SilentlyContinue
        Write-Host "Force mode: re-sending all sessions."
    }

    $before = 0
    if (Test-Path $Log) { $before = @(Get-Content $Log).Count }

    Write-Host "Syncing now ..."
    & node $Daemon --config $Config --state $State --log $Log --update-log $UpdateLog --once

    Write-Host ""
    Write-Host "---- sync.log (new lines) ----"
    if (Test-Path $Log) {
        $new = @(Get-Content $Log | Select-Object -Skip $before)
        if ($new.Count -eq 0) {
            Write-Host "(no new log lines - the daemon may have just updated itself; run this again)"
        } else {
            $new | ForEach-Object { Write-Host $_ }
            $last = $new[-1]
            if ($last -match "error") {
                Write-Host "RESULT: FAILED - see the error above." -ForegroundColor Red
            } elseif ($last -match "ok: sent") {
                Write-Host "RESULT: OK - data reached the server." -ForegroundColor Green
            } elseif ($last -match "nothing new") {
                Write-Host "RESULT: OK - already up to date, or no Claude sessions were found on this PC." -ForegroundColor Yellow
                Write-Host "To re-send everything: `$env:TOKEN_TRACER_FORCE='1'; iex (irm https://token-tracer-three.vercel.app/sync-now.ps1)"
            }
        }
    }
}

Sync-TokenTracerNow

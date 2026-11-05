#!/usr/bin/env bash
# Token Tracer - push data to the server right now (macOS / Linux) and show the result.
#
# Usage:
#   curl -fsSL https://token-tracer-three.vercel.app/sync-now.sh | bash
#
# Optional: TOKEN_TRACER_FORCE=1 re-sends every session, not just new ones:
#   curl -fsSL https://token-tracer-three.vercel.app/sync-now.sh | TOKEN_TRACER_FORCE=1 bash

DIR="$HOME/.token-tracer"
DAEMON="$DIR/sync-daemon.mjs"
CONFIG="$DIR/config.json"
STATE="$DIR/sync-state.json"
LOG="$DIR/sync.log"
UPDATE_LOG="$DIR/update.log"

if [ ! -f "$DAEMON" ] || [ ! -f "$CONFIG" ]; then
  echo "ERROR: Token Tracer is not installed on this machine ($DIR not found). Run the install command first."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js not found. Install v18+ from https://nodejs.org"
  exit 1
fi

if [ "$TOKEN_TRACER_FORCE" = "1" ]; then
  STATE="$(mktemp -t token-tracer-force.XXXXXX)"
  rm -f "$STATE"
  echo "Force mode: re-sending all sessions."
fi

BEFORE=0
[ -f "$LOG" ] && BEFORE="$(wc -l < "$LOG" | tr -d ' ')"

echo "Syncing now ..."
node "$DAEMON" --config "$CONFIG" --state "$STATE" --log "$LOG" --update-log "$UPDATE_LOG" --once

echo
echo "---- sync.log (new lines) ----"
NEW="$(tail -n +"$((BEFORE + 1))" "$LOG" 2>/dev/null)"
if [ -z "$NEW" ]; then
  echo "(no new log lines - the daemon may have just updated itself; run this again)"
  exit 0
fi
echo "$NEW"
LAST="$(echo "$NEW" | tail -n 1)"
case "$LAST" in
  *error*)       echo "RESULT: FAILED - see the error above." ;;
  *"ok: sent"*)  echo "RESULT: OK - data reached the server." ;;
  *"nothing new"*)
    echo "RESULT: OK - already up to date, or no Claude sessions were found on this machine."
    echo "To re-send everything: curl -fsSL https://token-tracer-three.vercel.app/sync-now.sh | TOKEN_TRACER_FORCE=1 bash" ;;
esac

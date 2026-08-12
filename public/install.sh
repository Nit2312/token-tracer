#!/usr/bin/env bash
# Token Tracer — One-Line Bootstrapper (run ONCE per developer machine)
#
# After this runs, the daemon handles all future updates automatically.
# You never need to re-run this script after a new release is published.
#
# Usage:
#   curl -fsSL https://token-tracer-three.vercel.app/install.sh | bash -s -- --key av_live_YOUR_KEY
#
# Optional flags:
#   --key   / -k   API key (required)
#   --server / -s  Backend URL (default: https://token-tracer-three.vercel.app)
#   --interval     Sync interval in minutes (default: 20)

set -euo pipefail

SERVER_URL="https://token-tracer-three.vercel.app"
API_KEY=""
INTERVAL_MIN="20"
SERVICE_LABEL="com.token-tracer.daemon"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --key|-k)      API_KEY="$2";       shift 2 ;;
    --server|-s)   SERVER_URL="$2";    shift 2 ;;
    --interval)    INTERVAL_MIN="$2";  shift 2 ;;
    *)             shift ;;
  esac
done

if [ -z "$API_KEY" ]; then
  echo "❌ Error: --key is required."
  echo "Usage: curl -fsSL ${SERVER_URL}/install.sh | bash -s -- --key av_live_YOUR_KEY"
  exit 1
fi

# ── Require Node.js ──────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "❌ Node.js is not installed."
  echo "Install via: brew install node  or  https://nodejs.org"
  exit 1
fi

NODE_PATH="$(command -v node)"
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Node.js v18+ required (found v$(node --version)). Please upgrade."
  exit 1
fi

# ── Prepare install directory ────────────────────────────────────────────────
TARGET_DIR="$HOME/.token-tracer"
mkdir -p "$TARGET_DIR"
chmod 700 "$TARGET_DIR"

echo "📦 Bootstrapping Token Tracer daemon in $TARGET_DIR …"

# ── Write config.json ────────────────────────────────────────────────────────
CONFIG_PATH="$TARGET_DIR/config.json"
cat > "$CONFIG_PATH" <<EOF
{
  "apiUrl": "$SERVER_URL",
  "apiKey": "$API_KEY",
  "intervalMin": $INTERVAL_MIN
}
EOF
chmod 600 "$CONFIG_PATH"

# ── Download daemon ──────────────────────────────────────────────────────────
DAEMON_PATH="$TARGET_DIR/sync-daemon.mjs"
echo "⬇️  Downloading daemon …"
curl -fsSL "$SERVER_URL/sync-daemon.mjs" -o "$DAEMON_PATH"
chmod 755 "$DAEMON_PATH"

# ── macOS: register as LaunchAgent (persists across reboots) ─────────────────
if [[ "$(uname)" == "Darwin" ]]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$PLIST_DIR"
  PLIST_PATH="$PLIST_DIR/${SERVICE_LABEL}.plist"

  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${DAEMON_PATH}</string>
        <string>--config</string>
        <string>${CONFIG_PATH}</string>
        <string>--state</string>
        <string>${TARGET_DIR}/sync-state.json</string>
        <string>--log</string>
        <string>${TARGET_DIR}/sync.log</string>
        <string>--update-log</string>
        <string>${TARGET_DIR}/update.log</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${TARGET_DIR}/launchd.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${TARGET_DIR}/launchd.stderr.log</string>
    <key>ThrottleInterval</key>
    <integer>60</integer>
</dict>
</plist>
PLIST

  # Unload any existing instance, then load the new one
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load -w "$PLIST_PATH"

elif [[ "$(uname)" == "Linux" ]]; then
  # ── Linux: register as systemd user service (if systemd is available) ──────
  if command -v systemctl &>/dev/null && systemctl --user status &>/dev/null 2>&1; then
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_DIR"
    SERVICE_FILE="$SYSTEMD_DIR/token-tracer.service"

    cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=Token Tracer background sync daemon
After=network.target

[Service]
ExecStart=${NODE_PATH} ${DAEMON_PATH} --config ${CONFIG_PATH} --state ${TARGET_DIR}/sync-state.json --log ${TARGET_DIR}/sync.log --update-log ${TARGET_DIR}/update.log
Restart=always
RestartSec=60
StandardOutput=append:${TARGET_DIR}/launchd.stdout.log
StandardError=append:${TARGET_DIR}/launchd.stderr.log

[Install]
WantedBy=default.target
SERVICE

    systemctl --user daemon-reload
    systemctl --user enable --now token-tracer.service
  else
    # Fallback: add to ~/.profile for login-shell startup
    PROFILE_LINE="nohup node \"$DAEMON_PATH\" --config \"$CONFIG_PATH\" --state \"$TARGET_DIR/sync-state.json\" --log \"$TARGET_DIR/sync.log\" --update-log \"$TARGET_DIR/update.log\" &>/dev/null &"
    if ! grep -qF "sync-daemon.mjs" "$HOME/.profile" 2>/dev/null; then
      echo "" >> "$HOME/.profile"
      echo "# Token Tracer daemon (auto-started at login)" >> "$HOME/.profile"
      echo "$PROFILE_LINE" >> "$HOME/.profile"
    fi
    # Start now
    eval "$PROFILE_LINE"
  fi
fi

echo ""
echo "=========================================================="
echo " ✅ Token Tracer bootstrapped successfully!"
echo " 🔄 Daemon is running and will self-update automatically."
echo " 📁 Install dir : $TARGET_DIR"
echo " 📜 Sync log    : $TARGET_DIR/sync.log"
echo " 🔄 Update log  : $TARGET_DIR/update.log"
echo " ℹ️  This is the last time you ever need to run this script."
echo "=========================================================="

#!/usr/bin/env bash
# CaptureDesk native host installer (Linux, per-user).
# Registers com.capturedesk.host for Chrome/Chromium/Brave/Edge.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOST_ID="com.capturedesk.host"
HOST_JS="${HERE}/native-host.js"

if ! command -v node >/dev/null 2>&1; then
  echo "[CaptureDesk] Node.js not found on PATH. Install Node.js 18+ first." >&2
  exit 1
fi

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <chrome-extension-id>" >&2
  exit 1
fi
EXT_ID="$1"

MANIFEST="${HERE}/com.capturedesk.host.json"
cat > "$MANIFEST" <<EOF
{
  "name": "${HOST_ID}",
  "description": "CaptureDesk native messaging host",
  "path": "${HOST_JS}",
  "type": "stdio",
  "allowed_origins": [ "chrome-extension://${EXT_ID}/" ]
}
EOF
chmod +x "$HOST_JS"

register() {
  local dir="$1"
  mkdir -p "$dir"
  ln -sf "$MANIFEST" "$dir/$HOST_ID"
  echo "[CaptureDesk] registered: $dir/$HOST_ID"
}

for base in "$HOME/.config/google-chrome" "$HOME/.config/chromium" \
            "$HOME/.config/BraveSoftware/Brave-Browser" \
            "$HOME/.config/microsoft-edge"; do
  register "$base/NativeMessagingHosts"
done

echo "[CaptureDesk] Native host installed. Restart your browser to pick it up."

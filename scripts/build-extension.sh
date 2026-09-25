#!/usr/bin/env bash
# Build the CaptureDesk Chrome extension bundle:
#   dist/CaptureDesk-Chrome-Extension.zip   (load-ready zip)
#   dist/capturedesk-chrome-extension/      (unpacked copy, per release spec)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"

# dist/ is no longer tracked in git (Release assets are the published
# binaries), so it must exist before the copy below.
mkdir -p "$DIST"
rm -rf "$DIST/capturedesk-chrome-extension" "$DIST/CaptureDesk-Chrome-Extension.zip"
cp -r "$ROOT/extension" "$DIST/capturedesk-chrome-extension"

# Strip junk from the shipped copy.
find "$DIST/capturedesk-chrome-extension" -name '.DS_Store' -delete 2>/dev/null || true
find "$DIST/capturedesk-chrome-extension" -name 'Thumbs.db' -delete 2>/dev/null || true

mkdir -p "$DIST"
(
  cd "$DIST/capturedesk-chrome-extension"
  zip -qr "$DIST/CaptureDesk-Chrome-Extension.zip" .
)

echo "[CaptureDesk] extension bundle:"
ls -la "$DIST/CaptureDesk-Chrome-Extension.zip" "$DIST/capturedesk-chrome-extension" | sed 's/^/  /'

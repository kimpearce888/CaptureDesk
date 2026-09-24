#!/usr/bin/env bash
# Package CaptureDesk Desktop for Windows x64 (cross-packaged on Linux —
# @electron/packager uses pure-JS resedit, no wine required).
# Output: build/CaptureDesk-win32-x64/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/desktop"

cd "$DESKTOP"

if [ ! -d node_modules/electron/dist ]; then
  echo "[CaptureDesk] fetching the Electron binary (postinstall)…"
  node node_modules/electron/install.js
fi

npx --yes @electron/packager . CaptureDesk \
  --platform=win32 \
  --arch=x64 \
  --out "$ROOT/build" \
  --overwrite \
  --asar=false \
  --icon "$DESKTOP/assets/icons/CaptureDesk.ico" \
  --app-bundle-id "com.capturedesk.desktop" \
  --app-version "1.0.0" \
  --app-copyright "MIT License — CaptureDesk Project" \
  --win32metadata.CompanyName="CaptureDesk Project" \
  --win32metadata.FileDescription="CaptureDesk" \
  --win32metadata.ProductName="CaptureDesk" \
  --win32metadata.InternalName="CaptureDesk" \
  --win32metadata.OriginalFilename="CaptureDesk.exe" \
  --ignore "^/build($|/)" \
  --ignore "^/tools($|/)" \
  --ignore "^/dist($|/)" \
  --ignore "\.DS_Store"

OUT="$ROOT/build/CaptureDesk-win32-x64"
test -f "$OUT/CaptureDesk.exe" || { echo "[CaptureDesk] packager output missing"; exit 1; }

# Sanity: required runtime pieces present.
test -d "$OUT/resources/app/node_modules/@ffmpeg/core" || { echo "[CaptureDesk] @ffmpeg/core missing from package"; exit 1; }
test -f "$OUT/resources/app/src/main/index.js" || { echo "[CaptureDesk] app entry missing from package"; exit 1; }

echo "[CaptureDesk] desktop package ready: $OUT"
du -sh "$OUT" | sed 's/^/  /'

#!/usr/bin/env bash
# Compile dist/CaptureDeskSetup.exe from the packaged desktop build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Ensure NSIS is available (fetched without root into tools/).
if [ ! -x "$ROOT/tools/nsis/usr/bin/makensis" ]; then
  bash "$ROOT/scripts/fetch-nsis.sh"
fi

export NSISDIR="$ROOT/tools/nsis/usr/share/nsis"
APPDIR="$ROOT/build/CaptureDesk-win32-x64"
test -f "$APPDIR/CaptureDesk.exe" || { echo "[CaptureDesk] run build-desktop.sh first"; exit 1; }

mkdir -p "$ROOT/dist"
"$ROOT/tools/nsis/usr/bin/makensis" \
  -DAPPSRC="$APPDIR" \
  -DROOTDIR="$ROOT" \
  -DOUTFILE="$ROOT/dist/CaptureDeskSetup.exe" \
  -V2 \
  "$ROOT/installer/CaptureDesk.nsi"

ls -la "$ROOT/dist/CaptureDeskSetup.exe" | sed 's/^/  /'
echo "[CaptureDesk] installer compiled."

#!/usr/bin/env bash
# Compile dist/CaptureDeskSetup.exe from the v2 native build outputs.
#
# Since the v2 native stack the installer stages THREE components
# (see installer/CaptureDesk.nsi):
#   APPSRC    — Tauri app binaries   (desktop-tauri/src-tauri/target/release)
#   ENGINESRC — capturedesk-engine   (desktop-tauri/native/build/…)
#   HOSTSRC   — capturedesk-native-host (native-host-cs/publish)
# The v1 Electron-only flow therefore no longer applies; build those first
# (or just run scripts/release-v2.sh, which orchestrates everything).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Ensure NSIS is available (fetched without root into tools/).
if [ ! -x "$ROOT/tools/nsis/usr/bin/makensis" ] && ! command -v makensis >/dev/null 2>&1; then
  bash "$ROOT/scripts/fetch-nsis.sh"
fi
if [ -x "$ROOT/tools/nsis/usr/bin/makensis" ]; then
  MAKEN="$ROOT/tools/nsis/usr/bin/makensis"
  export NSISDIR="$ROOT/tools/nsis/usr/share/nsis"
else
  MAKEN="$(command -v makensis)"
fi

APPDIR="$ROOT/desktop-tauri/src-tauri/target/release"
ENGINE=""
for p in "$ROOT/desktop-tauri/native/build/Release/capturedesk-engine.exe" \
         "$ROOT/desktop-tauri/native/build/capturedesk-engine.exe" \
         "$ROOT/desktop-tauri/native/build/Release/capturedesk-engine" \
         "$ROOT/desktop-tauri/native/build/capturedesk-engine"; do
  [ -f "$p" ] && ENGINE="$p" && break
done
HOST=""
for p in "$ROOT/native-host-cs/publish/capturedesk-native-host.exe" \
         "$ROOT/native-host-cs/publish/capturedesk-native-host"; do
  [ -f "$p" ] && HOST="$p" && break
done

# Preflight: fail with an actionable message, not a cryptic NSIS error.
MISSING=""
[ -f "$APPDIR/CaptureDesk.exe" ] || MISSING="$MISSING\n  - Tauri app: $APPDIR/CaptureDesk.exe (run scripts/build-tauri.sh)"
[ -n "$ENGINE" ]                || MISSING="$MISSING\n  - Engine: desktop-tauri/native/build/… (run scripts/build-engine.sh)"
[ -n "$HOST" ]                  || MISSING="$MISSING\n  - Host: native-host-cs/publish/… (run scripts/build-host.sh)"
if [ -n "$MISSING" ]; then
  printf '[CaptureDesk] installer needs the v2 build outputs:%b\n' "$MISSING" >&2
  echo "[CaptureDesk] or run scripts/release-v2.sh to build everything." >&2
  exit 1
fi

EXT_ID="${CD_EXT_ID:-REPLACE_WITH_EXTENSION_ID}"
mkdir -p "$ROOT/dist"
"$MAKEN" \
  -DAPPSRC="$APPDIR" \
  -DENGINESRC="$ENGINE" \
  -DHOSTSRC="$HOST" \
  -DCD_EXT_ID="$EXT_ID" \
  -DROOTDIR="$ROOT" \
  -DOUTFILE="$ROOT/dist/CaptureDeskSetup.exe" \
  -V2 \
  "$ROOT/installer/CaptureDesk.nsi"

ls -la "$ROOT/dist/CaptureDeskSetup.exe" | sed 's/^/  /'
echo "[CaptureDesk] installer compiled."

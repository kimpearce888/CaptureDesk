#!/usr/bin/env bash
# CaptureDesk v2 — full release pipeline on a Windows dev box / CI runner:
#   engine (C++) → host (C#) → shell (Tauri) → NSIS installer → dist + checksums.
#
# Mirrors .github/workflows/release.yml (the canonical, CI-proven pipeline).
# Intended for Git Bash on Windows (MSYS2/MinGW); on Linux it builds the
# transcode-capable engine and skips the Windows-only installer.
set -euo pipefail
cd "$(dirname "$0")/.."

EXT_ID="${1:-REPLACE_WITH_EXTENSION_ID}"

# Engine exe layout depends on the CMake generator:
#   VS multi-config → build/Release/   Ninja/single-config → build/
ENGINE=""
for p in desktop-tauri/native/build/Release/capturedesk-engine.exe \
         desktop-tauri/native/build/capturedesk-engine.exe; do
  [ -f "$p" ] && ENGINE="$p" && break
done

echo "== 1/4 native engine =="
bash scripts/build-engine.sh
if [ -z "$ENGINE" ]; then
  for p in desktop-tauri/native/build/Release/capturedesk-engine.exe \
           desktop-tauri/native/build/capturedesk-engine.exe \
           desktop-tauri/native/build/Release/capturedesk-engine \
           desktop-tauri/native/build/capturedesk-engine; do
    [ -f "$p" ] && ENGINE="$p" && break
  done
fi
if [ -z "$ENGINE" ]; then
  echo "ERROR: capturedesk-engine binary not found after build" >&2
  exit 1
fi
echo "engine: $ENGINE"

# Stage the engine TOGETHER with its runtime DLL closure (vcpkg FFmpeg +
# MSVC CRT app-local) — the installed engine must run on machines without a
# system-wide FFmpeg, otherwise users hit "avformat-63.dll was not found".
ENGINE_STAGE="build/engine-stage"
mkdir -p "$ENGINE_STAGE"
cp "$ENGINE" "$ENGINE_STAGE/"
case "$ENGINE" in
  *.exe)
    VCPKGBIN="${VCPKG_INSTALLATION_ROOT:-/c/vcpkg}/installed/x64-windows/bin"
    [ -d "$VCPKGBIN" ] || VCPKGBIN="/c/vcpkg/installed/x64-windows/bin"
    if [ -d "$VCPKGBIN" ]; then
      if command -v powershell.exe >/dev/null 2>&1 && [ -f scripts/stage-engine-runtime.ps1 ]; then
        # Precise closure via dumpbin; fall back to the (provably complete)
        # whole-bin copy if the script cannot run for any reason.
        if ! powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/stage-engine-runtime.ps1 \
              -EngineExe "$(cygpath -w "$ENGINE_STAGE/capturedesk-engine.exe")" \
              -VcpkgBin "$(cygpath -w "$VCPKGBIN")" \
              -OutDir "$(cygpath -w "$PWD/$ENGINE_STAGE")"; then
          echo "precise staging failed — copying the whole vcpkg bin dir instead" >&2
          cp -f "$VCPKGBIN"/*.dll "$ENGINE_STAGE/"
        fi
      else
        cp -f "$VCPKGBIN"/*.dll "$ENGINE_STAGE/"
      fi
      for crt in msvcp140.dll msvcp140_1.dll msvcp140_2.dll \
                 vcruntime140.dll vcruntime140_1.dll concrt140.dll; do
        [ -f "/c/Windows/System32/$crt" ] && cp -f "/c/Windows/System32/$crt" "$ENGINE_STAGE/"
      done
    else
      echo "WARNING: vcpkg bin dir not found — engine will miss its FFmpeg DLLs" >&2
    fi
    ;;
esac
ENGINE="$ENGINE_STAGE/capturedesk-engine.exe"
[ -f "$ENGINE" ] || ENGINE="$ENGINE_STAGE/capturedesk-engine"

echo "== 2/4 native messaging host (C#) =="
bash scripts/build-host.sh win-x64
HOST="native-host-cs/publish/capturedesk-native-host.exe"
[ -f "$HOST" ] || HOST="native-host-cs/publish/capturedesk-native-host"
[ -f "$HOST" ] || { echo "ERROR: native host binary not found" >&2; exit 1; }

echo "== 3/4 Tauri shell + NSIS installer =="
bash scripts/build-tauri.sh "$ENGINE" --no-bundle

# Locate the app binary (cargo target dir lives under src-tauri).
APPBIN=""
for c in desktop-tauri/src-tauri/target/release/CaptureDesk.exe \
         desktop-tauri/src-tauri/target/release/capturedesk-desktop \
         desktop-tauri/src-tauri/target/release/capturedesk-desktop.exe; do
  [ -f "$c" ] && APPBIN="$c" && break
done
if [ -z "$APPBIN" ]; then
  echo "ERROR: CaptureDesk app binary not found (build-tauri.sh output missing)" >&2
  exit 1
fi

mkdir -p build/stage dist
cp "$APPBIN" build/stage/CaptureDesk.exe
[ -f desktop-tauri/src-tauri/target/release/WebView2Loader.dll ] && \
  cp desktop-tauri/src-tauri/target/release/WebView2Loader.dll build/stage/

if command -v makensis >/dev/null 2>&1 || [ -x tools/nsis/usr/bin/makensis ]; then
  MAKEN="$(command -v makensis || echo tools/nsis/usr/bin/makensis)"
  cp desktop/assets/icons/CaptureDesk.ico installer/assets/
  ROOT="$PWD"
  # Windows makensis resolves only canonical backslash paths reliably.
  if uname -s | grep -qiE 'MINGW|CYGWIN|MSYS'; then
    W() { cygpath -w "$1"; }
  else
    W() { echo "$1"; }
  fi
  "$MAKEN" \
    -DAPPSRC="$(W "$ROOT/build/stage")" \
    -DENGINEDIR="$(W "$ROOT/$ENGINE_STAGE")" \
    -DHOSTSRC="$(W "$ROOT/$HOST")" \
    -DCD_EXT_ID="$EXT_ID" \
    -DCD_ICON_FILE="$(W "$ROOT/installer/assets/CaptureDesk.ico")" \
    -DCD_WELCOME_BITMAP_FILE="$(W "$ROOT/installer/assets/sidebar.bmp")" \
    -DCD_HEADER_BITMAP_FILE="$(W "$ROOT/installer/assets/header.bmp")" \
    -DCD_LICENSE_FILE="$(W "$ROOT/LICENSE")" \
    -DOUTFILE="$(W "$ROOT/dist/CaptureDeskSetup.exe")" \
    -V2 installer/CaptureDesk.nsi
else
  echo "!! makensis not found — skipping installer compile (app staged in build/stage)" >&2
fi

echo "== 4/4 assemble dist/ =="
bash scripts/build-extension.sh

rm -f dist/checksums.txt
if command -v sha256sum >/dev/null 2>&1; then
  (cd dist && sha256sum CaptureDeskSetup.exe CaptureDesk-Chrome-Extension.zip > checksums.txt 2>/dev/null) || true
  if [ ! -s dist/checksums.txt ]; then
    # Installer skipped (e.g. Linux host without makensis) — checksum what exists.
    (cd dist && sha256sum CaptureDesk-Chrome-Extension.zip > checksums.txt)
  fi
else
  (cd dist && powershell.exe -NoProfile -Command \
    "Get-FileHash CaptureDeskSetup.exe,CaptureDesk-Chrome-Extension.zip -Algorithm SHA256 | ForEach-Object { \"{0}  {1}\" -f \$_.Hash.ToLower(), \$([IO.Path]::GetFileName(\$_.Path)) } | Set-Content checksums.txt")
fi

echo
echo "dist/ ready:"
ls -lh dist/

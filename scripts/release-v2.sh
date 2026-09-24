#!/usr/bin/env bash
# CaptureDesk v2 — full release pipeline on a Windows dev box / CI runner:
#   engine (C++) → host (C#) → shell (Tauri/NSIS) → dist + checksums.
#
# Intended for PowerShell host running Git Bash; see .github/workflows for
# the canonical CI invocation.
set -euo pipefail
cd "$(dirname "$0")/.."

EXT_ID="${1:-REPLACE_WITH_EXTENSION_ID}"

echo "== 1/4 native engine =="
bash scripts/build-engine.sh
ENGINE="desktop-tauri/native/build/Release/capturedesk-engine.exe"

echo "== 2/4 native messaging host (C#) =="
bash scripts/build-host.sh win-x64
HOST="native-host-cs/publish/capturedesk-native-host.exe"

echo "== 3/4 Tauri shell + NSIS bundle =="
bash scripts/build-tauri.sh "$ENGINE" --bundles nsis

echo "== 4/4 assemble dist/ =="
mkdir -p dist
cp "desktop-tauri/target/release/bundle/nsis/CaptureDesk_2.0.0-alpha.1_x64-setup.exe" \
   dist/CaptureDeskSetup.exe
cp -r dist/../extension dist/capturedesk-chrome-extension.tmp
rm -rf dist/capturedesk-chrome-extension.tmp

# Extension bundle (zip) if not already present from build-extension.sh
if [[ ! -f dist/CaptureDesk-Chrome-Extension.zip ]]; then
  bash scripts/build-extension.sh
fi

rm -f dist/checksums.txt
if command -v sha256sum >/dev/null 2>&1; then
  (cd dist && sha256sum CaptureDeskSetup.exe CaptureDesk-Chrome-Extension.zip > checksums.txt)
else
  (cd dist && powershell.exe -NoProfile -Command \
    "Get-FileHash CaptureDeskSetup.exe,CaptureDesk-Chrome-Extension.zip -Algorithm SHA256 | ForEach-Object { \"{0}  {1}\" -f \$_.Hash.ToLower(), \$([IO.Path]::GetFileName(\$_.Path)) } | Set-Content checksums.txt")
fi

echo
echo "dist/ ready:"
ls -lh dist/

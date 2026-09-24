#!/usr/bin/env bash
# CaptureDesk release orchestrator: builds every artifact into dist/.
#   dist/CaptureDeskSetup.exe
#   dist/CaptureDesk-Chrome-Extension.zip
#   dist/capturedesk-chrome-extension/
#   dist/checksums.txt
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> [1/4] CaptureDesk Chrome extension"
bash "$ROOT/scripts/build-extension.sh"

echo "==> [2/4] CaptureDesk Desktop (Windows x64 package)"
bash "$ROOT/scripts/build-desktop.sh"

echo "==> [3/4] CaptureDesk Setup installer"
bash "$ROOT/scripts/build-installer.sh"

echo "==> [4/4] Checksums"
bash "$ROOT/scripts/checksums.sh"

echo ""
echo "CaptureDesk dist/ ready:"
ls -la "$ROOT/dist"

#!/usr/bin/env bash
# CaptureDesk release orchestrator — v1 Electron suite.
#
# NOTE: since the v2 native stack, the NSIS installer stages the Tauri app +
# C++ engine + C# host, so it is built by scripts/release-v2.sh (or the tag
# CI pipeline). This script still produces the v1 desktop package and the
# extension bundle:
#   dist/CaptureDesk-Chrome-Extension.zip
#   dist/capturedesk-chrome-extension/
#   dist/checksums.txt
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> [1/3] CaptureDesk Chrome extension"
bash "$ROOT/scripts/build-extension.sh"

echo "==> [2/3] CaptureDesk Desktop (Windows x64 package, v1 Electron)"
bash "$ROOT/scripts/build-desktop.sh"

echo "==> [3/3] Checksums"
bash "$ROOT/scripts/checksums.sh"

echo ""
echo "CaptureDesk dist/ ready:"
ls -la "$ROOT/dist"
echo ""
echo "For the v2 native-stack installer run: scripts/release-v2.sh"

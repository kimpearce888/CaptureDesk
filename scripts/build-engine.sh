#!/usr/bin/env bash
# CaptureDesk v2 — build the native C++ engine sidecar (capturedesk-engine).
#
# Windows (MSVC + vcpkg):  vcpkg install nlohmann-json ffmpeg[x264,vpx,opus]
# Linux/CI (transcode only): apt install nlohmann-json3-dev libavformat-dev
#   libavcodec-dev libavutil-dev libswscale-dev libswresample-dev
set -euo pipefail
cd "$(dirname "$0")/../desktop-tauri/native"

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release ${VCPKG_TOOLCHAIN:+-DCMAKE_TOOLCHAIN_FILE=$VCPKG_TOOLCHAIN}
cmake --build build --config Release --parallel

echo
echo "capturedesk-engine built:"
case "$(uname -s)" in
  MINGW*|CYGWIN*) ls -l build/Release/capturedesk-engine.exe ;;
  *) ls -l build/capturedesk-engine ;;
esac

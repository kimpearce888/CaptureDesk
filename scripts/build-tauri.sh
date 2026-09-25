#!/usr/bin/env bash
# CaptureDesk v2 — build the Tauri desktop app (shell + webview UI).
#
# Prereqs: Rust 1.77+ (rustup), Tauri 2 system prerequisites
# (https://tauri.app/start/prerequisites/), and a built engine sidecar
# (scripts/build-engine.sh) copied into src-tauri/engine/ for bundling.
set -euo pipefail
cd "$(dirname "$0")/../desktop-tauri"

# Stage the engine sidecar as a bundle resource.
if [ $# -lt 1 ]; then
  echo "usage: build-tauri.sh <path-to-capturedesk-engine> [extra tauri args…]" >&2
  exit 1
fi
ENGINE_BIN="$1"
if [ ! -f "$ENGINE_BIN" ]; then
  echo "usage: build-tauri.sh <path-to-capturedesk-engine> [extra tauri args…]" >&2
  echo "engine binary not found: $ENGINE_BIN" >&2
  exit 1
fi
mkdir -p src-tauri/engine
cp "$ENGINE_BIN" src-tauri/engine/
shift # consumed the engine path — remaining args go to tauri

cargo tauri build "$@"

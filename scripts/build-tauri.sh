#!/usr/bin/env bash
# CaptureDesk v2 — build the Tauri desktop app (shell + webview UI).
#
# Prereqs: Rust 1.77+ (rustup), Tauri 2 system prerequisites
# (https://tauri.app/start/prerequisites/), and a built engine sidecar
# (scripts/build-engine.sh) copied into src-tauri/engine/ for bundling.
set -euo pipefail
cd "$(dirname "$0")/../desktop-tauri"

# Stage the engine sidecar as a bundle resource.
ENGINE_BIN="$1" # path to capturedesk-engine(.exe)
if [[ -z "${1:-}" || ! -f "$ENGINE_BIN" ]]; then
  echo "usage: build-tauri.sh <path-to-capturedesk-engine>" >&2
  exit 1
fi
mkdir -p src-tauri/engine
cp "$ENGINE_BIN" src-tauri/engine/

cargo tauri build "$@"

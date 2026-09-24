#!/usr/bin/env bash
# Write dist/checksums.txt (SHA-256) for every release artifact.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
OUT="$DIST/checksums.txt"

: > "$OUT"
for f in CaptureDeskSetup.exe CaptureDesk-Chrome-Extension.zip; do
  if [ -f "$DIST/$f" ]; then
    (cd "$DIST" && sha256sum "$f") >> "$OUT"
  fi
done

cat "$OUT"
echo "[CaptureDesk] checksums written."

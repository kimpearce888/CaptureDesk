#!/usr/bin/env bash
# Fetch a Linux build of NSIS (makensis) without root, from Debian packages.
# Extracts to tools/nsis and verifies it runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/tools"
NSIS_VER="${NSIS_VER:-3.11-1}"
BASE="http://deb.debian.org/debian/pool/main/n/nsis"

mkdir -p "$TOOLS"
cd "$TOOLS"

if [ -x "nsis/usr/bin/makensis" ]; then
  echo "[CaptureDesk] NSIS already present."
else
  echo "[CaptureDesk] downloading nsis-common + nsis ($NSIS_VER)…"
  curl -sfO "$BASE/nsis-common_${NSIS_VER}_all.deb"
  curl -sfO "$BASE/nsis_${NSIS_VER}_amd64.deb"
  dpkg-deb -x "nsis-common_${NSIS_VER}_all.deb" nsis
  dpkg-deb -x "nsis_${NSIS_VER}_amd64.deb" nsis
  rm -f "nsis-common_${NSIS_VER}_all.deb" "nsis_${NSIS_VER}_amd64.deb"
fi

export NSISDIR="$TOOLS/nsis/usr/share/nsis"
"$TOOLS/nsis/usr/bin/makensis" -VERSION
echo "[CaptureDesk] NSIS ready."

#!/usr/bin/env bash
# CaptureDesk v2 — build the C# native messaging host (capturedesk-native-host).
# Produces a self-contained single-file binary in native-host-cs/publish/.
set -euo pipefail
cd "$(dirname "$0")/../native-host-cs"

RID="${1:-win-x64}"
dotnet publish capturedesk-native-host.csproj -c Release -r "$RID" \
  -o publish --nologo

echo
echo "capturedesk-native-host ($RID) built:"
ls -lh publish/

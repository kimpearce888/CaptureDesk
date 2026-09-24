This directory is populated at build time by scripts/build-engine.sh with the
compiled capturedesk-engine sidecar binary (C++17). It is bundled into the
desktop package via tauri.conf.json `bundle.resources: ["engine/*"]`.

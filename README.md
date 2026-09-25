# CaptureDesk

An independent, professional screen-recording product: a Chrome extension and a
Windows desktop application with an editor — all original branding, all local.

> ## ✨ Branch `v2-native` — same product, native stack
>
> You are viewing the **v2 native stack** branch. Every v1 feature is
> preserved, but the runtime is rebuilt with the best language per component:
>
> | Component | v2 stack |
> |---|---|
> | Desktop app | **Tauri 2** (Rust shell) + ported webview UI (~10 MB, not Electron) |
> | Capture & encode | **C++17 engine** — Windows.Graphics.Capture, WASAPI, Media Foundation, FFmpeg |
> | Native messaging host | **C# / .NET 8** single-file exe (drop-in, same wire protocol) |
> | Chrome extension | Unchanged (JS — the Chrome-mandated language) |
>
> See [docs/SPEC-NATIVE.md](docs/SPEC-NATIVE.md) for the full decision record,
> the engine protocol and the feature-parity checklist. Build with
> `scripts/build-engine.sh` → `scripts/build-host.sh` → `scripts/build-tauri.sh`.

```
CaptureDesk/  (branch v2-native)
├── extension/         capturedesk-extension       Chrome extension (Manifest V3, JS)
├── desktop-tauri/     capturedesk-desktop         Tauri 2 app
│   ├── src-tauri/     Rust shell (windows, tray, hotkeys, settings, library)
│   ├── native/        capturedesk-engine (C++17: WGC/WASAPI/MF + FFmpeg)
│   └── ui/            ported webview UI + bridge.js (v1-compatible API)
├── native-host-cs/    capturedesk-native-host     C# native messaging host
├── native-host/       (v1 Node host — kept for reference)
├── installer/         capturedesk-installer       NSIS script (CaptureDeskSetup.exe)
├── scripts/           build pipeline (engine, host, tauri, checksums, release)
├── docs/              BRAND.md, SPEC-*.md, BUILDING.md, USER-GUIDE.md
└── dist/              release output (see below)
```

## Release artifacts (`dist/`)

| File | Description |
|------|-------------|
| `CaptureDeskSetup.exe` | Per-user Windows installer for CaptureDesk Desktop |
| `CaptureDesk-Chrome-Extension.zip` | Load-ready CaptureDesk extension bundle |
| `capturedesk-chrome-extension/` | Unpacked copy of the same extension |
| `checksums.txt` | SHA-256 sums of the above |

> **Note:** `CaptureDeskSetup.exe` (~117 MB) is larger than GitHub's 100 MB git
> file limit, so it is published as a binary asset on the
> [GitHub Releases](../../releases) page (tag `v1.0.0`) rather than tracked in
> git. You can always rebuild it from source with `scripts/release.sh` — see
> [docs/BUILDING.md](docs/BUILDING.md).

## What it does

- **Screen recording** — full display, single window, or a drag-selected region
- **Microphone + system audio** mixing, **camera bubble** picture-in-picture
- **Cursor highlight** ring and **click ripples** baked into the capture
- **CaptureDesk Editor** — trim in/out, annotate (pen, highlighter, arrow,
  rectangle), burn annotations on export, PNG snapshots
- **CaptureDesk Export** — WebM (fast stream copy), MP4, animated GIF
- Recordings saved locally as `CaptureDesk_YYYY-MM-DD_HH-mm-ss.webm` into
  `Videos\CaptureDesk` — nothing ever leaves the machine

See [docs/USER-GUIDE.md](docs/USER-GUIDE.md) for end-user instructions,
[docs/BRAND.md](docs/BRAND.md) for the visual identity, and
[docs/BUILDING.md](docs/BUILDING.md) to build everything from source.

## License

MIT — see [LICENSE](LICENSE).

# CaptureDesk

An independent, professional screen-recording product: a Chrome extension and a
Windows desktop application with an editor — all original branding, all local.

> ## ✨ Native stack (v2) — now on `main`
>
> `main` carries the **v2 native stack** (merged from `v2-native`). Every v1
> feature is preserved, but the runtime is rebuilt with the best language per
> component:
>
> | Component | v2 stack |
> |---|---|
> | Desktop app | **Tauri 2** (Rust shell) + ported webview UI (~10 MB, not Electron) |
> | Capture & encode | **C++20 engine** — Windows.Graphics.Capture, WASAPI, Media Foundation, FFmpeg |
> | Native messaging host | **C# / .NET 8** single-file exe (drop-in, same wire protocol) |
> | Chrome extension | Unchanged (JS — the Chrome-mandated language) |
>
> See [docs/SPEC-NATIVE.md](docs/SPEC-NATIVE.md) for the full decision record,
> the engine protocol and the feature-parity checklist. Build with
> `scripts/build-engine.sh` → `scripts/build-host.sh` → `scripts/build-tauri.sh`,
> or run everything at once with `scripts/release-v2.sh`.

```
CaptureDesk/  (main — v2 native stack)
├── extension/         capturedesk-extension       Chrome extension (Manifest V3, JS)
├── desktop-tauri/     capturedesk-desktop         Tauri 2 app
│   ├── src-tauri/     Rust shell (windows, tray, hotkeys, settings, library)
│   ├── native/        capturedesk-engine (C++20: WGC/WASAPI/MF + FFmpeg)
│   └── ui/            ported webview UI + bridge.js (v1-compatible API)
├── native-host-cs/    capturedesk-native-host     C# native messaging host
├── desktop/           v1 Electron app (superseded, kept for reference)
├── native-host/       v1 Node host (kept for reference)
├── installer/         capturedesk-installer       NSIS script (CaptureDeskSetup.exe)
├── scripts/           build pipeline (engine, host, tauri, installer, release)
└── docs/              BRAND.md, SPEC-*.md, BUILDING.md, USER-GUIDE.md
```

## Releases

Binaries are **never tracked in git** — `dist/` is local build output only.
Published assets live on the [GitHub Releases](../../releases) page and are
produced automatically by the tag-triggered pipeline
(`.github/workflows/release.yml`: push a `v2*` tag → Windows runner builds the
engine, host, Tauri shell and NSIS installer → assets + SHA-256 checksums are
attached).

| Asset | Description |
|------|-------------|
| `CaptureDeskSetup.exe` | Per-user Windows installer (v2: app + engine + native host) |
| `CaptureDesk-Chrome-Extension.zip` | Load-ready CaptureDesk extension bundle |
| `checksums.txt` | SHA-256 sums of the above |

You can also rebuild everything locally — see [docs/BUILDING.md](docs/BUILDING.md).

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

# CaptureDesk

An independent, professional screen-recording product: a Chrome extension and a
Windows desktop application with an editor — all original branding, all local.

```
CaptureDesk/
├── extension/      capturedesk-extension      Chrome extension (Manifest V3)
├── desktop/        capturedesk-desktop        Electron desktop app (win32)
│                   └── src/editor-core      capturedesk-editor (trim/annotate/export)
├── native-host/    capturedesk-native-host    optional native messaging host
├── installer/      capturedesk-installer      NSIS installer script (CaptureDeskSetup.exe)
├── scripts/        build pipeline (extension zip, packaging, installer, checksums)
├── docs/           BRAND.md, SPEC-*.md, BUILDING.md
└── dist/           release output (see below)
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

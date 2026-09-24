# CaptureDesk Desktop

Professional local screen recording, editing, and export — 100% on-device.

CaptureDesk Desktop records a full display, a single application window, or a
precisely selected region, with microphone, system audio, a camera bubble,
cursor highlight and click ripples. Recordings land in your **CaptureDesk
Recordings** folder (`Videos\CaptureDesk`) and can be trimmed, annotated and
exported (WebM / MP4 / GIF / PNG) in **CaptureDesk Editor**. Nothing is ever
uploaded.

## Features

- **Fullscreen / Window / Region** capture (per-display region pickers)
- Microphone + system audio (Windows loopback) mixing
- Camera bubble — draggable, always-on-top, mirrored
- Cursor highlight ring and click ripples (native input hooks when available)
- Floating toolbar: timer, pause/resume, stop, countdown
- Recordings library: play, edit, rename, reveal, delete
- **CaptureDesk Editor**: trim in/out, annotate (pen, highlighter, arrow,
  rectangle), burn annotations on export, PNG snapshots
- **CaptureDesk Export**: WebM (fast stream copy), MP4, animated GIF
- Global hotkeys: `Ctrl+Alt+R` start/stop · `Ctrl+Alt+P` pause · `Ctrl+Alt+E` editor
- System tray with quick controls, minimize-to-tray behavior
- `capturedesk://` protocol registration

## Development

```bash
npm install
npm start
```

Requirements: Node.js 18+ (Node 20+ recommended). The app ships with
`@ffmpeg/ffmpeg` + `@ffmpeg/core` (WebAssembly) so exports run fully offline.

## Security posture

- Renderers run with `contextIsolation: true`, `nodeIntegration: false`
- All filesystem access goes through a restricted IPC surface in the main
  process (paths are validated against the app root and CaptureDesk folders)
- Media permissions are granted only to CaptureDesk windows

## Packaging

The installer (`CaptureDeskSetup.exe`) is produced by
`capturedesk-installer` — see `../docs/BUILDING.md` in the project root.

## License

MIT — see [LICENSE](LICENSE).

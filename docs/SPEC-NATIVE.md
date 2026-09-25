# CaptureDesk v2 — Native Stack Specification & Decision Record

Branch: `v2-native` · Status: alpha (2.0.0-alpha.1) · Feature parity with v1: full

The v2 branch keeps the **product identical** — same features, same brand, same
UI copy — while replacing the JavaScript-only runtime with a native stack
chosen per component on merit.

---

## 1. Stack decisions ("what is best, where")

| Component | v1 (main) | v2 (this branch) | Why |
|---|---|---|---|
| Desktop shell | Electron 31 (Chromium + Node) | **Tauri 2 (Rust)** | ~8–12 MB binary instead of ~200 MB, ~10× lower idle RAM, stronger sandbox model; the branded webview UI is ported 1:1 instead of rewritten |
| Capture & encode | Chromium `getUserMedia` in a hidden renderer + ffmpeg.wasm | **C++17 engine** (`capturedesk-engine` sidecar): Windows.Graphics.Capture, WASAPI, Media Foundation, FFmpeg | Real-time media belongs in a GC-free language with first-class OS capture APIs; no wasm memory ceiling, no double-buffering through JS |
| Native messaging host | Node.js script (needs Node installed) | **C# / .NET 8** single-file exe | JSON/stdio protocol logic is trivial and safe in C#; `dotnet publish` ships one self-contained binary — no runtime prerequisite for users |
| Chrome extension | MV3 (JS) | **Unchanged (JS)** | Chrome *mandates* JS/HTML/CSS for extensions; the only native surface is native messaging, which now talks to the C# host |
| Installer | NSIS | **NSIS** (via Tauri bundler or `installer/CaptureDesk.nsi`) | Already branded, per-user, tiny; Tauri emits it natively |

**Language role summary:** Rust = secure shell glue · C++ = deterministic media
path · C# = protocol plumbing · JS = UI + the Chrome-mandated extension.
Each language is used only where it is genuinely the best tool.

## 2. Architecture

```
┌──────────────────────────── Chrome ────────────────────────────┐
│  CaptureDesk extension (MV3, JS)                               │
│      └── native messaging ──► capturedesk-native-host (C#)     │
└────────────────────────────────┬───────────────────────────────┘
                                 │ capturedesk:// deep link
┌────────────────────────────────▼───────────────────────────────┐
│  CaptureDesk Desktop (Tauri 2 / Rust shell)                    │
│   windows: dashboard · toolbar · region · camera bubble ·      │
│            CaptureDesk Editor (webview UI, ported JS)          │
│                                                                │
│   shell ◄──JSON lines/stdio──► capturedesk-engine (C++17)      │
│            start/stop/pause/list-sources/transcode             │
│            state/done/progress/error events                    │
│                                                                │
│   engine internals (Windows):                                  │
│     WGC screen/window frames ─┐                                │
│     WASAPI mic + loopback ────┼─► RGBA compositor ─► FFmpeg    │
│     MF camera PiP ────────────┤   (cursor ring, click          │
│     LL mouse hook ripples ────┘    ripples, PiP card)          │
└────────────────────────────────────────────────────────────────┘
```

Key protocol rules:

- Media bytes **never** cross the shell/engine channel; the engine writes
  recordings and exports to disk itself (`Videos\CaptureDesk` by default).
- `transcode` is asynchronous: the engine answers no synchronous body and
  later resolves the request with an **id-tagged** `done`/`error` event.
- Untagged `state`/`progress` events broadcast to the UI via Tauri events
  using the exact v1 channel names (`rec-state`, `export-progress`, …).

## 3. Feature parity checklist

| Feature (v1) | v2 implementation |
|---|---|
| Screen / window recording | WGC item per monitor / HWND (`screen:N`, `window:0x…`) |
| Drag-selected region | Same region picker window; engine crops frames before encode |
| Microphone + system audio mix | Two WASAPI clients (capture + render loopback) → stereo mix |
| Camera bubble (PiP) | Same bubble window; MF camera frames composited bottom-right |
| Cursor highlight ring | CPU ring with soft stroke, teal `#5EEAD4`, size from settings |
| Click ripples | Low-level mouse hook → expanding amber ripples, baked in |
| Countdown / pause / resume / stop | Engine FSM; toolbar + hotkeys + tray unchanged |
| Recording naming & folder | `CaptureDesk_YYYY-MM-DD_HH-mm-ss.webm` in `Videos\CaptureDesk` |
| CaptureDesk Editor (trim/annotate) | Same editor UI; annotation math unchanged (JS canvas) |
| CaptureDesk Export WebM | Engine: VP9 (+Opus), stream-level trim + overlay burn-in |
| CaptureDesk Export MP4 | Engine: H.264 + AAC (v1 fell back to MPEG-4 — v2 encodes properly) |
| CaptureDesk Export GIF | Engine: GIF encoder |
| PNG snapshots | Unchanged (editor canvas → restricted-FS write) |
| Recordings library (rename/remove/reveal/pick dir) | Rust `library.rs`, same entry shape `{file,name,size,mtime}` |
| Settings persistence | `capturedesk-settings.json`, same keys as v1 `store.js` |
| Global hotkeys (Ctrl+Alt+R / Ctrl+Alt+P) | `tauri-plugin-global-shortcut`, same semantics |
| Tray (Start/Stop/Recordings/Settings/Quit) | `tray.rs`, same menu items |
| `capturedesk://editor?file=…` deep link | Registry-registered scheme → single-instance → editor window |
| Extension → host transfer (begin/chunk/end/abort) | C# host, byte-identical wire protocol |
| "CaptureDesk is ready" | Dashboard toast on the `capturedesk-ready` event |

Removed in v2: the hidden Electron compositor renderer and ffmpeg.wasm
(`editor-core/trim.js` arg builders are no longer called; they remain only as
historical reference). `editor-core/compose.js` is now the native engine
loader and `editor-core/exporter.js` the engine hand-off.

## 4. Build & test matrix

| Target | Commands | Notes |
|---|---|---|
| Shell (Rust) | `cargo check` / `cargo tauri build` | needs Rust 1.77+, Tauri 2 prereqs |
| Engine (C++, Windows) | `cmake -B build && cmake --build build` | vcpkg: `nlohmann-json ffmpeg[x264,vpx,opus]`; Windows SDK ≥ 10.0.19041 (C++/WinRT) |
| Engine (C++, Linux CI) | same | transcode/export only — capture stubs fail gracefully |
| Host (C#) | `dotnet publish -r win-x64` | single-file, self-contained |
| UI/extension | `node --check` + JSON validation | pure JS, no bundler |

CI (`.github/workflows/ci.yml`) runs all four on every push to the branch.

## 5. Known alpha limitations

- Capture is Windows-only in v2 alpha (the engine reports a clear error on
  other platforms; exports work cross-platform).
- Region crop + highlights composite at capture resolution; quality presets
  scale after compositing (ring size scales with it).
- GIF encoding uses the libav palette path (single-pass) rather than the
  v1 two-pass palettegen pipeline.
- `library.json` rename-cache from v1 is not migrated (renames live in the
  filesystem only).

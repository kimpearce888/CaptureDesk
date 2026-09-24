# Building CaptureDesk

Everything builds from this repository on a Linux CI host (Windows
cross-packaging requires no wine and no code-signing certificate).

## Prerequisites

- Node.js 18+ (tested on Node 24)
- npm 11+
- `zip`, `curl`, `dpkg-deb` (for the NSIS toolchain fetch)
- Python 3 + Pillow (only to regenerate brand assets: `scripts/gen-icons.py`)

## One-shot release

```bash
bash scripts/release.sh
```

Produces:

```
dist/
    CaptureDeskSetup.exe
    CaptureDesk-Chrome-Extension.zip
    capturedesk-chrome-extension/
    checksums.txt
```

## Step by step

| Script | What it does |
|--------|--------------|
| `scripts/fetch-nsis.sh` | Downloads + extracts a Linux NSIS 3.11 (makensis) into `tools/` — no root needed |
| `scripts/build-extension.sh` | Copies the extension into `dist/capturedesk-chrome-extension/` and zips it |
| `scripts/build-desktop.sh` | Cross-packages CaptureDesk Desktop for win32-x64 with `@electron/packager` (pure-JS resedit embeds the icon and version info) into `build/CaptureDesk-win32-x64/` |
| `scripts/build-installer.sh` | Compiles `dist/CaptureDeskSetup.exe` from the packaged build with makensis |
| `scripts/checksums.sh` | Writes `dist/checksums.txt` (SHA-256) |
| `scripts/gen-icons.py` | Regenerates the original brand assets (icons, .ico, installer bitmaps) |

## Desktop development

```bash
cd desktop
npm install        # electron binary may need: node node_modules/electron/install.js
npm start          # or: xvfb-run ./node_modules/.bin/electron . (headless)
```

Smoke-test flags used by CI:

```bash
electron . --editor-smoke    # opens CaptureDesk Editor, exercises ffmpeg.wasm
electron . --recorder-smoke  # opens the hidden compositor window
```

## Extension development

Load `extension/` (or `dist/capturedesk-chrome-extension/`) via
`chrome://extensions` → *Load unpacked*.

## Notes on the Windows package

- `@ffmpeg/ffmpeg` + `@ffmpeg/core` are bundled so exports work fully offline.
- `uiohook-napi` ships prebuilds for `win32-x64` inside the npm tarball, so
  native click hooks work in the cross-packaged build.
- The app is packaged **without asar** on purpose: the editor's export engine
  loads its WebAssembly core from `resources/app/node_modules` via `file://`
  URLs, which must be real files.

## Versioning

Bump `version` in `extension/manifest.json` and `desktop/package.json`, and
`PRODUCTVER` in `installer/CaptureDesk.nsi`, then re-run `scripts/release.sh`.

# SPEC — CaptureDesk Desktop (`capturedesk-desktop`, Electron)

Build a complete, production-quality Electron desktop application: a
professional local screen recorder with a recording library, a trim/annotate
editor, and local export. Read `docs/BRAND.md` FIRST and follow it exactly
(naming, palette, typography, voice, icons). All UI text uses the product
name exactly as specified there (e.g. "Start Recording", "CaptureDesk
Settings", "CaptureDesk Recordings", "CaptureDesk Editor", "CaptureDesk
Export", "CaptureDesk Desktop", "CaptureDesk is ready").

Write code ONLY inside `/home/z/my-project/CaptureDesk/desktop/`.
`package.json` already exists with dependencies pinned
(@ffmpeg/ffmpeg, @ffmpeg/util, uiohook-napi, electron) — DO NOT modify the
dependency list and DO NOT run npm install (already running). Icons already
exist in `assets/icons/`. Use the existing `CaptureDesk.ico` /
`CaptureDesk_*.png` / `tray.png` / `tray-rec.png`.

## File tree (exact)

```
desktop/
  package.json                    (exists — do not touch deps)
  LICENSE                         (MIT, "CaptureDesk Project")
  README.md                       (dev setup: npm install; npm start)
  src/main/index.js               (app lifecycle, single instance, protocol)
  src/main/appPaths.js            (app.setName('CaptureDesk'), dirs, recordings dir)
  src/main/store.js               (settings.json persistence in userData)
  src/main/library.js             (recordings scan/rename/delete/reveal)
  src/main/windows.js             (dashboard, toolbar, region, cam bubble, editor)
  src/main/recorder.js            (recording session orchestration + IPC relay)
  src/main/inputhooks.js          (uiohook-napi optional loader + cursor polling)
  src/main/tray.js
  src/main/shortcuts.js
  src/main/menu.js                (application menu, About CaptureDesk)
  src/preload/index.js            (contextBridge → window.capturedesk)
  src/renderer/shared/ui.css      (design tokens + shared components)
  src/renderer/shared/toast.js    (tiny toast helper)
  src/renderer/dashboard/index.html|.css|.js
  src/renderer/toolbar/index.html|.css|.js
  src/renderer/region/index.html|.css|.js
  src/renderer/cambubble/index.html|.css|.js
  src/renderer/editor/index.html|.css|.js
  src/editor-core/compose.js      (ffmpeg.wasm loader — blob-url strategy)
  src/editor-core/trim.js         (build ffmpeg args for trim/export)
  src/editor-core/annotate.js     (annotation canvas engine)
  src/editor-core/exporter.js     (runs export with progress; PNG snapshot)
```

## Architecture rules

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`
  (needed for ffmpeg.wasm worker/blob strategy; all filesystem access goes
  through IPC handlers in the main process — never from renderers directly).
- `app.setName('CaptureDesk')` BEFORE app ready → userData resolves to
  `%APPDATA%/CaptureDesk` (Windows) / `~/.config/CaptureDesk` (Linux).
- Single-instance lock; second launch focuses dashboard.
- Register `capturedesk://` protocol (open-with hook, no-op handler is fine).
- Session media permission handler: allow `media` requests from our own
  windows (session.setPermissionRequestHandler), deny everything else.
- Every BrowserWindow gets `icon: assets/icons/CaptureDesk.ico` (win) /
  png, `backgroundColor '#0B1120'`, `show:false` + `ready-to-show` pattern.
- No remote code, no eval. JSDoc on functions, 2-space indent, single quotes.

## Settings (`store.js`)

JSON file `settings.json` in userData. Defaults:
```js
{
  fps: 30, quality: '1080p', countdown: 3,
  mic: true, systemAudio: true, cameraBubble: false,
  cursorHighlight: true, clickHighlight: true,
  minimizeToTray: true, hotkeysEnabled: true,
  recordingsDir: <videos dir>/CaptureDesk,   // resolved & created on boot
  highlight: { color: '#5EEAD4', size: 26 },
  firstRunDone: false, version: '1.0.0'
}
```
IPC: `settings:get`, `settings:set` (partial deep-merge, persist, broadcast
`settings-changed` to all windows).

## IPC contract (preload exposes `window.capturedesk.*`)

```
app:      getVersion(), quit(), minimizeToTray()
state:    get() → {state, elapsedMs, sourceMode, region, note}
sources:  list() → [{id, name, thumbnailDataUrl, type:'screen'|'window'}]
rec:      start({mode:'screen'|'window'|'region', sourceId?, options{...}}),
          pause(), resume(), stop(), cancel()
region:   beginSelection(), onSelected(cb)
library:  list() → [{file, name, size, mtime}], rename(file,newName),
          remove(file), reveal(file), dir()
editor:   open(file), readVideoChunk? (not needed — use file:// in <video>)
fs:       readFileBuffer(absPath) → ArrayBuffer (ONLY under app paths,
          used for ffmpeg.wasm assets), writeFile(absPath, ArrayBuffer),
          uniqueExportPath(base, ext)
input:    onCursor(cb) → {x,y}, onRipple(cb) → {x,y}
events (renderer-side `capturedesk.on(channel, cb)` whitelist):
  'rec-state' {state, elapsedMs, note}, 'countdown' {remaining},
  'library-changed', 'settings-changed', 'export-progress' {ratio, message}
```
Main sends `rec-state` transitions: `idle → preparing → countdown →
recording ⇄ paused → stopping → idle|saved`. Include `lastFile` on save.

## Recorder pipeline

- `recorder.js` (main): owns session state. On start with
  `mode:'screen'|'window'`: resolve desktopCapturer source; with
  `mode:'region'`: run region selection first, then capture the ENTIRE
  display that contains the region (crop in compositor).
- Hidden recorder window (`width=1280,height=720,show:false`) loads
  `src/renderer/hidden-rec/index.html`? — NO: keep composition INSIDE the
  toolbar window? NO — cleanest: a dedicated hidden window
  `src/renderer/recorder/index.html|.js` (add these two files) that:
  1. getUserMedia screen video via
     `{video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:sourceId,
     maxFrameRate:fps}}}` (Electron renderer supports this legacy constraint
     syntax; pass `maxWidth/maxHeight` per quality).
  2. System audio (Windows): second getUserMedia with
     `{audio:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId}}}`
     in try/catch — only when options.systemAudio.
  3. Mic: getUserMedia audio with echoCancellation/noiseSuppression/
     autoGainControl when options.mic.
  4. Camera (for PiP): getUserMedia video 640x480 (mirrored when drawn).
  5. Composite to canvas at output size (720p→1280x720, 1080p→1920x1080):
     cover-fit source; crop region when region mode
     (drawImage 9-arg with sx,sy,sw,sh computed from region/DIP→pixels);
     camera PiP bottom-right 22% height with 3px ring + shadow; cursor ring
     (teal `rgba(94,234,212,.9)` ring, size from settings) mapped from
     onCursor IPC positions; click ripples (expanding teal ring 450ms) from
     onRipple IPC.
  6. Draw loop with `setInterval(1000/fps)` (NOT rAF — hidden windows
     throttle rAF). `canvas.captureStream(fps)`.
  7. Audio mixing via AudioContext → MediaStreamDestination → add track.
  8. MediaRecorder `video/webm;codecs=vp9,opus` → vp8 → webm fallback;
     bitrate 8 Mbps @1080p / 5 Mbps @720p; collect chunks.
  9. Pause/resume: recorder.pause()/resume(); elapsed timer excludes pauses.
  10. Stop → Blob → send to main via IPC `rec-save` (ArrayBuffer transfer) →
      main writes `CaptureDesk_YYYY-MM-DD_HH-mm-ss.webm` into recordingsDir,
      fires `library-changed`, state `saved` with lastFile, toolbar closes,
      dashboard shows success toast "Saved to CaptureDesk Recordings".
- `inputhooks.js`: dynamic `import('uiohook-napi')` in try/catch. If it
  loads, subscribe global mouse-down/up → forward screen coords as ripples
  (and expose `nativeHooksAvailable:true` via state). Cursor position ALWAYS
  works: `setInterval(() => screen.getCursorScreenPoint(), 33)` while
  recording. If uiohook is unavailable, clickHighlight gracefully disables
  (state note `click-highlight-unavailable` shown once in dashboard options).
- Region picker (`region` window): per-display fullscreen transparent
  frameless window, dim backdrop (rgba(11,17,32,0.35)), instruction pill
  "Drag to select the area to record — Esc to cancel", live rect with teal
  border + size badge "1280 × 720", mouseup → send display bounds + rect
  (DIP screen coords) → main. Esc cancels.
- Toolbar (`toolbar` window): frameless, alwaysOnTop, skipTaskbar, resizable
  false, ~340x64, draggable via `-webkit-app-region: drag` handle. Shows
  pulsing red dot, tabular timer, Pause/Resume, Stop (teal), camera-bubble
  toggle, and during countdown a "Recording starts in N" state. Position:
  bottom-center of the captured display, above taskbar margin (clamp to
  workArea). Esc-to-cancel only during countdown.
- Camera bubble (`cambubble` window): 190x190, transparent, frameless,
  alwaysOnTop, skipTaskbar, circular video (CSS mask), mirrored, subtle teal
  ring, drag region (whole bubble draggable via CSS), hover shows a small
  close ×. Only visible when options.cameraBubble.
- Failure handling: any getUserMedia rejection → state error → dashboard
  toast with actionable copy ("Screen capture was blocked — grant permission
  and try again").

## Dashboard (`renderer/dashboard`) — window 1120x720, min 960x620, title "CaptureDesk"

Single-page dark layout per BRAND.md:
1. Top bar: logo SVG (24px, same geometry as PNG mark) + "CaptureDesk" +
   right side: settings gear (opens "CaptureDesk Settings" modal), version chip.
2. Hero: pill "100% local & private — recordings never leave your machine",
   H1 "Record your screen.", sub copy, gradient primary button
   **"Start Recording"** (starts with last-used source), secondary ghost
   button "Select area…".
3. Source cards (3): "Fullscreen" / "Window" / "Region" each with inline SVG
   icon, 1-line description, selected state teal ring. Window mode opens a
   source picker modal (grid of desktopCapturer thumbnails, name, search
   filter).
4. Options row: toggles — Microphone, System audio, Camera bubble, Cursor
   highlight, Click highlight; selects — fps (24/30/60), quality (720p/1080p),
   countdown (Off/3s/5s). If uiohook unavailable, Click highlight toggle
   shows tooltip "Unavailable on this machine — will be skipped".
5. "Recent recordings" — up to 6 cards (name, duration, size, date) with
   Play / Edit / Reveal / Delete on hover; footer link "Open CaptureDesk
   Recordings" (opens folder).
6. Status bar: "CaptureDesk is ready" (or live state), plus hotkey hints
   (Ctrl+Alt+R Start/Stop · Ctrl+Alt+P Pause).
7. "CaptureDesk Settings" modal sections: Recording (fps/quality/countdown,
   recordings folder + Change… + Reveal), Highlights (color/size), General
   (minimize to tray, hotkeys enabled), About CaptureDesk (logo, version,
   MIT, "Made for privacy-first screen capture"). First run → "Welcome to
   CaptureDesk" onboarding modal (3 quick steps + Got it) unless
   firstRunDone.

## Library (`library.js`)

- Scan recordingsDir (flat) for `*.webm|*.mp4`, sort mtime desc, cache
  metadata in userData/library.json; broadcast `library-changed` on changes.
- rename → sanitize (no path separators, keep extension), remove → fs.unlink
  with confirm dialog handled in renderer, reveal → shell.showItemInFolder.

## Editor — window 1180x760 min 1000x640, title "CaptureDesk Editor"

Layout:
1. Header: "CaptureDesk Editor" + file name (editable) + Close.
2. Left/main: video player (file:// video element) with overlay canvas for
   annotations; transport: play/pause, time / duration (tabular), frame step
   buttons, speed 0.5–2x.
3. Timeline: full-width waveform-free scrub bar with in/out trim handles
   (drag, 50ms snap), shaded cut regions, zoom ignored (single scale OK),
   "Reset trim" button. Trim state {in, out} in seconds.
4. Annotation toolbar: tools — Select/none, Pen, Highlighter (60% alpha,
   thick), Arrow, Rectangle; color swatches (teal, amber, white, red);
   width 2/4/8; Undo, Clear. Strokes stored with {tool, color, width, points,
   tStart, tEnd}; drawing allowed only while paused at time t (stroke gets
   tStart=t, tEnd=+1.5s default; editing order = draw order); canvas renders
   strokes active at current playback time with fade-in 200ms.
5. Right panel "CaptureDesk Export": trim summary (cut vs kept duration),
   format cards: "WebM (fast, lossless trim)" (stream copy), "MP4 (more
   compatible)" (re-encode, honest note "slower — re-encodes video"),
   "Animated GIF (12 fps, 480px)", "PNG snapshot" (current frame with
   annotations). Toggle "Burn annotations into export" (auto-enabled when
   strokes exist). "Export" button → runs ffmpeg.wasm with progress bar
   (export-progress events) → success toast + Reveal button. Output via
   fs.uniqueExportPath → `CaptureDesk_2026-09-24_15-30-22_trim.webm` style
   names in recordingsDir.
6. ffmpeg.wasm loading (`editor-core/compose.js`): UMD scripts are NOT
   loadable via <script> from node_modules inside packaged apps reliably —
   use the blob strategy: IPC `fs:readFileBuffer` for
   `node_modules/@ffmpeg/ffmpeg/dist/umd/ffmpeg.js`,
   `node_modules/@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js`,
   `node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js` and `ffmpeg-core.wasm`
   (resolve paths relative to app root via `app.getAppPath()` in main;
   in dev that is `desktop/`). Create Blob URLs (correct MIME: text/js for
   scripts), inject the main UMD via <script src=blobURL>, then
   `new FFmpegWASM.FFmpeg()` with
   `load({classWorkerURL, coreURL, wasmURL})` (all blob URLs). Cache the
   instance. Any failure → editor shows "Export engine unavailable — PNG
   snapshot still works" and disables re-encode formats gracefully.
   Trim/copy WebM path: `-ss in -to out -i input -c copy -avoid_negative_ts
   make_zero out.webm` (put -ss/-to BEFORE -i for fast seek; with c copy add
   `-copyts`? — choose args that keep A/V sync: use `-ss` before -i and
   `-to` after -i relative… VERIFY your flag order logic and comment it).
   MP4: `-c:v mpeg4 -q:v 5 -c:a aac -b:a 128k` (LGPL core has mpeg4, not
   libx264 — do NOT reference libx264). GIF: fps 12, scale 480:-1, palettegen
   / paletteuse two-pass. Progress: FFmpeg 'progress' event → IPC.
   On export completion also handle Cancel (ffmpeg.terminate()).
7. Annotation burn-in: render all strokes to ONE transparent PNG sized to
   video; per-stroke timing needs multiple overlays — chain up to 6
   `-i strokeN.png -filter_complex` overlay entries with
   `enable='between(t,a,b)'`; if >6 strokes, fall back to single merged PNG
   (all strokes visible from their tStart to tEnd not individually —
   acceptable simplification, comment it).

## Tray (`tray.js`)

Icon `assets/icons/tray.png`; tooltip "CaptureDesk". Context menu:
"Start Recording"/"Stop Recording" (state-aware label), "Pause"/"Resume",
separator, "Open CaptureDesk", "Open CaptureDesk Recordings", "CaptureDesk
Settings", separator, "Quit CaptureDesk". While recording, swap icon to
`tray-rec.png`. Click → focus dashboard. Balloon on first record? Skip.

## Shortcuts (`shortcuts.js`) — when settings.hotkeysEnabled

- `Ctrl+Alt+R` start/stop, `Ctrl+Alt+P` pause/resume, `Ctrl+Alt+E` open
  CaptureDesk Editor with latest recording. Unregister on blur of settings?
  Just re-register on settings-changed; unregisterAll on quit.

## Menu (`menu.js`)

Custom menu: CaptureDesk (About CaptureDesk, Settings…, Quit), File (New
Recording, Open Recordings Folder), Edit (Undo/Redo/Cut/Copy/Paste standard
roles), View (Reload, Toggle DevTools, Zoom), Help (CaptureDesk Help → opens
README in default viewer? just a dialog). Keep minimal but branded.

## Edge cases

1. Recording a window that closes → video track ended → auto-stop & save.
2. Display unplugged mid-capture → treat as ended → save what we have.
3. Two displays with region on secondary → capture that display's source
   (desktopCapturer display_id matching) and crop accordingly.
4. Space in recordings path → all shell operations quote properly.
5. App quit while recording → confirm dialog "Recording in progress — stop
   and save before quitting?" (Stop & save / Discard / Cancel).
6. Recording with zero audio sources → video-only file, note in state.
7. Editor opened for file that got deleted → friendly empty state.
8. Recording duration: include countdown only in state, not in file.

## Quality bar

- All JS passes `node --check` (except files using ESM `import` in renderer
  scripts loaded with `<script type="module">` — still keep them
  `node --check`-compatible syntax-wise where possible; main+preload MUST be
  CommonJS and MUST pass `node --check`).
- All JSON parses; all HTML well-formed; no TODO/FIXME left; no placeholder
  dead buttons; every toggle wired.
- User-facing strings exactly per BRAND.md; the forbidden competitor name
  must appear nowhere.
- Log lines prefixed `[CaptureDesk]`.

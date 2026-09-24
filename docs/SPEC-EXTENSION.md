# SPEC — CaptureDesk Chrome Extension (`capturedesk-extension`)

Build a complete, production-quality Manifest V3 Chrome extension that records
the current tab, a chosen window, or the full screen — with optional webcam
bubble (picture-in-picture), microphone, cursor ring and click ripples — and
saves recordings locally via the Downloads API. Read `docs/BRAND.md` first and
follow it exactly (naming, palette, typography, voice). All UI text uses the
product name exactly as specified there.

Write code ONLY inside `/home/z/my-project/CaptureDesk/extension/`.
Icons already exist in `extension/assets/icons/` (icon16/32/48/128.png) — do
not regenerate them. No third-party npm dependencies and no build step: plain
HTML/CSS/JS (ES modules allowed inside extension pages; the service worker
must be a classic script or module per manifest config you choose — if module,
set `"type": "module"`).

## File tree (exact)

```
extension/
  manifest.json
  LICENSE                      (MIT, "CaptureDesk Project")
  README.md                    (install/load-unpacked guide, features)
  src/common/defaults.js       (settings defaults + helpers)
  src/common/messages.js       (message type constants, shared)
  src/sw/service-worker.js     (background: state machine, offscreen lifecycle,
                                badge, downloads save, content-script injection)
  src/offscreen/offscreen.html
  src/offscreen/offscreen.js   (compositor + MediaRecorder + save)
  src/popup/popup.html
  src/popup/popup.css
  src/popup/popup.js
  src/options/options.html
  src/options/options.css
  src/options/options.js
  src/content/overlay.js       (cursor ring + click ripples; injected on demand)
  assets/icons/icon16.png icon32.png icon48.png icon128.png
  assets/logo.svg              (inline-able vector of the brand mark — create it,
                                same geometry as the PNG: teal gradient rounded
                                square, white monitor frame, rec-dot badge)
```

## manifest.json requirements

- `"name": "CaptureDesk"`, `"version": "1.0.0"`,
  `"description"`: original copy, e.g. "Screen recorder for tabs, windows, and
  your full desktop — camera bubble, microphone, cursor & click highlights,
  instant local saving. 100% on-device."
- `"permissions": ["tabCapture", "desktopCapture", "offscreen", "storage",
  "downloads", "scripting"]`
- `"host_permissions": ["<all_urls>"]` (needed for on-demand content-script
  injection of the overlay)
- `"action"` with `default_popup: src/popup/popup.html` and default icons.
- `"background": { "service_worker": "src/sw/service-worker.js" }`
- `"options_page": "src/options/options.html"`
- `"minimum_chrome_version": "116"`
- `"offline_enabled": true`
- No remote code. No `unsafe-eval`. Default CSP is fine.

## Message contract (`src/common/messages.js`)

```js
export const MSG = {
  // popup -> SW
  GET_STATE: 'cd:get-state',
  START: 'cd:start',            // payload: {mode:'tab'|'window'|'screen',
                                //   options:{mic,cam,cursor,clicks,fps,quality,countdown}}
  PAUSE: 'cd:pause', RESUME: 'cd:resume',
  STOP: 'cd:stop', CANCEL: 'cd:cancel',
  // SW -> offscreen
  REC_SETUP: 'cd:rec-setup',    // payload: {mode, tabId?, streamId?, audioMode?, options}
  REC_START: 'cd:rec-start',    // payload: {countdown} (offscreen runs countdown)
  REC_PAUSE: 'cd:rec-pause', REC_RESUME: 'cd:rec-resume',
  REC_STOP: 'cd:rec-stop',      // finalize & save
  REC_CANCEL: 'cd:rec-cancel',  // discard
  // offscreen -> SW
  REC_STATE: 'cd:rec-state',    // {state:'preparing'|'recording'|'paused'|'stopping'|'idle',
                                //  elapsedMs, error?}
  REC_SAVED: 'cd:rec-saved',    // {fileName, size, via:'downloads'|'native'}
  // content overlay -> SW
  OVERLAY_READY: 'cd:overlay-ready',
  // popup/options -> SW
  OPTIONS_CHANGED: 'cd:options-changed',
};
```

## Service worker (`service-worker.js`) — state machine

States: `idle → preparing → countdown → recording ⇄ paused → stopping → idle`.

- On START:
  1. Read options from `chrome.storage.sync` (defaults in `defaults.js`).
  2. Resolve the media source:
     - `mode:'tab'`: query active tab (`chrome.tabs.query({active:true,currentWindow:true})`),
       then `chrome.tabCapture.getMediaStreamId({tabId})` — pass streamId to
       offscreen. Note: call getMediaStreamId in the SW AFTER the popup gesture;
       that is fine.
     - `mode:'window'|'screen'`: the POPUP calls
       `chrome.desktopCapture.chooseDesktopMedia(['window'|'screen'], tab, cb)`
       itself (needs a visible page) and passes the returned `streamId` in the
       START message. SW never calls chooseDesktopMedia.
  3. Ensure offscreen document exists:
     `chrome.offscreen.createDocument({url:'src/offscreen/offscreen.html',
     reasons:['USER_MEDIA','DISPLAY_MEDIA'], justification:'CaptureDesk screen recording'})`
     (guard: if `clients`/exists check via `chrome.runtime.getContexts` when
     available, else track a boolean; handle "Only a single offscreen document
     may be created" error by ignoring).
  4. Send REC_SETUP, then REC_START with countdown. Badge: `setBadgeText('REC')`,
     `setBadgeBackgroundColor('#EF4444')`, `setTitle('CaptureDesk — recording')`.
  5. Inject the content overlay into the recorded tab when `mode:'tab'` and
     cursor/click options are on:
     `chrome.scripting.executeScript({target:{tabId}, files:['src/content/overlay.js']})`.
     For window/screen modes, still inject into the active tab (best effort;
     ripples then appear only over browser content — acceptable and documented).
     Track injected tabIds; send an overlay stop message on REC_STOP/CANCEL.
  6. Handle stream/permission failures: send REC_STATE error to popup and
     reset to idle; badge cleared.
- On PAUSE/RESUME/STOP/CANCEL: relay to offscreen; update badge
  (paused → setBadgeText('❚❚') or 'II'; idle → clear).
- On REC_SAVED: `chrome.downloads.download({url: blobUrl, filename:
  'CaptureDesk/<name>.webm', saveAs:false})` — see Save flow below. Then clear
  badge and set a transient title "CaptureDesk is ready".
- Keep last state + last error in `chrome.storage.session` so the popup can
  restore its UI after being closed/reopened.
- Optional native-host path: wrap in try/catch — attempt
  `chrome.runtime.connectNative('com.capturedesk.host')`; if it throws or the
  port disconnects immediately, fall back to downloads. If the port works,
  stream base64 chunks to it (`{type:'begin', fileName}`, `{type:'chunk',
  data}`, `{type:'end'}`) instead of using blob URLs. This is best-effort and
  must never break the downloads fallback.

## Offscreen recorder (`offscreen.js`) — compositor

- Single hidden page. Maintains: source video stream, camera stream (optional),
  mic stream (optional), composited `<canvas>`, WebAudio mix, MediaRecorder.
- Resolution by quality setting: `720p→1280x720`, `1080p→1920x1080`
  (even if source is larger; letterbox/cover-fit source).
- Video composition loop: `setInterval(draw, 1000/fps)` — do NOT rely on
  requestAnimationFrame (offscreen pages throttle rAF). `canvas.captureStream(fps)`.
- Camera bubble: draw round-cornered (or circular) PiP, 22% of canvas height,
  bottom-right with 24px margin, 3px white ring, subtle shadow. Mirror the
  camera horizontally (selfie view).
- Cursor ring & click ripples (when enabled): SW forwards OVERLAY input events
  {type:'cursor'|'down', x, y, dpr, vw, vh} (viewport coords) to offscreen;
  offscreen maps viewport coords → canvas coords using the ratio between the
  captured video frame size and the reported viewport size, then draws:
  - cursor: teal ring (rgba(94,234,212,0.9)), 26px diameter, 2.5px stroke;
  - click: expanding ripple (radius 8→36px over 450ms, alpha 0.9→0,
    fill rgba(94,234,212,0.35), stroke solid teal). Keep an array of active
    ripples with spawn timestamps; cull expired ones each frame.
- Audio: if mic enabled → getUserMedia({audio:{echoCancellation:true,
  noiseSuppression:true, autoGainControl:true}}). If mode is window/screen,
  ALSO try system audio by opening a second getUserMedia with
  `{audio:{mandatory:{chromeMediaSource:'desktop', chromeMediaSourceId: streamId}}}`
  in a try/catch (works when the user ticked "share audio"; ignore failure).
  Mix available sources via AudioContext → MediaStreamDestination → add track
  to canvas stream. If only one source, connect directly.
- MediaRecorder: prefer `video/webm;codecs=vp9,opus`, fallback
  `video/webm;codecs=vp8,opus`, fallback `video/webm`. `videoBitsPerSecond`:
  720p→5_000_000, 1080p→8_000_000. `timeslice`: none (collect ondataavailable
  into an array).
- Pause/resume via `MediaRecorder.pause()/resume()`; keep an accumulated
  elapsed timer (exclude paused time; report via REC_STATE every 500ms).
- Auto-stop: if every video track `ended` fires (user clicked the browser's
  native "Stop sharing", or the tab closed) → finalize & save exactly like
  REC_STOP, then notify SW.
- Save flow (downloads path): build `new Blob(chunks, {type:'video/webm'})`;
  create `URL.createObjectURL(blob)`; send REC_SAVED with the blobUrl to SW;
  SW calls chrome.downloads.download with that URL. Offscreen MUST stay alive
  until SW confirms the download started (SW sends a 'cd:saved-ack' message;
  only then offscreen revokes the URL and resets to idle). Keep total blob
  guard: if blob.size > 2 GiB, report an error state instead.
- Name: `CaptureDesk_YYYY-MM-DD_HH-mm-ss.webm` (local time, zero-padded).
- CANCEL: stop recorder+tracks, discard chunks, idle, no save.
- All audio contexts/nodes closed and tracks stopped on reset (avoid leaks).

## Popup (`popup.html/css/js`) — dark UI per BRAND.md

Layout (max-width 360px):
1. Header: logo (24px) + "CaptureDesk" + version chip. Right side: gear icon →
   opens options page.
2. If idle: mode segmented control `Tab | Window | Screen` (Tab is default).
   Toggles list (custom switches, not checkboxes): "Microphone", "Camera
   bubble", "Cursor highlight", "Click highlights". Quality select
   (720p / 1080p). Countdown select (Off / 3s / 5s). Big primary button
   **"Start Recording"**.
   - For Window/Screen modes the START click first calls
     `chrome.desktopCapture.chooseDesktopMedia([...], tab, cb)` from the popup
     (this shows Chrome's native picker) and then sends START with streamId.
     If the user cancels the picker, do nothing.
3. If recording: timer (tabular nums, red dot pulsing), buttons Pause/Resume
   and **"Stop & save"**, plus a subtle "Cancel" text button (with
   confirm-swap: first click turns it into "Really discard?").
4. If paused: amber "Paused" pill, Resume + Stop.
5. Footer: "Saved to Downloads/CaptureDesk" + "Open CaptureDesk Desktop"
   (non-functional hint text is allowed but must not look like a broken link;
   render it as muted text with a tooltip "Included with CaptureDesk Desktop").
6. All state restored from chrome.storage.session on open.

## Options page (`options.*`) — title "CaptureDesk Settings"

Sections: Recording (default quality, fps 24/30/60, countdown), Highlights
(cursor ring color — teal/amber/white; click ripple color; sizes), Saving
(folder subfolder name — fixed default "CaptureDesk", filename template with
`{date}` `{time}` tokens and a live preview, e.g.
`CaptureDesk_2026-09-24_15-30-22.webm`), About CaptureDesk (version, MIT
license, "100% local — recordings never leave your machine"). Save via
chrome.storage.sync with a "Saved" toast. Every heading uses the product name
where appropriate ("CaptureDesk Settings", "About CaptureDesk").

## Content overlay (`overlay.js`) — injected on demand

- Runs as a classic script (no exports; guard with `window.__cdOverlay` to
  avoid double-injection).
- Elements: `#cd-cursor-ring` (fixed, 26px, pointer-events:none, high z-index,
  teal ring following mousemove with a light lerp), ripples appended to a
  `#cd-ripple-layer` container. Colors read from a config object injected via
  `chrome.storage.session` key `cd.overlayConfig` (SW writes it before
  injection; overlay reads on init with fallback defaults).
- Listens: `mousemove` (throttle via rAF), `pointerdown` → ripple + notify SW
  (`chrome.runtime.sendMessage({type:MSG from common? classic script: use the
  literal string 'cd:input', payload:{type:'down', x:clientX, y:clientY,
  vw:innerWidth, vh:innerHeight, dpr:devicePixelRatio}})`), cursor moves are
  NOT forwarded (offscreen draws the ring from local events… correction:
  offscreen cannot see page events; so forward a throttled 'cursor' message
  at most every 66ms).
- Cleanup: listens for `chrome.runtime.onMessage` 'cd:overlay-stop' → removes
  all nodes + listeners; also self-cleans on `pagehide`.
- Must never affect page interaction: `pointer-events:none` on everything,
  `will-change: transform`, no scroll listeners leaks.

## Edge cases to handle (test your logic by re-reading it line by line)

1. Popup closed during recording — SW keeps state in storage.session; badge
   shows REC; reopening popup shows live timer.
2. User stops sharing from Chrome's native bar → offscreen auto-saves.
3. Mic permission denied → continue video-only, surface state note via
   REC_STATE `{note:'mic-unavailable'}` → popup shows muted warning.
4. Offscreen already exists → reuse.
5. START while recording → popup disables button (SW replies error otherwise).
6. Browser restart mid-recording → SW starts idle (acceptable), badge cleared.
7. tabCapture of a tab that gets closed → track ended → auto-save.
8. Downloads path with existing file name → append ` (2)` before extension
   (chrome.downloads handles onDeterminingFilename? Simply pass
   `conflictAction:'uniquify'`).

## Quality bar

- Zero console errors in SW/popup/offscreen under normal flows.
- All JS must pass `node --check`. All JSON must parse. All HTML well-formed.
- Consistent 2-space indent, single quotes, semicolons, JSDoc on functions.
- Every user-facing string follows docs/BRAND.md voice; product name always
  "CaptureDesk".

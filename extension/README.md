# CaptureDesk — Chrome Extension

Screen recorder for tabs, windows, and your full desktop — camera bubble,
microphone, cursor & click highlights, instant local saving. 100% on-device.

## Features

- Record the current tab, a chosen window, or the entire screen (WebM; VP9
  with automatic VP8 fallback).
- Optional camera bubble (picture-in-picture) with mirrored selfie view.
- Microphone mixing with echo cancellation, noise suppression and auto gain;
  system audio is captured too when you tick "share audio" in Chrome's picker.
- Cursor ring and click ripples rendered both on the page and into the video.
- Countdown (off / 3s / 5s), pause and resume with an elapsed timer that
  excludes paused time.
- Saves locally via the Downloads API under `Downloads/CaptureDesk/` as
  `CaptureDesk_YYYY-MM-DD_HH-mm-ss.webm` (duplicate names are auto-numbered).
- Session state survives closing the popup; the badge shows REC / paused.
- 100% on-device: no servers, no accounts, no telemetry.

## Install (Load unpacked)

1. Unzip `CaptureDesk-Chrome-Extension.zip` — you get a folder whose top
   level contains `manifest.json` (if you see `src/` only, you picked one
   level too deep or too shallow).
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select **the folder that contains
   `manifest.json`** (from the repo: this `extension/` folder).
5. Pin **CaptureDesk** from the toolbar, open the popup, choose a mode and
   press **Start Recording**.

No build step and no dependencies — plain HTML/CSS/JS (Manifest V3,
Chrome/Chromium 116 or newer).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Manifest file is missing or unreadable" when loading | You selected the wrong folder. Pick the folder that **directly contains `manifest.json`**. |
| Popup says the background service is not responding | Open `chrome://extensions`, click the **reload** icon on the CaptureDesk card, then reopen the popup (this also happens after the extension was updated while the popup was open). |
| Popup footer says "Desktop app not connected" | That is **not an error** — recordings save to `Downloads/CaptureDesk/`. Install/launch CaptureDesk Desktop (v2.0.0+) to save into its library instead. |
| Record button does nothing on a `chrome://` page | Chrome forbids capturing browser pages. Switch to a normal `http(s)://` tab, or use Window/Screen mode. |
| No sound in Window/Screen mode | Tick **Share audio** in Chrome's share picker; tab recordings always include tab audio. |
| Recording saved under the wrong name | Duplicate names are auto-numbered; check `Downloads/CaptureDesk/`. |

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `tabCapture` | Capture the current tab. |
| `desktopCapture` | Capture a window or the full screen via Chrome's native picker. |
| `offscreen` | Run the hidden compositor + MediaRecorder page. |
| `storage` | Keep your settings and restore the popup state. |
| `downloads` | Save recordings into `Downloads/CaptureDesk/`. |
| `scripting` | Inject the cursor/click overlay into the recorded tab on demand. |
| `<all_urls>` (host) | Allows the on-demand overlay injection on any page you record. |

## Notes & limits

- In Window/Screen modes the cursor ring and click ripples appear only over
  browser content — the overlay lives in the active tab.
- Recordings larger than 2 GB are not saved (a guard against oversized blobs).
- If the microphone is unavailable, CaptureDesk records video only and tells
  you so instead of failing.
- An optional native messaging host (`com.capturedesk.host`) can receive the
  recording as chunks; when it is not installed, CaptureDesk always falls back
  to the Downloads API.

## Files

- `manifest.json` — Manifest V3 manifest.
- `src/common/` — shared settings defaults and message constants.
- `src/sw/service-worker.js` — recording state machine, badge, save flow,
  overlay injection, offscreen lifecycle.
- `src/offscreen/` — hidden compositor: canvas draw loop, WebAudio mix,
  MediaRecorder, save handshake.
- `src/popup/`, `src/options/` — the popup and CaptureDesk Settings pages
  (dark theme per `docs/BRAND.md`).
- `src/content/overlay.js` — cursor ring + click ripples content script.
- `assets/` — action icons and the brand mark (`logo.svg`).

## License

MIT — see `LICENSE`. © CaptureDesk Project

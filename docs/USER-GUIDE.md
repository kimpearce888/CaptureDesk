# CaptureDesk — User Guide

## 1. Install

### CaptureDesk Desktop (Windows)

1. Run `CaptureDeskSetup.exe`.
2. Choose the install folder (default: `%LOCALAPPDATA%\Programs\CaptureDesk`).
3. Pick optional extras: desktop shortcut, launch at Windows startup.
4. CaptureDesk starts and shows **"CaptureDesk is ready"**.

Recordings land in **`Videos\CaptureDesk`** (change it in *CaptureDesk Settings*).
Settings live in `%APPDATA%\CaptureDesk`.

### CaptureDesk for Chrome

1. Unzip `CaptureDesk-Chrome-Extension.zip`.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select the unzipped folder (or the `capturedesk-chrome-extension/` copy).
3. Click the CaptureDesk icon to start recording. Files are saved to
   `Downloads\CaptureDesk\` as `CaptureDesk_YYYY-MM-DD_HH-mm-ss.webm`.

## 2. Record

1. Pick a source: **Fullscreen**, **Window**, or **Region** (drag a rectangle).
2. Toggle what gets captured: microphone, system audio (Windows), camera
   bubble, cursor highlight, click highlights.
3. Press **Start Recording** (or `Ctrl+Alt+R` anywhere). After the countdown
   the floating toolbar shows the timer; pause with `Ctrl+Alt+P`.
4. Press **Stop** on the toolbar — the recording is saved automatically.

## 3. Edit & export

1. Open a recording from the dashboard (Play/Edit) — it opens in
   **CaptureDesk Editor**.
2. Drag the trim handles to cut the beginning/end.
3. Pause playback and draw annotations: pen, highlighter, arrow, rectangle.
4. Open the **CaptureDesk Export** panel and choose WebM (fast), MP4, or GIF.
   Enable *Burn annotations into export* to bake your markup in.
5. Press **Export** — progress is shown, results are saved into
   CaptureDesk Recordings. Use *Save PNG snapshot* for the current frame.

## 4. Privacy

CaptureDesk records, edits, and exports entirely on your device. There is no
account, no upload, and no telemetry.

## 5. Hotkeys

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+R` | Start / stop recording |
| `Ctrl+Alt+P` | Pause / resume |
| `Ctrl+Alt+E` | Open CaptureDesk Editor (latest recording) |

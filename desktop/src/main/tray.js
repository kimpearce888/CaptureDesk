/**
 * @file CaptureDesk system tray: branded icon, state-aware menu, quick
 * record controls. The icon swaps to the red-dot variant while recording.
 */
const path = require('path');
const { Tray, Menu, app, nativeImage } = require('electron');
const { appRoot } = require('./appPaths');
const store = require('./store');
const recorder = require('./recorder');
const windows = require('./windows');
const library = require('./library');

let tray = null;

/**
 * @param {string} name Icon file name inside assets/icons.
 * @returns {Electron.Tray} A tray built from the given image (not assigned yet).
 */
function image(name) {
  return nativeImage.createFromPath(path.join(appRoot(), 'assets', 'icons', name));
}

/**
 * Rebuild the tray menu from the current session state (also swaps the icon).
 */
function refresh() {
  if (!tray) return;
  const snap = recorder.snapshot();
  const recording = [recorder.STATE.RECORDING, recorder.STATE.PAUSED, recorder.STATE.COUNTDOWN]
    .includes(snap.state);

  tray.setImage(image(recording ? 'tray-rec.png' : 'tray.png'));
  tray.setToolTip('CaptureDesk');

  const items = [];
  if (recording) {
    items.push(
      { label: snap.state === recorder.STATE.PAUSED ? 'Resume Recording' : 'Pause Recording',
        click: () => (snap.state === recorder.STATE.PAUSED ? recorder.resume() : recorder.pause()) },
      { label: 'Stop & Save', click: () => recorder.stop() },
    );
  } else {
    items.push({
      label: 'Start Recording',
      click: async () => {
        const s = store.read();
        await recorder.start({ mode: 'screen', options: s });
      },
    });
  }
  items.push(
    { type: 'separator' },
    { label: 'Open CaptureDesk', click: () => windows.dashboard() },
    {
      label: 'Open CaptureDesk Recordings',
      click: () => {
        const { shell } = require('electron');
        shell.openPath(library.currentDir());
      },
    },
    { label: 'CaptureDesk Settings', click: () => windows.dashboard() },
    { type: 'separator' },
    { label: 'Quit CaptureDesk', click: () => app.quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

/**
 * Create the tray (idempotent).
 * @returns {Electron.Tray|null}
 */
function create() {
  if (tray) return tray;
  try {
    tray = new Tray(image('tray.png'));
  } catch (err) {
    console.error('[CaptureDesk] tray unavailable:', err.message);
    return null;
  }
  tray.on('click', () => windows.dashboard());
  refresh();
  return tray;
}

/** Destroy the tray on quit. */
function destroy() {
  if (tray) {
    try {
      tray.destroy();
    } catch (_) {
      // Already gone.
    }
    tray = null;
  }
}

module.exports = { create, refresh, destroy };

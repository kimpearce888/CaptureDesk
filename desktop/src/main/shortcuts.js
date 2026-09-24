/**
 * @file CaptureDesk global shortcuts: Ctrl+Alt+R record toggle,
 * Ctrl+Alt+P pause/resume, Ctrl+Alt+E open CaptureDesk Editor. Re-registered
 * whenever the hotkeys setting changes.
 */
const { globalShortcut } = require('electron');
const store = require('./store');
const recorder = require('./recorder');
const windows = require('./windows');
const library = require('./library');

/**
 * (Re)register global shortcuts according to settings.
 */
function register() {
  unregisterAll();
  if (!store.read().hotkeysEnabled) return;
  try {
    globalShortcut.register('CommandOrControl+Alt+R', () => {
      const snap = recorder.snapshot();
      if (snap.state === recorder.STATE.IDLE) {
        recorder.start({ mode: 'screen', options: store.read() });
      } else {
        recorder.stop();
      }
    });
    globalShortcut.register('CommandOrControl+Alt+P', () => {
      const snap = recorder.snapshot();
      if (snap.state === recorder.STATE.RECORDING) recorder.pause();
      else if (snap.state === recorder.STATE.PAUSED) recorder.resume();
    });
    globalShortcut.register('CommandOrControl+Alt+E', () => {
      const items = library.list();
      windows.editor(items.length ? items[0].file : null);
    });
  } catch (err) {
    console.warn('[CaptureDesk] shortcut registration failed:', err.message);
  }
}

/** Unregister every CaptureDesk shortcut. */
function unregisterAll() {
  try {
    globalShortcut.unregisterAll();
  } catch (_) {
    // Nothing registered.
  }
}

module.exports = { register, unregisterAll };

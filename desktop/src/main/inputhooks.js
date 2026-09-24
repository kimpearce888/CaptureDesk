/**
 * @file CaptureDesk input hooks: global cursor position polling (always
 * available via Electron's screen API) plus optional native mouse hooks
 * (uiohook-napi) for click ripples. The native module is a progressive
 * enhancement — when it is unavailable the click-highlight feature degrades
 * gracefully and the recorder hides its toggle.
 */
const { screen } = require('electron');

const CURSOR_POLL_MS = 33; // ~30 Hz cursor updates.

let cursorTimer = null;
let hookApi = null; // { uIOhook } when the native module is available.
let nativeAvailable = false;
let onCursor = null;
let onRipple = null;

/**
 * Start emitting cursor positions (and clicks when the native hooks are
 * available) for the active recording session.
 * @param {Function} cursorCb ({x, y}) in DIP screen coordinates.
 * @param {Function} rippleCb ({x, y}) in DIP screen coordinates.
 * @returns {Promise<boolean>} True when native click hooks are available.
 */
async function start(cursorCb, rippleCb) {
  onCursor = cursorCb;
  onRipple = rippleCb;

  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    try {
      const p = screen.getCursorScreenPoint();
      if (onCursor) onCursor({ x: p.x, y: p.y });
    } catch (_) {
      // Screen API hiccup — skip a tick.
    }
  }, CURSOR_POLL_MS);

  if (!nativeAvailable && !hookApi) {
    try {
      // Dynamic import keeps the app fully functional without the module.
      const mod = await import('uiohook-napi');
      hookApi = mod && mod.uIOhook ? mod : null;
      if (hookApi) {
        hookApi.uIOhook.on('mousedown', (e) => {
          if (onRipple) onRipple({ x: e.x, y: e.y, button: e.button });
        });
        hookApi.uIOhook.start();
        nativeAvailable = true;
      }
    } catch (err) {
      console.warn('[CaptureDesk] native input hooks unavailable:', err.message);
      hookApi = null;
      nativeAvailable = false;
    }
  } else if (hookApi && !nativeAvailable) {
    try {
      hookApi.uIOhook.start();
      nativeAvailable = true;
    } catch (_) {
      nativeAvailable = false;
    }
  }
  return nativeAvailable;
}

/** Stop cursor polling (the native hook keeps its listener but stops emitting). */
function stop() {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
  onCursor = null;
  onRipple = null;
  if (hookApi && nativeAvailable) {
    try {
      hookApi.uIOhook.stop();
    } catch (_) {
      // Ignore hook shutdown errors.
    }
    nativeAvailable = false;
  }
}

/**
 * Whether native click hooks can be used on this machine.
 * @returns {boolean}
 */
function isNativeAvailable() {
  return nativeAvailable;
}

module.exports = { start, stop, isNativeAvailable };

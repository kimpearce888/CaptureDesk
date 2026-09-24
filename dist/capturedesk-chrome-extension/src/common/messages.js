/**
 * @file Shared message-type constants for every CaptureDesk extension context.
 * Keep this file import-free so the service worker, offscreen page, popup and
 * options page can all import it as an ES module.
 */

/**
 * Canonical message contract. Every sender and receiver in the extension uses
 * these constants. Literal strings are only allowed inside the injected
 * content overlay (a classic script that cannot import modules); the overlay
 * literals mirror INPUT, OVERLAY_READY and OVERLAY_STOP below.
 */
export const MSG = {
  // popup -> service worker
  GET_STATE: 'cd:get-state',
  START: 'cd:start', // payload: {mode:'tab'|'window'|'screen', streamId?, options?}
  PAUSE: 'cd:pause',
  RESUME: 'cd:resume',
  STOP: 'cd:stop',
  CANCEL: 'cd:cancel',

  // service worker -> offscreen
  REC_SETUP: 'cd:rec-setup', // payload: {mode, tabId?, streamId?, audioMode?, options, native}
  REC_START: 'cd:rec-start', // payload: {countdown} (offscreen runs the countdown)
  REC_PAUSE: 'cd:rec-pause',
  REC_RESUME: 'cd:rec-resume',
  REC_STOP: 'cd:rec-stop', // finalize & save
  REC_CANCEL: 'cd:rec-cancel', // discard

  // offscreen -> service worker (broadcast to extension pages as well)
  REC_STATE: 'cd:rec-state', // {state:'preparing'|'recording'|'paused'|'stopping'|'idle', elapsedMs, remainingMs?, note?, error?}
  REC_SAVED: 'cd:rec-saved', // {via:'downloads'|'native', fileName, size, blobUrl?}

  // content overlay -> service worker
  OVERLAY_READY: 'cd:overlay-ready',

  // popup/options -> service worker
  OPTIONS_CHANGED: 'cd:options-changed', // payload: {patch}

  // --- internal helpers (not part of the public popup contract) ---

  /** service worker -> offscreen: confirms the save started (blob URL safe to revoke). */
  SAVED_ACK: 'cd:saved-ack',

  /** content overlay -> service worker -> offscreen: cursor/click input. */
  INPUT: 'cd:input',

  /** service worker -> content overlay (via tabs.sendMessage): tear down the overlay. */
  OVERLAY_STOP: 'cd:overlay-stop',

  /** offscreen -> service worker: base64 chunk for the optional native-host path. */
  NATIVE_CHUNK: 'cd:native-chunk',
};

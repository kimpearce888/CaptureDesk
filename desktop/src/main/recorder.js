/**
 * @file CaptureDesk recording session orchestration (main process). Owns the
 * session state machine, drives the hidden recorder window, positions the
 * toolbar, manages the camera bubble, and writes finished recordings to the
 * CaptureDesk Recordings folder.
 */
const path = require('path');
const fs = require('fs');
const { screen, desktopCapturer } = require('electron');
const store = require('./store');
const library = require('./library');
const inputhooks = require('./inputhooks');
const windows = require('./windows');

const STATE = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  COUNTDOWN: 'countdown',
  RECORDING: 'recording',
  PAUSED: 'paused',
  STOPPING: 'stopping',
};

let session = blankSession();
let pendingRegion = null; // {displayId, rect} from the region picker.

/** Pending renderer acks: key → resolver (setup/start). */
const pendingAcks = new Map();

/**
 * Wait for the recorder window to ack a control message.
 * @param {string} key Logical ack key ('setup').
 * @param {number} [timeoutMs] Give-up timeout.
 * @returns {Promise<object|null>} Ack payload or null on timeout.
 */
function waitForAck(key, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingAcks.has(key)) {
        pendingAcks.delete(key);
        resolve(null);
      }
    }, timeoutMs);
    pendingAcks.set(key, (value) => {
      clearTimeout(timer);
      resolve(value || null);
    });
  });
}

/**
 * Resolve a pending ack (wired to the rec:ack IPC handle).
 * @param {string} key Logical ack key.
 * @param {*} value Ack payload.
 */
function resolveAck(key, value) {
  const fn = pendingAcks.get(key);
  if (fn) {
    pendingAcks.delete(key);
    fn(value);
  }
}

/** @returns {object} Fresh idle session snapshot. */
function blankSession() {
  return {
    state: STATE.IDLE,
    mode: null,
    elapsedMs: 0,
    remainingMs: null,
    note: null,
    error: null,
    lastFile: null,
    nativeHooks: false,
    cameraBubble: false,
    startedAt: 0,
  };
}

/** Push the current snapshot to the dashboard + toolbar. */
function sync() {
  windows.broadcast('rec-state', { ...session, snapshotAt: Date.now() });
}

/**
 * Merge a partial snapshot, then sync.
 * @param {object} patch Partial session fields.
 */
function patchSync(patch) {
  session = { ...session, ...patch };
  sync();
}

/**
 * List capture sources for the picker modal (thumbnails as data URLs).
 * @param {{screens:boolean, windows:boolean}} kinds Which kinds to include.
 * @returns {Promise<Array<{id:string,name:string,thumbnail:string,type:string}>>}
 */
async function listSources({ screens = true, windows: wantWindows = true } = {}) {
  const sources = await desktopCapturer.getSources({
    types: [...(screens ? ['screen'] : []), ...(wantWindows ? ['window'] : [])],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
    type: s.id.startsWith('screen:') ? 'screen' : 'window',
  }));
}

/**
 * Start a recording session.
 * @param {{mode:'screen'|'window'|'region', sourceId?:string, options?:object}} req
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function start(req = {}) {
  const mode = req.mode || 'screen';
  if (!['screen', 'window', 'region'].includes(mode)) {
    return { ok: false, error: 'Unknown capture mode.' };
  }
  if (session.state !== STATE.IDLE) {
    return { ok: false, error: 'CaptureDesk is already recording.' };
  }

  const settings = store.read();
  const options = { ...settings, ...(req.options || {}) };

  if (mode === 'window' && !req.sourceId) {
    return { ok: false, error: 'Pick a window to record first.' };
  }
  if (mode === 'region' && !pendingRegion) {
    return { ok: false, error: 'Select an area to record first.' };
  }

  // Resolve the display to capture + its scale factor for DIP mapping.
  let display = null;
  if (mode === 'region') {
    display = screen.getAllDisplays().find((d) => d.id === pendingRegion.displayId)
      || screen.getPrimaryDisplay();
  } else {
    const targets = await listSources({ screens: mode === 'screen', windows: mode === 'window' });
    const match = targets.find((t) => t.id === req.sourceId) || targets[0];
    if (!match) return { ok: false, error: 'No capture source was found.' };
    if (match.type === 'screen') {
      const idx = targets.filter((t) => t.type === 'screen').indexOf(match);
      display = screen.getAllDisplays()[idx] || screen.getPrimaryDisplay();
    }
  }

  patchSync({
    state: STATE.PREPARING,
    mode,
    error: null,
    note: null,
    lastFile: null,
    nativeHooks: inputhooks.isNativeAvailable(),
    cameraBubble: Boolean(options.cameraBubble),
  });

  // Native hooks + cursor relay into the recorder window.
  const recWin = windows.recorderWindow();
  const nativeHooks = await inputhooks.start(
    (p) => recWin.webContents.send('cursor', p),
    (p) => recWin.webContents.send('ripple', p),
  );
  session.nativeHooks = nativeHooks;

  // Camera bubble for the session (the recorder window captures its own PiP).
  if (options.cameraBubble) windows.camBubble();

  const region = mode === 'region'
    ? {
      displayBounds: display.bounds,
      scaleFactor: display.scaleFactor,
      rect: pendingRegion.rect,
    }
    : null;
  clearPendingRegion();

  // Display info for cursor mapping (null for window captures — the source
  // window does not fill its display, so DIP mapping would be misleading).
  const displayInfo = display
    ? { x: display.bounds.x, y: display.bounds.y, scaleFactor: display.scaleFactor }
    : null;

  recWin.webContents.send('rec-setup', {
    mode,
    sourceId: req.sourceId || null,
    region,
    display: displayInfo,
    options: {
      fps: Number(options.fps) || 30,
      quality: options.quality === '720p' ? '720p' : '1080p',
      mic: Boolean(options.mic),
      systemAudio: Boolean(options.systemAudio) && process.platform === 'win32',
      cameraBubble: Boolean(options.cameraBubble),
      cursorHighlight: Boolean(options.cursorHighlight),
      clickHighlight: Boolean(options.clickHighlight) && nativeHooks,
      highlight: options.highlight || { color: '#5EEAD4', size: 26 },
    },
  });
  const setupAck = await waitForAck('setup');

  if (!setupAck || !setupAck.ok) {
    await abort((setupAck && setupAck.error) || 'CaptureDesk could not start recording.',
      (setupAck && setupAck.note) || null);
    return { ok: false, error: session.error };
  }

  // Countdown lives in the toolbar UI; the compositor starts afterwards.
  const countdown = Number(options.countdown) || 0;
  windows.toolbar(display ? display.workArea : screen.getPrimaryDisplay().workArea);
  patchSync({
    state: countdown > 0 ? STATE.COUNTDOWN : STATE.RECORDING,
    remainingMs: countdown > 0 ? countdown * 1000 : null,
  });
  recWin.webContents.send('rec-start', { countdown });
  return { ok: true };
}

/**
 * Abort a failed start: reset to idle and surface the error.
 * @param {string} error Human-readable error.
 * @param {string|null} [note] Optional note (e.g. mic unavailable).
 */
async function abort(error, note = null) {
  inputhooks.stop();
  windows.closeToolbar();
  windows.closeCamBubble();
  windows.closeRecorder();
  session = { ...blankSession(), error, note, lastFile: session.lastFile };
  sync();
}

/**
 * Begin region selection: open a picker overlay on every display.
 * @returns {{ok:boolean}}
 */
function beginRegionSelection() {
  if (session.state !== STATE.IDLE) return { ok: false };
  for (const display of screen.getAllDisplays()) {
    windows.regionWindow(display);
  }
  return { ok: true };
}

/**
 * Region picker result (from any overlay). Stores the pending region and
 * closes the overlays; the dashboard then calls rec:start with mode 'region'.
 * @param {{displayId:number, rect:object|null, canceled?:boolean}} sel
 */
function setPendingRegion(sel) {
  windows.closeRegionWindows();
  if (!sel || sel.canceled || !sel.rect) {
    pendingRegion = null;
    windows.broadcast('region-selected', { canceled: true }, ['dashboard']);
    return;
  }
  pendingRegion = { displayId: sel.displayId, rect: sel.rect };
  windows.broadcast('region-selected', sel, ['dashboard']);
}

/** Clear the pending region (after a start attempt consumed it). */
function clearPendingRegion() {
  pendingRegion = null;
}

/** Pause the active recording. */
async function pause() {
  if (session.state !== STATE.RECORDING) return { ok: false, error: 'Not recording.' };
  const win = windows.get('recorder');
  if (win) win.webContents.send('rec-pause', {});
  return { ok: true };
}

/** Resume a paused recording. */
async function resume() {
  if (session.state !== STATE.PAUSED) return { ok: false, error: 'Not paused.' };
  const win = windows.get('recorder');
  if (win) win.webContents.send('rec-resume', {});
  return { ok: true };
}

/**
 * Stop and save (or discard a not-yet-started recording).
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function stop() {
  if (![STATE.RECORDING, STATE.PAUSED, STATE.COUNTDOWN].includes(session.state)) {
    return { ok: false, error: 'Nothing to stop.' };
  }
  if (session.state === STATE.COUNTDOWN) {
    return cancel();
  }
  const win = windows.get('recorder');
  patchSync({ state: STATE.STOPPING });
  if (win) win.webContents.send('rec-stop', {});
  return { ok: true };
}

/** Cancel the session without saving. */
async function cancel() {
  const win = windows.get('recorder');
  if (win) win.webContents.send('rec-cancel', {});
  inputhooks.stop();
  windows.closeToolbar();
  windows.closeCamBubble();
  windows.closeRecorder();
  clearPendingRegion();
  session = { ...blankSession(), lastFile: session.lastFile };
  sync();
  return { ok: true };
}

/**
 * Recorder window finished capturing: write the file, update the library.
 * @param {{data:ArrayBuffer, durationMs:number}} payload From rec:save IPC.
 * @returns {Promise<{ok:boolean, file?:string, error?:string}>}
 */
async function saveRecording(payload) {
  try {
    const dir = library.currentDir();
    const name = library.recordingName();
    const file = path.join(dir, name);
    const data = Buffer.from(new Uint8Array(payload.data));
    if (!data.length) throw new Error('The recording was empty.');
    fs.writeFileSync(file, data);
    inputhooks.stop();
    windows.closeToolbar();
    windows.closeCamBubble();
    windows.closeRecorder();
    clearPendingRegion();
    session = {
      ...blankSession(),
      lastFile: file,
      elapsedMs: payload.durationMs || 0,
    };
    windows.broadcast('library-changed', { at: Date.now() });
    sync();
    return { ok: true, file };
  } catch (err) {
    await abort(`CaptureDesk could not save the recording: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Update session state from the recorder window (elapsed, remaining, notes).
 * @param {object} payload {state?, elapsedMs?, remainingMs?, note?, error?}
 */
function applyRecorderState(payload) {
  const patch = {};
  if (payload.state && Object.values(STATE).includes(payload.state)) patch.state = payload.state;
  if (Number.isFinite(payload.elapsedMs)) patch.elapsedMs = payload.elapsedMs;
  if (Number.isFinite(payload.remainingMs)) patch.remainingMs = payload.remainingMs;
  if (payload.note !== undefined) patch.note = payload.note;
  if (payload.error !== undefined) patch.error = payload.error;
  patchSync(patch);
}

/**
 * Whether a session is active (any non-idle state).
 * @returns {boolean}
 */
function isActive() {
  return session.state !== STATE.IDLE;
}

/**
 * Current session snapshot.
 * @returns {object}
 */
function snapshot() {
  return { ...session };
}

module.exports = {
  resolveAck,
  start,
  pause,
  resume,
  stop,
  cancel,
  saveRecording,
  applyRecorderState,
  beginRegionSelection,
  setPendingRegion,
  clearPendingRegion,
  listSources,
  isActive,
  snapshot,
  STATE,
};

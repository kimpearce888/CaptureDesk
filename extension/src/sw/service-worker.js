/**
 * @file CaptureDesk background service worker.
 *
 * Owns the recording state machine (idle → preparing → countdown → recording
 * ⇄ paused → stopping → idle), the offscreen document lifecycle, the action
 * badge, content-overlay injection, the downloads save flow and the optional
 * native-host save path. Registered as an ES module in manifest.json.
 */
import { getSettings, setSettings, sanitizeFolder } from '../common/defaults.js';
import { MSG } from '../common/messages.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
const SESSION_KEY = 'cd.sessionState';
const OVERLAY_CONFIG_KEY = 'cd.overlayConfig';
const NATIVE_HOST_NAME = 'com.capturedesk.host';
const NATIVE_GRACE_MS = 250;
const DEFAULT_TITLE = 'CaptureDesk';
const READY_TITLE = 'CaptureDesk is ready';

/** Recording state machine states. */
const STATE = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  COUNTDOWN: 'countdown',
  RECORDING: 'recording',
  PAUSED: 'paused',
  STOPPING: 'stopping',
};

let session = blankSession();
let sessionReady = null;
let offscreenReady = false;
let overlayConfig = null;
let injectedTabIds = new Set();
let nativePort = null;
let nativeRelay = null;

/** @returns {object} A fresh idle session snapshot. */
function blankSession() {
  return {
    state: STATE.IDLE,
    mode: null,
    elapsedMs: 0,
    remainingMs: null,
    note: null,
    error: null,
    lastSaved: null,
    snapshotAt: Date.now(),
  };
}

/**
 * Restore the session snapshot from chrome.storage.session exactly once and
 * expose cd.overlayConfig to content scripts (the cursor/click overlay reads
 * its colors from there).
 * @returns {Promise<void>}
 */
function init() {
  if (!sessionReady) {
    sessionReady = (async () => {
      try {
        const data = await chrome.storage.session.get(SESSION_KEY);
        if (data && data[SESSION_KEY]) session = { ...blankSession(), ...data[SESSION_KEY] };
      } catch (_) {
        // storage.session unavailable — start idle.
      }
      try {
        await chrome.storage.session.setAccessLevel({
          accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
        });
      } catch (_) {
        // Overlay falls back to the OVERLAY_READY response for its config.
      }
    })();
  }
  return sessionReady;
}
init();

/**
 * Persist the session snapshot to chrome.storage.session so the popup can
 * restore its UI after being closed and reopened.
 * @returns {Promise<void>}
 */
async function persistSession() {
  session.snapshotAt = Date.now();
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: session });
  } catch (_) {
    // Non-fatal: the popup falls back to in-memory state.
  }
}

/** Broadcast the current state snapshot to every extension page. */
function broadcastState() {
  const payload = { ...session, snapshotAt: Date.now() };
  chrome.runtime.sendMessage({ type: MSG.REC_STATE, payload }).catch(() => {});
}

/** Persist + broadcast the current snapshot. */
async function syncState() {
  await persistSession();
  broadcastState();
}

/** Badge: red REC while capturing. */
function setBadgeRecording() {
  chrome.action.setBadgeText({ text: 'REC' });
  chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
  chrome.action.setTitle({ title: 'CaptureDesk — recording' });
}

/** Badge: amber pause bars while paused. */
function setBadgePaused() {
  chrome.action.setBadgeText({ text: '❚❚' });
  chrome.action.setBadgeBackgroundColor({ color: '#FBBF24' });
  chrome.action.setTitle({ title: 'CaptureDesk — paused' });
}

/** Clear the badge and (optionally) set a status title. */
function clearBadge(title) {
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setTitle({ title: title || DEFAULT_TITLE });
}

/**
 * Check whether the offscreen document exists, preferring the contexts API.
 * @returns {Promise<boolean>}
 */
async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      });
      return Array.isArray(contexts) && contexts.length > 0;
    } catch (_) {
      // Fall through to the boolean flag.
    }
  }
  return offscreenReady;
}

/**
 * Create the offscreen document if needed (reuse if it already exists).
 * @returns {Promise<boolean>} True when the offscreen page is usable.
 */
async function ensureOffscreen() {
  if (await hasOffscreen()) {
    offscreenReady = true;
    return true;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
      justification: 'CaptureDesk screen recording',
    });
    offscreenReady = true;
    return true;
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (msg.toLowerCase().includes('single offscreen document')) {
      offscreenReady = true; // Already exists — reuse it.
      return true;
    }
    return false;
  }
}

/**
 * Send a message to the offscreen document (resolves to its ack or null).
 * @param {string} type Message type.
 * @param {object} payload Message payload.
 * @param {number} [retries] Extra attempts when no receiver answers yet.
 * @returns {Promise<object|null>} Ack object, or null on failure.
 */
async function sendOffscreen(type, payload, retries = 0) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await chrome.runtime.sendMessage({ type, payload });
      return res === undefined ? null : res;
    } catch (_) {
      if (attempt >= retries) return null;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
}

/**
 * Describe which audio sources the offscreen compositor should acquire.
 * Tab audio always travels with a tab capture; "system" is the desktop
 * audio track from the picker's "share audio" checkbox.
 * @param {string} mode 'tab' | 'window' | 'screen'.
 * @param {object} opts Effective recording options.
 * @returns {string} 'none' | 'mic' | 'system' | 'mic+system'.
 */
function audioModeFor(mode, opts) {
  const desktop = mode === 'window' || mode === 'screen';
  const mic = Boolean(opts.mic);
  if (mic && desktop) return 'mic+system';
  if (mic) return 'mic';
  if (desktop) return 'system';
  return 'none';
}

/**
 * Build the config object consumed by the content overlay and the offscreen
 * compositor for cursor ring / click ripple rendering.
 * @param {object} opts Effective recording options.
 * @returns {object} Overlay config.
 */
function overlayFor(opts) {
  return {
    cursor: Boolean(opts.cursor),
    clicks: Boolean(opts.clicks),
    cursorColor: opts.cursorColor,
    rippleColor: opts.rippleColor,
    cursorSize: opts.cursorSize,
    rippleSize: opts.rippleSize,
  };
}

/**
 * Reset to idle after a failed start, surfacing the error to the popup.
 * @param {string} error Human-readable error message.
 * @param {string|null} [note] Optional status note (e.g. 'mic-unavailable').
 * @returns {{ok: boolean, error: string}}
 */
async function failStart(error, note = null) {
  session = { ...blankSession(), error, note, lastSaved: session.lastSaved };
  await clearOverlay();
  clearBadge();
  await syncState();
  return { ok: false, error };
}

/**
 * Handle START from the popup: resolve the capture source, ensure the
 * offscreen document, run REC_SETUP + REC_START and inject the overlay.
 * @param {object} payload {mode, streamId?, options?}.
 * @returns {Promise<object>} {ok, error?}
 */
async function handleStart(payload = {}) {
  const mode = payload.mode;
  if (!['tab', 'window', 'screen'].includes(mode)) {
    return { ok: false, error: 'Unknown capture mode.' };
  }
  if (session.state !== STATE.IDLE) {
    return { ok: false, error: 'CaptureDesk is already recording.' };
  }

  const settings = await getSettings();
  const opts = { ...settings, ...(payload.options || {}) };

  session = { ...blankSession(), state: STATE.PREPARING, mode, lastSaved: session.lastSaved };
  setBadgeRecording();
  await syncState();

  // Resolve the media source.
  let tabId = null;
  let streamId = payload.streamId || null;
  if (mode === 'tab') {
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (_) {
      tab = null;
    }
    if (!tab || typeof tab.id !== 'number') {
      return failStart('CaptureDesk could not find an active tab to record.');
    }
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ tabId: tab.id });
    } catch (_) {
      return failStart('CaptureDesk could not access this tab. Try reloading the page, then start again.');
    }
    tabId = tab.id;
  }
  if (!streamId) {
    return failStart('No capture source was selected. Please start again and pick a source.');
  }

  if (!(await ensureOffscreen())) {
    return failStart('CaptureDesk could not start its recorder page.');
  }

  const native = await tryOpenNativePort();
  const setup = {
    mode,
    tabId,
    streamId,
    audioMode: audioModeFor(mode, opts),
    options: { ...opts, overlay: overlayFor(opts) },
    native,
  };
  const ack = await sendOffscreen(MSG.REC_SETUP, setup, 1);
  if (!ack || !ack.ok) {
    return failStart(
      (ack && ack.error) || 'CaptureDesk could not start recording.',
      (ack && ack.note) || null,
    );
  }
  session.note = ack.note || null;
  await syncState();

  await injectOverlay(tabId, opts, mode);

  const startAck = await sendOffscreen(MSG.REC_START, { countdown: Number(opts.countdown) || 0 });
  if (!startAck || !startAck.ok) {
    return failStart('CaptureDesk could not start recording.');
  }

  session.state = Number(opts.countdown) > 0 ? STATE.COUNTDOWN : STATE.RECORDING;
  session.remainingMs = Number(opts.countdown) > 0 ? Number(opts.countdown) * 1000 : null;
  await syncState();
  return { ok: true };
}

/**
 * Inject the content overlay into a tab (best effort) and remember the tab id
 * so the overlay can be torn down when the recording ends.
 * @param {number|null} tabId Recorded tab (tab mode) or null.
 * @param {object} opts Effective recording options.
 * @param {string} mode Capture mode.
 * @returns {Promise<void>}
 */
async function injectOverlay(tabId, opts, mode) {
  if (!opts.cursor && !opts.clicks) return;
  let target = tabId;
  if (typeof target !== 'number') {
    // Window/screen modes: inject into the active tab as a best effort —
    // ripples then appear only over browser content (documented behavior).
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      target = tab && tab.id;
    } catch (_) {
      target = undefined;
    }
  }
  if (typeof target !== 'number') return;
  overlayConfig = overlayFor(opts);
  try {
    await chrome.storage.session.set({ [OVERLAY_CONFIG_KEY]: overlayConfig });
  } catch (_) {
    // The overlay still gets its config via the OVERLAY_READY response.
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: target },
      files: ['src/content/overlay.js'],
    });
    injectedTabIds.add(target);
  } catch (_) {
    // Restricted pages (chrome://, Web Store, ...) — the recording is unaffected.
  }
}

/**
 * Ask every injected overlay to remove itself and forget the tab ids.
 * @returns {Promise<void>}
 */
async function clearOverlay() {
  const ids = [...injectedTabIds];
  injectedTabIds.clear();
  await Promise.all(ids.map(async (tabId) => {
    try {
      await chrome.tabs.sendMessage(tabId, { type: MSG.OVERLAY_STOP });
    } catch (_) {
      // Tab may be gone or has no overlay — nothing to do.
    }
  }));
}

/**
 * Handle PAUSE from the popup.
 * @returns {Promise<object>} {ok, error?}
 */
async function handlePause() {
  if (session.state !== STATE.RECORDING) return { ok: false, error: 'Not recording.' };
  const ack = await sendOffscreen(MSG.REC_PAUSE, {});
  if (!ack || !ack.ok) {
    return { ok: false, error: (ack && ack.error) || 'The recorder is not responding.' };
  }
  session.state = STATE.PAUSED;
  setBadgePaused();
  await syncState();
  return { ok: true };
}

/**
 * Handle RESUME from the popup.
 * @returns {Promise<object>} {ok, error?}
 */
async function handleResume() {
  if (session.state !== STATE.PAUSED) return { ok: false, error: 'Not paused.' };
  const ack = await sendOffscreen(MSG.REC_RESUME, {});
  if (!ack || !ack.ok) {
    return { ok: false, error: (ack && ack.error) || 'The recorder is not responding.' };
  }
  session.state = STATE.RECORDING;
  setBadgeRecording();
  await syncState();
  return { ok: true };
}

/**
 * Handle STOP from the popup: finalize & save (or discard a pending countdown).
 * @returns {Promise<object>} {ok, error?}
 */
async function handleStop() {
  if (![STATE.RECORDING, STATE.PAUSED, STATE.COUNTDOWN].includes(session.state)) {
    return { ok: false, error: 'Nothing to stop.' };
  }
  const ack = await sendOffscreen(MSG.REC_STOP, {});
  if (!ack || !ack.ok) {
    return { ok: false, error: (ack && ack.error) || 'The recorder is not responding.' };
  }
  if (session.state === STATE.COUNTDOWN) {
    // Nothing was recorded yet — treat like a cancel.
    await clearOverlay();
    clearBadge();
    session.state = STATE.IDLE;
    await syncState();
    return { ok: true };
  }
  session.state = STATE.STOPPING;
  session.remainingMs = null;
  clearBadge('CaptureDesk — saving…');
  await syncState();
  return { ok: true };
}

/**
 * Handle CANCEL from the popup: discard everything and reset to idle.
 * @returns {Promise<object>} {ok}
 */
async function handleCancel() {
  await sendOffscreen(MSG.REC_CANCEL, {});
  await clearOverlay();
  clearBadge();
  session = { ...blankSession(), lastSaved: session.lastSaved };
  await syncState();
  return { ok: true };
}

/**
 * Apply a REC_STATE broadcast coming from the offscreen recorder.
 * @param {object} payload {state, elapsedMs, remainingMs?, note?, error?}.
 * @returns {Promise<void>}
 */
async function applyRecorderState(payload = {}) {
  const st = payload.state;
  if (!st) return;
  session.state = st;
  session.elapsedMs = Number(payload.elapsedMs) || 0;
  session.remainingMs = typeof payload.remainingMs === 'number' ? payload.remainingMs : null;
  if (payload.note !== undefined) session.note = payload.note;
  if (payload.error !== undefined) session.error = payload.error;
  if (st === STATE.RECORDING) setBadgeRecording();
  else if (st === STATE.PAUSED) setBadgePaused();
  else if (st === STATE.STOPPING) clearBadge('CaptureDesk — saving…');
  else if (st === STATE.IDLE) {
    await clearOverlay();
    clearBadge(session.lastSaved && !session.error ? READY_TITLE : DEFAULT_TITLE);
  }
  await syncState();
}

/**
 * Handle REC_SAVED from the offscreen recorder: run the downloads save with
 * the provided blob URL, then ack so the offscreen page can revoke the URL.
 * The offscreen page stays alive until it receives SAVED_ACK.
 * @param {object} payload {via, fileName, size, blobUrl?}.
 * @returns {Promise<void>}
 */
async function handleSaved(payload = {}) {
  if (payload.via === 'native') {
    if (nativePort) {
      nativeRelay = { fileName: payload.fileName, size: payload.size || 0, began: false };
      await sendOffscreen(MSG.SAVED_ACK, { ok: true, relay: true });
    } else {
      // Native host vanished mid-recording — tell offscreen to use the blob path.
      await sendOffscreen(MSG.SAVED_ACK, { ok: false, fallback: true });
    }
    return;
  }

  const settings = await getSettings();
  const folder = sanitizeFolder(settings.folder);
  const filename = `${folder}/${payload.fileName}`;
  let ack;
  try {
    const downloadId = await chrome.downloads.download({
      url: payload.blobUrl,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    ack = { ok: true, downloadId };
    session.lastSaved = {
      fileName: payload.fileName,
      size: payload.size || 0,
      via: 'downloads',
      at: Date.now(),
    };
    session.error = null;
  } catch (err) {
    ack = { ok: false, error: String((err && err.message) || err) };
    session.error = 'CaptureDesk could not save the recording.';
  }
  await sendOffscreen(MSG.SAVED_ACK, ack);
  if (ack.ok) clearBadge(READY_TITLE);
  await syncState();
}

/**
 * Relay a base64 chunk from the offscreen page to the native host. Sends the
 * begin/end framing around the chunk stream and reports completion.
 * @param {object} payload {fileName, seq, data, last}.
 * @returns {Promise<object>} {ok, done?, fileName?}
 */
async function handleNativeChunk(payload = {}) {
  if (!nativePort || !nativeRelay) return { ok: false };
  try {
    if (!nativeRelay.began) {
      nativePort.postMessage({
        type: 'begin',
        fileName: nativeRelay.fileName,
        size: nativeRelay.size,
      });
      nativeRelay.began = true;
    }
    nativePort.postMessage({ type: 'chunk', data: payload.data });
    if (payload.last) {
      nativePort.postMessage({ type: 'end' });
      session.lastSaved = {
        fileName: nativeRelay.fileName,
        size: nativeRelay.size,
        via: 'native',
        at: Date.now(),
      };
      nativeRelay = null;
      session.error = null;
      clearBadge(READY_TITLE);
      await syncState();
      return { ok: true, done: true };
    }
    return { ok: true };
  } catch (_) {
    nativeRelay = null;
    try {
      nativePort.disconnect();
    } catch (_) {
      // Already disconnected.
    }
    nativePort = null;
    return { ok: false };
  }
}

/**
 * Best-effort connection to the CaptureDesk native host. Never throws; a port
 * that dies within the grace window (host not registered) is treated as absent.
 * @returns {Promise<boolean>} True when the native host is usable.
 */
async function tryOpenNativePort() {
  if (nativePort) return true;
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (_) {
    return false; // nativeMessaging unavailable or host not installed.
  }
  let open = true;
  port.onDisconnect.addListener(() => {
    if (nativePort === port) nativePort = null;
    open = false;
  });
  port.onMessage.addListener(() => {
    // Host acks are informational; the chunk relay is the source of truth.
  });
  nativePort = port;
  await new Promise((resolve) => setTimeout(resolve, NATIVE_GRACE_MS));
  if (!open) {
    nativePort = null;
    return false;
  }
  return true;
}

/**
 * Forward overlay input (cursor moves / clicks) to the offscreen compositor.
 * @param {object} payload {type:'cursor'|'down', x, y, vw, vh, dpr}.
 * @returns {object} {ok}
 */
function handleInput(payload = {}) {
  sendOffscreen(MSG.INPUT, payload);
  return { ok: true };
}

/**
 * Central message dispatcher. Returns a value for every message type that
 * expects a response; returns undefined for fire-and-forget types.
 * @param {object} msg {type, payload}.
 * @returns {Promise<object|undefined>}
 */
async function dispatch(msg) {
  const p = msg.payload || {};
  switch (msg.type) {
    case MSG.GET_STATE:
      return {
        ok: true,
        state: { ...session, snapshotAt: Date.now() },
        version: chrome.runtime.getManifest().version,
      };
    case MSG.START:
      return handleStart(p);
    case MSG.PAUSE:
      return handlePause();
    case MSG.RESUME:
      return handleResume();
    case MSG.STOP:
      return handleStop();
    case MSG.CANCEL:
      return handleCancel();
    case MSG.OPTIONS_CHANGED: {
      const settings = await setSettings(p.patch || p);
      return { ok: true, settings };
    }
    case MSG.PROBE_NATIVE: {
      // Popup diagnostics: is the CaptureDesk native host usable? Never
      // throws; a dead/absent host simply means recordings save to Downloads.
      const native = await tryOpenNativePort();
      return { ok: true, native };
    }
    case MSG.OVERLAY_READY:
      return { ok: true, config: overlayConfig || null };
    case MSG.INPUT:
      return handleInput(p);
    case MSG.NATIVE_CHUNK:
      return handleNativeChunk(p);
    default:
      return undefined;
  }
}

// Message types answered by this worker; everything else is fire-and-forget.
const ASYNC_TYPES = new Set([
  MSG.GET_STATE,
  MSG.START,
  MSG.PAUSE,
  MSG.RESUME,
  MSG.STOP,
  MSG.CANCEL,
  MSG.OPTIONS_CHANGED,
  MSG.PROBE_NATIVE,
  MSG.OVERLAY_READY,
  MSG.INPUT,
  MSG.NATIVE_CHUNK,
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (!ASYNC_TYPES.has(msg.type)) {
    if (msg.type === MSG.REC_STATE) {
      init().then(() => applyRecorderState(msg.payload));
    } else if (msg.type === MSG.REC_SAVED) {
      init().then(() => handleSaved(msg.payload));
    }
    return false;
  }
  init()
    .then(() => dispatch(msg))
    .then((result) => {
      if (result !== undefined) sendResponse(result);
    })
    .catch((err) => {
      try {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      } catch (_) {
        // Popup closed before the response — nothing to do.
      }
    });
  return true;
});

chrome.runtime.onStartup.addListener(() => {
  // Browser restart mid-recording: start clean and idle.
  session = blankSession();
  injectedTabIds.clear();
  persistSession();
  clearBadge();
});

chrome.runtime.onInstalled.addListener(() => {
  persistSession();
  clearBadge();
});

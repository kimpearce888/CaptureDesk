/**
 * @file CaptureDesk popup: mode picker, toggles, live timer and transport
 * controls. All state is restored from the service worker's session snapshot.
 */
import { getSettings, sanitizeFolder } from '../common/defaults.js';
import { MSG } from '../common/messages.js';

const els = {
  versionChip: document.getElementById('versionChip'),
  openOptions: document.getElementById('openOptions'),
  statusLine: document.getElementById('statusLine'),
  setupView: document.getElementById('setupView'),
  modeSeg: document.getElementById('modeSeg'),
  optMic: document.getElementById('optMic'),
  optCam: document.getElementById('optCam'),
  optCursor: document.getElementById('optCursor'),
  optClicks: document.getElementById('optClicks'),
  optQuality: document.getElementById('optQuality'),
  optCountdown: document.getElementById('optCountdown'),
  startBtn: document.getElementById('startBtn'),
  recView: document.getElementById('recView'),
  recDot: document.getElementById('recDot'),
  timer: document.getElementById('timer'),
  pausedPill: document.getElementById('pausedPill'),
  countPill: document.getElementById('countPill'),
  pauseBtn: document.getElementById('pauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  cancelBtn: document.getElementById('cancelBtn'),
  savedCard: document.getElementById('savedCard'),
  savedName: document.getElementById('savedName'),
  footerFolder: document.getElementById('footerFolder'),
};

let current = { state: 'idle' }; // Last known session snapshot.
let uiMode = 'tab'; // Selected capture mode.
let ticker = 0; // Timer refresh interval id.
let cancelTimer = 0; // Cancel confirm-swap revert timeout id.

/**
 * Format milliseconds as m:ss or h:mm:ss.
 * @param {number} ms Elapsed milliseconds.
 * @returns {string} Formatted timer text.
 */
function fmt(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Elapsed time to display: interpolate between recorder heartbeats while
 * recording, otherwise show the frozen value.
 * @returns {number} Elapsed milliseconds.
 */
function displayMs() {
  const s = current;
  if (s.state === 'recording') {
    const drift = Math.max(0, Date.now() - (s.snapshotAt || Date.now()));
    return (s.elapsedMs || 0) + drift;
  }
  return s.elapsedMs || 0;
}

/** Start the 250 ms display ticker while the recording view is visible. */
function startTicker() {
  if (ticker) return;
  ticker = setInterval(updateTimer, 250);
}

/** Stop the display ticker. */
function stopTicker() {
  if (ticker) {
    clearInterval(ticker);
    ticker = 0;
  }
}

/** Refresh the timer text and the countdown pill from the current snapshot. */
function updateTimer() {
  const s = current;
  if (s.state === 'countdown') {
    const drift = Math.max(0, Date.now() - (s.snapshotAt || Date.now()));
    const rem = Math.max(0, (s.remainingMs || 0) - drift);
    els.countPill.textContent = `Starting in ${Math.ceil(rem / 1000)}s`;
    els.timer.textContent = fmt(0);
    return;
  }
  els.timer.textContent = fmt(displayMs());
}

/** Reset the Cancel button to its unarmed state. */
function disarmCancel() {
  clearTimeout(cancelTimer);
  cancelTimer = 0;
  delete els.cancelBtn.dataset.armed;
  els.cancelBtn.classList.remove('is-armed');
  els.cancelBtn.textContent = 'Cancel';
}

/**
 * Render the popup for the current session snapshot.
 * @returns {void}
 */
function render() {
  const s = current;
  const st = s.state || 'idle';
  const idle = st === 'idle';

  els.setupView.hidden = !idle;
  els.recView.hidden = idle;
  els.savedCard.hidden = !(idle && s.lastSaved);
  if (!idle && cancelTimer) disarmCancel();
  if (idle) stopTicker();
  else startTicker();

  const note = s.note;
  const err = s.error;
  const showStatus = Boolean(err || note || ['recording', 'preparing', 'stopping'].includes(st));
  els.statusLine.hidden = !showStatus;
  els.statusLine.classList.toggle('is-error', Boolean(err));
  els.statusLine.classList.toggle('is-warning', !err && note === 'mic-unavailable');
  if (err) {
    els.statusLine.textContent = err;
  } else if (note === 'mic-unavailable') {
    els.statusLine.textContent = 'Microphone unavailable — recording without audio.';
  } else if (note === 'cam-unavailable') {
    els.statusLine.textContent = 'Camera unavailable — recording without the camera bubble.';
  } else if (st === 'preparing') {
    els.statusLine.textContent = 'Preparing…';
  } else if (st === 'stopping') {
    els.statusLine.textContent = 'Saving…';
  } else if (st === 'recording') {
    els.statusLine.textContent = 'Recording…';
  } else {
    els.statusLine.textContent = '';
  }

  if (idle) {
    if (s.lastSaved) els.savedName.textContent = s.lastSaved.fileName || '';
    els.startBtn.disabled = false;
    els.startBtn.textContent = 'Start Recording';
    return;
  }

  const recording = st === 'recording';
  const paused = st === 'paused';
  const countdown = st === 'countdown';
  const busy = st === 'preparing' || st === 'stopping';

  els.pauseBtn.hidden = !(recording || paused);
  els.pauseBtn.disabled = busy;
  els.pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  els.stopBtn.disabled = busy;
  els.cancelBtn.hidden = !(recording || paused || countdown);
  els.cancelBtn.disabled = busy;
  els.pausedPill.hidden = !paused;
  els.countPill.hidden = !countdown;
  els.recDot.style.visibility = countdown || recording ? 'visible' : 'hidden';
  updateTimer();
}

/**
 * Fetch the latest session snapshot from the service worker and re-render.
 * @returns {Promise<void>}
 */
async function refresh() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.GET_STATE });
    if (res && res.ok && res.state) {
      current = res.state;
      if (res.version) els.versionChip.textContent = `v${res.version}`;
    }
  } catch (_) {
    current = { state: 'idle' };
  }
  render();
}

/**
 * Persist a settings patch via the service worker (OPTIONS_CHANGED).
 * @param {object} patch Settings fragment to persist.
 * @returns {void}
 */
function sendOptions(patch) {
  chrome.runtime
    .sendMessage({ type: MSG.OPTIONS_CHANGED, payload: { patch } })
    .catch(() => {});
}

/**
 * Collect the current popup options for the START payload.
 * @returns {object} Options consumed by the service worker.
 */
function collectOptions() {
  return {
    mic: els.optMic.checked,
    cam: els.optCam.checked,
    cursor: els.optCursor.checked,
    clicks: els.optClicks.checked,
    quality: els.optQuality.value,
    countdown: Number(els.optCountdown.value) || 0,
  };
}

/**
 * Open Chrome's native desktop picker and resolve the chosen stream id.
 * @param {string} mode 'window' | 'screen'.
 * @returns {Promise<string|undefined>} streamId, or undefined when cancelled.
 */
async function pickDesktopSource(mode) {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) {
    tab = undefined;
  }
  return new Promise((resolve) => {
    try {
      chrome.desktopCapture.chooseDesktopMedia([mode], tab, (streamId) => resolve(streamId));
    } catch (_) {
      resolve(undefined);
    }
  });
}

/**
 * Start Recording click handler: for Window/Screen modes the picker runs here
 * (it needs a visible page); on cancel, nothing happens.
 * @returns {Promise<void>}
 */
async function onStart() {
  if (current.state !== 'idle') return;
  els.startBtn.disabled = true;
  els.startBtn.textContent = 'Preparing…';

  const payload = { mode: uiMode, options: collectOptions() };
  if (uiMode !== 'tab') {
    const streamId = await pickDesktopSource(uiMode);
    if (!streamId) {
      // User cancelled Chrome's picker — restore the idle UI untouched.
      render();
      return;
    }
    payload.streamId = streamId;
  }

  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.START, payload });
    if (!res || !res.ok) {
      current.error = (res && res.error) || 'CaptureDesk could not start recording.';
      render();
      return;
    }
  } catch (_) {
    current.error = 'CaptureDesk could not start recording.';
    render();
    return;
  }
  await refresh();
}

/**
 * Pause / Resume click handler (the label mirrors the current state).
 * @returns {Promise<void>}
 */
async function onPause() {
  const type = current.state === 'paused' ? MSG.RESUME : MSG.PAUSE;
  try {
    await chrome.runtime.sendMessage({ type, payload: {} });
  } catch (_) {
    // Broadcasts reconcile the UI even if this message failed.
  }
  await refresh();
}

/**
 * Stop & save click handler.
 * @returns {Promise<void>}
 */
async function onStop() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.STOP, payload: {} });
    if (res && !res.ok && res.error) current.error = res.error;
  } catch (_) {
    // Broadcasts reconcile the UI even if this message failed.
  }
  await refresh();
}

/**
 * Cancel click handler with confirm-swap: the first click arms the button
 * ("Really discard?"), the second click discards the recording.
 * @returns {Promise<void>}
 */
async function onCancel() {
  if (!els.cancelBtn.dataset.armed) {
    els.cancelBtn.dataset.armed = '1';
    els.cancelBtn.classList.add('is-armed');
    els.cancelBtn.textContent = 'Really discard?';
    clearTimeout(cancelTimer);
    cancelTimer = setTimeout(disarmCancel, 3500);
    return;
  }
  disarmCancel();
  try {
    await chrome.runtime.sendMessage({ type: MSG.CANCEL, payload: {} });
  } catch (_) {
    // Broadcasts reconcile the UI even if this message failed.
  }
  await refresh();
}

/**
 * Apply stored settings to the popup controls.
 * @param {object} settings Sanitized settings from storage.sync.
 * @returns {void}
 */
function applySettingsToControls(settings) {
  els.optMic.checked = settings.mic;
  els.optCam.checked = settings.cam;
  els.optCursor.checked = settings.cursor;
  els.optClicks.checked = settings.clicks;
  els.optQuality.value = settings.quality;
  els.optCountdown.value = String(settings.countdown);
  els.footerFolder.textContent = `Saved to Downloads/${sanitizeFolder(settings.folder)}`;
}

/** Wire every control to its handler. */
function wireEvents() {
  els.modeSeg.addEventListener('click', (event) => {
    const btn = event.target.closest('.seg-btn');
    if (!btn) return;
    uiMode = btn.dataset.mode;
    for (const el of els.modeSeg.querySelectorAll('.seg-btn')) {
      el.classList.toggle('is-active', el === btn);
    }
  });
  els.optMic.addEventListener('change', () => sendOptions({ mic: els.optMic.checked }));
  els.optCam.addEventListener('change', () => sendOptions({ cam: els.optCam.checked }));
  els.optCursor.addEventListener('change', () => sendOptions({ cursor: els.optCursor.checked }));
  els.optClicks.addEventListener('change', () => sendOptions({ clicks: els.optClicks.checked }));
  els.optQuality.addEventListener('change', () => sendOptions({ quality: els.optQuality.value }));
  els.optCountdown.addEventListener('change', () => {
    sendOptions({ countdown: Number(els.optCountdown.value) || 0 });
  });
  els.startBtn.addEventListener('click', () => void onStart());
  els.pauseBtn.addEventListener('click', () => void onPause());
  els.stopBtn.addEventListener('click', () => void onStop());
  els.cancelBtn.addEventListener('click', () => void onCancel());
  els.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === MSG.REC_STATE && msg.payload) {
    current = { ...current, ...msg.payload };
    render();
  } else if (msg.type === MSG.REC_SAVED) {
    void refresh();
  }
  return;
});

/**
 * Popup entry point: wire controls, apply settings, restore session state.
 * @returns {Promise<void>}
 */
async function init() {
  els.versionChip.textContent = `v${chrome.runtime.getManifest().version || '1.0.0'}`;
  wireEvents();
  try {
    applySettingsToControls(await getSettings());
  } catch (_) {
    applySettingsToControls({});
  }
  await refresh();
}

void init();

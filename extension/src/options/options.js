/**
 * @file CaptureDesk Settings page: edits the settings stored in
 * chrome.storage.sync (via the service worker) with a live file-name preview.
 */
import { buildFileName, getSettings, sanitizeFolder } from '../common/defaults.js';
import { MSG } from '../common/messages.js';

const els = {
  optQuality: document.getElementById('optQuality'),
  optFps: document.getElementById('optFps'),
  optCountdown: document.getElementById('optCountdown'),
  optCursorColor: document.getElementById('optCursorColor'),
  optCursorSize: document.getElementById('optCursorSize'),
  optRippleColor: document.getElementById('optRippleColor'),
  optRippleSize: document.getElementById('optRippleSize'),
  optFolder: document.getElementById('optFolder'),
  optTemplate: document.getElementById('optTemplate'),
  namePreview: document.getElementById('namePreview'),
  aboutVersion: document.getElementById('aboutVersion'),
  saveBtn: document.getElementById('saveBtn'),
  toast: document.getElementById('toast'),
};

let toastTimer = 0;

/**
 * Read the current form values as a settings patch.
 * @returns {object} Settings patch collected from the form.
 */
function collect() {
  return {
    quality: els.optQuality.value,
    fps: Number(els.optFps.value) || 30,
    countdown: Number(els.optCountdown.value) || 0,
    cursorColor: els.optCursorColor.value,
    cursorSize: Number(els.optCursorSize.value) || 26,
    rippleColor: els.optRippleColor.value,
    rippleSize: Number(els.optRippleSize.value) || 36,
    folder: els.optFolder.value,
    filenameTemplate: els.optTemplate.value,
  };
}

/** Refresh the live file-name preview from the current form values. */
function updatePreview() {
  const folder = sanitizeFolder(els.optFolder.value);
  const name = buildFileName(els.optTemplate.value, new Date(), '.webm');
  els.namePreview.textContent = `Downloads/${folder}/${name}`;
}

/**
 * Show the "Saved" toast for a moment.
 * @returns {void}
 */
function showToast() {
  els.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 1800);
}

/**
 * Apply a settings object to the form controls.
 * @param {object} settings Sanitized settings from storage.sync.
 * @returns {void}
 */
function applySettingsToControls(settings) {
  els.optQuality.value = settings.quality;
  els.optFps.value = String(settings.fps);
  els.optCountdown.value = String(settings.countdown);
  els.optCursorColor.value = settings.cursorColor;
  els.optCursorSize.value = String(settings.cursorSize);
  els.optRippleColor.value = settings.rippleColor;
  els.optRippleSize.value = String(settings.rippleSize);
  els.optFolder.value = settings.folder;
  els.optTemplate.value = settings.filenameTemplate;
  updatePreview();
}

/**
 * Save click handler: persist the settings through the service worker
 * (OPTIONS_CHANGED → chrome.storage.sync) and show the Saved toast.
 * @returns {Promise<void>}
 */
async function onSave() {
  els.saveBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.OPTIONS_CHANGED,
      payload: { patch: collect() },
    });
    if (!res || !res.ok) throw new Error('save rejected');
    showToast();
  } catch (_) {
    showToast();
  } finally {
    els.saveBtn.disabled = false;
  }
}

/** Wire every control to its handler. */
function wireEvents() {
  els.saveBtn.addEventListener('click', () => void onSave());
  els.optFolder.addEventListener('input', updatePreview);
  els.optTemplate.addEventListener('input', updatePreview);
}

/**
 * Options page entry point: wire controls, load settings, fill the About
 * section with the manifest version.
 * @returns {Promise<void>}
 */
async function init() {
  wireEvents();
  els.aboutVersion.textContent = chrome.runtime.getManifest().version || '1.0.0';
  try {
    applySettingsToControls(await getSettings());
  } catch (_) {
    updatePreview();
  }
}

void init();

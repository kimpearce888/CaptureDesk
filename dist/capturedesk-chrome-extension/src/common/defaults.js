/**
 * @file CaptureDesk settings defaults + helpers shared by every context.
 * Settings live in chrome.storage.sync under SETTINGS_KEY. Stored values are
 * always merged over these defaults and sanitized before use.
 */

/** storage.sync key that holds the settings object. */
export const SETTINGS_KEY = 'cd.settings';

/** Canvas output size per quality preset (the source is cover-fitted into it). */
export const FRAME_SIZES = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

/** Video bitrate per quality preset, in bits per second. */
export const VIDEO_BITRATES = {
  '720p': 5000000,
  '1080p': 8000000,
};

/** RGB triplets for highlight colors, shared by the overlay and the compositor. */
export const OVERLAY_COLORS = {
  teal: { rgb: '94, 234, 212' },
  amber: { rgb: '251, 191, 36' },
  white: { rgb: '255, 255, 255' },
};

/** Factory defaults for every user-facing setting. */
export const DEFAULT_SETTINGS = {
  quality: '720p', // '720p' | '1080p'
  fps: 30, // 24 | 30 | 60
  countdown: 0, // 0 | 3 | 5 (seconds)
  mic: true, // microphone on by default
  cam: false, // camera bubble
  cursor: true, // cursor ring
  clicks: true, // click ripples
  cursorColor: 'teal', // 'teal' | 'amber' | 'white'
  rippleColor: 'teal', // 'teal' | 'amber' | 'white'
  cursorSize: 26, // ring diameter in px
  rippleSize: 36, // max ripple diameter in px
  folder: 'CaptureDesk', // Downloads subfolder
  filenameTemplate: 'CaptureDesk_{date}_{time}', // {date} {time} {timestamp} tokens
};

const FPS_CHOICES = [24, 30, 60];
const COUNTDOWN_CHOICES = [0, 3, 5];
const COLOR_NAMES = Object.keys(OVERLAY_COLORS);

/**
 * Merge a stored settings fragment over the defaults and sanitize the result.
 * @param {*} stored Raw value read from chrome.storage.sync (may be undefined).
 * @returns {object} A complete, sanitized settings object.
 */
export function mergeSettings(stored) {
  const merged = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (stored[key] !== undefined && stored[key] !== null) merged[key] = stored[key];
    }
  }
  return sanitizeSettings(merged);
}

/**
 * Read the effective settings from chrome.storage.sync.
 * @returns {Promise<object>} Complete sanitized settings.
 */
export async function getSettings() {
  if (!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync)) {
    return { ...DEFAULT_SETTINGS };
  }
  const data = await chrome.storage.sync.get(SETTINGS_KEY);
  return mergeSettings(data ? data[SETTINGS_KEY] : undefined);
}

/**
 * Persist a settings patch to chrome.storage.sync.
 * @param {object} patch Partial settings to write.
 * @returns {Promise<object>} The full sanitized settings after the write.
 */
export async function setSettings(patch) {
  const current = await getSettings();
  const next = sanitizeSettings({ ...current, ...(patch || {}) });
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * Coerce every known setting into a valid value.
 * @param {object} input Candidate settings object.
 * @returns {object} Sanitized shallow copy.
 */
export function sanitizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  if (!Object.keys(FRAME_SIZES).includes(s.quality)) s.quality = DEFAULT_SETTINGS.quality;
  s.fps = Number(s.fps);
  if (!FPS_CHOICES.includes(s.fps)) s.fps = DEFAULT_SETTINGS.fps;
  s.countdown = Number(s.countdown);
  if (!COUNTDOWN_CHOICES.includes(s.countdown)) s.countdown = DEFAULT_SETTINGS.countdown;
  s.mic = Boolean(s.mic);
  s.cam = Boolean(s.cam);
  s.cursor = Boolean(s.cursor);
  s.clicks = Boolean(s.clicks);
  if (!COLOR_NAMES.includes(s.cursorColor)) s.cursorColor = DEFAULT_SETTINGS.cursorColor;
  if (!COLOR_NAMES.includes(s.rippleColor)) s.rippleColor = DEFAULT_SETTINGS.rippleColor;
  s.cursorSize = clampInt(s.cursorSize, 16, 48, DEFAULT_SETTINGS.cursorSize);
  s.rippleSize = clampInt(s.rippleSize, 24, 80, DEFAULT_SETTINGS.rippleSize);
  s.folder = sanitizeFolder(s.folder);
  if (typeof s.filenameTemplate !== 'string' || !s.filenameTemplate.trim()) {
    s.filenameTemplate = DEFAULT_SETTINGS.filenameTemplate;
  }
  return s;
}

/**
 * Clamp a numeric option to an integer range with a fallback.
 * @param {*} value Candidate value.
 * @param {number} min Inclusive minimum.
 * @param {number} max Inclusive maximum.
 * @param {number} fallback Used when the value is not a finite number.
 * @returns {number} Clamped integer.
 */
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Normalize a downloads subfolder name into a single safe path segment.
 * @param {*} folder Candidate folder name.
 * @returns {string} Safe folder name (never empty).
 */
export function sanitizeFolder(folder) {
  const cleaned = typeof folder === 'string'
    ? folder
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/^[\s.]+/, '')
      .trim()
    : '';
  return cleaned || DEFAULT_SETTINGS.folder;
}

/**
 * Build a recording file name from the configured template.
 * Tokens: {date} → YYYY-MM-DD, {time} → HH-mm-ss, {timestamp} → unix seconds.
 * @param {string} template Filename template from settings.
 * @param {Date} [now] Moment to render; defaults to the current local time.
 * @param {string} [ext] Extension including the dot, or '' to omit.
 * @returns {string} e.g. 'CaptureDesk_2026-09-24_15-30-22.webm'.
 */
export function buildFileName(template, now = new Date(), ext = '.webm') {
  const t = typeof template === 'string' && template.trim()
    ? template
    : DEFAULT_SETTINGS.filenameTemplate;
  const pad2 = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
  const stamp = String(Math.floor(now.getTime() / 1000));
  let name = t
    .split('{date}').join(date)
    .split('{time}').join(time)
    .split('{timestamp}').join(stamp)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .trim();
  if (!name) name = 'CaptureDesk';
  return `${name}${ext || ''}`;
}

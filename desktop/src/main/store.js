/**
 * @file CaptureDesk settings store — JSON persistence in the app data
 * directory (%APPDATA%/CaptureDesk/settings.json) with deep-merge writes and
 * change broadcasts to every window.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { recordingsDir } = require('./appPaths');

const FILE = () => path.join(app.getPath('userData'), 'settings.json');

/** Factory defaults for every user-facing setting. */
const DEFAULTS = {
  fps: 30,
  quality: '1080p', // '720p' | '1080p'
  countdown: 3, // 0 | 3 | 5 (seconds)
  mic: true,
  systemAudio: true,
  cameraBubble: false,
  cursorHighlight: true,
  clickHighlight: true,
  minimizeToTray: true,
  hotkeysEnabled: true,
  recordingsDir: null, // resolved lazily to <Videos>/CaptureDesk
  highlight: { color: '#5EEAD4', size: 26 },
  firstRunDone: false,
  version: '1.0.0',
};

let cache = null;
/** Subscribers notified with the full settings object after every write. */
const listeners = new Set();

/**
 * Read settings from disk (or seed defaults on first run).
 * @returns {object} The effective settings object.
 */
function read() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    cache = deepMerge(DEFAULTS, raw && typeof raw === 'object' ? raw : {});
  } catch (_) {
    cache = deepMerge(DEFAULTS, {});
  }
  if (!cache.recordingsDir) cache.recordingsDir = recordingsDir();
  return cache;
}

/**
 * Deep-merge `patch` into settings, persist and broadcast.
 * @param {object} patch Partial settings (nested objects merge key-wise).
 * @returns {object} The new effective settings.
 */
function write(patch) {
  const next = deepMerge(read(), patch || {});
  // Guarded fields callers may not set directly.
  next.recordingsDir = typeof next.recordingsDir === 'string' && next.recordingsDir
    ? next.recordingsDir
    : recordingsDir();
  next.version = DEFAULTS.version;
  cache = next;
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('[CaptureDesk] settings write failed:', err.message);
  }
  for (const fn of listeners) {
    try {
      fn(next);
    } catch (_) {
      // A broken listener must not break the rest.
    }
  }
  return next;
}

/**
 * Subscribe to settings changes.
 * @param {Function} fn Listener(settings).
 * @returns {Function} Unsubscribe.
 */
function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Recursive merge that clones plain objects and replaces everything else.
 * @param {object} base Base object.
 * @param {object} over Overrides.
 * @returns {object} Merged copy.
 */
function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over || {})) {
    const b = base ? base[k] : undefined;
    const o = over[k];
    if (o && typeof o === 'object' && !Array.isArray(o) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = deepMerge(b, o);
    } else if (o !== undefined) {
      out[k] = o;
    }
  }
  return out;
}

module.exports = { read, write, onChange, DEFAULTS };

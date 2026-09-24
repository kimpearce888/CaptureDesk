/**
 * @file CaptureDesk app paths: product naming, userData layout and the
 * recordings directory. Required first so app.setName() runs before ready.
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// The product name drives the app data directory: %APPDATA%/CaptureDesk on
// Windows, ~/.config/CaptureDesk on Linux.
app.setName('CaptureDesk');

/**
 * Root of the installed application (desktop/ in development, resources/app
 * when packaged). Used to resolve ffmpeg.wasm assets and renderer files.
 * @returns {string} Absolute app root path.
 */
function appRoot() {
  return app.isPackaged ? app.getAppPath() : path.join(__dirname, '..', '..');
}

/**
 * Absolute path of the CaptureDesk recordings directory, created on demand.
 * @returns {string} e.g. <Videos>/CaptureDesk.
 */
function recordingsDir() {
  const dir = path.join(app.getPath('videos'), 'CaptureDesk');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // Unwritable Videos dir — library falls back to userData.
  }
  return dir;
}

/**
 * Writable scratch directory for export intermediates (stroke PNGs, palettes).
 * @returns {string} Absolute temp directory path.
 */
function tmpDir() {
  const dir = path.join(app.getPath('temp'), 'CaptureDesk');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // Best effort.
  }
  return dir;
}

/**
 * True when abs resolves inside base (or a subfolder of it).
 * @param {string} abs Candidate absolute path.
 * @param {string} base Base directory.
 * @returns {boolean}
 */
function inside(abs, base) {
  const rel = path.relative(base, abs);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = { appRoot, recordingsDir, tmpDir, inside };

/**
 * @file CaptureDesk recordings library: scan, metadata cache, rename, delete,
 * reveal, unique export paths and the canonical recording file name builder.
 */
const fs = require('fs');
const path = require('path');
const { app, shell, dialog } = require('electron');
const { recordingsDir, inside } = require('./appPaths');
const store = require('./store');

const CACHE = () => path.join(app.getPath('userData'), 'library.json');

/**
 * Canonical recording file name: CaptureDesk_YYYY-MM-DD_HH-mm-ss.webm
 * @param {Date} [now] Moment to render (defaults to now).
 * @param {string} [ext] Extension with dot (default '.webm').
 * @returns {string}
 */
function recordingName(now = new Date(), ext = '.webm') {
  const p = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const time = `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  return `CaptureDesk_${date}_${time}${ext}`;
}

/**
 * Scan the recordings directory and return fresh metadata, newest first.
 * The on-disk cache only stores user renames (title overrides).
 * @returns {Array<{file:string,name:string,size:number,mtime:number}>}
 */
function list() {
  const dir = currentDir();
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const items = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!/\.(webm|mp4|gif)$/i.test(ent.name)) continue;
    try {
      const full = path.join(dir, ent.name);
      const st = fs.statSync(full);
      items.push({
        file: full,
        name: ent.name,
        size: st.size,
        mtime: st.mtimeMs,
      });
    } catch (_) {
      // File vanished mid-scan — skip.
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

/**
 * The effective recordings directory (settings override or default).
 * @returns {string}
 */
function currentDir() {
  const s = store.read();
  const dir = s.recordingsDir || recordingsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // Fall back to default when the override is unusable.
    return recordingsDir();
  }
  return dir;
}

/**
 * Rename a recording (same directory, extension preserved, name sanitized).
 * @param {string} file Absolute path inside the recordings dir.
 * @param {string} newName Desired display/file name.
 * @returns {{ok:boolean, file?:string, error?:string}}
 */
function rename(file, newName) {
  const dir = currentDir();
  if (!inside(file, dir)) return { ok: false, error: 'Not a CaptureDesk recording.' };
  const ext = path.extname(file);
  const clean = String(newName || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: 'Please enter a name.' };
  const target = path.join(dir, path.basename(clean, path.extname(clean)) + ext);
  try {
    fs.renameSync(file, target);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  broadcast();
  return { ok: true, file: target };
}

/**
 * Delete a recording permanently.
 * @param {string} file Absolute path inside the recordings dir.
 * @returns {{ok:boolean, error?:string}}
 */
function remove(file) {
  const dir = currentDir();
  if (!inside(file, dir)) return { ok: false, error: 'Not a CaptureDesk recording.' };
  try {
    fs.unlinkSync(file);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  broadcast();
  return { ok: true };
}

/**
 * Reveal a recording in the system file manager.
 * @param {string} file Absolute path.
 * @returns {{ok:boolean}}
 */
function reveal(file) {
  shell.showItemInFolder(file);
  return { ok: true };
}

/**
 * Compute a unique export path like <dir>/name_trim.webm that does not exist.
 * @param {string} base Base name without extension.
 * @param {string} ext Extension with dot.
 * @returns {string}
 */
function uniqueExportPath(base, ext) {
  const dir = currentDir();
  const safe = String(base || recordingName()).replace(/[\\/:*?"<>|]+/g, '-').trim() || recordingName();
  let candidate = path.join(dir, `${safe}${ext}`);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${safe} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

/**
 * Ask the user for a new recordings folder.
 * @param {Electron.BrowserWindow} win Parent window.
 * @returns {Promise<{ok:boolean, dir?:string}>}
 */
async function pickDir(win) {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a CaptureDesk Recordings folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  return { ok: true, dir: res.filePaths[0] };
}

/** Notify listeners that the library changed. */
function broadcast() {
  for (const win of require('./windows').allWindows()) {
    if (!win.isDestroyed()) win.webContents.send('library-changed', { at: Date.now() });
  }
}

module.exports = {
  recordingName,
  list,
  currentDir,
  rename,
  remove,
  reveal,
  uniqueExportPath,
  pickDir,
};

/**
 * @file CaptureDesk window factories: dashboard, hidden recorder compositor,
 * floating toolbar, region picker, camera bubble and the editor. Every window
 * is dark-themed, branded and created hidden until ready-to-show.
 */
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { appRoot } = require('./appPaths');
const store = require('./store');

const ICON = () => path.join(appRoot(), 'assets', 'icons', process.platform === 'win32' ? 'CaptureDesk.ico' : 'CaptureDesk_256.png');

/** Track live windows so other modules can broadcast events. */
const windows = new Map();

/**
 * @param {string} key Logical window key.
 * @returns {BrowserWindow|null}
 */
function get(key) {
  const win = windows.get(key);
  return win && !win.isDestroyed() ? win : null;
}

/** Remove destroyed windows from the map. */
function gc() {
  for (const [k, w] of windows) if (w.isDestroyed()) windows.delete(k);
}

/**
 * All live windows (for event broadcasts).
 * @returns {BrowserWindow[]}
 */
function allWindows() {
  gc();
  return [...windows.values()];
}

/**
 * Send an event to every live window (or a subset).
 * @param {string} channel Channel name.
 * @param {*} payload Event payload.
 * @param {string[]} [onlyKeys] Restrict to these window keys.
 */
function broadcast(channel, payload, onlyKeys) {
  gc();
  for (const [key, win] of windows) {
    if (onlyKeys && !onlyKeys.includes(key)) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (_) {
      // Window may be closing.
    }
  }
}

/** Common webPreferences for every CaptureDesk window. */
function prefs(extra) {
  return {
    preload: path.join(appRoot(), 'src', 'preload', 'index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
    ...extra,
  };
}

/**
 * Create (or focus) the main dashboard window — "CaptureDesk".
 * @returns {BrowserWindow}
 */
function dashboard() {
  const existing = get('dashboard');
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    title: 'CaptureDesk',
    width: 1120,
    height: 720,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0B1120',
    icon: ICON(),
    show: false,
    autoHideMenuBar: false,
    webPreferences: prefs({}),
  });
  win.loadFile(path.join(appRoot(), 'src', 'renderer', 'dashboard', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    const s = store.read();
    if (s.minimizeToTray && !global.__cdQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => windows.delete('dashboard'));
  windows.set('dashboard', win);
  return win;
}

/**
 * Hidden compositor window that owns capture streams, the canvas and the
 * MediaRecorder instance.
 * @returns {BrowserWindow}
 */
function recorderWindow() {
  let win = get('recorder');
  if (win) return win;
  win = new BrowserWindow({
    title: 'CaptureDesk Recorder',
    width: 900,
    height: 600,
    show: false,
    backgroundColor: '#0B1120',
    webPreferences: prefs({ backgroundThrottling: false }),
  });
  win.loadFile(path.join(appRoot(), 'src', 'renderer', 'recorder', 'index.html'));
  win.on('closed', () => windows.delete('recorder'));
  windows.set('recorder', win);
  return win;
}

/**
 * Floating recording toolbar near the captured display.
 * @param {Electron.Rectangle} [workArea] Work area to center within.
 * @returns {BrowserWindow}
 */
function toolbar(workArea) {
  const existing = get('toolbar');
  if (existing) return existing;
  const wa = workArea || screen.getPrimaryDisplay().workArea;
  const width = 384;
  const height = 72;
  const win = new BrowserWindow({
    title: 'CaptureDesk',
    width,
    height,
    x: wa.x + Math.floor((wa.width - width) / 2),
    y: wa.y + wa.height - height - 24,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    icon: ICON(),
    show: false,
    webPreferences: prefs({}),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(appRoot(), 'src', 'renderer', 'toolbar', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => windows.delete('toolbar'));
  windows.set('toolbar', win);
  return win;
}

/**
 * Fullscreen transparent region-picker overlay for one display.
 * @param {Electron.Display} display Target display.
 * @returns {BrowserWindow}
 */
function regionWindow(display) {
  const key = `region:${display.id}`;
  const win = new BrowserWindow({
    title: 'CaptureDesk — select area',
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    fullscreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    enableLargerThanScreen: false,
    backgroundColor: '#00000000',
    icon: ICON(),
    show: false,
    webPreferences: prefs({}),
  });
  win.loadFile(path.join(appRoot(), 'src', 'renderer', 'region', 'index.html'), {
    query: {
      displayId: String(display.id),
      displayX: String(display.bounds.x),
      displayY: String(display.bounds.y),
      scaleFactor: String(display.scaleFactor),
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => windows.delete(key));
  windows.set(key, win);
  return win;
}

/** Close every region picker (after a selection or a cancel). */
function closeRegionWindows() {
  gc();
  for (const [key, win] of windows) {
    if (key.startsWith('region:')) {
      windows.delete(key);
      try {
        win.close();
      } catch (_) {
        // Already closing.
      }
    }
  }
}

/**
 * Circular, draggable, always-on-top camera bubble.
 * @returns {BrowserWindow}
 */
function camBubble() {
  const existing = get('cambubble');
  if (existing) return existing;
  const wa = screen.getPrimaryDisplay().workArea;
  const size = 190;
  const win = new BrowserWindow({
    title: 'CaptureDesk Camera',
    width: size,
    height: size,
    x: wa.x + wa.width - size - 32,
    y: wa.y + wa.height - size - 32,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    backgroundColor: '#00000000',
    icon: ICON(),
    show: false,
    webPreferences: prefs({}),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(appRoot(), 'src', 'renderer', 'cambubble', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => windows.delete('cambubble'));
  windows.set('cambubble', win);
  return win;
}

/**
 * "CaptureDesk Editor" window for playback, trimming, annotation and export.
 * @param {string} [file] Recording path to open.
 * @returns {BrowserWindow}
 */
function editor(file) {
  let win = get('editor');
  if (win) {
    win.focus();
    if (file) win.webContents.send('editor:load', { file });
    return win;
  }
  win = new BrowserWindow({
    title: 'CaptureDesk Editor',
    width: 1180,
    height: 760,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0B1120',
    icon: ICON(),
    show: false,
    // The editor loads ffmpeg.wasm workers from the app directory; local-only
    // content + preload IPC isolation keep this window's attack surface tiny.
    webPreferences: prefs({ webSecurity: false }),
  });
  const hash = file ? `#${encodeURIComponent(file)}` : '';
  win.loadFile(path.join(appRoot(), 'src', 'renderer', 'editor', 'index.html'), { hash });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => windows.delete('editor'));
  windows.set('editor', win);
  return win;
}

/** Close the toolbar (end of session). */
function closeToolbar() {
  const win = get('toolbar');
  if (win) {
    windows.delete('toolbar');
    try {
      win.close();
    } catch (_) {
      // Already closing.
    }
  }
}

/** Close the camera bubble. */
function closeCamBubble() {
  const win = get('cambubble');
  if (win) {
    windows.delete('cambubble');
    try {
      win.close();
    } catch (_) {
      // Already closing.
    }
  }
}

/** Close the hidden recorder window. */
function closeRecorder() {
  const win = get('recorder');
  if (win) {
    windows.delete('recorder');
    try {
      win.close();
    } catch (_) {
      // Already closing.
    }
  }
}

module.exports = {
  dashboard,
  recorderWindow,
  toolbar,
  regionWindow,
  closeRegionWindows,
  camBubble,
  editor,
  closeToolbar,
  closeCamBubble,
  closeRecorder,
  get,
  allWindows,
  broadcast,
};

/**
 * @file CaptureDesk Desktop — application entry point. Wires the session
 * state machine, the recording library, settings, tray, shortcuts, the
 * capturedesk:// protocol and every IPC handler.
 */
const path = require('path');
const fs = require('fs');
const { app, ipcMain, dialog, session, shell, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

const { appRoot, recordingsDir, tmpDir, inside } = require('./appPaths');
const store = require('./store');
const library = require('./library');
const recorder = require('./recorder');
const inputhooks = require('./inputhooks');
const windows = require('./windows');
const tray = require('./tray');
const shortcuts = require('./shortcuts');
const menu = require('./menu');

// Single instance: focus the dashboard instead of launching twice.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => windows.dashboard());
}

// capturedesk:// scheme for future deep links (registered per process).
protocol.registerSchemesAsPrivileged([
  { scheme: 'capturedesk', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(() => {
  // Allow only our own windows to request media devices.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const allowed = ['media', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock'];
    cb(allowed.includes(permission));
  });

  try {
    protocol.handle('capturedesk', (request) => net.fetch(request.url.replace('capturedesk://', 'http://local/')));
  } catch (_) {
    // Deep links are a progressive enhancement; ignore failures.
  }

  menu.install();
  store.read(); // Seed settings on boot.
  recordingsDir(); // Ensure the CaptureDesk Recordings folder exists.
  windows.dashboard();
  tray.create();
  shortcuts.register();
  store.onChange(() => shortcuts.register());

  // Development smoke tests (used by the build pipeline on headless CI):
  //   electron . --editor-smoke                → opens CaptureDesk Editor
  //   electron . --editor-smoke --export-smoke → also runs the export self test
  //   electron . --recorder-smoke              → opens the hidden compositor window
  if (process.argv.includes('--editor-smoke')) {
    setTimeout(() => {
      windows.editor(null);
      if (process.argv.includes('--export-smoke')) {
        setTimeout(() => {
          const win = windows.get('editor');
          if (win) win.webContents.send('editor:smoke');
        }, 5000);
      }
    }, 1200);
  }
  if (process.argv.includes('--recorder-smoke')) setTimeout(() => windows.recorderWindow(), 1200);

  console.log('[CaptureDesk] ready — data dir:', app.getPath('userData'));
});

// Keep the recorder from being background-throttled mid-session.
app.on('browser-window-created', (_e, win) => {
  win.webContents.setBackgroundThrottling(false);
});

// Confirm before quitting mid-recording.
app.on('before-quit', (e) => {
  if (!recorder.isActive() || global.__cdQuitting) return;
  e.preventDefault();
  global.__cdQuitting = true;
  const win = windows.dashboard();
  const snap = recorder.snapshot();
  dialog
    .showMessageBox(win || undefined, {
      type: 'question',
      title: 'CaptureDesk',
      message: 'Recording in progress',
      detail: snap.state === recorder.STATE.PAUSED
        ? 'CaptureDesk is paused. Save the recording before quitting?'
        : 'Stop and save the recording before quitting CaptureDesk?',
      buttons: ['Stop & save', 'Discard & quit', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    })
    .then(async ({ response }) => {
      if (response === 0) {
        await recorder.stop();
        // Give the recorder a moment to flush, then quit.
        setTimeout(() => app.quit(), 1500);
      } else if (response === 1) {
        await recorder.cancel();
        app.quit();
      } else {
        global.__cdQuitting = false;
      }
    });
});

app.on('window-all-closed', () => {
  // Tray keeps the app alive; quit only when the user asks (or no tray).
  if (!store.read().minimizeToTray || !tray) {
    app.quit();
  }
});

app.on('will-quit', () => {
  shortcuts.unregisterAll();
  inputhooks.stop();
  tray.destroy();
});

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

/** Wrap a handler so renderer errors come back as {ok:false,error}. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return await fn(payload, event);
    } catch (err) {
      console.error(`[CaptureDesk] ${channel} failed:`, err.message);
      return { ok: false, error: err.message };
    }
  });
}

handle('app:get-version', () => app.getVersion());
handle('app:quit', () => app.quit());

handle('state:get', () => ({ ok: true, state: recorder.snapshot() }));

handle('sources:list', async (payload) => ({
  ok: true,
  sources: await recorder.listSources(payload || {}),
}));

handle('rec:start', (payload) => recorder.start(payload || {}));
handle('rec:pause', () => recorder.pause());
handle('rec:resume', () => recorder.resume());
handle('rec:stop', () => recorder.stop());
handle('rec:cancel', () => recorder.cancel());
handle('rec:ack', ({ key, value }) => recorder.resolveAck(key, value));
handle('rec:state', (payload) => recorder.applyRecorderState(payload || {}));

// Show/hide the camera bubble while recording.
handle('cambubble:toggle', () => {
  const open = Boolean(windows.get('cambubble'));
  if (open) windows.closeCamBubble();
  else windows.camBubble();
  windows.broadcast('cambubble-visible', { visible: !open }, ['toolbar']);
  return { ok: true, visible: !open };
});

// From the hidden recorder window: finished recording bytes.
handle('rec:save', async (payload) => recorder.saveRecording(payload));

handle('region:begin', () => recorder.beginRegionSelection());
handle('region:selected', (payload) => recorder.setPendingRegion(payload));

handle('settings:get', () => ({ ok: true, settings: store.read() }));
handle('settings:set', (patch) => {
  const settings = store.write(patch);
  windows.broadcast('settings-changed', { settings });
  return { ok: true, settings };
});

handle('library:list', () => ({ ok: true, items: library.list() }));
handle('library:rename', ({ file, newName }) => library.rename(file, newName));
handle('library:remove', ({ file }) => library.remove(file));
handle('library:reveal', ({ file }) => library.reveal(file));
handle('library:dir', () => ({ ok: true, dir: library.currentDir() }));
handle('library:pick-dir', async (_p, event) => library.pickDir(event.sender.getOwnerBrowserWindow()));

handle('editor:open', ({ file }) => {
  windows.editor(file);
  return { ok: true };
});

// Restricted filesystem surface for the editor's ffmpeg.wasm strategy.
handle('fs:app-path', () => ({ ok: true, path: appRoot() }));
handle('fs:tmp-dir', () => ({ ok: true, path: tmpDir() }));
handle('fs:recordings-dir', () => ({ ok: true, path: library.currentDir() }));

/** Resolve an app-root file to a file:// URL (editor's ffmpeg.wasm assets). */
handle('fs:app-file-url', ({ rel }) => {
  const root = appRoot();
  const abs = path.resolve(root, String(rel || ''));
  if (!inside(abs, root)) return { ok: false, error: 'Path outside the application.' };
  return { ok: true, url: pathToFileURL(abs).href };
});

/**
 * Read a recording from the CaptureDesk Recordings folder (editor input).
 */
handle('fs:read-recording', ({ file }) => {
  const dir = library.currentDir();
  const abs = path.resolve(String(file || ''));
  if (!inside(abs, dir)) return { ok: false, error: 'Not a CaptureDesk recording.' };
  const data = fs.readFileSync(abs);
  return { ok: true, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
});

/** Write bytes anywhere under the recordings dir or the temp dir. */
handle('fs:write-file', ({ file, data }) => {
  const abs = path.resolve(String(file || ''));
  const allowed = inside(abs, library.currentDir()) || inside(abs, tmpDir());
  if (!allowed) return { ok: false, error: 'Path outside CaptureDesk folders.' };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(new Uint8Array(data)));
  return { ok: true };
});

handle('fs:unique-path', ({ base, ext }) => ({
  ok: true,
  path: library.uniqueExportPath(base, ext),
}));

handle('shell:open-path', ({ path: p }) => shell.openPath(String(p || '')));

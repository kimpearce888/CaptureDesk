/**
 * @file CaptureDesk preload — a minimal, namespaced, promise-based bridge.
 * No Node APIs leak into renderers; every call is an explicit IPC round-trip.
 */
const { contextBridge, ipcRenderer } = require('electron');

/** Events renderers may subscribe to (everything else is rejected). */
const EVENT_CHANNELS = new Set([
  'rec-state', // {state, elapsedMs, remainingMs, note, error, lastFile, nativeHooks}
  'library-changed', // {at}
  'settings-changed', // {settings}
  'region-selected', // {displayId, rect}
  'export-progress', // {ratio, message}
  'rec-setup', // recorder window: session setup payload
  'rec-start', // recorder window: {countdown}
  'rec-pause', // recorder window: {}
  'rec-resume', // recorder window: {}
  'rec-stop', // recorder window: {}
  'rec-cancel', // recorder window: {}
  'cursor', // recorder window: {x, y} DIP screen coords
  'ripple', // recorder window: {x, y, button}
  'cambubble-visible', // toolbar: {visible}
  'editor:load', // editor window: {file}
  'editor:smoke', // editor window: run the export-pipeline self test
]);

/** Invoke helper: (channel, payload) → result. */
function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

contextBridge.exposeInMainWorld('capturedesk', {
  // ---- app ---------------------------------------------------------------
  getVersion: () => invoke('app:get-version'),
  quit: () => invoke('app:quit'),

  // ---- session state -----------------------------------------------------
  getState: () => invoke('state:get'),

  // ---- sources & recording ----------------------------------------------
  listSources: (kinds) => invoke('sources:list', kinds),
  startRecording: (req) => invoke('rec:start', req),
  pauseRecording: () => invoke('rec:pause'),
  resumeRecording: () => invoke('rec:resume'),
  stopRecording: () => invoke('rec:stop'),
  cancelRecording: () => invoke('rec:cancel'),
  ack: (key, value) => invoke('rec:ack', { key, value }),
  saveRecording: (payload) => invoke('rec:save', payload),
  saveState: (payload) => invoke('rec:state', payload),
  toggleCamBubble: () => invoke('cambubble:toggle'),
  beginRegionSelection: () => invoke('region:begin'),
  regionSelected: (payload) => invoke('region:selected', payload),

  // ---- settings ----------------------------------------------------------
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),

  // ---- library -----------------------------------------------------------
  listLibrary: () => invoke('library:list'),
  renameRecording: (file, newName) => invoke('library:rename', { file, newName }),
  removeRecording: (file) => invoke('library:remove', { file }),
  revealRecording: (file) => invoke('library:reveal', { file }),
  libraryDir: () => invoke('library:dir'),
  pickRecordingsDir: () => invoke('library:pick-dir'),

  // ---- editor ------------------------------------------------------------
  openEditor: (file) => invoke('editor:open', { file }),

  // ---- restricted filesystem (editor / ffmpeg.wasm support) --------------
  appPath: () => invoke('fs:app-path'),
  tmpDir: () => invoke('fs:tmp-dir'),
  recordingsDir: () => invoke('fs:recordings-dir'),
  appFileUrl: (rel) => invoke('fs:app-file-url', { rel }),
  readRecording: (file) => invoke('fs:read-recording', { file }),
  writeFile: (file, data) => invoke('fs:write-file', { file, data }),
  uniqueExportPath: (base, ext) => invoke('fs:unique-path', { base, ext }),
  openPath: (p) => invoke('shell:open-path', { path: p }),

  // ---- events ------------------------------------------------------------
  /**
   * Subscribe to a whitelisted event channel.
   * @param {string} channel Channel name.
   * @param {Function} cb Listener(payload).
   * @returns {Function} Unsubscribe.
   */
  on(channel, cb) {
    if (!EVENT_CHANNELS.has(channel)) {
      throw new Error(`CaptureDesk: unknown event channel "${channel}"`);
    }
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});

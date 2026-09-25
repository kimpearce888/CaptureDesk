/**
 * @file CaptureDesk bridge (Tauri v2) — a drop-in replacement for the v1
 * Electron preload. Every renderer talks to `window.capturedesk` exactly
 * as before; this file maps those calls onto Tauri commands and events.
 *
 * Requires `app.withGlobalTauri: true` (see tauri.conf.json).
 */
(function () {
  'use strict';

  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || !tauri.event) {
    // The dashboard can render the failure instead of dying silently.
    window.capturedesk = {
      _bridge: 'missing',
      on() {
        return () => {};
      },
    };
    ['getVersion', 'getState', 'getSettings'].forEach((m) => {
      window.capturedesk[m] = () =>
        Promise.reject(new Error('CaptureDesk: Tauri global API unavailable'));
    });
    return;
  }

  const { invoke, convertFileSrc } = tauri.core;
  const { listen } = tauri.event;

  /** Events renderers may subscribe to (identical to the v1 whitelist). */
  const EVENT_CHANNELS = new Set([
    'rec-state',
    'library-changed',
    'settings-changed',
    'region-selected',
    'export-progress',
    'rec-setup',
    'rec-start',
    'rec-pause',
    'rec-resume',
    'rec-stop',
    'rec-cancel',
    'cursor',
    'ripple',
    'cambubble-visible',
    'editor:load',
    'editor:smoke',
    'capturedesk-ready',
  ]);

  // ---- base64 helpers (restricted-FS bridge payloads) ----------------------

  function u8ToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + chunk)
      );
    }
    return btoa(bin);
  }

  function b64ToU8(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---- bridge --------------------------------------------------------------

  const bridge = {
    // ---- app ---------------------------------------------------------------
    getVersion: () =>
      invoke('app_get_version').then((r) =>
        typeof r === 'string' ? r : r && r.version ? r.version : ''
      ),
    quit: () => invoke('app_quit'),

    // ---- session state -----------------------------------------------------
    getState: () => invoke('state_get'),

    // ---- sources & recording ----------------------------------------------
    listSources: (kinds) => invoke('sources_list', { kinds }),
    startRecording: (req) => invoke('rec_start', { req }),
    pauseRecording: () => invoke('rec_pause'),
    resumeRecording: () => invoke('rec_resume'),
    stopRecording: () => invoke('rec_stop'),
    cancelRecording: () => invoke('rec_cancel'),
    ack: (key, value) => invoke('rec_ack', { key, value }),
    saveRecording: (payload) => invoke('rec_save', { payload }),
    saveState: (payload) => invoke('rec_state_save', { payload }),
    toggleCamBubble: () => invoke('cambubble_toggle'),
    beginRegionSelection: () => invoke('region_begin'),
    regionSelected: (payload) => invoke('region_selected', { payload }),

    // ---- settings ----------------------------------------------------------
    getSettings: () => invoke('settings_get'),
    setSettings: (patch) => invoke('settings_set', { patch }),

    // ---- library -----------------------------------------------------------
    listLibrary: () => invoke('library_list'),
    renameRecording: (file, newName) => invoke('library_rename', { file, newName }),
    removeRecording: (file) => invoke('library_remove', { file }),
    revealRecording: (file) => invoke('library_reveal', { file }),
    libraryDir: () => invoke('library_dir'),
    pickRecordingsDir: () => invoke('library_pick_dir'),

    // ---- editor ------------------------------------------------------------
    openEditor: (file) => invoke('editor_open', { file }),

    // ---- restricted filesystem ----------------------------------------------
    appPath: () => invoke('fs_app_path'),
    tmpDir: () => invoke('fs_tmp_dir'),
    recordingsDir: () => invoke('fs_recordings_dir'),
    appFileUrl: (rel) =>
      invoke('fs_app_file_url', { rel }).then((r) => ({
        url: r && r.path ? convertFileSrc(r.path) : '',
      })),
    readRecording: (file) =>
      invoke('fs_read_recording', { file }).then((r) =>
        r && r.ok ? { ok: true, data: b64ToU8(r.dataB64) } : r
      ),
    writeFile: (file, data) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      return invoke('fs_write_file', { file, dataB64: u8ToB64(bytes) });
    },
    uniqueExportPath: (base, ext) => invoke('fs_unique_path', { base, ext }),
    openPath: (p) => invoke('shell_open_path', { path: p }),

    // ---- native export (v2: CaptureDesk Export runs in the C++ engine) -----
    transcodeFile: (spec) => invoke('transcode_file', { spec }),
    transcodeCancel: () => invoke('transcode_cancel'),
    engineVersion: () => invoke('engine_version'),

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
      let unlisten = null;
      let alive = true;
      listen(channel, (event) => cb(event.payload)).then((u) => {
        if (alive) unlisten = u;
        else u();
      });
      return () => {
        alive = false;
        if (unlisten) unlisten();
      };
    },
  };

  window.capturedesk = bridge;
})();

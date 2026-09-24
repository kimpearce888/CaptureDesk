/**
 * @file CaptureDesk Editor — engine loader (v2 native stack).
 *
 * In v2 the export pipeline is the CaptureDesk native engine (C++/FFmpeg
 * sidecar). "Loading the engine" is a health check: the shell asks the
 * engine for its version over the sidecar channel. The v1 ffmpeg.wasm
 * virtual-FS shim is gone — no wasm download, no worker bootstrap, no
 * COOP/COEP headers, and full-format encoding on every platform.
 */
(function () {
  'use strict';

  const CDEditor = (window.CDEditor = window.CDEditor || {});

  let enginePromise = null;

  /**
   * Resolve once the native engine answers a version probe.
   * @returns {Promise<{engine:string, version:string}>}
   */
  CDEditor.loadFFmpeg = function loadFFmpeg() {
    if (!enginePromise) {
      enginePromise = window.capturedesk
        .engineVersion()
        .then((r) => {
          if (!r || !r.ok) {
            throw new Error(r && r.error ? r.error : 'engine unavailable');
          }
          return { engine: r.engine || 'native-cpp', version: r.version || '' };
        })
        .catch((err) => {
          enginePromise = null;
          throw err;
        });
    }
    return enginePromise;
  };

  /** Current load attempt (null when idle or unavailable). */
  CDEditor.currentFFmpeg = function currentFFmpeg() {
    return enginePromise;
  };

  /** Drop the cached probe so the next export re-checks the engine. */
  CDEditor.resetFFmpeg = function resetFFmpeg() {
    enginePromise = null;
  };
})();

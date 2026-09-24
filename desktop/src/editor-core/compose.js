/**
 * @file CaptureDesk Editor — ffmpeg.wasm loader.
 *
 * Strategy: the editor window runs with webSecurity disabled (local-only
 * content), which lets us hand ffmpeg.wasm direct file:// URLs for its UMD
 * script, class worker and core. Blob URLs are NOT used — on file:// pages
 * their opaque origin breaks the worker's dynamic import of the core module.
 * The instance is cached for the window lifetime; after terminate() the
 * loader transparently rebuilds it.
 */
(function () {
  'use strict';

  window.CDEditor = window.CDEditor || {};

  const ASSETS = {
    main: 'node_modules/@ffmpeg/ffmpeg/dist/umd/ffmpeg.js',
    worker: 'node_modules/@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js',
    core: 'node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js',
    wasm: 'node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm',
  };

  let cached = null;
  let loading = null;

  /**
   * Resolve a node_modules asset to a file:// URL via the restricted IPC.
   * @param {string} rel App-root-relative path.
   * @returns {Promise<string>} Absolute file URL.
   */
  async function assetURL(rel) {
    const res = await window.capturedesk.appFileUrl(rel);
    if (!res || !res.ok) throw new Error(`Missing asset: ${rel}`);
    return res.url;
  }

  /**
   * Load (or return the cached) ffmpeg.wasm instance.
   * @param {Function} [onMessage] Optional log callback.
   * @returns {Promise<object>} FFmpeg instance.
   */
  CDEditor.loadFFmpeg = async function loadFFmpeg(onMessage) {
    if (cached) return cached;
    if (loading) return loading;

    loading = (async () => {
      const mainURL = await assetURL(ASSETS.main);
      await new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = mainURL;
        el.onload = () => resolve();
        el.onerror = () => reject(new Error('CaptureDesk could not load the export engine.'));
        document.head.appendChild(el);
      });

      if (!window.FFmpegWASM || !window.FFmpegWASM.FFmpeg) {
        throw new Error('CaptureDesk export engine is unavailable.');
      }

      const [workerURL, coreURL, wasmURL] = await Promise.all([
        assetURL(ASSETS.worker),
        assetURL(ASSETS.core),
        assetURL(ASSETS.wasm),
      ]);

      let ffmpeg;
      try {
        ffmpeg = new window.FFmpegWASM.FFmpeg();
        ffmpeg.on('log', ({ message }) => {
          if (onMessage) onMessage(String(message).slice(0, 300));
        });
        // No classWorkerURL here: the UMD build then spawns a CLASSIC worker
        // from its own directory, where importScripts(coreURL) is available.
        // (classWorkerURL would force a module worker, whose fallback path
        // is a webpack stub that always throws MODULE_NOT_FOUND.)
        await ffmpeg.load({ coreURL, wasmURL });
      } catch (err) {
        const detail = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
        console.warn('[CaptureDesk] ffmpeg.load failed:', detail);
        throw err instanceof Error ? err : new Error(`Export engine failed to load: ${detail}`);
      }
      cached = ffmpeg;
      return ffmpeg;
    })();

    try {
      return await loading;
    } finally {
      loading = null;
    }
  };

  /**
   * Drop the cached instance (used after terminate/cancel).
   */
  CDEditor.resetFFmpeg = function resetFFmpeg() {
    cached = null;
    loading = null;
  };

  /**
   * The cached instance, if one is loaded.
   * @returns {object|null}
   */
  CDEditor.currentFFmpeg = function currentFFmpeg() {
    return cached;
  };
})();

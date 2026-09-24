/**
 * @file CaptureDesk Editor — export orchestration (capturedesk-editor module).
 * Bridges the UI, the ffmpeg.wasm instance and the restricted filesystem IPC.
 */
(function () {
  'use strict';

  const CDEditor = (window.CDEditor = window.CDEditor || {});

  let cancelled = false;

  /**
   * Write bytes into the ffmpeg FS.
   * @param {object} ffmpeg FFmpeg instance.
   * @param {string} name Virtual file name.
   * @param {Uint8Array} bytes File bytes.
   */
  async function put(ffmpeg, name, bytes) {
    await ffmpeg.writeFile(name, bytes);
  }

  /**
   * Run an ffmpeg command, reporting progress, supporting cancel.
   * @param {object} ffmpeg FFmpeg instance.
   * @param {string[]} args Command args.
   * @param {Function} onProgress (ratio 0..1).
   */
  async function run(ffmpeg, args, onProgress) {
    cancelled = false;
    const handler = ({ progress }) => {
      if (onProgress) onProgress(Math.max(0, Math.min(1, progress || 0)));
    };
    ffmpeg.on('progress', handler);
    try {
      const code = await ffmpeg.exec(args);
      if (cancelled) throw new Error('cancelled');
      if (code !== 0) throw new Error(`Export failed (exit ${code}).`);
    } finally {
      ffmpeg.off('progress', handler);
    }
  }

  /**
   * Delete a virtual file from the ffmpeg FS (best effort).
   * @param {object} ffmpeg FFmpeg instance.
   * @param {string} name Virtual file name.
   */
  async function del(ffmpeg, name) {
    try {
      await ffmpeg.deleteFile(name);
    } catch (_) {
      // Not present.
    }
  }

  /**
   * Save an in-memory export to the CaptureDesk Recordings folder.
   * @param {Uint8Array} bytes Export bytes.
   * @param {string} base Base name.
   * @param {string} ext Extension with dot.
   * @returns {Promise<string>} Absolute output path.
   */
  async function persist(bytes, base, ext) {
    const res = await window.capturedesk.uniqueExportPath(base, ext);
    if (!res || !res.ok) throw new Error('CaptureDesk could not choose an output path.');
    const w = await window.capturedesk.writeFile(res.path, bytes.buffer);
    if (!w || !w.ok) throw new Error('CaptureDesk could not write the exported file.');
    return res.path;
  }

  /**
   * Run a full export.
   * @param {object} o
   * @param {string} o.file Absolute recording path.
   * @param {string} o.base Export base name.
   * @param {'webm'|'mp4'|'gif'} o.format Output format.
   * @param {{inS:number, outS:number}} o.trim Trim window.
   * @param {Array<object>} o.strokes Annotation strokes (normalized coords).
   * @param {boolean} o.burn Burn annotations into the video.
   * @param {Function} o.getPNG Async (i) => Blob for stroke i, or Blob for 'all'.
   * @param {Function} o.onProgress (ratio, message).
   * @returns {Promise<{file:string, fallbackNote:string|null}>} Written export path.
   */
  CDEditor.runExport = async function runExport(o) {
    const ffmpeg = await CDEditor.loadFFmpeg();
    o.onProgress(0, 'Preparing…');

    // 1) Input bytes.
    const res = await window.capturedesk.readRecording(o.file);
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'Could not read the recording.');
    await put(ffmpeg, 'input.webm', new Uint8Array(res.data));
    o.onProgress(0.02, 'Loading…');

    // 2) Stroke PNGs (virtual FS) when burning.
    const burn = o.burn && o.strokes.length > 0;
    if (burn) {
      const many = o.strokes.length <= 6;
      const pngs = [];
      for (let i = 0; i < (many ? o.strokes.length : 1); i += 1) {
        const blob = await o.getPNG(many ? i : 'all');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await put(ffmpeg, `stroke${i}.png`, bytes);
        pngs.push(o.strokes[i]);
      }
      o.strokes = many ? o.strokes : [{ ...o.strokes[0], tEnd: o.strokes[o.strokes.length - 1].tEnd }];
    }

    // 3) Encode. WebM is a pure stream copy (the LGPL core cannot encode
    //    VP8); burning annotations with a WebM choice therefore falls back
    //    to an MP4 output, reported to the caller via `fallbackNote`.
    let outName;
    let ext;
    let args;
    let fallbackNote = null;
    let effFormat = o.format;
    if (burn && o.format === 'webm') {
      effFormat = 'mp4';
      fallbackNote = 'WebM cannot carry burned-in annotations with the bundled engine — exported MP4 instead.';
    }
    if (effFormat === 'gif') {
      const p1 = CDEditor.buildGifPass(1, o.trim);
      o.onProgress(0.1, 'Analyzing colors (pass 1 of 2)…');
      await run(ffmpeg, p1.args, (r) => o.onProgress(0.1 + r * 0.4, 'Analyzing colors…'));
      const p2 = CDEditor.buildGifPass(2, o.trim);
      outName = p2.output;
      ext = '.gif';
      args = p2.args;
      o.onProgress(0.5, 'Encoding GIF (pass 2 of 2)…');
      await run(ffmpeg, args, (r) => o.onProgress(0.5 + r * 0.5, 'Encoding GIF…'));
    } else {
      const built = effFormat === 'mp4' ? CDEditor.buildMp4({ ...o.trim, burn, strokes: o.strokes }) : CDEditor.buildWebm(o.trim);
      outName = built.output;
      ext = effFormat === 'mp4' ? '.mp4' : '.webm';
      await run(ffmpeg, built.args, (r) => o.onProgress(0.02 + r * 0.97, 'Encoding…'));
    }

    // 4) Persist.
    o.onProgress(1, 'Saving…');
    const data = await ffmpeg.readFile(outName);
    const file = await persist(new Uint8Array(data), o.base, ext);

    // 5) Cleanup virtual FS.
    await del(ffmpeg, 'input.webm');
    await del(ffmpeg, outName);
    if (o.format === 'gif') await del(ffmpeg, 'palette.png');
    if (burn) {
      const n = o.strokes.length <= 6 ? o.strokes.length : 1;
      for (let i = 0; i < n; i += 1) await del(ffmpeg, `stroke${i}.png`);
    }
    return { file, fallbackNote };
  };

  /**
   * Cancel an in-flight export (terminates the wasm instance; the next export
   * transparently reloads it).
   */
  CDEditor.cancelExport = function cancelExport() {
    cancelled = true;
    const ffmpeg = CDEditor.currentFFmpeg();
    if (ffmpeg) {
      try {
        ffmpeg.terminate();
      } catch (_) {
        // Already gone.
      }
    }
    CDEditor.resetFFmpeg();
  };
})();

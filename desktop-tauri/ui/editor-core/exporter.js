/**
 * @file CaptureDesk Editor — export orchestration (capturedesk-editor, v2).
 *
 * Hands the export spec (input, trim window, rasterized annotation overlays)
 * to the CaptureDesk native engine, which trims, burns overlays and encodes
 * WebM / MP4 / GIF directly into the CaptureDesk Recordings folder. Progress
 * arrives on the `export-progress` bridge event.
 */
(function () {
  'use strict';

  const CDEditor = (window.CDEditor = window.CDEditor || {});

  CDEditor.runExport = async function runExport(o) {
    // Fail fast (with the engine-unavailable note) before staging anything.
    await CDEditor.loadFFmpeg();
    o.onProgress(0, 'Preparing…');

    // 1) Stage annotation overlays as PNGs in the CaptureDesk tmp folder.
    const overlays = [];
    const burn = o.burn && o.strokes.length > 0;
    if (burn) {
      const many = o.strokes.length <= 6;
      const strokes = many
        ? o.strokes
        : [{ ...o.strokes[0], tEnd: o.strokes[o.strokes.length - 1].tEnd }];
      const tmp = (await window.capturedesk.tmpDir()).dir;
      const stamp = Date.now();
      for (let i = 0; i < strokes.length; i += 1) {
        const blob = await o.getPNG(many ? i : 'all');
        const path = `${tmp}/cd-stroke-${stamp}-${i}.png`;
        const w = await window.capturedesk.writeFile(
          path,
          new Uint8Array(await blob.arrayBuffer())
        );
        if (!w || !w.ok) {
          throw new Error(w && w.error ? w.error : 'CaptureDesk could not stage annotation overlays.');
        }
        overlays.push({
          png: path,
          from: Number(strokes[i].tStart) || 0,
          to: Number(strokes[i].tEnd) || 1e9,
        });
      }
    }

    // 2) Run the engine export; progress events mirror the v1 callback.
    const unProgress = window.capturedesk.on('export-progress', (p) => {
      const ratio = Math.max(0, Math.min(1, Number(p && p.ratio) || 0));
      o.onProgress(ratio, (p && p.message) || 'Encoding…');
    });

    let result;
    try {
      result = await window.capturedesk.transcodeFile({
        input: o.file,
        base: o.base,
        format: o.format,
        trim: { inS: o.trim.inS, outS: o.trim.outS },
        overlays,
        quality: 'source',
      });
    } finally {
      unProgress();
    }

    if (!result || !result.ok) {
      throw new Error(result && result.error ? result.error : 'CaptureDesk Export failed.');
    }
    return { file: result.file, fallbackNote: result.fallbackNote || null };
  };

  /**
   * Cancel an in-flight export. The engine stops at the next frame and the
   * pending transcodeFile call rejects with "cancelled" (v1-compatible).
   */
  CDEditor.cancelExport = function cancelExport() {
    window.capturedesk.transcodeCancel().catch(() => {
      // Engine already gone — the pending export will fail on its own.
    });
  };
})();

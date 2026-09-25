/**
 * @file CaptureDesk Editor — ffmpeg argument builders for every export
 * format (capturedesk-editor export module).
 *
 * Flag-order notes:
 *  - WebM stream copy: -ss/-to go BEFORE -i (fast seek on container level)
 *    and -c copy keeps original quality; cuts snap to keyframes, which keeps
 *    A/V in sync thanks to -avoid_negative_ts make_zero.
 *  - MP4 (MPEG-4 Part 2 "mpeg4" — the bundled LGPL core ships no libx264):
 *    -ss/-to go AFTER -i so the filter graph sees trimmed timestamps;
 *    re-encoding is slower but frame-accurate.
 *  - GIF uses a two-pass palettegen/paletteuse flow (see buildGifPass).
 */
(function () {
  'use strict';

  const CDEditor = (window.CDEditor = window.CDEditor || {});

  /**
   * Format seconds as an ffmpeg-friendly fixed string.
   * @param {number} s Seconds.
   * @returns {string} e.g. '12.340'.
   */
  function t(s) {
    return (Math.max(0, Number(s) || 0)).toFixed(3);
  }

  /**
   * Build the overlay filter chain for burn-in annotations.
   * @param {number} count Number of stroke PNG inputs (1-based after video).
   * @param {Array<{tStart:number,tEnd:number}>} strokes Stroke timing.
   * @returns {{args:string[], mapVideo:string, mapAudio:string}} Args to append
   *   after the input list plus the mapping labels.
   */
  function overlayChain(count, strokes) {
    if (!count) return { args: [], mapVideo: '0:v', mapAudio: '0:a?' };
    const args = [];
    for (let i = 0; i < count; i += 1) args.push('-i', `stroke${i}.png`);
    let label = '0:v';
    let chain = '';
    for (let i = 0; i < count; i += 1) {
      const s = strokes[i];
      const next = `ov${i}`;
      chain += `[${label}][${i + 1}:v]overlay=0:0:enable='between(t,${t(s.tStart)},${t(s.tEnd)})'[${next}];`;
      label = next;
    }
    chain = chain.replace(/;$/, '');
    args.push('-filter_complex', chain);
    return { args, mapVideo: label, mapAudio: '0:a?' };
  }

  /**
   * Build a WebM export. The LGPL wasm core cannot ENCODE VP8 (decode only),
   * so WebM is always a pure stream copy — burning annotations with a WebM
   * output is handled by the exporter as an MP4 fallback.
   * @param {object} o {inS, outS}.
   * @returns {{args:string[], output:string}} Complete arg list.
   */
  CDEditor.buildWebm = function buildWebm(o) {
    const out = 'output.webm';
    return {
      args: ['-ss', t(o.inS), '-to', t(o.outS), '-i', 'input.webm',
        '-c', 'copy', '-avoid_negative_ts', 'make_zero', out],
      output: out,
    };
  };

  /**
   * Build an MP4 export (MPEG-4 Part 2; broad compatibility).
   * @param {object} o {inS, outS, burn, strokes}.
   * @returns {{args:string[], output:string}}
   */
  CDEditor.buildMp4 = function buildMp4(o) {
    const out = 'output.mp4';
    const oc = overlayChain(o.burn ? (o.strokes || []).length : 0, o.strokes || []);
    return {
      args: ['-i', 'input.webm', '-ss', t(o.inS), '-to', t(o.outS),
        ...oc.args,
        '-map', oc.mapVideo, '-map', oc.mapAudio,
        '-c:v', 'mpeg4', '-q:v', '5',
        '-c:a', 'aac', '-b:a', '128k', out],
      output: out,
    };
  };

  /**
   * Build one GIF pass.
   * @param {number} pass 1 = palettegen, 2 = paletteuse.
   * @param {object} o {inS, outS}.
   * @returns {{args:string[], output:string}}
   */
  CDEditor.buildGifPass = function buildGifPass(pass, o) {
    if (pass === 1) {
      return {
        args: ['-ss', t(o.inS), '-to', t(o.outS), '-i', 'input.webm',
          '-vf', 'fps=12,scale=480:-1:flags=lanczos,palettegen', 'palette.png'],
        output: 'palette.png',
      };
    }
    return {
      args: ['-ss', t(o.inS), '-to', t(o.outS), '-i', 'input.webm', '-i', 'palette.png',
        '-lavfi', 'fps=12,scale=480:-1:flags=lanczos [x]; [x][1:v] paletteuse', 'output.gif'],
      output: 'output.gif',
    };
  };
})();

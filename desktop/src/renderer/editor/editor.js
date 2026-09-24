/**
 * @file CaptureDesk Editor UI: playback, trimming, annotation and local
 * export through the capturedesk-editor core modules.
 */
const $ = (id) => document.getElementById(id);

const video = $('video');
const annotCanvas = $('annot');
const stage = $('stage');
const playBtn = $('playBtn');
const timeLabel = $('timeLabel');
const track = $('track');
const selRange = $('selRange');
const cutLeft = $('cutLeft');
const cutRight = $('cutRight');
const hIn = $('hIn');
const hOut = $('hOut');
const playhead = $('playhead');
const burnToggle = $('burnToggle');
const annotHint = $('annotHint');

let filePath = null;
let fileBase = 'CaptureDesk';
let duration = 0;
let trim = { inS: 0, outS: 0 };
let engine = null;
let exporting = false;

/** Format seconds as m:ss.d. */
function fmtT(s) {
  if (!Number.isFinite(s)) return '00:00.0';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, '0')}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}

/**
 * Build a file:// URL that survives spaces, unicode and Windows drive letters.
 * @param {string} p Absolute path.
 * @returns {string} File URL.
 */
function fileUrl(p) {
  let u = String(p).replace(/\\/g, '/');
  if (!u.startsWith('/')) u = `/${u}`; // Windows drive path → /C:/…
  return `file://${u.split('/').map(encodeURIComponent).join('/')}`;
}

// ---- load ------------------------------------------------------------------

/**
 * Load a recording by absolute path (also used by editor:load events).
 * @param {string} file Absolute path.
 */
async function load(file) {
  filePath = file;
  fileBase = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  $('fileName').value = fileBase;
  video.src = fileUrl(file);
  await resolveDuration();
  trim = { inS: 0, outS: duration };
  updateTrimUI();
  updateProgressUI();
}

/**
 * Resolve the real duration of a MediaRecorder-produced WebM (its header
 * advertises Infinity until the demuxer reaches the last cluster).
 */
function resolveDuration() {
  return new Promise((resolve) => {
    const done = () => {
      duration = Number.isFinite(video.duration) ? video.duration : 0;
      resolve();
    };
    if (Number.isFinite(video.duration) && video.duration > 0) {
      done();
      return;
    }
    const seekToEnd = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        done();
        return;
      }
      const onSeeked = () => {
        video.removeEventListener('timeupdate', onSeeked);
        video.currentTime = 0;
        done();
      };
      video.addEventListener('timeupdate', onSeeked);
      video.currentTime = 1e6; // Force the demuxer through the final cluster.
    };
    if (video.readyState >= 1) seekToEnd();
    else video.addEventListener('loadedmetadata', seekToEnd, { once: true });
  });
}

window.capturedesk.on('editor:load', ({ file }) => load(file));

// ---- transport -------------------------------------------------------------

function togglePlay() {
  if (video.paused) video.play();
  else video.pause();
}

playBtn.addEventListener('click', togglePlay);
video.addEventListener('click', togglePlay);
video.addEventListener('play', () => {
  playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
});
video.addEventListener('pause', () => {
  playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  engine.render(video.currentTime);
});
video.addEventListener('timeupdate', () => {
  timeLabel.textContent = `${fmtT(video.currentTime)} / ${fmtT(duration)}`;
  playhead.style.left = `${(video.currentTime / Math.max(duration, 0.01)) * 100}%`;
  updateProgressUI();
});
video.addEventListener('error', () => {
  window.toast('CaptureDesk could not open this recording.', 'err');
});

$('backBtn').addEventListener('click', () => {
  video.pause();
  video.currentTime = Math.max(0, video.currentTime - 1 / 30);
});
$('fwdBtn').addEventListener('click', () => {
  video.pause();
  video.currentTime = Math.min(duration, video.currentTime + 1 / 30);
});
$('speed').addEventListener('change', (e) => {
  video.playbackRate = Number(e.target.value) || 1;
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  }
});

// ---- timeline / trim -------------------------------------------------------

/**
 * Convert a pointer event on the track to a fraction 0..1.
 * @param {MouseEvent} e Pointer event.
 * @returns {number}
 */
function frac(e) {
  const r = track.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
}

track.addEventListener('click', (e) => {
  video.currentTime = frac(e) * duration;
});

/**
 * Make a trim handle draggable.
 * @param {HTMLElement} el Handle element.
 * @param {'inS'|'outS'} key Which trim bound to move.
 */
function dragHandle(el, key) {
  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    const move = (ev) => {
      const f = frac(ev);
      const t = f * duration;
      if (key === 'inS') trim.inS = Math.min(t, trim.outS - 0.1);
      else trim.outS = Math.max(t, trim.inS + 0.1);
      updateTrimUI();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      updateProgressUI();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

dragHandle(hIn, 'inS');
dragHandle(hOut, 'outS');

/** Sync the trim UI from the trim state. */
function updateTrimUI() {
  const d = Math.max(duration, 0.01);
  const a = (trim.inS / d) * 100;
  const b = (trim.outS / d) * 100;
  selRange.style.left = `${a}%`;
  selRange.style.width = `${b - a}%`;
  cutLeft.style.width = `${a}%`;
  cutRight.style.left = `${b}%`;
  cutRight.style.width = `${100 - b}%`;
  hIn.style.left = `calc(${a}% - 5px)`;
  hOut.style.left = `calc(${b}% - 5px)`;
  $('trimIn').textContent = `${trim.inS.toFixed(2)}s`;
  $('trimOut').textContent = `${trim.outS.toFixed(2)}s`;
}

/** Keep the export summary fresh. */
function updateProgressUI() {
  const kept = Math.max(0, trim.outS - trim.inS);
  $('trimSummary').textContent = kept >= duration - 0.05
    ? 'Trim: full clip'
    : `Trim: keeping ${kept.toFixed(1)}s of ${duration.toFixed(1)}s`;
}

$('resetTrim').addEventListener('click', () => {
  trim = { inS: 0, outS: duration };
  updateTrimUI();
  updateProgressUI();
});

// ---- annotations -----------------------------------------------------------

engine = new CDEditor.AnnotationEngine(annotCanvas, video, () => {
  burnToggle.disabled = engine.strokes.length === 0;
  burnToggle.checked = engine.strokes.length > 0;
});
engine.onBlocked = () => {
  annotHint.textContent = 'Pause playback to draw annotations';
  setTimeout(() => {
    annotHint.textContent = 'Pause playback to draw annotations';
  }, 1200);
};

document.querySelectorAll('#tools .tool').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tools .tool').forEach((x) => x.classList.remove('active'));
    btn.classList.add('active');
    engine.tool = btn.dataset.tool;
    stage.classList.toggle('draw', engine.tool !== 'none');
  });
});
document.querySelectorAll('#aColors .swatch').forEach((sw) => {
  sw.addEventListener('click', () => {
    document.querySelectorAll('#aColors .swatch').forEach((x) => x.classList.remove('selected'));
    sw.classList.add('selected');
    engine.color = sw.dataset.color;
  });
});
$('aWidth').addEventListener('change', (e) => {
  engine.width = Number(e.target.value) || 4;
});
$('undoBtn').addEventListener('click', () => engine.undo());
$('clearBtn').addEventListener('click', () => engine.clear());

window.addEventListener('resize', () => engine.resize());

// ---- export ----------------------------------------------------------------

let format = 'webm';
document.querySelectorAll('#fmtList .fmt').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#fmtList .fmt').forEach((x) => x.classList.remove('selected'));
    btn.classList.add('selected');
    format = btn.dataset.fmt;
  });
});

/**
 * Set export progress UI state.
 * @param {number|null} ratio 0..1 (null hides the bar).
 * @param {string} [msg] Status line.
 */
function setProgress(ratio, msg) {
  const wrap = $('progressWrap');
  if (ratio === null) {
    wrap.classList.remove('on');
    $('progressMsg').textContent = msg || '';
    $('cancelExportBtn').style.display = 'none';
    return;
  }
  wrap.classList.add('on');
  $('progressBar').style.width = `${Math.round(ratio * 100)}%`;
  $('progressMsg').textContent = msg || '';
  $('cancelExportBtn').style.display = 'block';
}

$('exportBtn').addEventListener('click', async () => {
  if (exporting || !filePath) return;
  if (duration <= 0) {
    window.toast('Nothing to export yet.', 'err');
    return;
  }
  exporting = true;
  $('exportBtn').disabled = true;
  setProgress(0, 'Starting export engine…');
  try {
    const res = await CDEditor.runExport({
      file: filePath,
      base: `${fileBase}_export`,
      format,
      trim: { inS: trim.inS, outS: trim.outS },
      strokes: engine.strokes,
      burn: burnToggle.checked && burnToggle.disabled === false,
      getPNG: async (i) => engine.exportPNG(i),
      onProgress: (r, m) => setProgress(r, m),
    });
    window.toast(`Exported to CaptureDesk Recordings — ${res.file.split(/[\\/]/).pop()}`, 'ok', 5000);
    if (res.fallbackNote) window.toast(res.fallbackNote, 'err', 6000);
    setProgress(null, `Saved: ${res.file}`);
  } catch (err) {
    if (String(err.message) === 'cancelled') {
      window.toast('Export cancelled.', 'err');
      setProgress(null, 'Export cancelled.');
    } else {
      window.toast(`Export failed: ${err.message}`, 'err', 6000);
      setProgress(null, '');
    }
  } finally {
    exporting = false;
    $('exportBtn').disabled = false;
    window.capturedesk.listLibrary();
  }
});

$('cancelExportBtn').addEventListener('click', () => CDEditor.cancelExport());

// ---- snapshot --------------------------------------------------------------

$('snapshotBtn').addEventListener('click', async () => {
  if (!filePath) return;
  try {
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 1280;
    c.height = video.videoHeight || 720;
    const ctx = c.getContext('2d');
    ctx.drawImage(video, 0, 0, c.width, c.height);
    if (engine.strokes.length) {
      const blob = await engine.exportPNG('all');
      const img = new Image();
      const url = URL.createObjectURL(blob);
      await new Promise((r) => {
        img.onload = r;
        img.src = url;
      });
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
    }
    const blob = await new Promise((r) => c.toBlob((b) => r(b), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const res = await window.capturedesk.uniqueExportPath(`${fileBase}_snapshot`, '.png');
    await window.capturedesk.writeFile(res.path, bytes.buffer);
    window.toast(`Snapshot saved: ${res.path.split(/[\\/]/).pop()}`, 'ok');
  } catch (err) {
    window.toast(`Snapshot failed: ${err.message}`, 'err');
  }
});

// ---- header ----------------------------------------------------------------

$('closeBtn').addEventListener('click', () => window.close());
$('fileName').addEventListener('change', (e) => {
  // Renaming here renames the underlying recording too.
  if (filePath) {
    window.capturedesk.renameRecording(filePath, e.target.value).then((res) => {
      if (res.ok) {
        filePath = res.file;
        fileBase = res.file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
        window.toast('Recording renamed.', 'ok');
      } else if (res.error) {
        window.toast(res.error, 'err');
      }
    });
  }
});

// ---- engine availability note ---------------------------------------------

CDEditor.loadFFmpeg().then(() => {
  console.info('[CaptureDesk] export engine ready');
  $('engineNote').textContent = 'Export engine ready — everything runs locally.';
}).catch((err) => {
  console.warn('[CaptureDesk] export engine unavailable:', err.message);
  $('engineNote').textContent = 'Export engine unavailable — PNG snapshots still work. Re-encode formats are disabled.';
  document.querySelectorAll('#fmtList .fmt').forEach((b) => {
    if (b.dataset.fmt !== 'webm') b.style.opacity = '0.4';
  });
});

// ---- export-pipeline self test (CI: electron . --editor-smoke --export-smoke)

window.capturedesk.on('editor:smoke', async () => {
  try {
    console.info('[CaptureDesk] smoke: self test starting');
    const ffmpeg = await CDEditor.loadFFmpeg();
    console.info('[CaptureDesk] smoke: engine loaded');
    // 1x1 red PNG — validates writeFile → demux → decode → encode → readFile
    // without the cost of a wasm video encode on CI hardware.
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0));
    await ffmpeg.writeFile('in.png', bytes);
    await ffmpeg.exec(['-i', 'in.png', 'out.bmp']);
    const out = await ffmpeg.readFile('out.bmp');
    console.info(`[CaptureDesk] smoke: transcode output bytes = ${out.length}`);
    if (out.length < 58) throw new Error('BMP output suspiciously small');
    // Encoder matrix probe (non-fatal): informs format availability notes.
    const probe = async (name, args, minBytes) => {
      try {
        await ffmpeg.exec(args);
        const bytes = (await ffmpeg.readFile(args[args.length - 1])).length;
        console.info(`[CaptureDesk] smoke: encoder ${name} = ${bytes} bytes`);
        await ffmpeg.deleteFile(args[args.length - 1]).catch(() => {});
        return bytes >= minBytes;
      } catch (err) {
        console.warn(`[CaptureDesk] smoke: encoder ${name} unavailable: ${err.message}`);
        return false;
      }
    };
    const vp8ok = await probe('vp8', ['-loop', '1', '-i', 'in.png', '-t', '0.2', '-c:v', 'libvpx', '-an', 'p.webm'], 1000);
    const mp4ok = await probe('mpeg4', ['-loop', '1', '-i', 'in.png', '-t', '0.2', '-c:v', 'mpeg4', '-an', 'p.mp4'], 500);
    const gifok = await probe('gif', ['-loop', '1', '-i', 'in.png', '-t', '0.2', 'p.gif'], 100);
    console.info(`[CaptureDesk] smoke: encoders vp8=${vp8ok} mpeg4=${mp4ok} gif=${gifok}`);
    if (!mp4ok || !gifok) throw new Error('required encoders missing');
    console.info('[CaptureDesk] smoke: EXPORT PIPELINE OK');
  } catch (err) {
    console.warn(`[CaptureDesk] smoke: EXPORT PIPELINE FAILED: ${err.message}`);
  }
});

// ---- boot ------------------------------------------------------------------

const hashFile = decodeURIComponent(location.hash.replace(/^#/, ''));
if (hashFile) load(hashFile);

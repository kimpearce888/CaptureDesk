/**
 * @file CaptureDesk offscreen recorder.
 *
 * Single hidden extension page that owns the capture streams, the canvas
 * compositor (setInterval draw loop — never requestAnimationFrame, which
 * offscreen pages throttle), the WebAudio mix, the MediaRecorder pipeline and
 * the save handshake with the service worker.
 */
import {
  buildFileName,
  FRAME_SIZES,
  OVERLAY_COLORS,
  VIDEO_BITRATES,
} from '../common/defaults.js';
import { MSG } from '../common/messages.js';

const MAX_BLOB_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB guard for the save path.
const NATIVE_CHUNK_BYTES = 1024 * 1024; // 1 MiB base64 chunks for the native host.
const RIPPLE_MS = 450; // Ripple lifetime, matches the content overlay.
const STATE_TICK_MS = 500; // REC_STATE heartbeat.
const COUNTDOWN_OVERLAY = 'rgba(11, 17, 32, 0.45)';
const COUNTDOWN_COLOR = '#F1F5F9';

const canvas = document.getElementById('stage');
const g2d = canvas.getContext('2d', { alpha: false });

let rec = null; // Active recording session object, or null when idle.

/**
 * Map a low-level getUserMedia error to an actionable message.
 * @param {*} err Error thrown by getUserMedia.
 * @returns {string} Human-readable, actionable message.
 */
function friendlyMediaError(err) {
  const name = err && err.name ? err.name : '';
  if (name === 'NotAllowedError') {
    return 'Capture permission was denied. Allow access and start again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'The selected capture source is no longer available. Pick a source and start again.';
  }
  return 'CaptureDesk could not access the capture source. Try starting again.';
}

/**
 * Create a hidden <video> element bound to a stream.
 * @param {MediaStream} stream Stream to display.
 * @returns {HTMLVideoElement} Playing, muted, hidden video element.
 */
function createVideo(stream) {
  const el = document.createElement('video');
  el.srcObject = stream;
  el.muted = true;
  el.playsInline = true;
  el.style.display = 'none';
  document.body.appendChild(el);
  const p = el.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return el;
}

/**
 * Stop every track of a stream (safely).
 * @param {MediaStream|null} stream Stream to stop.
 * @returns {void}
 */
function stopTracks(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch (_) {
      // Track already stopped.
    }
  }
}

/**
 * Video constraint for the mandatory chromeMediaSource syntax used by
 * tabCapture / desktopCapture streamIds inside the offscreen document.
 * @param {string} mode 'tab' | 'window' | 'screen'.
 * @param {string} streamId Stream id resolved by the service worker.
 * @returns {object} Video constraint object.
 */
function videoConstraintFor(mode, streamId) {
  const source = mode === 'tab' ? 'tab' : 'desktop';
  return {
    mandatory: {
      chromeMediaSource: source,
      chromeMediaSourceId: streamId,
    },
  };
}

/**
 * Pick the best supported WebM recording mime type (VP9 → VP8 → generic).
 * @returns {string} A mimeType accepted by MediaRecorder.
 */
function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  if (typeof MediaRecorder.isTypeSupported === 'function') {
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
  }
  return 'video/webm';
}

/**
 * Listen for the capture stream ending (user pressed Chrome's native
 * "Stop sharing", or the recorded tab closed) to auto-save.
 * @param {MediaStreamTrack[]} tracks Video tracks to watch.
 * @returns {void}
 */
function attachEnded(tracks) {
  for (const track of tracks) {
    track.addEventListener('ended', onSourceEnded);
  }
}

/**
 * Auto-stop handler: finalize & save exactly like REC_STOP.
 * @returns {void}
 */
function onSourceEnded() {
  if (!rec || rec.finishing) return;
  if (rec.state === 'recording' || rec.state === 'paused') {
    finalizeAndSave();
  } else if (rec.state === 'countdown') {
    clearCountdown();
    void teardownAndIdle();
  }
}

/**
 * Elapsed recording time in ms, excluding paused intervals.
 * @returns {number} Elapsed milliseconds.
 */
function currentElapsed() {
  if (!rec) return 0;
  if (rec.state === 'recording') {
    return rec.accMs + Math.max(0, performance.now() - rec.startedAt);
  }
  return rec.accMs;
}

/**
 * Broadcast a REC_STATE heartbeat to the service worker (and popup).
 * @param {object} [extra] Extra fields (e.g. {error}) merged into the payload.
 * @returns {void}
 */
function reportState(extra = {}) {
  if (!rec) return;
  const payload = { state: rec.state, elapsedMs: Math.round(currentElapsed()) };
  if (rec.state === 'countdown') {
    payload.remainingMs = Math.max(0, Math.round(rec.countdownEndsAt - performance.now()));
  }
  if (rec.note) payload.note = rec.note;
  if (extra.error) payload.error = extra.error;
  chrome.runtime.sendMessage({ type: MSG.REC_STATE, payload }).catch(() => {});
}

/** Periodic REC_STATE heartbeat while a session is active. */
function tick() {
  if (!rec) return;
  if (['recording', 'paused', 'stopping', 'countdown'].includes(rec.state)) {
    reportState();
  }
}

/**
 * Handle REC_SETUP: acquire all streams, build the compositor + recorder.
 * @param {object} payload {mode, tabId?, streamId, audioMode, options, native}.
 * @returns {Promise<object>} {ok, note?} or {ok:false, error}.
 */
async function handleSetup(payload) {
  if (rec) await teardown();
  const opts = payload.options || {};
  const frame = FRAME_SIZES[opts.quality] || FRAME_SIZES['720p'];
  canvas.width = frame.width;
  canvas.height = frame.height;
  g2d.fillStyle = '#000000';
  g2d.fillRect(0, 0, canvas.width, canvas.height);

  rec = {
    mode: payload.mode,
    tabId: payload.tabId || null,
    streamId: payload.streamId || null,
    audioMode: payload.audioMode || 'none',
    options: opts,
    overlay: opts.overlay || null,
    native: Boolean(payload.native),
    state: 'preparing',
    startedAt: 0,
    accMs: 0,
    chunks: [],
    recorder: null,
    mimeType: 'video/webm',
    mainStream: null,
    mainVideo: null,
    mixedStream: null,
    micStream: null,
    systemStream: null,
    camStream: null,
    camVideo: null,
    audioCtx: null,
    mixDest: null,
    drawTimer: 0,
    tickTimer: 0,
    countdownTimer: 0,
    countdownEndsAt: 0,
    cursor: null,
    ripples: [],
    viewport: null,
    note: null,
    finishing: false,
    discard: false,
    savedBlob: null,
    fileName: '',
    pendingBlobUrl: null,
  };
  reportState();

  try {
    await acquireStreams();
    buildPipeline();
  } catch (err) {
    const error = friendlyMediaError(err);
    await teardown();
    rec = null;
    return { ok: false, error };
  }
  return { ok: true, note: rec.note };
}

/**
 * Acquire the main capture stream plus optional mic, system audio and camera.
 * @returns {Promise<void>}
 */
async function acquireStreams() {
  const audio = rec.mode === 'tab'
    ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: rec.streamId } }
    : false;
  rec.mainStream = await navigator.mediaDevices.getUserMedia({
    audio,
    video: videoConstraintFor(rec.mode, rec.streamId),
  });
  attachEnded(rec.mainStream.getVideoTracks());

  if (rec.audioMode.includes('mic')) {
    try {
      rec.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (_) {
      rec.note = 'mic-unavailable'; // Graceful fallback: keep recording video-only.
    }
  }
  if (rec.audioMode.includes('system') && rec.streamId) {
    try {
      rec.systemStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: rec.streamId,
          },
        },
      });
    } catch (_) {
      // User did not tick "share audio" — recording without system audio.
    }
  }
  if (rec.options.cam) {
    try {
      rec.camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
    } catch (_) {
      rec.note = rec.note || 'cam-unavailable';
    }
  }
}

/**
 * Build the compositor pipeline: videos, canvas draw loop, WebAudio mix and
 * the MediaRecorder instance.
 * @returns {void}
 */
function buildPipeline() {
  rec.mainVideo = createVideo(rec.mainStream);
  if (rec.camStream) rec.camVideo = createVideo(rec.camStream);

  const fps = Number(rec.options.fps) || 30;
  const canvasStream = canvas.captureStream(fps);
  const tracks = [...canvasStream.getVideoTracks()];

  const audioStreams = [];
  if (rec.mode === 'tab') audioStreams.push(rec.mainStream); // Tab audio rides along.
  if (rec.systemStream) audioStreams.push(rec.systemStream);
  if (rec.micStream) audioStreams.push(rec.micStream);
  const withAudio = audioStreams.filter(
    (stream) => stream && stream.getAudioTracks().length > 0,
  );
  if (withAudio.length > 0) {
    rec.audioCtx = new AudioContext();
    try {
      if (rec.audioCtx.state === 'suspended') rec.audioCtx.resume();
    } catch (_) {
      // Mixing still works in most suspended states; ignore.
    }
    rec.mixDest = rec.audioCtx.createMediaStreamDestination();
    for (const stream of withAudio) {
      rec.audioCtx.createMediaStreamSource(stream).connect(rec.mixDest);
    }
    tracks.push(...rec.mixDest.stream.getAudioTracks());
  }

  rec.mixedStream = new MediaStream(tracks);
  rec.mimeType = pickMimeType();
  rec.recorder = new MediaRecorder(rec.mixedStream, {
    mimeType: rec.mimeType,
    videoBitsPerSecond: VIDEO_BITRATES[rec.options.quality] || VIDEO_BITRATES['720p'],
    audioBitsPerSecond: 128000,
  });
  rec.recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) rec.chunks.push(event.data);
  };
  rec.recorder.onerror = (event) => {
    const name = event && event.error && event.error.name ? event.error.name : 'unknown error';
    void teardownAndIdle(`Recording failed (${name}).`);
  };

  rec.drawTimer = setInterval(draw, Math.max(8, Math.round(1000 / fps)));
  rec.tickTimer = setInterval(tick, STATE_TICK_MS);
  draw();
}

/**
 * Handle REC_START: run the countdown (if any), then begin recording.
 * @param {object} payload {countdown}.
 * @returns {object} {ok} or {ok:false, error}.
 */
function handleStart(payload) {
  if (!rec) return { ok: false, error: 'No recorder session.' };
  if (rec.state !== 'preparing') return { ok: false, error: 'Recorder already started.' };
  const countdown = Math.max(0, Number(payload && payload.countdown) || 0);
  if (countdown > 0) {
    rec.state = 'countdown';
    rec.countdownEndsAt = performance.now() + countdown * 1000;
    reportState();
    rec.countdownTimer = setTimeout(() => {
      if (!rec || rec.state !== 'countdown') return;
      rec.countdownEndsAt = 0;
      beginRecording();
    }, countdown * 1000);
  } else {
    beginRecording();
  }
  return { ok: true };
}

/** Start the MediaRecorder and the elapsed timer (excludes paused time). */
function beginRecording() {
  if (!rec || rec.finishing) return;
  rec.recorder.start(); // No timeslice: chunks are collected on dataavailable.
  rec.state = 'recording';
  rec.startedAt = performance.now();
  rec.accMs = 0;
  reportState();
}

/**
 * Handle REC_PAUSE.
 * @returns {object} {ok} or {ok:false, error}.
 */
function handlePause() {
  if (!rec || rec.state !== 'recording' || rec.recorder.state !== 'recording') {
    return { ok: false, error: 'Not recording.' };
  }
  rec.accMs += performance.now() - rec.startedAt;
  rec.recorder.pause();
  rec.state = 'paused';
  reportState();
  return { ok: true };
}

/**
 * Handle REC_RESUME.
 * @returns {object} {ok} or {ok:false, error}.
 */
function handleResume() {
  if (!rec || rec.state !== 'paused' || rec.recorder.state !== 'paused') {
    return { ok: false, error: 'Not paused.' };
  }
  rec.recorder.resume();
  rec.state = 'recording';
  rec.startedAt = performance.now();
  reportState();
  return { ok: true };
}

/**
 * Handle REC_STOP: finalize & save (a pending countdown is simply discarded).
 * @returns {Promise<object>} {ok}.
 */
async function handleStop() {
  if (!rec) return { ok: true };
  if (rec.state === 'countdown') {
    clearCountdown();
    await teardownAndIdle();
    return { ok: true };
  }
  if (rec.state === 'recording' || rec.state === 'paused') {
    finalizeAndSave();
    return { ok: true };
  }
  if (rec.state === 'stopping') return { ok: true };
  return { ok: false, error: 'Nothing to stop.' };
}

/**
 * Handle REC_CANCEL: stop everything and discard without saving.
 * @returns {object} {ok}.
 */
function handleCancel() {
  if (!rec) return { ok: true };
  clearCountdown();
  rec.discard = true;
  rec.finishing = true;
  rec.state = 'stopping';
  if (rec.recorder && rec.recorder.state !== 'inactive') {
    rec.recorder.onstop = () => void teardownAndIdle();
    try {
      rec.recorder.stop();
    } catch (_) {
      void teardownAndIdle();
    }
  } else {
    void teardownAndIdle();
  }
  return { ok: true };
}

/** Clear a pending countdown timer, if any. */
function clearCountdown() {
  if (!rec) return;
  if (rec.countdownTimer) {
    clearTimeout(rec.countdownTimer);
    rec.countdownTimer = 0;
  }
  rec.countdownEndsAt = 0;
}

/**
 * Stop the recorder, then hand the collected chunks to the save flow
 * (exactly the same path used by the auto-save on track ended).
 * @returns {void}
 */
function finalizeAndSave() {
  if (!rec || rec.finishing) return;
  rec.finishing = true;
  if (rec.state === 'recording') {
    rec.accMs += Math.max(0, performance.now() - rec.startedAt);
  }
  rec.state = 'stopping';
  reportState();

  const done = () => {
    if (!rec) return;
    clearInterval(rec.drawTimer);
    clearInterval(rec.tickTimer);
    rec.drawTimer = 0;
    rec.tickTimer = 0;
    if (rec.discard) {
      void teardownAndIdle();
      return;
    }
    saveRecording();
  };

  if (rec.recorder && rec.recorder.state !== 'inactive') {
    rec.recorder.onstop = done;
    try {
      rec.recorder.stop();
    } catch (_) {
      done();
    }
  } else {
    done();
  }
}

/**
 * Build the blob, enforce the 2 GiB guard and hand off to the native or
 * downloads save path. The offscreen page keeps the blob (and the blob URL)
 * alive until the service worker confirms with SAVED_ACK.
 * @returns {void}
 */
function saveRecording() {
  if (!rec) return;
  const blob = new Blob(rec.chunks, { type: 'video/webm' });
  rec.chunks = [];
  const fileName = buildFileName(rec.options.filenameTemplate, new Date(), '.webm');
  if (blob.size > MAX_BLOB_BYTES) {
    void teardownAndIdle('This recording is larger than 2 GB and was not saved.');
    return;
  }
  rec.savedBlob = blob;
  rec.fileName = fileName;
  if (rec.native) {
    reportSaved({ via: 'native', fileName, size: blob.size });
  } else {
    rec.pendingBlobUrl = URL.createObjectURL(blob);
    reportSaved({
      via: 'downloads',
      fileName,
      size: blob.size,
      blobUrl: rec.pendingBlobUrl,
    });
  }
}

/**
 * Handle SAVED_ACK from the service worker.
 * - {ok, relay:true}: start streaming base64 chunks to the native host.
 * - {ok:false, fallback:true}: native host died — switch to the blob URL path.
 * - {ok:false, error}: downloads save failed — surface the error.
 * - {ok:true}: downloads save started — revoke the URL and reset to idle.
 * @param {object} payload Ack payload from the service worker.
 * @returns {Promise<object>} {ok}.
 */
async function handleSavedAck(payload = {}) {
  if (!rec) return { ok: true };
  if (payload.ok && payload.relay) {
    void streamNativeChunks();
    return { ok: true };
  }
  if (!payload.ok && payload.fallback) {
    rec.native = false;
    rec.pendingBlobUrl = URL.createObjectURL(rec.savedBlob);
    reportSaved({
      via: 'downloads',
      fileName: rec.fileName,
      size: rec.savedBlob.size,
      blobUrl: rec.pendingBlobUrl,
    });
    return { ok: true };
  }
  if (rec.pendingBlobUrl) {
    try {
      URL.revokeObjectURL(rec.pendingBlobUrl);
    } catch (_) {
      // URL already revoked.
    }
    rec.pendingBlobUrl = null;
  }
  const error = payload.ok ? null : `Save failed: ${payload.error || 'unknown error'}.`;
  await teardownAndIdle(error);
  return { ok: true };
}

/**
 * Stream the recorded blob to the service worker (native host relay) in 1 MiB
 * base64 chunks. If the relay rejects a chunk, fall back to the downloads path.
 * @returns {Promise<void>}
 */
async function streamNativeChunks() {
  if (!rec || !rec.savedBlob) return;
  const blob = rec.savedBlob;
  const total = Math.max(1, Math.ceil(blob.size / NATIVE_CHUNK_BYTES));
  try {
    for (let i = 0; i < total; i += 1) {
      const slice = blob.slice(
        i * NATIVE_CHUNK_BYTES,
        Math.min(blob.size, (i + 1) * NATIVE_CHUNK_BYTES),
      );
      const data = await blobToBase64(slice);
      const res = await chrome.runtime.sendMessage({
        type: MSG.NATIVE_CHUNK,
        payload: { fileName: rec.fileName, seq: i, data, last: i === total - 1 },
      });
      if (!res || !res.ok) throw new Error('relay rejected the chunk');
      if (res.done) {
        await teardownAndIdle();
        return;
      }
    }
  } catch (_) {
    if (!rec) return; // Session already reset.
    rec.native = false;
    rec.pendingBlobUrl = URL.createObjectURL(rec.savedBlob);
    reportSaved({
      via: 'downloads',
      fileName: rec.fileName,
      size: rec.savedBlob.size,
      blobUrl: rec.pendingBlobUrl,
    });
  }
}

/**
 * Read a blob slice as a base64 string.
 * @param {Blob} blob Blob slice to encode.
 * @returns {Promise<string>} Base64 payload without the data-url prefix.
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.onload = () => {
      const s = String(reader.result || '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Reset the offscreen page to idle: stop the recorder and every track, close
 * the AudioContext, drop the videos, report REC_STATE idle.
 * @param {string|null} [error] Optional error to surface with the idle state.
 * @returns {Promise<void>}
 */
async function teardownAndIdle(error = null) {
  await teardown();
  rec = null;
  const payload = { state: 'idle', elapsedMs: 0 };
  if (error) payload.error = error;
  chrome.runtime.sendMessage({ type: MSG.REC_STATE, payload }).catch(() => {});
}

/**
 * Release every resource owned by the session (no state broadcast).
 * @returns {Promise<void>}
 */
async function teardown() {
  if (!rec) return;
  clearCountdown();
  clearInterval(rec.drawTimer);
  clearInterval(rec.tickTimer);
  rec.drawTimer = 0;
  rec.tickTimer = 0;
  try {
    if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
  } catch (_) {
    // Recorder already inactive.
  }
  stopTracks(rec.mainStream);
  stopTracks(rec.micStream);
  stopTracks(rec.systemStream);
  stopTracks(rec.camStream);
  rec.mainStream = null;
  rec.micStream = null;
  rec.systemStream = null;
  rec.camStream = null;
  if (rec.audioCtx) {
    try {
      await rec.audioCtx.close();
    } catch (_) {
      // Context already closed.
    }
    rec.audioCtx = null;
  }
  if (rec.mainVideo) {
    rec.mainVideo.srcObject = null;
    rec.mainVideo.remove();
    rec.mainVideo = null;
  }
  if (rec.camVideo) {
    rec.camVideo.srcObject = null;
    rec.camVideo.remove();
    rec.camVideo = null;
  }
  if (rec.pendingBlobUrl) {
    try {
      URL.revokeObjectURL(rec.pendingBlobUrl);
    } catch (_) {
      // URL already revoked.
    }
    rec.pendingBlobUrl = null;
  }
  rec.savedBlob = null;
}

/**
 * Fire REC_SAVED at the service worker (fire-and-forget; the SAVED_ACK
 * message comes back separately).
 * @param {object} payload {via, fileName, size, blobUrl?}.
 * @returns {void}
 */
function reportSaved(payload) {
  chrome.runtime.sendMessage({ type: MSG.REC_SAVED, payload }).catch(() => {});
}

/**
 * Handle forwarded overlay input: track the viewport + cursor and spawn
 * canvas ripples on clicks.
 * @param {object} payload {type:'cursor'|'down', x, y, vw, vh, dpr}.
 * @returns {object} {ok}.
 */
function handleInput(payload = {}) {
  if (!rec || !rec.overlay || !payload || typeof payload.x !== 'number') {
    return { ok: true };
  }
  rec.viewport = {
    w: payload.vw || 0,
    h: payload.vh || 0,
    dpr: payload.dpr || 1,
  };
  if (payload.type === 'cursor' && rec.overlay.cursor) {
    rec.cursor = { x: payload.x, y: payload.y };
  }
  if (payload.type === 'down' && rec.overlay.clicks) {
    rec.ripples.push({ x: payload.x, y: payload.y, t0: performance.now() });
  }
  return { ok: true };
}

/** Compositor frame: source (cover-fit), camera PiP, effects, countdown. */
function draw() {
  if (!rec) return;
  const w = canvas.width;
  const h = canvas.height;
  g2d.fillStyle = '#000000';
  g2d.fillRect(0, 0, w, h);
  const video = rec.mainVideo;
  if (video && video.readyState >= 2 && video.videoWidth > 0) {
    drawCover(video, w, h);
    if (rec.camVideo && rec.camVideo.readyState >= 2 && rec.camVideo.videoWidth > 0) {
      drawCameraBubble(w, h);
    }
    drawCanvasEffects(video);
  }
  if (rec.state === 'countdown') drawCountdown(w, h);
}

/**
 * Draw a video into the canvas with a cover fit (fills the canvas, crops
 * the overflow, keeps the aspect ratio).
 * @param {HTMLVideoElement} video Source video.
 * @param {number} w Canvas width.
 * @param {number} h Canvas height.
 * @returns {void}
 */
function drawCover(video, w, h) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const k = Math.max(w / vw, h / vh);
  const dw = vw * k;
  const dh = vh * k;
  g2d.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * Draw the camera bubble: 22% of canvas height, bottom-right with 24px
 * margin, rounded corners, 3px white ring, soft shadow, mirrored (selfie).
 * @param {number} w Canvas width.
 * @param {number} h Canvas height.
 * @returns {void}
 */
function drawCameraBubble(w, h) {
  const cam = rec.camVideo;
  const ph = Math.round(h * 0.22);
  const ratio = cam.videoWidth > 0 && cam.videoHeight > 0
    ? cam.videoWidth / cam.videoHeight
    : 4 / 3;
  let pw = Math.round(ph * ratio);
  pw = Math.min(pw, w - 48);
  const margin = 24;
  const x = w - pw - margin;
  const y = h - ph - margin;
  const r = 12;

  g2d.save();
  g2d.shadowColor = 'rgba(2, 12, 27, 0.45)';
  g2d.shadowBlur = 18;
  g2d.shadowOffsetY = 6;
  g2d.beginPath();
  roundRectPath(g2d, x - 3, y - 3, pw + 6, ph + 6, r + 3);
  g2d.fillStyle = '#FFFFFF';
  g2d.fill();
  g2d.restore();

  g2d.save();
  g2d.beginPath();
  roundRectPath(g2d, x, y, pw, ph, r);
  g2d.clip();
  g2d.translate(x + pw, y);
  g2d.scale(-1, 1); // Mirror horizontally — selfie view.
  g2d.drawImage(cam, 0, 0, pw, ph);
  g2d.restore();
}

/**
 * Trace a rounded-rectangle path (compatible with every canvas context).
 * @param {CanvasRenderingContext2D} ctx Target context.
 * @param {number} x Left.
 * @param {number} y Top.
 * @param {number} w Width.
 * @param {number} h Height.
 * @param {number} r Corner radius.
 * @returns {void}
 */
function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
}

/**
 * Draw the cursor ring and click ripples onto the canvas, mapping viewport
 * coordinates through the captured frame size and the cover-fit transform.
 * @param {HTMLVideoElement} video Source video (for frame dimensions).
 * @returns {void}
 */
function drawCanvasEffects(video) {
  if (!rec.overlay || (!rec.cursor && rec.ripples.length === 0)) return;
  if (!rec.viewport || !rec.viewport.w || !video.videoWidth) return;
  const w = canvas.width;
  const h = canvas.height;
  const fw = video.videoWidth;
  const fh = video.videoHeight;
  const k = Math.max(w / fw, h / fh);
  const ox = (w - fw * k) / 2;
  const oy = (h - fh * k) / 2;
  const dpr = rec.viewport.dpr || 1;
  const map = (x, y) => ({ x: ox + x * dpr * k, y: oy + y * dpr * k });
  const now = performance.now();

  if (rec.overlay.clicks && rec.ripples.length > 0) {
    rec.ripples = rec.ripples.filter((ripple) => now - ripple.t0 < RIPPLE_MS);
    for (const ripple of rec.ripples) {
      const p = map(ripple.x, ripple.y);
      const t = (now - ripple.t0) / RIPPLE_MS;
      const radius = 8 + (rec.overlay.rippleSize - 8) * t;
      g2d.beginPath();
      g2d.arc(p.x, p.y, radius, 0, Math.PI * 2);
      g2d.fillStyle = rgbaFor(rec.overlay.rippleColor, 0.35 * (1 - t));
      g2d.fill();
      g2d.lineWidth = 2;
      g2d.strokeStyle = rgbaFor(rec.overlay.rippleColor, 0.9 * (1 - t));
      g2d.stroke();
    }
  }

  if (rec.overlay.cursor && rec.cursor) {
    const p = map(rec.cursor.x, rec.cursor.y);
    g2d.beginPath();
    g2d.arc(p.x, p.y, rec.overlay.cursorSize / 2, 0, Math.PI * 2);
    g2d.lineWidth = 2.5;
    g2d.strokeStyle = rgbaFor(rec.overlay.cursorColor, 0.9);
    g2d.stroke();
  }
}

/**
 * Build an rgba() color string from an overlay color name.
 * @param {string} name 'teal' | 'amber' | 'white'.
 * @param {number} alpha Alpha channel value.
 * @returns {string} CSS color string.
 */
function rgbaFor(name, alpha) {
  const color = OVERLAY_COLORS[name] || OVERLAY_COLORS.teal;
  return `rgba(${color.rgb},${alpha})`;
}

/**
 * Draw the countdown number over a dimmed frame.
 * @param {number} w Canvas width.
 * @param {number} h Canvas height.
 * @returns {void}
 */
function drawCountdown(w, h) {
  if (!rec.countdownEndsAt) return;
  const remainSec = Math.max(0, Math.ceil((rec.countdownEndsAt - performance.now()) / 1000));
  g2d.fillStyle = COUNTDOWN_OVERLAY;
  g2d.fillRect(0, 0, w, h);
  g2d.fillStyle = COUNTDOWN_COLOR;
  g2d.font = `700 ${Math.round(h * 0.28)}px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`;
  g2d.textAlign = 'center';
  g2d.textBaseline = 'middle';
  g2d.fillText(String(remainSec), w / 2, h / 2);
}

// Message types answered by this page; broadcasts (REC_STATE, REC_SAVED,
// INPUT, REC_*) arriving from the worker are ignored to avoid echo loops.
const RESPOND_TYPES = new Set([
  MSG.REC_SETUP,
  MSG.REC_START,
  MSG.REC_PAUSE,
  MSG.REC_RESUME,
  MSG.REC_STOP,
  MSG.REC_CANCEL,
  MSG.SAVED_ACK,
]);

/**
 * Offscreen message handler.
 * @param {object} msg {type, payload}.
 * @returns {Promise<object>} Ack object.
 */
async function handleOffscreenMessage(msg) {
  const p = msg.payload || {};
  switch (msg.type) {
    case MSG.REC_SETUP:
      return handleSetup(p);
    case MSG.REC_START:
      return handleStart(p);
    case MSG.REC_PAUSE:
      return handlePause();
    case MSG.REC_RESUME:
      return handleResume();
    case MSG.REC_STOP:
      return handleStop();
    case MSG.REC_CANCEL:
      return handleCancel();
    case MSG.SAVED_ACK:
      return handleSavedAck(p);
    default:
      return { ok: false, error: 'Unsupported message.' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !RESPOND_TYPES.has(msg.type)) return false;
  handleOffscreenMessage(msg)
    .then(sendResponse)
    .catch((err) => {
      try {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      } catch (_) {
        // Sender gone — nothing to do.
      }
    });
  return true;
});

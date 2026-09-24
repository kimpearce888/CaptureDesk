/**
 * @file CaptureDesk hidden recorder window (renderer). Owns the capture
 * streams, the canvas compositor (setInterval loop — hidden windows throttle
 * requestAnimationFrame), the WebAudio mix, the MediaRecorder pipeline and
 * the save handshake with the main process.
 *
 * Coordinate mapping (documented once, used everywhere):
 *   - Capture streams are PHYSICAL pixels of the captured display.
 *   - Region rects and cursor positions arrive as DIP coordinates relative
 *     to the display origin; multiply by display.scaleFactor to get pixels.
 *   - The canvas is sized to fit the captured area (full frame or region)
 *     into the quality box while preserving aspect, so the mapping from
 *     source pixels to canvas pixels is a single uniform scale.
 */
const canvas = document.getElementById('stage');
const g2d = canvas.getContext('2d', { alpha: false });

const RIPPLE_MS = 450; // Ripple lifetime on the composited canvas.

let session = null; // Active setup payload, or null when idle.
let screenStream = null;
let micStream = null;
let systemStream = null;
let camStream = null;
let screenVideo = null;
let camVideo = null;
let audioCtx = null;
let recorder = null;
let chunks = [];

let drawTimer = null;
let stateTimer = null;
let countdownTimer = null;

let recording = false;
let paused = false;
let startedAt = 0; // performance.now() when recording actually started.
let pausedTotal = 0;
let pausedAt = 0;

let elapsedMs = 0;
let remainingMs = 0;

const cursor = { x: 0, y: 0, fresh: false }; // Last DIP cursor position.
const ripples = []; // {x, y, at} in canvas coordinates.

/**
 * Post a session-state snapshot to the main process (which broadcasts it).
 * @param {object} extra Extra fields to merge.
 */
function sendState(extra = {}) {
  window.capturedesk.saveState({
    state: extra.state || (recording ? (paused ? 'paused' : 'recording') : 'preparing'),
    elapsedMs,
    remainingMs: remainingMs > 0 ? remainingMs : null,
    ...extra,
  });
}

/**
 * Stop every track of a stream (safely).
 * @param {MediaStream|null} stream Stream to stop.
 */
function stopTracks(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch (_) {
      // Already stopped.
    }
  }
}

/**
 * Build a hidden <video> bound to a stream.
 * @param {MediaStream} stream Source stream.
 * @returns {HTMLVideoElement} Playing muted video.
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
 * Pick the best supported WebM mime type (VP9 → VP8 → generic).
 * @returns {string}
 */
function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'video/webm';
}

/**
 * Acquire every requested stream for the session.
 * @param {object} setup Session setup payload from the main process.
 * @returns {Promise<{note: string|null}>} Warning note, if any.
 */
async function acquireStreams(setup) {
  const o = setup.options;
  let note = null;

  // 1) Screen / window video.
  screenStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: setup.sourceId,
        maxFrameRate: o.fps,
      },
    },
  });
  screenVideo = createVideo(screenStream);
  await waitForVideo(screenVideo);

  // 2) System audio (Windows loopback) — best effort.
  if (o.systemAudio) {
    try {
      systemStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: setup.sourceId } },
        video: false,
      });
    } catch (_) {
      systemStream = null;
      note = note || 'system-audio-unavailable';
    }
  }

  // 3) Microphone — optional; failure is a warning, not an abort.
  if (o.mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (_) {
      micStream = null;
      note = note ? `${note}+mic-unavailable` : 'mic-unavailable';
    }
  }

  // 4) Camera for the PiP bubble in the composited video.
  if (o.cameraBubble) {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      camVideo = createVideo(camStream);
    } catch (_) {
      camStream = null;
      note = note ? `${note}+camera-unavailable` : 'camera-unavailable';
    }
  }
  return { note };
}

/**
 * Wait until a video element has real dimensions.
 * @param {HTMLVideoElement} el Video element.
 * @returns {Promise<void>}
 */
function waitForVideo(el) {
  if (el.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    el.addEventListener('loadedmetadata', () => resolve(), { once: true });
    setTimeout(resolve, 3000); // Never hang the session on metadata.
  });
}

/**
 * Prepare the composited canvas for the capture geometry.
 * @param {object} setup Session setup payload.
 */
function prepareCanvas(setup) {
  const frameW = screenVideo.videoWidth || 1280;
  const frameH = screenVideo.videoHeight || 720;

  let srcX = 0;
  let srcY = 0;
  let srcW = frameW;
  let srcH = frameH;

  if (setup.mode === 'region' && setup.region) {
    const sf = setup.region.scaleFactor || 1;
    const r = setup.region.rect;
    srcX = Math.max(0, Math.round((r.x - setup.region.displayBounds.x) * sf));
    srcY = Math.max(0, Math.round((r.y - setup.region.displayBounds.y) * sf));
    srcW = Math.max(16, Math.round(r.width * sf));
    srcH = Math.max(16, Math.round(r.height * sf));
    // Clamp to the actual frame.
    srcW = Math.min(srcW, frameW - srcX);
    srcH = Math.min(srcH, frameH - srcY);
  }

  const box = setup.options.quality === '720p' ? { w: 1280, h: 720 } : { w: 1920, h: 1080 };
  const scale = Math.min(box.w / srcW, box.h / srcH, 1.5);
  const outW = Math.max(2, Math.round((srcW * scale) / 2) * 2);
  const outH = Math.max(2, Math.round((srcH * scale) / 2) * 2);
  canvas.width = outW;
  canvas.height = outH;

  session.geometry = { srcX, srcY, srcW, srcH, scale };
  g2d.fillStyle = '#0b1120';
  g2d.fillRect(0, 0, outW, outH);
}

/**
 * Draw one composited frame: capture content, camera PiP, cursor, ripples.
 */
function drawFrame() {
  if (!session || !screenVideo) return;
  const geo = session.geometry;
  const o = session.options;

  g2d.drawImage(screenVideo, geo.srcX, geo.srcY, geo.srcW, geo.srcH, 0, 0, canvas.width, canvas.height);

  // Camera PiP — bottom-right, rounded, mirrored selfie view.
  if (camVideo && camVideo.videoWidth > 0) {
    const h = Math.round(canvas.height * 0.22);
    const w = Math.round(h * (camVideo.videoWidth / camVideo.videoHeight));
    const m = Math.round(canvas.height * 0.03);
    const x = canvas.width - w - m;
    const y = canvas.height - h - m;
    const rad = Math.round(h * 0.12);
    g2d.save();
    g2d.beginPath();
    g2d.roundRect(x, y, w, h, rad);
    g2d.fillStyle = 'rgba(11, 17, 32, 0.9)';
    g2d.fill();
    g2d.clip();
    g2d.translate(x + w, y);
    g2d.scale(-1, 1); // Mirror.
    g2d.drawImage(camVideo, 0, 0, w, h);
    g2d.restore();
    g2d.save();
    g2d.beginPath();
    g2d.roundRect(x, y, w, h, rad);
    g2d.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    g2d.lineWidth = Math.max(2, h * 0.02);
    g2d.stroke();
    g2d.restore();
  }

  // Cursor highlight ring — map DIP screen coords to canvas coords.
  if (o.cursorHighlight && cursor.fresh) {
    const p = toCanvas(cursor.x, cursor.y);
    if (p) {
      const size = (o.highlight && o.highlight.size) || 26;
      g2d.beginPath();
      g2d.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
      g2d.strokeStyle = 'rgba(94, 234, 212, 0.9)';
      g2d.lineWidth = 2.5;
      g2d.stroke();
    }
  }

  // Click ripples — expanding teal rings.
  const now = performance.now();
  for (let i = ripples.length - 1; i >= 0; i -= 1) {
    const rp = ripples[i];
    const t = (now - rp.at) / RIPPLE_MS;
    if (t >= 1) {
      ripples.splice(i, 1);
      continue;
    }
    if (!o.clickHighlight) continue;
    const radius = 8 + ((o.highlight && o.highlight.size) || 26) * t;
    g2d.beginPath();
    g2d.arc(rp.x, rp.y, radius, 0, Math.PI * 2);
    g2d.fillStyle = `rgba(94, 234, 212, ${0.35 * (1 - t)})`;
    g2d.fill();
    g2d.strokeStyle = `rgba(94, 234, 212, ${0.9 * (1 - t)})`;
    g2d.lineWidth = 2;
    g2d.stroke();
  }
}

/**
 * Map DIP screen coordinates to composited-canvas coordinates.
 *
 * Region captures know their exact source rect, and fullscreen captures know
 * the display origin — both map precisely. Window captures are skipped
 * (return null): a window does not fill its display, so DIP mapping would
 * paint a misleading ring.
 * @param {number} x DIP screen X.
 * @param {number} y DIP screen Y.
 * @returns {{x:number, y:number}|null} Canvas point, or null when outside.
 */
function toCanvas(x, y) {
  if (!session) return null;
  const geo = session.geometry;
  const sf = session.display ? session.display.scaleFactor : 1;

  let px;
  let py;
  if (session.mode === 'region' && session.region) {
    const b = session.region.displayBounds;
    px = (x - b.x) * (session.region.scaleFactor || 1) - geo.srcX;
    py = (y - b.y) * (session.region.scaleFactor || 1) - geo.srcY;
  } else if (session.mode === 'screen' && session.display) {
    px = (x - session.display.x) * sf - geo.srcX;
    py = (y - session.display.y) * sf - geo.srcY;
  } else {
    return null; // Window mode: no reliable mapping.
  }
  const out = {
    x: px * (canvas.width / geo.srcW),
    y: py * (canvas.height / geo.srcH),
  };
  if (out.x < 0 || out.y < 0 || out.x > canvas.width || out.y > canvas.height) return null;
  return out;
}

/**
 * Mix available audio sources into one MediaStream track.
 * @returns {MediaStreamTrack|null} Mixed audio track (or a single track).
 */
function buildAudioTrack() {
  const streams = [systemStream, micStream].filter(Boolean);
  if (streams.length === 0) return null;
  if (streams.length === 1) return streams[0].getAudioTracks()[0] || null;
  try {
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    for (const s of streams) {
      audioCtx.createMediaStreamSource(s).connect(dest);
    }
    return dest.stream.getAudioTracks()[0] || null;
  } catch (_) {
    return streams[0].getAudioTracks()[0] || null;
  }
}

/**
 * Begin the actual MediaRecorder capture (after any countdown).
 */
function beginRecording() {
  const stream = canvas.captureStream(session.options.fps);
  const audio = buildAudioTrack();
  if (audio) stream.addTrack(audio);

  recorder = new MediaRecorder(stream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond: session.options.quality === '720p' ? 5000000 : 8000000,
  });
  chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = finalize;
  recorder.start(1000); // 1s chunks keep memory flat and enables partial saves.

  recording = true;
  paused = false;
  startedAt = performance.now();
  pausedTotal = 0;

  drawTimer = setInterval(drawFrame, 1000 / session.options.fps);
  stateTimer = setInterval(() => {
    if (recording && !paused) elapsedMs = performance.now() - startedAt - pausedTotal;
    sendState();
  }, 500);
  sendState({ state: 'recording' });
}

/**
 * Finalize the recording and hand the bytes to the main process.
 */
async function finalize() {
  recording = false;
  clearInterval(drawTimer);
  clearInterval(stateTimer);
  clearInterval(countdownTimer);
  drawTimer = stateTimer = countdownTimer = null;

  const durationMs = elapsedMs;
  try {
    const blob = new Blob(chunks, { type: 'video/webm' });
    chunks = [];
    const data = await blob.arrayBuffer();
    await window.capturedesk.saveRecording({ data, durationMs });
  } catch (err) {
    sendState({ state: 'idle', error: `CaptureDesk could not save the recording: ${err.message}` });
  } finally {
    cleanup();
  }
}

/**
 * Release every resource held by this window.
 */
function cleanup() {
  stopTracks(screenStream);
  stopTracks(micStream);
  stopTracks(systemStream);
  stopTracks(camStream);
  screenStream = micStream = systemStream = camStream = null;
  screenVideo = camVideo = null;
  if (audioCtx) {
    try {
      audioCtx.close();
    } catch (_) {
      // Already closed.
    }
    audioCtx = null;
  }
  session = null;
}

// ---- IPC wiring -----------------------------------------------------------

window.capturedesk.on('rec-setup', async (setup) => {
  try {
    session = { ...setup, geometry: null };
    const { note } = await acquireStreams(setup);
    prepareCanvas(setup);
    // Paint one frame so preview snapshots are never black.
    await waitForVideo(screenVideo);
    drawFrame();
    window.capturedesk.ack('setup', { ok: true, note });
  } catch (err) {
    cleanup();
    window.capturedesk.ack('setup', {
      ok: false,
      error: err && err.name === 'NotAllowedError'
        ? 'Screen capture was blocked — grant permission and try again.'
        : `CaptureDesk could not access the capture source: ${err.message}`,
    });
  }
});

window.capturedesk.on('rec-start', ({ countdown }) => {
  remainingMs = Number(countdown) || 0;
  if (remainingMs > 0) {
    sendState({ state: 'countdown' });
    countdownTimer = setInterval(() => {
      remainingMs -= 1000;
      if (remainingMs <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        remainingMs = 0;
        beginRecording();
      } else {
        sendState({ state: 'countdown' });
      }
    }, 1000);
  } else {
    beginRecording();
  }
});

window.capturedesk.on('rec-pause', () => {
  if (!recording || paused) return;
  try {
    recorder.pause();
  } catch (_) {
    // Recorder may have already paused.
  }
  paused = true;
  pausedAt = performance.now();
  sendState({ state: 'paused' });
});

window.capturedesk.on('rec-resume', () => {
  if (!recording || !paused) return;
  try {
    recorder.resume();
  } catch (_) {
    // Recorder may have already resumed.
  }
  paused = false;
  pausedTotal += performance.now() - pausedAt;
  sendState({ state: 'recording' });
});

window.capturedesk.on('rec-stop', () => {
  if (!recording) return;
  clearInterval(countdownTimer);
  countdownTimer = null;
  sendState({ state: 'stopping' });
  try {
    recorder.stop();
  } catch (_) {
    finalize();
  }
});

window.capturedesk.on('rec-cancel', () => {
  if (!recording) {
    cleanup();
    return;
  }
  recording = false;
  clearInterval(drawTimer);
  clearInterval(stateTimer);
  clearInterval(countdownTimer);
  try {
    recorder.onstop = null; // Discard instead of saving.
    recorder.stop();
  } catch (_) {
    // Nothing to stop.
  }
  chunks = [];
  cleanup();
});

window.capturedesk.on('cursor', (p) => {
  cursor.x = p.x;
  cursor.y = p.y;
  cursor.fresh = true;
});

window.capturedesk.on('ripple', (p) => {
  const point = toCanvas(p.x, p.y);
  if (point) ripples.push({ x: point.x, y: point.y, at: performance.now() });
});

// Auto-stop when the captured stream ends (closed window / unplugged display).
window.addEventListener('beforeunload', () => {
  if (recording) {
    try {
      recorder.stop();
    } catch (_) {
      // Nothing to flush.
    }
  }
});

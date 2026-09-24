/**
 * @file CaptureDesk Editor — annotation engine (capturedesk-editor module).
 *
 * Strokes are stored with normalized coordinates (0..1 of the video box) and
 * a time window [tStart, tEnd]; during playback only strokes whose window
 * contains the current time are drawn, with a 200ms fade-in. This makes
 * annotations appear when they were drawn, exactly like live markup.
 */
(function () {
  'use strict';

  const CDEditor = (window.CDEditor = window.CDEditor || {});

  const FADE_MS = 200;
  const STROKE_TTL = 1.5; // Seconds a stroke stays visible after its tStart.

  /**
   * Create an annotation engine bound to a canvas over a video element.
   * @param {HTMLCanvasElement} canvas Overlay canvas.
   * @param {HTMLVideoElement} video Video element.
   * @param {Function} [onStrokesChanged] Change callback.
   */
  function AnnotationEngine(canvas, video, onStrokesChanged) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.video = video;
    this.onStrokesChanged = onStrokesChanged || null;
    this.tool = 'pen';
    this.color = '#5EEAD4';
    this.width = 4;
    this.strokes = [];
    this.current = null;
    this._raf = null;

    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Resize the overlay canvas to the video box. */
  AnnotationEngine.prototype.resize = function resize() {
    const r = this.video.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      this.canvas.width = Math.round(r.width);
      this.canvas.height = Math.round(r.height);
      this.render(this.video.currentTime);
    }
  };

  /** Begin a stroke (only while the video is paused, per the editing model). */
  AnnotationEngine.prototype._down = function _down(e) {
    if (this.tool === 'none') return;
    if (!this.video.paused) {
      if (this.onBlocked) this.onBlocked();
      return;
    }
    const p = this._norm(e);
    this.current = {
      tool: this.tool,
      color: this.color,
      width: this.width,
      tStart: Number(this.video.currentTime.toFixed(2)),
      tEnd: Number((this.video.currentTime + STROKE_TTL).toFixed(2)),
      points: [p],
    };
    this.canvas.setPointerCapture(e.pointerId);
  };

  /** Extend the current stroke. */
  AnnotationEngine.prototype._move = function _move(e) {
    if (!this.current) return;
    if (e.buttons !== 1) return;
    this.current.points.push(this._norm(e));
    this.render(this.video.currentTime);
  };

  /** Commit the current stroke. */
  AnnotationEngine.prototype._up = function _up(e) {
    if (!this.current) return;
    this.current.points.push(this._norm(e));
    if (this.current.points.length > 1 || this.current.tool === 'rect') {
      this.strokes.push(this.current);
      if (this.onStrokesChanged) this.onStrokesChanged(this.strokes.length);
    }
    this.current = null;
    this.render(this.video.currentTime);
  };

  /**
   * Convert a pointer event to normalized coordinates.
   * @param {PointerEvent} e Pointer event.
   * @returns {{x:number, y:number}} Normalized point.
   */
  AnnotationEngine.prototype._norm = function _norm(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  /** Remove the last stroke. */
  AnnotationEngine.prototype.undo = function undo() {
    this.strokes.pop();
    this.render(this.video.currentTime);
    if (this.onStrokesChanged) this.onStrokesChanged(this.strokes.length);
  };

  /** Remove every stroke. */
  AnnotationEngine.prototype.clear = function clear() {
    this.strokes = [];
    this.render(this.video.currentTime);
    if (this.onStrokesChanged) this.onStrokesChanged(0);
  };

  /**
   * Render all strokes visible at time t (plus the in-progress one).
   * @param {number} t Video time in seconds.
   */
  AnnotationEngine.prototype.render = function render(t) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.ctx.clearRect(0, 0, w, h);
    for (const s of this.strokes) {
      if (t >= s.tStart && t <= s.tEnd) _drawStroke(this.ctx, s, w, h);
    }
    if (this.current) _drawStroke(this.ctx, this.current, w, h);
    if (this._raf) cancelAnimationFrame(this._raf);
    if (!this.video.paused) {
      this._raf = requestAnimationFrame(() => this.render(this.video.currentTime));
    }
  };

  /**
   * Draw one stroke onto a 2D context (module-level so PNG export can reuse
   * it without borrowing the engine instance).
   * @param {CanvasRenderingContext2D} ctx Target context.
   * @param {object} s Stroke descriptor.
   * @param {number} w Canvas width.
   * @param {number} h Canvas height.
   */
  function _drawStroke(ctx, s, w, h) {
    const pts = s.points.map((p) => ({ x: p.x * w, y: p.y * h }));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;

    if (s.tool === 'highlighter') {
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = s.width * 4;
    } else {
      ctx.globalAlpha = 1;
      ctx.lineWidth = s.width;
    }

    if (s.tool === 'rect' && pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      ctx.lineWidth = s.width;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else if (s.tool === 'arrow' && pts.length >= 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const head = Math.max(8, s.width * 3);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang - Math.PI / 6), b.y - head * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(b.x - head * Math.cos(ang + Math.PI / 6), b.y - head * Math.sin(ang + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Render one stroke (or all strokes) to a transparent PNG blob.
   * @param {number|'all'} index Stroke index, or 'all' for a merged image.
   * @returns {Promise<Blob>} PNG blob.
   */
  AnnotationEngine.prototype.exportPNG = async function exportPNG(index) {
    const c = document.createElement('canvas');
    c.width = this.canvas.width || 1280;
    c.height = this.canvas.height || 720;
    const ctx = c.getContext('2d');
    if (index === 'all') {
      for (const s of this.strokes) _drawStroke(ctx, s, c.width, c.height);
    } else {
      _drawStroke(ctx, this.strokes[index], c.width, c.height);
    }
    return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'));
  };

  window.CDEditor.AnnotationEngine = AnnotationEngine;
})();

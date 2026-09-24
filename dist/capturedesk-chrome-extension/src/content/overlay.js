/**
 * @file CaptureDesk content overlay (injected on demand by the service
 * worker while a recording is active).
 *
 * This script is intentionally EVENTS-ONLY: it does not draw anything into
 * the page. All cursor rings and click ripples are rendered by the offscreen
 * compositor canvas from the INPUT events forwarded here, which keeps the
 * effect consistent across tab/window/screen capture and avoids double
 * rendering inside the captured video.
 *
 * It is a classic script (content scripts cannot use ES module imports), so
 * the message type literals below mirror src/common/messages.js:
 *   OVERLAY_READY 'cd:overlay-ready', INPUT 'cd:input', OVERLAY_STOP
 * 'cd:overlay-stop'.
 */
(function () {
  'use strict';

  if (window.__cdOverlay) return; // Never double-inject.
  window.__cdOverlay = true;

  var MSG_OVERLAY_READY = 'cd:overlay-ready';
  var MSG_INPUT = 'cd:input';
  var MSG_OVERLAY_STOP = 'cd:overlay-stop';

  /** Fallback config used until the worker answers OVERLAY_READY. */
  var config = {
    cursor: true,
    clicks: true,
    cursorColor: 'teal',
    rippleColor: 'teal',
    cursorSize: 26,
    rippleSize: 36,
  };

  var CURSOR_FORWARD_MS = 66; // ~15 Hz cursor updates are plenty for a ring.
  var stopped = false;
  var lastCursorSent = 0;
  var bound = [];

  /**
   * Add a listener and remember it so teardown removes exactly the same pair.
   * @param {EventTarget} target Event target.
   * @param {string} type Event type.
   * @param {Function} fn Handler.
   * @param {boolean} [capture] Capture phase flag.
   */
  function on(target, type, fn, capture) {
    target.addEventListener(type, fn, capture === true);
    bound.push({ target: target, type: type, fn: fn, capture: capture === true });
  }

  /**
   * Forward one input event to the service worker (which relays it to the
   * offscreen compositor). Fire-and-forget; failures are swallowed because a
   * torn-down extension must never break the host page.
   * @param {string} type 'cursor' | 'down'.
   * @param {number} x Client X in CSS pixels.
   * @param {number} y Client Y in CSS pixels.
   */
  function sendInput(type, x, y) {
    if (stopped) return;
    try {
      var payload = {
        type: type,
        x: x,
        y: y,
        vw: window.innerWidth,
        vh: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      };
      var p = chrome.runtime.sendMessage({ type: MSG_INPUT, payload: payload });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (_) {
      // Extension context is gone — the recording will end on its own.
    }
  }

  /**
   * mousemove handler: move updates are throttled to CURSOR_FORWARD_MS.
   * @param {MouseEvent} ev Native mouse event.
   */
  function handleMove(ev) {
    if (stopped || !config.cursor) return;
    var now = Date.now();
    if (now - lastCursorSent < CURSOR_FORWARD_MS) return;
    lastCursorSent = now;
    sendInput('cursor', ev.clientX, ev.clientY);
  }

  /**
   * pointerdown handler: clicks are always forwarded immediately.
   * @param {PointerEvent} ev Native pointer event.
   */
  function handleDown(ev) {
    if (stopped || !config.clicks) return;
    sendInput('down', ev.clientX, ev.clientY);
  }

  /** Remove every listener and mark the overlay dead. */
  function teardown() {
    if (stopped) return;
    stopped = true;
    for (var i = 0; i < bound.length; i += 1) {
      var b = bound[i];
      try {
        b.target.removeEventListener(b.type, b.fn, b.capture);
      } catch (_) {
        // Target already gone.
      }
    }
    bound = [];
    delete window.__cdOverlay;
  }

  // ---- wiring -----------------------------------------------------------

  on(window, 'mousemove', handleMove, true);
  on(window, 'pointerdown', handleDown, true);
  on(window, 'pagehide', teardown, true);

  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === MSG_OVERLAY_STOP) teardown();
      return false;
    });
  } catch (_) {
    // No runtime messaging (should not happen) — pagehide still cleans up.
  }

  // Fetch the effective overlay config (colors/sizes/toggles) from the worker.
  try {
    var ready = chrome.runtime.sendMessage({ type: MSG_OVERLAY_READY });
    if (ready && typeof ready.then === 'function') {
      ready
        .then(function (res) {
          if (stopped || !res || !res.ok || !res.config) return;
          var c = res.config;
          if (typeof c.cursor === 'boolean') config.cursor = c.cursor;
          if (typeof c.clicks === 'boolean') config.clicks = c.clicks;
          if (typeof c.cursorColor === 'string') config.cursorColor = c.cursorColor;
          if (typeof c.rippleColor === 'string') config.rippleColor = c.rippleColor;
          if (Number.isFinite(c.cursorSize)) config.cursorSize = c.cursorSize;
          if (Number.isFinite(c.rippleSize)) config.rippleSize = c.rippleSize;
          if (!config.cursor && !config.clicks) teardown();
        })
        .catch(function () {});
    }
  } catch (_) {
    // Config stays at defaults; the overlay remains functional.
  }
})();

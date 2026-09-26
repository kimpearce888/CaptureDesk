/**
 * @file CaptureDesk region picker overlay: drag a rectangle on a fullscreen
 * window showing a frozen screenshot of the desktop, report the DIP rect +
 * display id to the main process, cancel with Esc / the Cancel pill /
 * double click. Runs one instance per session; the shell recreates it with
 * a fresh screenshot every time.
 *
 * Escape hatches (belt and braces — the overlay must never trap the PC):
 * page keydown Esc, the Cancel pill, window.close() fallbacks, the shell's
 * global Esc hotkey, blur-cancel and the 180 s native auto-cancel.
 */
const rectEl = document.getElementById('rect');
const sizeEl = document.getElementById('size');
const dim = document.getElementById('dim');
const shotEl = document.getElementById('shot');
const cancelBtn = document.getElementById('cancelBtn');

const q = new URLSearchParams(location.search);
const displayId = Number(q.get('displayId'));
// PHYSICAL monitor origin (screen px) — the engine's frames are physical.
const displayX = Number(q.get('displayX')) || 0;
const displayY = Number(q.get('displayY')) || 0;
// DIP → physical factor for this display (WebView2 devicePixelRatio).
const scale = Number(q.get('scale')) || window.devicePixelRatio || 1;
// Frozen desktop screenshot (physical px) captured before this window opened.
const shotPath = q.get('shot') || '';

let dragging = false;
let startX = 0;
let startY = 0;
let confirmed = false;
let revealed = false;

/**
 * Reveal the overlay. The window is created hidden so the white pre-paint
 * flash never shows; this flips it on once the screenshot has decoded (or
 * immediately in dim-fallback mode). Uses the Tauri window API directly —
 * the capability grant makes it work even when the bridge shim failed.
 */
function reveal() {
  if (revealed) return;
  revealed = true;
  try {
    const t = window.__TAURI__;
    if (t && t.window && t.window.getCurrentWindow) {
      const w = t.window.getCurrentWindow();
      if (w && typeof w.show === 'function') {
        Promise.resolve(w.show()).catch(() => {});
        if (typeof w.setFocus === 'function') Promise.resolve(w.setFocus()).catch(() => {});
      }
    }
  } catch (e) {
    /* the shell's 900 ms native fallback reveals us anyway */
  }
}

if (shotPath && window.capturedesk && typeof window.capturedesk.assetUrl === 'function') {
  shotEl.addEventListener('load', () => {
    document.body.classList.add('shot-ok');
    reveal();
  });
  shotEl.addEventListener('error', () => {
    // Shot missing/undecodable → dim fallback (window stays transparent).
    document.body.classList.remove('shot-ok');
    reveal();
  });
  shotEl.src = window.capturedesk.assetUrl(shotPath);
  // Hard deadline: never stay invisible longer than 1.2 s.
  setTimeout(reveal, 1200);
} else {
  setTimeout(reveal, 60);
}

/**
 * Report a selection/cancel to the shell. Falls back to a direct Tauri
 * invoke when the bridge shim is unavailable, and never throws — the
 * native escape hatches (global Esc hotkey, timers, close) cover the rest.
 * @param {{displayId:number,canceled:boolean,rect:(object|null)}} payload
 */
function report(payload) {
  try {
    if (window.capturedesk && typeof window.capturedesk.regionSelected === 'function') {
      window.capturedesk.regionSelected(payload);
      return;
    }
  } catch (e) { /* fall through to the raw API */ }
  try {
    const t = window.__TAURI__;
    if (t && t.core && t.core.invoke) {
      t.core.invoke('region_selected', { payload });
    }
  } catch (e) { /* native hatches close the window */ }
}

/**
 * Cancel selection (Esc, Cancel pill or double click).
 */
function cancel() {
  if (confirmed) return;
  confirmed = true;
  report({ displayId, rect: null, canceled: true });
  // Belt and braces: closing natively (the shell intercepts close as a
  // cancel) hides the overlay even if the IPC report never landed.
  setTimeout(() => {
    try { window.close(); } catch (e) { /* timers remain */ }
  }, 120);
}

// Last-resort page timers: the picker never outlives 90 s on its own; the
// shell's 180 s auto-cancel is the final net underneath this one.
setTimeout(() => { if (!confirmed) cancel(); }, 90_000);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel();
});

cancelBtn.addEventListener('click', cancel);
cancelBtn.addEventListener('mousedown', (e) => e.stopPropagation());

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || confirmed) return;
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  rectEl.style.display = 'block';
  sizeEl.style.display = 'block';
  updateRect(e.clientX, e.clientY);
});

document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  updateRect(e.clientX, e.clientY);
});

document.addEventListener('mouseup', (e) => {
  if (!dragging || confirmed) return;
  dragging = false;
  const r = normalize(e.clientX, e.clientY);
  // Ignore accidental micro-selections.
  if (r.width < 12 || r.height < 12) {
    rectEl.style.display = 'none';
    sizeEl.style.display = 'none';
    // Restore the dim backdrop (the rect's box-shadow is hidden with it).
    dim.style.background = '';
    return;
  }
  confirmed = true;
  // Report the rect in PHYSICAL pixels: pointer coords are DIP inside the
  // window; the engine crops physical capture frames.
  report({
    displayId,
    canceled: false,
    rect: {
      x: Math.round(displayX + r.x * scale),
      y: Math.round(displayY + r.y * scale),
      width: Math.max(2, Math.round(r.width * scale) & ~1),
      height: Math.max(2, Math.round(r.height * scale) & ~1),
    },
  });
});

document.addEventListener('dblclick', cancel);

/**
 * Update the selection rectangle + size badge from the current pointer.
 * @param {number} cx Pointer client X.
 * @param {number} cy Pointer client Y.
 */
function updateRect(cx, cy) {
  const r = normalize(cx, cy);
  rectEl.style.left = `${r.x}px`;
  rectEl.style.top = `${r.y}px`;
  rectEl.style.width = `${r.width}px`;
  rectEl.style.height = `${r.height}px`;
  sizeEl.style.left = `${r.x}px`;
  sizeEl.style.top = `${r.y}px`;
  sizeEl.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
  // The dim backdrop comes from the rect's box-shadow; hide it before any
  // selection exists so the screen is only dimmed while choosing.
  dim.style.background = 'transparent';
}

/**
 * Normalize a pointer pair into a positive rect.
 * @param {number} cx Pointer client X.
 * @param {number} cy Pointer client Y.
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function normalize(cx, cy) {
  return {
    x: Math.min(startX, cx),
    y: Math.min(startY, cy),
    width: Math.abs(cx - startX),
    height: Math.abs(cy - startY),
  };
}

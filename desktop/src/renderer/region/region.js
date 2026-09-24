/**
 * @file CaptureDesk region picker overlay: drag a rectangle on a transparent
 * fullscreen window, report the DIP rect + display id to the main process,
 * cancel with Esc. Runs one instance per display.
 */
const rectEl = document.getElementById('rect');
const sizeEl = document.getElementById('size');
const dim = document.getElementById('dim');

const q = new URLSearchParams(location.search);
const displayId = Number(q.get('displayId'));
const displayX = Number(q.get('displayX'));
const displayY = Number(q.get('displayY'));

let dragging = false;
let startX = 0;
let startY = 0;
let confirmed = false;

/**
 * Cancel selection (Esc or double click).
 */
function cancel() {
  if (confirmed) return;
  confirmed = true;
  window.capturedesk.regionSelected({ displayId, rect: null, canceled: true });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel();
});

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
    return;
  }
  confirmed = true;
  window.capturedesk.regionSelected({
    displayId,
    canceled: false,
    rect: {
      x: displayX + r.x,
      y: displayY + r.y,
      width: r.width,
      height: r.height,
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

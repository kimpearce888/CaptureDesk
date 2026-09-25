/**
 * @file CaptureDesk floating toolbar: live timer, pause/resume, stop,
 * camera-bubble toggle and countdown badge. Draggable via the left section.
 */
const dot = document.getElementById('dot');
const timer = document.getElementById('timer');
const stateText = document.getElementById('stateText');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const camBtn = document.getElementById('camBtn');
const countBadge = document.getElementById('countBadge');

let camOn = false;

/** Reflect the bubble visibility on the toolbar toggle. */
function applyCam(visible) {
  camOn = Boolean(visible);
  camBtn.classList.toggle('active', camOn);
}

/** Format milliseconds as m:ss (hours roll into minutes). */
function fmt(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Apply a session-state snapshot to the toolbar UI.
 * @param {object} s Session snapshot from the main process.
 */
function apply(s) {
  if (s.state === 'countdown') {
    countBadge.style.display = 'block';
    countBadge.textContent = `Recording starts in ${Math.ceil((s.remainingMs || 0) / 1000)}…`;
    stateText.textContent = 'Get ready…';
    timer.textContent = '00:00';
    return;
  }
  countBadge.style.display = 'none';
  if (s.state === 'recording') {
    stateText.textContent = 'Recording…';
    timer.textContent = fmt(s.elapsedMs || 0);
    pauseBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
    pauseBtn.title = 'Pause recording';
    pauseBtn.classList.remove('active');
  } else if (s.state === 'paused') {
    stateText.textContent = 'Paused';
    pauseBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    pauseBtn.title = 'Resume recording';
    pauseBtn.classList.add('active');
  } else if (s.state === 'stopping') {
    stateText.textContent = 'Saving…';
    stopBtn.disabled = true;
  }
}

window.capturedesk.on('rec-state', apply);
window.capturedesk.on('cambubble-visible', (p) => applyCam(p && p.visible));

window.capturedesk.getState().then((s) => applyCam(s.state && s.state.cameraBubble));

pauseBtn.addEventListener('click', async () => {
  const s = (await window.capturedesk.getState()).state;
  if (s.state === 'paused') await window.capturedesk.resumeRecording();
  else await window.capturedesk.pauseRecording();
});

stopBtn.addEventListener('click', () => window.capturedesk.stopRecording());

camBtn.addEventListener('click', async () => {
  const res = await window.capturedesk.toggleCamBubble();
  applyCam(res && res.visible);
});

apply({ state: 'recording', elapsedMs: 0, remainingMs: null });

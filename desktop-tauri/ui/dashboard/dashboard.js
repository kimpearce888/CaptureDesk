/**
 * @file CaptureDesk dashboard: hero controls, source selection, recording
 * options, recent recordings strip and the branded settings modal.
 */
const $ = (id) => document.getElementById(id);

const startBtn = $('startBtn');
const areaBtn = $('areaBtn');
const statusText = $('statusText');

let selectedMode = 'screen';
let recordingNow = false;

/** Format bytes as a compact human string. */
function fmtSize(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Format a mtime as a short local date. */
function fmtDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Guess a recording's duration tag from the file name (fast, no probing).
 * @param {string} name File name.
 * @returns {string} Duration or ''.
 */
function fmtDurationGuess() {
  return ''; // Durations are shown after opening in the editor.
}

// ---- settings → UI ---------------------------------------------------------

/**
 * Push a settings object into every control.
 * @param {object} s Effective settings.
 */
function applySettings(s) {
  $('optMic').checked = Boolean(s.mic);
  $('optSys').checked = Boolean(s.systemAudio);
  $('optCam').checked = Boolean(s.cameraBubble);
  $('optCursor').checked = Boolean(s.cursorHighlight);
  $('optClicks').checked = Boolean(s.clickHighlight);
  $('optFps').value = String(s.fps);
  $('optQuality').value = s.quality;
  $('optCountdown').value = String(s.countdown);
  $('setTray').checked = Boolean(s.minimizeToTray);
  $('setHotkeys').checked = Boolean(s.hotkeysEnabled);
  $('ringSize').value = String(s.highlight && s.highlight.size ? s.highlight.size : 26);
  for (const sw of document.querySelectorAll('.swatch')) {
    sw.classList.toggle('selected', sw.dataset.color === (s.highlight && s.highlight.color));
  }
  $('folderPath').textContent = s.recordingsDir || '';
}

/**
 * Collect the current UI options as a settings patch.
 * @returns {object}
 */
function collectOptions() {
  return {
    mic: $('optMic').checked,
    systemAudio: $('optSys').checked,
    cameraBubble: $('optCam').checked,
    cursorHighlight: $('optCursor').checked,
    clickHighlight: $('optClicks').checked,
    fps: Number($('optFps').value),
    quality: $('optQuality').value,
    countdown: Number($('optCountdown').value),
    highlight: {
      color: document.querySelector('.swatch.selected')?.dataset.color || '#5EEAD4',
      size: Number($('ringSize').value) || 26,
    },
  };
}

/** Persist dashboard controls as settings. */
function persistOptions() {
  window.capturedesk.setSettings(collectOptions()).catch(() => {});
}

for (const id of ['optMic', 'optSys', 'optCam', 'optCursor', 'optClicks', 'optFps', 'optQuality', 'optCountdown']) {
  $(id).addEventListener('change', persistOptions);
}
document.querySelectorAll('.swatch').forEach((sw) => {
  sw.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach((x) => x.classList.remove('selected'));
    sw.classList.add('selected');
    persistOptions();
  });
});
$('ringSize').addEventListener('change', persistOptions);

// ---- session state ---------------------------------------------------------

window.capturedesk.on('rec-state', (s) => {
  recordingNow = s.state !== 'idle';
  const busy = ['preparing', 'countdown', 'recording', 'paused', 'stopping'].includes(s.state);
  startBtn.disabled = busy;
  areaBtn.disabled = busy;
  document.querySelectorAll('.source').forEach((c) => (c.disabled = busy));
  if (s.state === 'recording') statusText.textContent = `Recording… ${Math.floor((s.elapsedMs || 0) / 1000)}s`;
  else if (s.state === 'paused') statusText.textContent = 'Paused';
  else if (s.state === 'countdown') statusText.textContent = `Starting in ${Math.ceil((s.remainingMs || 0) / 1000)}…`;
  else if (s.state === 'stopping') statusText.textContent = 'Saving…';
  else if (s.state === 'idle') {
    statusText.textContent = s.error ? s.error : 'CaptureDesk is ready';
    if (s.error) window.toast(s.error, 'err');
    if (s.note) {
      if (s.note.includes('mic-unavailable')) window.toast('Microphone unavailable — recording without audio.', 'err');
      if (s.note.includes('system-audio-unavailable')) window.toast('System audio is not available for this source.', 'err');
      if (s.note.includes('camera-unavailable')) window.toast('Camera unavailable — recording without the camera bubble.', 'err');
    }
  }
});

// ---- start flows -----------------------------------------------------------

startBtn.addEventListener('click', async () => {
  if (recordingNow) return;
  if (selectedMode === 'region') {
    await window.capturedesk.beginRegionSelection();
    return;
  }
  if (selectedMode === 'window') {
    await openPicker('window', 'Choose a window to record');
    return;
  }
  // Screen mode: auto-start when a single display, else pick.
  const { sources } = await window.capturedesk.listSources({ screens: true, windows: false });
  // Engine source entries carry their kind in `kind` (not `type`).
  const screens = sources.filter((x) => x.kind === 'screen');
  if (screens.length <= 1) {
    const res = await window.capturedesk.startRecording({ mode: 'screen', sourceId: screens[0] && screens[0].id, options: collectOptions() });
    if (!res.ok && res.error) window.toast(res.error, 'err');
  } else {
    await openPicker('screen', 'Choose a display to record');
  }
});

areaBtn.addEventListener('click', async () => {
  if (recordingNow) return;
  await window.capturedesk.beginRegionSelection();
});

// When a region is chosen, start recording it right away (with countdown).
window.capturedesk.on('region-selected', async (sel) => {
  if (!sel || sel.canceled) return;
  const res = await window.capturedesk.startRecording({ mode: 'region', options: collectOptions() });
  if (!res.ok && res.error) window.toast(res.error, 'err');
});

// Source cards select the mode.
document.querySelectorAll('.source').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.source').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedMode = card.dataset.mode;
    if (selectedMode === 'window') startBtn.click();
  });
});

// ---- source picker ---------------------------------------------------------

let pickerKind = 'window';

/**
 * Open the source picker modal for a kind.
 * @param {'window'|'screen'} kind Source kind.
 * @param {string} title Modal title.
 */
async function openPicker(kind, title) {
  pickerKind = kind;
  $('pickerTitle').textContent = title;
  $('pickerSearch').value = '';
  $('pickerBackdrop').classList.add('open');
  await renderPicker('');
}

/**
 * Render picker cards for the query.
 * @param {string} query Filter text.
 */
async function renderPicker(query) {
  const { sources } = await window.capturedesk.listSources({
    screens: pickerKind === 'screen',
    windows: pickerKind === 'window',
  });
  const q = query.trim().toLowerCase();
  const grid = $('pickerGrid');
  grid.innerHTML = '';
  for (const src of sources.filter((s) => !q || s.name.toLowerCase().includes(q))) {
    const btn = document.createElement('button');
    btn.className = 'pick';
    const img = document.createElement('img');
    // Engine sources carry thumbnails in `thumb` and the entry type in `kind`.
    img.src = src.thumb || '';
    img.alt = '';
    const label = document.createElement('div');
    label.className = 'pname';
    label.textContent = src.name || (src.kind === 'screen' ? 'Display' : 'Window');
    btn.append(img, label);
    btn.addEventListener('click', async () => {
      $('pickerBackdrop').classList.remove('open');
      const res = await window.capturedesk.startRecording({ mode: pickerKind, sourceId: src.id, options: collectOptions() });
      if (!res.ok && res.error) window.toast(res.error, 'err');
    });
    grid.appendChild(btn);
  }
  if (!grid.children.length) {
    grid.innerHTML = '<p class="empty">No sources found.</p>';
  }
}

$('pickerClose').addEventListener('click', () => $('pickerBackdrop').classList.remove('open'));
$('pickerSearch').addEventListener('input', (e) => renderPicker(e.target.value));

// ---- recent recordings -----------------------------------------------------

/**
 * Render the recent recordings strip.
 */
async function renderLibrary() {
  const { items } = await window.capturedesk.listLibrary();
  const grid = $('recentGrid');
  grid.innerHTML = '';
  $('recentEmpty').style.display = items.length ? 'none' : 'block';
  for (const item of items.slice(0, 6)) {
    const card = document.createElement('div');
    card.className = 'card rec-card';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.name;
    name.title = item.name;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${fmtSize(item.size)} · ${fmtDate(item.mtime)} ${fmtDurationGuess()}`;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const mk = (label, fn, cls = 'btn-ghost') => {
      const b = document.createElement('button');
      b.className = `btn ${cls}`;
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };

    actions.append(
      mk('Play', () => window.capturedesk.openEditor(item.file), 'btn-primary'),
      mk('Edit', () => window.capturedesk.openEditor(item.file)),
      mk('Reveal', () => window.capturedesk.revealRecording(item.file)),
      mk('Delete', async () => {
        if (!window.confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
        const res = await window.capturedesk.removeRecording(item.file);
        if (!res.ok && res.error) window.toast(res.error, 'err');
        renderLibrary();
      }, 'btn-danger'),
    );
    card.append(name, meta, actions);
    grid.appendChild(card);
  }
}

$('openFolder').addEventListener('click', async () => {
  const { dir } = await window.capturedesk.libraryDir();
  window.capturedesk.openPath(dir);
});

window.capturedesk.on('library-changed', renderLibrary);

// ---- settings modal --------------------------------------------------------

$('settingsBtn').addEventListener('click', () => $('settingsBackdrop').classList.add('open'));
$('settingsClose').addEventListener('click', () => $('settingsBackdrop').classList.remove('open'));

$('changeFolder').addEventListener('click', async () => {
  const res = await window.capturedesk.pickRecordingsDir();
  if (res && res.ok && res.dir) {
    await window.capturedesk.setSettings({ recordingsDir: res.dir });
    window.toast('CaptureDesk Recordings folder updated.', 'ok');
  }
});

$('revealFolder').addEventListener('click', async () => {
  const { dir } = await window.capturedesk.libraryDir();
  window.capturedesk.openPath(dir);
});

$('setTray').addEventListener('change', (e) => window.capturedesk.setSettings({ minimizeToTray: e.target.checked }));
$('setHotkeys').addEventListener('change', (e) => window.capturedesk.setSettings({ hotkeysEnabled: e.target.checked }));

window.capturedesk.on('settings-changed', ({ settings }) => applySettings(settings));

// ---- onboarding ------------------------------------------------------------

$('welcomeOk').addEventListener('click', async () => {
  $('welcomeBackdrop').classList.remove('open');
  await window.capturedesk.setSettings({ firstRunDone: true });
});

// ---- boot ------------------------------------------------------------------

(async function boot() {
  const version = await window.capturedesk.getVersion();
  $('verChip').textContent = `v${version}`;
  $('aboutVersion').textContent = `v${version}`;
  const { settings } = await window.capturedesk.getSettings();
  applySettings(settings);
  if (!settings.firstRunDone) $('welcomeBackdrop').classList.add('open');
  renderLibrary();
})();

window.capturedesk.on('capturedesk-ready', () => {
  if (window.toast) window.toast('CaptureDesk is ready', 'ok');
});

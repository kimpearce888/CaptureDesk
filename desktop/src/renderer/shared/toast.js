/**
 * @file CaptureDesk toast helper (renderer). One shared container per page.
 */

/**
 * Show a toast message.
 * @param {string} message Text to display.
 * @param {'ok'|'err'|'info'} [kind] Visual kind.
 * @param {number} [ms] Auto-dismiss delay.
 */
function toast(message, kind = 'info', ms = 3200) {
  let host = document.getElementById('cd-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'cd-toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : ''}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

window.toast = toast;

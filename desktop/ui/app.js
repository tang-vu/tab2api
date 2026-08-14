/* global document, window */
const invoke = window.__TAURI__?.core?.invoke;

const elements = {
  dot: document.querySelector('#status-dot'),
  label: document.querySelector('#status-label'),
  detail: document.querySelector('#status-detail'),
  endpoint: document.querySelector('#endpoint'),
  error: document.querySelector('#error'),
  start: document.querySelector('#start'),
  stop: document.querySelector('#stop'),
  login: document.querySelector('#login'),
  refresh: document.querySelector('#refresh'),
  undock: document.querySelector('#undock'),
  redock: document.querySelector('#redock'),
  browserHost: document.querySelector('#browser-host'),
  browserMode: document.querySelector('#browser-mode'),
};

const labels = {
  stopped: 'Stopped',
  starting: 'Starting',
  ready: 'Ready',
  unhealthy: 'Needs attention',
  login_open: 'Login browser open',
};

function render(status) {
  elements.dot.className = `dot ${status.phase}`;
  elements.label.textContent = labels[status.phase] ?? status.phase;
  elements.detail.textContent = status.detail;
  elements.endpoint.textContent = status.endpoint;
  const modeLabels = { none: 'Not running', external: 'External window', docked: 'Docked' };
  elements.browserMode.textContent = modeLabels[status.browser_mode] ?? 'Unavailable';
  elements.browserHost.classList.toggle('active', status.browser_mode === 'docked');
  const busy = status.phase === 'starting' || status.phase === 'login_open';
  elements.start.disabled = status.phase !== 'stopped';
  elements.stop.disabled = status.phase === 'stopped';
  elements.login.disabled = status.phase !== 'stopped';
  elements.refresh.disabled = busy;
  elements.undock.disabled = status.browser_mode !== 'docked';
  elements.redock.disabled = status.browser_mode !== 'external';
  if (status.browser_mode === 'docked') queueBrowserBounds();
}

let boundsQueued = false;
function queueBrowserBounds() {
  if (boundsQueued || typeof invoke !== 'function') return;
  boundsQueued = true;
  window.requestAnimationFrame(async () => {
    boundsQueued = false;
    const rect = elements.browserHost.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 120) return;
    try {
      await invoke('set_browser_bounds', {
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    } catch (error) {
      elements.error.textContent = String(error);
      elements.error.hidden = false;
    }
  });
}

async function perform(command) {
  elements.error.hidden = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    render(await invoke(command));
  } catch (error) {
    elements.error.textContent = String(error);
    elements.error.hidden = false;
    await refresh();
  }
}

async function refresh() {
  try {
    render(await invoke('sidecar_status'));
  } catch (error) {
    elements.error.textContent = String(error);
    elements.error.hidden = false;
  }
}

if (typeof invoke !== 'function') {
  elements.error.textContent =
    'Native bridge initialization failed. Restart tab2api; reinstall the desktop app if this persists.';
  elements.error.hidden = false;
  elements.label.textContent = 'Desktop bridge unavailable';
  elements.detail.textContent = 'The native command API was not injected into this window.';
  for (const button of document.querySelectorAll('button')) button.disabled = true;
} else {
  elements.start.addEventListener('click', () => perform('start_sidecar'));
  elements.stop.addEventListener('click', () => perform('stop_sidecar'));
  elements.login.addEventListener('click', () => perform('open_login'));
  elements.refresh.addEventListener('click', refresh);
  elements.undock.addEventListener('click', () => perform('undock_browser'));
  elements.redock.addEventListener('click', async () => {
    await perform('redock_browser');
    queueBrowserBounds();
  });
  new ResizeObserver(queueBrowserBounds).observe(elements.browserHost);

  await refresh();
  window.setInterval(refresh, 3000);
}

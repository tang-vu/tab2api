/* global document, window */
const invoke = window.__TAURI__.core.invoke;

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
  const busy = status.phase === 'starting' || status.phase === 'login_open';
  elements.start.disabled = status.phase !== 'stopped';
  elements.stop.disabled = status.phase === 'stopped';
  elements.login.disabled = status.phase !== 'stopped';
  elements.refresh.disabled = busy;
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

elements.start.addEventListener('click', () => perform('start_sidecar'));
elements.stop.addEventListener('click', () => perform('stop_sidecar'));
elements.login.addEventListener('click', () => perform('open_login'));
elements.refresh.addEventListener('click', refresh);

await refresh();
window.setInterval(refresh, 3000);

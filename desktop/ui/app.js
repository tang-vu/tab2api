/* global document, navigator, window */
import { languageOptions, loadLanguage, saveLanguage, translate } from './i18n.js';

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
  tunnelMode: document.querySelector('#tunnel-mode'),
  tunnelDetail: document.querySelector('#tunnel-detail'),
  tunnelPrerequisites: document.querySelector('#tunnel-prerequisites'),
  tunnelHostname: document.querySelector('#tunnel-hostname'),
  installCloudflared: document.querySelector('#install-cloudflared'),
  enableAccess: document.querySelector('#enable-access'),
  enableBearer: document.querySelector('#enable-bearer'),
  disableTunnel: document.querySelector('#disable-tunnel'),
  openTunnelFolder: document.querySelector('#open-tunnel-folder'),
  openSettings: document.querySelector('#open-settings'),
  settingsDialog: document.querySelector('#settings-dialog'),
  languageSelect: document.querySelector('#language-select'),
};

function localSettingsStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const settingsStorage = localSettingsStorage();
const tunnelHostnameStorageKey = 'tab2api.tunnelHostname';
let language = loadLanguage(settingsStorage, navigator.languages ?? [navigator.language]);
let lastServiceStatus;
let lastTunnelStatus;
const t = (key) => translate(language, key);

try {
  elements.tunnelHostname.value = settingsStorage?.getItem(tunnelHostnameStorageKey) ?? '';
} catch {
  elements.tunnelHostname.value = '';
}

function tunnelHostname() {
  return elements.tunnelHostname.value.trim().toLowerCase();
}

function validTunnelHostname() {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
    tunnelHostname(),
  );
}

for (const [code, label] of languageOptions) {
  const option = document.createElement('option');
  option.value = code;
  option.textContent = label;
  elements.languageSelect.append(option);
}

function applyLanguage() {
  document.documentElement.lang = language;
  document.title = t('appTitle');
  elements.languageSelect.value = language;
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  if (lastServiceStatus) render(lastServiceStatus);
  if (lastTunnelStatus) renderTunnel(lastTunnelStatus);
}

function serviceDetail(status) {
  const keys = {
    stopped: 'serviceStopped',
    starting: 'serviceStarting',
    ready: 'serviceReady',
    unhealthy: 'serviceUnhealthy',
    login_open: 'serviceLoginOpen',
  };
  return keys[status.phase] ? t(keys[status.phase]) : status.detail;
}

function render(status) {
  lastServiceStatus = status;
  const labelKeys = {
    stopped: 'stopped',
    starting: 'starting',
    ready: 'ready',
    unhealthy: 'unhealthy',
    login_open: 'loginOpen',
  };
  elements.dot.className = `dot ${status.phase}`;
  elements.label.textContent = labelKeys[status.phase] ? t(labelKeys[status.phase]) : status.phase;
  elements.detail.textContent = serviceDetail(status);
  elements.endpoint.textContent = status.endpoint;
  const modeKeys = {
    none: 'browserNotRunning',
    external: 'browserExternal',
    docked: 'browserDocked',
  };
  elements.browserMode.textContent = t(modeKeys[status.browser_mode] ?? 'browserNotRunning');
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

function tunnelDetail(status) {
  if (status.running) {
    if (status.mode === 'access') return t('tunnelRunningAccess');
    if (status.mode === 'bearer_only') return t('tunnelRunningBearer');
    return t('tunnelRunningUnknown');
  }
  if (status.task_installed) return t('tunnelInstalledStopped');
  if (!status.cloudflared_installed) return t('tunnelNeedsInstall');
  if (!status.config_ready) return t('tunnelNeedsConfig');
  return t('tunnelReady');
}

function renderTunnel(status) {
  lastTunnelStatus = status;
  const modeKeys = {
    none: status.running ? 'tunnelUnknown' : 'tunnelDisabled',
    access: 'tunnelAccess',
    bearer_only: 'tunnelBearer',
  };
  elements.tunnelMode.textContent = status.supported
    ? t(modeKeys[status.mode] ?? 'tunnelUnknown')
    : t('tunnelUnsupported');
  elements.tunnelDetail.textContent = tunnelDetail(status);
  const ready = (value) => t(value ? 'prerequisiteReady' : 'prerequisiteMissing');
  elements.tunnelPrerequisites.textContent = [
    `${t('cloudflared')}: ${ready(status.cloudflared_installed)}`,
    `${t('tunnelConfig')}: ${ready(status.config_ready)}`,
    `${t('accessProbe')}: ${ready(status.access_probe_ready)}`,
  ].join(' / ');
  elements.installCloudflared.disabled = !status.supported || status.cloudflared_installed;
  elements.enableAccess.disabled =
    !status.supported ||
    !status.cloudflared_installed ||
    !status.config_ready ||
    !status.access_probe_ready ||
    status.running ||
    !validTunnelHostname();
  elements.enableBearer.disabled =
    !status.supported ||
    !status.cloudflared_installed ||
    !status.config_ready ||
    status.running ||
    !validTunnelHostname();
  elements.disableTunnel.disabled = !status.supported || !status.task_installed;
  elements.openTunnelFolder.disabled = !status.supported;
}

function localizedError(error) {
  const message = String(error);
  if (message.includes('Cloudflare Access verification or tunnel activation failed')) {
    return t('accessActivationError');
  }
  if (message.includes('bearer-only tunnel task')) return t('bearerActivationError');
  if (message.includes('valid dedicated tunnel hostname')) return t('hostnameError');
  return message;
}

function showError(error) {
  elements.error.textContent = localizedError(error);
  elements.error.hidden = false;
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
      showError(error);
    }
  });
}

async function perform(command) {
  elements.error.hidden = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    render(await invoke(command));
  } catch (error) {
    showError(error);
    await refresh();
  }
}

async function refresh() {
  try {
    render(await invoke('sidecar_status'));
  } catch (error) {
    showError(error);
  }
}

let tunnelRefreshInFlight;
function refreshTunnel() {
  if (tunnelRefreshInFlight) return tunnelRefreshInFlight;
  tunnelRefreshInFlight = invoke('tunnel_status')
    .then(renderTunnel)
    .catch(showError)
    .finally(() => {
      tunnelRefreshInFlight = undefined;
    });
  return tunnelRefreshInFlight;
}

async function performTunnel(command, args) {
  elements.error.hidden = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    renderTunnel(await invoke(command, args));
  } catch (error) {
    showError(error);
  } finally {
    await Promise.all([refresh(), refreshTunnel()]);
  }
}

applyLanguage();

if (typeof invoke !== 'function') {
  elements.error.textContent = t('nativeBridgeError');
  elements.error.hidden = false;
  elements.label.textContent = t('bridgeUnavailable');
  elements.detail.textContent = t('bridgeUnavailableDetail');
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
  elements.installCloudflared.addEventListener('click', () => performTunnel('install_cloudflared'));
  elements.enableAccess.addEventListener('click', () =>
    performTunnel('enable_access_tunnel', { hostname: tunnelHostname() }),
  );
  elements.enableBearer.addEventListener('click', () => {
    if (window.confirm(t('confirmBearer'))) {
      performTunnel('enable_bearer_tunnel', { hostname: tunnelHostname(), accepted: true });
    }
  });
  elements.disableTunnel.addEventListener('click', () => performTunnel('disable_tunnel'));
  elements.openTunnelFolder.addEventListener('click', () => performTunnel('open_tunnel_folder'));
  elements.openSettings.addEventListener('click', () => elements.settingsDialog.showModal());
  elements.languageSelect.addEventListener('change', () => {
    language = elements.languageSelect.value;
    saveLanguage(settingsStorage, language);
    applyLanguage();
  });
  elements.tunnelHostname.addEventListener('input', () => {
    const hostname = tunnelHostname();
    elements.tunnelHostname.value = hostname;
    try {
      settingsStorage?.setItem(tunnelHostnameStorageKey, hostname);
    } catch {
      // Local settings remaining unavailable must not block tunnel status or other controls.
    }
    if (lastTunnelStatus) renderTunnel(lastTunnelStatus);
  });
  new ResizeObserver(queueBrowserBounds).observe(elements.browserHost);
  window.addEventListener('resize', queueBrowserBounds);
  window.addEventListener('scroll', queueBrowserBounds, { passive: true });

  await Promise.all([refresh(), refreshTunnel()]);
  window.setInterval(refresh, 3000);
  window.setInterval(refreshTunnel, 5000);
}

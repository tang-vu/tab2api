/* global document, navigator, window */
import { administrationControls, usageTotals, validKeyLabel } from './admin-view.js';
import { languageOptions, loadLanguage, saveLanguage, translate } from './i18n.js';
import { tunnelControlState, tunnelOperationDetail } from './tunnel-controls.js';
import { viewState } from './view-tabs.js';

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
  showBrowserView: document.querySelector('#show-browser-view'),
  showApiDocs: document.querySelector('#show-api-docs'),
  showAdminView: document.querySelector('#show-admin-view'),
  browserColumn: document.querySelector('#browser-column'),
  apiDocsColumn: document.querySelector('#api-docs-column'),
  adminColumn: document.querySelector('#admin-column'),
  exportApiDocs: document.querySelector('#export-api-docs'),
  docsExportStatus: document.querySelector('#docs-export-status'),
  refreshAdmin: document.querySelector('#refresh-admin'),
  adminStatus: document.querySelector('#admin-status'),
  createKeyForm: document.querySelector('#create-key-form'),
  keyLabel: document.querySelector('#key-label'),
  createKey: document.querySelector('#create-key'),
  keyList: document.querySelector('#key-list'),
  usageList: document.querySelector('#usage-list'),
  showResetUsage: document.querySelector('#show-reset-usage'),
  createdKeyDialog: document.querySelector('#created-key-dialog'),
  createdKeyValue: document.querySelector('#created-key-value'),
  copyCreatedKey: document.querySelector('#copy-created-key'),
  copyKeyStatus: document.querySelector('#copy-key-status'),
  revokeKeyDialog: document.querySelector('#revoke-key-dialog'),
  revokeKeyMessage: document.querySelector('#revoke-key-message'),
  confirmRevokeKey: document.querySelector('#confirm-revoke-key'),
  resetUsageDialog: document.querySelector('#reset-usage-dialog'),
  confirmResetUsage: document.querySelector('#confirm-reset-usage'),
  browserHost: document.querySelector('#browser-host'),
  browserMode: document.querySelector('#browser-mode'),
  tunnelCard: document.querySelector('#tunnel-card'),
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
  bearerDialog: document.querySelector('#bearer-dialog'),
  confirmBearer: document.querySelector('#confirm-bearer'),
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
let tunnelOperation;
let activeView = 'browser';
let requestedNativeBrowserVisibility;
let appliedNativeBrowserVisibility;
let nativeBrowserVisibilityQueue = Promise.resolve();
let adminOperation;
let lastApiKeys;
let lastUsage;
let pendingRevokeKey;
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
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  }
  if (lastApiKeys) renderApiKeys(lastApiKeys);
  if (lastUsage) renderUsage(lastUsage);
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
  const previousPhase = lastServiceStatus?.phase;
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
  if (status.browser_mode === 'docked' && activeView === 'browser') queueBrowserBounds();
  queueNativeBrowserVisibility();
  renderAdministrationControls();
  if (status.phase !== 'ready' && activeView === 'admin') {
    setAdminStatus('adminStartRequired');
  } else if (status.phase === 'ready' && previousPhase !== 'ready' && activeView === 'admin') {
    void refreshAdminData();
  }
}

function queueNativeBrowserVisibility() {
  const state = viewState(activeView, lastServiceStatus?.browser_mode);
  requestedNativeBrowserVisibility = state.nativeBrowserVisible;
  if (typeof requestedNativeBrowserVisibility !== 'boolean' || typeof invoke !== 'function') {
    appliedNativeBrowserVisibility = undefined;
    return;
  }
  nativeBrowserVisibilityQueue = nativeBrowserVisibilityQueue
    .then(async () => {
      const visible = requestedNativeBrowserVisibility;
      if (typeof visible !== 'boolean' || visible === appliedNativeBrowserVisibility) return;
      await invoke('set_browser_visibility', { visible });
      appliedNativeBrowserVisibility = visible;
      if (visible) queueBrowserBounds();
    })
    .catch((error) => {
      appliedNativeBrowserVisibility = undefined;
      showError(error);
    });
}

function showView(view) {
  const state = viewState(view, lastServiceStatus?.browser_mode);
  activeView = state.activeView;
  elements.browserColumn.hidden = state.browserHidden;
  elements.apiDocsColumn.hidden = state.docsHidden;
  elements.adminColumn.hidden = state.adminHidden;
  elements.showBrowserView.classList.toggle('active', activeView === 'browser');
  elements.showApiDocs.classList.toggle('active', activeView === 'docs');
  elements.showAdminView.classList.toggle('active', activeView === 'admin');
  elements.showBrowserView.setAttribute('aria-selected', String(activeView === 'browser'));
  elements.showApiDocs.setAttribute('aria-selected', String(activeView === 'docs'));
  elements.showAdminView.setAttribute('aria-selected', String(activeView === 'admin'));
  queueNativeBrowserVisibility();
  if (activeView === 'browser') queueBrowserBounds();
}

function setAdminStatus(key, isError = false) {
  elements.adminStatus.textContent = t(key);
  elements.adminStatus.classList.toggle('error', isError);
}

function renderAdministrationControls() {
  const controls = administrationControls(lastServiceStatus?.phase, Boolean(adminOperation));
  elements.refreshAdmin.disabled = controls.refreshDisabled;
  elements.createKey.disabled = controls.createDisabled || !validKeyLabel(elements.keyLabel.value);
  elements.keyLabel.disabled = controls.createDisabled;
  elements.showResetUsage.disabled = controls.resetDisabled;
  elements.adminColumn.setAttribute('aria-busy', String(Boolean(adminOperation)));
}

function formatNumber(value) {
  return new Intl.NumberFormat(language).format(Number(value));
}

function formatDate(value) {
  if (value === 'runtime') return t('runtime');
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(language).format(date);
}

function renderApiKeys(result) {
  lastApiKeys = result;
  elements.keyList.replaceChildren();
  const clientKeys = result.data.filter((key) => key.role === 'client');
  if (clientKeys.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = t('keyListEmpty');
    elements.keyList.append(empty);
  }
  for (const key of result.data) {
    const row = document.createElement('article');
    row.className = `key-row${key.revokedAt ? ' revoked' : ''}`;
    const copy = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = key.label;
    const id = document.createElement('code');
    id.textContent = key.id;
    const metadata = document.createElement('span');
    const role = key.role === 'admin' ? t('administrator') : t('client');
    const state = key.revokedAt ? t('revoked') : t('active');
    metadata.textContent = `${role} · ${state} · ${t('created')}: ${formatDate(key.createdAt)}`;
    copy.append(label, id, metadata);
    row.append(copy);
    if (key.role === 'client' && !key.revokedAt) {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'danger-button compact';
      revoke.textContent = t('revokeKey');
      revoke.addEventListener('click', () => {
        pendingRevokeKey = { id: key.id, label: key.label };
        elements.revokeKeyMessage.textContent = `${t('revokeKeyMessage')} “${key.label}”?`;
        elements.revokeKeyDialog.showModal();
      });
      row.append(revoke);
    }
    elements.keyList.append(row);
  }
}

function metric(label, value) {
  const item = document.createElement('span');
  const name = document.createElement('small');
  const number = document.createElement('strong');
  name.textContent = label;
  number.textContent = formatNumber(value);
  item.append(name, number);
  return item;
}

function renderUsage(result) {
  lastUsage = result;
  elements.usageList.replaceChildren();
  if (result.keys.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = t('noUsage');
    elements.usageList.append(empty);
    return;
  }
  for (const entry of result.keys) {
    const totals = usageTotals(entry);
    const details = document.createElement('details');
    details.className = 'usage-entry';
    const summary = document.createElement('summary');
    const identity = document.createElement('span');
    const label = document.createElement('strong');
    const lastUsed = document.createElement('small');
    label.textContent = entry.label;
    lastUsed.textContent = `${t('lastUsed')}: ${formatDate(entry.lastUsedAt)}`;
    identity.append(label, lastUsed);
    const headline = document.createElement('span');
    headline.textContent = `${formatNumber(totals.requests)} ${t('requests')}`;
    summary.append(identity, headline);
    const metrics = document.createElement('div');
    metrics.className = 'usage-metrics';
    metrics.append(
      metric(t('requests'), totals.requests),
      metric(t('successful'), totals.successful),
      metric(t('failed'), totals.failed),
      metric(t('estimatedTokens'), totals.estimatedTokens),
      metric(t('bytes'), totals.bytes),
    );
    const endpointTitle = document.createElement('h3');
    endpointTitle.textContent = t('endpoints');
    const endpointList = document.createElement('div');
    endpointList.className = 'usage-endpoints';
    for (const [endpoint, endpointUsage] of Object.entries(entry.endpoints)) {
      const endpointRow = document.createElement('div');
      const path = document.createElement('code');
      const count = document.createElement('span');
      path.textContent = endpoint;
      count.textContent = `${formatNumber(endpointUsage.requests)} ${t('requests')}`;
      endpointRow.append(path, count);
      endpointList.append(endpointRow);
    }
    details.append(summary, metrics, endpointTitle, endpointList);
    elements.usageList.append(details);
  }
}

async function refreshAdminData() {
  const controls = administrationControls(lastServiceStatus?.phase, Boolean(adminOperation));
  if (!controls.canLoad) {
    setAdminStatus(lastServiceStatus?.phase === 'ready' ? 'adminBusy' : 'adminStartRequired');
    return;
  }
  adminOperation = 'refresh';
  renderAdministrationControls();
  setAdminStatus('adminLoading');
  try {
    const [keys, usage] = await Promise.all([invoke('list_api_keys'), invoke('usage_status')]);
    renderApiKeys(keys);
    renderUsage(usage);
    setAdminStatus('adminReady');
  } catch (error) {
    elements.adminStatus.textContent = localizedError(error);
    elements.adminStatus.classList.add('error');
    showError(error);
  } finally {
    adminOperation = undefined;
    renderAdministrationControls();
  }
}

async function createApiKey() {
  const label = elements.keyLabel.value.trim();
  if (!validKeyLabel(label) || adminOperation) return;
  adminOperation = 'create';
  renderAdministrationControls();
  try {
    const created = await invoke('create_api_key', { label });
    elements.createdKeyValue.textContent = created.token;
    created.token = '';
    elements.copyKeyStatus.hidden = true;
    elements.keyLabel.value = '';
    setAdminStatus('keyCreated');
    elements.createdKeyDialog.showModal();
    await refreshAdminDataAfterMutation();
  } catch (error) {
    showError(error);
  } finally {
    adminOperation = undefined;
    renderAdministrationControls();
  }
}

async function refreshAdminDataAfterMutation() {
  const [keys, usage] = await Promise.all([invoke('list_api_keys'), invoke('usage_status')]);
  renderApiKeys(keys);
  renderUsage(usage);
}

async function revokeApiKey() {
  if (!pendingRevokeKey || adminOperation) return;
  const { id } = pendingRevokeKey;
  elements.revokeKeyDialog.close();
  pendingRevokeKey = undefined;
  adminOperation = 'revoke';
  renderAdministrationControls();
  try {
    await invoke('revoke_api_key', { id });
    await refreshAdminDataAfterMutation();
    setAdminStatus('keyRevoked');
  } catch (error) {
    showError(error);
  } finally {
    adminOperation = undefined;
    renderAdministrationControls();
  }
}

async function resetUsage() {
  if (adminOperation) return;
  elements.resetUsageDialog.close();
  adminOperation = 'reset';
  renderAdministrationControls();
  try {
    await invoke('reset_usage');
    await refreshAdminDataAfterMutation();
    setAdminStatus('usageReset');
  } catch (error) {
    showError(error);
  } finally {
    adminOperation = undefined;
    renderAdministrationControls();
  }
}

async function exportApiDocs() {
  elements.docsExportStatus.hidden = true;
  elements.exportApiDocs.disabled = true;
  try {
    const result = await invoke('export_api_docs');
    elements.docsExportStatus.textContent = `${t('exportSaved')} ${result.fileName}`;
    elements.docsExportStatus.hidden = false;
  } catch (error) {
    showError(error);
  } finally {
    elements.exportApiDocs.disabled = false;
  }
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
  const operationDetail = tunnelOperationDetail(tunnelOperation);
  elements.tunnelDetail.textContent = operationDetail ? t(operationDetail) : tunnelDetail(status);
  const ready = (value) => t(value ? 'prerequisiteReady' : 'prerequisiteMissing');
  elements.tunnelPrerequisites.textContent = [
    `${t('cloudflared')}: ${ready(status.cloudflared_installed)}`,
    `${t('tunnelConfig')}: ${ready(status.config_ready)}`,
    `${t('accessProbe')}: ${ready(status.access_probe_ready)}`,
  ].join(' / ');
  const controls = tunnelControlState(status, validTunnelHostname(), tunnelOperation);
  elements.tunnelCard.setAttribute('aria-busy', String(controls.busy));
  elements.tunnelHostname.disabled = controls.hostnameDisabled;
  elements.installCloudflared.disabled = controls.installDisabled;
  elements.enableAccess.disabled = controls.accessDisabled;
  elements.enableBearer.disabled = controls.bearerDisabled;
  elements.disableTunnel.disabled = controls.disableDisabled;
  elements.openTunnelFolder.disabled = controls.folderDisabled;
}

function localizedError(error) {
  const message = String(error);
  if (message.includes('Cloudflare Access verification or tunnel activation failed')) {
    return t('accessActivationError');
  }
  if (message.includes('bearer-only tunnel task')) return t('bearerActivationError');
  if (message.includes('valid dedicated tunnel hostname')) return t('hostnameError');
  if (message.includes('another Cloudflare Tunnel operation')) return t('tunnelBusyError');
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
  for (const button of [
    elements.start,
    elements.stop,
    elements.login,
    elements.refresh,
    elements.undock,
    elements.redock,
  ]) {
    button.disabled = true;
  }
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
function refreshTunnel(force = false) {
  if (tunnelOperation && !force) return Promise.resolve(lastTunnelStatus);
  if (force && tunnelRefreshInFlight) {
    return tunnelRefreshInFlight.finally(() => refreshTunnel(true));
  }
  if (tunnelRefreshInFlight) return tunnelRefreshInFlight;
  tunnelRefreshInFlight = invoke('tunnel_status')
    .then((status) => {
      if (!tunnelOperation) renderTunnel(status);
      return status;
    })
    .catch(showError)
    .finally(() => {
      tunnelRefreshInFlight = undefined;
    });
  return tunnelRefreshInFlight;
}

async function performTunnel(command, args) {
  if (tunnelOperation) {
    showError(t('tunnelBusyError'));
    return;
  }
  elements.error.hidden = true;
  tunnelOperation = command;
  if (lastTunnelStatus) renderTunnel(lastTunnelStatus);
  try {
    renderTunnel(await invoke(command, args));
  } catch (error) {
    showError(error);
  } finally {
    tunnelOperation = undefined;
    await refreshTunnel(true);
    void refresh();
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
  elements.showBrowserView.addEventListener('click', () => showView('browser'));
  elements.showApiDocs.addEventListener('click', () => showView('docs'));
  elements.showAdminView.addEventListener('click', () => {
    showView('admin');
    void refreshAdminData();
  });
  elements.exportApiDocs.addEventListener('click', () => void exportApiDocs());
  elements.refreshAdmin.addEventListener('click', () => void refreshAdminData());
  elements.keyLabel.addEventListener('input', renderAdministrationControls);
  elements.createKeyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void createApiKey();
  });
  elements.confirmRevokeKey.addEventListener('click', () => void revokeApiKey());
  elements.revokeKeyDialog.addEventListener('close', () => {
    pendingRevokeKey = undefined;
  });
  elements.showResetUsage.addEventListener('click', () => elements.resetUsageDialog.showModal());
  elements.confirmResetUsage.addEventListener('click', () => void resetUsage());
  elements.copyCreatedKey.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(elements.createdKeyValue.textContent);
      elements.copyKeyStatus.textContent = t('copied');
    } catch {
      elements.copyKeyStatus.textContent = t('copyFailed');
    }
    elements.copyKeyStatus.hidden = false;
  });
  elements.createdKeyDialog.addEventListener('close', () => {
    elements.createdKeyValue.textContent = '';
    elements.copyKeyStatus.textContent = '';
    elements.copyKeyStatus.hidden = true;
  });
  elements.installCloudflared.addEventListener('click', () => performTunnel('install_cloudflared'));
  elements.enableAccess.addEventListener('click', () =>
    performTunnel('enable_access_tunnel', { hostname: tunnelHostname() }),
  );
  elements.enableBearer.addEventListener('click', () => elements.bearerDialog.showModal());
  elements.confirmBearer.addEventListener('click', () => {
    elements.bearerDialog.close();
    void performTunnel('enable_bearer_tunnel', {
      hostname: tunnelHostname(),
      accepted: true,
    });
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

  renderAdministrationControls();
  await Promise.all([refresh(), refreshTunnel()]);
  window.setInterval(refresh, 3000);
  window.setInterval(refreshTunnel, 5000);
}

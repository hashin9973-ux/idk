'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowsBridge', Object.freeze({
  getState: () => ipcRenderer.invoke('app:get-state'),
  openDashboard: () => ipcRenderer.invoke('app:open-dashboard'),
  getBrowserTabs: () => ipcRenderer.invoke('app:browser-tabs'),
  openBrowserTab: url => ipcRenderer.invoke('app:browser-open-tab', url),
  openColabTab: () => ipcRenderer.invoke('app:colab-open-tab'),
  setBrowserTabActive: id => ipcRenderer.invoke('app:browser-tab-active', id),
  closeBrowserTab: id => ipcRenderer.invoke('app:browser-tab-close', id),
  setBrowserBounds: bounds => ipcRenderer.invoke('app:browser-bounds', bounds),
  getBrowserSettings: () => ipcRenderer.invoke('app:browser-settings'),
  setBrowserSettings: value => ipcRenderer.invoke('app:browser-settings', value),
  setTtsVolume: value => ipcRenderer.invoke('app:tts-volume', value),
  setTheme: theme => ipcRenderer.invoke('app:set-theme', theme),
  saveDashboardState: state => ipcRenderer.invoke('app:save-dashboard-state', state),
  acknowledgeTrayState: (requestId, state) => ipcRenderer.invoke('app:tray-state-saved', { requestId, state }),
  onPrepareForTray(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value && typeof value === 'object' ? value : {});
    ipcRenderer.on('app:prepare-for-tray', listener);
    return () => ipcRenderer.removeListener('app:prepare-for-tray', listener);
  },
  saveNow: () => ipcRenderer.invoke('app:save-now'),
  getTtsSettings: () => ipcRenderer.invoke('app:tts-settings'),
  getLocalTtsSettings: () => ipcRenderer.invoke('app:local-tts-settings'),
  setLocalTtsSettings: value => ipcRenderer.invoke('app:local-tts-settings', value),
  getLocalTtsStatus: () => ipcRenderer.invoke('app:local-tts-status'),
  prepareLocalTts: () => ipcRenderer.invoke('app:local-tts-prepare'),
  testLocalTts: () => ipcRenderer.invoke('app:local-tts-test'),
  onLocalTtsStatus(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status && typeof status === 'object' ? status : {});
    ipcRenderer.on('app:local-tts-status', listener);
    return () => ipcRenderer.removeListener('app:local-tts-status', listener);
  },
  setTtsSettings: settings => ipcRenderer.invoke('app:tts-settings', settings),
  previewCaptions: () => ipcRenderer.invoke('app:caption-preview'),
  getCloudSyncStatus: () => ipcRenderer.invoke('app:cloud-sync-status'),
  chooseCloudFolder: () => ipcRenderer.invoke('app:cloud-sync-choose-folder'),
  configureCloudSync: value => ipcRenderer.invoke('app:cloud-sync-config', value),
  syncCloudNow: () => ipcRenderer.invoke('app:cloud-sync-now'),
  setRepositoryBridgeConfig: value => ipcRenderer.invoke('app:repository-bridge-config', value),
  onDashboardState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state && typeof state === 'object' ? state : {});
    ipcRenderer.on('app:dashboard-state', listener);
    return () => ipcRenderer.removeListener('app:dashboard-state', listener);
  },
  onPreferences(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value && typeof value === 'object' ? value : {});
    ipcRenderer.on('app:preferences', listener);
    return () => ipcRenderer.removeListener('app:preferences', listener);
  },
  onCloudSyncStatus(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value && typeof value === 'object' ? value : {});
    ipcRenderer.on('app:cloud-sync-status', listener);
    return () => ipcRenderer.removeListener('app:cloud-sync-status', listener);
  },
  onBrowserTabsChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, tabs) => callback(Array.isArray(tabs) ? tabs : []);
    ipcRenderer.on('app:browser-tabs-changed', listener);
    return () => ipcRenderer.removeListener('app:browser-tabs-changed', listener);
  },
  onBrowserTabOpened(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value && typeof value === 'object' ? value : {});
    ipcRenderer.on('app:browser-tab-opened', listener);
    return () => ipcRenderer.removeListener('app:browser-tab-opened', listener);
  },
  onBrowserMemory(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value && typeof value === 'object' ? value : {});
    ipcRenderer.on('app:browser-memory', listener);
    return () => ipcRenderer.removeListener('app:browser-memory', listener);
  },
  onBrowserBoundsRefresh(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('app:browser-bounds-refresh', listener);
    return () => ipcRenderer.removeListener('app:browser-bounds-refresh', listener);
  },
  selectWorkspace: () => ipcRenderer.invoke('app:select-workspace'),
  refreshProjectIndex: () => ipcRenderer.invoke('app:project-index-refresh'),
  selectAgentWorkspace: (agentId, sessionId = null) => ipcRenderer.invoke('app:agent-select-workspace', { agentId, sessionId }),
  addAgentWidget: () => ipcRenderer.invoke('app:agent-widget-add'),
  deleteAgentWidget: (agentId, sessionId = null, wipeMailbox = false) => ipcRenderer.invoke('app:agent-widget-delete', { agentId, sessionId, wipeMailbox }),
  pauseAgentSession: (agentId, sessionId, paused) => ipcRenderer.invoke('app:agent-session-pause', { agentId, sessionId, paused }),
  disconnectAgentSession: (agentId, sessionId) => ipcRenderer.invoke('app:agent-session-disconnect', { agentId, sessionId }),
  setSessionAutoExpire: enabled => ipcRenderer.invoke('app:session-auto-expire', enabled),
  getTaskDashboard: () => ipcRenderer.invoke('app:task-dashboard'),
  getAgentWidgetSettings: agentId => ipcRenderer.invoke('app:agent-widget-settings', { agentId }),
  setAgentWidgetSettings: (agentId, value) => ipcRenderer.invoke('app:agent-widget-settings', { agentId, value }),
  chooseAgentAssignmentWorkspace: () => ipcRenderer.invoke('app:agent-assignment-workspace'),
  respondAgentAssignment: payload => ipcRenderer.invoke('app:agent-assignment-response', payload),
  onAgentAssignmentRequested(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload && typeof payload === 'object' ? payload : {});
    ipcRenderer.on('app:agent-assignment-requested', listener);
    return () => ipcRenderer.removeListener('app:agent-assignment-requested', listener);
  },
  onAgentAssignmentDismissed(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload && typeof payload === 'object' ? payload : {});
    ipcRenderer.on('app:agent-assignment-dismissed', listener);
    return () => ipcRenderer.removeListener('app:agent-assignment-dismissed', listener);
  },
  sendAgentMessage: (sessionId, message) => ipcRenderer.invoke('app:agent-send-message', { sessionId, message }),
  readAgentReplies: (sessionId, messageIds) => ipcRenderer.invoke('app:agent-read-replies', { sessionId, messageIds }),
  setAutoAcceptAll: enabled => ipcRenderer.invoke('app:set-auto-accept-all', enabled),
  minimizeToTray: () => ipcRenderer.invoke('app:minimize-to-tray'),
  quit: () => ipcRenderer.invoke('app:quit'),
  getGitHubState: () => ipcRenderer.invoke('app:github-state'),
  onGitHubState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state && typeof state === 'object' ? state : {});
    ipcRenderer.on('app:github-state', listener);
    return () => ipcRenderer.removeListener('app:github-state', listener);
  },
  onColabHandoffResult(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, result) => callback(result && typeof result === 'object' ? result : {});
    ipcRenderer.on('app:colab-handoff-result', listener);
    return () => ipcRenderer.removeListener('app:colab-handoff-result', listener);
  },
  getVisionStatus: () => ipcRenderer.invoke('app:vision-status'),
  getObserveStatus: () => ipcRenderer.invoke('app:observe-status'),
  setObserveEnabled: enabled => ipcRenderer.invoke('app:observe-toggle', enabled),
  setObserveFps: fps => ipcRenderer.invoke('app:observe-fps', fps),
  connectColab: endpointUrl => ipcRenderer.invoke('app:vision-connect-colab', endpointUrl),
  setVisionManualPanel: visible => ipcRenderer.invoke('app:vision-manual-panel', visible),
  checkVisionSetup: () => ipcRenderer.invoke('app:vision-setup-check'),
  retryConnection: () => ipcRenderer.invoke('app:retry-connection'),
  startGitHubLogin: () => ipcRenderer.invoke('app:github-start-login'),
  reconnectGitHub: () => ipcRenderer.invoke('app:github-reconnect'),
  pollGitHubLogin: () => ipcRenderer.invoke('app:github-poll-login'),
  copyDeviceCode: code => ipcRenderer.invoke('app:copy-device-code', code),
  onGitHubDeviceCode(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, code) => callback(typeof code === 'string' ? code : '');
    ipcRenderer.on('app:github-device-code', listener);
    return () => ipcRenderer.removeListener('app:github-device-code', listener);
  },
  onBridgeState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state && typeof state === 'object' ? state : {});
    ipcRenderer.on('app:bridge-state', listener);
    return () => ipcRenderer.removeListener('app:bridge-state', listener);
  }
}));

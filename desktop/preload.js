'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowsBridge', Object.freeze({
  getState: () => ipcRenderer.invoke('app:get-state'),
  openDashboard: () => ipcRenderer.invoke('app:open-dashboard'),
  showOverlay: () => ipcRenderer.invoke('app:show-overlay'),
  getBrowserTabs: () => ipcRenderer.invoke('app:browser-tabs'),
  openBrowserTab: url => ipcRenderer.invoke('app:browser-open-tab', url),
  openColabTab: () => ipcRenderer.invoke('app:colab-open-tab'),
  setBrowserTabActive: id => ipcRenderer.invoke('app:browser-tab-active', id),
  closeBrowserTab: id => ipcRenderer.invoke('app:browser-tab-close', id),
  setBrowserBounds: bounds => ipcRenderer.invoke('app:browser-bounds', bounds),
  getBrowserSettings: () => ipcRenderer.invoke('app:browser-settings'),
  setBrowserSettings: value => ipcRenderer.invoke('app:browser-settings', value),
  setTtsVolume: value => ipcRenderer.invoke('app:tts-volume', value),
  setRepositoryBridgeConfig: value => ipcRenderer.invoke('app:repository-bridge-config', value),
  onBrowserTabsChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, tabs) => callback(Array.isArray(tabs) ? tabs : []);
    ipcRenderer.on('app:browser-tabs-changed', listener);
    return () => ipcRenderer.removeListener('app:browser-tabs-changed', listener);
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

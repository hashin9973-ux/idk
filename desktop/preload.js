'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowsBridge', Object.freeze({
  getState: () => ipcRenderer.invoke('app:get-state'),
  selectWorkspace: () => ipcRenderer.invoke('app:select-workspace'),
  setAutoAcceptAll: enabled => ipcRenderer.invoke('app:set-auto-accept-all', enabled),
  minimizeToTray: () => ipcRenderer.invoke('app:minimize-to-tray'),
  quit: () => ipcRenderer.invoke('app:quit'),
  getGitHubState: () => ipcRenderer.invoke('app:github-state'),
  getVisionStatus: () => ipcRenderer.invoke('app:vision-status'),
  getObserveStatus: () => ipcRenderer.invoke('app:observe-status'),
  setObserveEnabled: enabled => ipcRenderer.invoke('app:observe-toggle', enabled),
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

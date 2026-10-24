'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowsBridge', Object.freeze({
  getState: () => ipcRenderer.invoke('app:get-state'),
  saveBridgeConfig: config => ipcRenderer.invoke('app:save-bridge-config', config),
  startBridge: () => ipcRenderer.invoke('app:start-bridge'),
  stopBridge: () => ipcRenderer.invoke('app:stop-bridge'),
  selectWorkspace: () => ipcRenderer.invoke('app:select-workspace'),
  openChatGPT: () => ipcRenderer.invoke('app:open-chatgpt'),
  openGitHubOAuthSettings: () => ipcRenderer.invoke('app:open-github-oauth-settings'),
  collapse: () => ipcRenderer.invoke('app:collapse'),
  expand: () => ipcRenderer.invoke('app:expand'),
  quit: () => ipcRenderer.invoke('app:quit'),
  getGitHubState: () => ipcRenderer.invoke('app:github-state'),
  setGitHubClientId: clientId => ipcRenderer.invoke('app:github-set-client-id', clientId),
  startGitHubLogin: () => ipcRenderer.invoke('app:github-start-login'),
  pollGitHubLogin: () => ipcRenderer.invoke('app:github-poll-login'),
  logoutGitHub: () => ipcRenderer.invoke('app:github-logout'),
  onBridgeState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state && typeof state === 'object' ? state : {});
    ipcRenderer.on('app:bridge-state', listener);
    return () => ipcRenderer.removeListener('app:bridge-state', listener);
  },
  onWorkspaceChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, root) => callback(String(root || ''));
    ipcRenderer.on('app:workspace-changed', listener);
    return () => ipcRenderer.removeListener('app:workspace-changed', listener);
  },
  onCollapsedChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, collapsed) => callback(Boolean(collapsed));
    ipcRenderer.on('app:collapsed-changed', listener);
    return () => ipcRenderer.removeListener('app:collapsed-changed', listener);
  }
}));

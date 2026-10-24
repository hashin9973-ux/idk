const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assistantOverlay', Object.freeze({
  collapse: () => ipcRenderer.invoke('overlay:collapse'),
  expand: () => ipcRenderer.invoke('overlay:expand'),
  reloadChat: () => ipcRenderer.invoke('overlay:reload-chat'),
  openInBrowser: () => ipcRenderer.invoke('overlay:open-in-browser'),
  quit: () => ipcRenderer.invoke('overlay:quit'),
  selectWorkspace: () => ipcRenderer.invoke('overlay:select-workspace'),
  getWorkspace: () => ipcRenderer.invoke('overlay:get-workspace'),
  openAccounts: () => ipcRenderer.invoke('overlay:open-accounts'),
  openChatGPTLogin: () => ipcRenderer.invoke('overlay:open-chatgpt-login'),
  getGitHubState: () => ipcRenderer.invoke('overlay:github-state'),
  setGitHubClientId: (clientId) => ipcRenderer.invoke('overlay:github-set-client-id', clientId),
  startGitHubLogin: () => ipcRenderer.invoke('overlay:github-start-login'),
  pollGitHubLogin: () => ipcRenderer.invoke('overlay:github-poll-login'),
  logoutGitHub: () => ipcRenderer.invoke('overlay:github-logout'),\n  setGitHubBridgeConfig: (config) => ipcRenderer.invoke('overlay:github-set-bridge-config', config),\n  getRepositoryBridgeStatus: () => ipcRenderer.invoke('overlay:repository-bridge-status'),
  onRepositoryBridgeStatus(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status && typeof status === 'object' ? status : {});
    ipcRenderer.on('overlay:repository-bridge-status-changed', listener);
    return () => ipcRenderer.removeListener('overlay:repository-bridge-status-changed', listener);
  },
  onWorkspaceChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, workspaceRoot) => callback(String(workspaceRoot || ''));
    ipcRenderer.on('overlay:workspace-changed', listener);
    return () => ipcRenderer.removeListener('overlay:workspace-changed', listener);
  },
  onCollapsedChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, collapsed) => callback(Boolean(collapsed));
    ipcRenderer.on('overlay:collapsed-changed', listener);
    return () => ipcRenderer.removeListener('overlay:collapsed-changed', listener);
  }
}));

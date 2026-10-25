'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowsBridge', Object.freeze({
  getState: () => ipcRenderer.invoke('app:get-state'),
  minimizeToTray: () => ipcRenderer.invoke('app:minimize-to-tray'),
  quit: () => ipcRenderer.invoke('app:quit'),
  getGitHubState: () => ipcRenderer.invoke('app:github-state'),
  startGitHubLogin: () => ipcRenderer.invoke('app:github-start-login'),
  pollGitHubLogin: () => ipcRenderer.invoke('app:github-poll-login'),
  onBridgeState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state && typeof state === 'object' ? state : {});
    ipcRenderer.on('app:bridge-state', listener);
    return () => ipcRenderer.removeListener('app:bridge-state', listener);
  }
}));

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assistantOverlay', Object.freeze({
  collapse: () => ipcRenderer.invoke('overlay:collapse'),
  expand: () => ipcRenderer.invoke('overlay:expand'),
  reloadChat: () => ipcRenderer.invoke('overlay:reload-chat'),
  openInBrowser: () => ipcRenderer.invoke('overlay:open-in-browser'),
  quit: () => ipcRenderer.invoke('overlay:quit'),
  selectWorkspace: () => ipcRenderer.invoke('overlay:select-workspace'),
  getWorkspace: () => ipcRenderer.invoke('overlay:get-workspace'),
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

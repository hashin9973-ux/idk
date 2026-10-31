'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('speechCaption', Object.freeze({
  onUpdate(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value && typeof value === 'object' ? value : {});
    ipcRenderer.on('caption:update', listener);
    return () => ipcRenderer.removeListener('caption:update', listener);
  },
  play: () => ipcRenderer.invoke('caption:play'),
  navigate: direction => ipcRenderer.invoke('caption:navigate', direction),
  togglePause: () => ipcRenderer.invoke('caption:pause-toggle'),
  dismiss: () => ipcRenderer.invoke('caption:dismiss')
}));

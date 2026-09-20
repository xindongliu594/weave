const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('connection', Object.freeze({ read: () => ipcRenderer.invoke('connection:read'), save: input => ipcRenderer.invoke('connection:save', input) }));

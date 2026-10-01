const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('connection', Object.freeze({ read: () => ipcRenderer.invoke('connection:read'), save: input => ipcRenderer.invoke('connection:save', input) }));
contextBridge.exposeInMainWorld('localExecution',Object.freeze({read:()=>ipcRenderer.invoke('local:read'),choose:()=>ipcRenderer.invoke('local:choose'),enable:input=>ipcRenderer.invoke('local:enable',input),disable:()=>ipcRenderer.invoke('local:disable')}));

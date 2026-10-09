const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pickFolder', () => ipcRenderer.invoke('pick-folder'));
contextBridge.exposeInMainWorld('refocus', () => ipcRenderer.send('refocus'));

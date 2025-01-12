import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('backend', {
  saveConfig: (query) => ipcRenderer.invoke('save-config', query),
  loadConfig: () => ipcRenderer.invoke('load-config'),
});

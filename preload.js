'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  call: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (cb) => {
    const h = (_e, msg) => cb(msg);
    ipcRenderer.on('evt', h);
    return () => ipcRenderer.removeListener('evt', h);
  },
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
});

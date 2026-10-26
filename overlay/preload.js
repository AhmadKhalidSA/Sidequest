const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sq', {
  onEngine: (cb) => ipcRenderer.on('engine', (_e, ev) => cb(ev)),
  onUi: (cb) => ipcRenderer.on('ui', (_e, msg) => cb(msg)),
  send: (cmd) => ipcRenderer.send('cmd', cmd),
  ui: (msg) => ipcRenderer.send('ui', msg),
  pathForFile: (file) => webUtils.getPathForFile(file),
});

// NEONFALL preload — exposes the desktop bridge to the renderer.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('neonfallBridge', {
  isDesktop: true,
  version: '0.2.9',
  appPath: '',
  listCharts: () => ipcRenderer.invoke('nf-list-charts'),
  readChart: (id) => ipcRenderer.invoke('nf-read-chart', id),
  readBundledChart: (name) => ipcRenderer.invoke('nf-read-bundled-chart', name),
  writeChart: (id, name, b64) => ipcRenderer.invoke('nf-write-chart', id, name, b64),
  deleteChart: (id) => ipcRenderer.invoke('nf-delete-chart', id),
  listSkins: () => ipcRenderer.invoke('nf-list-skins'),
  readSkin: (id) => ipcRenderer.invoke('nf-read-skin', id),
  writeSkin: (id, name, b64) => ipcRenderer.invoke('nf-write-skin', id, name, b64),
  deleteSkin: (id) => ipcRenderer.invoke('nf-delete-skin', id),
  pickFiles: () => ipcRenderer.invoke('nf-pick-files'),
  quit: () => ipcRenderer.send('nf-quit'),
});

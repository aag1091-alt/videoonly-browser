'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vo', {
  platform: process.platform,
  navigate: (input) => ipcRenderer.send('ui:navigate', String(input || '')),
  back: () => ipcRenderer.send('ui:back'),
  forward: () => ipcRenderer.send('ui:forward'),
  reload: () => ipcRenderer.send('ui:reload'),
  stop: () => ipcRenderer.send('ui:stop'),
  toggleVideoOnly: () => ipcRenderer.send('ui:toggle-video-only'),
  videoOnlyMenu: () => ipcRenderer.send('ui:video-only-menu'),
  settingsMenu: () => ipcRenderer.send('ui:settings-menu'),
  blockedMenu: () => ipcRenderer.send('ui:blocked-menu'),
  openBlocked: (url) => ipcRenderer.send('ui:open-blocked', String(url || '')),
  dismissNotice: () => ipcRenderer.send('ui:dismiss-notice'),
  focusContent: () => ipcRenderer.send('ui:focus-content'),
  ready: () => ipcRenderer.send('ui:ready'),
  onState: (cb) => ipcRenderer.on('vo:state', (_e, state) => cb(state)),
  onFocusUrl: (cb) => ipcRenderer.on('vo:focus-url', () => cb()),
});

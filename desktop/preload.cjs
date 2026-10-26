'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const call = name => async value => {
  const result = await ipcRenderer.invoke('wallet:' + name, value);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('wallet', Object.freeze({
  unlock: call('unlock'), lock: call('lock'),
  onLocked: callback => { const listener = () => callback(); ipcRenderer.on('wallet:locked', listener); return () => ipcRenderer.removeListener('wallet:locked', listener); },
  state: call('state'), create: call('create'), import: call('import'),
  delegation: call('delegation'), copySupport: call('copySupport'),
  backup: call('backup'), balance: call('balance'), sync: call('sync'), send: call('send'),
  settings: call('settings'), copyAddress: call('copyAddress'), docs: call('docs')
}));

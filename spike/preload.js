'use strict';
// Стенд работает в тех же условиях, что и основное окно: contextIsolation + sandbox.
// Параметры стратегии приходят из main через additionalArguments (в sandbox это process.argv).
const { contextBridge, ipcRenderer } = require('electron');

const arg = (name) => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => typeof a === 'string' && a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

const strategy = arg('spike-strategy') || 'classic';

contextBridge.exposeInMainWorld('spike', {
  strategy,
  vsUrl: arg('spike-vs') || '',
  done: (payload) => ipcRenderer.send(`spike:done:${strategy}`, payload),
});

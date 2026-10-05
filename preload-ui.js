'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'state:get', 'project:add', 'project:remove', 'project:bind',
  'fs:list', 'file:open',
  'proposals:list', 'proposal:dismiss', 'proposals:dismissAll', 'proposal:get', 'proposal:retarget', 'proposal:apply', 'proposal:reject', 'proposal:fromClipboard',
  'history:list', 'history:view', 'history:revert',
  'backups:stats', 'backups:clear',
  'prompt:get', 'prompt:tree', 'prompt:save-draft', 'prompt:set-excluded', 'prompt:build', 'prompt:copy', 'prompt:copy-reminder', 'prompt:copy-files',
  'prompt:preset-save', 'prompt:preset-load', 'prompt:preset-delete', 'prompt:reset',
  'layout:drag-start', 'layout:set', 'layout:drag-end',
]);
const EVENTS = new Set(['chat:changed', 'chat:tokens', 'proposals:changed', 'projects:changed', 'files:changed']);

contextBridge.exposeInMainWorld('api', {
  invoke(channel, arg) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error('Unknown channel: ' + channel));
    return ipcRenderer.invoke(channel, arg);
  },
  on(channel, cb) {
    if (!EVENTS.has(channel)) throw new Error('Unknown event: ' + channel);
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});

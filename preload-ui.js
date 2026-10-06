'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'state:get', 'project:add', 'project:remove', 'project:bind', 'project:pending',
  'fs:list', 'file:open',
  'file:read', 'file:write', 'file:hashes',
  'proposals:list', 'proposal:dismiss', 'proposals:dismissAll', 'proposal:get', 'proposal:retarget', 'proposal:apply', 'proposal:reject', 'proposal:fromClipboard',
  'history:list', 'history:view', 'history:revert',
  'backups:stats', 'backups:clear',
  'prompt:get', 'prompt:tree', 'prompt:save-draft', 'prompt:set-excluded', 'prompt:build', 'prompt:copy', 'prompt:copy-reminder', 'prompt:copy-files',
  'prompt:preset-save', 'prompt:preset-load', 'prompt:preset-delete', 'prompt:reset', 'proposals:report', 'manual:list', 'manual:view', 'manual:copy', 'proposal:merge',
  'layout:drag-start', 'layout:set', 'layout:drag-end',
]);
const EVENTS = new Set(['chat:changed', 'proposals:changed', 'projects:changed', 'files:changed', 'project:auto-bound']);

// В sandbox-преалоде доступен только process.argv: так main передаёт то, что требует fs
// (например, абсолютный путь к AMD-сборке Monaco в dev и в app.asar.unpacked).
const argvValue = (name) => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => typeof a === 'string' && a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

contextBridge.exposeInMainWorld('api', {
  monacoVs: argvValue('monaco-vs'),
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

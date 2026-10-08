'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const INVOKE = new Set([
  'state:get', 'project:add', 'project:remove', 'project:bind', 'project:pending',
  'fs:list', 'file:open',
  'file:read', 'file:write', 'file:hashes',
  'proposals:list', 'proposal:dismiss', 'proposals:dismissAll', 'proposal:get', 'proposal:retarget', 'proposal:apply', 'proposal:reject', 'proposal:fromClipboard',
  // пометка «выполнено» для предложений запуска и команд (&RUN:/&CMD:)
  'proposal:executed',
  'history:list', 'history:view', 'history:revert',
  'backups:stats', 'backups:clear',
  'prompt:get', 'prompt:tree', 'prompt:save-draft', 'prompt:set-excluded', 'prompt:build', 'prompt:copy', 'prompt:copy-reminder', 'prompt:copy-files',
  'prompt:preset-save', 'prompt:preset-load', 'prompt:preset-delete', 'prompt:reset', 'proposals:report', 'manual:view', 'manual:copy', 'context:list', 'context:ack', 'context:ack-all', 'context:known', 'proposal:merge',
  'layout:save',
  // запуск (этап C3): старт/остановка сессии и отчёт в буфер обмена
  'run:start', 'run:stop', 'run:copy-report',
  // настройки запуска (этап C3b): обнаружение инструментов, выбор файла, чтение/запись config.run
  'tools:detect', 'tools:pick', 'settings:get', 'settings:save',
]);
// run:data/run:exit/run:state — поток вывода терминала и состояние сессии (ТЗ C3 §3.4)
const EVENTS = new Set(['chat:changed', 'proposals:changed', 'projects:changed', 'files:changed', 'project:auto-bound', 'run:data', 'run:exit', 'run:state']);
// Fire-and-forget (ipcRenderer.send): геометрия чата меняется каждый кадр перетаскивания
// разделителя, и invoke с его round-trip только бы отставал (ТЗ §4). Ответ не нужен —
// main просто применяет прямоугольник к WebContentsView.
// run:input/run:resize — ввод с клавиатуры и размер терминала: та же причина,
// нажатие обязано уходить в pty мгновенно, без round-trip.
const SEND = new Set(['chat:set-bounds', 'chat:set-visible', 'run:input', 'run:resize']);

// В sandbox-преалоде доступен только process.argv: так main передаёт то, что требует fs
// (например, абсолютный путь к AMD-сборке Monaco в dev и в app.asar.unpacked).
const argvValue = (name) => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => typeof a === 'string' && a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

contextBridge.exposeInMainWorld('api', {
  monacoVs: argvValue('monaco-vs'),
  // getBoundingClientRect отдаёт CSS-пиксели, а setBounds работает в DIP: при zoom ≠ 1
  // их надо делить на коэффициент. В приложении zoom штатно не меняется, но меню
  // «Вид» содержит zoomIn/zoomOut, поэтому страховка дешёвая и осознанная.
  zoomFactor: () => webFrame.getZoomFactor(),
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
  send(channel, arg) {
    if (!SEND.has(channel)) throw new Error('Unknown channel: ' + channel);
    ipcRenderer.send(channel, arg);
  },
});

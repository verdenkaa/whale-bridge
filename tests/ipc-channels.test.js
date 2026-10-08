'use strict';
// Сверка IPC-каналов между main.js, preload-ui.js и renderer.
//
// Каналы объявлены в трёх файлах сразу, и расхождение между ними не ловится ничем другим:
// приложение просто молча не делает то, что должно (preload отклоняет неизвестный канал,
// а отсутствующий handle в main даёт «No handler registered for ...» уже в рантайме).
// Electron здесь не нужен — проверяем исходники как текст.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const main = read('main.js');
const preload = read('preload-ui.js');
const app = read('ui/app.js');
const editor = read('ui/editor.js');

/** Все строковые литералы внутри блока `const NAME = new Set([...]);` */
function setFrom(source, name) {
  const start = source.indexOf(`const ${name} = new Set([`);
  assert.ok(start >= 0, `в preload-ui.js не найден набор ${name}`);
  const end = source.indexOf(']);', start);
  assert.ok(end > start, `набор ${name} не закрыт`);
  const body = source.slice(start, end);
  return new Set([...body.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

const all = (source, re) => [...source.matchAll(re)].map((m) => m[1]);

const INVOKE = setFrom(preload, 'INVOKE');
const EVENTS = setFrom(preload, 'EVENTS');
const SEND = setFrom(preload, 'SEND');

// main: handle('channel', ...)
const handled = new Set(all(main, /handle\('([^']+)'/g));
// main: ipcMain.on('channel', ...) — fire-and-forget приём
const received = new Set(all(main, /ipcMain\.on\('([^']+)'/g));
// renderer: call('channel' | api.invoke('channel'
const invoked = new Set([...all(app, /(?:call|api\.invoke)\('([^']+)'/g), ...all(editor, /(?:call|api\.invoke)\('([^']+)'/g)]);
// renderer: api.send('channel' — геометрия чата (этап B, без ответа)
const sentByUi = new Set([...all(app, /api\.send\('([^']+)'/g), ...all(editor, /api\.send\('([^']+)'/g)]);
// renderer: api.on('channel'
const listened = new Set(all(app, /api\.on\('([^']+)'/g));
// main: send('channel'
const sent = new Set(all(main, /send\('([^']+)'/g));

test('ipc: каждый канал renderer разрешён в preload', () => {
  const forbidden = [...invoked].filter((c) => !INVOKE.has(c));
  assert.deepEqual(forbidden, [], 'preload отклонит эти каналы: ' + forbidden.join(', '));
});

test('ipc: каждый разрешённый канал действительно обрабатывается в main', () => {
  const missing = [...INVOKE].filter((c) => !handled.has(c));
  assert.deepEqual(missing, [], 'в main.js нет handle() для: ' + missing.join(', '));
});

test('ipc: в main нет обработчиков, недоступных из renderer', () => {
  // handle() без записи в INVOKE — мёртвый код: до него нельзя добраться
  const unreachable = [...handled].filter((c) => !INVOKE.has(c));
  assert.deepEqual(unreachable, [], 'не внесены в белый список preload: ' + unreachable.join(', '));
});

test('ipc: каждое событие, которое слушает renderer, разрешено в preload', () => {
  const forbidden = [...listened].filter((c) => !EVENTS.has(c));
  assert.deepEqual(forbidden, [], 'preload бросит Unknown event для: ' + forbidden.join(', '));
});

test('ipc: каждое событие из main можно принять в renderer', () => {
  const missing = [...sent].filter((c) => !EVENTS.has(c));
  assert.deepEqual(missing, [], 'send() уходит в никуда, канала нет в EVENTS: ' + missing.join(', '));
});

test('ipc: каналы редактора Stage A на месте и разрешены', () => {
  for (const c of ['file:read', 'file:write', 'file:hashes']) {
    assert.ok(INVOKE.has(c), `${c} не в белом списке preload`);
    assert.ok(handled.has(c), `${c} не обрабатывается в main`);
  }
  // редактор действительно ими пользуется, а не они добавлены «на всякий случай»
  assert.ok(invoked.has('file:read') && invoked.has('file:write') && invoked.has('file:hashes'));
});

test('ipc: каналы не пересекаются между invoke и событиями', () => {
  const both = [...INVOKE].filter((c) => EVENTS.has(c));
  assert.deepEqual(both, [], 'одно имя используется и как запрос, и как событие: ' + both.join(', '));
});

// ---- этап B: fire-and-forget каналы геометрии (§4, §28) ----

test('ipc: send-каналы renderer разрешены в preload и принимаются в main', () => {
  assert.ok(sentByUi.size > 0, 'renderer не отправляет ни одного send-канала — проверка ничего не стоит');
  const forbidden = [...sentByUi].filter((c) => !SEND.has(c));
  assert.deepEqual(forbidden, [], 'preload бросит Unknown channel для: ' + forbidden.join(', '));
  const missing = [...SEND].filter((c) => !received.has(c));
  assert.deepEqual(missing, [], 'в main.js нет ipcMain.on() для: ' + missing.join(', '));
});

test('ipc: каналы геометрии чата на месте, старая схема layout:drag-* удалена', () => {
  for (const c of ['chat:set-bounds', 'chat:set-visible']) {
    assert.ok(SEND.has(c), `${c} не в белом списке SEND preload`);
    assert.ok(received.has(c), `${c} не принимается в main`);
    assert.ok(sentByUi.has(c), `${c} разрешён, но renderer его не использует`);
  }
  // main больше не считает геометрию (§28): прежних каналов разделителя быть не должно
  for (const c of ['layout:drag-start', 'layout:set', 'layout:drag-end']) {
    assert.ok(!INVOKE.has(c), `${c} остался в белом списке preload`);
    assert.ok(!handled.has(c), `${c} остался в main`);
  }
  // сохранение раскладки — обычный invoke с ответом
  assert.ok(INVOKE.has('layout:save') && handled.has('layout:save') && invoked.has('layout:save'));
});

test('ipc: send-каналы не пересекаются с invoke и событиями', () => {
  const asInvoke = [...SEND].filter((c) => INVOKE.has(c));
  const asEvent = [...SEND].filter((c) => EVENTS.has(c));
  assert.deepEqual(asInvoke, [], 'send-канал одновременно в INVOKE: ' + asInvoke.join(', '));
  assert.deepEqual(asEvent, [], 'send-канал одновременно в EVENTS: ' + asEvent.join(', '));
});

// ---- этап C3: каналы запуска и терминала (ТЗ §3.4) ----

const terminal = read('ui/terminal.js');
const invokedByTerminal = new Set(all(terminal, /post\('([^']+)'/g));
const listenedAll = new Set([...listened, ...all(terminal, /api\.on\('([^']+)'/g)]);

test('ipc: invoke-каналы запуска на месте и разрешены', () => {
  for (const c of ['run:start', 'run:stop', 'run:copy-report']) {
    assert.ok(INVOKE.has(c), `${c} не в белом списке INVOKE preload`);
    assert.ok(handled.has(c), `${c} не обрабатывается в main`);
    assert.ok(invoked.has(c), `${c} разрешён, но renderer его не вызывает`);
    assert.ok(!EVENTS.has(c) && !SEND.has(c), `${c} не должен пересекаться с событиями и send`);
  }
});

test('ipc: send-каналы терминала на месте и принимаются в main', () => {
  for (const c of ['run:input', 'run:resize']) {
    assert.ok(SEND.has(c), `${c} не в белом списке SEND preload`);
    assert.ok(received.has(c), `${c} не принимается в main (ipcMain.on)`);
    assert.ok(invokedByTerminal.has(c), `${c} разрешён, но терминал его не использует`);
    assert.ok(!INVOKE.has(c) && !EVENTS.has(c), `${c} не должен пересекаться с invoke и событиями`);
  }
});

test('ipc: события потока вывода на месте и слушаются renderer', () => {
  for (const c of ['run:data', 'run:exit', 'run:state']) {
    assert.ok(EVENTS.has(c), `${c} не в белом списке EVENTS preload`);
    assert.ok(sent.has(c), `main никогда не отправляет ${c}`);
    assert.ok(listenedAll.has(c), `${c} никто не слушает в renderer`);
    assert.ok(!INVOKE.has(c) && !SEND.has(c), `${c} не должен пересекаться с invoke и send`);
  }
});

// ---- этап C3b: каналы настроек запуска (ТЗ §2.4, §3.4) ----

test('ipc: invoke-каналы настроек запуска на месте и разрешены', () => {
  for (const c of ['tools:detect', 'tools:pick', 'settings:get', 'settings:save']) {
    assert.ok(INVOKE.has(c), `${c} не в белом списке INVOKE preload`);
    assert.ok(handled.has(c), `${c} не обрабатывается в main`);
    assert.ok(invoked.has(c), `${c} разрешён, но renderer его не вызывает`);
    assert.ok(!EVENTS.has(c) && !SEND.has(c), `${c} не должен пересекаться с событиями и send`);
  }
});

test('ipc: каналы настроек не дублируют каналы запуска', () => {
  const run = new Set(['run:start', 'run:stop', 'run:copy-report', 'run:input', 'run:resize', 'run:data', 'run:exit', 'run:state']);
  const settings = new Set(['tools:detect', 'tools:pick', 'settings:get', 'settings:save']);
  assert.deepEqual([...settings].filter((c) => run.has(c)), [], 'имена каналов не пересекаются');
  // запись конфига — только через settings:save: renderer не умеет писать config.json напрямую
  assert.match(main, /handle\('settings:save'[\s\S]{0,400}sanitizeRunConfig/, 'settings:save чистит присланный конфиг');
});

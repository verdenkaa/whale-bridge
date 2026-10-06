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

// main: handle('channel', ...)
const handled = new Set(all(main, /handle\('([^']+)'/g));
// renderer: call('channel' | api.invoke('channel'
const invoked = new Set([...all(app, /(?:call|api\.invoke)\('([^']+)'/g), ...all(editor, /(?:call|api\.invoke)\('([^']+)'/g)]);
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

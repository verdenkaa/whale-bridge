'use strict';
// Журнал контекста: учёт того, какую версию файла знает модель в конкретном чате.
const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../src/context');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const D = 'd'.repeat(64);
const CHAT = '17b45023-2aba-4a1a-a966-17bbe41926ea';
const OTHER = '27b45023-2aba-4a1a-a966-17bbe41926eb';

const rec = (known, extra = {}) => C.record(known, CHAT, { projectId: 'p1', relPath: 'a.gd', hash: A, source: 'applied', ...extra });

test('context: запись и чтение известной модели версии', () => {
  const known = {};
  assert.equal(C.knownVersion(known, CHAT, 'p1', 'a.gd'), null);
  assert.equal(rec(known), true);

  const v = C.knownVersion(known, CHAT, 'p1', 'a.gd');
  assert.equal(v.hash, A);
  assert.equal(v.source, 'applied');
  assert.equal(v.historyId, null);
  assert.ok(typeof v.ts === 'number');

  // повторная запись перезаписывает: знать две версии сразу модель не может
  rec(known, { hash: B, source: 'ack' });
  assert.equal(C.knownVersion(known, CHAT, 'p1', 'a.gd').hash, B);
  assert.equal(C.knownVersion(known, CHAT, 'p1', 'a.gd').source, 'ack');
});

test('context: запись отклоняет мусор и ничего не портит', () => {
  const known = {};
  rec(known);
  const before = JSON.stringify(known);
  assert.equal(C.record(known, CHAT, { projectId: 'p1', relPath: 'a.gd', hash: B, source: 'не-источник' }), false);
  assert.equal(C.record(known, CHAT, { projectId: 'p1', relPath: 'a.gd', hash: '', source: 'ack' }), false);
  assert.equal(C.record(known, '', { projectId: 'p1', relPath: 'a.gd', hash: B, source: 'ack' }), false);
  assert.equal(C.record(known, CHAT, { projectId: '', relPath: 'a.gd', hash: B, source: 'ack' }), false);
  assert.equal(C.record(known, CHAT, null), false);
  assert.equal(C.record(null, CHAT, { projectId: 'p1', relPath: 'a.gd', hash: B, source: 'ack' }), false);
  assert.equal(JSON.stringify(known), before, 'отклонённые записи не изменили журнал');
  for (const s of C.SOURCES) {
    const k = {};
    assert.equal(C.record(k, CHAT, { projectId: 'p', relPath: 'r', hash: A, source: s }), true, s);
  }
});

test('context: знание привязано к чату, а не к проекту', () => {
  const known = {};
  rec(known);
  assert.equal(C.knownVersion(known, CHAT, 'p1', 'a.gd').hash, A);
  // в другом чате модель эту версию не видела
  assert.equal(C.knownVersion(known, OTHER, 'p1', 'a.gd'), null);
  // и в другом проекте — тоже другой файл
  assert.equal(C.knownVersion(known, CHAT, 'p2', 'a.gd'), null);
  C.record(known, OTHER, { projectId: 'p1', relPath: 'a.gd', hash: B, source: 'ack' });
  assert.equal(C.knownVersion(known, CHAT, 'p1', 'a.gd').hash, A, 'чужой чат не перезаписал наш');
  assert.equal(C.knownVersion(known, OTHER, 'p1', 'a.gd').hash, B);
});

test('context: расхождение — это несовпадение диска с версией, которую видела модель', () => {
  const known = {};
  rec(known);
  C.record(known, CHAT, { projectId: 'p1', relPath: 'b.gd', hash: B, source: 'prompt' });

  // всё совпадает — расхождений нет
  assert.deepEqual(C.divergences(known, CHAT, 'p1', { 'a.gd': A, 'b.gd': B }), []);

  // a.gd изменили (в редакторе, внешним редактором, откатом — не важно)
  const d = C.divergences(known, CHAT, 'p1', { 'a.gd': D, 'b.gd': B });
  assert.equal(d.length, 1);
  assert.equal(d[0].relPath, 'a.gd');
  assert.equal(d[0].knownHash, A);
  assert.equal(d[0].diskHash, D);
  assert.equal(d[0].knownSource, 'applied');
  assert.match(d[0].knownLabel, /модель сама предложила/);
  assert.equal(d[0].missing, false);

  // файл удалён — тоже расхождение, и оно отличается от «просто другой контент»
  const gone = C.divergences(known, CHAT, 'p1', { 'a.gd': null });
  assert.equal(gone.length, 1);
  assert.equal(gone[0].missing, true);
  assert.equal(gone[0].diskHash, null);

  // файлы, которых нет в ответе, не проверяются (например, они из другого проекта)
  assert.deepEqual(C.divergences(known, CHAT, 'p1', { 'c.gd': D }), []);
  // в другом чате расхождений нет: там модель ничего не знает про эти файлы
  assert.deepEqual(C.divergences(known, OTHER, 'p1', { 'a.gd': D }), []);
  assert.deepEqual(C.divergences(known, CHAT, 'p1', null), []);
});

test('context: файл без записи в журнале расхождением не считается', () => {
  // Модель никогда не видела файл — сравнивать не с чем. Помечать такие файлы значило бы
  // подсветить весь проект и обесценить отметку.
  const known = {};
  rec(known);
  const d = C.divergences(known, CHAT, 'p1', { 'a.gd': D, 'never-seen.gd': B });
  assert.deepEqual(d.map((x) => x.relPath), ['a.gd']);
});

test('context: entries и knownHashes для пакетных запросов', () => {
  const known = {};
  rec(known);
  C.record(known, CHAT, { projectId: 'p1', relPath: 'b.gd', hash: B, source: 'ack', historyId: 'h1' });
  C.record(known, CHAT, { projectId: 'p2', relPath: 'c.gd', hash: D, source: 'prompt' });

  const p1 = C.entries(known, CHAT, 'p1').sort((a, b) => a.relPath.localeCompare(b.relPath));
  assert.deepEqual(p1.map((e) => e.relPath), ['a.gd', 'b.gd']);
  assert.equal(p1[1].historyId, 'h1');
  assert.equal(C.entries(known, CHAT).length, 3, 'без фильтра по проекту — все записи чата');
  assert.equal(C.entries(known, CHAT, 'p3').length, 0);
  assert.deepEqual(C.entries(known, 'нет-чата', 'p1'), []);

  assert.deepEqual(C.knownHashes(known, CHAT, 'p1', ['a.gd', 'b.gd', 'c.gd', 42, '']),
    { 'a.gd': A, 'b.gd': B, 'c.gd': null });
  assert.deepEqual(C.knownHashes(known, CHAT, 'p1', null), {});
});

test('context: ключ разбирается обратно, разделитель не встречается в данных', () => {
  assert.equal(C.key('p1', 'src/a.gd'), 'p1::src/a.gd');
  assert.deepEqual(C.splitKey('p1::src/a.gd'), { projectId: 'p1', relPath: 'src/a.gd' });
  assert.equal(C.splitKey('без-разделителя'), null);
  // Ключ обязан быть однозначным: projectId — slug без '::', а relPath проходит
  // normalizeRel(), где двоеточие запрещено. Проверяем это, а не надеемся.
  const { normalizeRel } = require('../src/paths');
  assert.equal(normalizeRel('a::b.gd').ok, false);
  assert.equal(normalizeRel('src/a:b.gd').ok, false);
});

test('context: лимит записей на чат', () => {
  const known = {};
  for (let i = 0; i < C.MAX_KNOWN_PER_CHAT + 50; i++) {
    C.record(known, CHAT, { projectId: 'p1', relPath: `f${i}.gd`, hash: 'h' + i, source: 'ack', ts: i });
  }
  assert.equal(C.entries(known, CHAT, 'p1').length, C.MAX_KNOWN_PER_CHAT);
  // удалены самые старые
  assert.equal(C.knownVersion(known, CHAT, 'p1', 'f0.gd'), null);
  assert.ok(C.knownVersion(known, CHAT, 'p1', `f${C.MAX_KNOWN_PER_CHAT + 49}.gd`));
});

test('context: dropChat убирает знания чата, не трогая остальные', () => {
  const known = {};
  rec(known);
  C.record(known, OTHER, { projectId: 'p1', relPath: 'a.gd', hash: B, source: 'ack' });
  assert.equal(C.dropChat(known, CHAT), true);
  assert.equal(C.knownVersion(known, CHAT, 'p1', 'a.gd'), null);
  assert.equal(C.knownVersion(known, OTHER, 'p1', 'a.gd').hash, B);
  assert.equal(C.dropChat(known, CHAT), false, 'повторное удаление не ошибка');
});

// ---------- уже виденные блоки ответа модели ----------

test('context: seen — блок, разобранный однажды, новым стать не может', () => {
  const seen = {};
  assert.equal(C.wasSeen(seen, CHAT, 'h1'), false);
  assert.equal(C.markSeen(seen, CHAT, 'h1'), true, 'первый раз — новый');
  assert.equal(C.markSeen(seen, CHAT, 'h1'), false, 'повтор — уже видели');
  assert.equal(C.wasSeen(seen, CHAT, 'h1'), true);

  // другой чат — свои блоки: одинаковый код в двух чатах независимо допустим
  assert.equal(C.wasSeen(seen, OTHER, 'h1'), false);
  assert.equal(C.markSeen(seen, OTHER, 'h1'), true);

  assert.equal(C.markSeen(seen, '', 'h2'), false);
  assert.equal(C.markSeen(seen, CHAT, ''), false);
  assert.equal(C.wasSeen(null, CHAT, 'h1'), false);
});

test('context: seen ограничен и не вытесняет свежее', () => {
  const seen = {};
  for (let i = 0; i < C.MAX_SEEN_PER_CHAT + 100; i++) C.markSeen(seen, CHAT, 'h' + i);
  assert.equal(seen[CHAT].length, C.MAX_SEEN_PER_CHAT);
  assert.equal(C.wasSeen(seen, CHAT, 'h0'), false, 'самые старые вытеснены');
  assert.equal(C.wasSeen(seen, CHAT, `h${C.MAX_SEEN_PER_CHAT + 99}`), true);
  assert.equal(C.dropChatSeen(seen, CHAT), true);
  assert.equal(C.dropChatSeen(seen, CHAT), false);
});

test('context: модуль загружается в браузере (window.WhaleContext)', async () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const fakeWindow = {};
  const ctx = vm.createContext({ window: fakeWindow, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'context.js'), 'utf8'), ctx, { filename: 'context.js' });
  const browser = fakeWindow.WhaleContext;
  assert.ok(browser, 'window.WhaleContext появился');
  const known = {};
  browser.record(known, CHAT, { projectId: 'p1', relPath: 'a.gd', hash: A, source: 'applied' });
  assert.equal(browser.divergences(known, CHAT, 'p1', { 'a.gd': D }).length, 1);
});

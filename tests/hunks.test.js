'use strict';
// Ханки и трёхстороннее слияние (src/hunks.js, ТЗ §20–§22). Чистые функции — без DOM
// и Monaco: именно они решают, какой текст попадёт в буфер, поэтому покрыты плотно.
const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('../src/hunks');

const mk = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

test('hunks: toHunks группирует изменения с контекстом и сливает близкие группы', () => {
  const base = mk(20);
  const lines = base.split('\n');
  lines[1] = 'CHANGED 2';   // строка 2
  lines[17] = 'CHANGED 18'; // строка 18 — далеко от первой (15 строк промежутка > 2*3)
  const proposed = lines.join('\n');

  const hunks = H.toHunks(base, proposed, 3);
  assert.equal(hunks.length, 2, 'две группы изменений — два ханка');
  const [h1, h2] = hunks;
  assert.equal(h1.index, 0);
  assert.equal(h1.baseLineStart, 1); // контекст упирается в начало файла
  assert.equal(h1.baseStart, 0);
  assert.equal(h1.added, 1);
  assert.equal(h1.removed, 1);
  assert.equal(h1.snippet, '- line 2'); // первая изменённая строка — удаляемая
  // baseLines точно соответствуют базе — на этом держится applySelection
  const baseLines = H.linesOf(base);
  assert.deepEqual(h1.baseLines, baseLines.slice(h1.baseStart, h1.baseStart + h1.baseLines.length));
  assert.deepEqual(h2.baseLines, baseLines.slice(h2.baseStart, h2.baseStart + h2.baseLines.length));
  assert.equal(h2.baseLineStart, 15); // 18 - 3 контекста
  assert.equal(h2.baseLineEnd, 20);   // 18 + 2 изменения/контекста, конец файла

  // близкие группы (промежуток <= 2*ctx) сливаются в один ханк
  const lines2 = mk(20).split('\n');
  lines2[4] = 'A';
  lines2[10] = 'B'; // промежуток 5 строк <= 6
  const one = H.toHunks(mk(20), lines2.join('\n'), 3);
  assert.equal(one.length, 1, 'близкие изменения — один ханк');
  assert.equal(one[0].added, 2);
});

test('hunks: toHunks на крайних случаях', () => {
  assert.deepEqual(H.toHunks('a\n', 'a\n'), [], 'нет изменений — нет ханков');
  const create = H.toHunks('', 'x\ny\n');
  assert.equal(create.length, 1);
  assert.equal(create[0].added, 2);
  assert.deepEqual(create[0].baseLines, [], 'создание: сторона базы пуста');
  const del = H.toHunks('x\ny\n', '');
  assert.equal(del.length, 1);
  assert.equal(del[0].removed, 2);
  assert.deepEqual(del[0].newLines, []);
});

test('hunks: applySelection — перестановки выбора', () => {
  const base = mk(20);
  const lines = base.split('\n');
  lines[1] = 'CHANGED 2';
  lines[17] = 'CHANGED 18';
  const proposed = lines.join('\n');
  const hunks = H.toHunks(base, proposed, 3);

  // принято всё — результат равен предложению
  assert.equal(H.applySelection(base, hunks, new Set([0, 1]), true), proposed);
  // только первый
  const only1 = H.applySelection(base, hunks, new Set([0]), true);
  assert.ok(only1.includes('CHANGED 2') && !only1.includes('CHANGED 18'));
  // только второй
  const only2 = H.applySelection(base, hunks, new Set([1]), true);
  assert.ok(!only2.includes('CHANGED 2') && only2.includes('CHANGED 18'));
  // ничего — база без изменений
  assert.equal(H.applySelection(base, hunks, new Set(), true), base);
  // массив индексов равносилен Set
  assert.equal(H.applySelection(base, hunks, [1], true), only2);
});

test('hunks: merge3 — быстрые пути дают ТОЧНЫЙ текст (от этого зависит учёт контекста)', () => {
  const base = mk(10);
  const proposed = base.replace('line 5', 'LINE FIVE');
  // буфер не тронут: результат байт в байт равен предложению
  const m1 = H.merge3(base, base, proposed);
  assert.equal(m1.ok, true);
  assert.equal(m1.text, proposed);
  // ничего не принято: результат байт в байт равен буферу
  const m2 = H.merge3(base, base, base);
  assert.equal(m2.text, base);
  // theirs == base: буфер без изменений
  const ours = base.replace('line 3', 'MY EDIT');
  assert.equal(H.merge3(base, ours, base).text, ours);
});

test('hunks: merge3 — правка пользователя в другом месте сохраняется (§29)', () => {
  const base = mk(20);
  const proposed = base.replace('line 2\n', 'MODEL 2\n');  // модель меняет строку 2
  const ours = base.replace('line 15\n', 'MINE 15\n');     // пользователь — строку 15
  const m = H.merge3(base, ours, proposed);
  assert.equal(m.ok, true, 'пересечений нет');
  assert.ok(m.text.includes('MODEL 2'), 'правка модели на месте');
  assert.ok(m.text.includes('MINE 15'), 'правка пользователя не потеряна');
  assert.ok(!m.text.includes('line 2\n'), 'старая строка модели заменена');
});

test('hunks: merge3 — пересечение становится конфликтом, а не тихой перезаписью', () => {
  const base = mk(10);
  const proposed = base.replace('line 5\n', 'MODEL 5\n');
  const ours = base.replace('line 5\n', 'MINE 5\n');
  const m = H.merge3(base, ours, proposed);
  assert.equal(m.ok, false);
  assert.equal(m.conflicts, 1);
  assert.ok(m.text.includes('<<<<<<< YOUR CURRENT FILE'));
  assert.ok(m.text.includes('MINE 5'));
  assert.ok(m.text.includes('MODEL 5'));
  assert.ok(m.text.includes('>>>>>>> AI PROPOSAL'));
  // идентичные правки с обеих сторон конфликтом не считаются
  const same = H.merge3(base, base.replace('line 5\n', 'X\n'), base.replace('line 5\n', 'X\n'));
  assert.equal(same.ok, true);
  assert.ok(same.text.includes('X'));
});

test('hunks: CRLF сохраняется при слиянии и применении', () => {
  const base = 'a\r\nb\r\nc\r\n';
  const proposed = 'a\r\nB2\r\nc\r\n';
  const hunks = H.toHunks(base, proposed, 3);
  assert.equal(hunks.length, 1);
  const applied = H.applySelection(base, hunks, new Set([0]), true);
  assert.equal(applied, 'a\r\nB2\r\nc\r\n', 'EOL базы сохранён');
  const m = H.merge3(base, base, proposed);
  assert.equal(m.text, proposed);
  // общий путь merge3 (есть правка пользователя) тоже собирает CRLF
  const ours = 'a\r\nb\r\nC3\r\n';
  const m2 = H.merge3(base, ours, proposed);
  assert.equal(m2.ok, true);
  assert.equal(m2.text, 'a\r\nB2\r\nC3\r\n');
});

test('hunks: файл без завершающего перевода строки', () => {
  const base = 'a\nb';
  const proposed = 'a\nB2';
  const hunks = H.toHunks(base, proposed, 3);
  assert.equal(H.applySelection(base, hunks, new Set([0]), false), 'a\nB2');
  // предложенный текст добавил перевод строки — хвост берётся от предложения
  const proposedNl = 'a\nB2\n';
  const hunks2 = H.toHunks(base, proposedNl, 3);
  assert.equal(H.applySelection(base, hunks2, new Set([0]), true), 'a\nB2\n');
});

test('hunks: полный цикл — выбор ханков + правка пользователя + слияние', () => {
  const base = mk(20);
  const lines = base.split('\n');
  lines[1] = 'MODEL 2';
  lines[17] = 'MODEL 18';
  const proposed = lines.join('\n');
  const hunks = H.toHunks(base, proposed, 3);
  assert.equal(hunks.length, 2);

  // пользователь правит строку 10, принимает только второй ханк
  const ours = base.replace('line 10\n', 'MINE 10\n');
  const theirs = H.applySelection(base, hunks, new Set([1]), true);
  const m = H.merge3(base, ours, theirs);
  assert.equal(m.ok, true);
  assert.ok(m.text.includes('MINE 10'));
  assert.ok(m.text.includes('MODEL 18'));
  assert.ok(m.text.includes('line 2\n'), 'непринятый ханк не применён');
  // результат НЕ равен предложению — честный учёт контекста отметит расхождение
  assert.notEqual(m.text, proposed);
});

test('hunks: diffChanges — координаты в строках базы', () => {
  const ch = H.diffChanges('a\nb\nc\n', 'a\nX\nc\n');
  assert.deepEqual(ch, [{ start: 1, end: 2, replacement: ['X'] }]);
});

test('hunks: загружается в браузере через window.WhaleDiff/WhaleHunks (без require)', () => {
  const fs = require('fs');
  const vm = require('vm');
  const path = require('path');
  const fakeWindow = {};
  const ctx = vm.createContext({ window: fakeWindow, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'diff.js'), 'utf8'), ctx, { filename: 'diff.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'hunks.js'), 'utf8'), ctx, { filename: 'hunks.js' });
  assert.ok(fakeWindow.WhaleDiff && typeof fakeWindow.WhaleDiff.diffLines === 'function');
  assert.ok(fakeWindow.WhaleHunks && typeof fakeWindow.WhaleHunks.toHunks === 'function');
  assert.equal(typeof fakeWindow.WhaleHunks.merge3, 'function');
});

test('hunks: без src/diff.js падает сразу, а не молча считает слияния', () => {
  const fs = require('fs');
  const vm = require('vm');
  const path = require('path');
  const fakeWindow = {};
  const ctx = vm.createContext({ window: fakeWindow, console });
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'hunks.js'), 'utf8');
  assert.throws(() => vm.runInContext(src, ctx, { filename: 'hunks.js' }), /WhaleDiff/);
});

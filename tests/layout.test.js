'use strict';
// Математика раскладки (ui/layout.js, ТЗ §4–§6, §28). DOM и Electron не нужны:
// правила разделителей, минимумов и стороны чата — чистые функции.
const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../ui/layout');

const WIN = 1500;
const base = () => ({ chatW: 420, filesW: 220, sideW: 380, chatSide: 'left' });

test('layout: sanitize возвращает дефолты на мусоре и сохраняет валидное', () => {
  assert.deepEqual(L.sanitize(null, WIN), L.DEFAULTS);
  assert.deepEqual(L.sanitize(undefined), L.DEFAULTS);
  assert.deepEqual(L.sanitize({ chatW: 'широко', filesW: NaN, sideW: null }, WIN),
    { ...L.DEFAULTS });
  // валидные значения переживают sanitize без изменений
  assert.deepEqual(L.sanitize({ chatW: 500, filesW: 200, sideW: 300, chatSide: 'right' }, WIN),
    { chatW: 500, filesW: 200, sideW: 300, chatSide: 'right' });
  // неизвестная сторона — всегда left
  assert.equal(L.sanitize({ chatSide: 'сверху' }, WIN).chatSide, 'left');
  // дробные ширины округляются
  assert.equal(L.sanitize({ chatW: 420.6 }, WIN).chatW, 421);
});

test('layout: минимумы панели не опускаются ниже LIMITS', () => {
  const tiny = L.sanitize({ chatW: 10, filesW: 1, sideW: -50 }, WIN);
  assert.ok(tiny.chatW >= L.LIMITS.chatMin);
  assert.ok(tiny.filesW >= L.LIMITS.filesMin);
  assert.ok(tiny.sideW >= L.LIMITS.sideMin);
});

test('layout: чат не шире 60% окна', () => {
  const wide = L.fitToWindow({ ...base(), chatW: 1400 }, WIN);
  assert.ok(wide.chatW <= Math.floor(WIN * L.LIMITS.chatMaxRatio));
});

test('layout: fitToWindow жмёт панели в порядке side → files → chat', () => {
  // не хватает 100px — урезается только боковая панель
  const winW = 1175; // 420+220+380+15 + 240(editorMin) - 100
  const fit = L.fitToWindow(base(), winW);
  assert.deepEqual(fit, { chatW: 420, filesW: 220, sideW: 280, chatSide: 'left' });
  assert.equal(L.editorWidth(fit, winW), L.LIMITS.editorMin);

  // не хватает 280px — боковая до минимума, затем файлы, затем чат
  const winW2 = 995;
  const fit2 = L.fitToWindow(base(), winW2);
  assert.deepEqual(fit2, { chatW: 340, filesW: 160, sideW: 240, chatSide: 'left' });
  assert.equal(L.editorWidth(fit2, winW2), L.LIMITS.editorMin);

  // узкое окно: даже минимумы не влезают — панели остаются на минимумах, без NaN и отрицаний
  const fit3 = L.fitToWindow(base(), 700);
  assert.equal(fit3.chatW, L.LIMITS.chatMin);
  assert.equal(fit3.filesW, L.LIMITS.filesMin);
  assert.equal(fit3.sideW, L.LIMITS.sideMin);
  assert.ok(L.editorWidth(fit3, 700) >= 0);
});

test('layout: drag чата слева — вправо шире, с упором в 60% и минимум редактора', () => {
  let l = L.drag(base(), 'chat', 100, WIN);
  assert.equal(l.chatW, 520);
  assert.equal(l.filesW, 220, 'файлы не двигаются');
  assert.equal(l.sideW, 380, 'боковая не двигается');

  // упор в chatMax: окно должно быть достаточно широким, иначе строже минимум редактора
  const WIN_BIG = 2200; // editor = 2200-1035 = 1165, chatMax = 1320
  l = L.drag(base(), 'chat', 1500, WIN_BIG);
  assert.equal(l.chatW, Math.floor(WIN_BIG * L.LIMITS.chatMaxRatio));

  // упор в минимум редактора: editor = 1500 - 420 - 220 - 380 - 15 = 465 → сдвиг не больше 465-240=225
  l = L.drag(base(), 'chat', 400, WIN);
  assert.equal(l.chatW, 420 + 225);
  assert.equal(L.editorWidth(l, WIN), L.LIMITS.editorMin);

  // влево — уже, до chatMin
  l = L.drag(base(), 'chat', -500, WIN);
  assert.equal(l.chatW, L.LIMITS.chatMin);
});

test('layout: drag чата справа — знак обратный', () => {
  const r = { ...base(), chatSide: 'right' };
  // тянем ВЛЕВО (dx<0) — чат справа становится шире
  let l = L.drag(r, 'chat', -100, WIN);
  assert.equal(l.chatW, 520);
  // тянем вправо — уже, до минимума
  l = L.drag(r, 'chat', 900, WIN);
  assert.equal(l.chatW, L.LIMITS.chatMin);
});

test('layout: drag файлов и боковой панели', () => {
  // файлы: вправо шире, упор в минимум редактора
  let l = L.drag(base(), 'files', 50, WIN);
  assert.equal(l.filesW, 270);
  l = L.drag(base(), 'files', 900, WIN);
  assert.equal(l.filesW, 220 + 225); // editorMin ограничивает
  // влево — до filesMin
  l = L.drag(base(), 'files', -900, WIN);
  assert.equal(l.filesW, L.LIMITS.filesMin);

  // боковая: вправо — УЖЕ (dx>0 уменьшает sideW)
  l = L.drag(base(), 'side', 100, WIN);
  assert.equal(l.sideW, 280);
  // до sideMin
  l = L.drag(base(), 'side', 900, WIN);
  assert.equal(l.sideW, L.LIMITS.sideMin);
  // влево — шире, упор в минимум редактора (editor 465 → +225)
  l = L.drag(base(), 'side', -900, WIN);
  assert.equal(l.sideW, 380 + 225);
});

test('layout: drag на неизвестном разделителе ничего не меняет', () => {
  assert.deepEqual(L.drag(base(), 'bottom', 100, WIN), base());
  assert.deepEqual(L.drag(base(), 'files', NaN, WIN), base());
});

test('layout: normalizeRect — целые, неотрицательные, без нулевого размера', () => {
  assert.deepEqual(L.normalizeRect({ x: 0.4, y: 38.6, width: 419.5, height: 800.2 }),
    { x: 0, y: 39, width: 420, height: 800 });
  // нулевая ячейка Grid — отправлять нечего
  assert.equal(L.normalizeRect({ x: 0, y: 0, width: 0, height: 500 }), null);
  assert.equal(L.normalizeRect({ x: 0, y: 0, width: 500, height: 0 }), null);
  // мусор
  assert.equal(L.normalizeRect(null), null);
  assert.equal(L.normalizeRect('rect'), null);
  assert.equal(L.normalizeRect({ x: 0, y: 0, width: NaN, height: 10 }), null);
  assert.equal(L.normalizeRect({ x: -5, y: 0, width: 10, height: 10 }), null);
});

test('layout: cssVars — px-строки для :root', () => {
  assert.deepEqual(L.cssVars(base()), { '--chat-w': '420px', '--files-w': '220px', '--side-w': '380px' });
});

test('layout: editorWidth считает остаток с тремя разделителями', () => {
  assert.equal(L.editorWidth(base(), WIN), WIN - (420 + 220 + 380 + 15));
  assert.equal(L.editorWidth({ ...base(), chatW: 5000 }, 1500), 0); // не отрицательный
});

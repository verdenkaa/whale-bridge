'use strict';
// Математика раскладки (ui/layout.js, ТЗ §4, §28). DOM и Electron не нужны:
// правила разделителей и минимумов — чистые функции.
const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../ui/layout');

const WIN = 1500;
const base = () => ({ leftW: 320, chatW: 420, promptOpen: false, leftTab: 'files' });

test('layout: sanitize возвращает дефолты на мусоре и сохраняет валидное', () => {
  assert.deepEqual(L.sanitize(null, WIN), L.DEFAULTS);
  assert.deepEqual(L.sanitize(undefined), L.DEFAULTS);
  assert.deepEqual(L.sanitize({ leftW: 'широко', chatW: NaN, leftTab: null }, WIN), L.DEFAULTS);
  assert.deepEqual(L.sanitize({ leftW: 300, chatW: 500, promptOpen: true, leftTab: 'history' }, WIN),
    { leftW: 300, chatW: 500, promptOpen: true, leftTab: 'history' });
  // неизвестная вкладка и не-логический флаг нормализуются
  assert.equal(L.sanitize({ leftTab: 'промпт' }, WIN).leftTab, 'files');
  assert.equal(L.sanitize({ promptOpen: 'да' }, WIN).promptOpen, false);
  assert.equal(L.sanitize({ leftW: 320.6 }, WIN).leftW, 321);
});

test('layout: миграция прежних схем — leftW из filesW/sideW, но не уже 280', () => {
  // 0012/0013: дерево было 220px — для списка предложений этого мало
  assert.equal(L.sanitize({ filesW: 220, chatW: 420 }, WIN).leftW, 280);
  // широкая прежняя панель сохраняется как есть
  assert.equal(L.sanitize({ sideW: 380 }, WIN).leftW, 380);
  assert.equal(L.sanitize({ filesW: 300 }, WIN).leftW, 300);
  // явный leftW важнее наследия
  assert.equal(L.sanitize({ leftW: 250, filesW: 220, sideW: 380 }, WIN).leftW, 250);
  // поля прежних схем не протекают в новую раскладку
  const m = L.sanitize({ chatSide: 'right', bottomH: 900, promptW: 460, bottomCollapsed: true }, WIN);
  assert.deepEqual(m, { leftW: 320, chatW: 420, promptOpen: false, leftTab: 'files' });
});

test('layout: минимумы не опускаются ниже LIMITS', () => {
  const tiny = L.sanitize({ leftW: 1, chatW: 10 }, WIN);
  assert.ok(tiny.leftW >= L.LIMITS.leftMin);
  assert.ok(tiny.chatW >= L.LIMITS.chatMin);
});

test('layout: чат не шире 60% окна', () => {
  const wide = L.fitToWindow({ ...base(), chatW: 1400 }, WIN);
  assert.ok(wide.chatW <= Math.floor(WIN * L.LIMITS.chatMaxRatio));
});

test('layout: fitToWindow жмёт панели в порядке left → chat', () => {
  // fixed = 320 + 420 + 10 = 750.
  // Не хватает 60px — урезается только левая панель: winW = 750 + 240 - 60 = 930
  const fit = L.fitToWindow(base(), 930);
  assert.deepEqual({ leftW: fit.leftW, chatW: fit.chatW }, { leftW: 260, chatW: 420 });
  assert.equal(L.editorWidth(fit, 930), L.LIMITS.editorMin);

  // не хватает 200px: левая до минимума (−120), затем чат (−80). winW = 750 + 240 - 200 = 790
  const fit2 = L.fitToWindow(base(), 790);
  assert.deepEqual({ leftW: fit2.leftW, chatW: fit2.chatW }, { leftW: 200, chatW: 340 });
  assert.equal(L.editorWidth(fit2, 790), L.LIMITS.editorMin);

  // узкое окно: даже минимумы не влезают — панели на минимумах, без NaN и отрицаний
  const fit3 = L.fitToWindow(base(), 500);
  assert.equal(fit3.leftW, L.LIMITS.leftMin);
  assert.equal(fit3.chatW, L.LIMITS.chatMin);
  assert.ok(L.editorWidth(fit3, 500) >= 0);
});

test('layout: drag левой панели — вправо шире, с упором в минимум редактора', () => {
  // editor = 1500 - 320 - 420 - 10 = 750 → сдвиг не больше 750-240 = 510
  let l = L.drag(base(), 'left', 100, WIN);
  assert.equal(l.leftW, 420);
  assert.equal(l.chatW, 420, 'чат не двигается');

  l = L.drag(base(), 'left', 2000, WIN);
  assert.equal(l.leftW, 320 + 510);
  assert.equal(L.editorWidth(l, WIN), L.LIMITS.editorMin);

  // влево — уже, до leftMin
  l = L.drag(base(), 'left', -900, WIN);
  assert.equal(l.leftW, L.LIMITS.leftMin);
});

test('layout: drag чата — разделитель слева от него, поэтому знак обратный', () => {
  // тянем ВЛЕВО (delta<0) — чат шире
  let l = L.drag(base(), 'chat', -100, WIN);
  assert.equal(l.chatW, 520);
  assert.equal(l.leftW, 320, 'левая панель не двигается');

  // на окне 1500 оба упора рядом, строже chatMax: 60% = 900 (editorMin разрешил бы +510)
  l = L.drag(base(), 'chat', -2000, WIN);
  assert.equal(l.chatW, Math.floor(WIN * L.LIMITS.chatMaxRatio));

  // тот же упор в chatMax (60%) на широком окне: editor = 2200-750 = 1450, его минимум не мешает
  const BIG = 2200;
  l = L.drag(base(), 'chat', -2000, BIG);
  assert.equal(l.chatW, Math.floor(BIG * L.LIMITS.chatMaxRatio));

  // вправо — уже, до chatMin
  l = L.drag(base(), 'chat', 900, WIN);
  assert.equal(l.chatW, L.LIMITS.chatMin);
});

test('layout: drag на неизвестном разделителе ничего не меняет', () => {
  assert.deepEqual(L.drag(base(), 'side', 100, WIN), base());
  assert.deepEqual(L.drag(base(), 'bottom', 100, WIN), base());
  assert.deepEqual(L.drag(base(), 'left', NaN, WIN), base());
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
  assert.deepEqual(L.cssVars(base()), { '--left-w': '320px', '--chat-w': '420px' });
});

test('layout: editorWidth считает остаток с двумя разделителями', () => {
  assert.equal(L.editorWidth(base(), WIN), WIN - (320 + 420 + 10));
  assert.equal(L.editorWidth({ ...base(), chatW: 5000 }, WIN), 0); // не отрицательный
});

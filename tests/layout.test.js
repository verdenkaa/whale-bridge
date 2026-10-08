'use strict';
// Математика раскладки (ui/layout.js, ТЗ §4, §28). DOM и Electron не нужны:
// правила разделителей и минимумов — чистые функции.
const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../ui/layout');

const WIN = 1500;
const WINH = 900;
const base = () => ({ leftW: 320, chatW: 420, promptOpen: false, leftTab: 'files', termOpen: false, termH: 260 });

test('layout: sanitize возвращает дефолты на мусоре и сохраняет валидное', () => {
  assert.deepEqual(L.sanitize(null, WIN), L.DEFAULTS);
  assert.deepEqual(L.sanitize(undefined), L.DEFAULTS);
  assert.deepEqual(L.sanitize({ leftW: 'широко', chatW: NaN, leftTab: null }, WIN), L.DEFAULTS);
  assert.deepEqual(L.sanitize({ leftW: 300, chatW: 500, promptOpen: true, leftTab: 'history' }, WIN),
    { leftW: 300, chatW: 500, promptOpen: true, leftTab: 'history', termOpen: false, termH: 260 });
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
  assert.deepEqual(m, { leftW: 320, chatW: 420, promptOpen: false, leftTab: 'files', termOpen: false, termH: 260 });
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
  assert.deepEqual(L.cssVars(base()), { '--left-w': '320px', '--chat-w': '420px', '--term-h': '260px' });
});

// ---------- терминал (этап C3, §2.1): termOpen/termH ----------

test('layout: терминал — sanitize хранит termOpen/termH и нормализует мусор', () => {
  const l = L.sanitize({ termOpen: true, termH: 380 }, WIN, WINH);
  assert.equal(l.termOpen, true);
  assert.equal(l.termH, 380);
  // не-логический флаг и не-число возвращаются к дефолтам
  assert.equal(L.sanitize({ termOpen: 'открыт' }, WIN, WINH).termOpen, false);
  assert.equal(L.sanitize({ termH: 'высоко' }, WIN, WINH).termH, L.DEFAULTS.termH);
  assert.equal(L.sanitize({ termH: 300.4 }, WIN, WINH).termH, 300);
  // старые конфиги без терминальных полей получают дефолты
  const old = L.sanitize({ leftW: 300, chatW: 420 }, WIN, WINH);
  assert.equal(old.termOpen, false);
  assert.equal(old.termH, L.DEFAULTS.termH);
});

test('layout: терминал — высота не ниже минимума и не съедает окно', () => {
  // ниже termMin не опускается даже при явном мусоре
  assert.equal(L.sanitize({ termH: 10 }, WIN, WINH).termH, L.LIMITS.termMin);
  assert.equal(L.fitToWindow({ ...base(), termH: 1 }, WIN, WINH).termH, L.LIMITS.termMin);
  // выше «окно − запас» не поднимается: редактору и topbar остаётся termReserve
  assert.equal(L.fitToWindow({ ...base(), termH: 5000 }, WIN, WINH).termH, WINH - L.LIMITS.termReserve);
  assert.equal(L.sanitize({ termH: 5000 }, WIN, WINH).termH, WINH - L.LIMITS.termReserve);
  // низкое окно: минимум важнее запаса (иначе termH стал бы отрицательным)
  assert.equal(L.fitToWindow({ ...base(), termH: 5000 }, WIN, 300).termH, L.LIMITS.termMin);
  // winH неизвестна — ограничиваемся абсолютным минимумом
  assert.equal(L.fitToWindow({ ...base(), termH: 5000 }, WIN).termH, 5000);
});

test('layout: терминал — drag за разделитель: вверх выше, вниз ниже, с упорами', () => {
  // тянем ВВЕРХ (delta<0) — терминал выше
  let l = L.drag(base(), 'term', -100, { w: WIN, h: WINH });
  assert.equal(l.termH, 360);
  assert.equal(l.leftW, base().leftW, 'ширины панелей не двигаются');
  assert.equal(l.chatW, base().chatW);
  // упор в запас окна: 900 − 300 = 600
  l = L.drag(base(), 'term', -5000, { w: WIN, h: WINH });
  assert.equal(l.termH, WINH - L.LIMITS.termReserve);
  // вниз — ниже, до termMin
  l = L.drag(base(), 'term', 5000, { w: WIN, h: WINH });
  assert.equal(l.termH, L.LIMITS.termMin);
  // без высоты окна верхний упор бесконечный, но минимум работает
  l = L.drag(base(), 'term', -5000, WIN);
  assert.equal(l.termH, 260 + 5000);
  l = L.drag(base(), 'term', 5000, WIN);
  assert.equal(l.termH, L.LIMITS.termMin);
  // неизвестный разделитель по-прежнему ничего не меняет
  assert.deepEqual(L.drag(base(), 'bottom', 100, { w: WIN, h: WINH }), base());
});

test('layout: editorWidth считает остаток с двумя разделителями', () => {
  assert.equal(L.editorWidth(base(), WIN), WIN - (320 + 420 + 10));
  assert.equal(L.editorWidth({ ...base(), chatW: 5000 }, WIN), 0); // не отрицательный
});

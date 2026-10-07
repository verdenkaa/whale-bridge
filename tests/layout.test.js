'use strict';
// Математика раскладки (ui/layout.js, ТЗ §4–§6, §28). DOM и Electron не нужны:
// правила разделителей, минимумов, стороны чата и нижней панели — чистые функции.
const test = require('node:test');
const assert = require('node:assert/strict');

const L = require('../ui/layout');

const WIN = { w: 1500, h: 900 };
const base = () => ({
  chatW: 420, filesW: 220, promptW: 460, bottomH: 260,
  chatSide: 'left', promptOpen: false, bottomCollapsed: false,
});

test('layout: sanitize возвращает дефолты на мусоре и сохраняет валидное', () => {
  assert.deepEqual(L.sanitize(null, WIN.w, WIN.h), L.DEFAULTS);
  assert.deepEqual(L.sanitize(undefined), L.DEFAULTS);
  assert.deepEqual(L.sanitize({ chatW: 'широко', filesW: NaN, sideW: null }, WIN.w, WIN.h), L.DEFAULTS);
  // валидные значения переживают sanitize без изменений
  assert.deepEqual(L.sanitize({ chatW: 500, filesW: 200, promptW: 400, bottomH: 300, chatSide: 'right', promptOpen: true, bottomCollapsed: true }, WIN.w, WIN.h),
    { chatW: 500, filesW: 200, promptW: 400, bottomH: 300, chatSide: 'right', promptOpen: true, bottomCollapsed: true });
  // неизвестная сторона — всегда left; логические поля нормализуются
  assert.equal(L.sanitize({ chatSide: 'сверху', promptOpen: 'да' }, WIN.w, WIN.h).chatSide, 'left');
  assert.equal(L.sanitize({ promptOpen: 'да' }, WIN.w, WIN.h).promptOpen, false);
  // дробные размеры округляются
  assert.equal(L.sanitize({ chatW: 420.6 }, WIN.w, WIN.h).chatW, 421);
});

test('layout: миграция раскладки 0012 — sideW становится promptW', () => {
  const old = { chatW: 420, filesW: 220, sideW: 380, chatSide: 'left' };
  const m = L.sanitize(old, WIN.w, WIN.h);
  assert.equal(m.promptW, 380, 'ширина бывшей боковой панели унаследована');
  assert.equal(m.sideW, undefined, 'старое поле не переносится в новую раскладку');
  // явный promptW важнее наследия
  assert.equal(L.sanitize({ sideW: 380, promptW: 500 }, WIN.w, WIN.h).promptW, 500);
});

test('layout: минимумы панели не опускаются ниже LIMITS', () => {
  const tiny = L.sanitize({ chatW: 10, filesW: 1, promptW: -50, bottomH: 3 }, WIN.w, WIN.h);
  assert.ok(tiny.chatW >= L.LIMITS.chatMin);
  assert.ok(tiny.filesW >= L.LIMITS.filesMin);
  assert.ok(tiny.promptW >= L.LIMITS.promptMin);
  assert.ok(tiny.bottomH >= L.LIMITS.bottomMin);
});

test('layout: слот чата не шире 60% окна', () => {
  const wide = L.fitToWindow({ ...base(), chatW: 1400 }, WIN.w, WIN.h);
  assert.ok(wide.chatW <= Math.floor(WIN.w * L.LIMITS.chatMaxRatio));
});

test('layout: нижняя панель не съедает рабочую область', () => {
  const tall = L.fitToWindow({ ...base(), bottomH: 5000 }, WIN.w, WIN.h);
  assert.equal(tall.bottomH, WIN.h - L.LIMITS.bottomKeep);
});

test('layout: fitToWindow жмёт панели в порядке prompt → files → chat', () => {
  const open = { ...base(), promptOpen: true };
  // chatColW(open) = 420+460+5 = 885; fixed = 885+220+10 = 1115

  // не хватает 100px — урезается только «Промпт»: winW = 1115 + 240 - 100 = 1255
  const fit = L.fitToWindow(open, 1255, WIN.h);
  assert.deepEqual({ chatW: fit.chatW, filesW: fit.filesW, promptW: fit.promptW },
    { chatW: 420, filesW: 220, promptW: 360 });
  assert.equal(L.editorWidth(fit, 1255), L.LIMITS.editorMin);

  // не хватает 340px: «Промпт» до минимума (−180), затем файлы (−60) и чат (−100).
  // winW = 1115 + 240 - 340 = 1015
  const fit2 = L.fitToWindow(open, 1015, WIN.h);
  assert.deepEqual({ chatW: fit2.chatW, filesW: fit2.filesW, promptW: fit2.promptW },
    { chatW: 320, filesW: 160, promptW: 280 });
  assert.equal(L.editorWidth(fit2, 1015), L.LIMITS.editorMin);

  // «Промпт» закрыт — первым жмётся дерево: fixed = 420+220+10 = 650; winW = 650+240-60 = 830
  const fit3 = L.fitToWindow(base(), 830, WIN.h);
  assert.deepEqual({ chatW: fit3.chatW, filesW: fit3.filesW }, { chatW: 420, filesW: 160 });
  assert.equal(L.editorWidth(fit3, 830), L.LIMITS.editorMin);

  // узкое окно: даже минимумы не влезают — панели остаются на минимумах, без NaN и отрицаний
  const fit4 = L.fitToWindow(base(), 500, 500);
  assert.equal(fit4.chatW, L.LIMITS.chatMin);
  assert.equal(fit4.filesW, L.LIMITS.filesMin);
  assert.ok(L.editorWidth(fit4, 500) >= 0);
  assert.equal(fit4.bottomH, Math.max(L.LIMITS.bottomMin, 500 - L.LIMITS.bottomKeep));
});

test('layout: drag чата слева — вправо шире, с упором в 60% и минимум редактора', () => {
  let l = L.drag(base(), 'chat', 100, WIN);
  assert.equal(l.chatW, 520);
  assert.equal(l.filesW, 220, 'файлы не двигаются');

  // упор в chatMax: окно должно быть достаточно широким, иначе строже минимум редактора
  const BIG = { w: 2200, h: 900 }; // editor = 2200-650 = 1550, chatMax = 1320
  l = L.drag(base(), 'chat', 1500, BIG);
  assert.equal(l.chatW, Math.floor(BIG.w * L.LIMITS.chatMaxRatio));

  // упор в минимум редактора: filesW=500 → editor = 1500-930 = 570 → сдвиг не больше 570-240=330
  l = L.drag({ ...base(), filesW: 500 }, 'chat', 900, WIN);
  assert.equal(l.chatW, 420 + 330);
  assert.equal(L.editorWidth(l, WIN.w), L.LIMITS.editorMin);

  // без упора в editorMin ограничение строже — 60% окна: chatMax 900
  l = L.drag(base(), 'chat', 900, WIN);
  assert.equal(l.chatW, Math.floor(WIN.w * L.LIMITS.chatMaxRatio));

  // влево — уже, до chatMin
  l = L.drag(base(), 'chat', -500, WIN);
  assert.equal(l.chatW, L.LIMITS.chatMin);
});

test('layout: drag чата справа — знак обратный', () => {
  const r = { ...base(), chatSide: 'right' };
  // тянем ВЛЕВО (delta<0) — чат справа становится шире
  let l = L.drag(r, 'chat', -100, WIN);
  assert.equal(l.chatW, 520);
  // тянем вправо — уже, до минимума
  l = L.drag(r, 'chat', 900, WIN);
  assert.equal(l.chatW, L.LIMITS.chatMin);
});

test('layout: drag файлов и промпта', () => {
  // файлы: вправо шире, упор в минимум редактора (editor 850 → +610)
  let l = L.drag(base(), 'files', 50, WIN);
  assert.equal(l.filesW, 270);
  l = L.drag(base(), 'files', 2000, WIN);
  assert.equal(l.filesW, 220 + 610);
  // влево — до filesMin
  l = L.drag(base(), 'files', -900, WIN);
  assert.equal(l.filesW, L.LIMITS.filesMin);

  // промпт открыт: тянем ВЛЕВО (delta<0) — панель шире; слот чата не меняется
  const open = { ...base(), promptOpen: true };
  // editor = 1500 - (420+460+5) - 220 - 10 = 385 → промпт может вырасти на 385-240=145
  l = L.drag(open, 'prompt', -200, WIN);
  assert.equal(l.promptW, 460 + 145);
  assert.equal(l.chatW, 420, 'слот чата не двигается — растёт вся колонка');
  // вправо — уже, до promptMin
  l = L.drag(open, 'prompt', 900, WIN);
  assert.equal(l.promptW, L.LIMITS.promptMin);
});

test('layout: drag нижней панели — вверх выше, с двумя упорами', () => {
  // вверх (delta<0) — выше
  let l = L.drag(base(), 'bottom', -80, WIN);
  assert.equal(l.bottomH, 340);
  // упор сверху: winH - bottomKeep
  l = L.drag(base(), 'bottom', -5000, WIN);
  assert.equal(l.bottomH, WIN.h - L.LIMITS.bottomKeep);
  // вниз — ниже, до bottomMin
  l = L.drag(base(), 'bottom', 900, WIN);
  assert.equal(l.bottomH, L.LIMITS.bottomMin);
});

test('layout: drag на неизвестном разделителе ничего не меняет', () => {
  assert.deepEqual(L.drag(base(), 'side', 100, WIN), base());
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

test('layout: cssVars — px-строки для :root, ширина чат-колонки считает «Промпт»', () => {
  assert.deepEqual(L.cssVars(base()), {
    '--chat-w': '420px', '--chat-col-w': '420px', '--files-w': '220px',
    '--prompt-w': '460px', '--bottom-h': '260px',
  });
  // открытый «Промпт» расширяет колонку: слот + разделитель + панель
  const open = { ...base(), promptOpen: true };
  assert.equal(L.cssVars(open)['--chat-col-w'], (420 + 460 + L.SPLITTER) + 'px');
  assert.equal(L.cssVars(open)['--chat-w'], '420px', 'слот чата не меняется');
});

test('layout: editorWidth и chatColW', () => {
  assert.equal(L.chatColW(base()), 420);
  assert.equal(L.chatColW({ ...base(), promptOpen: true }), 420 + 460 + L.SPLITTER);
  assert.equal(L.editorWidth(base(), WIN.w), WIN.w - (420 + 220 + 10));
  assert.equal(L.editorWidth({ ...base(), chatW: 5000 }, 1500), 0); // не отрицательный
});

'use strict';
// Дымовой тест интерфейса на минимальной имитации DOM (без Electron и jsdom).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const pg = require('../src/promptgen');

class TextNode { constructor(t) { this.nodeType = 3; this.textContent = t; } }
// Как настоящий ParentNode.append(): аргументы разворачиваются (вложенные массивы тоже),
// null/undefined молча игнорируются, всё остальное становится текстовым узлом.
// Если этого не повторить, в children попадают undefined и массивы — и чтение textContent
// падает с непонятным «Cannot read properties of undefined», хотя в браузере всё работает.
const toNode = (x) => {
  if (x && typeof x === 'object' && x.nodeType) return x;
  if (typeof x === 'string' || typeof x === 'number') return new TextNode(String(x));
  throw new TypeError(`append(): DOM принял бы только узел или строку, передано ${typeof x}: ${String(x)}`);
};
class El {
  constructor(tag) {
    this.nodeType = 1; this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {};
    this.style = { cssText: '', setProperty() {} }; this.className = ''; this.scrollTop = 0; this.value = '';
    this.classList = { add() {}, remove() {} };
  }
  append(...k) { for (const x of k.flat(Infinity)) { if (x == null) continue; this.children.push(toNode(x)); } }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  setPointerCapture() {}
  set textContent(v) { this.children = [new TextNode(String(v))]; }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
}
const walk = (el, fn) => { fn(el); (el.children || []).forEach((c) => c.nodeType === 1 && walk(c, fn)); };
const findAll = (root, pred) => { const out = []; walk(root, (e) => pred(e) && out.push(e)); return out; };
const click = async (el, ev = {}) => { for (const f of el.listeners.click || []) await f({ stopPropagation() {}, target: el, ...ev }); await tick(); };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

const CHAT = '17b45023-2aba-4a1a-a966-17bbe41926ea';
const PROJECT = { id: 'p1', name: 'Proj', path: '/x' };

test('UI: вкладки, патч-предложения, бэкапы, генератор промптов', async () => {
  const roots = {};
  for (const id of ['head', 'tabs', 'body', 'toast', 'splitter', 'panel']) { roots[id] = new El('div'); }
  global.document = {
    createElement: (t) => new El(t),
    createTextNode: (t) => new TextNode(t),
    documentElement: { style: { setProperty() {} } },
    querySelector(sel) {
      const id = sel.slice(1);
      if (roots[id]) return roots[id];
      for (const r of Object.values(roots)) { const f = findAll(r, (e) => e.attrs.id === id)[0]; if (f) return f; }
      return null;
    },
  };
  const log = [];
  const handlers = {};
  const sections = pg.defaultSections();
  const tree = { truncated: false, nodes: [{ name: 'scripts', rel: 'scripts', isDir: true, children: [{ name: 'player.gd', rel: 'scripts/player.gd', isDir: false }] }, { name: 'project.godot', rel: 'project.godot', isDir: false }] };
  const proposals = [
    { id: 'a', status: 'pending', state: 'update', op: 'update', relPath: 'big.gd', mode: 'patch', patchBlocks: 2, stats: { added: 1, removed: 1 }, warnings: 0, historical: false },
    { id: 'b', status: 'pending', state: 'patch-failed', op: 'update', relPath: 'x.gd', mode: 'patch', patchBlocks: 1, stats: null, warnings: 0, historical: false },
    { id: 'c', status: 'pending', state: 'create', op: 'create', relPath: 'n.gd', mode: 'full', patchBlocks: 0, stats: { added: 3, removed: 0 }, warnings: 0, historical: false },
  ];
  const canned = {
    'state:get': { projects: [PROJECT], chatId: CHAT, project: PROJECT, lastProjectId: 'p1', ratio: 0.5 },
    'proposals:list': proposals,
    'proposal:get': {
      id: 'a', status: 'pending', state: 'update', op: 'update', relPath: 'big.gd', mode: 'patch', projectId: 'p1', incomplete: [], shrink: null, suggestions: [],
      stats: { added: 1, removed: 1 }, baseHash: 'h', contentHash: 'c', rows: [{ type: 'del', oldNo: 1, text: 'a' }, { type: 'add', newNo: 1, text: 'b' }],
      patchResults: [{ status: 'ok', method: 'block', line: 5, endLine: 8 }, { status: 'ok', method: 'trim', line: 9 }, { status: 'ok', method: 'exact', line: 1, wholeFile: true }], newText: 'b\n', rawText: 'raw',
      pathFixed: { from: 'proj/big.gd', to: 'big.gd' },
    },
    'history:list': [
      { id: 'h1', ts: Date.now(), op: 'update', relPath: 'a.gd', status: 'applied', pruned: true },
      { id: 'h2', ts: Date.now(), op: 'update', relPath: 'a.gd', status: 'applied' },
    ],
    'backups:stats': { files: 4, bytes: 2048 },
    'prompt:get': { sections, presets: [{ id: 'pr1', name: 'Godot' }], excluded: [], defaults: pg.defaultTexts() },
    'prompt:tree': tree,
    'prompt:build': { text: 'ПРОМПТ', partial: false },
    'prompt:copy': { ok: true, length: 6, partial: false },
    'fs:list': { items: [{ name: 'a.gd', rel: 'a.gd', isDir: false }] },
  };
  global.window = {
    innerWidth: 1500,
    api: {
      invoke: async (ch, arg) => {
        log.push([ch, arg]);
        return canned[ch] ?? null;
      },
      on: (ch, cb) => { handlers[ch] = cb; return () => {}; },
    },
  };
  global.confirm = () => true;
  global.requestAnimationFrame = (f) => setTimeout(f, 0);

  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a);
  require(path.join(__dirname, '..', 'ui', 'app.js'));
  await tick(60);

  const text = (el) => el.textContent;
  const tabs = findAll(roots.tabs, (e) => e.tag === 'button');
  assert.deepEqual(tabs.map((t) => text(t).replace(/\d+$/, '')), ['Предложения', 'Файлы', 'История', 'Промпт']);

  // карточки, крестик, бейдж патча
  assert.equal(findAll(roots.body, (e) => e.className === 'dismiss').length, 3);
  assert.match(text(roots.body), /частичная правка · 2/);
  assert.match(text(roots.body), /Правка не применяется/);
  assert.ok(!/Инструкция для ИИ/.test(text(roots.body)));

  // открыть патч-предложение
  await click(findAll(roots.body, (e) => e.tag === 'button' && e.className.startsWith('card'))[0]);
  assert.match(text(roots.body), /Частичная правка: блоков 3/);
  assert.match(text(roots.body), /функция\/класс заменены целиком, строки 5–8/);
  assert.match(text(roots.body), /без учёта отступов/);
  assert.match(text(roots.body), /почти весь файл/);
  assert.match(text(roots.body), /Путь исправлен автоматически: «proj\/big.gd» → «big.gd»/);
  assert.match(text(roots.body), /Просмотреть итоговый файл/);
  await click(findAll(roots.body, (e) => e.tag === 'button' && text(e) === '← К списку')[0]);

  // крестик
  await click(findAll(roots.body, (e) => e.className === 'dismiss')[0]);
  assert.ok(log.some(([ch, a]) => ch === 'proposal:dismiss' && a.id === 'a'));

  // история + бэкапы
  await click(tabs[2]);
  assert.match(text(roots.body), /Хранятся 2 последние версии/);
  assert.match(text(roots.body), /копия удалена/);
  const diffBtns = findAll(roots.body, (e) => e.tag === 'button' && text(e) === 'Diff');
  assert.equal(diffBtns.length, 1); // у устаревшей операции Diff скрыт
  await click(findAll(roots.body, (e) => e.tag === 'button' && text(e) === 'Очистить бэкапы')[0]);
  assert.ok(log.some(([ch]) => ch === 'backups:clear'));

  // вкладка «Промпт»
  await click(tabs[3]);
  await tick(80);
  const titles = findAll(roots.body, (e) => e.className === 'sec-title').map((e) => e.attrs.value);
  assert.deepEqual(titles, sections.map((s) => s.title)); // порядок и состав полей — как в наборе по умолчанию
  assert.ok(titles.includes('СТРУКТУРА ПРОЕКТА') && titles.includes('ЗАДАЧА'));
  const areas = findAll(roots.body, (e) => e.tag === 'textarea');
  assert.equal(areas.length, sections.filter((s) => s.type !== 'tree').length); // по одному полю на текстовую секцию
  // ищем поле по названию секции, а не по индексу: порядок полей может меняться
  const areaOf = (title) => {
    const sec = findAll(roots.body, (e) => e.tag === 'section').find((s) => findAll(s, (n) => n.className === 'sec-title' && n.attrs.value === title).length);
    return sec ? findAll(sec, (e) => e.tag === 'textarea')[0] : null;
  };
  assert.match(text(areaOf('ЧТО В КОНТЕКСТЕ')), /Файлы приложены в чат вложениями/);
  assert.match(text(areaOf('ПРАВИЛА РАБОТЫ')), /SEARCH/);

  // ввод в поле «Задача» сохраняется в черновик
  areaOf('ЗАДАЧА').listeners.input[0]({ target: { value: 'Сделать двойной прыжок', style: {}, scrollHeight: 10 } });
  await tick(520);
  const saved = log.filter(([ch]) => ch === 'prompt:save-draft').pop();
  assert.equal(saved[1].sections.find((s) => s.key === 'task').text, 'Сделать двойной прыжок');

  // дерево проекта: отключение папки
  const tree1 = document.querySelector('#prompt-tree');
  assert.ok(tree1, 'дерево нарисовано');
  const boxes = findAll(tree1, (e) => e.tag === 'input');
  assert.equal(boxes.length, 2); // scripts/ (свёрнута) и project.godot
  boxes[0].listeners.change[0]({ target: { checked: false } });
  await tick(30);
  const ex = log.filter(([ch]) => ch === 'prompt:set-excluded').pop();
  assert.deepEqual(ex[1].excluded, ['scripts']);
  assert.match(text(document.querySelector('#prompt-tree-count')), /Скрыто элементов: 1/);

  // добавить поле, удалить поле, копирование
  const secTitles = () => findAll(roots.body, (e) => e.className === 'sec-title');
  const before = secTitles().length; // 8 полей по умолчанию
  await click(findAll(roots.body, (e) => e.tag === 'button' && text(e) === '＋ Добавить поле')[0]);
  assert.equal(secTitles().length, before + 1);
  assert.equal(secTitles()[secTitles().length - 1].attrs.value, 'НОВОЕ ПОЛЕ');
  await click(findAll(roots.body, (e) => e.tag === 'button' && e.attrs.title === 'Удалить поле')[0]);
  assert.equal(secTitles().length, before);
  await click(findAll(roots.body, (e) => e.tag === 'button' && text(e) === 'Скопировать промпт')[0]);
  assert.ok(log.some(([ch]) => ch === 'prompt:copy'));
  await click(findAll(roots.body, (e) => e.tag === 'button' && text(e) === '⧗ Напомнить формат')[0]);
  assert.ok(log.some(([ch]) => ch === 'prompt:copy-reminder'));

  // «files:changed» не пересобирает форму (фокус в поле не теряется)
  const areaBefore = findAll(roots.body, (e) => e.tag === 'textarea')[0];
  await handlers['files:changed']();
  await tick(40);
  assert.equal(findAll(roots.body, (e) => e.tag === 'textarea')[0], areaBefore);

  console.error = origErr;
  assert.deepEqual(errors, []);
});

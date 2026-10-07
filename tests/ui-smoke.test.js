'use strict';
// Дымовой тест интерфейса на минимальной имитации DOM (без Electron и jsdom).
// Этап B: раскладка IDE — вкладки боковой панели, панель файлов (заголовок, плашка,
// данные для дерева), геометрия чата (chat:set-bounds / chat:set-visible), разделители.
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
    const cls = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      contains: (x) => cls.has(x),
      toggle: (x, force) => {
        const on = force === undefined ? !cls.has(x) : !!force;
        if (on) cls.add(x); else cls.delete(x);
        return on;
      },
    };
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

test('UI: раскладка IDE, вкладки, панель файлов, геометрия чата', async () => {
  const roots = {};
  for (const id of ['head', 'tabs', 'body', 'toast', 'workspace', 'chat-slot',
    'vsplit-chat', 'vsplit-files', 'vsplit-side', 'files-head', 'files-banner',
    'ed-tree', 'ed-tabs', 'ed-host', 'ed-empty', 'ed-status', 'ed-overlay']) { roots[id] = new El('div'); }
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
  const sent = []; // fire-and-forget (api.send): геометрия чата
  const handlers = {};
  const sections = pg.defaultSections();
  const tree = { truncated: false, nodes: [{ name: 'scripts', rel: 'scripts', isDir: true, children: [{ name: 'player.gd', rel: 'scripts/player.gd', isDir: false }] }, { name: 'project.godot', rel: 'project.godot', isDir: false }] };
  const proposals = [
    { id: 'a', status: 'pending', state: 'update', op: 'update', relPath: 'big.gd', mode: 'patch', patchBlocks: 2, stats: { added: 1, removed: 1 }, warnings: 0, historical: false },
    { id: 'b', status: 'pending', state: 'patch-failed', op: 'update', relPath: 'x.gd', mode: 'patch', patchBlocks: 1, stats: null, warnings: 0, historical: false },
    { id: 'c', status: 'pending', state: 'create', op: 'create', relPath: 'n.gd', mode: 'full', patchBlocks: 0, stats: { added: 3, removed: 0 }, warnings: 0, historical: false },
  ];
  const canned = {
    'state:get': { projects: [PROJECT], chatId: CHAT, project: PROJECT, lastProjectId: 'p1', layout: { chatW: 420, filesW: 220, sideW: 380, chatSide: 'left' } },
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
      // запись об откате: копии у неё не было, откатить повторно нельзя
      { id: 'h3', ts: Date.now(), op: 'create', relPath: 'n.gd', status: 'applied', pruned: true, source: 'rollback', revertible: false },
    ],
    'backups:stats': { files: 4, bytes: 2048 },
    'prompt:get': { sections, presets: [{ id: 'pr1', name: 'Godot' }], excluded: [], defaults: pg.defaultTexts() },
    'prompt:tree': tree,
    'prompt:build': { text: 'ПРОМПТ', partial: false },
    'prompt:copy': { ok: true, length: 6, partial: false },
    'context:list': {
      items: [{
        relPath: 'a.gd', knownHash: 'a', knownSource: 'applied',
        knownLabel: 'модель сама предложила это содержимое', knownTs: Date.now(),
        historyId: 'h9', diskHash: 'c', missing: false,
      }],
      checked: 1, truncated: false,
    },
    'context:known': { 'a.gd': 'a' },
    'context:ack': { ok: true, relPath: 'a.gd', hash: 'c' },
    'context:ack-all': { ok: true, acked: 1, total: 1, failed: [] },
    'manual:view': {
      relPath: 'a.gd', historyId: 'h9', diverged: true, currentHash: 'c', afterHash: 'a',
      knownVersion: { hash: 'a', source: 'applied', ts: Date.now(), label: 'модель сама предложила это содержимое' },
      stats: { added: 1, removed: 1 }, truncated: false, currentText: 'b\n',
      rows: [{ type: 'del', oldNo: 1, text: 'a' }, { type: 'add', newNo: 1, text: 'b' }],
    },
    'fs:list': { items: [{ name: 'a.gd', rel: 'a.gd', isDir: false }, { name: 'n.gd', rel: 'n.gd', isDir: false }] },
  };
  global.window = {
    innerWidth: 1500,
    addEventListener: () => {}, // resize окна: в тесте не нужен, но app.js его вешает
    api: {
      invoke: async (ch, arg) => {
        log.push([ch, arg]);
        return canned[ch] ?? null;
      },
      on: (ch, cb) => { handlers[ch] = cb; return () => {}; },
      send: (ch, arg) => { sent.push([ch, arg]); },
      zoomFactor: () => 1,
    },
  };
  global.confirm = () => true;
  global.requestAnimationFrame = (f) => setTimeout(f, 0);

  // заглушка редактора: smoke-тест проверяет СВЯЗИ в app.js, а не внутренности editor.js
  const ed = { mount: 0, els: null, setVisible: [], setProject: [], refreshDisk: 0, refreshTree: 0, extras: null, layoutCalls: 0 };
  global.window.WhaleEditor = {
    mount: (els, hooks) => { ed.mount++; ed.els = els; ed.hooks = hooks; },
    setProject: (p) => ed.setProject.push(p ? p.id : null),
    setVisible: (v) => ed.setVisible.push(v),
    refreshDisk: async () => { ed.refreshDisk++; },
    refreshTree: async () => { ed.refreshTree++; },
    setTreeExtras: (x) => { ed.extras = x; },
    layout: () => { ed.layoutCalls++; },
    hasUnsaved: () => false,
    dirtyPaths: () => [],
  };

  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a);
  // ui/dom.js и ui/layout.js должны быть загружены до app.js — как в index.html
  require(path.join(__dirname, '..', 'ui', 'dom.js'));
  assert.ok(global.window.WhaleDom && typeof global.window.WhaleDom.h === 'function');
  require(path.join(__dirname, '..', 'ui', 'layout.js'));
  assert.ok(global.window.WhaleLayout && typeof global.window.WhaleLayout.drag === 'function');
  require(path.join(__dirname, '..', 'ui', 'app.js'));
  await tick(60);

  const text = (el) => el.textContent;
  const btn = (root, label) => findAll(root, (e) => e.tag === 'button' && text(e) === label)[0];
  const tabs = findAll(roots.tabs, (e) => e.tag === 'button');
  // Этап B: «Редактор» и «Файлы» больше не вкладки — редактор всегда виден,
  // дерево живёт в панели файлов
  assert.deepEqual(tabs.map((t) => text(t).replace(/\d+$/, '')),
    ['Предложения', 'История', 'Промпт']);
  const TAB = { proposals: 0, history: 1, prompt: 2 };

  // редактор смонтирован один раз и со всеми нужными узлами (§7), видимость включена сразу
  assert.equal(ed.mount, 1);
  for (const k of ['tree', 'tabs', 'host', 'empty', 'status', 'overlay']) assert.ok(ed.els[k], `нет узла ${k}`);
  assert.equal(ed.setVisible[ed.setVisible.length - 1], true);

  // ---------- панель файлов: заголовок, плашка, данные дерева ----------
  assert.match(text(roots['files-head']), /ФАЙЛЫ/);
  assert.ok(btn(roots['files-head'], 'Скопировать для модели'), 'кнопка копирования версий для модели');
  assert.ok(btn(roots['files-head'], '✓ Модель знает все'), 'кнопка массовой отметки');
  assert.match(text(roots['files-banner']), /Модель не знает текущую версию: 1 файл/);
  assert.match(text(roots['files-banner']), /a\.gd/); // имена перечислены явно (свёрнутые папки)

  // отметки дерева: расхождения контекста, последняя откатимая операция, предложения
  assert.ok(ed.extras, 'данные дерева переданы в редактор');
  assert.deepEqual([...ed.extras.manual], ['a.gd']);
  assert.equal(ed.extras.undo.get('a.gd').id, 'h2'); // h1 — pruned, h3 — неоткатимый откат
  assert.equal(ed.extras.undo.has('n.gd'), false);
  assert.equal(ed.extras.proposals.get('big.gd').firstId, 'a');
  assert.equal(ed.extras.proposals.get('n.gd').count, 1);

  // клик по ◆ в дереве ведёт в сравнение «мои правки» (колбэк вызывает app.js)
  await ed.extras.callbacks.onManual('a.gd');
  await tick(30);
  assert.ok(log.some(([ch, a]) => ch === 'manual:view' && a.relPath === 'a.gd'));
  assert.match(text(roots.body), /Мои правки/);
  assert.match(text(roots.body), /Модель в чате не знает об этом изменении/);
  await click(btn(roots.body, '✓ Модель проинформирована'));
  assert.ok(log.some(([ch, a]) => ch === 'context:ack' && a.relPath === 'a.gd'));
  await tick(30);

  // клик по синей точке открывает карточку предложения
  await ed.extras.callbacks.onProposal('big.gd');
  await tick(30);
  assert.match(text(roots.body), /Частичная правка: блоков 3/);
  await click(btn(roots.body, '← К списку'));
  await tick(30);

  // откат из дерева — тот же обработчик, что был во вкладке «Файлы»
  await ed.extras.callbacks.onUndo({ id: 'h2', op: 'update', ts: Date.now() });
  await tick(60);
  assert.ok(log.some(([ch, a]) => ch === 'history:revert' && a.id === 'h2' && a.force === false));

  // «показать в проводнике»
  await ed.extras.callbacks.onReveal('a.gd');
  await tick(30);
  assert.ok(log.some(([ch, a]) => ch === 'file:open' && a.mode === 'reveal' && a.rel === 'a.gd'));

  // ---------- карточки предложений ----------
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
  assert.match(text(roots.body), /Путь исправлен автоматически: «proj\/big\.gd» → «big\.gd»/);
  assert.match(text(roots.body), /Просмотреть итоговый файл/);
  await click(btn(roots.body, '← К списку'));

  // крестик
  await click(findAll(roots.body, (e) => e.className === 'dismiss')[0]);
  assert.ok(log.some(([ch, a]) => ch === 'proposal:dismiss' && a.id === 'a'));

  // ---------- история + бэкапы ----------
  await click(tabs[TAB.history]);
  assert.match(text(roots.body), /Хранятся 2 последние версии/);
  assert.match(text(roots.body), /копия удалена/);
  const diffBtns = findAll(roots.body, (e) => e.tag === 'button' && text(e) === 'Diff');
  assert.equal(diffBtns.length, 1); // у устаревшей операции и у отката Diff скрыт
  // откат показан отдельным значком и не предлагает «Восстановить» — даже для create,
  // где обычное правило (pruned && op !== 'create') кнопку бы оставило
  assert.match(text(roots.body), /откат/);
  const revertBtns = findAll(roots.body, (e) => e.tag === 'button' && text(e) === 'Восстановить');
  assert.equal(revertBtns.length, 1);
  assert.equal(findAll(roots.body, (e) => text(e) === 'копия удалена').length, 1); // у отката такого значка нет
  await click(btn(roots.body, 'Очистить бэкапы'));
  assert.ok(log.some(([ch]) => ch === 'backups:clear'));

  // ---------- геометрия чата (§4, §6, §28) ----------
  // переключение стороны: класс на workspace, чат скрыт/показан, раскладка сохранена
  const sideBtn = btn(roots.head, 'Чат справа ⇄');
  assert.ok(sideBtn, 'кнопка переключения стороны чата');
  await click(sideBtn);
  await tick(30);
  assert.equal(roots.workspace.classList.contains('chat-right'), true);
  const vis = sent.filter(([ch]) => ch === 'chat:set-visible').map(([, v]) => v);
  assert.deepEqual(vis.slice(-2), [false, true], 'на время перестановки чат скрывается');
  let save = log.filter(([ch]) => ch === 'layout:save').pop();
  assert.equal(save[1].layout.chatSide, 'right');
  // кнопка перерисована под новое состояние
  assert.ok(btn(roots.head, 'Чат слева ⇄'));
  await click(btn(roots.head, 'Чат слева ⇄'));
  await tick(30);
  assert.equal(roots.workspace.classList.contains('chat-right'), false);

  // разделитель панели файлов: ширины считает ui/layout.js, сохранение — layout:save
  const sp = roots['vsplit-files'];
  const visBefore = sent.length;
  for (const f of sp.listeners.pointerdown) f({ button: 0, clientX: 500, pointerId: 1, preventDefault() {} });
  for (const f of sp.listeners.pointermove) f({ clientX: 550 });
  for (const f of sp.listeners.pointerup) f({});
  await tick(500); // сохранение с задержкой 400 мс
  save = log.filter(([ch]) => ch === 'layout:save').pop();
  assert.equal(save[1].layout.filesW, 270); // 220 + 50
  assert.equal(sent.length, visBefore, 'перетаскивание разделителя файлов не должно трогать видимость чата');
  assert.ok(ed.layoutCalls > 0, 'после разделителя Monaco пересчитан');

  // разделитель чата: на время перетаскивания чат скрыт, в конце показан
  const spc = roots['vsplit-chat'];
  sent.length = 0;
  for (const f of spc.listeners.pointerdown) f({ button: 0, clientX: 400, pointerId: 1, preventDefault() {} });
  assert.deepEqual(sent.filter(([ch]) => ch === 'chat:set-visible').map(([, v]) => v), [false]);
  for (const f of spc.listeners.pointermove) f({ clientX: 460 });
  for (const f of spc.listeners.pointerup) f({});
  await tick(450);
  assert.deepEqual(sent.filter(([ch]) => ch === 'chat:set-visible').map(([, v]) => v), [false, true]);
  save = log.filter(([ch]) => ch === 'layout:save').pop();
  assert.equal(save[1].layout.chatW, 480); // 420 + 60

  // ---------- вкладка «Промпт» ----------
  await click(tabs[TAB.prompt]);
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
  const savedDraft = log.filter(([ch]) => ch === 'prompt:save-draft').pop();
  assert.equal(savedDraft[1].sections.find((s) => s.key === 'task').text, 'Сделать двойной прыжок');

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
  await click(btn(roots.body, '＋ Добавить поле'));
  assert.equal(secTitles().length, before + 1);
  assert.equal(secTitles()[secTitles().length - 1].attrs.value, 'НОВОЕ ПОЛЕ');
  await click(findAll(roots.body, (e) => e.tag === 'button' && e.attrs.title === 'Удалить поле')[0]);
  assert.equal(secTitles().length, before);
  await click(btn(roots.body, 'Скопировать промпт'));
  assert.ok(log.some(([ch]) => ch === 'prompt:copy'));
  await click(btn(roots.body, '⧗ Напомнить формат'));
  assert.ok(log.some(([ch]) => ch === 'prompt:copy-reminder'));

  // «files:changed» не пересобирает форму (фокус в поле не теряется),
  // но доходит до дерева и редактора
  const areaBefore = findAll(roots.body, (e) => e.tag === 'textarea')[0];
  const refreshBefore = ed.refreshDisk;
  const treeBefore = ed.refreshTree;
  await handlers['files:changed']();
  await tick(60);
  // файл мог измениться под открытым буфером — редактор перечитывает хэши диска (§11)
  assert.ok(ed.refreshDisk > refreshBefore, 'files:changed дошёл до редактора');
  assert.ok(ed.refreshTree > treeBefore, 'files:changed перечитал дерево');
  assert.equal(findAll(roots.body, (e) => e.tag === 'textarea')[0], areaBefore);

  console.error = origErr;
  assert.deepEqual(errors, []);
});

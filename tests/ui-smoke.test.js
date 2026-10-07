'use strict';
// Дымовой тест интерфейса на минимальной имитации DOM (без Electron и jsdom).
// Раскладка после ручной проверки этапа B: левая панель (Файлы/Предложения/История),
// редактор с режимами (код / просмотр / «Промпт»), чат всегда справа, геометрия чата
// (chat:set-bounds / chat:set-visible) и разделители.
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

test('UI: левая панель, режимы редактора, геометрия чата', async () => {
  const roots = {};
  for (const id of ['head', 'left-tabs', 'files-pane', 'body', 'toast', 'workspace', 'chat-slot',
    'vsplit-left', 'vsplit-chat', 'files-head', 'files-banner', 'prompt-close',
    'view-host', 'diff-host', 'diff-bar', 'diff-editor', 'prompt-host', 'prompt-body',
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
    'state:get': { projects: [PROJECT], chatId: CHAT, project: PROJECT, lastProjectId: 'p1', layout: { leftW: 320, chatW: 420, promptOpen: false, leftTab: 'files' } },
    'proposals:list': proposals,
    'proposal:get': {
      id: 'a', status: 'pending', state: 'update', op: 'update', relPath: 'big.gd', mode: 'patch', patchBlocks: 2, projectId: 'p1', incomplete: [], shrink: null, suggestions: [],
      stats: { added: 1, removed: 1 }, baseHash: 'h', contentHash: 'c', rows: [{ type: 'del', oldNo: 1, text: 'a' }, { type: 'add', newNo: 1, text: 'b' }],
      patchResults: [{ status: 'ok', method: 'block', line: 5, endLine: 8 }, { status: 'ok', method: 'trim', line: 9 }, { status: 'ok', method: 'exact', line: 1, wholeFile: true }], newText: 'b\n', rawText: 'raw',
      pathFixed: { from: 'proj/big.gd', to: 'big.gd' },
      baseText: 'a\n', aiBaseText: 'a0\n',
    },
    'history:view': {
      id: 'h2', ts: Date.now(), op: 'update', relPath: 'a.gd', status: 'applied',
      stats: { added: 1, removed: 1 }, beforeText: 'a\n', afterText: 'b\n',
      rows: [{ type: 'del', oldNo: 1, text: 'a' }, { type: 'add', newNo: 1, text: 'b' }],
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
      baseText: 'a\n', base: 'context',
      rows: [{ type: 'del', oldNo: 1, text: 'a' }, { type: 'add', newNo: 1, text: 'b' }],
    },
    'fs:list': { items: [{ name: 'a.gd', rel: 'a.gd', isDir: false }, { name: 'n.gd', rel: 'n.gd', isDir: false }] },
  };
  global.window = {
    innerWidth: 1500,
    innerHeight: 900,
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
  const ed = { mount: 0, els: null, setVisible: [], setProject: [], refreshDisk: 0, refreshTree: 0, extras: null, layoutCalls: 0, diffs: [], hideDiff: 0, diffOk: true };
  global.window.WhaleEditor = {
    mount: (els, hooks) => { ed.mount++; ed.els = els; ed.hooks = hooks; },
    setProject: (p) => ed.setProject.push(p ? p.id : null),
    setVisible: (v) => ed.setVisible.push(v),
    refreshDisk: async () => { ed.refreshDisk++; },
    refreshTree: async () => { ed.refreshTree++; },
    setTreeExtras: (x) => { ed.extras = x; },
    layout: () => { ed.layoutCalls++; },
    showDiff: async (pair) => { ed.diffs.push(pair); return ed.diffOk; },
    hideDiff: () => { ed.hideDiff++; },
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
  const hidden = (el) => el.classList.contains('hidden');
  const leftTabs = () => findAll(roots['left-tabs'], (e) => e.tag === 'button');
  const leftTab = (label) => leftTabs().find((b) => text(b).replace(/\d+$/, '') === label);

  // ---------- левая панель: Файлы / Предложения / История ----------
  assert.deepEqual(leftTabs().map((t) => text(t).replace(/\d+$/, '')), ['Файлы', 'Предложения', 'История']);
  // нерассмотренные предложения подсвечены на ОБЕИХ вкладках: на «Файлах» — потому что
  // пользователь обычно смотрит в дерево и должен видеть, что его ждут предложения
  const filesCount = findAll(leftTab('Файлы'), (e) => e.className === 'count alert');
  assert.equal(filesCount.length, 1, 'на вкладке «Файлы» виден счётчик предложений');
  assert.equal(text(filesCount[0]), '3');
  const propCount = findAll(leftTab('Предложения'), (e) => e.className === 'count');
  assert.equal(text(propCount[0]), '3');

  // по умолчанию открыто дерево
  assert.equal(hidden(roots['files-pane']), false);
  assert.equal(hidden(roots.body), true);

  // редактор смонтирован один раз и со всеми нужными узлами (§7), режим — код
  assert.equal(ed.mount, 1);
  for (const k of ['tree', 'tabs', 'host', 'empty', 'status', 'overlay']) assert.ok(ed.els[k], `нет узла ${k}`);
  assert.equal(ed.setVisible[ed.setVisible.length - 1], true);
  assert.equal(hidden(roots['prompt-host']), true);
  assert.equal(hidden(roots['view-host']), true);

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

  // клик по ◆ в дереве открывает «мои правки» в Monaco DiffEditor ВМЕСТО редактора
  await ed.extras.callbacks.onManual('a.gd');
  await tick(40);
  assert.ok(log.some(([ch, a]) => ch === 'manual:view' && a.relPath === 'a.gd'));
  assert.equal(hidden(roots['diff-host']), false, 'дифф занял место редактора');
  assert.equal(hidden(roots['view-host']), true, 'подробный отчёт скрыт');
  assert.equal(hidden(roots['ed-tabs']), true, 'вкладки редактора скрыты');
  const manualDiff = ed.diffs[ed.diffs.length - 1];
  assert.deepEqual({ o: manualDiff.original, m: manualDiff.modified }, { o: 'a\n', m: 'b\n' });
  assert.match(text(roots['diff-bar']), /Мои правки/);
  assert.match(text(roots['diff-bar']), /Версия, которую знает модель/);
  // действия продублированы в шапке диффа — идти в отчёт за ними не нужно
  await click(btn(roots['diff-bar'], '✓ Модель проинформирована'));
  assert.ok(log.some(([ch, a]) => ch === 'context:ack' && a.relPath === 'a.gd'));
  await tick(40);
  // «Подробности» переключают на HTML-отчёт, «◧ Diff» возвращает в Monaco
  await click(btn(roots['diff-bar'], 'Подробности'));
  await tick(30);
  assert.equal(hidden(roots['view-host']), false);
  assert.match(text(roots['view-host']), /Модель в чате не знает об этом изменении/);
  await click(btn(roots['view-host'], '← Закрыть'));
  await tick(40);
  assert.equal(hidden(roots['view-host']), true, 'просмотр закрыт');
  assert.equal(hidden(roots['ed-tabs']), false, 'редактор вернулся');

  // клик по синей точке открывает предложение в Monaco-диффе и переключает левую панель
  const diffsBefore = ed.diffs.length;
  await ed.extras.callbacks.onProposal('big.gd');
  await tick(40);
  assert.equal(hidden(roots['diff-host']), false);
  const propDiff = ed.diffs[ed.diffs.length - 1];
  assert.deepEqual({ o: propDiff.original, m: propDiff.modified }, { o: 'a\n', m: 'b\n' });
  assert.equal(propDiff.leftLabel, 'Текущий файл на диске');
  assert.equal(log.filter(([ch]) => ch === 'layout:save').pop()[1].layout.leftTab, 'proposals');
  // база сравнения переключается на версию, которую видела модель
  await click(btn(roots['diff-bar'], 'База: файл на диске'));
  await tick(40);
  assert.equal(ed.diffs.length, diffsBefore + 2, 'дифф перерисован');
  assert.equal(ed.diffs[ed.diffs.length - 1].original, 'a0\n');
  assert.equal(ed.diffs[ed.diffs.length - 1].leftLabel, 'Версия, которую видела модель');
  await click(btn(roots['diff-bar'], '← К списку') || btn(roots['diff-bar'], '✕'));
  await tick(40);
  assert.equal(hidden(roots['diff-host']), true);

  // откат из дерева — тот же обработчик, что был во вкладке «Файлы»
  await ed.extras.callbacks.onUndo({ id: 'h2', op: 'update', ts: Date.now() });
  await tick(60);
  assert.ok(log.some(([ch, a]) => ch === 'history:revert' && a.id === 'h2' && a.force === false));

  // «показать в проводнике»
  await ed.extras.callbacks.onReveal('a.gd');
  await tick(30);
  assert.ok(log.some(([ch, a]) => ch === 'file:open' && a.mode === 'reveal' && a.rel === 'a.gd'));

  // ---------- список предложений (левая панель) ----------
  assert.equal(hidden(roots.body), false, 'после «← К списку» показаны предложения');
  assert.equal(findAll(roots.body, (e) => e.className === 'dismiss').length, 3);
  assert.match(text(roots.body), /частичная правка · 2/);
  assert.match(text(roots.body), /Правка не применяется/);
  assert.ok(!/Инструкция для ИИ/.test(text(roots.body)));
  // дубля кнопки открытия промпта в списке нет — переключатель живёт в шапке
  assert.ok(!btn(roots.body, 'Промпт для ИИ'), 'кнопка «Промпт для ИИ» удалена (дубль)');

  // открыть патч-предложение из списка — Monaco-дифф вместо редактора
  await click(findAll(roots.body, (e) => e.tag === 'button' && e.className.startsWith('card'))[0]);
  await tick(40);
  assert.equal(hidden(roots['diff-host']), false);
  assert.match(text(roots['diff-bar']), /Предложение модели/);
  assert.match(text(roots['diff-bar']), /частичная правка · 2/);
  await click(btn(roots['diff-bar'], 'Подробности'));
  await tick(30);
  assert.equal(hidden(roots['view-host']), false);
  assert.match(text(roots['view-host']), /Частичная правка: блоков 3/);
  assert.match(text(roots['view-host']), /функция\/класс заменены целиком, строки 5–8/);
  assert.match(text(roots['view-host']), /Путь исправлен автоматически: «proj\/big\.gd» → «big\.gd»/);
  assert.match(text(roots['view-host']), /Просмотреть итоговый файл/);
  await click(btn(roots['view-host'], '◧ Diff'));
  await tick(30);
  assert.equal(hidden(roots['diff-host']), false, 'из отчёта можно вернуться в Monaco-дифф');
  await click(btn(roots['diff-bar'], '✕'));
  await tick(40);
  assert.equal(hidden(roots['diff-host']), true);
  assert.ok(ed.hideDiff > 0, 'модели диффа освобождены при закрытии');

  // операция истории — тоже в Monaco-диффе
  await click(leftTab('История'));
  await tick(30);
  await click(btn(roots.body, 'Diff'));
  await tick(40);
  assert.equal(hidden(roots['diff-host']), false);
  const histDiff = ed.diffs[ed.diffs.length - 1];
  assert.deepEqual({ o: histDiff.original, m: histDiff.modified }, { o: 'a\n', m: 'b\n' });
  assert.equal(histDiff.leftLabel, 'До операции');
  await click(btn(roots['diff-bar'], '✕'));
  await tick(40);

  // Monaco недоступен — просмотр деградирует в подробный отчёт, а не в пустоту
  await click(leftTab('Предложения'));
  await tick(30);
  ed.diffOk = false;
  await click(findAll(roots.body, (e) => e.tag === 'button' && e.className.startsWith('card'))[0]);
  await tick(40);
  assert.equal(hidden(roots['view-host']), false, 'фолбэк на HTML-отчёт');
  assert.equal(hidden(roots['diff-host']), true);
  // кнопка «◧ Diff» остаётся (тексты на месте), но повторная попытка снова деградирует
  await click(btn(roots['view-host'], '◧ Diff'));
  await tick(40);
  assert.equal(hidden(roots['view-host']), false, 'без Monaco просмотр остаётся отчётом');
  ed.diffOk = true;
  await click(btn(roots['view-host'], '← К списку'));
  await tick(40);
  await click(leftTab('Файлы'));
  await tick(20);

  // крестик карточки
  await click(findAll(roots.body, (e) => e.className === 'dismiss')[0]);
  assert.ok(log.some(([ch, a]) => ch === 'proposal:dismiss' && a.id === 'a'));

  // ---------- история ----------
  await click(leftTab('История'));
  await tick(30);
  assert.match(text(roots.body), /Хранятся 2 последние версии/);
  assert.match(text(roots.body), /копия удалена/);
  const diffBtns = findAll(roots.body, (e) => e.tag === 'button' && text(e) === 'Diff');
  assert.equal(diffBtns.length, 1); // у устаревшей операции и у отката Diff скрыт
  assert.match(text(roots.body), /откат/);
  const revertBtns = findAll(roots.body, (e) => e.tag === 'button' && text(e) === 'Восстановить');
  assert.equal(revertBtns.length, 1);
  await click(btn(roots.body, 'Очистить бэкапы'));
  assert.ok(log.some(([ch]) => ch === 'backups:clear'));
  await click(leftTab('Файлы'));
  await tick(20);
  assert.equal(hidden(roots['files-pane']), false);
  assert.equal(hidden(roots.body), true);

  // ---------- «Промпт» вместо редактора, с возвратом в прежнее окно ----------
  const promptBtn = btn(roots.head, 'Промпт');
  assert.ok(promptBtn, 'кнопка «Промпт» в шапке');
  await click(promptBtn);
  await tick(80);
  assert.equal(hidden(roots['prompt-host']), false, 'промпт занял место редактора');
  assert.equal(hidden(roots['ed-tabs']), true, 'вкладки редактора скрыты');
  assert.equal(ed.setVisible[ed.setVisible.length - 1], false, 'редактор выключен');
  assert.ok(btn(roots.head, 'Редактор кода'), 'кнопка сменила подпись');
  let save = log.filter(([ch]) => ch === 'layout:save').pop();
  assert.equal(save[1].layout.promptOpen, true);

  // открытый поверх «Промпта» просмотр по кнопке возвращает в «Промпт»
  await click(leftTab('Предложения'));
  await tick(30);
  await click(findAll(roots.body, (e) => e.tag === 'button' && e.className.startsWith('card'))[0]);
  await tick(40);
  assert.equal(hidden(roots['diff-host']), false, 'просмотр важнее промпта, пока открыт');
  assert.ok(btn(roots.head, 'Промпт'), 'кнопка снова предлагает «Промпт»');
  await click(btn(roots.head, 'Промпт'));
  await tick(60);
  assert.equal(hidden(roots['prompt-host']), false);
  assert.ok(btn(roots.head, '← Просмотр'), 'подпись обещает возврат к просмотру');
  await click(btn(roots.head, '← Просмотр'));
  await tick(40);
  assert.equal(hidden(roots['diff-host']), false, 'вернулись в тот же просмотр');
  await click(btn(roots['diff-bar'], '✕'));
  await tick(40);
  assert.equal(hidden(roots['prompt-host']), false, 'закрыли просмотр — под ним снова «Промпт»');
  await click(leftTab('Файлы'));
  await tick(20);

  const pb = roots['prompt-body'];
  const titles = findAll(pb, (e) => e.className === 'sec-title').map((e) => e.attrs.value);
  assert.deepEqual(titles, sections.map((s) => s.title));
  assert.ok(titles.includes('СТРУКТУРА ПРОЕКТА') && titles.includes('ЗАДАЧА'));
  const areas = findAll(pb, (e) => e.tag === 'textarea');
  assert.equal(areas.length, sections.filter((s) => s.type !== 'tree').length);
  const areaOf = (title) => {
    const sec = findAll(pb, (e) => e.tag === 'section').find((s) => findAll(s, (n) => n.className === 'sec-title' && n.attrs.value === title).length);
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

  // добавить поле, удалить поле, копирование промпта
  const secTitles = () => findAll(pb, (e) => e.className === 'sec-title');
  const before = secTitles().length; // 8 полей по умолчанию
  await click(btn(pb, '＋ Добавить поле'));
  assert.equal(secTitles().length, before + 1);
  assert.equal(secTitles()[secTitles().length - 1].attrs.value, 'НОВОЕ ПОЛЕ');
  await click(findAll(pb, (e) => e.tag === 'button' && e.attrs.title === 'Удалить поле')[0]);
  assert.equal(secTitles().length, before);
  await click(btn(pb, 'Скопировать промпт'));
  assert.ok(log.some(([ch]) => ch === 'prompt:copy'));
  // «Напомнить формат» переехал в шапку — в форме его больше нет
  assert.ok(!btn(pb, '⧗ Напомнить формат'), 'памятка формата больше не в форме промпта');

  // крестик ✕ закрывает «Промпт» полностью (в отличие от переключателя в шапке)
  await click(roots['prompt-close']);
  await tick(40);
  assert.equal(hidden(roots['prompt-host']), true);
  assert.equal(hidden(roots['ed-tabs']), false, 'редактор вернулся');
  save = log.filter(([ch]) => ch === 'layout:save').pop();
  assert.equal(save[1].layout.promptOpen, false);

  // «files:changed» не пересобирает форму (фокус в поле не теряется)
  await click(btn(roots.head, 'Промпт'));
  await tick(60);
  const areaBefore = findAll(pb, (e) => e.tag === 'textarea')[0];
  const refreshBefore = ed.refreshDisk;
  const treeBefore = ed.refreshTree;
  await handlers['files:changed']();
  await tick(60);
  assert.ok(ed.refreshDisk > refreshBefore, 'files:changed дошёл до редактора');
  assert.ok(ed.refreshTree > treeBefore, 'files:changed перечитал дерево');
  assert.equal(findAll(pb, (e) => e.tag === 'textarea')[0], areaBefore);

  // открытие файла из дерева возвращает панель в режим редактора и закрывает «Промпт»
  await ed.hooks.onWantEditorMode();
  await tick(30);
  assert.equal(hidden(roots['prompt-host']), true);
  assert.equal(hidden(roots['ed-tabs']), false);
  assert.equal(ed.setVisible[ed.setVisible.length - 1], true);
  save = log.filter(([ch]) => ch === 'layout:save').pop();
  assert.equal(save[1].layout.promptOpen, false);

  // ---------- шапка: памятка формата ----------
  await click(btn(roots.head, '⧗ Напомнить формат'));
  assert.ok(log.some(([ch]) => ch === 'prompt:copy-reminder'));

  // ---------- геометрия чата (§4, §28): чат всегда справа ----------
  // разделитель левой панели: размеры считает ui/layout.js, сохранение — layout:save
  const sp = roots['vsplit-left'];
  const sentBefore = sent.length;
  for (const f of sp.listeners.pointerdown) f({ button: 0, clientX: 500, pointerId: 1, preventDefault() {} });
  for (const f of sp.listeners.pointermove) f({ clientX: 550 });
  for (const f of sp.listeners.pointerup) f({});
  await tick(60);
  save = log.filter(([ch]) => ch === 'layout:save').pop();
  assert.equal(save[1].layout.leftW, 370); // 320 + 50
  assert.equal(sent.length, sentBefore, 'разделитель левой панели не трогает чат');
  assert.ok(ed.layoutCalls > 0, 'после разделителя Monaco пересчитан');

  // разделитель чата: на время перетаскивания чат скрыт, в конце показан;
  // разделитель слева от чата, поэтому движение ВЛЕВО делает чат шире
  const spc = roots['vsplit-chat'];
  sent.length = 0;
  for (const f of spc.listeners.pointerdown) f({ button: 0, clientX: 1100, pointerId: 1, preventDefault() {} });
  assert.deepEqual(sent.filter(([ch]) => ch === 'chat:set-visible').map(([, v]) => v), [false]);
  for (const f of spc.listeners.pointermove) f({ clientX: 1040 });
  for (const f of spc.listeners.pointerup) f({});
  await tick(60);
  assert.deepEqual(sent.filter(([ch]) => ch === 'chat:set-visible').map(([, v]) => v), [false, true]);
  save = log.filter(([ch]) => ch === 'layout:save').pop();
  assert.equal(save[1].layout.chatW, 480); // 420 + 60

  console.error = origErr;
  assert.deepEqual(errors, []);
});

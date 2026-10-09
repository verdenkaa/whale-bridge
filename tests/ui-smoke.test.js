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
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  setPointerCapture() {}
  // addon-fit измеряет контейнер через getBoundingClientRect
  getBoundingClientRect() { return { width: 600, height: 200, x: 0, y: 0 }; }
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
    'view-host', 'diff-host', 'diff-bar', 'diff-notices', 'hunk-strip', 'diff-editor',
    'prompt-host', 'prompt-body',
    'ed-tree', 'ed-tabs', 'ed-host', 'ed-empty', 'ed-status', 'ed-overlay',
    'ed-content', 'hsplit-term', 'term-panel', 'term-bar', 'term-host', 'xterm-css',
    'settings-host', 'settings-body', 'settings-close']) { roots[id] = new El('div'); }
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
  // Настройки запуска (этап C3b): config.run и результат tools:detect покрывают все
  // четыре статуса таблицы — найден в PATH, взят из настроек, битый ручной путь
  // (с запасом в PATH и без него) и «не найден».
  const RUN_CFG = {
    tools: { python: null, node: null, cpp: 'C:\\gone\\g++.exe', c: null, javac: 'C:\\jdk\\bin\\javac.exe', java: 'C:\\gone\\java.exe' },
    args: { python: '', cpp: '', c: '', java: '' },
    timeoutSec: 600, shellWin: 'cmd',
  };
  const TOOLS = {
    python: { found: true, exe: 'C:\\Python312\\python.exe', source: 'path', version: { text: '3.12.4', major: 3 }, brokenManual: false, candidates: [] },
    node: { found: true, exe: 'C:\\node\\node.exe', source: 'path', version: { text: '22.9.0', major: 22 }, brokenManual: false, candidates: [] },
    cpp: { found: true, exe: 'C:\\mingw64\\bin\\g++.exe', source: 'path', version: null, brokenManual: true, candidates: [] },
    c: { found: false, exe: null, source: null, version: null, brokenManual: false, candidates: [] },
    javac: { found: true, exe: 'C:\\jdk\\bin\\javac.exe', source: 'manual', version: { text: '17.0.2', major: 17 }, brokenManual: false, candidates: [] },
    java: { found: false, exe: null, source: null, version: null, brokenManual: true, candidates: [] },
    dotnet: { found: true, exe: 'C:\\Program Files\\dotnet\\dotnet.exe', source: 'path', version: { text: '8.0.404', major: 8 }, brokenManual: false, candidates: [] },
  };
  const detectCalls = [];
  const pickCalls = [];
  const runSaveCalls = [];
  const executedCalls = []; // proposal:executed — пометка «выполнено» для карточек &RUN:/&CMD:
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
      // этап D: файлы, которых модель не видела вовсе (созданы/изменены вне чата)
      unseen: [{ relPath: 'n.gd', isNew: true }], unseenTruncated: false,
    },
    'context:known': { 'a.gd': 'a' },
    'context:ack': { ok: true, relPath: 'a.gd', hash: 'c' },
    'context:ack-all': { ok: true, acked: 2, total: 2, failed: [] },
    'manual:copy': { ok: true, files: 2, length: 100, asDiff: 1, asFull: 0, asNew: 1, skipped: 0, truncated: false },
    'manual:view': {
      relPath: 'a.gd', historyId: 'h9', diverged: true, currentHash: 'c', afterHash: 'a',
      knownVersion: { hash: 'a', source: 'applied', ts: Date.now(), label: 'модель сама предложила это содержимое' },
      stats: { added: 1, removed: 1 }, truncated: false, currentText: 'b\n',
      baseText: 'a\n', base: 'context',
      rows: [{ type: 'del', oldNo: 1, text: 'a' }, { type: 'add', newNo: 1, text: 'b' }],
    },
    'fs:list': { items: [{ name: 'a.gd', rel: 'a.gd', isDir: false }, { name: 'n.gd', rel: 'n.gd', isDir: false }] },
    // запуск (этап C3): успешный старт, остановка и отчёт
    'run:start': { ok: true, sessionId: 's1' },
    'run:stop': { ok: true },
    'run:copy-report': { ok: true, length: 42 },
    // настройки запуска (этап C3b): чтение config.run, обнаружение инструментов,
    // диалог выбора файла и сохранение. Функции вместо значений — чтобы сохранить
    // присланное и вернуть его обратно, как делает main.
    'settings:get': { ok: true, run: RUN_CFG },
    'tools:detect': (arg) => { detectCalls.push(arg || {}); return { ok: true, tools: TOOLS, run: RUN_CFG }; },
    'tools:pick': (arg) => { pickCalls.push(arg || {}); return { ok: true, path: 'C:\\mingw64\\bin\\g++.exe' }; },
    'settings:save': (arg) => { runSaveCalls.push(arg.run); return { ok: true, run: arg.run }; },
  };
  global.window = {
    innerWidth: 1500,
    innerHeight: 900,
    addEventListener: () => {}, // resize окна: в тесте не нужен, но app.js его вешает
    api: {
      invoke: async (ch, arg) => {
        log.push([ch, arg]);
        const v = canned[ch];
        return typeof v === 'function' ? v(arg) : (v ?? null);
      },
      on: (ch, cb) => { handlers[ch] = cb; return () => {}; },
      send: (ch, arg) => { sent.push([ch, arg]); },
      zoomFactor: () => 1,
    },
  };
  global.confirm = () => true;
  global.requestAnimationFrame = (f) => setTimeout(f, 0);
  global.self = global.window; // UMD-обёртки (xterm, runlangs) в браузере используют self

  // Имитация xterm.js: пишущийся «терминал» и считаемые fit-размеры. Настоящий
  // @xterm/xterm требует DOM и canvas — здесь достаточно контракта (write/clear/reset/
  // focus/onData/loadAddon/cols/rows), чтобы проверить СВЯЗИ app.js и terminal.js.
  const termState = { writes: [], clears: 0, resets: 0, focuses: 0, dataCb: null, cols: 100, rows: 30 };
  global.window.Terminal = class {
    constructor() { this.cols = termState.cols; this.rows = termState.rows; }
    open() {}
    write(s) { termState.writes.push(s); }
    clear() { termState.clears++; }
    reset() { termState.resets++; }
    focus() { termState.focuses++; }
    onData(cb) { termState.dataCb = cb; }
    loadAddon() {}
  };
  global.window.FitAddon = { FitAddon: class { fit() {} } };

  // заглушка редактора: smoke-тест проверяет СВЯЗИ в app.js, а не внутренности editor.js
  const ed = {
    mount: 0, els: null, setVisible: [], setProject: [], refreshDisk: 0, refreshTree: 0, extras: null,
    layoutCalls: 0, diffs: [], hideDiff: 0, diffOk: true, getTextValue: null, staged: new Map(),
    // запуск (этап C3): сохранение dirty-буферов, активный файл, кнопка во вкладках
    saveAll: [], activeFileValue: { projectId: 'p1', rel: 'main.py', name: 'main.py' }, tabsExtras: null,
  };
  global.window.WhaleEditor = {
    mount: (els, hooks) => { ed.mount++; ed.els = els; ed.hooks = hooks; },
    saveAllDirty: async () => { const r = ed.saveAll.length ? ed.saveAll.shift() : true; return r; },
    activeFile: () => ed.activeFileValue,
    setTabsExtras: (nodes) => { ed.tabsExtras = nodes; },
    setProject: (p) => ed.setProject.push(p ? p.id : null),
    setVisible: (v) => ed.setVisible.push(v),
    refreshDisk: async () => { ed.refreshDisk++; },
    refreshTree: async () => { ed.refreshTree++; },
    setTreeExtras: (x) => { ed.extras = x; },
    layout: () => { ed.layoutCalls++; },
    showDiff: async (pair) => { ed.diffs.push(pair); return ed.diffOk; },
    hideDiff: () => { ed.hideDiff++; },
    getText: () => ed.getTextValue,
    stagedProposals: () => ed.staged,
    acceptIntoBuffer: async () => true,
    saveActive: async () => true,
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
  // src/diff.js и src/hunks.js — UMD, общие для main и renderer: в браузере их грузит
  // index.html до app.js, здесь повторяем тот же порядок
  require(path.join(__dirname, '..', 'src', 'diff.js'));
  require(path.join(__dirname, '..', 'src', 'hunks.js'));
  assert.ok(global.window.WhaleHunks && typeof global.window.WhaleHunks.toHunks === 'function');
  // src/runlangs.js и ui/terminal.js грузятся index.html до app.js — повторяем порядок
  require(path.join(__dirname, '..', 'src', 'runlangs.js'));
  assert.ok(global.window.WhaleRunLangs && typeof global.window.WhaleRunLangs.classifyCommand === 'function');
  // модель представления настроек (src/runsettings.js) грузится сразу за runlangs
  require(path.join(__dirname, '..', 'src', 'runsettings.js'));
  assert.ok(global.window.WhaleRunSettings && typeof global.window.WhaleRunSettings.toolRows === 'function');
  require(path.join(__dirname, '..', 'ui', 'terminal.js'));
  assert.ok(global.window.WhaleTerminal && typeof global.window.WhaleTerminal.write === 'function');
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
  // этап D: файлы, которых модель не видела вовсе, — отдельная плашка и отметки дерева
  assert.match(text(roots['files-banner']), /Модель не видела: 1 файл/);
  assert.match(text(roots['files-banner']), /n\.gd/);

  // отметки дерева: расхождения контекста, невиденные файлы, последняя откатимая операция, предложения
  assert.ok(ed.extras, 'данные дерева переданы в редактор');
  assert.deepEqual([...ed.extras.manual], ['a.gd']);
  assert.deepEqual([...ed.extras.unseen], ['n.gd']);
  assert.equal(ed.extras.undo.get('a.gd').id, 'h2'); // h1 — pruned, h3 — неоткатимый откат
  assert.equal(ed.extras.undo.has('n.gd'), false);
  assert.equal(ed.extras.proposals.get('big.gd').firstId, 'a');
  assert.equal(ed.extras.proposals.get('n.gd').count, 1);

  // «Скопировать для модели» — одна кнопка на всё, чем модель отстала (manual:copy):
  // расхождения (diff) и новые файлы (целиком) уходят в буфер вместе
  await click(btn(roots['files-head'], 'Скопировать для модели'));
  await tick(40);
  assert.ok(log.some(([ch]) => ch === 'manual:copy'), 'копирование уходит через manual:copy');
  assert.match(text(roots.toast), /Скопировано файлов: 2/);
  assert.match(text(roots.toast), /1 новых/);

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
  await click(btn(roots['diff-bar'], '✕'));
  await tick(40);
  assert.equal(hidden(roots['diff-host']), true, 'просмотр закрыт');
  assert.equal(hidden(roots['ed-tabs']), false, 'редактор вернулся');

  // клик по синей точке открывает предложение в Monaco-диффе и переключает левую панель.
  // Буфер совпадает с диском ('a'), база модели — снимок 'a0': предпросмотр слияния
  // при расхождении деградирует к тексту предложения, а переключатель режима показывает
  // базу модели явно.
  ed.getTextValue = 'a\n';
  const diffsBefore = ed.diffs.length;
  await ed.extras.callbacks.onProposal('big.gd');
  await tick(40);
  assert.equal(hidden(roots['diff-host']), false);
  const propDiff = ed.diffs[ed.diffs.length - 1];
  assert.deepEqual({ o: propDiff.original, m: propDiff.modified }, { o: 'a\n', m: 'b\n' });
  assert.equal(propDiff.leftLabel, 'Ваш файл сейчас');
  assert.equal(log.filter(([ch]) => ch === 'layout:save').pop()[1].layout.leftTab, 'proposals');
  // переключатель режима сравнения: версия модели → предложение
  await click(btn(roots['diff-bar'], 'Сравнение: ваш файл → результат'));
  await tick(40);
  assert.equal(ed.diffs.length, diffsBefore + 2, 'дифф перерисован');
  assert.equal(ed.diffs[ed.diffs.length - 1].original, 'a0\n');
  assert.equal(ed.diffs[ed.diffs.length - 1].leftLabel, 'Версия, которую видела модель');
  await click(btn(roots['diff-bar'], 'Сравнение: версия модели → предложение'));
  await tick(40);
  await click(btn(roots['diff-bar'], '✕'));
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
  // предупреждения живут полоской над диффом — отдельного режима «Подробности» нет:
  // он дублировал дифф (ручная проверка патча 0015)
  assert.equal(hidden(roots['view-host']), true, 'отчёт не открывается сам');
  assert.ok(!btn(roots['diff-bar'], 'Отчёт'), 'кнопки «Отчёт»/«Подробности» в шапке диффа нет');
  assert.match(text(roots['diff-notices']), /Частичная правка: блоков 3/);
  assert.match(text(roots['diff-notices']), /Путь исправлен автоматически: «proj\/big\.gd» → «big\.gd»/);
  const patchRows = findAll(roots['diff-notices'], (e) => e.tag === 'summary');
  assert.equal(patchRows.length, 1);
  await click(patchRows[0]); // <details> раскрывается нативно — проверяем содержимое
  assert.match(text(roots['diff-notices']), /строки 5–8|Блок 1/);
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

  // ---------- принятие предложения по ханкам в буфер (§20–§22) ----------
  // Предложение big.gd: база модели (снимок) 'a0\n', предложено 'b\n'.
  // Буфер 'a0\n' = база: слияние быстро и точно равно предложению.
  ed.getTextValue = 'a0\n';
  await click(leftTab('Предложения'));
  await tick(30);
  await click(findAll(roots.body, (e) => e.tag === 'button' && e.className.startsWith('card'))[0]);
  await tick(60);
  assert.equal(hidden(roots['diff-host']), false);

  // список ханков нарисован, по умолчанию выбраны все
  const hunkBoxes = findAll(roots['hunk-strip'], (e) => e.tag === 'input');
  assert.equal(hunkBoxes.length, 1, 'ханк один: a0 → b');
  assert.ok('checked' in hunkBoxes[0].attrs, 'ханк выбран по умолчанию'); // boolean-атрибут
  assert.match(text(roots['hunk-strip']), /Изменений: 1/);
  assert.match(text(roots['hunk-strip']), /выбрано 1/);

  // предпросмотр: слева ваш буфер, справа — результат принятия
  const preview = ed.diffs[ed.diffs.length - 1];
  assert.equal(preview.original, 'a0\n', 'слева — ваш файл');
  assert.equal(preview.modified, 'b\n', 'справа — результат принятия');
  assert.equal(preview.leftLabel, 'Ваш файл сейчас');

  // снять галочку — предпросмотр возвращается к вашему файлу (пустой дифф)
  hunkBoxes[0].listeners.change[0]({ target: { checked: false } });
  await tick(40);
  const empty = ed.diffs[ed.diffs.length - 1];
  assert.deepEqual({ o: empty.original, m: empty.modified }, { o: 'a0\n', m: 'a0\n' });
  hunkBoxes[0] && findAll(roots['hunk-strip'], (e) => e.tag === 'input')[0].listeners.change[0]({ target: { checked: true } });
  await tick(40);

  // принять в буфер: текст уходит в редактор, на диск ничего не пишется
  const accepted = [];
  global.window.WhaleEditor.acceptIntoBuffer = async (pid, rel, txt, info) => { accepted.push({ pid, rel, txt, info }); return true; };
  await click(btn(roots['diff-bar'], 'Принять все (1) в буфер'));
  await tick(60);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].rel, 'big.gd');
  assert.equal(accepted[0].txt, 'b\n');
  assert.equal(accepted[0].info.acceptedHunks, 1);
  assert.equal(accepted[0].info.totalHunks, 1);
  assert.equal(accepted[0].info.proposedText, 'b\n', 'точный текст предложения — для честного учёта контекста');
  assert.ok(!log.some(([ch]) => ch === 'file:write'), 'принятие в буфер НЕ пишет на диск');
  // карточка и шапка диффа помечают, что изменения ждут сохранения
  ed.staged.set('a', { path: 'big.gd', acceptedHunks: 1, totalHunks: 1, contentHash: 'c' });
  await click(leftTab('История')); // перерисовать список
  await tick(20);
  await click(leftTab('Предложения'));
  await tick(30);
  assert.match(text(roots.body), /в буфере редактора/);

  // «Принять и сохранить» вызывает сохранение редактора и закрывает просмотр
  let saveCalls = 0;
  global.window.WhaleEditor.saveActive = async () => { saveCalls++; return true; };
  await click(findAll(roots.body, (e) => e.tag === 'button' && e.className.startsWith('card'))[0]);
  await tick(60);
  await click(btn(roots['diff-bar'], 'Принять и сохранить'));
  await tick(60);
  assert.equal(saveCalls, 1);
  assert.equal(hidden(roots['diff-host']), true, 'после сохранения просмотр закрыт');
  ed.staged.clear();

  // пересечение правок: буфер 'c\n', база модели 'a0\n', предложение 'b\n' — конфликт.
  // В буфер не пишется ничего, показывается отчёт с маркерами (§22).
  ed.getTextValue = 'c\n';
  await click(findAll(roots.body, (e) => e.tag === 'button' && e.className.startsWith('card'))[0]);
  await tick(60);
  const acceptedBefore = accepted.length;
  await click(btn(roots['diff-bar'], 'Принять все (1) в буфер'));
  await tick(60);
  assert.equal(accepted.length, acceptedBefore, 'при конфликте в буфер ничего не пишется');
  assert.equal(hidden(roots['view-host']), false, 'показан отчёт о конфликте');
  assert.match(text(roots['view-host']), /Конфликт merge/);
  assert.match(text(roots['view-host']), /Ни диск, ни буфер редактора не изменены/);
  await click(btn(roots['view-host'], '← К предложению'));
  await tick(60);
  assert.equal(hidden(roots['view-host']), true, 'отчёт закрыт');
  ed.getTextValue = 'a\n';

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

  // ---------- терминал и запуск (этап C3, §2) ----------
  // Разметка index.html объявляет панель и разделитель скрытыми (class="hidden") —
  // имитация DOM повторяет стартовое состояние разметки.
  roots['term-panel'].classList.add('hidden');
  roots['hsplit-term'].classList.add('hidden');
  assert.equal(hidden(roots['term-panel']), true, 'терминал закрыт до первого действия');
  assert.equal(hidden(roots['hsplit-term']), true);
  // Хост терминала получает размер: без него fit() не вызывается вовсе, а нам нужно
  // проверить, что размер уходит в main ровно один раз (холостой resize перерисовывает
  // экран ConPTY и «стирает» терминал у программы, ждущей ввода).
  roots['term-host'].clientWidth = 600;
  roots['term-host'].clientHeight = 200;

  // кнопка «Терминал» в шапке открывает панель и сохраняет раскладку
  await click(btn(roots.head, 'Терминал'));
  await tick(60);
  assert.equal(hidden(roots['term-panel']), false, 'панель терминала открыта');
  assert.equal(hidden(roots['hsplit-term']), false);
  save = log.filter(([ch]) => ch === 'layout:save').pop();
  assert.equal(save[1].layout.termOpen, true);
  // xterm создан один раз, стили подключены при первом открытии
  assert.equal(global.window.WhaleTerminal.isMounted(), true);
  assert.match(roots['term-host'].getAttribute('href') || '', /^$/); // сам host — не <link>
  const xtermCss = global.document.querySelector('#xterm-css');
  assert.match(xtermCss.getAttribute('href'), /xterm\.css$/);

  // Размер терминала уходит в main один раз: повторный fit с той же геометрией
  // run:resize не порождает. Холостой resize не безвреден — ConPTY перерисовывает экран
  // из своего буфера, и программа, ждущая ввода, «стирала» видимый терминал.
  const resizes = () => sent.filter(([ch]) => ch === 'run:resize').map(([, v]) => v);
  assert.deepEqual(resizes(), [{ cols: 100, rows: 30 }], 'размер отправлен один раз');
  global.window.WhaleTerminal.fit();
  global.window.WhaleTerminal.fit();
  await tick(80);
  assert.deepEqual(resizes(), [{ cols: 100, rows: 30 }], 'тот же размер повторно не отправляется');

  // кнопка «▶ Запустить» передаётся в строку вкладок редактора
  assert.ok(Array.isArray(ed.tabsExtras) && ed.tabsExtras.length === 1, 'кнопка запуска добавлена во вкладки');
  const runBtn = ed.tabsExtras[0];
  assert.equal(text(runBtn), '▶ Запустить');

  // запуск активного файла: очистка терминала → сохранение dirty-буферов → run:start →
  // статус в toolbar'е. Экран чистится ДО старта (каждый прогон начинается с чистого
  // терминала), иначе вывод процесса успел бы прийти раньше очистки.
  ed.activeFileValue = { projectId: 'p1', rel: 'main.py', name: 'main.py' };
  const resetsBefore = termState.resets;
  await click(runBtn);
  await tick(60);
  assert.equal(termState.resets, resetsBefore + 1, 'терминал очищен перед запуском');
  const startCall = log.filter(([ch]) => ch === 'run:start').pop();
  assert.ok(startCall, 'run:start отправлен');
  assert.deepEqual(startCall[1].target, { kind: 'file', rel: 'main.py' });
  assert.equal(startCall[1].projectId, 'p1');
  // геометрия передаётся сразу со стартом: pty рождается нужного размера, и первый
  // resize после открытия панели становится не нужен
  assert.equal(startCall[1].cols, 100);
  assert.equal(startCall[1].rows, 30);
  assert.match(text(roots['term-bar']), /Запуск: main\.py/);

  // вывод процесса приходит событием run:data и попадает в xterm как есть
  handlers['run:data']({ sessionId: 's1', step: 0, text: 'Результат: 10\r\n' });
  await tick(10);
  assert.ok(termState.writes.includes('Результат: 10\r\n'), 'вывод записан в терминал');

  // двухшаговый план: run:exit с nextStep печатает разделитель локально
  handlers['run:exit']({ sessionId: 's1', code: 0, step: 0, nextStep: { index: 1, kind: 'run' } });
  await tick(10);
  assert.ok(termState.writes.some((w) => w.includes('── запуск ──')), 'разделитель шагов напечатан');

  // завершение: код возврата 0 — зелёным в статусе.
  // Порядок событий как в жизни: run:exit, затем run:state(active:null)
  handlers['run:exit']({ sessionId: 's1', code: 0, step: 1, reason: null });
  handlers['run:state']({ active: null });
  await tick(10);
  assert.match(text(roots['term-bar']), /Код возврата: 0/);
  const okStatus = findAll(roots['term-bar'], (e) => e.className === 'term-status ok');
  assert.equal(okStatus.length, 1, 'нулевой код подсвечен');

  // компилируемый язык: первая фаза подписана «Компиляция», а не «Запуск» — процесс
  // ещё ничего не запускал. Служебная строка печатается по run:state: main отправляет
  // его до старта pty, поэтому строка оказывается раньше вывода компилятора.
  canned['run:start'] = { ok: true, sessionId: 'scpp', stepKind: 'build' };
  ed.activeFileValue = { projectId: 'p1', rel: 'app.cpp', name: 'app.cpp' };
  termState.writes.length = 0;
  await click(runBtn);
  await tick(40);
  handlers['run:state']({ active: { kind: 'file', label: 'app.cpp', state: 'running', sessionId: 'scpp', step: 0, stepKind: 'build' } });
  await tick(10);
  assert.ok(termState.writes.some((w) => w.includes('── компиляция ──')), 'фаза компиляции помечена в терминале');
  assert.match(text(roots['term-bar']), /Компиляция: app\.cpp/);
  // вторая фаза — запуск собранного бинарника
  handlers['run:exit']({ sessionId: 'scpp', code: 0, step: 0, nextStep: { index: 1, kind: 'run' } });
  await tick(10);
  assert.match(text(roots['term-bar']), /Запуск: app\.cpp/);
  // служебная строка фазы — один раз на сессию
  handlers['run:state']({ active: { kind: 'file', label: 'app.cpp', state: 'running', sessionId: 'scpp', step: 1, stepKind: 'run' } });
  await tick(10);
  assert.equal(termState.writes.filter((w) => w.includes('── компиляция ──')).length, 1, 'строка фазы не дублируется');
  handlers['run:exit']({ sessionId: 'scpp', code: 0, step: 1, reason: null });
  handlers['run:state']({ active: null });
  await tick(10);
  canned['run:start'] = { ok: true, sessionId: 's1' };
  ed.activeFileValue = { projectId: 'p1', rel: 'main.py', name: 'main.py' };

  // итог прогона виден в самом терминале, а не только в строке состояния: при ошибке —
  // красным, при пустом выводе — честное объяснение, что текст ошибки до нас не доехал.
  // События идут от текущей сессии ('s1'): чужие run:exit renderer игнорирует.
  await click(runBtn);
  await tick(40);
  termState.writes.length = 0;
  handlers['run:exit']({ sessionId: 's1', code: 1, step: 0, reason: null, emptyOutput: false });
  await tick(10);
  assert.ok(termState.writes.some((w) => w.includes('── завершено с ошибкой, код возврата: 1 ──')),
    'код возврата напечатан в терминале');
  termState.writes.length = 0;
  handlers['run:exit']({ sessionId: 's1', code: 1, step: 0, reason: null, emptyOutput: true });
  await tick(10);
  assert.ok(termState.writes.some((w) => w.includes('[вывода нет')), 'пустой вывод объяснён');
  termState.writes.length = 0;
  handlers['run:exit']({ sessionId: 's1', code: 0, step: 0, reason: null, emptyOutput: false });
  await tick(10);
  assert.ok(termState.writes.some((w) => w.includes('── завершено, код возврата: 0 ──')), 'успех тоже помечен');
  assert.ok(!termState.writes.some((w) => w.includes('[вывода нет')), 'при ненулевом выводе пометки нет');
  // остановка пользователем не дублируется строкой кода возврата
  termState.writes.length = 0;
  handlers['run:exit']({ sessionId: 's1', code: -1, step: 0, reason: 'stopped' });
  await tick(10);
  assert.ok(termState.writes.some((w) => w.includes('[процесс остановлен]')), 'причина остановки названа');
  assert.ok(!termState.writes.some((w) => w.includes('завершено')), 'строка кода не дублирует остановку');

  // команда оболочки печатается в терминал целиком: после очистки экрана иначе непонятно,
  // что именно было выполнено
  termState.writes.length = 0;
  handlers['run:state']({ active: { kind: 'cmd', label: 'findstr /i player *.gd', state: 'running', sessionId: 'scmd', step: 0, stepKind: 'run' } });
  await tick(10);
  assert.ok(termState.writes.some((w) => w.includes('⌘ findstr /i player *.gd')), 'команда напечатана');
  assert.match(text(roots['term-bar']), /Запуск: findstr/);
  handlers['run:state']({ active: null });
  await tick(10);

  // «■ Стоп» без процесса — честная ошибка, «📋 Отчёт» — копия в буфер
  await click(btn(roots['term-bar'], '■ Стоп'));
  await tick(30);
  assert.match(text(roots.toast), /Нет активного процесса/);
  await click(btn(roots['term-bar'], '📋 Отчёт'));
  await tick(30);
  assert.ok(log.some(([ch]) => ch === 'run:copy-report'));
  assert.match(text(roots.toast), /Отчёт скопирован/);

  // «🗑 Очистить» очищает xterm целиком: reset(), а не clear() — clear() оставляет
  // текущую строку, а на ней как раз лежит хвост вывода без перевода строки
  const resetsBefore2 = termState.resets;
  await click(btn(roots['term-bar'], '🗑 Очистить'));
  await tick(20);
  assert.equal(termState.resets, resetsBefore2 + 1);

  // повторный запуск: процесс идёт — «■ Стоп» отправляет run:stop
  canned['run:start'] = { ok: true, sessionId: 's2' };
  await click(runBtn);
  await tick(40);
  await click(btn(roots['term-bar'], '■ Стоп'));
  await tick(30);
  assert.ok(log.some(([ch]) => ch === 'run:stop'), 'остановка отправлена в main');
  // main ответил run:exit(reason:'stopped') — служебная строка в терминале
  handlers['run:exit']({ sessionId: 's2', code: -1, step: 0, reason: 'stopped' });
  handlers['run:state']({ active: null });
  await tick(10);
  assert.ok(termState.writes.some((w) => w.includes('остановлен')), 'остановка показана');

  // неуспешный запуск: ошибка печатается в терминал и в тост
  canned['run:start'] = { ok: false, reason: 'tool-missing', message: 'Не найден python в PATH.' };
  await click(runBtn);
  await tick(40);
  assert.ok(termState.writes.some((w) => w.includes('Не найден python')), 'ошибка инструмента в терминале');
  assert.match(text(roots.toast), /Не найден python/);
  canned['run:start'] = { ok: true, sessionId: 's3' };

  // ✕ = остановить процесс (если идёт) и скрыть панель (§2.1)
  await click(runBtn);
  await tick(40);
  await click(btn(roots['term-bar'], '✕'));
  await tick(40);
  assert.ok(log.some(([ch]) => ch === 'run:stop'), '✕ остановил процесс');
  assert.equal(hidden(roots['term-panel']), true, '✕ скрыл панель');
  save = log.filter(([ch]) => ch === 'layout:save').pop();
  assert.equal(save[1].layout.termOpen, false);

  // ввод с клавиатуры терминала уходит в main fire-and-forget (run:input)
  sent.length = 0;
  termState.dataCb('x\r');
  assert.deepEqual(sent.filter(([ch]) => ch === 'run:input').map(([, v]) => v), ['x\r']);

  // Уведомления о фокусе ('\x1b[I' / '\x1b[O') в pty не уходят: ConPTY запрашивает
  // режим 1004, xterm.js отвечает на каждый клик, а в отчёте это выглядело как «[I[I1256»
  sent.length = 0;
  termState.dataCb('\u001b[I');
  termState.dataCb('\u001b[O');
  assert.deepEqual(sent.filter(([ch]) => ch === 'run:input'), [], 'фокус-события отфильтрованы');
  termState.dataCb('\u001b[I12\u001b[O');
  assert.deepEqual(sent.filter(([ch]) => ch === 'run:input').map(([, v]) => v), ['12'], 'полезный ввод проходит');

  // разделитель высоты терминала: тянем вверх на 60px — панель выше
  const spt = roots['hsplit-term'];
  await click(btn(roots.head, 'Терминал')); // снова открыть
  await tick(30);
  for (const f of spt.listeners.pointerdown) f({ button: 0, clientX: 10, clientY: 500, pointerId: 1, preventDefault() {} });
  for (const f of spt.listeners.pointermove) f({ clientX: 10, clientY: 440 });
  for (const f of spt.listeners.pointerup) f({});
  await tick(40);
  save = log.filter(([ch]) => ch === 'layout:save').pop();
  assert.equal(save[1].layout.termH, 260 + 60, 'высота терминала сохранена');

  // ---------- настройки запуска (этап C3b, §2.4) ----------
  const settingsBtn = findAll(roots.head, (e) => e.tag === 'button').find((b) => text(b) === '⚙ Настройки');
  assert.ok(settingsBtn, 'кнопка «⚙ Настройки» в шапке');
  await click(settingsBtn);
  await tick(80);
  assert.equal(hidden(roots['settings-host']), false, 'панель настроек открыта');
  assert.equal(hidden(roots['prompt-host']), true, 'режимы центральной панели взаимоисключающие');
  assert.equal(hidden(roots['ed-tabs']), true, 'вкладки редактора скрыты под настройками');
  assert.ok(log.some(([ch]) => ch === 'settings:get'), 'config.run прочитан из main');
  assert.equal(detectCalls.length > 0 && detectCalls[0].fresh, true, 'при открытии PATH проверяется заново');

  // таблица: строка на каждый инструмент (у Java их две — javac и java)
  const rowsOf = () => findAll(roots['settings-body'], (e) => e.className === 'set-row');
  assert.equal(rowsOf().length, 7, 'семь инструментов в таблице (этап D: добавлен dotnet)');
  const bodyText = text(roots['settings-body']);
  for (const s of ['Python', 'Node.js', 'g++ / clang++', 'gcc / clang', 'javac', 'java', '.NET SDK (dotnet)',
    'Дополнительные аргументы', 'Таймаут бездействия', 'Оболочка для команд модели']) {
    assert.ok(bodyText.includes(s), 'в панели есть «' + s + '»');
  }
  // статусы: найден в PATH, взят из настроек, битый ручной путь (с запасом в PATH и без), не найден
  assert.ok(bodyText.includes('✔ C:\\Python312\\python.exe · 3.12.4'), 'автопоиск показан с версией');
  assert.ok(bodyText.includes('из настроек'), 'ручной путь помечен как источник');
  assert.ok(bodyText.includes('⚠ указанный путь не найден; в PATH есть'), 'битый путь показан честно, факт о PATH сохранён');
  assert.ok(bodyText.includes('⚠ указан, но не найден'), 'битый путь без запаса в PATH');
  assert.ok(bodyText.includes('✘ не найден в PATH'), 'честное «не найден»');
  const withClass = (cls) => findAll(roots['settings-body'],
    (e) => typeof e.className === 'string' && e.className.split(' ').includes(cls));
  assert.equal(withClass('st-none').length, 1, 'красным — только «не найден»');
  assert.equal(withClass('st-broken').length, 2, 'жёлтым — оба битых ручных пути');
  assert.equal(withClass('st-ok').length, 3, 'зелёным — python, node и dotnet из PATH');
  assert.equal(withClass('st-manual').length, 1, 'отдельный цвет у пути из настроек (javac)');
  assert.equal(withClass('st-unknown').length, 0, 'без результата обнаружения «не проверялось» не показывается');
  // подсказка «что установить» — только там, где не найдено (§9)
  const hints = findAll(roots['settings-body'], (e) => e.className === 'set-hint');
  assert.equal(hints.length, 1);
  assert.match(text(hints[0]), /MinGW-w64|LLVM/);
  // оболочка — справка, а не настройка (решение пользователя: PowerShell не внедряем)
  assert.match(bodyText, /cmd\.exe \/d \/s \/c/);
  assert.equal(findAll(roots['settings-body'], (e) => e.tag === 'select').length, 0, 'выбора оболочки нет');

  // ручной путь из конфига виден в поле, пустой — placeholder «автопоиск в PATH»
  const inputOf = (labelPart) => findAll(roots['settings-body'],
    (e) => e.tag === 'input' && String(e.getAttribute('aria-label') || '').includes(labelPart))[0];
  assert.equal(inputOf('Путь вручную: javac').getAttribute('value'), 'C:\\jdk\\bin\\javac.exe');
  assert.equal(inputOf('Путь вручную: gcc / clang').getAttribute('placeholder'), 'автопоиск в PATH');

  // «Обзор…» → tools:pick → settings:save → повторная проверка PATH (статус обязан обновиться)
  const detectBefore = detectCalls.length;
  const cppRow = rowsOf().find((r) => text(r).includes('g++'));
  await click(btn(cppRow, 'Обзор…'));
  await tick(60);
  assert.deepEqual(pickCalls.pop(), { toolKey: 'cpp' }, 'диалог знает, какой инструмент выбираем');
  assert.equal(runSaveCalls[runSaveCalls.length - 1].tools.cpp, 'C:\\mingw64\\bin\\g++.exe', 'выбранный путь сохранён');
  assert.equal(runSaveCalls[runSaveCalls.length - 1].shellWin, 'cmd', 'оболочка не меняется');
  assert.ok(detectCalls.length > detectBefore, 'после сохранения пути таблица перечитана');

  // «Авто» сбрасывает ручной путь; где пути нет — кнопка неактивна (сбрасывать нечего)
  const javacRow = rowsOf().find((r) => text(r).includes('javac'));
  assert.equal(btn(javacRow, 'Авто').getAttribute('disabled'), null, '«Авто» доступна, когда путь задан');
  await click(btn(javacRow, 'Авто'));
  await tick(60);
  assert.equal(runSaveCalls[runSaveCalls.length - 1].tools.javac, null, 'сброс к автопоиску сохранён');
  const pyRow = rowsOf().find((r) => text(r).includes('Python'));
  assert.equal(btn(pyRow, 'Авто').getAttribute('disabled'), '', 'без ручного пути «Авто» неактивна');

  // дополнительные аргументы: пять полей (Node без аргументов), сохранение по change
  const argInputs = findAll(roots['settings-body'],
    (e) => e.tag === 'input' && String(e.getAttribute('aria-label') || '').startsWith('Дополнительные аргументы'));
  assert.equal(argInputs.length, 5, 'аргументы у Python, C++, C, javac и C#');
  const cppArgs = argInputs.find((i) => String(i.getAttribute('aria-label')).includes('C++'));
  cppArgs.value = '-Wall -O2';
  for (const f of cppArgs.listeners.change) await f({ target: cppArgs });
  await tick(40);
  assert.equal(runSaveCalls[runSaveCalls.length - 1].args.cpp, '-Wall -O2', 'аргументы сохранены');

  // таймаут: мусор не сохраняется и объясняется тостом, число — сохраняется
  const numInput = () => findAll(roots['settings-body'], (e) => e.tag === 'input' && e.getAttribute('type') === 'number')[0];
  const savesBeforeTimeout = runSaveCalls.length;
  let ni = numInput();
  ni.value = 'много';
  for (const f of ni.listeners.change) await f({ target: ni });
  await tick(40);
  assert.match(text(roots.toast), /Таймаут — целое число секунд/);
  assert.equal(runSaveCalls.length, savesBeforeTimeout, 'недопустимый таймаут в конфиг не попал');
  ni = numInput();
  assert.equal(ni.getAttribute('value'), '600', 'прежнее значение возвращено в поле');
  ni.value = '120';
  for (const f of ni.listeners.change) await f({ target: ni });
  await tick(40);
  assert.equal(runSaveCalls[runSaveCalls.length - 1].timeoutSec, 120, 'таймаут сохранён');

  // «↻ Обновить» — повторная проверка PATH без перезаписи конфига
  const detectBefore2 = detectCalls.length;
  const savesBefore2 = runSaveCalls.length;
  await click(btn(roots['settings-body'], '↻ Обновить'));
  await tick(60);
  assert.equal(detectCalls.length, detectBefore2 + 1, 'PATH проверен заново');
  assert.equal(detectCalls[detectCalls.length - 1].fresh, true);
  assert.equal(runSaveCalls.length, savesBefore2, 'обновление ничего не сохраняет');
  assert.match(text(roots.toast), /проверены заново/);

  // ✕ закрывает настройки и возвращает к редактору
  for (const f of roots['settings-close'].listeners.click) await f({});
  await tick(40);
  assert.equal(hidden(roots['settings-host']), true, '✕ закрыл настройки');
  assert.equal(hidden(roots['ed-tabs']), false, 'редактор вернулся');

  // ошибка «инструмент не найден» ведёт в настройки кнопкой в тосте (§2.2 шаг 3, §9)
  canned['run:start'] = { ok: false, reason: 'tool-missing', message: 'Не найден gcc в PATH.', tool: 'c', brokenManual: false };
  await click(runBtn);
  await tick(60);
  assert.match(text(roots.toast), /Не найден gcc/);
  const toastAct = findAll(roots.toast, (e) => e.tag === 'button')[0];
  assert.ok(toastAct, 'в тосте есть кнопка действия');
  assert.equal(text(toastAct), 'Открыть настройки');
  await click(toastAct);
  await tick(60);
  assert.equal(hidden(roots['settings-host']), false, 'кнопка тоста открыла настройки');
  // обычная ошибка запуска кнопки не предлагает
  await click(findAll(roots.head, (e) => e.tag === 'button').find((b) => text(b) === '← Редактор'));
  await tick(40);
  canned['run:start'] = { ok: false, reason: 'no-project', message: 'Сначала выберите проект для этого чата' };
  await click(runBtn);
  await tick(60);
  assert.equal(findAll(roots.toast, (e) => e.tag === 'button').length, 0, 'у ошибки без действия кнопки нет');
  canned['run:start'] = { ok: true, sessionId: 's9' };

  // ---------- карточки запуска и команд (этап C3c, ТЗ §2.5) ----------
  const RUNP = {
    id: 'run1', kind: 'run', status: 'pending', state: 'run', op: 'run', relPath: 'main.py',
    args: ['--fast'], lang: 'python', langLabel: 'Python', inputLines: 2, historical: false,
    warnings: 0, pathFixed: false, exitCode: null, mode: 'full', patchBlocks: 0,
  };
  const RUN_MISSING = { ...RUNP, id: 'run2', relPath: 'new.py', state: 'missing-file', args: null, inputLines: 0 };
  const CMD_SAFE = {
    id: 'cmd1', kind: 'cmd', status: 'pending', state: 'cmd', op: 'cmd', relPath: null,
    command: 'grep -rn "Player" src', risk: { level: 'safe', reasons: [] }, inputLines: 0,
    historical: false, warnings: 0, exitCode: null, mode: 'full', patchBlocks: 0,
  };
  const CMD_DANGER = {
    ...CMD_SAFE, id: 'cmd2', command: 'rmdir /s /q build', inputLines: 1,
    risk: { level: 'danger', reasons: ['удаление или системная команда: rmdir'] },
  };
  const CMD_DONE = { ...CMD_SAFE, id: 'cmd3', command: 'dir', status: 'executed', state: 'executed', exitCode: 0 };
  const VIEWS = {
    run1: { ...RUNP, input: '5\nhello', rows: [], rawText: '5\nhello\n', baseText: null, aiBaseText: null },
    run2: { ...RUN_MISSING, input: '', rows: [] },
    cmd1: { ...CMD_SAFE, input: '', rows: [] },
    cmd2: { ...CMD_DANGER, input: 'y', rows: [] },
    cmd3: { ...CMD_DONE, input: '', rows: [] },
  };
  canned['proposals:list'] = [RUNP, RUN_MISSING, CMD_SAFE, CMD_DANGER, CMD_DONE];
  canned['proposal:get'] = (arg) => VIEWS[arg && arg.id] || null;
  canned['proposal:executed'] = (arg) => { executedCalls.push(arg); return { ok: true, status: 'executed' }; };
  handlers['proposals:changed']();
  await tick(60);
  await click(leftTab('Предложения'));
  await tick(40);

  const cards = () => findAll(roots.body, (e) => typeof e.className === 'string' && e.className.startsWith('card run-card'));
  assert.equal(cards().length, 5, 'карточка на каждое предложение запуска и команды');
  // ищем карточку точным совпадением команды/пути: 'dir' иначе находится внутри
  // 'rmdir /s /q build', и проверка попала бы не в ту карточку
  const cardOf = (id) => {
    const v = VIEWS[id];
    return cards().find((c) => {
      const line = findAll(c, (e) => e.className === 'cmd-line')[0];
      if (line) return text(line) === v.command;
      const pth = findAll(c, (e) => e.className === 'path')[0];
      return !!pth && text(pth).split('  ')[0] === v.relPath;
    });
  };
  const runCard = cardOf('run1');
  const missCard = cardOf('run2');
  const safeCard = cardOf('cmd1');
  const dangerCard = cardOf('cmd2');
  const doneCard = cardOf('cmd3');

  // заголовки и содержимое
  assert.match(text(runCard), /▶ Запуск main\.py/);
  assert.match(text(runCard), /main\.py  --fast/, 'аргументы видны в карточке');
  assert.match(text(safeCard), /⌘ Команда/);
  const cmdLine = findAll(safeCard, (e) => e.className === 'cmd-line')[0];
  assert.equal(cmdLine.tag, 'code', 'команда показана моноширинно');
  assert.equal(text(cmdLine), 'grep -rn "Player" src');

  // бейджи риска: зелёный «чтение», красный «опасная команда» + баннер с причинами
  const badge = (card, cls) => findAll(card, (e) => typeof e.className === 'string' && e.className.split(' ').includes(cls))[0];
  assert.equal(text(badge(safeCard, 'risk-safe')), 'чтение');
  assert.equal(text(badge(dangerCard, 'risk-danger')), 'опасная команда');
  const note = findAll(dangerCard, (e) => e.className === 'danger-note')[0];
  assert.ok(note, 'у опасной команды есть баннер');
  assert.match(text(note), /Не выполняйте, если не понимаете/);
  assert.match(text(note), /удаление или системная команда: rmdir/, 'причины перечислены');
  assert.equal(findAll(safeCard, (e) => e.className === 'danger-note').length, 0, 'у безопасной команды баннера нет');

  // состояния и кнопки
  assert.match(text(runCard), /Готов к запуску/);
  assert.match(text(missCard), /Файл ещё не создан/);
  assert.ok(badge(missCard, 'bad'), 'блокирующее состояние помечено');
  assert.match(text(doneCard), /Выполнено \(код 0\)/);
  assert.ok(btn(doneCard, '↻ Повторить'), 'выполненную команду можно повторить');
  assert.equal(btn(doneCard, 'Отклонить'), undefined, 'у выполненной карточки нет «Отклонить»');
  assert.ok(btn(runCard, '▶ Запустить') && btn(safeCard, '▶ Выполнить'), 'кнопки запуска на месте');

  // предпросмотр ввода догружается через proposal:get
  const inputBtn = findAll(runCard, (e) => e.tag === 'button' && text(e).startsWith('ввод:'))[0];
  assert.equal(text(inputBtn), 'ввод: 2 стр.');
  await click(inputBtn);
  await tick(40);
  const pre = findAll(roots.body, (e) => e.className === 'code run-input')[0];
  assert.ok(pre, 'ввод раскрыт');
  assert.equal(text(pre), '5\nhello');
  const hideBtn = findAll(cards()[0], (e) => e.tag === 'button' && text(e) === 'скрыть ввод')[0];
  assert.ok(hideBtn, 'предпросмотр можно свернуть');
  await click(hideBtn);
  await tick(30);

  // запуск несозданного файла заблокирован подсказкой, сессия не стартует
  const startsBefore = log.filter(([ch]) => ch === 'run:start').length;
  await click(btn(cardOf('run2'), '▶ Запустить'));
  await tick(40);
  assert.match(text(roots.toast), /Сначала примите предложение, создающее файл/);
  assert.equal(log.filter(([ch]) => ch === 'run:start').length, startsBefore, 'run:start не отправлен');

  // опасная команда: отказ в подтверждении — запуск не стартует
  const confirmWas = global.confirm;
  global.confirm = () => false;
  await click(btn(cardOf('cmd2'), '▶ Выполнить'));
  await tick(40);
  assert.equal(log.filter(([ch]) => ch === 'run:start').length, startsBefore, 'без подтверждения команда не выполняется');
  // согласие — выполняется, ввод из тела блока уходит в run:start
  let confirmText = '';
  global.confirm = (msg) => { confirmText = msg; return true; };
  canned['run:start'] = { ok: true, sessionId: 'sr1', stepKind: 'run' };
  await click(btn(cardOf('cmd2'), '▶ Выполнить'));
  await tick(60);
  global.confirm = confirmWas;
  assert.match(confirmText, /Я понимаю риск и хочу выполнить команду/, 'текст подтверждения понятный');
  const startCmd = log.filter(([ch]) => ch === 'run:start').pop();
  assert.deepEqual(startCmd[1].target, { kind: 'cmd', command: 'rmdir /s /q build' });
  assert.equal(startCmd[1].input, 'y', 'ввод из тела блока подставлен');
  assert.deepEqual(executedCalls[executedCalls.length - 1], { id: 'cmd2' }, 'предложение помечено выполненным со стартом');

  // код возврата дописывается по run:exit
  handlers['run:exit']({ sessionId: 'sr1', code: 3, step: 0, reason: null });
  handlers['run:state']({ active: null });
  await tick(60);
  const last = executedCalls[executedCalls.length - 1];
  assert.equal(last.id, 'cmd2');
  assert.equal(last.exitCode, 3, 'код возврата ушёл в решение «выполнено»');

  // безопасная команда выполняется без подтверждения
  global.confirm = () => { throw new Error('для безопасной команды подтверждение не спрашивается'); };
  await click(btn(cardOf('cmd1'), '▶ Выполнить'));
  await tick(60);
  global.confirm = confirmWas;
  const startSafe = log.filter(([ch]) => ch === 'run:start').pop();
  assert.deepEqual(startSafe[1].target, { kind: 'cmd', command: 'grep -rn "Player" src' });
  assert.equal(startSafe[1].input, undefined, 'пустое тело блока — ввода нет');

  // «Отклонить» на карточке команды
  await click(btn(cardOf('cmd1'), 'Отклонить'));
  await tick(40);
  assert.ok(log.some(([ch, arg]) => ch === 'proposal:reject' && arg.id === 'cmd1'), 'отклонение отправлено в main');

  console.error = origErr;
  assert.deepEqual(errors, []);
});

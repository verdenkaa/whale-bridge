'use strict';
// Обвязка между процессами проверяется как код, а не глазами.
//
// Класс ошибки, который этот тест ловит: main.js вызывает метод, которого нет в модуле
// (или канал, которого нет в белом списке преалода). Ни один юнит-тест такое не увидит —
// падает только в рантайме, при конкретном действии пользователя.
//
// main.js требует 'electron', поэтому он здесь не подключается: разбирается как текст.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Store } = require('../src/store');
const { ProposalManager } = require('../src/proposals');
const editorfs = require('../src/editorfs');
const fileops = require('../src/fileops');
const Context = require('../src/context');
const pg = require('../src/promptgen');
const layoutMath = require('../ui/layout');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const mainSrc = read('main.js');
const preloadUi = read('preload-ui.js');
const preloadChat = read('preload-chat.js');
const uiSources = fs.readdirSync(path.join(ROOT, 'ui'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => read(path.join('ui', f)));

// Все вызовы вида `obj.method(` с именем объекта из списка
function calls(src, obj) {
  const re = new RegExp(`\\b${obj}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
  const out = new Set();
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return [...out];
}

// Все строковые литералы вида `call('channel'` / `handle('channel'` / `'channel',` в наборе
function channels(src, fnName) {
  const re = new RegExp(`\\b${fnName}\\(\\s*'([^']+)'`, 'g');
  const out = new Set();
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return [...out];
}

// Содержимое `new Set([...])` из преалода — белый список каналов или событий
function whitelist(src, constName) {
  const start = src.indexOf(`const ${constName} = new Set([`);
  assert.ok(start >= 0, `в преалоде не найден ${constName}`);
  const end = src.indexOf(']);', start);
  const body = src.slice(start, end);
  return new Set([...body.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

test('обвязка: каждый канал renderer разрешён преолодом и обработан в main', () => {
  const invoke = whitelist(preloadUi, 'INVOKE');
  const sendWl = whitelist(preloadUi, 'SEND');
  const handled = new Set(channels(mainSrc, 'handle'));
  // fire-and-forget приём (геометрия чата, блоки из страницы DeepSeek)
  const received = new Set(channels(mainSrc.replace(/ipcMain\.on/g, 'ipcOn'), 'ipcOn'));

  const usedByUi = new Set();
  for (const src of uiSources) for (const c of channels(src, 'call')) usedByUi.add(c);
  const sentByUi = new Set();
  for (const src of uiSources) for (const c of channels(src, 'send')) sentByUi.add(c);

  assert.ok(usedByUi.size > 20, `renderer вызывает подозрительно мало каналов: ${usedByUi.size}`);

  const notWhitelisted = [...usedByUi].filter((c) => !invoke.has(c)).sort();
  assert.deepEqual(notWhitelisted, [],
    'renderer зовёт каналы, которых нет в белом списке преалода — вызов будет отклонён');

  const notHandled = [...invoke].filter((c) => !handled.has(c)).sort();
  assert.deepEqual(notHandled, [],
    'канал разрешён преолодом, но в main нет обработчика — invoke упадёт с «No handler registered»');

  const unused = [...handled].filter((c) => !invoke.has(c)).sort();
  assert.deepEqual(unused, [],
    'в main есть обработчик, не разрешённый преалом: до него не добраться, скорее всего опечатка');

  // send-каналы (этап B): свой белый список, свой приём в main. Молчаливая потеря
  // geometry-сообщения не роняет ничего — чат просто останется в старых границах,
  // поэтому сверка здесь важнее, чем для invoke.
  const sentForbidden = [...sentByUi].filter((c) => !sendWl.has(c)).sort();
  assert.deepEqual(sentForbidden, [],
    'renderer отправляет send-каналы вне белого списка SEND — preload бросит исключение');
  const sentNotReceived = [...sendWl].filter((c) => !received.has(c)).sort();
  assert.deepEqual(sentNotReceived, [],
    'send-канал разрешён преолодом, но main его не слушает — сообщения уходят в никуда');
});

test('обвязка: события, которые слушает renderer, действительно рассылаются', () => {
  const events = whitelist(preloadUi, 'EVENTS');
  const listened = new Set();
  for (const src of uiSources) for (const e of channels(src, 'on')) listened.add(e);

  const notWhitelisted = [...listened].filter((e) => !events.has(e)).sort();
  assert.deepEqual(notWhitelisted, [], 'renderer слушает события вне белого списка');

  const sent = new Set(channels(mainSrc, 'send'));
  const neverSent = [...events].filter((e) => !sent.has(e)).sort();
  assert.deepEqual(neverSent, [], 'main никогда не отправляет эти события — подписка мертва');
});

// Классы: метод может жить и в прототипе, и в экземпляре (this.onChange = ...).
// Проверять только прототип нельзя — получим ложные срабатывания.
function classMembers(proto, srcFile) {
  const names = new Set(Object.getOwnPropertyNames(proto));
  const src = read(srcFile);
  for (const m of src.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  for (const m of src.matchAll(/^\s{2}(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(m[1]);
  return names;
}

test('обвязка: main не вызывает несуществующих методов и свойств модулей', () => {
  const targets = [
    { obj: 'proposals', api: classMembers(ProposalManager.prototype, 'src/proposals.js'), what: 'ProposalManager' },
    { obj: 'store', api: classMembers(Store.prototype, 'src/store.js'), what: 'Store' },
    { obj: 'editorfs', api: new Set(Object.keys(editorfs)), what: 'src/editorfs' },
    { obj: 'fileops', api: new Set(Object.keys(fileops)), what: 'src/fileops' },
    { obj: 'pg', api: new Set(Object.keys(pg)), what: 'src/promptgen' },
    // ui/layout.js общий для двух процессов (UMD): main вызывает sanitize/normalizeRect
    { obj: 'layoutMath', api: new Set(Object.keys(layoutMath)), what: 'ui/layout' },
  ];

  for (const { obj, api, what } of targets) {
    const used = calls(mainSrc, obj);
    assert.ok(used.length > 0, `в main.js не найдено ни одного вызова ${obj}.<...> — проверка ничего не стоит`);
    const missing = used.filter((m) => !api.has(m)).sort();
    assert.deepEqual(missing, [], `main.js вызывает ${obj}.<...>, которого нет в ${what}`);
  }
});

test('обвязка: деструктурированные импорты main.js существуют в модулях', () => {
  // `const { resolveInProject } = require('./src/paths')` зовётся без префикса,
  // поэтому в предыдущую проверку не попадает. Несуществующее имя дало бы
  // undefined и TypeError в момент вызова, а не при запуске.
  const MODS = {
    './src/store': require('../src/store'),
    './src/proposals': require('../src/proposals'),
    './src/fileops': fileops,
    './src/editorfs': editorfs,
    './src/paths': require('../src/paths'),
    './src/parser': require('../src/parser'),
    './src/promptgen': pg,
    './src/context': Context,
    './src/diff': require('../src/diff'),
    './src/patch': require('../src/patch'),
    './src/versions': require('../src/versions'),
  };
  const checked = [];
  for (const m of mainSrc.matchAll(/const\s*\{([^}]+)\}\s*=\s*require\('(\.\/src\/[\w./-]+)'\)/g)) {
    const mod = MODS[m[2]];
    assert.ok(mod, `тест не знает модуль ${m[2]} — добавьте его в MODS`);
    for (const raw of m[1].split(',')) {
      const name = raw.split(':').pop().trim(); // поддержка `a: b`
      if (!name) continue;
      checked.push(name);
      assert.ok(name in mod, `main.js импортирует ${name} из ${m[2]}, которого там нет`);
    }
  }
  assert.ok(checked.length >= 3, `разобрано подозрительно мало импортов: ${checked.length}`);
});

test('обвязка: каналы чат-преалода принимаются в main', () => {
  // preload-chat работает на send (без ответа), а не на invoke: у чата свой контракт.
  // Канал обязан быть принят через ipcMain.on, иначе блоки ответов молча теряются.
  const sent = channels(preloadChat, 'send');
  assert.ok(sent.length > 0, 'в preload-chat не найдено ни одного send — проверка ничего не стоит');
  const received = new Set(channels(mainSrc.replace(/ipcMain\.on/g, 'ipcOn'), 'ipcOn'));
  const missing = sent.filter((c) => !received.has(c)).sort();
  assert.deepEqual(missing, [], 'чат отправляет каналы, которые main не слушает');
});

test('wiring: сохранение принятых ханков связано на всех трёх сторонах', () => {
  // renderer шлёт aiAccepts → main чистит их и зовёт markAppliedExternally + recordContext
  // → editorfs пишет историю с source:'ai'. Оборванное звено здесь означает, что принятые
  // правки модели уйдут на диск как «ручные», а журнал контекста соврёт.
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
  const editorSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'editor.js'), 'utf8');
  const stateSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'editor-state.js'), 'utf8');
  const editorfsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'editorfs.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');

  assert.match(appSrc, /acceptIntoBuffer/, 'app.js принимает ханки в буфер редактора');
  assert.match(editorSrc, /aiAccepts: pendingAi\.length \? pendingAi : undefined/,
    'editor.js передаёт принятые ханки вместе с file:write');
  assert.match(stateSrc, /function setPendingAi/, 'editor-state хранит принятые, но не сохранённые правки');
  assert.match(mainSrc, /function cleanAiAccepts/, 'main чистит aiAccepts из renderer');
  assert.match(mainSrc, /markAppliedExternally/, 'main закрывает предложения после сохранения из редактора');
  assert.match(mainSrc, /normEol\(accepts\[0\]\.proposedText\) === normEol\(content\)/,
    'честное правило контекста: точное совпадение с текстом модели (с учётом EOL)');
  assert.match(editorfsSrc, /source === 'ai' \? 'ai' : 'manual'/, 'история редактора различает ai/manual');
  // src/hunks.js и src/diff.js — UMD, общие для main и renderer: index.html грузит их до app.js
  const at = (needle) => {
    const i = htmlSrc.indexOf(needle);
    assert.ok(i >= 0, `в index.html нет ${needle}`);
    return i;
  };
  assert.ok(at('src/diff.js') < at('src/hunks.js'), 'diff.js подключается раньше hunks.js');
  assert.ok(at('src/hunks.js') < at('"app.js"'), 'hunks.js подключается раньше app.js');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'proposals.js'), 'utf8'),
    /const \{ merge3 \} = require\('\.\/hunks'\)/,
    'proposals.js использует то же слияние, что и renderer — правило одно');
});

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
    // этап C3 «Запуск»: чистое ядро языков, поиск инструментов и оркестратор сессий
    './src/runlangs': require('../src/runlangs'),
    './src/toolchain': require('../src/toolchain'),
    './src/runner': require('../src/runner'),
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

test('wiring: запуск (C3) связан на всех сторонах — main, preload, ui, упаковка', () => {
  const runnerMod = require('../src/runner');
  const toolchainMod = require('../src/toolchain');
  const termSrc = read('ui/terminal.js');
  const htmlSrc = read('ui/index.html');
  const pkg = JSON.parse(read('package.json'));

  // main: обработчики, fire-and-forget приём, события и жизненный цикл сессии
  for (const c of ['run:start', 'run:stop', 'run:copy-report']) {
    assert.match(mainSrc, new RegExp(`handle\\('${c}'`), `в main.js нет handle('${c}')`);
  }
  assert.match(mainSrc, /ipcMain\.on\('run:input'/, 'main не слушает run:input');
  assert.match(mainSrc, /ipcMain\.on\('run:resize'/, 'main не слушает run:resize');
  for (const c of ['run:data', 'run:exit', 'run:state']) {
    assert.match(mainSrc, new RegExp(`send\\('${c}'`), `main никогда не отправляет ${c}`);
  }
  assert.match(mainSrc, /runner\.start\(/, 'main не запускает сессии через runner.start');
  assert.match(mainSrc, /runner\.stop\(/, 'main не останавливает сессии через runner.stop');
  assert.match(mainSrc, /runner\.stopAll\(/, 'перед выходом приложение обязано убивать процессы');
  assert.match(mainSrc, /before-quit/, 'kill дерева на выходе вешается на before-quit');
  assert.match(mainSrc, /runner\.input\(/, 'ввод терминала обязан доходить до раннера');
  assert.match(mainSrc, /runner\.resize\(/, 'размер терминала обязан доходить до раннера');
  assert.match(mainSrc, /toolchain\.clearCache\(/, 'кеш инструментов сбрасывается перед запуском');
  assert.match(mainSrc, /taskkill/, 'kill дерева на Windows — taskkill /T /F (handover §4.3)');
  assert.match(mainSrc, /pauseWatcher/, 'на время сессии наблюдение за файлами приостановлено');
  assert.match(mainSrc, /node-pty/, 'main использует node-pty для псевдотерминала');
  assert.match(mainSrc, /asarUnpack|spawnPtyAdapter/, 'адаптер pty на месте');

  // фабрики модулей действительно возвращают то, что зовёт main
  const r = runnerMod.createRunner({ spawnPty: () => { throw new Error('не используется'); }, send() {} });
  for (const m of ['start', 'stop', 'stopAll', 'input', 'resize', 'report']) {
    assert.equal(typeof r[m], 'function', `runner не предоставляет ${m}`);
  }
  const tc = toolchainMod.createToolchain({ isFile: () => false });
  for (const m of ['findOnPath', 'toolVersion', 'detect', 'clearCache']) {
    assert.equal(typeof tc[m], 'function', `toolchain не предоставляет ${m}`);
  }

  // артефакты сборки не попадают в дерево файлов
  assert.ok(fileops.IGNORE_DIRS.has('.ide_build'), '.ide_build обязан быть в IGNORE_DIRS');

  // ui: терминал отправляет ввод/размер fire-and-forget и слушает события потока
  assert.match(termSrc, /post\('run:input'/, 'терминал не отправляет ввод в main');
  assert.match(termSrc, /post\('run:resize'/, 'терминал не отправляет размер в main');
  for (const c of ['run:data', 'run:exit', 'run:state']) {
    assert.match(read('ui/app.js'), new RegExp(`api\\.on\\('${c}'`), `app.js не слушает ${c}`);
  }
  assert.match(read('ui/app.js'), /saveAllDirty/, 'перед запуском сохраняются все dirty-буферы');
  assert.match(read('ui/editor.js'), /saveAllDirty/, 'editor.js предоставляет saveAllDirty');
  assert.match(read('ui/editor.js'), /setTabsExtras/, 'кнопка запуска живёт в строке вкладок');
  assert.match(read('ui/app.js'), /F5/, 'горячая клавиша запуска — F5');
  assert.match(read('ui/app.js'), /Backquote/, 'горячая клавиша терминала — Ctrl+`');

  // разметка: панель терминала внутри колонки редактора, порядок скриптов
  for (const id of ['term-panel', 'term-bar', 'term-host', 'hsplit-term', 'ed-content']) {
    assert.ok(htmlSrc.includes(`id="${id}"`), `в index.html нет #${id}`);
  }
  const at = (needle) => {
    const i = htmlSrc.indexOf(needle);
    assert.ok(i >= 0, `в index.html нет ${needle}`);
    return i;
  };
  assert.ok(at('@xterm/xterm/lib/xterm.js') < at('"terminal.js"'), 'xterm грузится до terminal.js');
  assert.ok(at('"terminal.js"') < at('"app.js"'), 'terminal.js грузится до app.js');
  assert.ok(at('src/runlangs.js') < at('"app.js"'), 'runlangs грузится до app.js');

  // упаковка: нативный node-pty обязан лежать на диске, не внутри asar (ТЗ §8)
  assert.ok(pkg.build.asarUnpack.includes('node_modules/node-pty/**'),
    'node-pty не распаковывается из asar — ConPTY не запустится');
  assert.ok(pkg.dependencies['node-pty'], 'node-pty не объявлен в dependencies');
  assert.ok(pkg.dependencies['@xterm/xterm'], '@xterm/xterm не объявлен в dependencies');
  assert.ok(pkg.dependencies['@xterm/addon-fit'], '@xterm/addon-fit не объявлен в dependencies');
});

test('wiring: настройки запуска (C3b) связаны на всех сторонах — main, preload, ui, модуль', () => {
  const htmlSrc = read('ui/index.html');
  const appSrc = read('ui/app.js');
  const rs = require('../src/runsettings');

  // main: четыре обработчика и то, что они реально делают
  for (const c of ['tools:detect', 'tools:pick', 'settings:get', 'settings:save']) {
    assert.match(mainSrc, new RegExp(`handle\\('${c}'`), `в main.js нет handle('${c}')`);
  }
  assert.match(mainSrc, /toolchain\.detect\(store\.config\.run\)/, 'tools:detect отдаёт результат обнаружения для текущего конфига');
  assert.match(mainSrc, /toolchain\.clearCache\(\)/, 'кеш инструментов сбрасывается (Обновить / сохранение пути)');
  assert.match(mainSrc, /dialog\.showOpenDialog/, '«Обзор…» открывает системный диалог выбора файла');
  assert.match(mainSrc, /handle\('settings:save'[\s\S]{0,300}sanitizeRunConfig/, 'присланный конфиг чистится перед записью');
  assert.match(mainSrc, /handle\('settings:save'[\s\S]{0,400}store\.saveConfig\(\)/, 'настройки сохраняются в config.json');
  assert.match(mainSrc, /runsettings\.toolByKey/, 'main берёт подписи инструментов из общей модели, а не дублирует их');

  // общая модель: renderer и main используют один модуль
  for (const m of ['toolRows', 'argRows', 'statusOf', 'nextConfig', 'parseTimeoutInput', 'missingToolMessage', 'toolByKey']) {
    assert.equal(typeof rs[m], 'function', `src/runsettings.js не предоставляет ${m}`);
  }
  assert.match(appSrc, /RS\.toolRows\(/, 'таблица настроек строится общей моделью');
  assert.match(appSrc, /RS\.nextConfig\(/, 'правка поля проходит через общее правило');
  assert.match(appSrc, /RS\.parseTimeoutInput\(/, 'таймаут проверяется общей функцией');
  assert.match(read('src/runner.js'), /runsettings\.missingToolMessage\(/, 'сообщение «не найден» — из общей модели');

  // renderer: каналы вызываются, панель рисуется, режим панели переключается
  for (const c of ['tools:detect', 'tools:pick', 'settings:get', 'settings:save']) {
    assert.ok(appSrc.includes(`call('${c}'`), `app.js не вызывает ${c}`);
  }
  assert.match(appSrc, /show\('#settings-host', mode === 'settings'\)/, 'режим «настройки» переключается в renderEditorArea');
  assert.match(appSrc, /renderSettingsPanel/, 'панель настроек перерисовывается');
  assert.match(appSrc, /reason === 'tool-missing'/, 'ошибка «инструмент не найден» ведёт в настройки');
  assert.match(appSrc, /Открыть настройки/, 'в тосте есть действие «Открыть настройки»');

  // разметка: панель настроек и порядок скриптов (runsettings требует runlangs)
  for (const id of ['settings-host', 'settings-body', 'settings-close']) {
    assert.ok(htmlSrc.includes(`id="${id}"`), `в index.html нет #${id}`);
  }
  const at = (needle) => {
    const i = htmlSrc.indexOf(needle);
    assert.ok(i >= 0, `в index.html нет ${needle}`);
    return i;
  };
  // ищем именно теги скриптов: в комментариях разметки имена модулей тоже упоминаются
  assert.ok(at('<script src="../src/runlangs.js">') < at('<script src="../src/runsettings.js">'),
    'runlangs грузится до runsettings');
  assert.ok(at('<script src="../src/runsettings.js">') < at('"app.js"'), 'runsettings грузится до app.js');

  // оболочка не настраивается: ни поля выбора, ни записи shellWin из renderer (ТЗ §5.3, Q4)
  assert.ok(!/shellWin\s*:/.test(appSrc), 'renderer не подбирает оболочку — она фиксирована');
  assert.equal(rs.nextConfig({ shellWin: 'powershell' }, {}).shellWin, 'cmd');
});

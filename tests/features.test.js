'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { parseBlock } = require('../src/parser');
const { parsePatch, applyEdits } = require('../src/patch');
const { Store } = require('../src/store');
const { ProposalManager } = require('../src/proposals');
const fileops = require('../src/fileops');
const pg = require('../src/promptgen');

const patchText = (...blocks) => blocks.map(([s, r]) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`).join('\n');
const E = (s, r) => ({ search: s.split('\n'), replace: r === '' ? [] : r.split('\n') });

// ---------- SEARCH/REPLACE ----------
test('patch: разбор нескольких блоков и режим patch в parseBlock', () => {
  const body = patchText(['a = 1', 'a = 2'], ['b = 1', 'b = 2']);
  const r = parseBlock('# &x.py\n' + body);
  assert.equal(r.mode, 'patch');
  assert.equal(r.edits.length, 2);
  assert.deepEqual(r.edits[0], { search: ['a = 1'], replace: ['a = 2'] });
  assert.deepEqual(r.issues, []);
  assert.equal(r.open, false);
  assert.equal(parseBlock('# &x.py\nprint(1)\n').mode, 'full');
});

test('patch: незакрытый блок = «ещё пишется»; лишний текст — ошибка', () => {
  assert.equal(parsePatch('<<<<<<< SEARCH\na\n=======\nb').open, true);
  assert.equal(parsePatch('текст\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE').issues.length, 1);
  assert.equal(parsePatch('<<<<<<< SEARCH\na\n>>>>>>> REPLACE').issues.length, 1);
});

test('patch: точное применение, вставка, удаление, последовательность', () => {
  const old = 'one\ntwo\nthree\nfour\n';
  assert.equal(applyEdits(old, [E('two', 'TWO')]).text, 'one\nTWO\nthree\nfour\n');
  assert.equal(applyEdits(old, [E('two\nthree', 'two\nnew\nthree')]).text, 'one\ntwo\nnew\nthree\nfour\n');
  assert.equal(applyEdits(old, [E('three', '')]).text, 'one\ntwo\nfour\n');
  // вторая правка видит результат первой
  assert.equal(applyEdits(old, [E('one', 'ONE'), E('ONE\ntwo', 'X')]).text, 'X\nthree\nfour\n');
  // CRLF во входе не мешает
  assert.equal(applyEdits('a\r\nb\r\n', [E('b', 'B')]).text, 'a\nB\n');
});

test('patch: неоднозначный и ненайденный фрагмент не применяются; остальные блоки пропускаются', () => {
  const old = 'x = 1\ny = 2\nx = 1\n';
  const amb = applyEdits(old, [E('x = 1', 'x = 9')]);
  assert.equal(amb.ok, false);
  assert.equal(amb.results[0].status, 'ambiguous');
  const nf = applyEdits(old, [E('y = 2', 'y = 3'), E('z = 5', 'z = 6'), E('x = 1\ny = 2', 'q')]);
  assert.equal(nf.ok, false);
  assert.deepEqual(nf.results.map((r) => r.status), ['ok', 'notfound', 'skipped']);
  assert.match(nf.error, /Блок 2/);
});

test('patch: допуск на пробелы в конце и на отступы (с переносом отступа в REPLACE)', () => {
  const old = 'func a():\n\tif x:\n\t\tprint(1)  \n\treturn 0\n';
  const r1 = applyEdits(old, [E('\t\tprint(1)', '\t\tprint(2)')]);
  assert.equal(r1.ok, true);
  assert.equal(r1.results[0].method, 'trimEnd');
  // модель потеряла отступ целиком: добавляем недостающий и в REPLACE
  const r2 = applyEdits(old, [E('if x:\n\tprint(1)', 'if x:\n\tprint(2)\n\tprint(3)')]);
  assert.equal(r2.ok, true);
  assert.equal(r2.results[0].method, 'trim');
  assert.equal(r2.text, 'func a():\n\tif x:\n\t\tprint(2)\n\t\tprint(3)\n\treturn 0\n');
});

test('patch: пустой SEARCH допустим только для пустого файла', () => {
  assert.equal(applyEdits('', [{ search: [], replace: ['a', 'b'] }]).text, 'a\nb');
  assert.equal(applyEdits('x\n', [{ search: [], replace: ['a'] }]).ok, false);
});

test('patch: частичный SEARCH показывает реальный diff, если строка просто отсутствует', () => {
  const old = 'one\ntwo\nprint("и ещё одна строка")\nprint("четвёртая строка")\n';
  const r = applyEdits(old, [{ search: ['one', 'two', 'print("и ещё одна строка")', 'print("пятая строка")'], replace: [] }]);
  assert.equal(r.ok, false);
  assert.equal(r.results[0].partial.matched, 3);
  assert.deepEqual(r.results[0].partial.diff.filter((x) => x.type !== 'eq').map((x) => [x.type, x.text]), [['del', 'print("пятая строка")'], ['add', 'print("четвёртая строка")']]);
});

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-p-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-d-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }), fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })]));
  const store = new Store(data);
  await store.load();
  const project = await store.addProject(root);
  const chat = '17b45023-2aba-4a1a-a966-17bbe41926ea';
  await store.bind(chat, project.id);
  return { root, data, store, project, chat, pm: new ProposalManager({ store }) };
}

/** Перечитать хранилище с диска — имитация перезапуска приложения. */
async function reloadStore(data) {
  const s = new Store(data);
  await s.load();
  return s;
}

test('proposal: решения «принято/отклонено» переживают новый ProposalManager', async (t) => {
  const { root, store, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  const pm1 = new ProposalManager({ store });
  pm1.ingest(chat, [{ key: 'reject', text: '# &a.py\nx = 2\n' }]);
  const rejected = (await pm1.list(chat, true))[0];
  pm1.reject(rejected.id);
  pm1.ingest(chat, [{ key: 'apply', text: '# &a.py\nx = 3\n' }]);
  const applied = (await pm1.list(chat, true)).find((x) => x.status === 'pending');
  const v = await pm1.view(applied.id);
  assert.equal((await pm1.apply(applied.id, { baseHash: v.baseHash, contentHash: v.contentHash })).ok, true);

  // Перезапуск: те же блоки приходят заново. Обработанные не должны снова становиться pending —
  // иначе Diff предложил бы применить (или отклонить) то, что пользователь уже закрыл.
  //Applied-блок не возвращается вовсе (правило ниже): файл уже содержит ровно это содержимое,
  // а запись о применении живёт в Истории.
  const pm2 = new ProposalManager({ store });
  pm2.ingest(chat, [
    { key: 'new-reject-node', text: '# &a.py\nx = 2\n' },
    { key: 'new-applied-node', text: '# &a.py\nx = 3\n' },
    { key: 'new-pending-node', text: '# &a.py\nx = 4\n' },
  ]);
  const list = await pm2.list(chat, true);
  const byStatus = (s) => list.filter((x) => x.status === s);
  assert.equal(list.length, 2, 'применённый блок заново не предлагается');
  assert.equal(byStatus('rejected').length, 1); // отклонённое вернулось уже отклонённым
  assert.equal(byStatus('applied').length, 0, 'применённого в списке нет');
  const fresh = byStatus('pending');
  assert.equal(fresh.length, 1); // новым осталось только действительно новое предложение
  const fv = await pm2.view(fresh[0].id);
  assert.match(fv.newText, /x = 4/);
});

test('proposal: блок, identical уже применённому, в список не добавляется', async (t) => {
  // Требование пользователя (приёмка 0019): DeepSeek в режиме рассуждений печатает тот же
  // код до итогового ответа, а при прокрутке старого чата догружаются давно отработанные
  // блоки. Совпадение 1 в 1 (тот же op, путь и содержимое — от них считается contentHash)
  // с уже применённым предложением карточку не создаёт.
  const { root, store, chat, data } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  const pm1 = new ProposalManager({ store });
  pm1.ingest(chat, [{ key: 'k1', text: '# &a.py\nx = 2\n' }]);
  const [item] = await pm1.list(chat, true);
  const v = await pm1.view(item.id);
  assert.equal((await pm1.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash })).ok, true);
  // в текущем сеансе карточка применённого предложения остаётся — это запись о действии
  assert.equal((await pm1.list(chat, true)).filter((x) => x.status === 'applied').length, 1);

  await store.saveConfig();
  const pm2 = new ProposalManager({ store: await reloadStore(data) });
  // тот же блок под другим ключом (другой DOM-узел после перезагрузки страницы)
  pm2.ingest(chat, [{ key: 'another-node', text: '# &a.py\nx = 2\n' }]);
  assert.equal((await pm2.list(chat, true)).length, 0, 'identical применённому — не предлагается');

  // отличающееся содержимое — новое предложение: правило не глушит настоящие правки
  pm2.ingest(chat, [{ key: 'changed', text: '# &a.py\nx = 5\n' }]);
  const fresh = await pm2.list(chat, true);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].status, 'pending');

  // создание файла работает так же
  const pm3 = new ProposalManager({ store });
  pm3.ingest(chat, [{ key: 'n1', text: '# &NEW:b.py\nprint(1)\n' }]);
  const created = (await pm3.list(chat, true)).find((x) => x.relPath === 'b.py');
  const cv = await pm3.view(created.id);
  assert.equal((await pm3.apply(created.id, { baseHash: cv.baseHash, contentHash: cv.contentHash })).ok, true);
  await store.saveConfig();
  const pm4 = new ProposalManager({ store: await reloadStore(data) });
  pm4.ingest(chat, [{ key: 'n2', text: '# &NEW:b.py\nprint(1)\n' }]);
  assert.equal((await pm4.list(chat, true)).filter((x) => x.relPath === 'b.py').length, 0);
  assert.ok(data, 'хранилище то же — решения читаются из config.json');
});

test('proposal: markAppliedExternally — принятие в буфер редактора закрывает предложение', async (t) => {
  const { root, store, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  const pm = new ProposalManager({ store });
  pm.ingest(chat, [{ key: 'k1', text: '# &a.py\nx = 2\n' }]);
  const [item] = await pm.list(chat, true);
  assert.equal(item.status, 'pending');

  // Пользователь принял предложение в буфер и сохранил его сам: main вызывает этот метод
  // после успешного file:write. Диск метод НЕ трогает — запись уже сделана редактором.
  assert.equal(pm.markAppliedExternally(item.id, { historyId: 'h-1' }), true);
  const [after] = await pm.list(chat, true);
  assert.equal(after.status, 'applied');
  assert.equal((await pm.view(item.id)).historyId, 'h-1');
  assert.equal(await fs.readFile(path.join(root, 'a.py'), 'utf8'), 'x = 1\n', 'диск не изменён');

  // повторный вызов и неизвестный id не ломают состояние
  assert.equal(pm.markAppliedExternally(item.id, { historyId: 'h-2' }), false);
  assert.equal(pm.markAppliedExternally('нет-такого', {}), false);

  // Журнал контекста метод не трогает: «модель знает» ставит main только когда сохранённый
  // текст байт в байт равен предложенному (честный учёт — иначе модель верила бы в версию,
  // которой никогда не видела).
  assert.deepEqual(store.contextKnown()[chat] || {}, {});

  // Решение переживает перезапуск, как после обычного apply. Но identical применённому
  // блок заново не предлагается (правило «не дублировать уже применённое»): файл уже
  // содержит ровно это содержимое, а запись о применении живёт в Истории.
  const pm2 = new ProposalManager({ store });
  pm2.ingest(chat, [{ key: 'k1-again', text: '# &a.py\nx = 2\n' }]);
  assert.deepEqual(await pm2.list(chat, true), [], 'применённый блок не возвращается карточкой');
  // отличающееся содержимое — по-прежнему новое предложение
  pm2.ingest(chat, [{ key: 'k1-other', text: '# &a.py\nx = 9\n' }]);
  const fresh = await pm2.list(chat, true);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].status, 'pending');
});

test('patch: полный цикл через предложение — Diff, запись с CRLF, откат', async (t) => {
  const { root, pm, chat } = await setup(t);
  const file = path.join(root, 'big.gd');
  const lines = Array.from({ length: 300 }, (_, i) => `var v${i} = ${i}`);
  await fs.writeFile(file, lines.join('\r\n') + '\r\n');

  pm.ingest(chat, [{ key: 'k', text: '# &big.gd\n' + patchText(['var v150 = 150', 'var v150 = 999']) }]);
  const [item] = await pm.list(chat, true);
  assert.equal(item.state, 'update');
  assert.equal(item.mode, 'patch');
  assert.equal(item.patchBlocks, 1);
  const v = await pm.view(item.id);
  assert.deepEqual(v.stats, { added: 1, removed: 1 });
  assert.equal(v.patchResults[0].line, 151);
  assert.ok(v.newText.includes('var v150 = 999') && v.newText.includes('var v299 = 299'));

  const res = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash });
  assert.equal(res.ok, true, res.error);
  const written = (await fs.readFile(file, 'utf8')).split('\r\n');
  assert.equal(written.length, 301); // 300 строк + пустой хвост
  assert.equal(written[150], 'var v150 = 999');

  // операция истории отдаёт оба текста целиком — их показывает Monaco DiffEditor (этап C).
  // CRLF нормализуется так же, как в построчном Diff: иначе стороны не совпали бы.
  const hv = await pm.historyView(res.historyId);
  assert.equal(hv.missingBackup, undefined);
  assert.equal(hv.beforeText.split('\r\n')[150], 'var v150 = 150');
  assert.equal(hv.afterText.split('\r\n')[150], 'var v150 = 999');
  assert.equal((await pm.historyRevert(res.historyId, false)).ok, true);
  assert.equal((await fs.readFile(file, 'utf8')).split('\r\n')[150], 'var v150 = 150');
});

test('patch: ошибки блокируют применение; NEW + патч недопустим; незакрытый блок', async (t) => {
  const { root, pm, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  pm.ingest(chat, [
    { key: '1', text: '# &a.py\n' + patchText(['нет такого', 'y']) },
    { key: '2', text: '# &NEW:b.py\n' + patchText(['a', 'b']) },
    { key: '3', text: '# &a.py\n<<<<<<< SEARCH\nx = 1\n=======\nx = 2' },
  ]);
  const list = await pm.list(chat, true);
  const by = (p) => list.find((x) => x.relPath === p && x.state !== 'x');
  assert.deepEqual(list.map((x) => x.state).sort(), ['patch-failed', 'patch-failed', 'patch-open']);
  const failed = list.find((x) => x.relPath === 'a.py' && x.state === 'patch-failed');
  const v = await pm.view(failed.id);
  assert.match(v.error, /Блок 1/);
  const r = await pm.apply(failed.id, { baseHash: v.baseHash, contentHash: v.contentHash });
  assert.equal(r.ok, false);
  assert.equal(await fs.readFile(path.join(root, 'a.py'), 'utf8'), 'x = 1\n');
  void by;
});

test('patch: блок дописывается — предложение обновляется, а не дублируется', async (t) => {
  const { root, pm, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  pm.ingest(chat, [{ key: 's', text: '# &a.py\n<<<<<<< SEARCH\nx = 1\n=======\nx = ' }]);
  assert.equal((await pm.list(chat, true))[0].state, 'patch-open');
  pm.ingest(chat, [{ key: 's', text: '# &a.py\n' + patchText(['x = 1', 'x = 2']) }]);
  const list = await pm.list(chat, true);
  assert.equal(list.length, 1);
  assert.equal(list[0].state, 'update');
});

// ---------- резервные копии ----------
test('бэкапы: хранятся только 2 последние операции на файл, очистка удаляет всё', async (t) => {
  const { root, data, store, pm, chat } = await setup(t);
  const file = path.join(root, 'a.txt');
  await fs.writeFile(file, 'v0\n');
  const ids = [];
  for (let i = 1; i <= 4; i++) {
    pm.ingest(chat, [{ key: 'k' + i, text: `# &a.txt\nv${i}\n` }]);
    const item = (await pm.list(chat, true)).find((x) => x.status === 'pending');
    const v = await pm.view(item.id);
    const r = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash });
    assert.equal(r.ok, true, r.error);
    ids.push(r.historyId);
  }
  const files = await fs.readdir(path.join(data, 'backups'));
  assert.equal(files.length, 4); // 2 операции × (before + after)
  assert.deepEqual(store.history.map((h) => !!h.pruned), [true, true, false, false]);

  // откат устаревшей операции запрещён, актуальной — работает
  assert.equal((await pm.historyRevert(ids[0], false)).code, 'pruned');
  assert.equal((await pm.historyView(ids[0])).missingBackup, true);
  assert.equal((await pm.historyRevert(ids[3], false)).ok, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'v3\n');

  // откат добавил в журнал запись, но не добавил ни одного файла копии
  const rollback = store.history.find((h) => h.source === 'rollback');
  assert.ok(rollback, 'запись об откате появилась в журнале');
  assert.equal(rollback.revertible, false);
  assert.equal(rollback.pruned, true);
  const stats = await store.backupStats();
  assert.equal(stats.files, 4); // откат копий не создаёт
  await store.clearBackups();
  assert.equal((await store.backupStats()).files, 0);
  assert.ok(store.history.every((h) => h.pruned));
  assert.equal(store.history.length, 5); // журнал остаётся: 4 операции + запись об откате
});

test('бэкапы: лимит считается отдельно по каждому файлу; создание можно откатить после очистки', async (t) => {
  const { root, store, pm, chat } = await setup(t);
  pm.ingest(chat, [{ key: 'n', text: '# &NEW:n.txt\nhello\n' }]);
  const item = (await pm.list(chat, true))[0];
  const v = await pm.view(item.id);
  const r = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash });
  await store.clearBackups();
  assert.equal((await pm.historyRevert(r.historyId, false)).ok, true); // create: файлы бэкапа не нужны
  await assert.rejects(fs.stat(path.join(root, 'n.txt')));
});

// ---------- генератор промпта ----------
test('промпт: поля по умолчанию, пропуск пустых, порядок и кастомные поля', () => {
  const secs = pg.defaultSections();
  assert.deepEqual(secs.map((s) => s.title), ['ЗАДАЧА', 'КОНТЕКСТ ПРОЕКТА', 'ЧТО В КОНТЕКСТЕ', 'ОГРАНИЧЕНИЯ', 'ПРАВИЛА РАБОТЫ', 'РЕЖИМ РАБОТЫ', 'СРЕДА ВЫПОЛНЕНИЯ', 'СТРУКТУРА ПРОЕКТА']);
  secs[0].text = 'Добавить двойной прыжок';
  secs.push({ id: 'x', key: null, title: 'МОЯ СЕКЦИЯ', text: 'abc', type: 'text' });
  const { text } = pg.buildPrompt({ sections: secs, project: null, tree: null, excluded: new Set() });
  assert.ok(text.startsWith('# ЗАДАЧА\nДобавить двойной прыжок\n\n# ЧТО В КОНТЕКСТЕ\nФайлы приложены'));
  assert.ok(!text.includes('# КОНТЕКСТ ПРОЕКТА')); // пустое поле не попадает
  assert.ok(text.includes('<<<<<<< SEARCH') && text.includes('# &NEW:'));
  assert.ok(text.endsWith('# МОЯ СЕКЦИЯ\nabc'));
  assert.ok(!text.includes('# СТРУКТУРА ПРОЕКТА')); // без проекта структуры нет
});

test('дерево: артефакты запуска .ide_build не видны в дереве и промпте (этап C3)', async (t) => {
  const { root, project } = await setup(t);
  await fs.mkdir(path.join(root, '.ide_build', 'classes'), { recursive: true });
  await fs.writeFile(path.join(root, '.ide_build', 'app.exe'), 'binary');
  await fs.writeFile(path.join(root, '.ide_build', 'classes', 'Main.class'), 'binary');
  await fs.mkdir(path.join(root, '__pycache__'));
  await fs.writeFile(path.join(root, '__pycache__', 'main.cpython-312.pyc'), 'binary');
  await fs.writeFile(path.join(root, 'main.py'), 'print(1)');
  fileops.invalidateIndex();
  const tree = await fileops.getTree(root);
  const rels = tree.nodes.map((n) => n.rel);
  assert.ok(rels.includes('main.py'), 'обычные файлы на месте');
  assert.ok(!rels.includes('.ide_build'), 'артефакты сборки скрыты из дерева');
  assert.ok(!rels.includes('__pycache__'), 'кеш python скрыт из дерева');
  // промпт-генератор видит то же дерево — артефакты не утекают модели
  const secs = pg.defaultSections().filter((s) => s.type === 'tree');
  const full = pg.buildPrompt({ sections: secs, project, tree, excluded: new Set() });
  assert.ok(!full.text.includes('.ide_build'));
  assert.ok(!full.text.includes('Main.class'));
});

test('промпт: дерево проекта, отключение папок и приписка о неполной структуре', async (t) => {
  const { root, project } = await setup(t);
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.mkdir(path.join(root, 'assets'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'scripts', 'player.gd'), 'x');
  await fs.writeFile(path.join(root, 'scripts', 'enemy.gd'), 'x');
  await fs.writeFile(path.join(root, 'assets', 'big.png'), 'x');
  await fs.writeFile(path.join(root, 'project.godot'), 'x');
  const tree = await fileops.getTree(root);
  const secs = pg.defaultSections().filter((s) => s.type === 'tree');

  const full = pg.buildPrompt({ sections: secs, project, tree, excluded: new Set() });
  assert.equal(full.partial, false);
  assert.ok(full.text.includes('./ (корень проекта)\n├── assets/'));
  assert.ok(!full.text.includes(project.name), 'имя корневой папки не должно попадать в дерево');
  assert.ok(full.text.includes('имя корневой папки в путь не входит'));
  assert.ok(full.text.includes('├── assets/\n│   └── big.png'));
  assert.ok(full.text.includes('└── project.godot'));
  assert.ok(!full.text.includes('node_modules'));
  assert.ok(!full.text.includes('намеренно скрыта'));

  const part = pg.buildPrompt({ sections: secs, project, tree, excluded: new Set(['assets', 'scripts/enemy.gd']) });
  assert.equal(part.partial, true);
  assert.ok(!part.text.includes('big.png') && !part.text.includes('assets/') && !part.text.includes('enemy.gd'));
  assert.ok(part.text.includes('player.gd'));
  assert.ok(part.text.includes('Структура проекта указана не полностью'));
});

test('промпт: sanitizeSections и пресеты в хранилище', async (t) => {
  const bad = pg.sanitizeSections([null, { title: 5, text: { a: 1 }, type: 'weird', id: 'a' }, { id: 'a', title: 'T', type: 'tree' }]);
  assert.equal(bad.length, 2);
  assert.equal(bad[0].type, 'text');
  assert.notEqual(bad[0].id, bad[1].id);
  assert.equal(pg.sanitizeSections('мусор').length, pg.defaultSections().length); // мусор → стандартный набор полей

  const { store } = await setup(t);
  await store.savePreset('Godot', pg.defaultSections());
  await store.savePreset('godot', [{ id: '1', key: null, title: 'A', text: 'b', type: 'text' }]); // тот же пресет, перезапись
  assert.equal(store.listPresets().length, 1);
  assert.equal(store.getPreset(store.listPresets()[0].id).sections[0].title, 'A');
  await store.setTreeOff('p1', ['assets']);
  assert.deepEqual(store.getTreeOff('p1'), ['assets']);
  await store.deletePreset(store.listPresets()[0].id);
  assert.equal(store.listPresets().length, 0);
});

// ---------- REPLACE_BLOCK: замена функции по заголовку ----------
const B = (...lines) => ({ kind: 'block', lines });

test('block: парсинг REPLACE_BLOCK вместе с SEARCH/REPLACE', () => {
  const body = '<<<<<<< REPLACE_BLOCK\ndef main():\n    pass\n>>>>>>> REPLACE_BLOCK\n' + patchText(['a', 'b']);
  const r = parseBlock('# &t.py\n' + body);
  assert.equal(r.mode, 'patch');
  assert.equal(r.edits.length, 2);
  assert.deepEqual(r.edits[0], { kind: 'block', lines: ['def main():', '    pass'] });
  assert.deepEqual(r.issues, []);
  assert.equal(parsePatch('<<<<<<< REPLACE_BLOCK\ndef f():').open, true);
});

test('block: Python — заменяется только функция, «if __name__» и остальное не трогаются', () => {
  const old = 'import os\n\ndef helper():\n    return 1\n\ndef main():\n    print("old")\n    x = helper()\n\nif __name__ == "__main__":\n    main()\n';
  const r = applyEdits(old, [B('def main():', '    print("new")', '    return 5')]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, 'import os\n\ndef helper():\n    return 1\n\ndef main():\n    print("new")\n    return 5\n\nif __name__ == "__main__":\n    main()\n');
  assert.equal(r.results[0].method, 'block');
  assert.equal(r.results[0].line, 6);
});

test('block: метод класса — отступ новой версии подгоняется под файл', () => {
  const old = 'class A:\n    def run(self):\n        return 1\n\n    def stop(self):\n        return 2\n';
  const r = applyEdits(old, [B('def run(self):', '    return 100')]); // модель написала без отступа класса
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, 'class A:\n    def run(self):\n        return 100\n\n    def stop(self):\n        return 2\n');
});

test('block: сигнатура изменилась — находим по имени и предупреждаем методом block-name', () => {
  const old = 'def main():\n    pass\n\nprint(main())\n';
  const r = applyEdits(old, [B('def main(argv):', '    return argv')]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.results[0].method, 'block-name');
  assert.equal(r.text, 'def main(argv):\n    return argv\n\nprint(main())\n');
});

test('block: GDScript, декораторы и многострочная сигнатура', () => {
  const old = '@rpc("any_peer")\nfunc hit(a,\n\t\tb) -> void:\n\tpass\n\nfunc other():\n\tpass\n';
  // без своих декораторов — старые сохраняются
  const keep = applyEdits(old, [B('func hit(a,', '\t\tb) -> void:', '\tprint(a)')]);
  assert.equal(keep.ok, true, keep.error);
  assert.equal(keep.text, '@rpc("any_peer")\nfunc hit(a,\n\t\tb) -> void:\n\tprint(a)\n\nfunc other():\n\tpass\n');
  // со своими — заменяются
  const swap = applyEdits(old, [B('@rpc("authority")', 'func hit(a, b) -> void:', '\tpass')]);
  assert.equal(swap.ok, true, swap.error);
  assert.equal(swap.text, '@rpc("authority")\nfunc hit(a, b) -> void:\n\tpass\n\nfunc other():\n\tpass\n');
});

test('block: фигурные скобки (JS и C# Allman), строки и комментарии со скобками', () => {
  const js = 'function a() {\n  return 1;\n}\n\nfunction b(x) {\n  const s = "}";\n  // }\n  if (x) {\n    return 2;\n  }\n}\n\nb();\n';
  const r1 = applyEdits(js, [B('function b(x) {', '  return x * 2;', '}')]);
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.text, 'function a() {\n  return 1;\n}\n\nfunction b(x) {\n  return x * 2;\n}\n\nb();\n');

  const cs = 'class P\n{\n    public void Go()\n    {\n        Run();\n    }\n\n    public void Stop()\n    {\n    }\n}\n';
  const r2 = applyEdits(cs, [B('    public void Go()', '    {', '        Walk();', '    }')]);
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.text, 'class P\n{\n    public void Go()\n    {\n        Walk();\n    }\n\n    public void Stop()\n    {\n    }\n}\n');
});

test('block: неоднозначный заголовок и ненайденная функция — ошибка без изменений', () => {
  const old = 'class A:\n    def run(self):\n        pass\n\nclass B:\n    def run(self):\n        pass\n';
  const amb = applyEdits(old, [B('def run(self):', '    return 1')]);
  assert.equal(amb.ok, false);
  assert.equal(amb.results[0].status, 'ambiguous');
  const nf = applyEdits(old, [B('def missing():', '    return 1')]);
  assert.equal(nf.ok, false);
  assert.match(nf.error, /не найдены в файле/);
  assert.equal(applyEdits('x = 1\n', [B('x = 2')]).ok, false); // не заголовок, границы не определить
});

test('block: комбинирование с SEARCH/REPLACE; предупреждение «весь файл в SEARCH»', () => {
  const old = 'def f():\n    return 1\n\nVALUE = 1\n';
  const r = applyEdits(old, [B('def f():', '    return 2'), E('VALUE = 1', 'VALUE = 2')]);
  assert.equal(r.text, 'def f():\n    return 2\n\nVALUE = 2\n');

  const big = Array.from({ length: 20 }, (_, i) => 'line' + i).join('\n') + '\n';
  const whole = applyEdits(big, [E(big.trimEnd(), big.trimEnd().replace('line5', 'X'))]);
  assert.equal(whole.ok, true);
  assert.equal(whole.results[0].wholeFile, true);
  assert.equal(applyEdits(big, [E('line5', 'X')]).results[0].wholeFile, false);
});

test('block: через предложение — test.py, как в реальном сценарии', async (t) => {
  const { root, pm, chat } = await setup(t);
  const orig = 'def main():\n    print("hello")\n\nif __name__ == "__main__":\n    main()\n';
  await fs.writeFile(path.join(root, 'test.py'), orig);
  pm.ingest(chat, [{ key: 'k', text: '# &test.py\n<<<<<<< REPLACE_BLOCK\ndef main():\n    print("hello, world")\n>>>>>>> REPLACE_BLOCK' }]);
  const [item] = await pm.list(chat, true);
  assert.equal(item.state, 'update');
  const v = await pm.view(item.id);
  assert.deepEqual(v.stats, { added: 1, removed: 1 });
  assert.equal((await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash })).ok, true);
  assert.equal(await fs.readFile(path.join(root, 'test.py'), 'utf8'), 'def main():\n    print("hello, world")\n\nif __name__ == "__main__":\n    main()\n');
});

test('путь с именем корневой папки: убирается, если такой подпапки нет', async (t) => {
  const { root, pm, chat } = await setup(t);
  const name = path.basename(root);
  await fs.writeFile(path.join(root, 'test.py'), 'x = 1\n');
  pm.ingest(chat, [
    { key: 'a', text: `# &${name}/test.py\nx = 2\n` },
    { key: 'b', text: `# &NEW:${name}/scripts/new.py\ny = 1\n` },
  ]);
  const list = await pm.list(chat, true);
  const a = list.find((x) => x.relPath === 'test.py');
  assert.ok(a, 'путь исправлен до test.py');
  assert.equal(a.state, 'update');
  assert.equal(a.pathFixed, true);
  const v = await pm.view(a.id);
  assert.deepEqual(v.pathFixed, { from: `${name}/test.py`, to: 'test.py' });
  assert.equal((await pm.apply(a.id, { baseHash: v.baseHash, contentHash: v.contentHash })).ok, true);
  assert.equal(await fs.readFile(path.join(root, 'test.py'), 'utf8'), 'x = 2\n');
  assert.ok(list.some((x) => x.relPath === 'scripts/new.py' && x.state === 'create'));
});

test('путь с именем корня НЕ трогается, если внутри есть настоящая подпапка с таким именем', async (t) => {
  const { root, pm, chat } = await setup(t);
  const name = path.basename(root);
  await fs.mkdir(path.join(root, name));
  await fs.writeFile(path.join(root, name, 'inner.py'), 'a = 1\n');
  pm.ingest(chat, [{ key: 'a', text: `# &${name}/inner.py\na = 2\n` }]);
  const [item] = await pm.list(chat, true);
  assert.equal(item.relPath, `${name}/inner.py`);
  assert.equal(item.pathFixed, false);
  assert.equal(item.state, 'update');
});

test('промпт: новые правила описывают REPLACE_BLOCK и запрещают весь файл в SEARCH; старые правила обновляются', () => {
  const r = pg.DEFAULT_RULES;
  assert.ok(r.includes('<<<<<<< REPLACE_BLOCK') && r.includes('>>>>>>> REPLACE_BLOCK'));
  assert.ok(pg.FORMAT_REMINDER.includes('# &DELETE:') && pg.FORMAT_REMINDER.includes('# &MOVE:'));
  assert.ok(r.includes('if __name__ == "__main__":'));
  assert.ok(r.includes('НИКОГДА не клади в SEARCH весь файл'));
  assert.ok(r.includes('имя корневой папки в путь НЕ входит'));
  // пример из правил сам парсится приложением как корректный блок
  const sample = r.slice(r.indexOf('<<<<<<< REPLACE_BLOCK'), r.indexOf('>>>>>>> REPLACE_BLOCK') + '>>>>>>> REPLACE_BLOCK'.length);
  const parsed = parseBlock('# &a.py\n' + sample);
  assert.equal(parsed.mode, 'patch');
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.edits[0].kind, 'block');

  const secs = pg.defaultSections();
  const legacy = require('../src/promptgen');
  void legacy;
  // старый текст по умолчанию заменяется, изменённый пользователем — нет
  const old = { id: '1', key: 'rules', type: 'text', title: 'ПРАВИЛА РАБОТЫ', text: 'мой собственный текст' };
  assert.equal(pg.upgradeLegacy([old])[0].text, 'мой собственный текст');
  assert.equal(pg.upgradeLegacy(secs)[4].text, pg.DEFAULT_RULES);
});

test('промпт: правила 13–14 учат модель маркерам &RUN: и &CMD: (этап C3c)', () => {
  const r = pg.DEFAULT_RULES;
  // запуск файла: маркер, аргументы, тело как ввод, supported-языки
  assert.match(r, /13\. Чтобы предложить мне запустить файл проекта/);
  assert.match(r, /# &RUN:путь\/к\/файлу \[аргументы\]/);
  assert.match(r, /Тело блока — ввод для программы/);
  assert.match(r, /Python, JavaScript\/TypeScript, C\+\+, C и Java/);
  // команда: оболочка, подтверждение, назначение «для чтения, а не для правки»
  assert.match(r, /14\. Чтобы предложить команду терминала/);
  assert.match(r, /# &CMD:команда/);
  assert.match(r, /Windows — cmd\.exe/);
  assert.match(r, /каждую команду я подтверждаю сам/);
  assert.match(r, /Используй команды для чтения и поиска, а не для изменения файлов/);
  // правило про блоки без маркера уточнено: команды без &CMD: не выполняются
  assert.match(r, /Команды терминала, присланные без маркера &CMD:, приложение просто показывает — не выполняет/);
  // нумерация не сломана: 14 пунктов подряд
  for (let i = 1; i <= 14; i++) assert.ok(r.includes(`\n${i}. `), `в правилах есть пункт ${i}`);

  // памятка формата дополнена теми же двумя маркерами
  assert.match(pg.FORMAT_REMINDER, /# &RUN:/);
  assert.match(pg.FORMAT_REMINDER, /# &CMD:/);

  // примеры маркеров в правилах сами разбираются приложением
  assert.equal(parseBlock('# &RUN:src/main.py\n5\n').marker.op, 'run');
  assert.equal(parseBlock('# &CMD:grep -rn Player src\n').marker.op, 'cmd');
  // легитимность старой эвристики (ТЗ §3.8): в правилах по-прежнему есть &DELETE:
  assert.ok(r.includes('&DELETE:'), 'эвристика LEGACY_RULES не сломана');
});

test('промпт: устаревшие правила — нетронутые обновляются молча, правленые предлагаются кнопкой', () => {
  // прежний текст по умолчанию (правила 1–12, без &RUN:/&CMD:) лежит в LEGACY_RULES:
  // пользователь его не правил, поэтому замена автоматическая
  const prev = pg.LEGACY_RULES[pg.LEGACY_RULES.length - 1];
  assert.ok(prev.includes('&DELETE:') && !prev.includes('&RUN:'), 'в списке устаревших — правила до этапа C3c');
  const upgraded = pg.upgradeLegacy([{ id: 'r', key: 'rules', type: 'text', title: 'ПРАВИЛА РАБОТЫ', text: prev }]);
  assert.equal(upgraded[0].text, pg.DEFAULT_RULES, 'нетронутые прежние правила заменены молча');
  assert.equal(pg.rulesNeedUpgrade(prev), false, 'для них кнопка не предлагается — они уже обновлены');

  // актуальный текст не считается устаревшим
  assert.equal(pg.rulesNeedUpgrade(pg.DEFAULT_RULES), false);

  // пользователь дописал правила сам (оба маркера на месте) — не трогаем
  const own = pg.DEFAULT_RULES + '\n15. Моё правило.';
  assert.equal(pg.rulesNeedUpgrade(own), false);
  assert.equal(pg.upgradeLegacy([{ id: 'r', key: 'rules', type: 'text', title: 'x', text: own }])[0].text, own);

  // правленый текст прежних правил: молча перезаписывать нельзя, предлагается кнопка
  const edited = prev.replace('10. Перед кодом коротко объясни', '10. Перед кодом подробно объясни');
  assert.equal(pg.rulesNeedUpgrade(edited), true, 'устаревшие правленые правила — обновить кнопкой');
  assert.equal(pg.upgradeLegacy([{ id: 'r', key: 'rules', type: 'text', title: 'x', text: edited }])[0].text, edited,
    'без нажатия кнопки текст пользователя не меняется');

  // авторский текст, на наши правила не похожий, не предлагается трогать
  assert.equal(pg.rulesNeedUpgrade('Пиши код на Python и комментируй по-русски.'), false);
  assert.equal(pg.rulesNeedUpgrade(''), false);
  assert.equal(pg.rulesNeedUpgrade(null), false);
  // другие секции не проверяются вовсе
  assert.equal(pg.upgradeLegacy([{ id: 't', key: 'task', type: 'text', title: 'ЗАДАЧА', text: 'SEARCH/REPLACE' }])[0].text, 'SEARCH/REPLACE');
});

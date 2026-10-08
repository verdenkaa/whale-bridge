'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { parseBlock, extractFencedBlocks } = require('../src/parser');
const { normalizeRel, resolveInProject } = require('../src/paths');
const { diffLines, diffStats, toRows } = require('../src/diff');
const fileops = require('../src/fileops');
const { Store } = require('../src/store');
const { ProposalManager } = require('../src/proposals');
const { FORMAT_REMINDER } = require('../src/promptgen');

// ---------- parser ----------
test('parser: update marker (пример из DOM DeepSeek)', () => {
  const text = '# &main.py\nprint("Hello, World!")';
  const r = parseBlock(text);
  assert.deepEqual(r.marker, { op: 'update', path: 'main.py' });
  assert.equal(r.content, 'print("Hello, World!")\n');
});

test('parser: NEW marker, разные стили комментариев, &amp;', () => {
  assert.deepEqual(parseBlock('# &NEW:scripts/weapon.gd\nextends Node').marker, { op: 'create', path: 'scripts/weapon.gd' });
  assert.deepEqual(parseBlock('// &src/a.js\nx').marker, { op: 'update', path: 'src/a.js' });
  assert.deepEqual(parseBlock('/* &NEW: css/a.css */\nbody{}').marker, { op: 'create', path: 'css/a.css' });
  assert.deepEqual(parseBlock('<!-- &index.html -->\n<p/>').marker, { op: 'update', path: 'index.html' });
  assert.deepEqual(parseBlock('# &amp;main.py\nx').marker, { op: 'update', path: 'main.py' });
});

test('parser: без маркера — не предложение; маркер вырезается из содержимого', () => {
  assert.equal(parseBlock('print(1)').marker, null);
  assert.ok(!parseBlock('# &a.py\nx = 1\n').content.includes('&a.py'));
});

test('parser: обрезанный код', () => {
  assert.equal(parseBlock('# &a.py\ndef f():\n    # ... остальной код\n    pass').incomplete.length, 1);
  assert.equal(parseBlock('// &a.js\n// rest of the code\nx()').incomplete.length, 1);
  assert.equal(parseBlock('# &a.py\nx = 1\n').incomplete.length, 0);
});

test('parser: extractFencedBlocks', () => {
  const t = 'a\n```py\n# &a.py\nx=1\n```\ntext\n```\ny\n```';
  assert.deepEqual(extractFencedBlocks(t), ['# &a.py\nx=1', 'y']);
  assert.deepEqual(extractFencedBlocks('plain'), ['plain']);
});

// ---------- paths ----------
test('paths: опасные пути отклоняются', () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/x', 'C:\\x', '\\\\srv\\share\\x', '.git/config', 'a/.GIT/x', 'nul.txt', 'a\0b', '', '   ', 'a/b.']) {
    assert.equal(normalizeRel(bad).ok, false, bad);
  }
});

test('paths: нормализация и различие scripts/player.gd vs enemies/player.gd', () => {
  assert.equal(normalizeRel('.\\scripts\\player.gd').rel, 'scripts/player.gd');
  assert.notEqual(normalizeRel('scripts/player.gd').rel, normalizeRel('enemies/player.gd').rel);
});

test('paths: symlink наружу блокируется', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-out-'));
  const link = path.join(root, 'link');
  t.after(async () => {
    // Ссылку снимаем отдельно и без рекурсии: удалять надо саму ссылку, а не то,
    // на что она указывает (для junction на Windows это особенно важно).
    try { await fs.rm(link, { recursive: false, force: true }); } catch { /* уже нет */ }
    await Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]);
  });
  try {
    await fs.symlink(outside, link, 'dir');
  } catch {
    // Windows без режима разработчика не даёт создавать symlink, но junction для папок
    // разрешён всем — для проверки блокировки выхода за проект этого достаточно.
    try { await fs.symlink(outside, link, 'junction'); } catch { return t.skip('symlink недоступен'); }
  }
  const r = await resolveInProject(root, 'link/evil.txt');
  assert.equal(r.ok, false);
});

// ---------- diff ----------
function applyOps(ops) {
  return ops.filter((o) => o.type !== 'del').map((o) => o.text);
}
function oldOf(ops) {
  return ops.filter((o) => o.type !== 'add').map((o) => o.text);
}

test('diff: фаззинг — восстанавливает обе версии', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let it = 0; it < 300; it++) {
    const mk = () => Array.from({ length: Math.floor(rnd() * 30) }, () => 'l' + Math.floor(rnd() * 6));
    const a = mk(), b = mk();
    const ops = diffLines(a.join('\n') + (a.length ? '\n' : ''), b.join('\n') + (b.length ? '\n' : ''));
    assert.deepEqual(oldOf(ops), a);
    assert.deepEqual(applyOps(ops), b);
  }
});

test('diff: статистика, нумерация, сворачивание контекста', () => {
  const a = Array.from({ length: 40 }, (_, i) => 'line' + i).join('\n') + '\n';
  const b = a.replace('line20\n', 'CHANGED\nextra\n');
  const ops = diffLines(a, b);
  assert.deepEqual(diffStats(ops), { added: 2, removed: 1 });
  const rows = toRows(ops, 3);
  assert.equal(rows[0].type, 'skip');
  assert.ok(rows.some((r) => r.type === 'add' && r.text === 'CHANGED'));
  assert.equal(diffStats(diffLines(a, a)).added, 0);
  assert.deepEqual(toRows(diffLines(a, a)), []);
});

test('diff: CRLF и LF считаются одинаковыми', () => {
  assert.equal(diffStats(diffLines('a\r\nb\r\n', 'a\nb\n')).added, 0);
});

test('diff: удаление последней строки не превращает соседнюю одинаковую строку в -/+ пару', () => {
  const old = 'one\ntwo\nprint("и ещё одна строка")\nprint("четвёртая строка")\n';
  const next = 'one\ntwo\nprint("и ещё одна строка")\n';
  const ops = diffLines(old, next);
  assert.deepEqual(diffStats(ops), { added: 0, removed: 1 });
  assert.deepEqual(ops.filter((x) => x.type !== 'eq'), [{ type: 'del', text: 'print("четвёртая строка")', oldNo: 4 }]);
});

// ---------- fileops / proposals ----------
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-proj-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-data-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]));
  const store = new Store(data);
  await store.load();
  const project = await store.addProject(root);
  const chat = '17b45023-2aba-4a1a-a966-17bbe41926ea';
  await store.bind(chat, project.id);
  const pm = new ProposalManager({ store });
  return { root, store, project, chat, pm };
}

test('apply: обновление с бэкапом, сохранением CRLF и историей', async (t) => {
  const { root, pm, chat, store } = await setup(t);
  await fs.mkdir(path.join(root, 'scripts'));
  const file = path.join(root, 'scripts', 'player.gd');
  await fs.writeFile(file, 'extends Node\r\n\r\nfunc a():\r\n\tpass\r\n');

  pm.ingest(chat, [{ key: 'k1', text: '# &scripts/player.gd\nextends Node\n\nfunc a():\n\tprint(1)\n' }]);
  const [item] = await pm.list(chat, true);
  assert.equal(item.state, 'update');
  const v = await pm.view(item.id);
  // обе стороны текста для Monaco DiffEditor (этап C): что на диске и что предлагает модель
  assert.equal(v.baseText, 'extends Node\r\n\r\nfunc a():\r\n\tpass\r\n');
  assert.equal(v.newText, 'extends Node\n\nfunc a():\n\tprint(1)\n');
  const res = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash });
  assert.equal(res.ok, true, res.error);

  const written = await fs.readFile(file, 'utf8');
  assert.equal(written, 'extends Node\r\n\r\nfunc a():\r\n\tprint(1)\r\n');
  assert.ok(!written.includes('&scripts'));
  assert.equal((await fs.readdir(path.join(root, 'scripts'))).length, 1); // нет временных файлов
  assert.equal(store.history.length, 1);

  // откат
  const back = await pm.historyRevert(res.historyId, false);
  assert.equal(back.ok, true, back.error);
  assert.equal(await fs.readFile(file, 'utf8'), 'extends Node\r\n\r\nfunc a():\r\n\tpass\r\n');
});

test('apply: конфликт, если файл изменился после Diff', async (t) => {
  const { root, pm, chat } = await setup(t);
  const file = path.join(root, 'a.py');
  await fs.writeFile(file, 'x = 1\n');
  pm.ingest(chat, [{ key: 'k', text: '# &a.py\nx = 2\n' }]);
  const [item] = await pm.list(chat, true);
  const v = await pm.view(item.id);
  await fs.writeFile(file, 'x = 99\n'); // пользователь поправил файл вручную
  const res = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'conflict');
  assert.equal(await fs.readFile(file, 'utf8'), 'x = 99\n');
});

test('apply: неполный ответ блокируется без явного разрешения', async (t) => {
  const { root, pm, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'def f():\n    pass\n');
  pm.ingest(chat, [{ key: 'k', text: '# &a.py\ndef f():\n    # ... остальной код\n' }]);
  const [item] = await pm.list(chat, true);
  const v = await pm.view(item.id);
  const r1 = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash });
  assert.equal(r1.code, 'incomplete');
  const r2 = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash, allowIncomplete: true });
  assert.equal(r2.ok, true);
});

test('create: новый файл, защита от перезаписи, папки только по запросу', async (t) => {
  const { root, pm, chat } = await setup(t);
  pm.ingest(chat, [{ key: 'n', text: '# &NEW:scripts/weapon.gd\nextends Node\n' }]);
  let [item] = await pm.list(chat, true);
  assert.equal(item.state, 'create');
  let v = await pm.view(item.id);
  assert.equal(v.needsDirs, true);
  // у нового файла нет стороны «на диске» — интерфейс рисует дифф от пустого текста
  assert.equal(v.baseText, null);
  const noDir = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash });
  assert.equal(noDir.code, 'no-dir');
  const ok = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash, createDirs: true });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(await fs.readFile(path.join(root, 'scripts', 'weapon.gd'), 'utf8'), 'extends Node\n');

  // тот же путь как NEW, но файл уже существует
  pm.ingest(chat, [{ key: 'n2', text: '# &NEW:scripts/weapon.gd\nother\n' }]);
  [item] = (await pm.list(chat, true)).filter((x) => x.status === 'pending');
  assert.equal(item.state, 'exists');
  // откат создания удаляет файл
  const back = await pm.historyRevert(ok.historyId, false);
  assert.equal(back.ok, true);
  await assert.rejects(fs.stat(path.join(root, 'scripts', 'weapon.gd')));
});

test('proposals: опасный путь, дедупликация, обновление стримящегося блока, подсказки пути', async (t) => {
  const { root, pm, chat } = await setup(t);
  pm.ingest(chat, [{ key: 'e', text: '# &../evil.py\nx\n' }]);
  let list = await pm.list(chat, true);
  assert.equal(list[0].state, 'invalid-path');

  // дубль того же блока — не создаёт второго предложения
  pm.ingest(chat, [{ key: 'e', text: '# &../evil.py\nx\n' }, { key: 'other', text: '# &../evil.py\nx\n' }]);
  assert.equal((await pm.list(chat, true)).length, 1);

  // блок дописывается — предложение обновляется, а не дублируется
  pm.ingest(chat, [{ key: 's', text: '# &NEW:s.py\nprint(' }]);
  pm.ingest(chat, [{ key: 's', text: '# &NEW:s.py\nprint(1)\n' }]);
  list = await pm.list(chat, true);
  assert.equal(list.length, 2);
  assert.equal((await pm.view(list.find((x) => x.relPath === 's.py').id)).newText, 'print(1)\n');

  // регистр и неверная папка → подсказка
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.writeFile(path.join(root, 'scripts', 'Player.gd'), 'x\n');
  pm.ingest(chat, [{ key: 'm', text: '# &enemies/player.gd\ny\n' }]);
  const m = (await pm.list(chat, true)).find((x) => x.relPath === 'enemies/player.gd');
  assert.equal(m.state, 'missing');
  const view = await pm.view(m.id);
  assert.deepEqual(view.suggestions, ['scripts/Player.gd']);
});

test('proposals: историческое из чата скрыто по умолчанию', async (t) => {
  const { pm, chat } = await setup(t);
  pm.ingest(chat, [{ key: 'h', text: '# &NEW:old.py\nx\n', initial: true }]);
  assert.equal((await pm.list(chat, false)).length, 0);
  assert.equal((await pm.list(chat, true)).length, 1);
});

test('dismiss: карточка убирается и не возвращается при повторном обнаружении', async (t) => {
  const { pm, chat } = await setup(t);
  pm.ingest(chat, [{ key: 'a', text: '# &NEW:a.py\nx\n' }, { key: 'b', text: '# &NEW:b.py\ny\n' }]);
  let list = await pm.list(chat, true);
  assert.equal(list.length, 2);
  pm.dismiss(list[0].id);
  assert.equal((await pm.list(chat, true)).length, 1);
  // наблюдатель пересылает тот же блок (например, после перезагрузки страницы, другой ключ)
  pm.ingest(chat, [{ key: 'zzz', text: '# &NEW:a.py\nx\n' }, { key: 'yyy', text: '# &NEW:b.py\ny\n' }]);
  assert.equal((await pm.list(chat, true)).length, 1);
  pm.dismissAll(chat, true);
  assert.equal((await pm.list(chat, true)).length, 0);
});

test('файл, созданный вне приложения после появления карточки, распознаётся как существующий', async (t) => {
  const { root, pm, chat } = await setup(t);
  pm.ingest(chat, [{ key: 'a', text: '# &notes.txt\nновый текст\n' }]);
  assert.equal((await pm.list(chat, true))[0].state, 'missing');
  await fs.writeFile(path.join(root, 'notes.txt'), 'старый текст\n'); // пользователь создал файл в проводнике
  fileops.invalidateIndex();
  const [item] = await pm.list(chat, true);
  assert.equal(item.state, 'update');
  const v = await pm.view(item.id);
  assert.equal((await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash })).ok, true);
  assert.equal(await fs.readFile(path.join(root, 'notes.txt'), 'utf8'), 'новый текст\n');
});

test('защита кодировки: CP1251 не позволяет обновлять файл и не меняет исходные байты', async (t) => {
  const { root, pm, chat } = await setup(t);
  const file = path.join(root, 'legacy.txt');
  const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0d, 0x0a]); // «Привет»\r\n
  await fs.writeFile(file, cp1251);
  pm.ingest(chat, [{ key: 'cp1251', text: '# &legacy.txt\nПривет, UTF-8!\n' }]);
  const [item] = await pm.list(chat, true);
  assert.equal(item.state, 'unreadable');
  const view = await pm.view(item.id);
  assert.match(view.error, /не UTF-8/i);
  const before = await fs.readFile(file);
  const result = await pm.apply(item.id, { baseHash: view.baseHash, contentHash: view.contentHash });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'state');
  assert.deepEqual(await fs.readFile(file), before);
});

test('удаление и перемещение CP1251-файла не требуют декодирования', async (t) => {
  const { root, pm, chat } = await setup(t);
  const bytes = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
  const del = path.join(root, 'legacy-delete.txt');
  const move = path.join(root, 'legacy-move.txt');
  await fs.writeFile(del, bytes);
  await fs.writeFile(move, bytes);

  const trashDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-trash-cp1251-'));
  t.after(() => fs.rm(trashDir, { recursive: true, force: true }));
  pm.trash = async (abs) => fs.rename(abs, path.join(trashDir, path.basename(abs)));

  pm.ingest(chat, [
    { key: 'del-cp1251', text: '# &DELETE:legacy-delete.txt\n' },
    { key: 'move-cp1251', text: '# &MOVE:legacy-move.txt -> archive/legacy-move.txt\n' },
  ]);
  const items = await pm.list(chat, true);
  const delItem = items.find((x) => x.op === 'delete');
  const moveItem = items.find((x) => x.op === 'move');
  assert.equal(delItem.state, 'delete');
  assert.equal(moveItem.state, 'move');

  const delView = await pm.view(delItem.id);
  const moveView = await pm.view(moveItem.id);
  assert.ok(delView.encodingWarning);
  assert.ok(moveView.encodingWarning);

  assert.equal((await pm.apply(delItem.id, { baseHash: delView.baseHash, contentHash: delView.contentHash })).ok, true);
  assert.equal((await pm.apply(moveItem.id, { baseHash: moveView.baseHash, contentHash: moveView.contentHash, createDirs: true })).ok, true);
  assert.deepEqual(await fs.readFile(path.join(trashDir, 'legacy-delete.txt')), bytes);
  assert.deepEqual(await fs.readFile(path.join(root, 'archive', 'legacy-move.txt')), bytes);
});

test('пустой файл, созданный в проводнике, обновляется без ошибок', async (t) => {
  const { root, pm, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'empty.gd'), '');
  pm.ingest(chat, [{ key: 'a', text: '# &empty.gd\nextends Node\n' }]);
  const [item] = await pm.list(chat, true);
  assert.equal(item.state, 'update');
  const v = await pm.view(item.id);
  assert.equal((await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash })).ok, true);
});

test('prompt: краткая памятка содержит все форматы действий', () => {
  assert.match(FORMAT_REMINDER, /&NEW:/);
  assert.match(FORMAT_REMINDER, /SEARCH/);
  assert.match(FORMAT_REMINDER, /REPLACE/);
  assert.match(FORMAT_REMINDER, /# &DELETE:/);
  assert.match(FORMAT_REMINDER, /# &MOVE:/);
  assert.match(FORMAT_REMINDER, /REPLACE_BLOCK/);
  assert.match(FORMAT_REMINDER, /Diff/);
});

test('parser: DELETE и MOVE маркеры', () => {
  assert.deepEqual(parseBlock('# &DELETE:scripts/old.gd\n').marker, { op: 'delete', path: 'scripts/old.gd' });
  assert.deepEqual(parseBlock('# &MOVE:scripts/old.gd -> archive/old.gd\n').marker, {
    op: 'move', path: 'scripts/old.gd', toPath: 'archive/old.gd',
  });
});

test('proposals: DELETE показывает diff, отправляет файл в корзину и откатывается из бэкапа', async (t) => {
  const { root, pm, chat, store } = await setup(t);
  const file = path.join(root, 'old.txt');
  await fs.writeFile(file, 'line 1\nline 2\n');
  const trashed = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-trash-')), 'old.txt');
  t.after(() => fs.rm(path.dirname(trashed), { recursive: true, force: true }));
  const oldTrash = pm.trash;
  pm.trash = async (abs) => { await fs.rename(abs, trashed); };

  pm.ingest(chat, [{ key: 'del', text: '# &DELETE:old.txt\n' }]);
  const item = (await pm.list(chat, true))[0];
  assert.equal(item.op, 'delete');
  assert.equal(item.state, 'delete');
  const view = await pm.view(item.id);
  assert.equal(view.stats.removed, 2);
  const applied = await pm.apply(item.id, { baseHash: view.baseHash, contentHash: view.contentHash });
  assert.equal(applied.ok, true, applied.error);
  await assert.rejects(fs.stat(file));
  assert.equal(await fs.readFile(trashed, 'utf8'), 'line 1\nline 2\n');
  assert.equal((await store.backupStats()).files, 2);
  assert.equal((await pm.historyRevert(applied.historyId, false)).ok, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'line 1\nline 2\n');
  assert.equal(await fs.stat(trashed).then(() => true, () => false), true);
  pm.trash = oldTrash;
});

test('proposals: MOVE требует отсутствующего назначения и умеет откатываться', async (t) => {
  const { root, pm, chat } = await setup(t);
  const src = path.join(root, 'src.txt');
  const dest = path.join(root, 'archive', 'src.txt');
  await fs.writeFile(src, 'hello\n');

  pm.ingest(chat, [{ key: 'mv', text: '# &MOVE:src.txt -> archive/src.txt\n' }]);
  const item = (await pm.list(chat, true))[0];
  assert.equal(item.op, 'move');
  assert.equal(item.state, 'move');
  const view = await pm.view(item.id);
  assert.equal(view.toRelPath, 'archive/src.txt');
  const applied = await pm.apply(item.id, { baseHash: view.baseHash, contentHash: view.contentHash, createDirs: true });
  assert.equal(applied.ok, true, applied.error);
  await assert.rejects(fs.stat(src));
  assert.equal(await fs.readFile(dest, 'utf8'), 'hello\n');

  const reverted = await pm.historyRevert(applied.historyId, false);
  assert.equal(reverted.ok, true, reverted.error);
  assert.equal(await fs.readFile(src, 'utf8'), 'hello\n');
  await assert.rejects(fs.stat(dest));
});

test('proposals: MOVE не перезаписывает существующий файл назначения', async (t) => {
  const { root, pm, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
  await fs.mkdir(path.join(root, 'archive'));
  await fs.writeFile(path.join(root, 'archive', 'a.txt'), 'existing\n');
  pm.ingest(chat, [{ key: 'mv-existing', text: '# &MOVE:a.txt -> archive/a.txt\n' }]);
  const item = (await pm.list(chat, true))[0];
  assert.equal(item.state, 'exists');
  const view = await pm.view(item.id);
  const result = await pm.apply(item.id, { baseHash: view.baseHash, contentHash: view.contentHash, createDirs: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'state');
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'a\n');
});

// --- unified diff: то, чем заменяется копирование файлов целиком ---

test('toUnifiedDiff: правка одной строки в большом файле — компактный hunk', () => {
  const { toUnifiedDiff } = require('../src/diff');
  const old = Array.from({ length: 40 }, (_, i) => `s${i + 1}`).join('\n') + '\n';
  const next = old.replace('s20', 'S20');
  const d = toUnifiedDiff(old, next, { oldLabel: 'a/f.py', newLabel: 'b/f.py' });
  assert.match(d, /^--- a\/f\.py$/m);
  assert.match(d, /^\+\+\+ b\/f\.py$/m);
  assert.match(d, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  assert.match(d, /^-s20$/m);
  assert.match(d, /^\+S20$/m);
  assert.ok(d.length < old.length, 'diff короче файла');
  assert.ok(!d.includes('s1\n'), 'далёкие строки в diff не попадают');
});

test('toUnifiedDiff: идентичные тексты — пустая строка', () => {
  const { toUnifiedDiff } = require('../src/diff');
  assert.equal(toUnifiedDiff('a\nb\n', 'a\nb\n'), '');
});

test('toUnifiedDiff: две далёкие правки — два hunk\'а', () => {
  const { toUnifiedDiff } = require('../src/diff');
  const old = Array.from({ length: 40 }, (_, i) => `s${i + 1}`).join('\n') + '\n';
  const next = old.replace('s2', 'S2').replace('s38', 'S38');
  const d = toUnifiedDiff(old, next, { context: 2 });
  assert.equal(d.split('\n').filter((l) => l.startsWith('@@')).length, 2);
});

test('toUnifiedDiff: создание файла из пустого — заголовок по соглашению git', () => {
  const { toUnifiedDiff } = require('../src/diff');
  const d = toUnifiedDiff('', 'x\ny\n');
  assert.match(d, /^@@ -0,0 \+1,2 @@$/m);
});

test('toUnifiedDiff: удаление всего содержимого — нулевой счётчик новой стороны', () => {
  const { toUnifiedDiff } = require('../src/diff');
  const d = toUnifiedDiff('x\ny\n', '');
  assert.match(d, /^@@ -1,2 \+0,0 @@$/m);
});

test('toUnifiedDiff: результат принимает git apply', async (t) => {
  // Формат проверяется не «на глаз», а реальным инструментом
  const { execFileSync } = require('node:child_process');
  const { toUnifiedDiff } = require('../src/diff');
  let ok = true;
  try { execFileSync('git', ['--version']); } catch { ok = false; }
  if (!ok) { t.skip('git недоступен'); return; }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-udiff-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  execFileSync('git', ['-c', 'core.autocrlf=false', 'init', '-q', '.'], { cwd: dir });
  // Локальный core.autocrlf=true (дефолт Git for Windows) заставлял git apply писать
  // в f.txt CRLF, и проверка формата diff падала на ровном месте: тест обязан проверять
  // наш формат, а не настройки git разработчика. Отключаем преобразование и конфигом,
  // и атрибутом — двойная страховка.
  await fs.writeFile(path.join(dir, '.gitattributes'), '* -text\n');
  const old = Array.from({ length: 30 }, (_, i) => `s${i + 1}`).join('\n') + '\n';
  const next = old.replace('s3', 'S3') + 's31\n';
  await fs.writeFile(path.join(dir, 'f.txt'), old);
  const patch = 'diff --git a/f.txt b/f.txt\n' + toUnifiedDiff(old, next, { oldLabel: 'a/f.txt', newLabel: 'b/f.txt' });
  await fs.writeFile(path.join(dir, 'd.patch'), patch);
  execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', 'd.patch'], { cwd: dir });
  assert.equal(await fs.readFile(path.join(dir, 'f.txt'), 'utf8'), next);
});

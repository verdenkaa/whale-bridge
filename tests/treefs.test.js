'use strict';
// Операции пользователя над файлами из дерева (src/treefs.js, этап D):
// создание, переименование и удаление файлов и папок — с историей, резервными
// копиями, корзиной и переносом журналов контекста. Electron не нужен:
// корзина внедрена функцией trash, всё остальное — настоящие fs и Store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const fileops = require('../src/fileops');
const treefs = require('../src/treefs');
const Context = require('../src/context');
const { Store } = require('../src/store');
const { ProposalManager } = require('../src/proposals');

const CHAT = '17b45023-2aba-4a1a-a966-17bbe41926ea';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-tree-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-treed-'));
  const trashDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-treet-'));
  t.after(() => Promise.all([root, data, trashDir]
    .map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))));
  const store = new Store(data);
  await store.load();
  const project = await store.addProject(root);
  await store.bind(CHAT, project.id);
  const pm = new ProposalManager({ store });
  // Корзина как в main (shell.trashItem): переносим файл/папку в отдельную папку
  const trash = async (abs) => {
    const dest = path.join(trashDir, path.basename(abs) + '-' + Date.now());
    await fs.rename(abs, dest).catch(async () => {
      await fs.cp(abs, dest, { recursive: true });
      await fs.rm(abs, { recursive: true, force: true });
    });
  };
  const exists = async (rel) => {
    try { await fs.stat(path.join(root, rel)); return true; } catch { return false; }
  };
  const read = (rel) => fs.readFile(path.join(root, rel), 'utf8');
  return { root, data, trashDir, store, pm, project, chat: CHAT, trash, exists, read };
}

const lastHistory = (store) => store.history[store.history.length - 1];

// ---------- создание ----------

test('treefs: создание файла — пустой файл, запись в историю, откат работает', async (t) => {
  const { store, pm, project, chat, trash, exists, read } = await setup(t);

  const r = await treefs.createFile({ project, rel: 'notes.txt', store, chatId: chat });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rel, 'notes.txt');
  assert.equal(r.isDir, false);
  assert.equal(await read('notes.txt'), '', 'файл создан пустым');

  const h = lastHistory(store);
  assert.equal(h.op, 'create');
  assert.equal(h.relPath, 'notes.txt');
  assert.equal(h.source, 'manual', 'операция пользователя, не модели');
  assert.equal(h.status, 'applied');
  assert.equal(h.beforeHash, null);
  assert.ok(h.afterHash, 'хэш созданного файла записан');

  // созданный файл модель НЕ знает: отметка ставится только явным действием
  assert.equal(Context.knownVersion(store.contextKnown(), chat, project.id, 'notes.txt'), null);

  // откат из истории удаляет созданный файл
  const rev = await pm.historyRevert(h.id, false);
  assert.equal(rev.ok, true, JSON.stringify(rev));
  assert.equal(await exists('notes.txt'), false, 'откат создания удалил файл');
  void trash;
});

test('treefs: создание файла в несуществующей папке создаёт папки', async (t) => {
  const { store, project, chat, exists } = await setup(t);
  const r = await treefs.createFile({ project, rel: 'src/deep/app.py', store, chatId: chat });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rel, 'src/deep/app.py');
  assert.equal(await exists('src/deep/app.py'), true);
  assert.equal(lastHistory(store).op, 'create');
});

test('treefs: создание — занятый путь, выход за проект, запрещённые имена', async (t) => {
  const { root, store, project, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'x');

  const dup = await treefs.createFile({ project, rel: 'a.txt', store, chatId: chat });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'exists', 'перезапись существующего файла запрещена');

  for (const bad of ['../evil.txt', '/abs.txt', 'a/../../b.txt', 'con.txt', 'bad<>name.txt', '', '   ']) {
    const r = await treefs.createFile({ project, rel: bad, store, chatId: chat });
    assert.equal(r.ok, false, `путь «${bad}» обязан быть отклонён`);
    assert.equal(r.code, 'path', `путь «${bad}»: code=path`);
  }
  assert.equal((await treefs.createFile({ project: null, rel: 'x.txt', store, chatId: chat })).code, 'no-project');
});

test('treefs: создание папки (в том числе вложенной) и отказ на занятом пути', async (t) => {
  const { root, store, project, exists } = await setup(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'x');

  const r = await treefs.createDir({ project, rel: 'assets/tex' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isDir, true);
  assert.equal(await exists('assets/tex'), true);
  assert.equal(store.history.length, 0, 'пустая папка в историю не пишется');

  const dup = await treefs.createDir({ project, rel: 'assets/tex' });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'exists');
  const onFile = await treefs.createDir({ project, rel: 'a.txt' });
  assert.equal(onFile.ok, false, 'файл на месте папки — отказ');

  const escape = await treefs.createDir({ project, rel: '../outside' });
  assert.equal(escape.ok, false);
  assert.equal(escape.code, 'path');
});

// ---------- переименование ----------

test('treefs: переименование файла — история, содержимое, откат', async (t) => {
  const { root, store, pm, project, chat, exists, read } = await setup(t);
  await fs.writeFile(path.join(root, 'old.txt'), 'содержимое\n');

  const r = await treefs.renamePath({ project, rel: 'old.txt', newRel: 'sub/new.txt', store, chatId: chat });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isDir, false);
  assert.equal(r.newRel, 'sub/new.txt');
  assert.equal(await exists('old.txt'), false);
  assert.equal(await read('sub/new.txt'), 'содержимое\n', 'содержимое переехало без изменений');

  const h = lastHistory(store);
  assert.equal(h.op, 'move');
  assert.equal(h.relPath, 'old.txt');
  assert.equal(h.newRelPath, 'sub/new.txt');
  assert.equal(h.source, 'manual');
  assert.equal(h.beforeHash, h.afterHash, 'хэш содержимого не изменился');

  // откат возвращает прежнее имя
  const rev = await pm.historyRevert(h.id, false);
  assert.equal(rev.ok, true, JSON.stringify(rev));
  assert.equal(await exists('old.txt'), true, 'файл вернулся на старое место');
  assert.equal(await exists('sub/new.txt'), false);
});

test('treefs: переименование переносит журнал контекста и базовый снимок', async (t) => {
  const s = await setup(t);
  const { store, project, chat } = s;
  await fs.writeFile(path.join(s.root, 'a.py'), 'x = 1\n');
  await fs.mkdir(path.join(s.root, 'pkg'));
  await fs.writeFile(path.join(s.root, 'pkg', 'b.py'), 'y = 2\n');
  // модель знает оба файла
  const rec = (rel) => Context.record(store.contextKnown(), chat, {
    projectId: project.id, relPath: rel, hash: 'h-' + rel, source: 'ack',
  });
  rec('a.py');
  rec('pkg/b.py');
  await store.saveBaseline(chat, project.id, {
    capturedAt: Date.now(), truncated: false,
    files: { 'a.py': '6:1', 'pkg/b.py': '6:2', 'untouched.py': '1:1' },
  });

  const r1 = await treefs.renamePath({ project, rel: 'a.py', newRel: 'a2.py', store, chatId: chat });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(Context.knownVersion(store.contextKnown(), chat, project.id, 'a.py'), null, 'старый путь очищен');
  const moved = Context.knownVersion(store.contextKnown(), chat, project.id, 'a2.py');
  assert.ok(moved && moved.hash === 'h-a.py', 'знание переехало на новый путь');

  const base = await store.getBaseline(chat, project.id);
  assert.ok('a2.py' in base.files, 'базовый снимок тоже перенесён');
  assert.ok(!('a.py' in base.files));
  assert.ok('untouched.py' in base.files, 'остальные записи не тронуты');

  // папка: переезжают все вложенные записи
  const r2 = await treefs.renamePath({ project, rel: 'pkg', newRel: 'lib', store, chatId: chat });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.isDir, true);
  assert.ok(Context.knownVersion(store.contextKnown(), chat, project.id, 'lib/b.py'), 'вложенный файл перенесён');
  assert.equal(Context.knownVersion(store.contextKnown(), chat, project.id, 'pkg/b.py'), null);
  const base2 = await store.getBaseline(chat, project.id);
  assert.ok('lib/b.py' in base2.files);
  assert.ok(!('pkg/b.py' in base2.files));
});

test('treefs: переименование — занятый путь, отсутствующий источник, путь наружу', async (t) => {
  const { root, store, project, chat, read } = await setup(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'A');
  await fs.writeFile(path.join(root, 'b.txt'), 'B');

  const dup = await treefs.renamePath({ project, rel: 'a.txt', newRel: 'b.txt', store, chatId: chat });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'exists', 'перезапись существующего файла запрещена');
  assert.equal(await read('b.txt'), 'B', 'файл назначения не тронут');

  const missing = await treefs.renamePath({ project, rel: 'нет.txt', newRel: 'x.txt', store, chatId: chat });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'missing');

  const out = await treefs.renamePath({ project, rel: 'a.txt', newRel: '../../evil.txt', store, chatId: chat });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'path');

  const same = await treefs.renamePath({ project, rel: 'a.txt', newRel: 'a.txt', store, chatId: chat });
  assert.equal(same.ok, false, 'переименование в себя — не операция');
});

test('treefs: переименование папки переносит содержимое', async (t) => {
  const { root, store, project, chat, exists, read } = await setup(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.py'), 'x\n');
  await fs.mkdir(path.join(root, 'src', 'in'));
  await fs.writeFile(path.join(root, 'src', 'in', 'b.py'), 'y\n');

  const r = await treefs.renamePath({ project, rel: 'src', newRel: 'lib', store, chatId: chat });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await exists('src'), false);
  assert.equal(await read('lib/a.py'), 'x\n');
  assert.equal(await read('lib/in/b.py'), 'y\n');
  assert.equal(store.history.length, 0, 'переименование папки историю не пишет');

  const ontoFile = await treefs.renamePath({ project, rel: 'lib', newRel: 'lib/a.py', store, chatId: chat });
  assert.equal(ontoFile.ok, false, 'папка не может встать на место файла');
});

// ---------- удаление ----------

test('treefs: удаление файла — в корзину, с резервной копией и откатом', async (t) => {
  const { root, store, pm, project, chat, trash, trashDir, exists } = await setup(t);
  await fs.writeFile(path.join(root, 'doomed.txt'), 'прощай\n');

  const r = await treefs.deletePath({ project, rel: 'doomed.txt', store, chatId: chat, trash });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await exists('doomed.txt'), false);
  const trashed = await fs.readdir(trashDir);
  assert.equal(trashed.length, 1, 'файл уехал в корзину');
  assert.equal(await fs.readFile(path.join(trashDir, trashed[0]), 'utf8'), 'прощай\n');

  const h = lastHistory(store);
  assert.equal(h.op, 'delete');
  assert.equal(h.source, 'manual');
  assert.ok(h.beforeHash, 'хэш удалённого содержимого записан');
  assert.equal(h.afterHash, null);

  // откат восстанавливает содержимое из резервной копии (даже мимо корзины)
  const rev = await pm.historyRevert(h.id, false);
  assert.equal(rev.ok, true, JSON.stringify(rev));
  assert.equal(await fs.readFile(path.join(root, 'doomed.txt'), 'utf8'), 'прощай\n');
});

test('treefs: удаление папки — целиком в корзину, без истории', async (t) => {
  const { root, store, project, chat, trash, trashDir, exists } = await setup(t);
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'assets', 'a.png'), 'x');
  await fs.mkdir(path.join(root, 'assets', 'in'));
  await fs.writeFile(path.join(root, 'assets', 'in', 'b.txt'), 'y');

  const r = await treefs.deletePath({ project, rel: 'assets', store, chatId: chat, trash });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isDir, true);
  assert.equal(await exists('assets'), false);
  assert.equal(store.history.length, 0, 'удаление папки в историю не пишется');
  // содержимое корзины цело
  const trashed = path.join(trashDir, (await fs.readdir(trashDir))[0]);
  assert.equal(await fs.readFile(path.join(trashed, 'in', 'b.txt'), 'utf8'), 'y');
  assert.equal(await fs.readFile(path.join(trashed, 'a.png'), 'utf8'), 'x');
});

test('treefs: удаление без корзины запрещено; отсутствующий путь — ошибка', async (t) => {
  const { root, store, project, chat, exists } = await setup(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'x');

  const noTrash = await treefs.deletePath({ project, rel: 'a.txt', store, chatId: chat });
  assert.equal(noTrash.ok, false);
  assert.equal(noTrash.code, 'io', 'без trash-функции удаление не выполняется');
  assert.equal(await exists('a.txt'), true, 'файл цел');

  const missing = await treefs.deletePath({ project, rel: 'нет.txt', store, chatId: chat, trash: async () => {} });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'missing');

  const rootDel = await treefs.deletePath({ project, rel: '', store, chatId: chat, trash: async () => {} });
  assert.equal(rootDel.ok, false, 'корень проекта удалить нельзя');
  assert.equal(rootDel.code, 'path');
});

test('treefs: журнал знания удалённого файла остаётся — расхождение видно честно', async (t) => {
  const { root, store, pm, project, chat, trash } = await setup(t);
  await fs.writeFile(path.join(root, 'known.py'), 'x = 1\n');
  const hash = fileops.sha256(Buffer.from('x = 1\n', 'utf8'));
  Context.record(store.contextKnown(), chat, { projectId: project.id, relPath: 'known.py', hash, source: 'ack' });
  await store.saveContext();

  const r = await treefs.deletePath({ project, rel: 'known.py', store, chatId: chat, trash });
  assert.equal(r.ok, true);
  // запись журнала НЕ удалена: «модель знает версию файла, которого больше нет» —
  // это расхождение, и список расхождений обязан его показать
  assert.ok(Context.knownVersion(store.contextKnown(), chat, project.id, 'known.py'), 'запись журнала на месте');
  const { items } = await pm.listDivergences(chat, project.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].relPath, 'known.py');
  assert.equal(items[0].missing, true, 'файл помечен отсутствующим');
});

'use strict';
// «Что записано» против «что знает чат-бот»: отметка о версии файла, известной модели.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const fileops = require('../src/fileops');
const { Store } = require('../src/store');
const { ProposalManager } = require('../src/proposals');

const H = (s) => fileops.sha256(Buffer.from(s, 'utf8'));

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-ms-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-msd-'));
  t.after(() => Promise.all([root, data].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const store = new Store(data);
  await store.load();
  const project = await store.addProject(root);
  const chat = '17b45023-2aba-4a1a-a966-17bbe41926ea';
  await store.bind(chat, project.id);
  const pm = new ProposalManager({ store });
  return { root, data, store, project, chat, pm };
}

/** Применяет предложение модели и возвращает historyId. */
async function applyAi({ pm, chat, key, text, createDirs = false }) {
  pm.ingest(chat, [{ key, text }]);
  await pm.sealAiBase(chat);
  const item = (await pm.list(chat, true)).find((x) => x.status === 'pending');
  const v = await pm.view(item.id);
  const r = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash, createDirs });
  assert.equal(r.ok, true, r.error || JSON.stringify(r));
  return r.historyId;
}

const pendingView = async (pm, chat) => {
  const item = (await pm.list(chat, true)).find((x) => x.status === 'pending');
  return pm.view(item.id);
};

test('modelSynced: применённое предложение помечает версию как известную модели', async (t) => {
  const { root, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  assert.equal(store.getModelSynced(project.id, 'a.py'), null);

  await applyAi({ pm, chat, key: 'k', text: '# &a.py\nx = 2\n' });
  // содержимое получено от модели — значит, эта версия ей известна
  assert.equal(store.getModelSynced(project.id, 'a.py'), H('x = 2\n'));
  // и предупреждения «модель не знает» сразу после применения быть не должно
  pm.ingest(chat, [{ key: 'k2', text: '# &a.py\nx = 9\n' }]);
  assert.ok(!(await pendingView(pm, chat)).manualChanged);
});

test('modelSynced: правка вне приложения помечается, подтверждение снимает отметку', async (t) => {
  const { root, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  await applyAi({ pm, chat, key: 'k', text: '# &a.py\nx = 2\n' });

  // пользователь правит файл сам — модель об этом не знает
  await fs.writeFile(path.join(root, 'a.py'), 'x = 3\n');
  pm.ingest(chat, [{ key: 'k2', text: '# &a.py\nx = 4\n' }]);
  const warned = await pendingView(pm, chat);
  assert.equal(warned.manualChanged, true);
  assert.ok(warned.manualHistoryId, 'указано, от какой версии считается расхождение');
  const list1 = await pm.listManualChanges(project.id);
  assert.ok(list1.some((x) => x.relPath === 'a.py'));
  const view1 = await pm.manualView(project.id, 'a.py');
  assert.equal(view1.synced, false);

  // подтверждение: передали модели актуальную версию
  const ack = await pm.ackModelSynced(project.id, 'a.py');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal(ack.hash, H('x = 3\n'));
  assert.equal(store.getModelSynced(project.id, 'a.py'), H('x = 3\n'));

  assert.ok(!(await pendingView(pm, chat)).manualChanged);
  assert.ok(!(await pm.listManualChanges(project.id)).some((x) => x.relPath === 'a.py'));
  assert.equal((await pm.manualView(project.id, 'a.py')).synced, true);
});

test('modelSynced: отметка хранится как хэш, поэтому новое изменение возвращает её само', async (t) => {
  const { root, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  await applyAi({ pm, chat, key: 'k', text: '# &a.py\nx = 2\n' });

  await fs.writeFile(path.join(root, 'a.py'), 'x = 3\n');
  await pm.ackModelSynced(project.id, 'a.py');
  pm.ingest(chat, [{ key: 'k2', text: '# &a.py\nx = 4\n' }]);
  assert.ok(!(await pendingView(pm, chat)).manualChanged);

  // файл снова изменили — подтверждать «насовсем» нельзя, отметка снимается
  await fs.writeFile(path.join(root, 'a.py'), 'x = 5\n');
  const warned = await pendingView(pm, chat);
  assert.equal(warned.manualChanged, true);
  assert.notEqual(store.getModelSynced(project.id, 'a.py'), H('x = 5\n'));
});

test('modelSynced: пакетный запрос хэшей и игнорирование мусора', async (t) => {
  const { root, pm, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  await fs.writeFile(path.join(root, 'b.py'), 'y = 1\n');
  await pm.ackModelSynced(project.id, 'a.py');

  const got = pm.modelSyncedHashes(project.id, ['a.py', 'b.py', 'нет.py', 42, '']);
  assert.equal(got['a.py'], H('x = 1\n'));
  assert.equal(got['b.py'], null);
  assert.equal(got['нет.py'], null);
  assert.ok(!(42 in got));
  assert.ok(!('' in got));
  assert.deepEqual(pm.modelSyncedHashes(project.id, null), {});
});

test('modelSynced: ошибки подтверждения — проект, путь, отсутствующий файл', async (t) => {
  const { root, pm, project } = await setup(t);
  assert.equal((await pm.ackModelSynced('нет-такого', 'a.py')).ok, false);
  assert.match((await pm.ackModelSynced('нет-такого', 'a.py')).error, /Проект/);
  assert.equal((await pm.ackModelSynced(project.id, '../evil.py')).ok, false);
  assert.equal((await pm.ackModelSynced(project.id, 'нет.py')).ok, false);
  assert.match((await pm.ackModelSynced(project.id, 'нет.py')).error, /не найден/i);

  // не-UTF-8 подтвердить нельзя: хэш есть, но передать содержимое модели не получится
  await fs.writeFile(path.join(root, 'legacy.py'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]));
  const r = await pm.ackModelSynced(project.id, 'legacy.py');
  assert.equal(r.ok, false);
  assert.match(r.error, /UTF-8/);
});

test('modelSynced: отметка переживает перезапуск и удаляется вместе с проектом', async (t) => {
  const { root, data, store, pm, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  await pm.ackModelSynced(project.id, 'a.py');

  const reloaded = new Store(data);
  await reloaded.load();
  assert.equal(reloaded.getModelSynced(project.id, 'a.py'), H('x = 1\n'));
  assert.deepEqual(reloaded.modelSyncedMap(project.id), { 'a.py': H('x = 1\n') });

  // чистка одного пути
  await reloaded.clearModelSynced(project.id, 'a.py');
  assert.equal(reloaded.getModelSynced(project.id, 'a.py'), null);
  await reloaded.clearModelSynced(project.id, 'a.py'); // повтор не ошибка

  // удаление проекта убирает и его отметки
  await pm.ackModelSynced(project.id, 'a.py');
  assert.equal(store.getModelSynced(project.id, 'a.py'), H('x = 1\n'));
  await store.removeProject(project.id);
  assert.deepEqual(store.modelSyncedMap(project.id), {});
});

test('modelSynced: move помечает новый путь, а не старый', async (t) => {
  const { root, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'old.txt'), 'data\n');
  pm.ingest(chat, [{ key: 'm', text: '# &MOVE:old.txt -> sub/new.txt\n' }]);
  const mv = (await pm.list(chat, true)).find((x) => x.op === 'move' && x.status === 'pending');
  const v = await pm.view(mv.id);
  const r = await pm.apply(mv.id, { baseHash: v.baseHash, contentHash: v.contentHash, createDirs: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(store.getModelSynced(project.id, 'sub/new.txt'), H('data\n'));
  assert.equal(store.getModelSynced(project.id, 'old.txt'), null);
});

'use strict';
// Откат как операция журнала (ТЗ §10): source 'rollback', неоткатимость, лимит записей,
// и отсутствие ложного «изменён вручную» после отката.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const fileops = require('../src/fileops');
const { Store, ROLLBACK_RECORD_LIMIT } = require('../src/store');
const { ProposalManager } = require('../src/proposals');
const { ABSENT } = require('../src/versions');

const H = (s) => fileops.sha256(Buffer.from(s, 'utf8'));

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-rb-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-rbd-'));
  const trashDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-rbt-'));
  t.after(() => Promise.all([root, data, trashDir].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const store = new Store(data);
  await store.load();
  const project = await store.addProject(root);
  const chat = '17b45023-2aba-4a1a-a966-17bbe41926ea';
  await store.bind(chat, project.id);
  const pm = new ProposalManager({ store });
  pm.trash = async (abs) => fs.rename(abs, path.join(trashDir, path.basename(abs)));
  return { root, data, trashDir, store, project, chat, pm };
}

/** Проводит предложение от ingest до apply и возвращает historyId. */
async function applyText({ pm, chat, key, text, createDirs = false }) {
  pm.ingest(chat, [{ key, text }]);
  const item = (await pm.list(chat, true)).find((x) => x.status === 'pending');
  const v = await pm.view(item.id);
  const r = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash, createDirs });
  assert.equal(r.ok, true, r.error || JSON.stringify(r));
  return r.historyId;
}

const rollbacks = (store) => store.history.filter((h) => h.source === 'rollback');
const backupFiles = (data) => fs.readdir(path.join(data, 'backups'));

test('rollback: запись в журнале есть, файлов копии нет, хэши верные', async (t) => {
  const { root, data, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'v0\n');
  const filesBefore = (await backupFiles(data)).length;

  const id = await applyText({ pm, chat, key: 'k', text: '# &a.py\nv1\n' });
  const filesAfterApply = (await backupFiles(data)).length;
  assert.equal(filesAfterApply - filesBefore, 2); // before + after

  const res = await pm.historyRevert(id, false);
  assert.equal(res.ok, true, res.error);
  assert.equal(await fs.readFile(path.join(root, 'a.py'), 'utf8'), 'v0\n');

  // откат не должен плодить файлы копии
  assert.equal((await backupFiles(data)).length, filesAfterApply);

  const [rb] = rollbacks(store);
  assert.ok(rb, 'запись об откате добавлена');
  assert.equal(rb.source, 'rollback');
  assert.equal(rb.status, 'applied');
  assert.equal(rb.revertible, false);
  assert.equal(rb.pruned, true);
  assert.equal(rb.revertedHistoryId, id);
  assert.equal(rb.beforeHash, H('v1\n')); // что было до отката
  assert.equal(rb.afterHash, H('v0\n')); // что стало после
  assert.equal(rb.relPath, 'a.py');
  assert.equal(rb.op, 'update');
  assert.equal(rb.projectId, project.id);

  // исходная операция помечена откаченной
  assert.equal(store.getHistory(id).status, 'reverted');
});

test('rollback: откат неоткатим — ни силой, ни через обычный путь', async (t) => {
  const { root, store, pm, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'v0\n');
  const id = await applyText({ pm, chat, key: 'k', text: '# &a.py\nv1\n' });
  await pm.historyRevert(id, false);
  const rb = rollbacks(store)[0];

  const again = await pm.historyRevert(rb.id, false);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'not-revertible');
  assert.match(again.error, /нельзя|неоткатим|повторно/i);
  // и с force тоже: дело не в отсутствии копии, а в самом правиле
  assert.equal((await pm.historyRevert(rb.id, true)).code, 'not-revertible');
  // файл не тронут
  assert.equal(await fs.readFile(path.join(root, 'a.py'), 'utf8'), 'v0\n');
  // новая запись об откате не появилась
  assert.equal(rollbacks(store).length, 1);
});

test(`rollback: на файл хранится не больше ${ROLLBACK_RECORD_LIMIT} записей об откате`, async (t) => {
  const { root, store, pm, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'v0\n');

  const ids = [];
  for (let i = 1; i <= 3; i++) {
    ids.push(await applyText({ pm, chat, key: 'k' + i, text: `# &a.py\nv${i}\n` }));
    assert.equal((await pm.historyRevert(ids[i - 1], false)).ok, true);
  }

  const rb = rollbacks(store);
  assert.equal(ROLLBACK_RECORD_LIMIT, 2);
  assert.equal(rb.length, ROLLBACK_RECORD_LIMIT);
  // удалена самая СТАРАЯ запись: остались откаты двух последних операций
  assert.deepEqual(rb.map((h) => h.revertedHistoryId).sort(), ids.slice(1).sort());
  assert.ok(!store.history.some((h) => h.revertedHistoryId === ids[0]), 'самая старая запись об откате удалена');
  // все оставшиеся — неоткатимы
  assert.ok(rb.every((h) => h.revertible === false));
  // журнал остальных операций не пострадал
  assert.equal(store.history.filter((h) => h.source === 'ai').length, 3);
});

test('rollback: откат создания удаляет файл, откат удаления возвращает его', async (t) => {
  const { root, store, pm, chat } = await setup(t);

  // создание → откат
  const createdId = await applyText({ pm, chat, key: 'n', text: '# &NEW:scripts/w.gd\nextends Node\n', createDirs: true });
  assert.equal(await fs.readFile(path.join(root, 'scripts', 'w.gd'), 'utf8'), 'extends Node\n');
  assert.equal((await pm.historyRevert(createdId, false)).ok, true);
  await assert.rejects(fs.stat(path.join(root, 'scripts', 'w.gd')));
  const rbCreate = rollbacks(store).find((h) => h.op === 'create');
  assert.equal(rbCreate.beforeHash, H('extends Node\n'));
  assert.equal(rbCreate.afterHash, ABSENT); // файла больше нет — и это отличимо от «не известно»

  // удаление → откат
  await fs.writeFile(path.join(root, 'old.txt'), 'line 1\nline 2\n');
  pm.ingest(chat, [{ key: 'd', text: '# &DELETE:old.txt\n' }]);
  const del = (await pm.list(chat, true)).find((x) => x.op === 'delete' && x.status === 'pending');
  const dv = await pm.view(del.id);
  const delRes = await pm.apply(del.id, { baseHash: dv.baseHash, contentHash: dv.contentHash });
  assert.equal(delRes.ok, true, delRes.error);
  await assert.rejects(fs.stat(path.join(root, 'old.txt')));

  assert.equal((await pm.historyRevert(delRes.historyId, false)).ok, true);
  assert.equal(await fs.readFile(path.join(root, 'old.txt'), 'utf8'), 'line 1\nline 2\n');
  const rbDelete = rollbacks(store).find((h) => h.op === 'delete');
  assert.equal(rbDelete.beforeHash, ABSENT);
  assert.equal(rbDelete.afterHash, H('line 1\nline 2\n'));
});

test('rollback: откат перемещения возвращает файл на старое место', async (t) => {
  const { root, store, pm, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'old.txt'), 'data\n');
  pm.ingest(chat, [{ key: 'm', text: '# &MOVE:old.txt -> archive/new.txt\n' }]);
  const mv = (await pm.list(chat, true)).find((x) => x.op === 'move' && x.status === 'pending');
  const v = await pm.view(mv.id);
  const r = await pm.apply(mv.id, { baseHash: v.baseHash, contentHash: v.contentHash, createDirs: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(await fs.readFile(path.join(root, 'archive', 'new.txt'), 'utf8'), 'data\n');

  assert.equal((await pm.historyRevert(r.historyId, false)).ok, true);
  assert.equal(await fs.readFile(path.join(root, 'old.txt'), 'utf8'), 'data\n');
  await assert.rejects(fs.stat(path.join(root, 'archive', 'new.txt')));

  const rb = rollbacks(store).find((h) => h.op === 'move');
  assert.equal(rb.beforeHash, H('data\n')); // до отката файл жил по новому пути
  assert.equal(rb.afterHash, H('data\n')); // после — по старому, содержимое то же
  assert.equal(rb.newRelPath, 'archive/new.txt');
});

test('rollback: нет ложного «изменён вручную» после принудительного отката старой операции', async (t) => {
  const { root, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'v0\n');
  const idA = await applyText({ pm, chat, key: 'a', text: '# &a.py\nv1\n' });
  const idB = await applyText({ pm, chat, key: 'b', text: '# &a.py\nv2\n' });
  assert.equal(await fs.readFile(path.join(root, 'a.py'), 'utf8'), 'v2\n');

  // откатываем СТАРУЮ операцию: диск расходится с её afterHash, без force нельзя
  assert.equal((await pm.historyRevert(idA, false)).code, 'conflict');
  assert.equal((await pm.historyRevert(idA, true)).ok, true);
  assert.equal(await fs.readFile(path.join(root, 'a.py'), 'utf8'), 'v0\n');

  // Операция B осталась applied с afterHash от v2 — без записи об откате именно она
  // попала бы в _manualBase как «последняя операция» и дала ложный manualChanged.
  const b = store.getHistory(idB);
  assert.equal(b.status, 'applied');
  assert.equal(b.afterHash, H('v2\n'));
  assert.notEqual(b.afterHash, H('v0\n'));

  pm.ingest(chat, [{ key: 'c', text: '# &a.py\nv3\n' }]);
  const pending = (await pm.list(chat, true)).find((x) => x.status === 'pending');
  const ev = await pm.view(pending.id);
  // evaluate() выставляет manualChanged только когда оно истинно — иначе ключа нет
  assert.ok(!ev.manualChanged, 'файл не менялся вручную — его откатили');

  // а вот реальное внешнее изменение после отката определяется честно
  await fs.writeFile(path.join(root, 'a.py'), 'vX\n');
  const ev2 = await pm.view((await pm.list(chat, true)).find((x) => x.status === 'pending').id);
  assert.equal(ev2.manualChanged, true);

  // точка отсчёта — запись об откате, копии у неё нет: объясняем это вместо пустого экрана
  const mv = await pm.manualView(project.id, 'a.py');
  assert.equal(mv.hashOnly, true);
  assert.match(mv.error, /откат/i);
  // и не роняем список «мои правки»: построить сравнение нечем, файла в списке нет
  const manual = await pm.listManualChanges(project.id);
  assert.ok(!manual.some((x) => x.relPath === 'a.py'));
});

test('rollback: откат не мешает обычному лимиту копий и не занимает его место', async (t) => {
  const { root, data, store, pm, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'v0\n');
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    ids.push(await applyText({ pm, chat, key: 'k' + i, text: `# &a.txt\nv${i}\n` }));
    await pm.historyRevert(ids[i - 1], false);
  }
  // копии считаются только по настоящим операциям: 2 последних на файл
  const withBackups = store.history.filter((h) => h.source === 'ai' && !h.pruned);
  assert.equal(withBackups.length, 2);
  const files = await backupFiles(data);
  assert.equal(files.length, 4); // 2 операции × (before + after)
  assert.ok(files.every((f) => !f.includes(rollbacks(store)[0].id)), 'у записей об откате копий нет');
  // лимит записей об откате соблюдён
  assert.equal(rollbacks(store).length, ROLLBACK_RECORD_LIMIT);
  assert.ok(store.history.every((h) => h.source === 'ai' || h.source === 'rollback'));
});

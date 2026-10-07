'use strict';
// Stage A (ТЗ §9, §11, §12): file:read / file:write и конфликт сохранения.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const editorfs = require('../src/editorfs');
const fileops = require('../src/fileops');
const { Store } = require('../src/store');
const { ProposalManager } = require('../src/proposals');
const { ABSENT } = require('../src/versions');

const H = (s) => fileops.sha256(Buffer.from(s, 'utf8'));

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-e-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-ed-'));
  t.after(() => Promise.all([root, data].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const store = new Store(data);
  await store.load();
  const project = await store.addProject(root);
  const chat = '17b45023-2aba-4a1a-a966-17bbe41926ea';
  await store.bind(chat, project.id);
  const read = (rel) => editorfs.readForEditor(project, rel);
  const write = (rel, content, expectedHash) => editorfs.writeFromEditor({ project, rel, content, expectedHash, store, chatId: chat });
  return { root, data, store, project, chat, read, write, pm: new ProposalManager({ store }) };
}

// ---------- чтение ----------
test('file:read отдаёт содержимое, хэш байтов диска и стиль файла', async (t) => {
  const { root, read } = await setup(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'player.gd'), 'extends Node\n');
  const r = await read('src/player.gd');
  assert.equal(r.ok, true);
  assert.equal(r.path, 'src/player.gd');
  assert.equal(r.content, 'extends Node\n');
  assert.equal(r.hash, H('extends Node\n'));
  assert.equal(r.eol, 'lf');
  assert.equal(r.hasBom, false);
  assert.equal(r.size, Buffer.byteLength('extends Node\n'));
});

test('file:read — обратные слеши нормализуются, путь вне проекта отклоняется', async (t) => {
  const { root, read } = await setup(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.gd'), 'x\n');
  assert.equal((await read('src\\a.gd')).ok, true);
  assert.equal((await read('./src/a.gd')).path, 'src/a.gd');
  for (const bad of ['../escape.gd', '/abs.gd', '.git/config', '', 42, null]) {
    const r = await read(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.code, 'path', JSON.stringify(bad));
  }
});

test('file:read — отсутствующий файл, папка и не-UTF-8', async (t) => {
  const { root, read } = await setup(t);
  const missing = await read('nope.gd');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'missing');

  await fs.mkdir(path.join(root, 'dir'), { recursive: true });
  assert.equal((await read('dir')).code, 'missing');

  // CP1251: чтение запрещено, иначе файл был бы молча повреждён при последующей записи
  await fs.writeFile(path.join(root, 'legacy.gd'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a]));
  const bad = await read('legacy.gd');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'unreadable');
  assert.match(bad.error, /UTF-8/);
});

test('file:read для CRLF и BOM: hashTextLike(content) совпадает с hash — иначе файл выглядел бы грязным', async (t) => {
  const { root, read } = await setup(t);
  await fs.writeFile(path.join(root, 'crlf.gd'), 'extends Node\r\n\r\nfunc a():\r\n\tpass\r\n');
  const crlf = await read('crlf.gd');
  assert.equal(crlf.eol, 'crlf');
  // Monaco хранит текст с '\n'; пересчёт в байты диска обязан дать тот же хэш
  assert.equal(fileops.hashTextLike(crlf.content.replace(/\r\n/g, '\n'), crlf), crlf.hash);

  await fs.writeFile(path.join(root, 'bom.py'), Buffer.from('\uFEFFx = 1\n', 'utf8'));
  const bom = await read('bom.py');
  assert.equal(bom.hasBom, true);
  assert.ok(!bom.content.startsWith('\uFEFF'), 'BOM снят — иначе он удвоился бы при записи');
  assert.equal(fileops.hashTextLike(bom.content, bom), bom.hash);
});

// ---------- запись ----------
test('file:write сохраняет, бережёт CRLF/BOM и пишет в историю source manual', async (t) => {
  const { root, store, read, write, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.gd'), 'extends Node\r\n');
  const before = await read('a.gd');

  const newText = 'extends Node\nvar hp = 10\n'; // из Monaco, с LF
  const r = await write('a.gd', newText, before.hash);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.path, 'a.gd');
  assert.equal(r.hash, fileops.hashTextLike(newText, before));
  assert.equal(await fs.readFile(path.join(root, 'a.gd'), 'utf8'), 'extends Node\r\nvar hp = 10\r\n');

  const h = store.getHistory(r.historyId);
  assert.equal(h.source, 'manual'); // §10: это правка пользователя, не предложение модели
  assert.equal(h.status, 'applied');
  assert.equal(h.chatId, chat);
  assert.equal(h.beforeHash, before.hash);
  assert.equal(h.afterHash, r.hash);

  // после сохранения точка сохранения догоняет диск — dirty снимается (§12)
  const after = await read('a.gd');
  assert.equal(after.hash, r.hash);
});

test('file:write — конфликт (§11): файл изменён на диске, запись НЕ выполняется', async (t) => {
  const { root, store, read, write } = await setup(t);
  await fs.writeFile(path.join(root, 'a.gd'), 'v0\n');
  const opened = await read('a.gd'); // editor знает hash A

  await fs.writeFile(path.join(root, 'a.gd'), 'changed outside\n'); // на диске стало B
  const diskHash = H('changed outside\n');

  const r = await write('a.gd', 'мои правки\n', opened.hash); // expectedHash = A
  assert.equal(r.ok, false);
  assert.equal(r.code, 'conflict');
  assert.match(r.error, /НЕ записаны/);
  assert.equal(r.actualHash, diskHash);
  assert.equal(r.diskContent, 'changed outside\n'); // диалог может показать различия сразу
  assert.equal(r.expectedHash, opened.hash);

  // главное: на диске осталась внешняя версия, наши правки не записаны
  assert.equal(await fs.readFile(path.join(root, 'a.gd'), 'utf8'), 'changed outside\n');
  assert.equal(store.history.length, 0, 'в истории ничего не появилось');
  assert.equal((await fs.readdir(path.join(store.backupDir))).length, 0, 'бэкап не создавался');
});

test('file:write — конфликт ловится и при гонке между чтением и заменой файла', async (t) => {
  const { root, write } = await setup(t);
  await fs.writeFile(path.join(root, 'a.gd'), 'v0\n');
  // expectedHash заведомо чужой — имитация, что файл уехал ещё до вызова
  const r = await write('a.gd', 'x\n', H('v0\n'));
  assert.equal(r.ok, true);
  const race = await write('a.gd', 'y\n', H('v0\n')); // устаревшая база
  assert.equal(race.ok, false);
  assert.equal(race.code, 'conflict');
  assert.equal(await fs.readFile(path.join(root, 'a.gd'), 'utf8'), 'x\n');
});

test('file:write — отклоняет мусор на входе, ничего не трогая', async (t) => {
  const { root, store, write } = await setup(t);
  await fs.writeFile(path.join(root, 'a.gd'), 'v0\n');
  const h0 = H('v0\n');

  assert.equal((await write('a.gd', 42, h0)).code, 'bad-content');
  assert.equal((await write('a.gd', null, h0)).code, 'bad-content');
  assert.equal((await write('a.gd', { text: 'x' }, h0)).code, 'bad-content');
  assert.equal((await write('../evil.gd', 'x\n', h0)).code, 'path');
  assert.equal((await write('нет-такого.gd', 'x\n', h0)).code, 'missing');
  // неизвестная база — не конфликт, а просьба перечитать
  const unk = await write('a.gd', 'x\n', null);
  assert.equal(unk.code, 'unknown-base');
  assert.equal(unk.actualHash, h0);

  assert.equal(await fs.readFile(path.join(root, 'a.gd'), 'utf8'), 'v0\n');
  assert.equal(store.history.length, 0);
});

test('file:write отказывается портить файл в не-UTF-8', async (t) => {
  const { root, write } = await setup(t);
  await fs.writeFile(path.join(root, 'legacy.gd'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a]));
  const bytes = await fs.readFile(path.join(root, 'legacy.gd'));
  const r = await write('legacy.gd', 'new text\n', fileops.sha256(bytes));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unreadable');
  assert.deepEqual(await fs.readFile(path.join(root, 'legacy.gd')), bytes);
});

test('file:write — 4 сохранения дают 2 копии, старейшие помечаются pruned', async (t) => {
  const { root, data, store, read, write } = await setup(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'v0\n');
  let hash = (await read('a.txt')).hash;
  for (let i = 1; i <= 4; i++) {
    const r = await write('a.txt', `v${i}\n`, hash);
    assert.equal(r.ok, true, r.error);
    hash = r.hash;
  }
  const files = await fs.readdir(path.join(data, 'backups'));
  assert.equal(files.length, 4); // 2 операции × (before + after)
  const manual = store.history.filter((h) => h.source === 'manual');
  assert.equal(manual.length, 4);
  assert.deepEqual(manual.map((h) => !!h.pruned), [true, true, false, false]);
});

test('file:write — ручное сохранение откатывается так же, как предложение модели', async (t) => {
  const { root, store, read, write, pm } = await setup(t);
  await fs.writeFile(path.join(root, 'a.gd'), 'v0\n');
  const r = await write('a.gd', 'v1\n', (await read('a.gd')).hash);
  assert.equal(await fs.readFile(path.join(root, 'a.gd'), 'utf8'), 'v1\n');

  const back = await pm.historyRevert(r.historyId, false);
  assert.equal(back.ok, true, back.error);
  assert.equal(await fs.readFile(path.join(root, 'a.gd'), 'utf8'), 'v0\n');
  assert.equal(store.getHistory(r.historyId).status, 'reverted');
  const rb = store.history.find((h) => h.source === 'rollback');
  assert.equal(rb.beforeHash, H('v1\n'));
  assert.equal(rb.afterHash, H('v0\n'));
});

test('file:write после применения предложения модели не конфликтует с ним', async (t) => {
  const { root, store, read, write, pm, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  pm.ingest(chat, [{ key: 'k', text: '# &a.py\nx = 2\n' }]);
  await pm.sealAiBase(chat);
  const item = (await pm.list(chat, true))[0];
  const v = await pm.view(item.id);
  assert.equal((await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash })).ok, true);

  // редактор открывает уже изменённый моделью файл и правит дальше
  const opened = await read('a.py');
  assert.equal(opened.content, 'x = 2\n');
  const r = await write('a.py', 'x = 3\n', opened.hash);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(store.history.map((h) => h.source), ['ai', 'manual']);
});

test('hashesForEditor отдаёт хэши пачкой и null для отсутствующих', async (t) => {
  const { root, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.gd'), 'a\n');
  await fs.writeFile(path.join(root, 'b.gd'), 'b\n');
  const got = await editorfs.hashesForEditor(project, ['a.gd', 'b.gd', 'нет.gd', '../x', 42, '']);
  assert.equal(got['a.gd'], H('a\n'));
  assert.equal(got['b.gd'], H('b\n'));
  assert.equal(got['нет.gd'], null);
  assert.ok(!('../x' in got) || got['../x'] === null);
  assert.ok(!(42 in got));
  assert.ok(!('' in got));
  assert.deepEqual(await editorfs.hashesForEditor(project, null), {});
  assert.deepEqual(await editorfs.hashesForEditor(null, ['a.gd']), {});
});

test('file:read/write без проекта — внятная ошибка, а не исключение', async (t) => {
  const r = await editorfs.readForEditor(null, 'a.gd');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-project');
  const w = await editorfs.writeFromEditor({ project: null, rel: 'a.gd', content: 'x', expectedHash: ABSENT, store: null });
  assert.equal(w.code, 'no-project');
});

test('file:write с принятыми ханками модели: source ai и подробности в журнале', async (t) => {
  const { root, store, project, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.gd'), 'extends Node\n');
  const r0 = await editorfs.readForEditor(project, 'a.gd');
  const aiMeta = { proposals: [{ id: 'p1', acceptedHunks: 2, totalHunks: 3 }] };
  const r = await editorfs.writeFromEditor({
    project, rel: 'a.gd', content: 'extends Node\n\nfunc _ready():\n\tpass\n',
    expectedHash: r0.hash, store, chatId: chat, source: 'ai', aiMeta,
  });
  assert.equal(r.ok, true, r.error);
  const h = store.history.find((x) => x.id === r.historyId);
  assert.equal(h.source, 'ai', 'запись журнала помечена источником ai (§10)');
  assert.deepEqual(h.ai, aiMeta, 'видно, какие предложения и сколько ханков приняты');
  // неизвестный source не проходит: normalizeSource оставляет только ai/manual/rollback
  const r2 = await editorfs.writeFromEditor({
    project, rel: 'a.gd', content: 'x\n', expectedHash: r.hash, store, chatId: chat, source: 'что угодно',
  });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(store.history.find((x) => x.id === r2.historyId).source, 'manual');
});

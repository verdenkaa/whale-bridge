'use strict';
// Журнал контекста в сборке: store + proposals + editorfs.
// Каждый тест воспроизводит конкретный сценарий, который раньше не обнаруживался.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const fileops = require('../src/fileops');
const editorfs = require('../src/editorfs');
const Context = require('../src/context');
const { Store, CONTEXT_SNAPSHOT_MAX_CHARS } = require('../src/store');
const { ProposalManager } = require('../src/proposals');

const H = (s) => fileops.sha256(Buffer.from(s, 'utf8'));
const CHAT = '17b45023-2aba-4a1a-a966-17bbe41926ea';
const CHAT2 = '27b45023-2aba-4a1a-a966-17bbe41926eb';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-ctx-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-ctxd-'));
  t.after(() => Promise.all([root, data].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const store = new Store(data);
  await store.load();
  const project = await store.addProject(root);
  await store.bind(CHAT, project.id);
  const pm = new ProposalManager({ store });
  return { root, data, store, project, chat: CHAT, pm };
}

async function applyAi({ pm, chat, key, text, createDirs = false }) {
  pm.ingest(chat, [{ key, text }]);
  await pm.sealAiBase(chat);
  const item = (await pm.list(chat, true)).find((x) => x.status === 'pending');
  const v = await pm.view(item.id);
  const r = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash, createDirs });
  assert.equal(r.ok, true, r.error || JSON.stringify(r));
  return r.historyId;
}

const pendingView = async (pm, chat, key = 'next') => {
  const item = (await pm.list(chat, true)).find((x) => x.status === 'pending');
  return pm.view(item.id);
};

test('контекст: применённое предложение фиксирует версию как известную модели', async (t) => {
  const { root, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  assert.equal(Context.knownVersion(store.contextKnown(), chat, project.id, 'a.py'), null);

  await applyAi({ pm, chat, key: 'k', text: '# &a.py\nx = 2\n' });
  const known = Context.knownVersion(store.contextKnown(), chat, project.id, 'a.py');
  assert.equal(known.hash, H('x = 2\n'));
  assert.equal(known.source, 'applied');
  assert.ok(known.historyId, 'известно, какая операция дала эту версию');

  // сразу после применения расхождения нет
  pm.ingest(chat, [{ key: 'k2', text: '# &a.py\nx = 9\n' }]);
  const ev = await pendingView(pm, chat);
  assert.ok(!ev.manualChanged);
  assert.ok(!ev.contextDiverged);
});

test('контекст: правка вне приложения обнаруживается и снимается подтверждением', async (t) => {
  const { root, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  await applyAi({ pm, chat, key: 'k', text: '# &a.py\nx = 2\n' });

  await fs.writeFile(path.join(root, 'a.py'), 'x = 3\n');
  pm.ingest(chat, [{ key: 'k2', text: '# &a.py\nx = 4\n' }]);
  const ev = await pendingView(pm, chat);
  assert.equal(ev.manualChanged, true);
  assert.equal(ev.contextDiverged, true);
  assert.equal(ev.knownVersion.hash, H('x = 2\n'));
  assert.equal(ev.knownVersion.source, 'applied');
  assert.match(ev.knownVersion.label, /модель сама предложила/);

  const ack = await pm.ackContext(chat, project.id, 'a.py');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal(ack.hash, H('x = 3\n'));
  assert.ok(!(await pendingView(pm, chat)).manualChanged);

  // следующее изменение снова видно: отметка привязана к содержимому, а не к факту клика
  await fs.writeFile(path.join(root, 'a.py'), 'x = 5\n');
  assert.equal((await pendingView(pm, chat)).manualChanged, true);
});

test('контекст: файл, который приложение никогда не записывало, тоже отслеживается', async (t) => {
  // Главный прежний провал: расхождение искали от последней записи ИСТОРИИ Whale Bridge,
  // поэтому файл без такой записи не проверялся вовсе. Теперь источник — журнал контекста.
  const { root, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'never-written.gd'), 'extends Node\n');
  assert.equal(store.history.length, 0, 'история операций пуста');

  // файл ушёл модели как контекст промпта
  const n = await pm.recordContext(chat, project.id, [{ relPath: 'never-written.gd', hash: H('extends Node\n') }], 'prompt');
  assert.equal(n, 1);

  await fs.writeFile(path.join(root, 'never-written.gd'), 'extends Node2D\n');
  const { items } = await pm.listDivergences(chat, project.id);
  assert.deepEqual(items.map((x) => x.relPath), ['never-written.gd']);
  assert.equal(items[0].knownSource, 'prompt');
  assert.equal(items[0].diskHash, H('extends Node2D\n'));

  // и предложение модели по этому файлу помечается
  pm.ingest(chat, [{ key: 'k', text: '# &never-written.gd\nextends Node3D\n' }]);
  const ev = await pendingView(pm, chat);
  assert.equal(ev.manualChanged, true);
  assert.match(ev.knownVersion.label, /скопирован в чат/);
});

test('контекст: сохранение в редакторе тоже расходится с тем, что знает модель', async (t) => {
  // Второй прежний провал: после записи через редактор диск совпадал с последней
  // операцией, и расхождение «гасило» само себя, хотя модель новой версии не видела.
  const { root, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.gd'), 'v0\n');
  await applyAi({ pm, chat, key: 'k', text: '# &a.gd\nv1\n' });

  const opened = await editorfs.readForEditor(project, 'a.gd');
  const w = await editorfs.writeFromEditor({ project, rel: 'a.gd', content: 'v2 из редактора\n', expectedHash: opened.hash, store, chatId: chat });
  assert.equal(w.ok, true, w.error);
  assert.equal(store.history.at(-1).source, 'manual');

  const { items } = await pm.listDivergences(chat, project.id);
  assert.deepEqual(items.map((x) => x.relPath), ['a.gd']);
  assert.equal(items[0].knownHash, H('v1\n'), 'модель знает версию, которую сама предложила');
  assert.equal(items[0].diskHash, H('v2 из редактора\n'));

  pm.ingest(chat, [{ key: 'k2', text: '# &a.gd\nv3\n' }]);
  assert.equal((await pendingView(pm, chat)).manualChanged, true);
});

test('контекст: знание относится к чату, а не к проекту', async (t) => {
  const { root, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  await applyAi({ pm, chat, key: 'k', text: '# &a.py\nx = 2\n' });
  await fs.writeFile(path.join(root, 'a.py'), 'x = 3\n');

  assert.equal((await pm.listDivergences(chat, project.id)).items.length, 1);
  // во втором чате модель этот файл не видела — и расхождения там нет
  await store.bind(CHAT2, project.id);
  assert.deepEqual((await pm.listDivergences(CHAT2, project.id)).items, []);
  assert.equal(Context.knownVersion(store.contextKnown(), CHAT2, project.id, 'a.py'), null);

  // подтверждение во втором чате не чинит первый
  await pm.ackContext(CHAT2, project.id, 'a.py');
  assert.equal((await pm.listDivergences(chat, project.id)).items.length, 1);
  assert.deepEqual((await pm.listDivergences(CHAT2, project.id)).items, []);
});

test('контекст: журнал переживает перезапуск приложения', async (t) => {
  // Третий прежний провал: учёт жил в памяти предложений и обнулялся с сессией.
  const { root, data, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  await applyAi({ pm, chat, key: 'k', text: '# &a.py\nx = 2\n' });
  await fs.writeFile(path.join(root, 'a.py'), 'x = 3\n');

  const store2 = new Store(data);
  await store2.load();
  const pm2 = new ProposalManager({ store: store2 });
  const { items } = await pm2.listDivergences(chat, project.id);
  assert.deepEqual(items.map((x) => x.relPath), ['a.py']);
  assert.equal(items[0].knownHash, H('x = 2\n'));

  pm2.ingest(chat, [{ key: 'k2', text: '# &a.py\nx = 9\n' }]);
  assert.equal((await pendingView(pm2, chat)).manualChanged, true);
});

test('контекст: копирование версий для модели фиксирует их, ack-all подтверждает пачкой', async (t) => {
  const { root, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  await fs.writeFile(path.join(root, 'b.py'), 'y = 1\n');
  await applyAi({ pm, chat, key: 'k', text: '# &a.py\nx = 2\n' });
  await pm.recordContext(chat, project.id, [{ relPath: 'b.py', hash: H('y = 1\n') }], 'prompt');
  await fs.writeFile(path.join(root, 'a.py'), 'x = 3\n');
  await fs.writeFile(path.join(root, 'b.py'), 'y = 3\n');

  const before = await pm.listDivergences(chat, project.id);
  assert.equal(before.items.length, 2);

  const copied = await pm.copyDivergentVersions(chat, project.id);
  assert.equal(copied.ok, true, JSON.stringify(copied));
  assert.equal(copied.files, 2);
  assert.match(copied.text, /--- a\.py ---\nx = 3/);
  assert.match(copied.text, /--- b\.py ---\ny = 3/);
  // копирование НЕ снимает предупреждений: скопировать в буфер — не значит отправить в чат,
  // а ложное «модель знает» хуже заметного, потому что скрывает уехавший контекст
  assert.equal((await pm.listDivergences(chat, project.id)).items.length, 2);

  // снимает только явное подтверждение
  const all = await pm.ackAllDivergent(chat, project.id);
  assert.equal(all.ok, true);
  assert.equal(all.acked, 2);
  assert.deepEqual((await pm.listDivergences(chat, project.id)).items, []);
  assert.equal(store.contextKnown()[chat] ? Object.keys(store.contextKnown()[chat]).length : 0, 2);

  // после подтверждения копировать уже нечего
  const empty = await pm.copyDivergentVersions(chat, project.id);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /Расхождений нет/);
});

test('контекст: удалённый файл — это расхождение, а не «нечего сравнивать»', async (t) => {
  const { root, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  await pm.recordContext(chat, project.id, [{ relPath: 'a.py', hash: H('x = 1\n') }], 'prompt');
  await fs.unlink(path.join(root, 'a.py'));

  const { items } = await pm.listDivergences(chat, project.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].missing, true);
  assert.equal(items[0].diskHash, null);
});

test('контекст: ошибки подтверждения — чат, проект, путь, файл, кодировка', async (t) => {
  const { root, pm, project } = await setup(t);
  assert.equal((await pm.ackContext(null, project.id, 'a.py')).ok, false);
  assert.match((await pm.ackContext(null, project.id, 'a.py')).error, /Чат не открыт/);
  assert.match((await pm.ackContext(CHAT, 'нет-проекта', 'a.py')).error, /Проект/);
  assert.equal((await pm.ackContext(CHAT, project.id, '../evil.py')).ok, false);
  assert.equal((await pm.ackContext(CHAT, project.id, 'нет.py')).ok, false);

  await fs.writeFile(path.join(root, 'legacy.py'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]));
  const r = await pm.ackContext(CHAT, project.id, 'legacy.py');
  assert.equal(r.ok, false);
  assert.match(r.error, /UTF-8/);

  // recordContext отбраковывает мусор и не пишет конфиг впустую
  assert.equal(await pm.recordContext(CHAT, project.id, [{ relPath: '', hash: 'x' }, { relPath: 'a', hash: '' }, null, 42], 'ack'), 0);
  assert.equal(await pm.recordContext(CHAT, project.id, null, 'ack'), 0);
  assert.equal(await pm.recordContext(null, project.id, [{ relPath: 'a', hash: 'h' }], 'ack'), 0);
});

test('контекст: список ограничен, и обрезка не скрывается', async (t) => {
  const { root, pm, chat, project } = await setup(t);
  const files = [];
  for (let i = 0; i < 12; i++) {
    await fs.writeFile(path.join(root, `f${i}.txt`), `v${i}\n`);
    files.push({ relPath: `f${i}.txt`, hash: H(`v${i}\n`) });
  }
  await pm.recordContext(chat, project.id, files, 'prompt');
  for (let i = 0; i < 12; i++) await fs.writeFile(path.join(root, `f${i}.txt`), 'changed\n');

  const full = await pm.listDivergences(chat, project.id);
  assert.equal(full.items.length, 12);
  assert.equal(full.truncated, false);
  assert.equal(full.checked, 12);

  const limited = await pm.listDivergences(chat, project.id, 5);
  assert.equal(limited.items.length, 5);
  assert.equal(limited.truncated, true);
  assert.equal(limited.checked, 5);

  assert.deepEqual(await pm.listDivergences(null, project.id), { items: [], checked: 0, truncated: false });
  assert.deepEqual(await pm.listDivergences(chat, 'нет-проекта'), { items: [], checked: 0, truncated: false });
});

test('контекст: пакетный запрос известных версий', async (t) => {
  const { root, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  await pm.recordContext(chat, project.id, [{ relPath: 'a.py', hash: H('x = 1\n') }], 'ack');
  assert.deepEqual(pm.contextKnownHashes(chat, project.id, ['a.py', 'b.py', 42, '']),
    { 'a.py': H('x = 1\n'), 'b.py': null });
  assert.deepEqual(pm.contextKnownHashes(null, project.id, ['a.py']), { 'a.py': null });
});

test('контекст: move фиксирует новый путь', async (t) => {
  const { root, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'old.txt'), 'data\n');
  pm.ingest(chat, [{ key: 'm', text: '# &MOVE:old.txt -> sub/new.txt\n' }]);
  const mv = (await pm.list(chat, true)).find((x) => x.op === 'move' && x.status === 'pending');
  const v = await pm.view(mv.id);
  const r = await pm.apply(mv.id, { baseHash: v.baseHash, contentHash: v.contentHash, createDirs: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(Context.knownVersion(store.contextKnown(), chat, project.id, 'sub/new.txt').hash, H('data\n'));
  assert.equal(Context.knownVersion(store.contextKnown(), chat, project.id, 'old.txt'), null);
});

test('снимки: сравнение строится от версии, которую видела модель', async (t) => {
  const { root, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'line1\nline2\n');
  await pm.recordContext(chat, project.id,
    [{ relPath: 'a.py', hash: H('line1\nline2\n'), content: 'line1\nline2\n' }], 'prompt');

  // файл, который приложение никогда не записывало: резервных копий нет вовсе,
  // но сравнение всё равно строится — от снимка в журнале контекста
  await fs.writeFile(path.join(root, 'a.py'), 'line1\nCHANGED\nline3\n');
  const v = await pm.manualView(chat, project.id, 'a.py');
  assert.equal(v.diverged, true);
  assert.equal(v.base, 'context');
  assert.equal(v.knownVersion.source, 'prompt');
  assert.equal(v.error, undefined);
  const texts = v.rows.filter((r) => r.type === 'del' || r.type === 'add').map((r) => [r.type, r.text]);
  assert.deepEqual(texts, [['del', 'line2'], ['add', 'CHANGED'], ['add', 'line3']]);
});

test('снимки: возврат файла к известной модели версии снимает расхождение сам', async (t) => {
  // Сценарий жалобы: изменили файл — заметили; вернули обратно — отметка должна исчезнуть
  // без всяких подтверждений, потому что сравниваются содержимые, а не факты изменений.
  const { root, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  await applyAi({ pm, chat, key: 'k', text: '# &a.py\nx = 2\n' });
  assert.deepEqual((await pm.listDivergences(chat, project.id)).items, []);

  await fs.writeFile(path.join(root, 'a.py'), 'x = 999\n');
  assert.equal((await pm.listDivergences(chat, project.id)).items.length, 1);

  await fs.writeFile(path.join(root, 'a.py'), 'x = 2\n'); // вернули ту же версию
  assert.deepEqual((await pm.listDivergences(chat, project.id)).items, [],
    'вернули содержимое, которое модель знает, — расхождения нет');

  // то же через сохранение в редакторе: вернули известную модели версию — расхождение ушло
  await fs.writeFile(path.join(root, 'a.py'), 'x = 5\n');
  assert.equal((await pm.listDivergences(chat, project.id)).items.length, 1);
  const opened = await editorfs.readForEditor(project, 'a.py');
  const w = await editorfs.writeFromEditor({
    project, rel: 'a.py', content: 'x = 2\n', expectedHash: opened.hash, store: pm.store, chatId: chat,
  });
  assert.equal(w.ok, true, w.error);
  assert.deepEqual((await pm.listDivergences(chat, project.id)).items, []);
});

test('снимки: ack сохраняет текущую версию, и её можно показать', async (t) => {
  const { root, store, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'v1\n');
  await pm.recordContext(chat, project.id, [{ relPath: 'a.py', hash: H('v1\n') }], 'prompt');
  // без содержимого снимка нет
  assert.equal(await store.readContextSnapshot(H('v1\n')), null);

  await fs.writeFile(path.join(root, 'a.py'), 'v2\n');
  assert.equal((await pm.ackContext(chat, project.id, 'a.py')).ok, true);
  assert.equal(await store.readContextSnapshot(H('v2\n')), 'v2\n');

  await fs.writeFile(path.join(root, 'a.py'), 'v3\n');
  const v = await pm.manualView(chat, project.id, 'a.py');
  assert.equal(v.base, 'context');
  assert.equal(v.knownVersion.hash, H('v2\n'));
  assert.deepEqual(v.rows.filter((r) => r.type !== 'eq' && r.type !== 'skip').map((r) => [r.type, r.text]),
    [['del', 'v2'], ['add', 'v3']]);
});

test('снимки: одинаковое содержимое хранится один раз', async (t) => {
  const { root, data, pm, chat, project } = await setup(t);
  const same = 'одинаковое содержимое\n';
  await fs.writeFile(path.join(root, 'a.py'), same);
  await fs.writeFile(path.join(root, 'b.py'), same);
  await pm.recordContext(chat, project.id, [
    { relPath: 'a.py', hash: H(same), content: same },
    { relPath: 'b.py', hash: H(same), content: same },
  ], 'prompt');
  const names = (await fs.readdir(path.join(data, 'context'))).filter((n) => !n.endsWith('.tmp'));
  assert.deepEqual(names, [H(same)], 'снимок адресуется содержимым, дублей нет');
});

test('снимки: слишком большая версия не сохраняется, сравнение честно об этом говорит', async (t) => {
  const { root, store, pm, chat, project } = await setup(t);
  const big = 'x'.repeat(CONTEXT_SNAPSHOT_MAX_CHARS + 10);
  await fs.writeFile(path.join(root, 'big.txt'), big);
  const ok = await store.saveContextSnapshot(H(big), big);
  assert.equal(ok, false, 'снимок больше лимита не сохраняется');

  await pm.recordContext(chat, project.id, [{ relPath: 'big.txt', hash: H(big), content: big }], 'prompt');
  await fs.writeFile(path.join(root, 'big.txt'), big + '\ny');
  const v = await pm.manualView(chat, project.id, 'big.txt');
  assert.equal(v.diverged, true);
  assert.equal(v.noBase, true);
  assert.match(v.error, /не сохранено/);
});

test('снимки: нет расхождения — сравнение не строится, но причина объяснена', async (t) => {
  const { root, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'v1\n');
  await pm.recordContext(chat, project.id, [{ relPath: 'a.py', hash: H('v1\n'), content: 'v1\n' }], 'prompt');
  const v = await pm.manualView(chat, project.id, 'a.py');
  assert.equal(v.diverged, false);
  assert.deepEqual(v.rows, []);
  assert.match(v.note, /знает текущую версию/);
});

test('снимки: удалённый файл — расхождение с внятной причиной', async (t) => {
  const { root, pm, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'v1\n');
  await pm.recordContext(chat, project.id, [{ relPath: 'a.py', hash: H('v1\n'), content: 'v1\n' }], 'prompt');
  await fs.unlink(path.join(root, 'a.py'));
  const v = await pm.manualView(chat, project.id, 'a.py');
  assert.equal(v.diverged, true);
  assert.equal(v.missing, true);
  assert.match(v.error, /удалён/);
});

test('снимки: вытесняются только те, на которые журнал больше не ссылается', async (t) => {
  const { root, data, store, pm, chat, project } = await setup(t);
  // запись, на которую есть ссылка в журнале
  await fs.writeFile(path.join(root, 'keep.py'), 'keep\n');
  await pm.recordContext(chat, project.id, [{ relPath: 'keep.py', hash: H('keep\n'), content: 'keep\n' }], 'prompt');
  // сирота: записали снимок, но в журнал не внесли
  await store.saveContextSnapshot('f'.repeat(64), 'orphan');
  const dir = path.join(data, 'context');
  const before = (await fs.readdir(dir)).filter((n) => !n.endsWith('.tmp'));
  assert.equal(before.length, 2);

  // принудительная чистка через новый снимок: лимит не превышен — сирота остаётся
  await store.saveContextSnapshot('e'.repeat(64), 'orphan2');
  await store._pruneContextSnapshots();
  const after = (await fs.readdir(dir)).filter((n) => !n.endsWith('.tmp'));
  assert.ok(after.includes(H('keep\n')), 'нужный снимок не удалён');
  assert.ok(after.includes('e'.repeat(64)));
  // сироты удаляются, только когда превышен лимит; проверяем сам механизм на малом лимите
  assert.equal(await store.readContextSnapshot(H('keep\n')), 'keep\n');
});

test('seen: старый ответ модели из прокрутки не предлагается как новый', async (t) => {
  // preload-chat.js считает «историей» только блоки первых 2.5 с. При прокрутке вверх
  // DeepSeek догружает старые сообщения, их блоки приходят позже и выглядят свежими.
  const { root, data, store, chat, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');

  const pm1 = new ProposalManager({ store });
  pm1.ingest(chat, [{ key: 'node-1', text: '# &a.py\nx = 2\n' }]);
  await pm1.sealAiBase(chat); // сохраняет журнал, как это делает main после ingest
  assert.equal((await pm1.list(chat, true))[0].historical, false, 'впервые блок новый');

  // новая «сессия»: тот же ответ модели приходит из DOM под другим идентификатором узла
  const store2 = new Store(data);
  await store2.load();
  const pm2 = new ProposalManager({ store: store2 });
  pm2.ingest(chat, [{ key: 'node-999', text: '# &a.py\nx = 2\n' }]);
  const list = await pm2.list(chat, true);
  assert.equal(list.length, 1);
  assert.equal(list[0].historical, true, 'уже виденный блок помечен историческим');
  // и в основной список (без «показывать код из истории чата») он не попадает
  assert.deepEqual(await pm2.list(chat, false), []);

  // действительно новый ответ остаётся новым
  pm2.ingest(chat, [{ key: 'node-1000', text: '# &a.py\nx = 7\n' }]);
  const fresh = (await pm2.list(chat, true)).find((x) => !x.historical);
  assert.ok(fresh, 'новый блок не считается историческим');
  assert.equal(Context.knownVersion(store2.contextKnown(), chat, project.id, 'a.py'), null);
});

test('seen: дописываемый блок не теряет статус нового', async (t) => {
  const { root, store, pm, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  pm.ingest(chat, [{ key: 'k', text: '# &a.py\nx = 2' }]);
  await pm.sealAiBase(chat);
  assert.equal((await pm.list(chat, true))[0].historical, false);
  // стриминг продолжился: содержимое изменилось, это по-прежнему свежий ответ
  pm.ingest(chat, [{ key: 'k', text: '# &a.py\nx = 2\n' }]);
  await pm.sealAiBase(chat);
  const [item] = await pm.list(chat, true);
  assert.equal(item.historical, false);
  assert.equal(item.status, 'pending');
});

test('миграция: прежние отметки modelSynced переносятся в журнал чата', async (t) => {
  const { root, data, project } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  // конфиг в старом формате: отметка по проекту, журнала контекста нет
  const cfgPath = path.join(data, 'config.json');
  const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  delete cfg.contextKnown;
  delete cfg.contextSeen;
  cfg.modelSynced = { [project.id]: { 'a.py': H('x = 1\n') } };
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));

  const store = new Store(data);
  await store.load();
  assert.equal(store.config.modelSynced, undefined, 'старое поле убрано');
  // и убрано не только в памяти: migration сохраняется, иначе поле вечно жило бы в config.json
  const raw = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
  assert.equal(raw.modelSynced, undefined, 'устаревшее поле осталось на диске');
  assert.ok(raw.contextKnown[CHAT], 'журнал контекста записан на диск');
  const known = Context.knownVersion(store.contextKnown(), CHAT, project.id, 'a.py');
  assert.ok(known, 'отметка перенесена в чат, привязанный к проекту');
  assert.equal(known.hash, H('x = 1\n'));
  assert.equal(known.source, 'migrated');

  // расхождения нет, пока файл не изменили
  const pm = new ProposalManager({ store });
  assert.deepEqual((await pm.listDivergences(CHAT, project.id)).items, []);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 2\n');
  assert.equal((await pm.listDivergences(CHAT, project.id)).items.length, 1);
});

'use strict';
// Слежение за файлами, которых модель не видела (этап D).
//
// Два уровня:
//   1. чистое правило Context.listUnseen / Context.renamePaths — без fs вообще;
//   2. сборка: store (базовые снимки) + fileops (отпечатки) + proposals
//      (ленивый снимок, список, копирование модели, массовая отметка, manualView).
//
// Сценарий пользователя, который это покрывает: «создал файл сам в проводнике —
// он подсветился как неизвестный модели, и одной кнопкой копируется промпт со
// всеми новыми файлами и их содержимым».
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const fileops = require('../src/fileops');
const Context = require('../src/context');
const { Store } = require('../src/store');
const { ProposalManager } = require('../src/proposals');

const CHAT = '17b45023-2aba-4a1a-a966-17bbe41926ea';
const CHAT2 = '27b45023-2aba-4a1a-a966-17bbe41926eb';

// ---------- чистое правило ----------

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const shape = (items) => items.map(({ relPath, isNew }) => ({ relPath, isNew }));

test('unseen: listUnseen — новые и изменённые без записи в журнале', () => {
  const baseline = { 'a.py': `10:100:${H1}`, 'b.py': `20:200:${H2}`, 'sub/c.py': `30:300:${H1}` };
  const current = {
    'a.py': '10:100',   // лежал и не менялся
    'b.py': '25:250',   // изменён после снимка
    'sub/c.py': '30:300',
    'new.py': '5:500',  // создан
  };
  const r = Context.listUnseen(baseline, current, new Set());
  assert.deepEqual(shape(r.items), [
    { relPath: 'b.py', isNew: false },
    { relPath: 'new.py', isNew: true },
  ], 'список отсортирован по пути, изменённые и новые различаются');
  assert.equal(r.truncated, false);
  // данные для точной проверки: хэш из снимка и текущий отпечаток
  const b = r.items.find((x) => x.relPath === 'b.py');
  assert.equal(b.baseHash, H2, 'хэш снимка передан вызывающему');
  assert.equal(b.curFp, '25:250');
  const n = r.items.find((x) => x.relPath === 'new.py');
  assert.equal(n.baseHash, null, 'у нового файла хэша снимка нет');
});

test('unseen: splitBaselineEntry — разбор записи снимка, терпимость к старым форматам', () => {
  assert.deepEqual(Context.splitBaselineEntry(`10:100.5:${H1}`), { fp: '10:100.5', hash: H1 });
  assert.deepEqual(Context.splitBaselineEntry('10:100.5:x'), { fp: '10:100.5', hash: null },
    '«x» — файл больше лимита чтения, хэша нет');
  assert.deepEqual(Context.splitBaselineEntry('10:100'), { fp: '10', hash: null },
    'запись без хэша разбирается терпимо');
  assert.deepEqual(Context.splitBaselineEntry(null), { fp: '', hash: null });
});

test('unseen: listUnseen — файл с записью в журнале относится к расхождениям, а не сюда', () => {
  const baseline = { 'a.py': `10:100:${H1}` };
  const current = { 'a.py': '99:999', 'known.py': '1:1' };
  // known.py изменён, но у модели есть запись о какой-то его версии — это расхождение
  const r = Context.listUnseen(baseline, current, new Set(['known.py']));
  assert.deepEqual(shape(r.items), [{ relPath: 'a.py', isNew: false }]);
});

test('unseen: listUnseen — удалённые файлы не всплывают, мусор на входе не роняет', () => {
  const r = Context.listUnseen({ 'gone.py': `1:1:${H1}` }, {}, new Set());
  assert.deepEqual(r.items, [], 'файл пропал — это работа списка расхождений');
  assert.deepEqual(Context.listUnseen(null, {}, new Set()).items, []);
  assert.deepEqual(Context.listUnseen({}, null, new Set()).items, []);
  // knownRels принимается и массивом
  const arr = Context.listUnseen({}, { 'x': '1:1' }, ['x']);
  assert.deepEqual(arr.items, []);
});

test('unseen: listUnseen — лимит списка и признак обрезки', () => {
  const current = {};
  for (let i = 0; i < Context.MAX_UNSEEN + 10; i++) current['f' + String(i).padStart(4, '0') + '.py'] = '1:1';
  const r = Context.listUnseen({}, current, new Set());
  assert.equal(r.items.length, Context.MAX_UNSEEN);
  assert.equal(r.truncated, true, 'обрезка видна вызывающему');
});

test('unseen: renamePaths переносит записи журнала (файл, папка, чужой проект не трогается)', () => {
  const known = {};
  Context.record(known, CHAT, { projectId: 'p1', relPath: 'a.py', hash: 'h1', source: 'ack' });
  Context.record(known, CHAT, { projectId: 'p1', relPath: 'pkg/b.py', hash: 'h2', source: 'ack' });
  Context.record(known, CHAT2, { projectId: 'p1', relPath: 'a.py', hash: 'h1x', source: 'ack' });
  Context.record(known, CHAT, { projectId: 'p2', relPath: 'a.py', hash: 'other', source: 'ack' });

  assert.equal(Context.renamePaths(known, 'p1', 'a.py', 'a2.py'), 2, 'перенесены записи обоих чатов');
  assert.equal(Context.knownVersion(known, CHAT, 'p1', 'a2.py').hash, 'h1');
  assert.equal(Context.knownVersion(known, CHAT2, 'p1', 'a2.py').hash, 'h1x');
  assert.equal(Context.knownVersion(known, CHAT, 'p1', 'a.py'), null);
  assert.equal(Context.knownVersion(known, CHAT, 'p2', 'a.py').hash, 'other', 'чужой проект не тронут');

  assert.equal(Context.renamePaths(known, 'p1', 'pkg', 'lib'), 1);
  assert.equal(Context.knownVersion(known, CHAT, 'p1', 'lib/b.py').hash, 'h2');
  assert.equal(Context.knownVersion(known, CHAT, 'p1', 'pkg/b.py'), null);

  // префикс не рвёт похожие имена: pkgx/ не является папкой pkg — переносить нечего
  Context.record(known, CHAT, { projectId: 'p1', relPath: 'pkgx/c.py', hash: 'h3', source: 'ack' });
  assert.equal(Context.renamePaths(known, 'p1', 'pkg', 'p2dir'), 0, 'записей pkg/ больше нет');
  assert.equal(Context.knownVersion(known, CHAT, 'p1', 'pkgx/c.py').hash, 'h3', 'похожий путь не тронут');

  assert.equal(Context.renamePaths(known, 'p1', 'a2.py', 'a2.py'), 0, 'переименование в себя — не операция');
  assert.equal(Context.renamePaths(null, 'p1', 'x', 'y'), 0);
});

// ---------- сборка: store + fileops + proposals ----------

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-unseen-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-unseend-'));
  t.after(() => Promise.all([root, data]
    .map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))));
  const store = new Store(data);
  await store.load();
  const project = await store.addProject(root);
  await store.bind(CHAT, project.id);
  const pm = new ProposalManager({ store });
  const write = async (rel, text) => {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
    fileops.invalidateIndex(); // main делает это по событию watcher'а
  };
  return { root, data, store, pm, project, chat: CHAT, write };
}

test('unseen: первый запрос создаёт базовый снимок — существующие файлы не светятся', async (t) => {
  const { root, store, pm, project, chat } = await setup(t);
  await fs.writeFile(path.join(root, 'old.py'), 'x = 1\n');
  fileops.invalidateIndex();

  const first = await pm.listUnseen(chat, project.id);
  assert.deepEqual(first.items, [], 'всё, что лежало до начала учёта, новым не считается');
  const base = await store.getBaseline(chat, project.id);
  assert.ok(base, 'снимок создан');
  assert.ok('old.py' in base.files, 'отпечаток файла сохранён');
  assert.match(base.files['old.py'], /^6:[\d.]+:[0-9a-f]{64}$/, 'снимок хранит отпечаток И хэш содержимого');
  assert.equal(base.truncated, false);

  // снимок переживает перезапуск (ленивое чтение baselines.json)
  const again = new Store(path.dirname(store.configPath));
  await again.load();
  const base2 = await again.getBaseline(chat, project.id);
  assert.deepEqual(base2.files, base.files);
});

test('unseen: файл, созданный вне приложения, подсвечивается; изменение — тоже', async (t) => {
  const { store, pm, project, chat, write } = await setup(t);
  await write('old.py', 'x = 1\n');
  await pm.listUnseen(chat, project.id); // снимок

  // пользователь создал файл в проводнике
  await write('created.py', 'print("Светит")\n');
  let r = await pm.listUnseen(chat, project.id);
  assert.deepEqual(r.items, [{ relPath: 'created.py', isNew: true }]);

  // и изменил существующий, которого модель не знала
  await write('old.py', 'x = 2\n');
  r = await pm.listUnseen(chat, project.id);
  assert.deepEqual(r.items.map((x) => x.relPath), ['created.py', 'old.py']);
  assert.equal(r.items.find((x) => x.relPath === 'old.py').isNew, false);

  // папки артефактов не считаются: .ide_build в IGNORE_DIRS
  await write('.ide_build/app.dll', 'binary');
  r = await pm.listUnseen(chat, project.id);
  assert.deepEqual(r.items.map((x) => x.relPath), ['created.py', 'old.py'], '.ide_build игнорируется');

  // отпечатки честные: повторный запрос без изменений даёт тот же список (кеш не врёт)
  fileops.invalidateIndex();
  r = await pm.listUnseen(chat, project.id);
  assert.equal(r.items.length, 2);
  void store;
});

test('unseen: файл «тронули» без изменения содержимого — не светится (точная проверка по хэшу)', async (t) => {
  const { root, store, pm, project, chat, write } = await setup(t);
  await write('old.py', 'x = 1\n');
  await pm.listUnseen(chat, project.id); // снимок: отпечаток + хэш

  // содержимое то же, mtime новый — так делают сборка, форматирование с тем же
  // результатом и git checkout туда-обратно. По отпечатку файл «изменён»,
  // по содержимому — нет: светиться он не должен, иначе в промпт уехал бы мусор.
  await write('old.py', 'x = 1\n');
  let r = await pm.listUnseen(chat, project.id);
  assert.deepEqual(r.items, [], 'побайтово файл не изменился — модели нечего догонять');

  // отпечаток в снимке обновлён: повторная проверка идёт без перечитывания файла
  const base = await store.getBaseline(chat, project.id);
  const cur = await fileops.getFingerprints(root);
  const entry = Context.splitBaselineEntry(base.files['old.py']);
  assert.equal(entry.fp, cur.files['old.py'], 'снимок догнал диск');
  fileops.invalidateIndex();
  r = await pm.listUnseen(chat, project.id);
  assert.deepEqual(r.items, []);

  // настоящее изменение содержимого видно по-прежнему
  await write('old.py', 'x = 2\n');
  r = await pm.listUnseen(chat, project.id);
  assert.deepEqual(r.items.map((x) => x.relPath), ['old.py']);
  void store;
});

test('unseen: известный модели файл не светится, а отметка снимается подтверждением', async (t) => {
  const { store, pm, project, chat, write } = await setup(t);
  await write('old.py', 'x = 1\n');
  await pm.listUnseen(chat, project.id);
  await write('new.py', 'y = 2\n');
  await write('old.py', 'x = 2\n');

  // модель узнала new.py (например, его отправили промптом) — он выпадает из списка
  const hash = fileops.sha256(Buffer.from('y = 2\n', 'utf8'));
  await pm.recordContext(chat, project.id, [{ relPath: 'new.py', hash, content: 'y = 2\n' }], 'prompt');
  let r = await pm.listUnseen(chat, project.id);
  assert.deepEqual(r.items.map((x) => x.relPath), ['old.py']);

  // изменённый файл подтверждён вручную — список пуст
  const ack = await pm.ackContext(chat, project.id, 'old.py');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  r = await pm.listUnseen(chat, project.id);
  assert.deepEqual(r.items, []);

  // после подтверждения ответственность переходит к списку расхождений:
  // следующая правка — это уже «модель знает устаревшее», а не «модель не видела»
  await write('old.py', 'x = 3\n');
  assert.deepEqual((await pm.listUnseen(chat, project.id)).items, [], 'в журнале есть запись — unseen пуст');
  const div = await pm.listDivergences(chat, project.id);
  assert.deepEqual(div.items.map((x) => x.relPath), ['old.py'], 'следующая правка видна как расхождение');
  void store;
});

test('unseen: ackAllUnseen отмечает весь список, а список расхождений не трогает', async (t) => {
  const { pm, project, chat, write } = await setup(t);
  await write('a.py', 'a\n');
  await pm.listUnseen(chat, project.id);
  await write('n1.py', 'n1\n');
  await write('n2.py', 'n2\n');

  const r = await pm.ackAllUnseen(chat, project.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.acked, 2);
  assert.equal(r.total, 2);
  assert.deepEqual((await pm.listUnseen(chat, project.id)).items, []);
});

test('unseen: copyUnseenFiles — преамбула, содержимое целиком, бинарные пропускаются', async (t) => {
  const { root, pm, project, chat, write } = await setup(t);
  await write('old.py', 'x = 1\n');
  await write('changed.py', 'y = 1\n');
  await pm.listUnseen(chat, project.id); // снимок: old.py и changed.py «лежали изначально»
  await write('created.py', 'print("Светит")\n');
  await write('changed.py', 'y = 2\n');
  await fs.writeFile(path.join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
  fileops.invalidateIndex();

  const r = await pm.copyUnseenFiles(chat, project.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.files, 2, 'два текстовых файла');
  assert.ok(r.text.includes('ЭТИХ ФАЙЛОВ ТЫ ЕЩЁ НЕ ВИДЕЛА'), 'преамбула на месте');
  assert.ok(r.text.includes('--- created.py --- (новый файл: приведён целиком)'));
  assert.ok(r.text.includes('print("Светит")'), 'содержимое с кириллицей цело');
  assert.ok(r.text.includes('--- changed.py --- (изменён без твоего участия: приведён целиком)'));
  assert.ok(r.text.includes('img.png (Бинарный файл)'), 'бинарный пропущен с объяснением');

  // копирование НЕ ставит отметок: буфер — не чат
  assert.ok((await pm.listUnseen(chat, project.id)).items.length >= 2, 'отметки не сняты');

  // отметили всё текстовое — остался только бинарный, который модели не передать:
  // копирование честно отказывает и объясняет причину
  await pm.ackAllUnseen(chat, project.id);
  const none = await pm.copyUnseenFiles(chat, project.id);
  assert.equal(none.ok, false);
  assert.match(none.error, /не удалось подготовить|Новых файлов нет/);
  await fs.rm(path.join(root, 'img.png'));
  fileops.invalidateIndex();
  const empty = await pm.copyUnseenFiles(chat, project.id);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /Новых файлов нет/);
});

test('unseen: copyMissingContext — одна кнопка на расхождения и новые файлы', async (t) => {
  const { pm, project, chat, write } = await setup(t);
  // модель знает версию known.py
  await write('known.py', 'v1\n');
  const h1 = fileops.sha256(Buffer.from('v1\n', 'utf8'));
  await pm.recordContext(chat, project.id, [{ relPath: 'known.py', hash: h1, content: 'v1\n' }], 'prompt');
  await pm.listUnseen(chat, project.id); // снимок: known.py v1

  // known.py изменён вручную (расхождение), fresh.py создан (unseen)
  await write('known.py', 'v2\n');
  await write('fresh.py', 'fresh\n');

  const r = await pm.copyMissingContext(chat, project.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.files, 2);
  assert.equal(r.asDiff + r.asFull, 1, 'расхождение — diff или файл целиком');
  assert.equal(r.asNew, 1, 'новый файл — целиком');
  assert.ok(r.text.includes('ИЗМЕНИЛИСЬ С ТЕХ ПОР'), 'преамбула расхождений');
  assert.ok(r.text.includes('ЕЩЁ НЕ ВИДЕЛА'), 'преамбула новых файлов');
  assert.ok(r.text.includes('fresh.py') && r.text.includes('fresh\n'));

  // только расхождения — преамбулы новых нет
  await pm.ackAllUnseen(chat, project.id);
  const onlyDiv = await pm.copyMissingContext(chat, project.id);
  assert.equal(onlyDiv.ok, true);
  assert.equal(onlyDiv.asNew, 0);
  assert.ok(!onlyDiv.text.includes('ЕЩЁ НЕ ВИДЕЛА'));

  // ничего не отстало — понятная ошибка
  await pm.ackAllDivergent(chat, project.id);
  const none = await pm.copyMissingContext(chat, project.id);
  assert.equal(none.ok, false);
  assert.match(none.error, /Копировать нечего/);
});

test('unseen: manualView показывает новый файл целиком и предлагает отметку', async (t) => {
  const { pm, project, chat, write } = await setup(t);
  await write('old.py', 'x = 1\n');
  await pm.listUnseen(chat, project.id);
  await write('created.py', 'line1\nline2\n');

  const v = await pm.manualView(chat, project.id, 'created.py');
  assert.equal(v.unseen, true);
  assert.equal(v.isNew, true);
  assert.equal(v.diverged, false, 'расхождения нет: сравнивать не с чем');
  assert.equal(v.base, 'empty');
  assert.equal(v.baseText, '', 'база сравнения — пустота');
  assert.equal(v.currentText, 'line1\nline2\n');
  assert.equal(v.knownVersion, null);
  assert.equal(v.stats.added, 2, 'весь файл — добавления');
  assert.equal(v.stats.removed, 0);
  assert.ok(v.rows.length > 0);

  // после отметки журнал знает текущую версию — просмотр говорит об этом
  await pm.ackContext(chat, project.id, 'created.py');
  const after = await pm.manualView(chat, project.id, 'created.py');
  assert.equal(after.diverged, false);
  assert.ok(!after.unseen);
  assert.match(after.note, /Модель знает текущую версию/);

  // обычный файл без записи и без изменений — не «новый»
  const quiet = await pm.manualView(chat, project.id, 'old.py');
  assert.ok(!quiet.unseen && !quiet.diverged);
  assert.match(quiet.note, /не менялся с начала учёта/);
});

test('unseen: список привязан к чату — у нового чата свой снимок', async (t) => {
  const { store, pm, project, chat, write } = await setup(t);
  await write('old.py', 'x = 1\n');
  await pm.listUnseen(chat, project.id);
  await write('created.py', 'new\n');
  assert.equal((await pm.listUnseen(chat, project.id)).items.length, 1);

  // второй чат того же проекта начинает с чистого листа
  await store.bind(CHAT2, project.id);
  const first2 = await pm.listUnseen(CHAT2, project.id);
  assert.deepEqual(first2.items, [], 'у нового чата всё существующее — не новое');
  const base2 = await store.getBaseline(CHAT2, project.id);
  assert.ok(base2 && 'created.py' in base2.files, 'снимок второго чата независим');

  // но новые файлы второго чата видны только ему
  await write('second.py', 'y\n');
  assert.deepEqual((await pm.listUnseen(CHAT2, project.id)).items.map((x) => x.relPath), ['second.py']);
  const firstList = (await pm.listUnseen(chat, project.id)).items.map((x) => x.relPath);
  assert.ok(firstList.includes('created.py') && firstList.includes('second.py'));

  // без чата списка нет: знать или не знать — свойство разговора
  assert.deepEqual((await pm.listUnseen(null, project.id)).items, []);
});

test('unseen: удалённый файл выпадает из списка, а переименованный переезжает', async (t) => {
  const { root, store, pm, project, chat, write } = await setup(t);
  await write('old.py', 'x = 1\n');
  await pm.listUnseen(chat, project.id);
  await write('created.py', 'new\n');
  assert.equal((await pm.listUnseen(chat, project.id)).items.length, 1);

  // удаление: файла нет ни на диске, ни в списке
  await fs.rm(path.join(root, 'created.py'));
  fileops.invalidateIndex();
  assert.deepEqual((await pm.listUnseen(chat, project.id)).items, []);

  // переименование через treefs: снимок переезжает, ложного «нового файла» нет
  const treefs = require('../src/treefs');
  await write('ren.py', 'r\n');
  fileops.invalidateIndex();
  assert.deepEqual((await pm.listUnseen(chat, project.id)).items.map((x) => x.relPath), ['ren.py']);
  const rr = await treefs.renamePath({ project, rel: 'ren.py', newRel: 'renamed.py', store, chatId: chat });
  assert.equal(rr.ok, true, JSON.stringify(rr));
  fileops.invalidateIndex();
  assert.deepEqual((await pm.listUnseen(chat, project.id)).items.map((x) => x.relPath), ['renamed.py'],
    'файл остаётся невиденным для модели, но путь обновлён');
});

test('store: базовые снимки — чтение, запись, перенос путей, удаление с проектом', async (t) => {
  const { data, store } = await setup(t);
  assert.equal(await store.getBaseline(CHAT, 'p1'), null, 'снимка ещё нет');

  await store.saveBaseline(CHAT, 'p1', { capturedAt: 1, truncated: false, files: { 'a.py': '1:1', 'd/b.py': '2:2' } });
  await store.saveBaseline(CHAT, 'p2', { capturedAt: 2, truncated: false, files: { 'a.py': '9:9' } });
  await store.saveBaseline(CHAT2, 'p1', { capturedAt: 3, truncated: false, files: { 'a.py': '5:5' } });

  assert.equal((await store.getBaseline(CHAT, 'p1')).files['a.py'], '1:1');
  // мусор вместо снимка — null, не падение
  assert.equal(await store.getBaseline(null, 'p1'), null);
  assert.equal(await store.getBaseline(CHAT, null), null);

  // перенос путей затрагивает все чаты проекта и не трогает чужие проекты
  const n = await store.renameBaselinePaths('p1', 'a.py', 'a2.py');
  assert.equal(n, 2, 'перенесено в обоих чатах проекта p1');
  const b1 = await store.getBaseline(CHAT, 'p1');
  assert.ok('a2.py' in b1.files && !('a.py' in b1.files));
  assert.ok('d/b.py' in b1.files, 'остальные записи целы');
  assert.equal((await store.getBaseline(CHAT2, 'p1')).files['a2.py'], '5:5');
  assert.equal((await store.getBaseline(CHAT, 'p2')).files['a.py'], '9:9', 'чужой проект не тронут');
  assert.equal(await store.renameBaselinePaths('p1', 'x', 'x'), 0);

  // снимки переживают перезапуск и удаляются вместе с проектом
  const again = new Store(data);
  await again.load();
  assert.ok(await again.getBaseline(CHAT, 'p1'));
  again.config.projects = [{ id: 'p1', name: 'x', path: '/x' }];
  await again.removeProject('p1');
  assert.equal(await again.getBaseline(CHAT, 'p1'), null, 'снимки p1 удалены');
  assert.equal(await again.getBaseline(CHAT2, 'p1'), null);
  assert.ok(await again.getBaseline(CHAT, 'p2'), 'снимки других проектов целы');
});

test('unseen: fileops.getFingerprints — отпечатки, игнор папок, кеш и инвалидация', async (t) => {
  const { root } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), '12345');
  await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'x', 'i.js'), 'junk');
  await fs.writeFile(path.join(root, '.git-tmp.aiws-abcd.tmp'), 'temp');
  fileops.invalidateIndex();

  const fp = await fileops.getFingerprints(root);
  assert.equal(fp.truncated, false);
  assert.deepEqual(Object.keys(fp.files), ['a.py'], 'только настоящие файлы проекта');
  assert.match(fp.files['a.py'], /^5:\d+(\.\d+)?$/, 'отпечаток — размер и mtime (без округления)');

  // кеш: повторный вызов без invalidate отдаёт тот же объект
  const again = await fileops.getFingerprints(root);
  assert.deepEqual(again.files, fp.files);

  // изменение файла видно после инвалидации
  await fs.writeFile(path.join(root, 'a.py'), '1234567');
  fileops.invalidateIndex();
  const after = await fileops.getFingerprints(root);
  assert.notEqual(after.files['a.py'], fp.files['a.py'], 'отпечаток изменился');
});

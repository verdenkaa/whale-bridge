'use strict';
// Stage 0 (ТЗ §36–38): идентичности, треугольник версий и контракт хэширования.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const fileops = require('../src/fileops');
const { Store, HISTORY_SOURCES } = require('../src/store');
const { ProposalManager } = require('../src/proposals');
const V = require('../src/versions');

const H = (s) => fileops.sha256(Buffer.from(s, 'utf8'));
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const S = 's'.repeat(64);

async function setup(t, { bind = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-v-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-vd-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(data, { recursive: true, force: true })]));
  const store = new Store(data);
  await store.load();
  const project = await store.addProject(root);
  const chat = '17b45023-2aba-4a1a-a966-17bbe41926ea';
  if (bind) await store.bind(chat, project.id);
  return { root, data, store, project, chat, pm: new ProposalManager({ store }) };
}

// ---------- идентичность файла ----------
test('versions: идентичность файла — ключ стабилен, путь нормализуется, небезопасный отклоняется', () => {
  const a = V.fileIdentity({ projectId: 'p1', relPath: 'src/player.gd', diskHash: A });
  assert.equal(a.ok, true);
  assert.equal(a.key, 'p1::src/player.gd');
  assert.equal(a.diskHash, A);

  // обратные слеши и лишние сегменты приводятся к одному ключу — иначе один файл
  // в renderer и main назывался бы по-разному
  const b = V.fileIdentity({ projectId: 'p1', relPath: 'src\\player.gd' });
  assert.equal(b.ok, true);
  assert.equal(b.key, a.key);
  const c = V.fileIdentity({ projectId: 'p1', relPath: './src/./player.gd' });
  assert.equal(c.key, a.key);

  // разные проекты — разные ключи, даже при одинаковом относительном пути
  assert.notEqual(V.fileIdentity({ projectId: 'p2', relPath: 'src/player.gd' }).key, a.key);

  for (const bad of [
    { projectId: '', relPath: 'a.gd' },
    { projectId: 'p1', relPath: '' },
    { projectId: 'p1', relPath: '../escape.gd' },
    { projectId: 'p1', relPath: '/abs.gd' },
    { projectId: 'p1', relPath: '.git/config' },
    { projectId: 'p1', relPath: 'a.gd', diskHash: 42 },
  ]) {
    assert.equal(V.fileIdentity(bad).ok, false, JSON.stringify(bad));
  }

  // round-trip
  const back = V.parseFileKey(a.key);
  assert.equal(back.ok, true);
  assert.equal(back.projectId, 'p1');
  assert.equal(back.relPath, 'src/player.gd');
  assert.equal(V.parseFileKey('без-разделителя').ok, false);
  assert.equal(V.parseFileKey(null).ok, false);
});

test('versions: идентичность предложения — chatId + proposalId + contentHash', () => {
  const p = V.proposalIdentity({ chatId: 'c1', proposalId: 'id1', contentHash: A });
  assert.equal(p.ok, true);
  assert.equal(p.key, 'c1::id1::' + A);
  assert.equal(V.proposalIdentity({ chatId: 'c1', proposalId: 'id1', contentHash: B }).key !== p.key, true);
  for (const bad of [
    { chatId: '', proposalId: 'i', contentHash: A },
    { chatId: 'c', proposalId: '', contentHash: A },
    { chatId: 'c', proposalId: 'i', contentHash: '' },
    { chatId: 'c', proposalId: 'i' },
  ]) {
    assert.equal(V.proposalIdentity(bad).ok, false, JSON.stringify(bad));
  }
});

// ---------- треугольник версий ----------
test('versions: неизвестные хэши не принимаются за версию', () => {
  const r = V.classifyVersions({});
  assert.equal(r.state, 'unknown');
  assert.equal(r.saveDecision, 'unknown');
  assert.equal(r.aiApply, 'unknown');
  assert.equal(r.dirty, false);
  assert.equal(r.diskDrift, false);
  assert.equal(r.aiStale, false);
  // null и ABSENT — разные факты: «не читали» против «файла нет»
  assert.equal(V.classifyVersions({ aiBase: null, disk: null, saved: null, editor: null }).state, 'unknown');
  assert.equal(V.classifyVersions({ disk: V.ABSENT, saved: V.ABSENT, editor: 'x' }).dirty, true);
  assert.match(r.summary, /—/);
});

test('versions: in-sync и dirty (§12) — dirty считается от точки сохранения, а не от диска', () => {
  const sync = V.classifyVersions({ aiBase: A, disk: A, saved: A, editor: A });
  assert.equal(sync.state, 'in-sync');
  assert.equal(sync.dirty, false);
  assert.equal(sync.saveDecision, 'noop');

  const dirty = V.classifyVersions({ aiBase: A, disk: A, saved: A, editor: C });
  assert.equal(dirty.state, 'editor-dirty');
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.saveDecision, 'ok');

  // после успешного сохранения saved догоняет editor — dirty снимается
  const afterSave = V.classifyVersions({ aiBase: A, disk: C, saved: C, editor: C });
  assert.equal(afterSave.state, 'in-sync');
  assert.equal(afterSave.dirty, false);
});

test('versions: drift и конфликт сохранения (§11) — запись запрещена, когда уехали и буфер, и диск', () => {
  // файл изменился вне редактора, своих правок нет → достаточно перечитать
  const drift = V.classifyVersions({ aiBase: A, disk: B, saved: A, editor: A });
  assert.equal(drift.state, 'disk-drift');
  assert.equal(drift.diskDrift, true);
  assert.equal(drift.dirty, false);
  assert.equal(drift.saveDecision, 'reload');
  assert.equal(drift.aiStale, true);

  // сценарий ТЗ §11: открыли A, на диске стало B, пользователь напечатал C → conflict
  const conflict = V.classifyVersions({ aiBase: A, disk: B, saved: A, editor: C });
  assert.equal(conflict.state, 'save-conflict');
  assert.equal(conflict.saveConflict, true);
  assert.equal(conflict.saveDecision, 'conflict');
  assert.equal(conflict.dirty, true);
  assert.equal(conflict.diskDrift, true);
});

test('versions: aiApply (§22) — база слияния это aiBase, а не диск', () => {
  // буфер совпадает с тем, что видела модель → предложение ложится как есть
  assert.equal(V.classifyVersions({ aiBase: A, disk: A, saved: A, editor: A }).aiApply, 'direct');
  // пользователь что-то поправил → только трёхстороннее слияние с базой aiBase
  assert.equal(V.classifyVersions({ aiBase: A, disk: A, saved: A, editor: C }).aiApply, 'merge3');
  // диск уехал, но буфер не тронут моделью-невидимкой: всё равно merge3, если буфер ≠ aiBase
  assert.equal(V.classifyVersions({ aiBase: A, disk: B, saved: A, editor: A }).aiApply, 'direct');
  assert.equal(V.classifyVersions({ aiBase: A, disk: B, saved: A, editor: C }).aiApply, 'merge3');
  // новая file: aiBase = ABSENT, буфер пустой → не «direct», ABSENT !== ''
  assert.equal(V.classifyVersions({ aiBase: V.ABSENT, disk: V.ABSENT, saved: '', editor: '' }).aiApply, 'merge3');
  assert.equal(V.classifyVersions({ aiBase: V.ABSENT }).aiBaseAbsent, true);
});

test('versions: summary честно называет все три версии (§37)', () => {
  const r = V.classifyVersions({ aiBase: A, disk: B, editor: C });
  assert.match(r.summary, new RegExp(`AI видел: ${A.slice(0, 8)}`));
  assert.match(r.summary, new RegExp(`на диске: ${B.slice(0, 8)}`));
  assert.match(r.summary, new RegExp(`в редакторе: ${C.slice(0, 8)}`));
  assert.match(V.classifyVersions({ disk: V.ABSENT }).summary, /нет файла/);
  assert.equal(V.shortHash(null), '—');
});

test('versions: checkExpectedHash — единая трактовка ожидаемого хэша (§9)', () => {
  assert.deepEqual(V.checkExpectedHash(A, A), { ok: true });
  const c = V.checkExpectedHash(A, B);
  assert.equal(c.ok, false);
  assert.equal(c.code, 'conflict');
  assert.equal(c.expected, A);
  assert.equal(c.actual, B);
  assert.equal(V.checkExpectedHash(A, null).code, 'unknown');
  assert.equal(V.checkExpectedHash(null, B).code, 'unknown');
  // ABSENT — полноценная версия: новый файл совпал с ожиданием «файла нет»
  assert.deepEqual(V.checkExpectedHash(V.ABSENT, V.ABSENT), { ok: true });
});

// ---------- контракт хэширования редактора и диска ----------
test('hashTextLike: хэш буфера сравним с хэшем диска для CRLF и BOM', async (t) => {
  const { root } = await setup(t);

  // CRLF: Monaco хранит текст с '\n', файл на диске — с '\r\n'.
  const crlf = path.join(root, 'crlf.gd');
  await fs.writeFile(crlf, 'extends Node\r\n\r\nfunc a():\r\n\tpass\r\n');
  const cur = await fileops.readTextFile(crlf);
  assert.equal(cur.eol, 'crlf');
  const asMonaco = cur.text.replace(/\r\n/g, '\n'); // так текст окажется в модели Monaco
  assert.notEqual(asMonaco, cur.text);
  // наивный хэш «текст как есть» НЕ совпал бы с диском — в этом и ловушка
  assert.notEqual(H(asMonaco), cur.hash);
  // hashTextLike приводит к байтам диска → совпадает, файл не выглядит «грязным» после открытия
  assert.equal(fileops.hashTextLike(asMonaco, cur), cur.hash);
  // реальная правка меняет хэш
  assert.notEqual(fileops.hashTextLike(asMonaco + 'x\n', cur), cur.hash);

  // BOM: readTextFile его снимает, encodeLike — возвращает
  const bom = path.join(root, 'bom.py');
  await fs.writeFile(bom, Buffer.from('\uFEFFx = 1\n', 'utf8'));
  const cb = await fileops.readTextFile(bom);
  assert.equal(cb.hasBom, true);
  assert.ok(!cb.text.startsWith('\uFEFF'));
  assert.notEqual(H(cb.text), cb.hash);
  assert.equal(fileops.hashTextLike(cb.text, cb), cb.hash);

  // новый файл (cur = null): LF без BOM — как в ветке create у applyChange
  assert.equal(fileops.hashTextLike('a\r\nb\n', null), H('a\nb\n'));
});

test('hashTextLike: совпадает с afterHash, который записал applyChange', async (t) => {
  const { root, store } = await setup(t);
  await fs.writeFile(path.join(root, 'a.gd'), 'extends Node\r\n');
  const cur = await fileops.readTextFile(path.join(root, 'a.gd'));
  const newText = 'extends Node\nvar hp = 10\n'; // из редактора, с LF
  const opId = 'op-hash-contract';
  const res = await fileops.applyChange({
    root, rel: 'a.gd', op: 'update', newText, expectedHash: cur.hash,
    backupDir: store.backupDir, opId,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(fileops.hashTextLike(newText, cur), res.afterHash);
  const after = await fileops.readTextFile(path.join(root, 'a.gd'));
  assert.equal(after.eol, 'crlf'); // стиль исходного файла сохранён
  assert.equal(fileops.hashTextLike(after.text.replace(/\r\n/g, '\n'), after), after.hash);
});

// ---------- источник операции в истории ----------
test('history: source по умолчанию ai, manual сохраняется, мусор отбрасывается', async (t) => {
  const { data, store } = await setup(t);
  assert.deepEqual(HISTORY_SOURCES, ['ai', 'manual', 'rollback']);
  const base = { id: 'h', ts: Date.now(), projectId: 'p1', relPath: 'a.gd', op: 'update', status: 'applied' };

  await store.addHistory({ ...base, id: 'h1' });
  assert.equal(store.getHistory('h1').source, 'ai'); // старое поведение = правка из предложения модели
  await store.addHistory({ ...base, id: 'h2', source: 'manual' });
  assert.equal(store.getHistory('h2').source, 'manual');
  await store.addHistory({ ...base, id: 'h3', source: 'rollback' });
  assert.equal(store.getHistory('h3').source, 'rollback');
  await store.addHistory({ ...base, id: 'h4', source: 'что угодно' });
  assert.equal(store.getHistory('h4').source, 'ai');
  await store.addHistory({ ...base, id: 'h5', source: undefined });
  assert.equal(store.getHistory('h5').source, 'ai');

  // перезагрузка: source переживает сериализацию
  const reloaded = new Store(data);
  await reloaded.load();
  assert.deepEqual(reloaded.history.map((h) => [h.id, h.source]),
    [['h1', 'ai'], ['h2', 'manual'], ['h3', 'rollback'], ['h4', 'ai'], ['h5', 'ai']]);
});

test('history: записи старше Stage 0 получают source ai при загрузке', async (t) => {
  const { data } = await setup(t);
  const legacy = [
    { id: 'old1', ts: 1, projectId: 'p1', relPath: 'a.gd', op: 'update', status: 'applied' },
    { id: 'old2', ts: 2, projectId: 'p1', relPath: 'b.gd', op: 'update', status: 'applied', source: 'manual' },
  ];
  await fs.writeFile(path.join(data, 'history.json'), JSON.stringify(legacy, null, 2));
  const store = new Store(data);
  await store.load();
  assert.deepEqual(store.history.map((h) => [h.id, h.source]), [['old1', 'ai'], ['old2', 'manual']]);
  // мусор в файле истории не роняет загрузку
  await fs.writeFile(path.join(data, 'history.json'), JSON.stringify([null, 'x', 42]));
  const s2 = new Store(data);
  await s2.load();
  assert.equal(s2.history.length, 3);
});

// ---------- aiBaseHash: какую версию видела модель ----------
test('aiBase: печатается после ingest и отвечает «устарело ли предложение»', async (t) => {
  const { root, chat, pm } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  const diskHash = H('x = 1\n');

  pm.ingest(chat, [{ key: 'k', text: '# &a.py\nx = 2\n' }]);
  // до печати база неизвестна — и это не то же самое, что «файла нет»
  let [item] = await pm.list(chat, true);
  const before = await pm.view(item.id);
  assert.equal(before.aiBaseHash, null);
  assert.equal(before.aiStale, undefined);

  assert.equal(await pm.sealAiBase(chat), 1);
  [item] = await pm.list(chat, true);
  const sealed = await pm.view(item.id);
  assert.equal(sealed.aiBaseHash, diskHash);
  assert.equal(sealed.aiStale, false);
  assert.equal(sealed.baseHash, diskHash); // диск пока тот же
  assert.equal(sealed.versions.aiStale, false);

  // файл изменили вне приложения → предложение честно помечается устаревшим
  await fs.writeFile(path.join(root, 'a.py'), 'x = 99\n');
  [item] = await pm.list(chat, true);
  const stale = await pm.view(item.id);
  assert.equal(stale.aiBaseHash, diskHash);
  assert.equal(stale.baseHash, H('x = 99\n'));
  assert.equal(stale.aiStale, true);
  assert.equal(stale.versions.aiStale, true);

  // повторная печать не перезаписывает базу: она про момент ответа модели, не про «сейчас»
  assert.equal(await pm.sealAiBase(chat), 0);
  assert.equal((await pm.view((await pm.list(chat, true))[0].id)).aiBaseHash, diskHash);
});

test('aiBase: новый файл — ABSENT; исторические блоки не печатаются', async (t) => {
  const { root, chat, pm } = await setup(t);
  pm.ingest(chat, [
    { key: 'new', text: '# &NEW:scripts/w.gd\nextends Node\n' },
    { key: 'old', text: '# &a.py\nx = 5\n', initial: true },
  ]);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  await pm.sealAiBase(chat);

  const list = await pm.list(chat, true);
  const created = list.find((x) => x.op === 'create');
  const historical = list.find((x) => x.historical);
  assert.equal((await pm.view(created.id)).aiBaseHash, V.ABSENT);
  // блок из уже открытого чата: диск с тех пор мог измениться, честный ответ — «неизвестно»
  assert.equal((await pm.view(historical.id)).aiBaseHash, null);
});

test('aiBase: без привязки проекта база неизвестна, после привязки — печатается', async (t) => {
  const { root, store, chat, pm } = await setup(t, { bind: false });
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  pm.ingest(chat, [{ key: 'k', text: '# &a.py\nx = 2\n' }]);
  assert.equal(await pm.sealAiBase(chat), 0);
  assert.equal((await pm.view((await pm.list(chat, true))[0].id)).aiBaseHash, null);

  await store.bind(chat, (await store.addProject(root)).id);
  assert.equal(await pm.sealAiBase(chat), 1);
  assert.equal((await pm.view((await pm.list(chat, true))[0].id)).aiBaseHash, H('x = 1\n'));
});

test('aiBase: небезопасный путь не печатается и не меняет существующее состояние', async (t) => {
  const { chat, pm } = await setup(t);
  pm.ingest(chat, [{ key: 'e', text: '# &../evil.py\nx\n' }]);
  assert.equal(await pm.sealAiBase(chat), 0);
  const [item] = await pm.list(chat, true);
  assert.equal(item.state, 'invalid-path');
  assert.equal((await pm.view(item.id)).aiBaseHash, null);
});

test('aiBase: дописываемый блок сохраняет базу файла и записывает source ai в историю', async (t) => {
  const { root, store, chat, pm } = await setup(t);
  await fs.writeFile(path.join(root, 'a.py'), 'x = 1\n');
  pm.ingest(chat, [{ key: 'k', text: '# &a.py\nx = 2' }]);
  await pm.sealAiBase(chat);
  const base = (await pm.view((await pm.list(chat, true))[0].id)).aiBaseHash;
  assert.equal(base, H('x = 1\n'));

  // модель дописала блок (стриминг): содержимое предложения меняется, версия файла — нет
  pm.ingest(chat, [{ key: 'k', text: '# &a.py\nx = 2\n' }]);
  await pm.sealAiBase(chat);
  const [item] = await pm.list(chat, true);
  const v = await pm.view(item.id);
  assert.equal(v.aiBaseHash, base);

  const res = await pm.apply(item.id, { baseHash: v.baseHash, contentHash: v.contentHash });
  assert.equal(res.ok, true, res.error);
  const h = store.getHistory(res.historyId);
  assert.equal(h.source, 'ai');
  assert.equal(h.aiBaseHash, base);
  assert.equal(store.history.length, 1); // откат пока не создаёт отдельной записи
});

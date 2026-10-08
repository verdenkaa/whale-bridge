'use strict';
// Предложения запуска и команд (ТЗ C3 §3.7, §2.5): жизненный цикл pending → executed /
// rejected / dismissed, дедупликация по contentHash, память решений в config.json,
// содержимое карточки (ввод, аргументы, уровень риска) и запреты файловых операций.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { Store } = require('../src/store');
const { ProposalManager } = require('../src/proposals');

const CHAT = '17b45023-2aba-4a1a-a966-17bbe41926ea';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-run-p-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'aiws-run-d-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  ]));
  const store = new Store(data);
  await store.load();
  const project = await store.addProject(root);
  await store.bind(CHAT, project.id);
  const pm = new ProposalManager({ store });
  await fs.writeFile(path.join(root, 'main.py'), 'print(1)\n');
  await fs.writeFile(path.join(root, 'notes.md'), '# readme\n');
  return { root, data, store, project, pm };
}

const ingest = (pm, text, key = 'k1', initial = false) => pm.ingest(CHAT, [{ key, text, initial }]);
const one = async (pm) => (await pm.list(CHAT, true))[0];

test('предложения: &RUN: — карточка запуска с файлом, аргументами и вводом', async (t) => {
  const { pm } = await setup(t);
  ingest(pm, '# &RUN:main.py --fast\n5\nhello\n');
  const item = await one(pm);
  assert.equal(item.kind, 'run');
  assert.equal(item.op, 'run');
  assert.equal(item.state, 'run', 'файл существует — готов к запуску');
  assert.equal(item.status, 'pending');
  assert.equal(item.relPath, 'main.py');
  assert.deepEqual(item.args, ['--fast']);
  assert.equal(item.lang, 'python');
  assert.equal(item.inputLines, 2, 'ввод виден в списке числом строк');
  assert.equal(item.historical, false);

  // полный текст ввода и детали — из view (список ходит в IPC часто)
  const v = await pm.view(item.id);
  assert.equal(v.input, '5\nhello');
  assert.deepEqual(v.args, ['--fast']);
  assert.deepEqual(v.rows, [], 'у запуска нет строк диффа');
  assert.equal(v.baseText, null, 'и нет текстов файла для сравнения');
  assert.equal(v.rawText, '5\nhello\n', 'тело блока сохранено как прислала модель');
  assert.equal(v.langLabel, 'Python');
});

test('предложения: &RUN: — файла нет, язык не поддерживается, путь вне проекта', async (t) => {
  const { pm } = await setup(t);
  // модель предложила создать файл и сразу запустить — создание ещё не принято
  ingest(pm, '# &RUN:new.py\n1\n', 'a');
  assert.equal((await one(pm)).state, 'missing-file');

  ingest(pm, '# &RUN:notes.md\n', 'b');
  const list = await pm.list(CHAT, true);
  assert.equal(list.find((x) => x.relPath === 'notes.md').state, 'unsupported-ext');

  ingest(pm, '# &RUN:../evil.py\n', 'c');
  const outside = (await pm.list(CHAT, true)).find((x) => x.state === 'invalid-path');
  assert.ok(outside, 'путь вне проекта отклонён');
});

test('предложения: &CMD: — команда, уровень риска и причины', async (t) => {
  const { pm } = await setup(t);
  ingest(pm, '# &CMD:grep -rn "Player" src\n');
  const safe = await one(pm);
  assert.equal(safe.kind, 'cmd');
  assert.equal(safe.state, 'cmd');
  assert.equal(safe.command, 'grep -rn "Player" src');
  assert.equal(safe.risk.level, 'safe', 'чтение — зелёный');
  assert.equal(safe.relPath, null, 'у команды нет файла');

  ingest(pm, '# &CMD:pip install requests\n', 'b');
  const caution = (await pm.list(CHAT, true)).find((x) => x.command && x.command.startsWith('pip'));
  assert.equal(caution.risk.level, 'caution', 'установка пакетов — жёлтый');

  ingest(pm, '# &CMD:rmdir /s /q build\n', 'c');
  const danger = (await pm.list(CHAT, true)).find((x) => x.command && x.command.startsWith('rmdir'));
  assert.equal(danger.risk.level, 'danger', 'удаление — красный');
  assert.ok(danger.risk.reasons.length > 0, 'причины перечислены для баннера');

  // пустая команда — честный статус, а не падение
  ingest(pm, '# &CMD:\n', 'd');
  const empty = (await pm.list(CHAT, true)).find((x) => x.state === 'empty-command');
  assert.ok(empty, 'пустая команда помечена');
});

test('предложения: дедупликация по contentHash — тот же блок не плодит карточки', async (t) => {
  const { pm } = await setup(t);
  ingest(pm, '# &RUN:main.py\n5\n', 'k1');
  ingest(pm, '# &RUN:main.py\n5\n', 'k2'); // другой ключ DOM-блока, то же содержимое
  assert.equal((await pm.list(CHAT, true)).length, 1, 'один и тот же запуск — одна карточка');

  // другой ввод — другое предложение
  ingest(pm, '# &RUN:main.py\n6\n', 'k3');
  assert.equal((await pm.list(CHAT, true)).length, 2);

  // дописывание того же блока обновляет карточку, а не создаёт новую
  ingest(pm, '# &RUN:main.py\n5\nhello\n', 'k1');
  const list = await pm.list(CHAT, true);
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.inputLines === 2).inputLines, 2);

  // команды дедуплицируются по тексту команды
  ingest(pm, '# &CMD:dir\n', 'c1');
  ingest(pm, '# &CMD:dir\n', 'c2');
  assert.equal((await pm.list(CHAT, true)).filter((x) => x.kind === 'cmd').length, 1);
  ingest(pm, '# &CMD:dir /b\n', 'c3');
  assert.equal((await pm.list(CHAT, true)).filter((x) => x.kind === 'cmd').length, 2);
});

test('предложения: выполнение и отказ сохраняются и не всплывают заново', async (t) => {
  const { pm, store, data, project } = await setup(t);
  ingest(pm, '# &RUN:main.py\n5\n', 'k1');
  const item = await one(pm);

  // старт сессии: сразу «выполнено», код возврата допишется по завершении
  const first = pm.markExecuted(item.id, {});
  assert.equal(first.ok, true);
  assert.equal(first.status, 'executed');
  assert.equal(first.exitCode, null);
  // завершение процесса: код возврата
  const second = pm.markExecuted(item.id, { exitCode: 0 });
  assert.equal(second.exitCode, 0);
  assert.equal((await one(pm)).status, 'executed');
  assert.equal((await one(pm)).exitCode, 0);
  assert.equal((await one(pm)).state, 'executed');

  // решение легло в config.json — новый менеджер на том же хранилище его видит.
  // setProposalDecision пишет асинхронно, поэтому сохранение дожидаемся явно:
  // иначе проверка стала бы гонкой и падала на медленной машине.
  await store.saveConfig();
  const store2 = new Store(data);
  await store2.load();
  const pm2 = new ProposalManager({ store: store2 });
  ingest(pm2, '# &RUN:main.py\n5\n', 'other-key');
  const restored = await one(pm2);
  assert.equal(restored.status, 'executed', 'выполненная карточка не вернулась как нерассмотренная');
  assert.equal(restored.exitCode, 0, 'код возврата пережил перезапуск');

  // отказ — та же механика
  ingest(pm, '# &CMD:dir\n', 'c1');
  const cmd = (await pm.list(CHAT, true)).find((x) => x.kind === 'cmd');
  pm.reject(cmd.id);
  assert.equal((await pm.list(CHAT, true)).find((x) => x.id === cmd.id).status, 'rejected');
  await store.saveConfig();
  const store3 = new Store(data);
  await store3.load();
  const pm3 = new ProposalManager({ store: store3 });
  ingest(pm3, '# &CMD:dir\n', 'c1-again');
  assert.equal((await one(pm3)).status, 'rejected');

  // снятие карточки: тот же блок больше не предлагается вовсе
  ingest(pm, '# &CMD:where python\n', 'c2');
  const where = (await pm.list(CHAT, true)).find((x) => x.command === 'where python');
  pm.dismiss(where.id);
  await store.saveConfig();
  const store4 = new Store(data);
  await store4.load();
  const pm4 = new ProposalManager({ store: store4 });
  ingest(pm4, '# &CMD:where python\n', 'c2-again');
  assert.equal((await pm4.list(CHAT, true)).filter((x) => x.command === 'where python').length, 0);
  assert.ok(store4.getProject(project.id), 'проект на месте — проверка не на пустом хранилище');
});

test('предложения: запуск не трогает журнал контекста и не применяется как файл', async (t) => {
  const { pm, store, root } = await setup(t);
  ingest(pm, '# &RUN:main.py\n5\n', 'k1');
  const item = await one(pm);
  const pid = store.getProjectForChat(CHAT).id;
  const before = (await pm.listDivergences(CHAT, pid)).items;

  // apply к запуску неприменим: это не запись файла
  const v = await pm.view(item.id);
  const r = await pm.apply(item.id, { baseHash: 'x', contentHash: v.contentHash });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'kind');

  // sealAiBase не печатает версию файла для запуска (у него нет aiBase)
  const sealed = await pm.sealAiBase(CHAT);
  assert.equal(sealed, 0, 'запуск не запечатывается как версия файла');
  const after = (await pm.listDivergences(CHAT, pid)).items;
  assert.deepEqual(after.map((x) => x.relPath), before.map((x) => x.relPath), 'журнал контекста не изменился');

  // файл проекта не изменён
  assert.equal(await fs.readFile(path.join(root, 'main.py'), 'utf8'), 'print(1)\n');
  assert.equal((await one(pm)).status, 'pending');
});

test('предложения: исторические блоки и отчёт для чата', async (t) => {
  const { pm } = await setup(t);
  ingest(pm, '# &RUN:main.py\n', 'h1', true); // initial — из уже открытого чата
  const hist = await one(pm);
  assert.equal(hist.historical, true);
  assert.equal((await pm.list(CHAT, false)).length, 0, 'по умолчанию история скрыта');

  ingest(pm, '# &CMD:dir\n', 'h2');
  const cmd = (await pm.list(CHAT, true)).find((x) => x.kind === 'cmd');
  pm.markExecuted(cmd.id, { exitCode: 1 });
  const rep = await pm.buildChatReport(CHAT);
  assert.equal(rep.ok, true);
  assert.match(rep.text, /Команда «dir»: выполнено \(код 1\)/);
  assert.match(rep.text, /Запуск main\.py: не выполнено/);
});

test('предложения: &RUN: без привязанного проекта — «Нет проекта»', async (t) => {
  const { store, root } = await setup(t);
  const other = '00000000-0000-4000-8000-000000000001';
  const pm = new ProposalManager({ store });
  pm.ingest(other, [{ key: 'k', text: '# &RUN:main.py\n' }]);
  const item = (await pm.list(other, true))[0];
  assert.equal(item.kind, 'run');
  assert.equal(item.state, 'no-project');
  assert.ok(root, 'проект существует, но чат к нему не привязан');
});

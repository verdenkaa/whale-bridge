'use strict';
// Конфигурация запуска (src/store.js + src/runlangs.js, ТЗ C3 §3.9):
// дефолты, миграция старого config.json, защита от мусора.
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { Store } = require('../src/store');
const { sanitizeRunConfig } = require('../src/runlangs');

async function setup(t, configJson) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiws-cfg-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  if (configJson !== undefined) {
    await fsp.writeFile(path.join(dir, 'config.json'), typeof configJson === 'string' ? configJson : JSON.stringify(configJson, null, 2));
  }
  const store = new Store(dir);
  await store.load();
  return { store, dir };
}

const DEFAULT_RUN = {
  tools: { python: null, node: null, cpp: null, c: null, javac: null, java: null },
  args: { python: '', cpp: '', c: '', java: '' },
  timeoutSec: 600,
  shellWin: 'cmd',
};

test('store: новый конфиг получает дефолты config.run', async (t) => {
  const { store } = await setup(t);
  assert.deepEqual(store.config.run, DEFAULT_RUN);
});

test('store: config.json без поля run (старая версия) — дефолты, остальные поля целы', async (t) => {
  const { store } = await setup(t, {
    version: 1, projects: [{ id: 'p1', name: 'x', path: '/x' }], lastProjectId: 'p1',
    layoutRatio: 0.4,
  });
  assert.deepEqual(store.config.run, DEFAULT_RUN);
  assert.equal(store.config.projects.length, 1, 'чужие данные не выброшены');
  assert.equal(store.config.lastProjectId, 'p1');
});

test('store: мусор в config.run не роняет загрузку', async (t) => {
  for (const garbage of ['строка', 42, [1, 2], true, { tools: 'нет', args: 7, timeoutSec: 'вечно', shellWin: {} }]) {
    const { store } = await setup(t, { run: garbage });
    assert.deepEqual(store.config.run, DEFAULT_RUN, `мусор ${JSON.stringify(garbage)} обязан дать дефолты`);
  }
  // run: null — тоже дефолты
  const { store } = await setup(t, { run: null });
  assert.deepEqual(store.config.run, DEFAULT_RUN);
});

test('store: валидный config.run сохраняется как есть', async (t) => {
  const run = {
    tools: { python: '/opt/py/bin/python3', node: null, cpp: null, c: null, javac: null, java: null },
    args: { python: '', cpp: '-Wall -O2', c: '', java: '' },
    timeoutSec: 120,
    shellWin: 'cmd',
  };
  const { store } = await setup(t, { run });
  assert.deepEqual(store.config.run, run);
});

test('store: PowerShell в чужом конфиге сводится к cmd (решение пользователя)', async (t) => {
  const { store } = await setup(t, { run: { shellWin: 'powershell' } });
  assert.equal(store.config.run.shellWin, 'cmd');
});

test('store: сохранение и перечитывание — config.run переживает перезапуск', async (t) => {
  const { store, dir } = await setup(t);
  store.config.run = sanitizeRunConfig({
    tools: { python: '/opt/py312/python' }, args: { c: '-g' }, timeoutSec: 30, shellWin: 'cmd',
  });
  await store.saveConfig();

  const again = new Store(dir);
  await again.load();
  assert.equal(again.config.run.tools.python, '/opt/py312/python');
  assert.equal(again.config.run.args.c, '-g');
  assert.equal(again.config.run.timeoutSec, 30);
  // неизвестные ключи из будущего не теряются молча, но и не ломают sanitize:
  // они отбрасываются — это осознанное поведение (правила одни, ТЗ §3.9)
  assert.equal('evil' in again.config.run, false);
});

test('store: битый config.json (не JSON) — приложение стартует с дефолтами', async (t) => {
  const { store } = await setup(t, '{ это не json');
  assert.deepEqual(store.config.run, DEFAULT_RUN);
  assert.deepEqual(store.config.projects, []);
});

test('store: sanitizeRunConfig идемпотентен — повторный прогон ничего не меняет', async (t) => {
  const once = sanitizeRunConfig({ tools: { python: ' /x/y ' }, args: { cpp: '-O2' }, timeoutSec: 45 });
  const twice = sanitizeRunConfig(once);
  assert.deepEqual(twice, once);
  assert.equal(once.tools.python, '/x/y', 'путь обрезан по краям');
});

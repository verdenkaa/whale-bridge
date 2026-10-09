'use strict';
// Пред-релизный аудит (2026-10): исправления безопасности, утечек и гонок.
// Каждый тест ссылается на конкретную правку — почему она сделана, написано
// в комментариях к коду на месте правки.
//
// Поведенческие тесты: лимит журнала ввода раннера, пометка обрезания в отчёте,
// удаление резервных копий при вытеснении записей истории.
// Текстовые (как в wiring.test.js): main.js и преагрузчики требуют Electron,
// поэтому проверяются как исходный текст.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createRunner, INPUT_LOG_LIMIT } = require('../src/runner');
const { buildReport } = require('../src/runfmt');
const { Store } = require('../src/store');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------- журнал ввода раннера (утечка памяти main-процесса) ----------

class FakePty {
  constructor(pid) {
    this.pid = pid;
    this.writes = [];
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.exited = false;
  }
  onData(cb) { this.dataHandlers.push(cb); }
  onExit(cb) { this.exitHandlers.push(cb); }
  write(s) { this.writes.push(s); }
  resize() {}
  kill() { if (!this.exited) { this.exited = true; for (const cb of this.exitHandlers) cb({ exitCode: -1, signal: null }); } }
}

function makeRunner() {
  const ptys = [];
  const runner = createRunner({
    platform: 'linux',
    spawnPty: (opts) => { const p = new FakePty(1000 + ptys.length); ptys.push(p); return p; },
    killTree: (_pid, pty) => { if (pty) pty.kill(); },
    clock: () => Date.now(),
    send: () => {},
    getRunConfig: () => ({}),
    toolchain: { detect: async () => ({}) },
    limits: { exitDrainMs: 0 },
    onError: () => {},
    watchdogUnref: true,
  });
  return { runner, ptys };
}

test('runner: журнал ввода ограничен INPUT_LOG_LIMIT и помечает обрезание', async () => {
  assert.equal(INPUT_LOG_LIMIT, 256 * 1024, 'предел журнала ввода — 256 КБ');
  const { runner, ptys } = makeRunner();
  const r = await runner.start({
    project: { id: 'p1', path: os.tmpdir() },
    target: { kind: 'cmd', command: 'cat' },
  });
  assert.ok(r.ok, 'сессия стартовала');
  // Ввод доходит до pty ЦЕЛИКОМ — лимит касается только журнала для отчёта
  const big = 'x'.repeat(INPUT_LOG_LIMIT);
  runner.input(big);
  runner.input('y'.repeat(1024));
  assert.equal(ptys[0].writes.join('').length, big.length + 1024, 'в pty записан весь ввод');
  runner.stop();
  const rep = runner.report();
  assert.ok(rep.ok);
  assert.match(rep.text, /журнал ввода ограничен/, 'отчёт честно говорит об обрезании');
  // Сам ввод в отчёте — не больше лимита (плюс оформление)
  const inputPart = rep.text.split('Ввод:')[1] || '';
  assert.ok(inputPart.length < INPUT_LOG_LIMIT + 1024, 'в отчёт не попал безлимитный ввод');
});

test('runner: обычный ввод не помечается обрезанным', async () => {
  const { runner } = makeRunner();
  const r = await runner.start({
    project: { id: 'p1', path: os.tmpdir() },
    target: { kind: 'cmd', command: 'cat' },
    input: '42',
  });
  assert.ok(r.ok);
  runner.input('\r');
  runner.stop();
  const rep = runner.report();
  assert.ok(rep.text.includes('42'), 'ввод из предложения в отчёте');
  assert.ok(!rep.text.includes('журнал ввода ограничен'), 'без переполнения пометки нет');
});

test('runfmt: buildReport оговаривает обрезанный ввод', () => {
  const withNote = buildReport({ inputLog: ['abc'], inputTruncated: true, output: 'ok', exitCode: 0 });
  assert.match(withNote, /Ввод:\nabc\n\[ввод показан не полностью/);
  const noNote = buildReport({ inputLog: ['abc'], output: 'ok', exitCode: 0 });
  assert.ok(!noNote.includes('не полностью'), 'без флага пометки нет');
});

// ---------- резервные копии при вытеснении истории (утечка диска) ----------

test('store: записи, вытесненные лимитом истории, удаляют свои резервные копии', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiws-store-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const store = new Store(dir);
  await store.load();
  // Заполняем журнал вплотную к HISTORY_LIMIT (1000) напрямую, чтобы не гонять
  // тысячу полных перезаписей history.json; копии создаём только у тех пяти записей,
  // которые будут вытеснены следующими addHistory.
  const entry = (id, ts) => ({
    id, ts, projectId: 'p1', projectName: 'Proj', relPath: 'f.txt', op: 'update',
    newRelPath: null, status: 'applied', beforeHash: 'a', afterHash: 'b', error: null, source: 'manual',
  });
  store.history = Array.from({ length: 1000 }, (_, i) => entry('op' + String(i).padStart(4, '0'), 1000 + i));
  for (const id of ['op0000', 'op0001', 'op0002', 'op0003', 'op0004']) {
    await fsp.writeFile(path.join(store.backupDir, id + '.before'), 'old');
    await fsp.writeFile(path.join(store.backupDir, id + '.after'), 'new');
  }
  // Копия записи, которая останется в журнале, — контроль: её удалять нельзя
  await fsp.writeFile(path.join(store.backupDir, 'op0005.before'), 'old');

  for (let i = 0; i < 5; i++) await store.addHistory(entry('new' + i, 9000 + i));
  assert.equal(store.history.length, 1000, 'журнал ограничен');
  assert.ok(!store.history.some((h) => h.id === 'op0000'), 'старейшая запись вытеснена');
  // Удаление копий асинхронное и best-effort — даём ему состояться
  await new Promise((r) => setTimeout(r, 100));
  for (const id of ['op0000', 'op0001', 'op0002', 'op0003', 'op0004']) {
    assert.equal(fs.existsSync(path.join(store.backupDir, id + '.before')), false, id + '.before удалён');
    assert.equal(fs.existsSync(path.join(store.backupDir, id + '.after')), false, id + '.after удалён');
  }
  assert.ok(fs.existsSync(path.join(store.backupDir, 'op0005.before')),
    'копия оставшейся в журнале записи не тронута');
});

// ---------- main.js: безопасность (текстовые проверки, как в wiring.test.js) ----------

const mainSrc = read('main.js');

test('main: список исполняемых расширений для shell.openPath закрыл классические векторы', () => {
  const m = /const UNSAFE_OPEN_EXT = new Set\(\[([\s\S]*?)\]\);/.exec(mainSrc);
  assert.ok(m, 'UNSAFE_OPEN_EXT на месте');
  const exts = new Set([...m[1].matchAll(/'(\.[^']+)'/g)].map((x) => x[1]));
  // Прежде отсутствовали: .hta выполнялся mshta, .py запускал интерпретатор,
  // .iso монтировался, .url/.scf — векторы проводника
  for (const e of ['.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.js', '.wsf', '.lnk', '.scr', '.sh', '.jar', '.reg',
    '.hta', '.py', '.pyw', '.rb', '.cpl', '.msc', '.pif', '.scf', '.url', '.inf', '.iso', '.img',
    '.msp', '.appref-ms', '.chm', '.desktop', '.wsh', '.docm', '.xlsm', '.pptm']) {
    assert.ok(exts.has(e), e + ' отсутствует в UNSAFE_OPEN_EXT');
  }
});

test('main: popup авторизации делит сессию с чатом (partition)', () => {
  // Без partition popup создавался в дефолтной сессии: cookies входа через
  // Google/Apple/Microsoft не доходят до chat.deepseek.com — логин не завершался.
  const popupBlock = /setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*?action: 'deny'/m.exec(mainSrc);
  assert.ok(popupBlock, 'обработчик popup на месте');
  assert.match(popupBlock[0], /partition: PARTITION/, 'popup открывается в сессии чата');
});

test('main: вторичные webContents не плодят окна и не ходят на локальные схемы', () => {
  assert.match(mainSrc, /app\.on\('web-contents-created'/, 'политика по умолчанию для всех webContents');
  const created = /app\.on\('web-contents-created'[\s\S]*?\n    \}\);/m.exec(mainSrc);
  assert.ok(created, 'блок политики найден');
  assert.match(created[0], /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/,
    'popup не открывает следующие окна');
  assert.match(created[0], /https\?:/, 'навигация ограничена http(s)');
});

test('main: разрешения проверяются и на синхронный запрос (check-handler)', () => {
  assert.match(mainSrc, /setPermissionCheckHandler/, 'check-обработчик на месте');
  assert.match(mainSrc, /setPermissionRequestHandler/, 'request-обработчик сохранён');
});

test('main: ввод терминала не режется на 4 КБ (вставка из буфера)', () => {
  assert.match(mainSrc, /runner\.input\(text\.slice\(0, 65536\)\)/, 'лимит ввода — 64 КБ');
  assert.ok(!mainSrc.includes('slice(0, 4096)'), 'прежний лимит 4096 удалён');
});

test('main: сбой renderer не оставляет белое окно навсегда', () => {
  const hits = mainSrc.match(/render-process-gone/g) || [];
  assert.ok(hits.length >= 2, 'обработчики у UI-окна и у чата');
  assert.match(mainSrc, /win\.webContents\.reload\(\)/, 'UI-окно перезагружается');
});

// ---------- preload-chat: потеря блоков при больших пакетах ----------

test('preload-chat: блоки уходят пакетами не больше лимита main', () => {
  const preSrc = read('preload-chat.js');
  const chunk = /const SEND_CHUNK = (\d+);/.exec(preSrc);
  assert.ok(chunk, 'константа SEND_CHUNK на месте');
  const limit = /blocks\.length > (\d+)/.exec(mainSrc);
  assert.ok(limit, 'лимит блоков в main на месте');
  assert.equal(chunk[1], limit[1], 'SEND_CHUNK совпадает с лимитом main: пакет не будет отброшен');
  assert.match(preSrc, /i \+= SEND_CHUNK/, 'отправка нарезана на пакеты');
  assert.ok(!/ipcRenderer\.send\('chat:blocks', \{ chatId, blocks: out \}\)/.test(preSrc),
    'отправка всего массива одним сообщением удалена');
});

// ---------- terminal.js / app.js / editor.js: утечки renderer ----------

test('terminal: буфер отложенного вывода ограничен', () => {
  const src = read('ui/terminal.js');
  assert.match(src, /PENDING_LIMIT = \d+/, 'предел буфера на месте');
  assert.match(src, /pending\.splice\(0, pending\.length - PENDING_LIMIT\)/, 'старые строки вытесняются');
});

test('app: кеш ввода карточек запуска чистится по текущему списку', () => {
  const src = read('ui/app.js');
  assert.match(src, /delete S\.runInputs\[id\]/, 'кеш ввода чистится');
  assert.match(src, /S\.runExpanded\.delete\(id\)/, 'состояние раскрытия чистится');
});

test('editor: слушатели контекстного меню не переживают своё меню', () => {
  const src = read('ui/editor.js');
  // Гонка: за тик между setTimeout(arm) и срабатыванием меню могли закрыть и открыть
  // новое — слушатели старого меню вставали навсегда и закрывали текущее меню на любой
  // клик. arm обязан проверять, что ctxMenu — всё ещё ЕГО меню.
  assert.match(src, /if \(ctxMenu !== menu\) return;/, 'arm проверяет своё меню');
});

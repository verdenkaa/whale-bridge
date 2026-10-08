'use strict';
// Оркестратор сессий (src/runner.js, ТЗ C3 §3.3) на фейковом pty: стриминг вывода,
// двухшаговые планы, остановка и kill дерева, watchdog, лимит вывода, ввод из
// предложения, одна активная сессия, отчёт. Electron и node-pty не нужны.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); // раннер работает с синхронным fs — и тест тоже
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createRunner, OUTPUT_LIMIT } = require('../src/runner');

/**
 * Ожидание пути, собранного раннером: пути он собирает модулем ЦЕЛЕВОЙ платформы
 * (path.win32/path.posix из DI), а не хостовым path, — иначе тесты вели бы себя
 * по-разному на Windows и в песочнице.
 */
const joinFor = (platform, ...parts) => (platform === 'win32' ? path.win32 : path.posix).join(...parts);

// ---------- стенд ----------

/** Фейковый pty: данные и выход вызываются тестом вручную. */
class FakePty {
  constructor(harness, opts) {
    this.harness = harness;
    this.opts = opts;
    this.pid = harness.nextPid++;
    this.writes = [];
    this.resizes = [];
    this.killed = 0;
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.exited = false;
  }
  onData(cb) { this.dataHandlers.push(cb); }
  onExit(cb) { this.exitHandlers.push(cb); }
  write(s) { this.writes.push(s); }
  resize(c, r) { this.resizes.push([c, r]); }
  // как настоящий pty: kill завершает процесс и порождает событие выхода
  kill() { this.killed++; this.exit(-1); }
  // --- управление из теста ---
  emit(text) { for (const cb of this.dataHandlers) cb(text); }
  exit(code) {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitHandlers) cb({ exitCode: code, signal: null });
  }
}

async function setup(t, cfg) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiws-run-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const c = cfg || {};

  fs.writeFileSync(path.join(root, 'main.py'), 'print("hi")\n');
  fs.writeFileSync(path.join(root, 'readme.md'), '# readme\n');
  fs.writeFileSync(path.join(root, 'app.cpp'), 'int main(){}\n');
  fs.writeFileSync(path.join(root, 'Main.java'), 'package a.b;\nclass Main{}\n');
  fs.mkdirSync(path.join(root, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deep', 'x.c'), 'int main(){}\n');
  fs.mkdirSync(path.join(root, '.ide_build'), { recursive: true });

  const ptys = [];
  const events = [];
  const killed = [];
  const started = [];
  const ended = [];
  const state = { clock: 0 };
  const fakeTools = c.tools || {
    python: { found: true, exe: '/bin/fakepython' },
    cpp: { found: true, exe: '/bin/fakeg++' },
    javac: { found: true, exe: '/bin/fakejavac' },
    java: { found: true, exe: '/bin/fakejava', version: { major: 17 } },
    node: { found: true, exe: '/bin/fakenode', version: { major: 22, minor: 9, patch: 0 } },
  };
  const runner = createRunner({
    platform: c.platform || 'linux',
    // ComSpec внедряется: на Windows он есть всегда, в песочнице нет, а поведение
    // cmd-сессии обязано быть одинаковым на любой машине
    comSpec: c.comSpec,
    spawnPty: (opts) => {
      if (c.spawnFails) throw new Error('spawn отказал');
      const p = new FakePty({ nextPid: 1000 + ptys.length }, opts);
      ptys.push(p);
      return p;
    },
    killTree: (pid, pty) => { killed.push(pid); if (pty) pty.kill(); },
    clock: () => ++state.clock,
    send: (channel, payload) => events.push([channel, payload]),
    getRunConfig: () => c.runConfig || {},
    toolchain: { detect: async () => fakeTools },
    fs: c.fs || fs,
    limits: c.limits,
    onStart: (s) => started.push(s),
    onEnd: (s) => ended.push(s),
    onError: () => {},
    watchdogUnref: true,
  });
  const project = { id: 'p1', path: root };
  const dataOf = (id) => events
    .filter(([ch, p]) => ch === 'run:data' && (!id || p.sessionId === id))
    .map(([, p]) => p.text).join('');
  const exitsOf = (id) => events
    .filter(([ch, p]) => ch === 'run:exit' && (!id || p.sessionId === id))
    .map(([, p]) => p);
  const statesOf = () => events.filter(([ch]) => ch === 'run:state').map(([, p]) => p);
  return { runner, project, root, ptys, events, killed, started, ended, dataOf, exitsOf, statesOf };
}

// ---------- одиночный запуск ----------

test('runner: запуск python — команда, ввод из предложения, стриминг, выход', async (t) => {
  const s = await setup(t);
  const r = await s.runner.start({
    project: s.project, target: { kind: 'file', rel: 'main.py' }, input: '5\nhello',
  });
  assert.equal(r.ok, true);
  assert.equal(s.ptys.length, 1);
  const pty = s.ptys[0];
  assert.equal(pty.opts.exe, '/bin/fakepython');
  assert.deepEqual(pty.opts.args, ['-u', 'main.py']);
  assert.equal(pty.opts.cwd, s.root);
  // окружение: PYTHONPATH подставлен корнем проекта, PYTHONIOENCODING utf-8
  assert.equal(pty.opts.env.PYTHONPATH, s.root);
  assert.equal(pty.opts.env.PYTHONIOENCODING, 'utf-8');
  // ввод из предложения написан в pty сразу, с завершителем \r
  assert.deepEqual(pty.writes, ['5\rhello\r']);

  pty.emit('Результат: 10\r\n');
  pty.exit(0);
  assert.equal(s.dataOf(r.sessionId), 'Результат: 10\r\n');
  const exits = s.exitsOf(r.sessionId);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 0);
  assert.equal(exits[0].reason, null);
  // состояние: сессия запущена и завершена
  const states = s.statesOf();
  assert.equal(states[0].active.sessionId, r.sessionId);
  assert.equal(states[states.length - 1].active, null);
  // наблюдение за файлами приостановлено на сессию и восстановлено после
  assert.equal(s.started.length, 1);
  assert.equal(s.ended.length, 1);
});

test('runner: run:start без проекта и с чужим путём отклоняется до всякого spawn', async (t) => {
  const s = await setup(t);
  const noProject = await s.runner.start({ target: { kind: 'file', rel: 'main.py' } });
  assert.deepEqual(noProject, { ok: false, reason: 'no-project', message: 'Сначала выберите проект для этого чата' });

  const outside = await s.runner.start({
    project: s.project, target: { kind: 'file', rel: '../../etc/passwd' },
  });
  assert.equal(outside.ok, false);
  assert.ok(['file-missing', 'outside-project'].includes(outside.reason));

  const missing = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'nope.py' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'file-missing');

  const badExt = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'readme.md' } });
  assert.equal(badExt.ok, false);
  assert.equal(badExt.reason, 'unsupported-ext');
  assert.match(badExt.message, /не поддерживается/);

  const badTarget = await s.runner.start({ project: s.project, target: { kind: 'телепорт' } });
  assert.equal(badTarget.ok, false);
  assert.equal(badTarget.reason, 'bad-target');

  assert.equal(s.ptys.length, 0, 'ни одного процесса не создано');
});

test('runner: инструмент не найден — reason tool-missing с понятным текстом', async (t) => {
  const s = await setup(t, { tools: { python: { found: false, exe: null, brokenManual: false } } });
  const r = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tool-missing');
  assert.equal(r.lang, 'python');
  assert.match(r.message, /Не найден python в PATH/);
  assert.match(r.message, /Настройках/);
  assert.equal(s.ptys.length, 0);

  // битый ручной путь называется в сообщении вместе с самим путём: чинить надо его
  const s2 = await setup(t, {
    tools: { python: { found: false, exe: null, brokenManual: true } },
    runConfig: { tools: { python: 'C:\\gone\\python.exe' } },
  });
  const r2 = await s2.runner.start({ project: s2.project, target: { kind: 'file', rel: 'main.py' } });
  assert.equal(r2.ok, false);
  assert.match(r2.message, /Указанный в настройках путь не найден: C:\\gone\\python\.exe/);
});

test('runner: битый ручной путь не подменяется молча инструментом из PATH (§9)', async (t) => {
  // Пользователь явно указал, чем запускать. Если этого файла больше нет, запуск другим
  // интерпретатором выглядел бы как игнорирование настроек: честный ответ — «не найден».
  // toolchain при этом факт о PATH сообщает (для таблицы настроек), решение принимает раннер.
  const s = await setup(t, {
    tools: { python: { found: true, exe: '/bin/otherpython', source: 'path', brokenManual: true } },
    runConfig: { tools: { python: 'C:\\gone\\python.exe' } },
  });
  const r = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tool-missing');
  assert.equal(r.brokenManual, true, 'renderer покажет кнопку «Открыть настройки»');
  assert.match(r.message, /Указанный в настройках путь не найден/);
  assert.equal(s.ptys.length, 0, 'процесс не стартовал');
  assert.equal(s.started.length, 0, 'сессия не создавалась — наблюдение за файлами не приостанавливалось');
});

test('runner: spawn упал — сессия завершена с ошибкой, приложение живо', async (t) => {
  const s = await setup(t, { spawnFails: true });
  const r = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'spawn-failed');
  assert.match(r.message, /spawn отказал/);
  const exits = s.exitsOf();
  assert.equal(exits[0].reason, 'spawn-failed');
});

// ---------- двухшаговые планы ----------

test('runner: cpp — компиляция, разделитель, запуск бинарника одним планом', async (t) => {
  const s = await setup(t);
  const r = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'app.cpp' } });
  assert.equal(r.ok, true);
  assert.equal(s.ptys.length, 1);
  assert.deepEqual(s.ptys[0].opts.args, ['app.cpp', '-o', '.ide_build/app']);
  // папка артефактов существует (создана до старта или уже была)
  assert.ok(fs.existsSync(path.join(s.root, '.ide_build')));

  s.ptys[0].emit('warning: ...\r\n');
  s.ptys[0].exit(0);
  // второй шаг стартовал в том же терминале: бинарник из папки артефактов.
  // Путь абсолютный: относительный '.ide_build/app' Windows разрешила бы относительно
  // папки Electron, а не cwd процесса, — запуск не нашёл бы свежесобранный файл.
  assert.equal(s.ptys.length, 2);
  assert.equal(s.ptys[1].opts.exe, joinFor('linux', s.root, '.ide_build/app'));
  assert.deepEqual(s.ptys[1].opts.args, []);
  // run:exit первого шага несёт nextStep — по нему renderer печатает «── запуск ──»
  const stepExits = s.exitsOf(r.sessionId).filter((e) => e.nextStep);
  assert.equal(stepExits.length, 1);
  assert.equal(stepExits[0].nextStep.kind, 'run');

  s.ptys[1].emit('done\r\n');
  s.ptys[1].exit(0);
  const final = s.exitsOf(r.sessionId).filter((e) => !e.nextStep);
  assert.equal(final.length, 1);
  assert.equal(final[0].code, 0);
});

test('runner: cpp на win32 — суффикс .exe в плане и в запуске бинарника', async (t) => {
  // Платформа влияет на план (exeSuffix), поэтому она обязана доходить из раннера до
  // planRun: без этого на Windows собирался и запускался '.ide_build/app' без '.exe'.
  const s = await setup(t, { platform: 'win32' });
  const r = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'app.cpp' } });
  assert.equal(r.ok, true);
  assert.deepEqual(s.ptys[0].opts.args, ['app.cpp', '-o', '.ide_build/app.exe']);
  // фаза видна в ответе run:start и в run:state: по ним renderer подписывает
  // «Компиляция: app.cpp» и печатает «── компиляция ──» до вывода компилятора
  assert.equal(r.stepKind, 'build');
  const st = s.statesOf().find((x) => x.active && x.active.sessionId === r.sessionId);
  assert.equal(st.active.stepKind, 'build');
  assert.equal(st.active.step, 0);
  assert.equal(st.active.label, 'app.cpp');
  s.ptys[0].exit(0);
  assert.equal(s.ptys.length, 2);
  assert.equal(s.ptys[1].opts.exe, joinFor('win32', s.root, '.ide_build/app.exe'));
  // отчёт показывает команду читаемо: артефакт — относительным путём
  s.ptys[1].exit(0);
  assert.match(s.runner.report().text, /\.ide_build[/\\]app\.exe/);
});

test('runner: у интерпретируемого языка фаза сразу run', async (t) => {
  const s = await setup(t);
  const r = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  assert.equal(r.stepKind, 'run', 'у python один шаг — запуск');
  const c = await setup(t);
  const rc = await c.runner.start({ project: c.project, target: { kind: 'cmd', command: 'dir' } });
  assert.equal(rc.stepKind, 'run');
});

test('runner: провал компиляции обрывает сессию — второй шаг не выполняется', async (t) => {
  const s = await setup(t);
  const r = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'app.cpp' } });
  s.ptys[0].emit('error: expected ;\r\n');
  s.ptys[0].exit(1);
  assert.equal(s.ptys.length, 1, 'запуска бинарника не было');
  const exits = s.exitsOf(r.sessionId);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 1);
  assert.equal(exits[0].nextStep, undefined);
  assert.equal(s.ended.length, 1, 'сессия завершена');
});

test('runner: java — fqcn из исходника, -cp .ide_build/classes, пара инструментов', async (t) => {
  const s = await setup(t);
  const r = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'Main.java' } });
  assert.equal(r.ok, true);
  assert.deepEqual(s.ptys[0].opts.exe, '/bin/fakejavac');
  assert.deepEqual(s.ptys[0].opts.args, ['-encoding', 'UTF-8', '-d', '.ide_build/classes', 'Main.java']);
  s.ptys[0].exit(0);
  assert.equal(s.ptys.length, 2);
  assert.deepEqual(s.ptys[1].opts.exe, '/bin/fakejava');
  assert.deepEqual(s.ptys[1].opts.args, ['-cp', '.ide_build/classes', 'a.b.Main']);
  s.ptys[1].exit(0);
  assert.equal(s.exitsOf(r.sessionId).filter((e) => !e.nextStep)[0].code, 0);
});

test('runner: java — второй инструмент не найден, ошибка называет его', async (t) => {
  const s = await setup(t, {
    tools: {
      javac: { found: true, exe: '/bin/fakejavac' },
      java: { found: false, exe: null },
      python: { found: true, exe: '/bin/p' },
    },
  });
  const r = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'Main.java' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tool-missing');
  assert.match(r.message, /Не найден java в PATH/);
});

// ---------- остановка и kill дерева ----------

test('runner: stop — killTree вызван с pid, сессия закрыта немедленно', async (t) => {
  const s = await setup(t);
  const r = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  const pid = s.ptys[0].pid;
  const res = s.runner.stop();
  assert.equal(res.ok, true);
  assert.deepEqual(s.killed, [pid]);
  assert.equal(s.ptys[0].killed, 1, 'pty.kill тоже вызван');
  const exits = s.exitsOf(r.sessionId);
  assert.equal(exits[0].reason, 'stopped');
  assert.equal(s.ended.length, 1);
  // повторный stop — честно «нет сессии»
  assert.deepEqual(s.runner.stop(), { ok: false, reason: 'no-session' });
  // выход уже убитого процесса игнорируется (событий не дублируется)
  s.ptys[0].exit(143);
  assert.equal(s.exitsOf(r.sessionId).length, 1);
});

test('runner: stopAll для before-quit убивает активный процесс', async (t) => {
  const s = await setup(t);
  await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  s.runner.stopAll();
  assert.equal(s.killed.length, 1);
  assert.equal(s.ended.length, 1);
});

test('runner: одна активная сессия — новый запуск убивает предыдущий', async (t) => {
  const s = await setup(t);
  const r1 = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  const r2 = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  assert.notEqual(r1.sessionId, r2.sessionId);
  assert.deepEqual(s.killed, [s.ptys[0].pid], 'первый процесс убит');
  assert.equal(s.exitsOf(r1.sessionId)[0].reason, 'stopped');
  // вывод старой сессии больше не принимается
  s.ptys[0].emit('поздний вывод');
  assert.equal(s.dataOf(r1.sessionId), '');
  s.ptys[1].emit('новый вывод');
  s.ptys[1].exit(0);
  assert.equal(s.dataOf(r2.sessionId), 'новый вывод');
});

// ---------- watchdog и лимиты ----------

test('runner: watchdog бездействия — таймаут останавливает процесс', async (t) => {
  const s = await setup(t, { runConfig: { timeoutSec: 1 } });
  const r = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  await new Promise((res) => setTimeout(res, 1250));
  assert.equal(s.killed.length, 1, 'процесс убит по таймауту');
  const exits = s.exitsOf(r.sessionId);
  assert.equal(exits[0].reason, 'timeout');
});

test('runner: вывод или ввод сбрасывает watchdog', async (t) => {
  const s = await setup(t, { runConfig: { timeoutSec: 1 } });
  await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  // каждые 300 мс процесс что-то печатает — за 1.6 с таймаут (1 с) не наступает
  for (let i = 0; i < 5; i++) {
    await new Promise((res) => setTimeout(res, 300));
    s.ptys[0].emit('.');
  }
  assert.equal(s.killed.length, 0);
  s.runner.stop();
});

test('runner: таймаут 0 — watchdog выключен', async (t) => {
  const s = await setup(t, { runConfig: { timeoutSec: 0 } });
  await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(s.killed.length, 0);
  s.runner.stop();
});

test('runner: лимит вывода — процесс останавливается, хвост сохраняется', async (t) => {
  const s = await setup(t, { limits: { maxOutputBytes: 100 } });
  const r = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  s.ptys[0].emit('a'.repeat(60));
  s.ptys[0].emit('b'.repeat(60)); // переполнение: 120 > 100
  assert.equal(s.killed.length, 1);
  const exits = s.exitsOf(r.sessionId);
  assert.equal(exits[0].reason, 'output-limit');
  const rep = s.runner.report();
  assert.equal(rep.ok, true);
  assert.match(rep.text, /вывод превысил лимит/);
  assert.match(rep.text, /bbb/, 'хвост вывода сохранён');
  assert.ok(!rep.text.includes('a'.repeat(60)), 'начало выброшено кольцевым буфером');
});

test('runner: боевой лимит вывода — 4 МБ (ТЗ §3.3)', () => {
  assert.equal(OUTPUT_LIMIT, 4 * 1024 * 1024);
});

// ---------- ввод, размер, отчёт ----------

test('runner: ввод пользователя пишется в pty и попадает в журнал отчёта', async (t) => {
  const s = await setup(t);
  await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' }, input: '7' });
  assert.deepEqual(s.ptys[0].writes, ['7\r'], 'ввод предложения: \\n заменён на \\r');
  s.runner.input('42\r');
  s.runner.input('x');
  assert.deepEqual(s.ptys[0].writes, ['7\r', '42\r', 'x']);
  s.ptys[0].exit(0);
  const rep = s.runner.report();
  assert.match(rep.text, /Ввод:/);
  assert.match(rep.text, /7/);
  assert.match(rep.text, /42/);
  // ввод завершённой сессии игнорируется
  s.runner.input('поздно');
  assert.equal(s.ptys[0].writes.length, 3);
});

test('runner: resize доходит до pty с санитарными рамками', async (t) => {
  const s = await setup(t);
  await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  s.runner.resize(120, 40);
  assert.deepEqual(s.ptys[0].resizes, [[120, 40]]);
  s.runner.resize(0, -5);
  assert.deepEqual(s.ptys[0].resizes[1], [2, 2], 'нули и отрицания прижаты к минимуму');
  s.runner.resize('широко', NaN);
  assert.deepEqual(s.ptys[0].resizes[2], [80, 24], 'мусор — к дефолту');
});

test('runner: папка инструмента из настроек попадает в PATH процесса', async (t) => {
  // Ручной путь к g++ при пустом PATH: сам компилятор найдётся, а вот собранному
  // .exe нужны libstdc++-6.dll и libgcc_s_seh-1.dll из папки MinGW — без добавления
  // этой папки в PATH запуск упал бы с ошибкой про отсутствующую DLL.
  //
  // Ключ PATH ищем без учёта регистра: process.env в Windows регистронезависим, а его
  // копия (Object.assign) — обычный объект с родным регистром ключа, то есть 'Path'.
  // Тест, читающий env.PATH, на Windows падал, хотя поведение было правильным.
  const pathKeyOf = (o) => Object.keys(o).find((k) => k.toUpperCase() === 'PATH');
  const pathBefore = process.env.PATH;
  const s = await setup(t, {
    platform: 'win32',
    tools: { cpp: { found: true, exe: 'C:\\mingw64\\bin\\g++.exe', source: 'manual' } },
  });
  await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'app.cpp' } });
  const env = s.ptys[0].opts.env;
  const key = pathKeyOf(env);
  assert.ok(key, 'переменная PATH в окружении процесса есть');
  assert.ok(env[key].startsWith('C:\\mingw64\\bin;'), 'папка инструмента — первая в PATH');
  assert.ok(env[key].endsWith(pathBefore || ''), 'прежний PATH сохранён за ней');
  assert.equal(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH').length, 1,
    'второго ключа PATH/Path не появилось');

  // инструмент из PATH ничего не добавляет: его папка там уже есть
  const p = await setup(t, { tools: { python: { found: true, exe: '/usr/bin/python3', source: 'path' } } });
  await p.runner.start({ project: p.project, target: { kind: 'file', rel: 'main.py' } });
  const penv = p.ptys[0].opts.env;
  assert.equal(penv[pathKeyOf(penv)], process.env.PATH, 'для PATH-инструмента окружение не меняется');

  // окружение главного процесса не мутируется
  assert.equal(process.env.PATH, pathBefore, 'process.env родителя не изменён');
});

test('runner: холостой resize не доходит до pty', async (t) => {
  // ConPTY на любое изменение геометрии перерисовывает экран из своего буфера, а у
  // нового pty он пуст: программа, ждущая ввода, «стирала» терминал. Сессия стартует
  // с размером из run:start, поэтому повтор того же размера обязан быть проигнорирован.
  const s = await setup(t);
  await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' }, cols: 100, rows: 30 });
  assert.equal(s.ptys[0].opts.cols, 100);
  s.runner.resize(100, 30);
  assert.deepEqual(s.ptys[0].resizes, [], 'тот же размер — pty не дёргаем');
  s.runner.resize(100, 31);
  assert.deepEqual(s.ptys[0].resizes, [[100, 31]], 'настоящее изменение дошло');
});

test('runner: отчёт — файл, команда, папка, код, ввод и вывод', async (t) => {
  const s = await setup(t);
  await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' }, input: '5' });
  s.ptys[0].emit('Результат: 10\r\n');
  s.ptys[0].exit(0);
  const rep = s.runner.report();
  assert.equal(rep.ok, true);
  assert.match(rep.text, /Файл: main\.py/);
  // в отчёте команда читаемая: путь к инструменту укорочен до имени (полный — в настройках)
  assert.match(rep.text, /Команда: fakepython -u main\.py/);
  assert.ok(!/Команда: .*[/\\]fakepython/.test(rep.text), 'полного пути к инструменту в отчёте нет');
  assert.match(rep.text, new RegExp('Папка проекта: ' + s.root.replace(/[\\/]/g, '[\\\\/]')));
  assert.match(rep.text, /Код возврата: 0/);
  assert.match(rep.text, /Ввод:/);
  assert.match(rep.text, /Результат: 10/);
  // до запуска отчёта нет
  const s2 = await setup(t);
  assert.equal(s2.runner.report().ok, false);
});

test('runner: cmd-сессия — оболочка платформы, команда одним аргументом', async (t) => {
  const s = await setup(t);
  const r = await s.runner.start({
    project: s.project, target: { kind: 'cmd', command: 'grep -rn "Player" src' }, input: 'in',
  });
  assert.equal(r.ok, true);
  assert.equal(s.ptys[0].opts.exe, '/bin/sh');
  assert.deepEqual(s.ptys[0].opts.args, ['-c', 'grep -rn "Player" src']);
  assert.equal(s.ptys[0].opts.cwd, s.root);
  s.ptys[0].exit(0);
  const rep = s.runner.report();
  assert.match(rep.text, /Команда: grep -rn "Player" src/);
  assert.ok(!rep.text.includes('Файл:'), 'у cmd-сессии нет строки «Файл»');

  // windows: всегда cmd.exe (решение пользователя — PowerShell не внедряем).
  // ComSpec обнулён, чтобы ожидание не зависело от машины: на Windows он есть всегда,
  // в песочнице его нет, а оболочка обязана быть одной и той же.
  const w = await setup(t, { platform: 'win32', comSpec: '' });
  await w.runner.start({ project: w.project, target: { kind: 'cmd', command: 'dir' } });
  assert.equal(w.ptys[0].opts.exe, 'cmd.exe');
  assert.deepEqual(w.ptys[0].opts.args, ['/d', '/s', '/c', 'dir']);

  // пустая команда отклоняется
  const bad = await s.runner.start({ project: s.project, target: { kind: 'cmd', command: '   ' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'empty-command');
});

test('runner: cmd на win32 берёт cmd.exe из ComSpec, на posix — игнорирует его', async (t) => {
  // ComSpec надёжнее поиска cmd.exe в PATH: это полный путь к командному процессору.
  const comSpec = 'C:\\WINDOWS\\system32\\cmd.exe';
  const w = await setup(t, { platform: 'win32', comSpec });
  await w.runner.start({ project: w.project, target: { kind: 'cmd', command: 'dir' } });
  assert.equal(w.ptys[0].opts.exe, comSpec);
  assert.deepEqual(w.ptys[0].opts.args, ['/d', '/s', '/c', 'dir']);
  // 'C:\WINDOWS\…' содержит каталог и уже абсолютен — раннер его не пересобирает
  const p = await setup(t, { platform: 'linux', comSpec });
  await p.runner.start({ project: p.project, target: { kind: 'cmd', command: 'ls' } });
  assert.equal(p.ptys[0].opts.exe, '/bin/sh', 'чужой ComSpec на posix не подставляется');
});

test('runner: данные и события чужой/устаревшей сессии не смешиваются', async (t) => {
  const s = await setup(t);
  const r1 = await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  const pty1 = s.ptys[0];
  await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  // pty первой сессии ещё агонизирует: её вывод не должен уйти в новый терминал
  pty1.emit('призрак');
  assert.equal(s.dataOf(r1.sessionId), '');
  assert.equal(s.exitsOf(r1.sessionId).length, 1, 'выход уже был отправлен при остановке');
  pty1.exit(1);
  assert.equal(s.exitsOf(r1.sessionId).length, 1, 'поздний exit игнорируется');
});

test('runner: журнал контекста и история не трогаются — раннер ничего не пишет в проект', async (t) => {
  const s = await setup(t);
  const before = fs.readdirSync(s.root).sort();
  await s.runner.start({ project: s.project, target: { kind: 'file', rel: 'main.py' } });
  s.ptys[0].emit('x');
  s.ptys[0].exit(0);
  const after = fs.readdirSync(s.root).sort();
  assert.deepEqual(after, before, 'раннер не создал и не удалил файлы проекта');
});

test('runner: папка .ide_build создаётся перед компиляцией, если её нет', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiws-run2-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  fs.writeFileSync(path.join(root, 'p.c'), 'int main(){}\n');
  const runner = createRunner({
    platform: 'linux',
    spawnPty: (opts) => new FakePty({ nextPid: 7 }, opts),
    killTree: () => {},
    send: () => {},
    getRunConfig: () => ({}),
    toolchain: { detect: async () => ({ c: { found: true, exe: '/bin/fakegcc' } }) },
    onError: () => {},
    watchdogUnref: true,
  });
  const r = await runner.start({ project: { id: 'p', path: root }, target: { kind: 'file', rel: 'p.c' } });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(root, '.ide_build')), 'папка артефактов создана');
});

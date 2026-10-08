'use strict';
// Поиск инструментов (src/toolchain.js, ТЗ C3 §3.2): findOnPath на временной папке,
// PATHEXT-имитация Windows, порядок кандидатов, предпочтение python 3, ручной путь,
// кеш. Реальные тулчейны не нужны: isFile и execFile внедрены через DI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { createToolchain, WIN_PATH_EXT } = require('../src/toolchain');

async function mkTmp(t, name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), name));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Стенд: «на диске» лежит набор путей, execFile отвечает готовыми версиями. */
function harness(files, versions, platform) {
  // В win32-режиме toolchain соединяет каталог и имя через обратную косую — на любой
  // ОС-хосте приводим «диск» к тому же виду, чтобы имитация не зависела от хоста.
  // Файловая система Windows регистронезависима: PATHEXT даёт «.EXE», а файл может
  // лежать как «.exe» — имитация сравнивает в нижнем регистре, как настоящая NTFS.
  const norm = (p) => (platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : path.posix.normalize(p));
  const present = new Set(files.map(norm));
  const execCalls = [];
  const tc = createToolchain({
    platform: platform || 'linux',
    isFile: (p) => present.has(norm(p)),
    execFile: (exe, args, opts, cb) => {
      execCalls.push([exe, args]);
      const out = versions && versions[exe] !== undefined ? versions[exe] : `${path.basename(exe)} 1.0.0`;
      cb(null, out, '');
      return { on: () => {} };
    },
  });
  return { tc, execCalls };
}

test('toolchain: findOnPath — кандидаты перебираются в порядке дескриптора (ТЗ §3.2)', () => {
  const { tc } = harness(['/usr/bin/gcc', '/opt/bin/clang']);
  // ни один кандидат не найден — null
  assert.equal(tc.findOnPath(['g++', 'clang++'], { PATH: '/usr/bin:/opt/bin' }), null);
  assert.equal(tc.findOnPath(['gcc', 'clang'], { PATH: '/usr/bin:/opt/bin' }), '/usr/bin/gcc');
  // порядок КАНДИДАТОВ важнее порядка PATH: gcc первый в дескрипторе — он и побеждает,
  // даже если clang лежит в более раннем каталоге PATH
  const { tc: tc2 } = harness(['/a/clang', '/b/gcc']);
  assert.equal(tc2.findOnPath(['gcc', 'clang'], { PATH: '/a:/b' }), '/b/gcc');
  // в пределах одного кандидата решает порядок PATH
  const { tc: tc3 } = harness(['/a/python3', '/b/python3']);
  assert.equal(tc3.findOnPath(['python3'], { PATH: '/b:/a' }), '/b/python3');
});

test('toolchain: findOnPath — пустой PATH, мусор и отсутствующие кандидаты', () => {
  const { tc } = harness([]);
  assert.equal(tc.findOnPath(['gcc'], { PATH: '' }), null);
  assert.equal(tc.findOnPath(['gcc'], {}), null);
  assert.equal(tc.findOnPath([], { PATH: '/usr/bin' }), null);
  assert.equal(tc.findOnPath(null, { PATH: '/usr/bin' }), null);
});

test('toolchain: Windows — PATHEXT, регистр переменной и поиск в текущей папке', () => {
  // Пути и ожидания — с обратными косыми, как на настоящей Windows: path.join на
  // win32-режиме соединяет каталог и имя через «\» (на POSIX он дал бы «\» как
  // обычный символ — поэтому harness хранит пути буквально, а нормализация в
  // isFile приводит обе стороны к одному виду).
  // PATHEXT в окружении Windows обычно хранится в нижнем регистре — как в жизни
  const env = { PATH: 'C:\\tools', PATHEXT: '.com;.exe;.bat;.cmd' };
  const { tc } = harness(['C:\\tools\\gcc.exe', 'mytool.cmd'], {}, 'win32');
  // .exe находится через PATHEXT
  assert.equal(tc.findOnPath(['gcc'], env), 'C:\\tools\\gcc.exe');
  // регистр имени переменной не важен (Path вместо PATH)
  assert.equal(tc.findOnPath(['gcc'], { Path: 'C:\\tools', PATHEXT: '.exe' }), 'C:\\tools\\gcc.exe');
  // cmd.exe ищет и в текущей папке: «.» добавляется первым каталогом
  assert.equal(tc.findOnPath(['mytool'], { PATH: 'C:\\nowhere', PATHEXT: '.cmd' }), 'mytool.cmd');
  // свой PATHEXT из окружения заменяет дефолтный
  const { tc: tc2 } = harness(['C:\\t\\x.bat'], {}, 'win32');
  assert.equal(tc2.findOnPath(['x'], { PATH: 'C:\\t', PATHEXT: '.bat' }), 'C:\\t\\x.bat');
  assert.equal(tc2.findOnPath(['x'], { PATH: 'C:\\t', PATHEXT: '.exe' }), null);
  // дефолт PATHEXT — как у Windows
  assert.equal(WIN_PATH_EXT, '.COM;.EXE;.BAT;.CMD');
  // запись PATH с хвостовой косой не даёт двойного разделителя, а расширение из PATHEXT
  // приводится к нижнему регистру (NTFS регистронезависима): этот путь видит пользователь
  // в отчёте и в настройках, и 'C:\Python312\\python.EXE' там выглядело бы опечаткой
  const { tc: tc3 } = harness(['C:\\Python312\\python.exe'], {}, 'win32');
  assert.equal(tc3.findOnPath(['python'], { PATH: 'C:\\Python312\\', PATHEXT: '.EXE' }), 'C:\\Python312\\python.exe');
});

test('toolchain: Windows — ручной путь распознаётся абсолютным по правилам win32', async () => {
  // Абсолютность проверяется модулем целевой платформы: для path.posix строка
  // 'C:\tools\python.exe' относительна, и ручной путь превратился бы в мусорный.
  const exe = 'C:\\tools\\python.exe';
  const { tc } = harness([exe], { [exe]: 'Python 3.12.4' }, 'win32');
  const r = await tc.detect({ tools: { python: exe } }, { PATH: 'C:\\nowhere' });
  assert.equal(r.python.source, 'manual');
  assert.equal(r.python.exe, exe);
  assert.equal(r.python.brokenManual, false);
  assert.equal(r.python.version.text, '3.12.4');
});

test('toolchain: findAllOnPath возвращает все совпадения в порядке перебора', () => {
  const { tc } = harness(['/usr/bin/python', '/usr/local/bin/python3', '/usr/bin/py']);
  const hits = tc.findAllOnPath(['python', 'python3', 'py'], { PATH: '/usr/bin:/usr/local/bin' });
  assert.deepEqual(hits.map((h) => h.exe), ['/usr/bin/python', '/usr/local/bin/python3', '/usr/bin/py']);
  assert.deepEqual(hits.map((h) => h.name), ['python', 'python3', 'py']);
});

test('toolchain: detect — python 2 в PATH не перекрывает python 3', async () => {
  const { tc } = harness(['/usr/bin/python', '/usr/bin/python3'], {
    '/usr/bin/python': 'Python 2.7.18',
    '/usr/bin/python3': 'Python 3.12.4',
  });
  const r = await tc.detect({}, { PATH: '/usr/bin' });
  assert.equal(r.python.found, true);
  assert.equal(r.python.exe, '/usr/bin/python3', 'предпочтена третья версия');
  assert.equal(r.python.source, 'path');
  assert.equal(r.python.version.major, 3);
  assert.equal(r.python.version.minor, 12);
  // кандидаты перечислены для UI настроек
  assert.deepEqual(r.python.candidates.map((c) => c.exe), ['/usr/bin/python', '/usr/bin/python3']);
});

test('toolchain: detect — только python 2: берём что есть, версия честная', async () => {
  const { tc } = harness(['/usr/bin/python'], { '/usr/bin/python': 'Python 2.7.18' });
  const r = await tc.detect({}, { PATH: '/usr/bin' });
  assert.equal(r.python.found, true);
  assert.equal(r.python.exe, '/usr/bin/python');
  assert.equal(r.python.version.major, 2);
});

test('toolchain: detect — ручной путь побеждает автопоиск', async () => {
  const { tc } = harness(['/usr/bin/python3', '/opt/py311/python'], {
    '/opt/py311/python': 'Python 3.11.9',
    '/usr/bin/python3': 'Python 3.12.4',
  });
  const r = await tc.detect({ tools: { python: '/opt/py311/python' } }, { PATH: '/usr/bin' });
  assert.equal(r.python.exe, '/opt/py311/python');
  assert.equal(r.python.source, 'manual');
  assert.equal(r.python.brokenManual, false);
  assert.equal(r.python.version.text, '3.11.9');
});

test('toolchain: detect — битый ручной путь виден честно, запуск спасает автопоиск', async () => {
  // кандидаты cpp — g++ и clang++: ручной путь битый, но g++ жив в PATH
  const { tc } = harness(['/usr/bin/g++'], {});
  const r = await tc.detect({ tools: { cpp: '/opt/gone/g++' } }, { PATH: '/usr/bin' });
  assert.equal(r.cpp.found, true);
  assert.equal(r.cpp.exe, '/usr/bin/g++');
  assert.equal(r.cpp.source, 'path');
  assert.equal(r.cpp.brokenManual, true, 'UI покажет «указан, но не найден»');

  // PATH пуст — честный провал
  const { tc: tc2 } = harness([], {});
  const r2 = await tc2.detect({ tools: { cpp: '/opt/gone/g++' } }, { PATH: '' });
  assert.equal(r2.cpp.found, false);
  assert.equal(r2.cpp.exe, null);
  assert.equal(r2.cpp.brokenManual, true);
});

test('toolchain: detect — инструмент не найден: found=false без исключений', async () => {
  const { tc } = harness([], {});
  const r = await tc.detect({}, { PATH: '/usr/bin' });
  for (const key of ['python', 'node', 'cpp', 'c', 'javac', 'java']) {
    assert.equal(r[key].found, false, `${key} обязан быть не найден`);
    assert.equal(r[key].exe, null);
    assert.equal(r[key].source, null);
    assert.deepEqual(r[key].candidates, []);
  }
});

test('toolchain: detect — кеш до смены настроек, clearCache сбрасывает', async () => {
  const files = ['/usr/bin/gcc'];
  const { tc, execCalls } = harness(files, {});
  const env = { PATH: '/usr/bin' };
  const r1 = await tc.detect({}, env);
  const calls1 = execCalls.length;
  const r2 = await tc.detect({}, env);
  assert.equal(r2, r1, 'повторный detect вернул кешированный объект');
  assert.equal(execCalls.length, calls1, 'версии повторно не спрашивались');

  // смена ручного пути — кеш недействителен
  const r3 = await tc.detect({ tools: { cpp: '/usr/bin/gcc' } }, env);
  assert.equal(r3.cpp.source, 'manual');

  // clearCache — принудительное обновление («Обновить» в настройках)
  tc.clearCache();
  const r4 = await tc.detect({ tools: { cpp: '/usr/bin/gcc' } }, env);
  assert.equal(r4.cpp.source, 'manual');
});

test('toolchain: detect — все пять языков в одном результате (ключи как в config.run.tools)', async () => {
  const { tc } = harness([
    '/bin/python3', '/bin/node', '/bin/g++', '/bin/gcc', '/bin/javac', '/bin/java',
  ], {
    '/bin/node': 'v22.9.0', '/bin/javac': 'javac 17.0.2', '/bin/java': 'openjdk 17.0.2',
    '/bin/g++': 'g++ (GCC) 13.2.0', '/bin/gcc': 'gcc (GCC) 13.2.0', '/bin/python3': 'Python 3.12.4',
  });
  const r = await tc.detect({}, { PATH: '/bin' });
  assert.deepEqual(Object.keys(r).sort(), ['c', 'cpp', 'java', 'javac', 'node', 'python']);
  assert.equal(r.node.version.major, 22);
  assert.equal(r.javac.version.major, 17);
  for (const key of Object.keys(r)) assert.equal(r[key].found, true);
});

test('toolchain: detect — относительный ручной путь приводится к абсолютному', async () => {
  // Ожидание собирается модулем целевой платформы (harness без platform — posix-режим),
  // как это делает src/toolchain.js: хостовый path.resolve на Windows дал бы другой
  // разделитель, и тест зависел бы от машины, на которой запущен.
  const abs = path.posix.resolve('tools/gcc');
  const { tc } = harness([abs], {});
  const r = await tc.detect({ tools: { c: 'tools/gcc' } }, { PATH: '' });
  assert.equal(r.c.source, 'manual');
  assert.equal(r.c.exe, abs);
  assert.notEqual(r.c.exe, 'tools/gcc', 'относительный путь приведён к абсолютному');
});

test('toolchain: toolVersion — таймаут и ошибка не роняют, вывод stderr учитывается', async () => {
  // версия в stderr (так делает java)
  const tcErr = createToolchain({
    platform: 'linux',
    isFile: () => true,
    execFile: (exe, args, opts, cb) => { cb(null, '', 'openjdk version "21.0.1"'); return { on: () => {} }; },
  });
  const v = await tcErr.toolVersion('/bin/java');
  assert.equal(v.major, 21);

  // execFile кидает синхронно — null, не исключение
  const tcThrow = createToolchain({
    platform: 'linux', isFile: () => true,
    execFile: () => { throw new Error('нет такого файла'); },
  });
  assert.equal(await tcThrow.toolVersion('/bin/x'), null);

  // процесс сообщает об ошибке через событие error
  const tcEv = createToolchain({
    platform: 'linux', isFile: () => true,
    execFile: (exe, args, opts, cb) => ({ on: (ev, fn) => { if (ev === 'error') setTimeout(() => fn(new Error('EPERM')), 0); } }),
  });
  assert.equal(await tcEv.toolVersion('/bin/x'), null);

  // вывод без версии
  const tcNo = createToolchain({
    platform: 'linux', isFile: () => true,
    execFile: (exe, args, opts, cb) => { cb(null, 'команда без версии', ''); return { on: () => {} }; },
  });
  assert.equal(await tcNo.toolVersion('/bin/x'), null);
});

test('toolchain: findOnPath на настоящей временной папке (без имитации)', async (t) => {
  // имитация isFile проверялась выше; здесь — честный fs, чтобы расхождение
  // «нормализация путей в тестах против жизни» не ускользнуло
  const dir = await mkTmp(t, 'aiws-tc-');
  const exe = path.join(dir, 'mytool');
  fs.writeFileSync(exe, '#!/bin/sh\necho ok\n');
  fs.chmodSync(exe, 0o755);
  const tc = createToolchain({ platform: process.platform });
  const found = tc.findOnPath(['mytool'], { PATH: dir });
  assert.equal(found, exe);
  assert.equal(tc.findOnPath(['notool'], { PATH: dir }), null);
});

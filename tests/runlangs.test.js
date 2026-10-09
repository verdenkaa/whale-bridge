'use strict';
// Ядро запуска (src/runlangs.js, ТЗ C3 §3.1, §4): планы всех языков, разбор аргументов,
// Java FQCN, версии, sanitize конфига. Чистые функции — ни Electron, ни fs не нужны.
const test = require('node:test');
const assert = require('node:assert/strict');

const RL = require('../src/runlangs');

test('runlangs: таблица языков — 6 языков, расширения и инструменты как в ТЗ', () => {
  assert.equal(RL.LANGS.length, 6);
  assert.deepEqual(RL.LANGS.map((l) => l.id), ['python', 'node', 'cpp', 'c', 'java', 'csharp']);
  const byId = Object.fromEntries(RL.LANGS.map((l) => [l.id, l]));
  assert.deepEqual([...byId.python.exts], ['.py']);
  assert.deepEqual([...byId.node.exts], ['.js', '.mjs', '.cjs', '.ts', '.mts']);
  assert.deepEqual([...byId.cpp.exts], ['.cpp', '.cc', '.cxx']);
  assert.deepEqual([...byId.c.exts], ['.c']);
  assert.deepEqual([...byId.java.exts], ['.java']);
  assert.deepEqual([...byId.csharp.exts], ['.cs']);
  // кандидаты PATH в порядке дескриптора
  assert.deepEqual([...byId.python.tools[0].names], ['python', 'python3', 'py']);
  assert.deepEqual([...byId.cpp.tools[0].names], ['g++', 'clang++']);
  assert.deepEqual([...byId.c.tools[0].names], ['gcc', 'clang']);
  // Java — пара инструментов: компилятор и рантайм
  assert.deepEqual(byId.java.tools.map((t) => t.key), ['javac', 'java']);
  // C# — один инструмент: SDK (dotnet build и dotnet <dll> — одна программа)
  assert.deepEqual(byId.csharp.tools.map((t) => t.key), ['dotnet']);
  assert.deepEqual([...byId.csharp.tools[0].names], ['dotnet']);
  // ключи ручных путей настроек совпадают с дефолтом config.run
  assert.deepEqual([...RL.TOOL_KEYS], ['python', 'node', 'cpp', 'c', 'javac', 'java', 'dotnet']);
  assert.deepEqual([...RL.ARGS_KEYS], ['python', 'cpp', 'c', 'java', 'csharp']);
  const def = RL.defaultRunConfig();
  assert.deepEqual(Object.keys(def.tools), [...RL.TOOL_KEYS]);
  assert.deepEqual(Object.keys(def.args), [...RL.ARGS_KEYS]);
});

test('runlangs: langByExt — с точкой и без, регистр не важен, чужое расширение — null', () => {
  assert.equal(RL.langByExt('.py').id, 'python');
  assert.equal(RL.langByExt('py').id, 'python');
  assert.equal(RL.langByExt('.CPP').id, 'cpp');
  assert.equal(RL.langByExt('.mts').id, 'node');
  assert.equal(RL.langByExt('.java').id, 'java');
  assert.equal(RL.langByExt('.md'), null);
  assert.equal(RL.langByExt(''), null);
  assert.equal(RL.langByExt(null), null);
});

test('runlangs: planRun python — «-u», относительный путь, PYTHONPATH/PYTHONIOENCODING', () => {
  const p = RL.planRun('python', 'src/main.py', { platform: 'win32' });
  assert.equal(p.ok, true);
  assert.equal(p.steps.length, 1);
  assert.deepEqual(p.steps[0], { kind: 'run', tool: 'python', exe: null, args: ['-u', 'src/main.py'] });
  assert.deepEqual(p.env, { PYTHONPATH: '{root}', PYTHONIOENCODING: 'utf-8' });
  assert.equal(p.outDir, null, 'интерпретируемый язык ничего не собирает');
  // аргументы из настроек идут ПОСЛЕ файла: «python -u main.py --verbose»
  const q = RL.planRun('python', 'main.py', { args: ['--verbose'] });
  assert.deepEqual(q.steps[0].args, ['-u', 'main.py', '--verbose']);
});

test('runlangs: planRun node — JS без флагов, TS со strip-types только на Node 22', () => {
  const js = RL.planRun('node', 'app.js', { nodeMajor: 22 });
  assert.deepEqual(js.steps[0].args, ['app.js']);
  assert.equal(js.steps[0].tool, 'node');

  const ts22 = RL.planRun('node', 'app.ts', { nodeMajor: 22 });
  assert.deepEqual(ts22.steps[0].args, ['--experimental-strip-types', 'app.ts']);

  // Node 23+ исполняет TS нативно — флаг не нужен и не должен мешать
  const ts23 = RL.planRun('node', 'app.ts', { nodeMajor: 23 });
  assert.deepEqual(ts23.steps[0].args, ['app.ts']);

  // версия node неизвестна или старая — честная ошибка вместо загадочного SyntaxError
  const unknown = RL.planRun('node', 'app.ts', {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Node\.js 22/);
  const old = RL.planRun('node', 'app.mts', { nodeMajor: 20 });
  assert.equal(old.ok, false);
  // обычный JS работает при любой версии node
  assert.equal(RL.planRun('node', 'app.js', { nodeMajor: 20 }).ok, true);
  assert.equal(RL.planRun('node', 'app.js', {}).ok, true);
});

test('runlangs: planRun cpp/c — сборка в .ide_build с именем исходника, запуск бинарника', () => {
  const p = RL.planRun('cpp', 'src/app.cpp', { platform: 'win32' });
  assert.equal(p.ok, true);
  assert.equal(p.steps.length, 2);
  assert.equal(p.steps[0].kind, 'build');
  assert.equal(p.steps[0].tool, 'cpp');
  assert.deepEqual(p.steps[0].args, ['src/app.cpp', '-o', '.ide_build/app.exe']);
  assert.equal(p.steps[1].kind, 'run');
  assert.equal(p.steps[1].exe, '.ide_build/app.exe');
  assert.deepEqual(p.steps[1].args, []);
  assert.equal(p.outDir, '.ide_build');
  assert.equal(p.env, null);

  // на posix без .exe
  const posix = RL.planRun('c', 'main.c', { platform: 'linux' });
  assert.deepEqual(posix.steps[0].args, ['main.c', '-o', '.ide_build/main']);
  assert.equal(posix.steps[1].exe, '.ide_build/main');

  // доп. аргументы настроек (-Wall, -O2) вставляются ПЕРЕД -o
  const withArgs = RL.planRun('c', 'main.c', { args: ['-Wall', '-O2'] });
  assert.deepEqual(withArgs.steps[0].args, ['-Wall', '-O2', 'main.c', '-o', '.ide_build/main']);

  // имя бинарника = имя исходника даже для файла в папке: два файла не перетираются
  const nested = RL.planRun('cpp', 'deep/dir/prog.cc', {});
  assert.deepEqual(nested.steps[0].args, ['deep/dir/prog.cc', '-o', '.ide_build/prog']);
});

test('runlangs: planRun java — javac -d .ide_build/classes, запуск FQCN с -cp', () => {
  const p = RL.planRun('java', 'src/Main.java', { fqcn: 'com.example.Main', args: ['-Xlint:all'] });
  assert.equal(p.ok, true);
  assert.deepEqual(p.steps[0], {
    kind: 'build', tool: 'javac', exe: null,
    args: ['-encoding', 'UTF-8', '-Xlint:all', '-d', '.ide_build/classes', 'src/Main.java'],
  });
  assert.deepEqual(p.steps[1], {
    kind: 'run', tool: 'java', exe: null,
    args: ['-cp', '.ide_build/classes', 'com.example.Main'],
  });
  assert.equal(p.outDir, '.ide_build/classes', 'папка байт-кода создаётся до компиляции');
  // без fqcn — имя файла (класс без package)
  const noFq = RL.planRun('java', 'Main.java', {});
  assert.deepEqual(noFq.steps[1].args, ['-cp', '.ide_build/classes', 'Main']);
});

test('runlangs: planRun csharp — dotnet build в .ide_build/bin, запуск dotnet <сборка>.dll (этап D)', () => {
  const cs = { proj: 'MyApp.csproj', assembly: 'MyApp' };
  const p = RL.planRun('csharp', 'src/Program.cs', { platform: 'win32', csharp: cs, args: ['--fast'] });
  assert.equal(p.ok, true);
  assert.equal(p.steps.length, 2, 'два шага: сборка и запуск');
  assert.deepEqual(p.steps[0], {
    kind: 'build', tool: 'dotnet', exe: null,
    args: ['build', 'MyApp.csproj', '--configuration', 'Release', '-o', '.ide_build/bin'],
  });
  assert.deepEqual(p.steps[1], {
    kind: 'run', tool: 'dotnet', exe: null,
    args: ['.ide_build/bin/MyApp.dll', '--fast'],
  });
  assert.equal(p.env, null);
  assert.equal(p.outDir, '.ide_build/bin', 'папка артефактов создаётся до сборки');
  // аргументы из настроек — аргументы ПРОГРАММЫ, идут в конец запуска
  assert.deepEqual(RL.planRun('csharp', 'a.cs', { csharp: cs }).steps[1].args, ['.ide_build/bin/MyApp.dll']);
  // служебный проект из .ide_build работает так же
  const svc = RL.planRun('csharp', 'Program.cs', { csharp: { proj: '.ide_build/app.csproj', assembly: 'app' } });
  assert.deepEqual(svc.steps[0].args[1], '.ide_build/app.csproj');
  assert.deepEqual(svc.steps[1].args, ['.ide_build/bin/app.dll']);
});

test('runlangs: planRun csharp без проекта — понятная ошибка, а не падение', () => {
  for (const opts of [{}, { csharp: null }, { csharp: {} }, { csharp: { proj: 'x.csproj' } },
    { csharp: { assembly: 'x' } }, { csharp: { proj: '  ', assembly: 'x' } }, 'мусор']) {
    const r = RL.planRun('csharp', 'Program.cs', opts);
    assert.equal(r.ok, false, JSON.stringify(opts));
    assert.match(r.error, /csproj/, 'ошибка называет .csproj');
  }
});

test('runlangs: csharpProjectXml — служебный проект (этап D)', () => {
  const xml = RL.csharpProjectXml('net9.0');
  assert.match(xml, /<Project Sdk="Microsoft\.NET\.Sdk">/);
  assert.match(xml, /<OutputType>Exe<\/OutputType>/, 'консольное приложение, а не библиотека');
  assert.match(xml, /<TargetFramework>net9\.0<\/TargetFramework>/, 'версия платформы из аргумента');
  assert.match(xml, /<ImplicitUsings>enable<\/ImplicitUsings>/);
  assert.match(xml, /<Nullable>enable<\/Nullable>/);
  assert.match(xml, /<AssemblyName>app<\/AssemblyName>/, 'имя сборки фиксировано — план знает его заранее');
  assert.match(xml, /<EnableDefaultItems>false<\/EnableDefaultItems>/, 'стандартные glob отключены');
  assert.match(xml, /<Compile Include="\.\.\/\*\*\/\*\.cs"/, 'исходники берутся из корня проекта');
  assert.match(xml, /Exclude="\.\.\/bin\/\*\*;\.\.\/obj\/\*\*/, 'чужие артефакты сборки исключены');
  assert.match(xml, /\.\.\/\.ide_build\/\*\*/, 'своя папка артефактов исключена');
  // мусор и неподдерживаемый TFM — запасной net8.0
  for (const bad of [null, undefined, '', 'net472', 'net9.0; Drop', '<evil>', 42, {}]) {
    assert.match(RL.csharpProjectXml(bad), /<TargetFramework>net8\.0<\/TargetFramework>/, String(bad));
  }
  assert.ok(xml.endsWith('</Project>\n'), 'XML закрыт');
});

test('runlangs: classifyCommand — dotnet build/run безопасны, пакеты и сеть под вопросом', () => {
  assert.equal(RL.classifyCommand('dotnet build app.csproj').level, 'safe');
  assert.equal(RL.classifyCommand('dotnet run --project app.csproj').level, 'safe');
  assert.equal(RL.classifyCommand('dotnet .ide_build/bin/app.dll').level, 'safe');
  assert.equal(RL.classifyCommand('dotnet --version').level, 'safe');
  for (const cmd of ['dotnet restore', 'dotnet add package Newtonsoft.Json', 'dotnet remove package X']) {
    const r = RL.classifyCommand(cmd);
    assert.equal(r.level, 'caution', cmd);
    assert.match(r.reasons.join(' '), /установка пакетов/, cmd);
  }
  // опасные флаги работают и внутри dotnet-команды
  assert.equal(RL.classifyCommand('dotnet clean --force').level, 'danger');
});

test('runlangs: planRun — мусор на входе не роняет, а отвечает ошибкой', () => {
  assert.equal(RL.planRun('brainfuck', 'x.bf', {}).ok, false);
  assert.equal(RL.planRun(null, 'main.py', {}).ok, false);
  assert.equal(RL.planRun('python', '', {}).ok, false);
  assert.equal(RL.planRun('python', null, {}).ok, false);
  // opts не объект — не падает
  assert.equal(RL.planRun('python', 'main.py', null).ok, true);
  // аргументы-не-строки отсеиваются
  const p = RL.planRun('python', 'main.py', { args: ['-x', 42, null, '-y'] });
  assert.deepEqual(p.steps[0].args, ['-u', 'main.py', '-x', '-y']);
});

test('runlangs: planShell — Windows всегда cmd.exe, команда одним аргументом', () => {
  const win = RL.planShell('grep -rn "Player" src', 'win32');
  assert.equal(win.exe, 'cmd.exe');
  assert.deepEqual(win.args, ['/d', '/s', '/c', 'chcp 65001>nul & grep -rn "Player" src']);
  assert.equal(win.verbatim, true, 'командная строка оболочки уходит в pty дословно');
  // оболочка — только cmd (решение пользователя: PowerShell не внедряем)
  assert.deepEqual([...RL.SHELLS_WIN], ['cmd']);
  // posix: argv поштучно, никакого verbatim
  const posix = RL.planShell('ls -la', 'linux');
  assert.deepEqual(posix, { exe: '/bin/sh', args: ['-c', 'ls -la'], verbatim: false });
  // не-строка не роняет; префикс chcp к пустой команде не добавляется
  assert.deepEqual(RL.planShell(null, 'win32').args, ['/d', '/s', '/c', '']);
  // префикс можно отключить (консоль остаётся в OEM-кодировке)
  assert.deepEqual(RL.planShell('dir', 'win32', { utf8: false }).args, ['/d', '/s', '/c', 'dir']);
});

test('runlangs: planShell — кавычки и кодировка консоли (замечания пользователя)', () => {
  // Реальный случай: findstr с фразой в кавычках. Кавычки обязаны дожить до cmd.exe —
  // иначе findstr принимает «fn» за шаблон, а «main» за имя файла и падает.
  const win = RL.planShell('findstr "fn main" poem.rs', 'win32');
  assert.equal(win.args[3], 'chcp 65001>nul & findstr "fn main" poem.rs');
  assert.equal(win.args[3].includes('\\"'), false, 'никакого экранирования MSVCRT');
  // пайп с кавычками тоже цел
  const pipe = RL.planShell('type poem.rs | findstr "fn main"', 'win32');
  assert.equal(pipe.args[3], 'chcp 65001>nul & type poem.rs | findstr "fn main"');
  // кириллица в файлах проекта: консоль переводится в UTF-8 до команды (CP866 → кракозябры)
  assert.ok(win.args[3].startsWith(RL.UTF8_CONSOLE_PREFIX), 'префикс chcp 65001 в начале');
  assert.equal(RL.UTF8_CONSOLE_PREFIX, 'chcp 65001>nul & ');
});

test('runlangs: рецепт PowerShell из правила 15 доезжает до cmd.exe дословно', () => {
  // Команду берём прямо из правил промпта (src/promptgen, пункт 15): тест обязан
  // доказывать, что рецепт, которому мы учим модель, проходит наш собственный конвейер.
  // В нём всё, что ломалось раньше, сразу: кириллица, вложенные кавычки и pipe.
  const pg = require('../src/promptgen');
  const m = pg.DEFAULT_RULES.match(/# &CMD:(powershell[^»]*)»/);
  assert.ok(m, 'в правилах есть пример команды PowerShell');
  const cmd = m[1];
  assert.ok(cmd.includes('|'), 'pipe в примере на месте');
  assert.ok(cmd.includes("'Светит'"), 'образец с кириллицей на месте');

  const plan = RL.planShell(cmd, 'win32');
  assert.equal(plan.exe, 'cmd.exe');
  assert.equal(plan.verbatim, true, 'команда уходит строкой: cmd.exe не понимает «\\\"»');
  assert.equal(plan.args[3], RL.UTF8_CONSOLE_PREFIX + cmd,
    'команда осталась одним аргументом — pipe внутри кавычек не резался');
  assert.equal(RL.ptySpawnArgs(plan.args, 'win32', plan.verbatim), '/d /s /c ' + plan.args[3]);
  // Чтение файла — не опасное действие: карточка не требует отдельного подтверждения
  assert.equal(RL.classifyCommand(cmd, 'win32').level, 'safe');
});

test('runlangs: ptySpawnArgs — на Windows команда оболочки одной строкой', () => {
  const args = ['/d', '/s', '/c', 'chcp 65001>nul & findstr "fn main" poem.rs'];
  // win32 + verbatim: строка — node-pty кладёт её в командную строку дословно
  assert.equal(RL.ptySpawnArgs(args, 'win32', true), args.join(' '));
  // win32 без verbatim (запуск файла: exe + argv) — массив
  assert.deepEqual(RL.ptySpawnArgs(['-u', 'main.py'], 'win32', false), ['-u', 'main.py']);
  // posix всегда массив: там execvp, экранирование не нужно
  assert.deepEqual(RL.ptySpawnArgs(args, 'linux', true), args);
  // исходный массив не мутируется
  const copy = args.slice();
  RL.ptySpawnArgs(args, 'win32', true);
  assert.deepEqual(args, copy);
  // мусор на входе
  assert.equal(RL.ptySpawnArgs(null, 'win32', true), '');
  assert.deepEqual(RL.ptySpawnArgs(null, 'linux', false), []);
});

test('runlangs: tokenizeArgs — кавычки, пустые токены, мусор', () => {
  assert.deepEqual(RL.tokenizeArgs('-Wall -O2'), ['-Wall', '-O2']);
  assert.deepEqual(RL.tokenizeArgs('  --name "Иван Петров"  5  '), ['--name', 'Иван Петров', '5']);
  assert.deepEqual(RL.tokenizeArgs(''), []);
  assert.deepEqual(RL.tokenizeArgs('   '), []);
  assert.deepEqual(RL.tokenizeArgs(null), []);
  assert.deepEqual(RL.tokenizeArgs(42), []);
  // пустая строка в кавычках — легитимный аргумент
  assert.deepEqual(RL.tokenizeArgs('a "" b'), ['a', '', 'b']);
  // незакрытая кавычка не роняет: остаток — один токен
  assert.deepEqual(RL.tokenizeArgs('"abc'), ['abc']);
  // одинарные кавычки в cmd.exe не особенные — остаются частью токена
  assert.deepEqual(RL.tokenizeArgs("grep 'x y'"), ["grep", "'x", "y'"]);
});

test('runlangs: javaClassFqn — package из исходника + имя файла', () => {
  assert.equal(RL.javaClassFqn('package com.example;\npublic class Main {}', 'Main'), 'com.example.Main');
  assert.equal(RL.javaClassFqn('  package  x.y ;\nclass App {}', 'App'), 'x.y.App');
  // package после лицензии/импортов — тоже находится (первое вхождение)
  assert.equal(RL.javaClassFqn('// (c) 2026\n\npackage a.b.c;\n\nimport java.util.*;', 'Prog'), 'a.b.c.Prog');
  // без package — просто имя
  assert.equal(RL.javaClassFqn('public class Main { }', 'Main'), 'Main');
  // мусор и package-like строки в комментариях/строках не считаются:
  // «package» обязан стоять началом строки (допускаются пробелы/табы)
  assert.equal(RL.javaClassFqn('// package fake.name;\nclass Main {}', 'Main'), 'Main');
  assert.equal(RL.javaClassFqn('String s = "package a.b;";', 'Main'), 'Main');
  assert.equal(RL.javaClassFqn(null, 'Main'), 'Main');
  // $ и _ в идентификаторах допустимы
  assert.equal(RL.javaClassFqn('package my_pkg_$1;', 'A_b'), 'my_pkg_$1.A_b');
});

test('runlangs: parseVersion — первая версия из вывода --version', () => {
  assert.deepEqual(RL.parseVersion('Python 3.12.4 (tags/v3.12.4)\n'), { major: 3, minor: 12, patch: 4, text: '3.12.4' });
  assert.deepEqual(RL.parseVersion('v22.9.0'), { major: 22, minor: 9, patch: 0, text: '22.9.0' });
  assert.deepEqual(RL.parseVersion('javac 17.0.2'), { major: 17, minor: 0, patch: 2, text: '17.0.2' });
  // первая подходящая строка: у gcc версия во второй строке
  const gcc = RL.parseVersion('gcc (GCC) 13.2.0\nCopyright (C) 2023 Free Software Foundation');
  assert.deepEqual(gcc, { major: 13, minor: 2, patch: 0, text: '13.2.0' });
  // версия без patch
  assert.deepEqual(RL.parseVersion('Tool 1.2 build'), { major: 1, minor: 2, patch: null, text: '1.2' });
  assert.equal(RL.parseVersion('no version here'), null);
  assert.equal(RL.parseVersion(''), null);
  assert.equal(RL.parseVersion(null), null);
});

test('runlangs: sanitizeRunConfig — мусор, чужие значения, старый конфиг', () => {
  const def = RL.sanitizeRunConfig(null);
  assert.deepEqual(def, {
    tools: { python: null, node: null, cpp: null, c: null, javac: null, java: null, dotnet: null },
    args: { python: '', cpp: '', c: '', java: '', csharp: '' },
    timeoutSec: 600,
    shellWin: 'cmd',
  });
  assert.deepEqual(RL.sanitizeRunConfig('мусор'), def);
  assert.deepEqual(RL.sanitizeRunConfig(undefined), def);

  // валидные значения сохраняются
  const good = RL.sanitizeRunConfig({
    tools: { python: 'C:\\Python312\\python.exe', node: '/usr/bin/node' },
    args: { cpp: '-Wall -O2', python: ' -X utf8 ' },
    timeoutSec: 30,
    shellWin: 'cmd',
  });
  assert.equal(good.tools.python, 'C:\\Python312\\python.exe');
  assert.equal(good.tools.node, '/usr/bin/node');
  assert.equal(good.tools.cpp, null);
  assert.equal(good.args.cpp, '-Wall -O2');
  assert.equal(good.args.python, ' -X utf8 ');
  assert.equal(good.timeoutSec, 30);

  // PowerShell не внедряем: любое неизвестное shellWin сводится к cmd
  assert.equal(RL.sanitizeRunConfig({ shellWin: 'powershell' }).shellWin, 'cmd');
  assert.equal(RL.sanitizeRunConfig({ shellWin: 42 }).shellWin, 'cmd');

  // битые значения нормализуются
  const bad = RL.sanitizeRunConfig({
    tools: { python: 42, node: '   ', cpp: { evil: true }, c: 'x'.repeat(2000) },
    args: { cpp: 7, java: null, c: 'ok' },
    timeoutSec: -5,
    shellWin: null,
  });
  assert.equal(bad.tools.python, null);
  assert.equal(bad.tools.node, null, 'пустая строка — это автопоиск');
  assert.equal(bad.tools.cpp, null);
  assert.equal(bad.tools.c, null, 'слишком длинная строка пути отбрасывается целиком');
  assert.equal(bad.args.cpp, '');
  assert.equal(bad.args.java, '');
  assert.equal(bad.args.c, 'ok');
  assert.equal(bad.timeoutSec, 600, 'отрицательный таймаут — снова дефолт');
  assert.equal(bad.shellWin, 'cmd');

  // 0 = watchdog выключен — допустимое значение, не дефолт
  assert.equal(RL.sanitizeRunConfig({ timeoutSec: 0 }).timeoutSec, 0);
  // безумный таймаут прижимается к дефолту
  assert.equal(RL.sanitizeRunConfig({ timeoutSec: 1e9 }).timeoutSec, 600);
  // неизвестные ключи не протекают
  const extra = RL.sanitizeRunConfig({ tools: { brainfuck: '/bin/bf' }, evil: true });
  assert.equal('brainfuck' in extra.tools, false);
  assert.equal('evil' in extra, false);
});

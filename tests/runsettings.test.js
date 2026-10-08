'use strict';
// Модель представления настроек запуска (src/runsettings.js, ТЗ C3 §2.4, патч 0018).
// Чистые функции: строки таблицы языков, статусы обнаружения, правило изменения
// config.run. Ни DOM, ни Electron — поэтому правила проверяются здесь, а не глазами.
const test = require('node:test');
const assert = require('node:assert/strict');

const RS = require('../src/runsettings');
const { sanitizeRunConfig } = require('../src/runlangs');

/** Результат toolchain.detect для одного инструмента — как его отдаёт src/toolchain.js. */
const entry = (over) => Object.assign({ found: false, exe: null, source: null, version: null, brokenManual: false, candidates: [] }, over);
const ver = (text, major) => ({ text, major, minor: 0, patch: null });

test('runsettings: строки таблицы — по одной на инструмент, у Java их две', () => {
  const rows = RS.toolRows(sanitizeRunConfig(null), null);
  assert.deepEqual(rows.map((r) => r.toolKey), ['python', 'node', 'cpp', 'c', 'javac', 'java']);
  // подпись языка стоит только на первой строке группы: визуально Java — один язык, два инструмента
  assert.deepEqual(rows.filter((r) => r.langId === 'java').map((r) => [r.firstOfLang, r.langLabel, r.toolLabel]),
    [[true, 'Java', 'javac'], [false, 'Java', 'java']]);
  assert.deepEqual(rows.find((r) => r.toolKey === 'cpp').candidates, ['g++', 'clang++']);
  assert.equal(rows.find((r) => r.toolKey === 'python').langLabel, 'Python');
  // без результата обнаружения статус честный: «не проверялось», а не «не найден»
  assert.equal(rows[0].status.kind, 'unknown');
  assert.equal(rows[0].manual, null);
});

test('runsettings: ручной путь из конфига виден в строке', () => {
  const cfg = sanitizeRunConfig({ tools: { cpp: 'C:\\mingw64\\bin\\g++.exe' } });
  const rows = RS.toolRows(cfg, null);
  assert.equal(rows.find((r) => r.toolKey === 'cpp').manual, 'C:\\mingw64\\bin\\g++.exe');
  assert.equal(rows.find((r) => r.toolKey === 'c').manual, null);
});

test('runsettings: статусы обнаружения — найден, из настроек, битый путь, не найден', () => {
  // автопоиск в PATH
  const ok = RS.statusOf(entry({ found: true, exe: '/usr/bin/gcc', source: 'path', version: ver('13.2.0', 13) }));
  assert.equal(ok.kind, 'ok');
  assert.match(ok.text, /^✔ \/usr\/bin\/gcc · 13\.2\.0$/);

  // ручной путь существует — он и использован
  const manual = RS.statusOf(entry({ found: true, exe: 'C:\\py\\python.exe', source: 'manual', version: ver('3.12.4', 3) }));
  assert.equal(manual.kind, 'manual');
  assert.match(manual.text, /из настроек/);
  assert.match(manual.text, /3\.12\.4/);

  // битый ручной путь + живой PATH: показываем оба факта, но не обещаем, что запустится
  const broken = RS.statusOf(entry({ found: true, exe: '/usr/bin/g++', source: 'path', brokenManual: true, version: ver('13.2.0', 13) }));
  assert.equal(broken.kind, 'broken');
  assert.match(broken.text, /^⚠ указанный путь не найден; в PATH есть \/usr\/bin\/g\+\+/);

  // битый ручной путь и в PATH ничего
  const broken2 = RS.statusOf(entry({ brokenManual: true }));
  assert.equal(broken2.kind, 'broken');
  assert.equal(broken2.text, '⚠ указан, но не найден');

  // не найден нигде
  const none = RS.statusOf(entry({}));
  assert.equal(none.kind, 'none');
  assert.match(none.text, /^✘ не найден в PATH$/);

  // мусор и отсутствие результата
  assert.equal(RS.statusOf(null).kind, 'unknown');
  assert.equal(RS.statusOf('строка').kind, 'unknown');
});

test('runsettings: дополнительные аргументы — только языки из ARGS_KEYS, у Java подписан javac', () => {
  const rows = RS.argRows(sanitizeRunConfig({ args: { cpp: '-Wall -O2' } }));
  assert.deepEqual(rows.map((r) => r.key), ['python', 'cpp', 'c', 'java']);
  assert.equal(rows.find((r) => r.key === 'cpp').value, '-Wall -O2');
  assert.equal(rows.find((r) => r.key === 'python').value, '');
  assert.match(rows.find((r) => r.key === 'java').hint, /javac/);
  assert.equal(rows.find((r) => r.key === 'cpp').label, 'C++');
  // у каждого поля есть подсказка-пример
  for (const r of rows) assert.ok(r.hint.length > 3, 'подсказка для ' + r.key);
});

test('runsettings: таймаут — целые секунды, 0 допустим, мусор не проходит', () => {
  assert.equal(RS.parseTimeoutInput('600'), 600);
  assert.equal(RS.parseTimeoutInput(0), 0);
  assert.equal(RS.parseTimeoutInput('  30 '), 30);
  assert.equal(RS.parseTimeoutInput(String(RS.TIMEOUT_MAX + 5000)), RS.TIMEOUT_MAX, 'верхняя граница прижата');
  assert.equal(RS.parseTimeoutInput(''), null);
  assert.equal(RS.parseTimeoutInput(null), null);
  assert.equal(RS.parseTimeoutInput('много'), null);
  assert.equal(RS.parseTimeoutInput('-5'), null);
  assert.equal(RS.parseTimeoutInput('30.7'), null, 'дробные секунды не принимаем');
});

test('runsettings: nextConfig — правка одного поля, всегда через sanitize', () => {
  const base = sanitizeRunConfig(null);

  const withTool = RS.nextConfig(base, { tool: { key: 'python', value: 'C:\\py\\python.exe' } });
  assert.equal(withTool.tools.python, 'C:\\py\\python.exe');
  assert.deepEqual(withTool.args, base.args, 'остальные поля не тронуты');

  // пустая строка и null — это «Авто»: ручной путь снимается
  assert.equal(RS.nextConfig(withTool, { tool: { key: 'python', value: '' } }).tools.python, null);
  assert.equal(RS.nextConfig(withTool, { tool: { key: 'python', value: null } }).tools.python, null);
  // пробелы по краям обрезаются
  assert.equal(RS.nextConfig(base, { tool: { key: 'c', value: '  /usr/bin/gcc  ' } }).tools.c, '/usr/bin/gcc');

  const withArgs = RS.nextConfig(base, { args: { key: 'cpp', value: '-Wall' } });
  assert.equal(withArgs.args.cpp, '-Wall');
  assert.equal(withArgs.tools.cpp, null);

  const withTimeout = RS.nextConfig(base, { timeoutSec: '120' });
  assert.equal(withTimeout.timeoutSec, 120);
  // недопустимый таймаут не меняет конфиг молча — поле остаётся прежним
  assert.equal(RS.nextConfig(base, { timeoutSec: 'abc' }).timeoutSec, base.timeoutSec);

  // неизвестные ключи игнорируются: конфиг нельзя расширить через renderer
  const junk = RS.nextConfig(base, { tool: { key: 'godot', value: 'x' }, args: { key: 'node', value: 'y' } });
  assert.deepEqual(Object.keys(junk.tools).sort(), ['c', 'cpp', 'java', 'javac', 'node', 'python']);
  assert.deepEqual(junk, base);

  // оболочка не настраивается: любое значение сводится к cmd (решение пользователя, §5.3)
  assert.equal(RS.nextConfig({ shellWin: 'powershell' }, {}).shellWin, 'cmd');

  // входной конфиг не мутируется
  const frozen = sanitizeRunConfig(null);
  RS.nextConfig(frozen, { tool: { key: 'python', value: 'x' } });
  assert.equal(frozen.tools.python, null);
});

test('runsettings: сообщение «не найден» называет инструмент, подсказку и битый путь', () => {
  const m = RS.missingToolMessage('cpp');
  assert.match(m, /^Не найден g\+\+ в PATH\./);
  assert.match(m, /MinGW-w64/, 'подсказка, что установить');
  assert.match(m, /Настройках → Запуск/);

  const withManual = RS.missingToolMessage('python', 'C:\\gone\\python.exe');
  assert.match(withManual, /Указанный в настройках путь не найден: C:\\gone\\python\.exe/);

  // неизвестный ключ не роняет: имя берётся из ключа
  assert.match(RS.missingToolMessage('unknown-tool'), /Не найден unknown-tool в PATH/);
});

test('runsettings: оболочка для &CMD: — справка, а не настройка', () => {
  assert.match(RS.SHELL_NOTE, /cmd\.exe \/d \/s \/c/);
  assert.match(RS.SHELL_NOTE, /не настраивается/);
  assert.match(RS.SHELL_NOTE, /\/bin\/sh/, 'поведение на Linux/macOS тоже названо');
});

test('runsettings: UMD-модуль отдаёт всё, что рисует renderer', () => {
  for (const m of ['toolRows', 'argRows', 'statusOf', 'nextConfig', 'parseTimeoutInput', 'missingToolMessage', 'toolByKey', 'langOfTool']) {
    assert.equal(typeof RS[m], 'function', 'нет функции ' + m);
  }
  assert.equal(typeof RS.SHELL_NOTE, 'string');
  assert.equal(RS.TIMEOUT_MAX, 86400);
  assert.equal(RS.langOfTool('javac').id, 'java');
  assert.equal(RS.toolByKey('node').tool.label, 'Node.js');
});

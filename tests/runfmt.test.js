'use strict';
// Формат отчёта и очистка вывода (src/runfmt.js, ТЗ C3 §2.3).
const test = require('node:test');
const assert = require('node:assert/strict');

const { stripAnsi, buildReport, createRing, REPORT_OUTPUT_LIMIT } = require('../src/runfmt');

const ESC = '\u001b';

test('runfmt: stripAnsi — цвета компиляторов, курсор, заголовки окна', () => {
  // типичный цветной вывод gcc: SGR-последовательности вокруг текста
  assert.equal(stripAnsi(`${ESC}[01m${ESC}[Kfoo.cpp:1:1:${ESC}[m${ESC}[K error`), 'foo.cpp:1:1: error');
  // палитра python/pytest
  assert.equal(stripAnsi(`${ESC}[32mOK${ESC}[0m`), 'OK');
  // 256 цветов и truecolor
  assert.equal(stripAnsi(`${ESC}[38;5;196mred${ESC}[0m`), 'red');
  assert.equal(stripAnsi(`${ESC}[38;2;255;0;0mred${ESC}[0m`), 'red');
  // движение курсора
  assert.equal(stripAnsi(`${ESC}[2K${ESC}[1GX`), 'X');
  // OSC: заголовок окна и гиперссылка (терминатор BEL и ST)
  assert.equal(stripAnsi(`${ESC}]0;заголовок\u0007текст`), 'текст');
  assert.equal(stripAnsi(`${ESC}]8;;http://x${ESC}\\ссылка${ESC}]8;;${ESC}\\`), 'ссылка');
  // одиночный ESC с финальным байтом Fe-диапазона (сброс)
  assert.equal(stripAnsi(`a${ESC}Mb`), 'ab');
  // обычный текст не меняется, переводы строк сохраняются
  assert.equal(stripAnsi('Привет\r\nмир\n'), 'Привет\r\nмир\n');
  // мусор на входе
  assert.equal(stripAnsi(null), '');
  assert.equal(stripAnsi(42), '');
});

test('runfmt: отчёт файла — все секции по порядку (§2.3)', () => {
  const text = buildReport({
    file: 'src/main.py',
    command: 'python -u src/main.py',
    projectDir: 'C:\\users\\me\\myproject',
    exitCode: 0,
    inputLog: ['5\n', 'hello\n'],
    output: 'Результат: 10\r\n',
  });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Файл: src/main.py');
  assert.equal(lines[1], 'Команда: python -u src/main.py');
  assert.equal(lines[2], 'Папка проекта: C:\\users\\me\\myproject');
  assert.equal(lines[3], 'Код возврата: 0');
  assert.ok(text.includes('Ввод:\n5\nhello'));
  assert.ok(text.includes('Вывод:\n```\nРезультат: 10\n```'));
  assert.ok(text.endsWith('\n'), 'отчёт оканчивается переводом строки');
  // ANSI из вывода вычищен
  assert.ok(!buildReport({ output: `${ESC}[31mred${ESC}[0m` }).includes(ESC));
});

test('runfmt: отчёт команды — без строки «Файл»', () => {
  const text = buildReport({ command: 'grep -rn Player src', exitCode: 1, output: '' });
  assert.ok(!text.includes('Файл:'));
  assert.ok(text.includes('Команда: grep -rn Player src'));
  assert.ok(text.includes('Код возврата: 1'));
  assert.ok(text.includes('(пусто)'), 'пустой вывод помечен явно');
});

test('runfmt: ввод отсутствует — секции «Ввод» нет; пустые строки ввода игнорируются', () => {
  const noInput = buildReport({ file: 'a.py', exitCode: 0, inputLog: [], output: 'x' });
  assert.ok(!noInput.includes('Ввод:'));
  const blank = buildReport({ file: 'a.py', exitCode: 0, inputLog: ['\n', '  \n'], output: 'x' });
  assert.ok(!blank.includes('Ввод:'), 'ввод из одних переводов строк секцию не создаёт');
});

test('runfmt: ``` в выводе повышает ограждение до ````', () => {
  const text = buildReport({ file: 'a.py', exitCode: 0, output: 'до\n```\nкод\n```\nпосле' });
  assert.ok(text.includes('````\nдо'), 'ограждение — четыре обратных кавычки');
  assert.ok(text.includes('\n````\n'), 'ограждение закрыто тем же уровнем');
});

test('runfmt: длинный вывод обрезается до хвоста ~200 КБ с пометкой', () => {
  const big = 'x'.repeat(REPORT_OUTPUT_LIMIT + 50_000) + 'ФИНАЛ';
  const text = buildReport({ file: 'a.py', exitCode: 0, output: big });
  assert.ok(text.includes('[начало вывода обрезано]'));
  assert.ok(text.includes('ФИНАЛ'), 'хвост сохранён');
  assert.ok(text.length < big.length, 'отчёт короче исходного вывода');
  // короткий вывод не обрезается
  const small = buildReport({ output: 'abc' });
  assert.ok(!small.includes('[начало вывода обрезано]'));
});

test('runfmt: процесс ещё идёт и примечания о причине остановки', () => {
  const running = buildReport({ file: 'a.py', running: true, output: '' });
  assert.ok(running.includes('Код возврата: процесс ещё выполняется'));

  const timeout = buildReport({ file: 'a.py', exitCode: -1, reason: 'timeout', output: '' });
  assert.match(timeout, /таймауту бездействия/);
  const limit = buildReport({ file: 'a.py', exitCode: -1, reason: 'output-limit', truncated: true, output: '' });
  assert.match(limit, /вывод превысил лимит/);
  assert.match(limit, /обрезан/);
  const stopped = buildReport({ file: 'a.py', exitCode: -1, reason: 'stopped', output: '' });
  assert.match(stopped, /остановлен пользователем/);
  // обычный выход без примечаний
  const clean = buildReport({ file: 'a.py', exitCode: 0, output: 'ok' });
  assert.ok(!clean.includes('Примечание'));
});

test('runfmt: мусор на входе не роняет сборку отчёта', () => {
  const t1 = buildReport(null);
  assert.equal(typeof t1, 'string');
  assert.ok(t1.includes('(пусто)'));
  const t2 = buildReport({ file: 42, command: null, exitCode: 'ноль', inputLog: 'строка' });
  assert.ok(!t2.includes('Файл:'), 'не-строки не печатаются');
  assert.ok(!t2.includes('Код возврата:'), 'не-число вместо кода не печатается');
  assert.ok(t2.includes('Ввод:\nстрока'), 'строковый журнал ввода допустим');
});

test('runfmt: кольцевой буфер — держит хвост, метит переполнение', () => {
  const ring = createRing(10);
  assert.equal(ring.push('abc'), false);
  assert.equal(ring.text(), 'abc');
  assert.equal(ring.bytes, 3);
  assert.equal(ring.push('defgh'), false);
  assert.equal(ring.bytes, 8);
  // переполнение: 8 + 5 = 13 > 10 — начало выброшено, флаг поднят
  assert.equal(ring.push('ijklm'), true);
  assert.equal(ring.truncated, true);
  assert.equal(ring.text(), 'defghijklm');
  assert.ok(ring.bytes <= 10);
  // пустые куски игнорируются
  assert.equal(ring.push(''), false);
  assert.equal(ring.push(null), false);
  // один кусок больше лимита: остаётся он же (буфер не пустой)
  const r2 = createRing(4);
  r2.push('xx');
  assert.equal(r2.push('yyyyyyyy'), true);
  assert.equal(r2.text(), 'yyyyyyyy');
  // мусорный лимит — к дефолту 4 МБ
  const r3 = createRing(-1);
  r3.push('z'.repeat(1000));
  assert.equal(r3.truncated, false);
});

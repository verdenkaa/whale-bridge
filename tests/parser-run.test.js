'use strict';
// Якоря &RUN: и &CMD: (ТЗ C3 §3.6, §5). Проверяем разбор первой строки блока: путь и
// аргументы у запуска, командная строка «как есть» у команды, тело блока как ввод,
// и что старые маркеры (файл, NEW, DELETE, MOVE) не сломаны.
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseBlock } = require('../src/parser');

test('parser: &RUN: — путь, аргументы и тело как ввод', () => {
  const r = parseBlock('# &RUN:src/main.py\n5\nhello\n');
  assert.deepEqual(r.marker, { op: 'run', path: 'src/main.py', args: [] });
  assert.equal(r.content, '5\nhello\n');
  assert.equal(r.mode, 'full', 'у запуска нет SEARCH/REPLACE');
  assert.deepEqual(r.edits, []);
  assert.deepEqual(r.incomplete, []);

  // аргументы разбираются с учётом кавычек (общий tokenizeArgs)
  const a = parseBlock('# &RUN:main.py "два слова" -v --flag=1\n');
  assert.deepEqual(a.marker.args, ['два слова', '-v', '--flag=1']);
  assert.equal(a.marker.path, 'main.py');

  // пустое тело — ввода нет
  const e = parseBlock('// &RUN:app.js\n');
  assert.equal(e.content, '');
  assert.deepEqual(e.marker.args, []);

  // знаки комментария разных языков
  for (const line of ['// &RUN:a.js', '-- &RUN:a.lua', '; &RUN:a.py', '<!-- &RUN:a.py -->', '/* &RUN:a.c */']) {
    const p = parseBlock(line + '\n');
    assert.equal(p.marker && p.marker.op, 'run', 'маркер распознан: ' + line);
  }
});

test('parser: &CMD: — командная строка как есть, кавычки не срезаются', () => {
  const r = parseBlock('// &CMD:grep -rn "class Player" src\n');
  assert.equal(r.marker.op, 'cmd');
  assert.equal(r.marker.command, 'grep -rn "class Player" src');
  assert.equal(r.marker.path, null, 'у команды нет пути файла');
  assert.equal(r.content, '');

  // концевая кавычка обязана остаться: у файловых маркеров кавычки срезаются, и тот же
  // код на команде превратил бы «echo "a b"» в «echo "a b»
  const q = parseBlock('# &CMD:echo "a b"\n');
  assert.equal(q.marker.command, 'echo "a b"');

  // тело блока — ввод для команды
  const withInput = parseBlock('# &CMD:sort\n3\n1\n2\n');
  assert.equal(withInput.marker.command, 'sort');
  assert.equal(withInput.content, '3\n1\n2\n');

  // пустая команда разбирается (карточка покажет «Пустая команда»), а не падает
  assert.equal(parseBlock('# &CMD:\n').marker.command, '');

  // пайпы, && и кавычки не ломают разбор — классифицирует их уже runlangs
  const complex = parseBlock('# &CMD:dir /b && findstr /i "player" *.gd | more\n');
  assert.equal(complex.marker.command, 'dir /b && findstr /i "player" *.gd | more');
});

test('parser: &amp;-экранировка работает и для новых якорей', () => {
  // текст попал из HTML с двойным экранированием
  const run = parseBlock('# &amp;RUN:test.py\n42\n');
  assert.equal(run.marker.op, 'run');
  assert.equal(run.marker.path, 'test.py');
  assert.equal(run.content, '42\n');

  const cmd = parseBlock('// &amp;CMD:dir\n');
  assert.equal(cmd.marker.op, 'cmd');
  assert.equal(cmd.marker.command, 'dir');
});

test('parser: у &RUN:/&CMD: эвристики «обрезанного кода» не применяются', () => {
  // ввод «...» легитимен: программа могла ждать именно его
  const r = parseBlock('# &RUN:main.py\n...\n');
  assert.deepEqual(r.incomplete, [], 'многоточие во вводе не считается обрезкой');
  const c = parseBlock('# &CMD:cat notes.txt\n... (остальной код без изменений)\n');
  assert.deepEqual(c.incomplete, []);
  // а у файлового предложения эвристика по-прежнему работает
  const f = parseBlock('# &main.py\nprint(1)\n# ... остальной код без изменений\n');
  assert.ok(f.incomplete.length > 0, 'файловое предложение с заглушкой помечено');
});

test('parser: SEARCH/REPLACE внутри &RUN:/&CMD: не превращает блок в патч', () => {
  // тело — ввод, а не правки файла: даже если модель написала туда нечто похожее
  const r = parseBlock('# &RUN:main.py\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n');
  assert.equal(r.mode, 'full');
  assert.deepEqual(r.edits, []);
  assert.equal(r.content, '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n');
});

test('parser: старые маркеры не сломаны новыми якорями', () => {
  assert.deepEqual(parseBlock('# &NEW:a.py\nprint(1)\n').marker, { op: 'create', path: 'a.py' });
  assert.deepEqual(parseBlock('# &src/a.py\nx\n').marker, { op: 'update', path: 'src/a.py' });
  assert.deepEqual(parseBlock('# &DELETE:old.py\n').marker, { op: 'delete', path: 'old.py' });
  assert.deepEqual(parseBlock('# &MOVE:a.py -> b/c.py\n').marker, { op: 'move', path: 'a.py', toPath: 'b/c.py' });
  // путь в кавычках/бэктиках по-прежнему освобождается от них (только у файловых)
  assert.deepEqual(parseBlock('# &`src/a.py`\nx\n').marker, { op: 'update', path: 'src/a.py' });
  assert.deepEqual(parseBlock('# &NEW:"a.py"\nx\n').marker, { op: 'create', path: 'a.py' });
  // у &RUN: кавычки разбирает tokenizeArgs: путь и аргументы получаются без них,
  // а вот у &CMD: командная строка сохраняется буквально (проверено выше)
  const run = parseBlock('# &RUN:"main.py" "два слова"\n');
  assert.equal(run.marker.path, 'main.py');
  assert.deepEqual(run.marker.args, ['два слова']);
});

test('parser: блок без маркера и мусор в маркере', () => {
  assert.equal(parseBlock('просто текст\n').marker, null);
  // RUN без двоеточия — не якорь, а путь файла «RUN file.py»
  const odd = parseBlock('# &RUN file.py\n');
  assert.equal(odd.marker.op, 'update');
  assert.equal(odd.marker.path, 'RUN file.py');
});

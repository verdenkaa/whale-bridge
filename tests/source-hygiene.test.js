'use strict';
// Гигиена исходников. Тест появился не на пустом месте: в комментариях несколько раз
// оказывались посторонние письменности (иероглифы, арабица), а в src/store.js долгое время
// жил буквальный NUL-байт, из-за которого git считал файл двоичным и не показывал по нему
// ни diff, ни review. Ни то ни другое не ломает исполнение, поэтому без теста не ловится.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'release', 'dist', 'assets', '.godot']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.css', '.html', '.yml', '.yaml', '.bat', '.sh', '.patch']);

function collect(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.gitignore') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(abs, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (TEXT_EXT.has(ext) || e.name === '.gitignore' || e.name === 'LICENSE') out.push(abs);
    }
  }
  return out;
}

// Письменности, которым в этом проекте взяться неоткуда: комментарии и строки русские,
// идентификаторы латинские.
const FOREIGN = /[\u0590-\u05ff\u0600-\u06ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/;

const files = collect(ROOT, []);

test('гигиена: в исходниках нет посторонних письменностей', () => {
  assert.ok(files.length > 20, `собрано подозрительно мало файлов: ${files.length}`);
  const hits = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    s.split('\n').forEach((line, i) => {
      if (FOREIGN.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(hits, [], 'найдены посторонние символы:\n' + hits.join('\n'));
});

test('гигиена: в исходниках нет литеральных NUL-байтов', () => {
  // Из-за NUL git считает файл двоичным: diff, review и blame по нему недоступны,
  // а патчи приходится собирать с --binary. Разделители пишутся как '\u0000'.
  const hits = [];
  for (const f of files) {
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) hits.push(path.relative(ROOT, f));
  }
  assert.deepEqual(hits, [], 'файлы с NUL-байтом: ' + hits.join(', '));
});

test('гигиена: нет забытых отладочных конструкций', () => {
  const hits = [];
  for (const f of files) {
    if (path.basename(f).includes('test')) continue; // в тестах отладка уместна
    const rel = path.relative(ROOT, f);
    const s = fs.readFileSync(f, 'utf8');
    s.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (/^\s*debugger\b/.test(line)) hits.push(`${rel}:${i + 1}: debugger`);
      if (/\bconsole\.log\(/.test(line) && !rel.startsWith('spike/')) hits.push(`${rel}:${i + 1}: console.log`);
    });
  }
  assert.deepEqual(hits, [], 'отладочный код в продуктивных файлах:\n' + hits.join('\n'));
});

test('гигиена: файлы оканчиваются переводом строки и не содержат CRLF', () => {
  // CRLF в репозитории при core.autocrlf даёт шумные diff на весь файл; LF держим явно
  const hits = [];
  for (const f of files) {
    if (path.extname(f) === '.bat') continue; // в .bat для Windows CRLF уместен
    const buf = fs.readFileSync(f);
    if (!buf.length) continue;
    if (buf.includes('\r\n'.charCodeAt(0))) {
      if (buf.includes(Buffer.from('\r\n'))) hits.push(path.relative(ROOT, f) + ': CRLF');
    }
    if (buf[buf.length - 1] !== 0x0a) hits.push(path.relative(ROOT, f) + ': нет перевода строки в конце');
  }
  assert.deepEqual(hits, [], hits.join('\n'));
});

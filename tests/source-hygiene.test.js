'use strict';
// Гигиена исходников. Тест появился не на пустом месте: в комментариях несколько раз
// оказывались посторонние письменности (иероглифы, арабица), а в src/store.js долгое время
// жил буквальный NUL-байт, из-за которого git считал файл двоичным и не показывал по нему
// ни diff, ни review. Ни то ни другое не ломает исполнение, поэтому без теста не ловится.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');

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

/** Относительный путь с прямыми косыми — как его показывает git (на Windows path.relative даёт '\\'). */
const relOf = (f) => path.relative(ROOT, f).split(path.sep).join('/');

/** Вывод git по строкам; null — git недоступен. Код 1 у check-ignore означает «ничего не найдено». */
function gitLines(args, input) {
  try {
    const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n');
  } catch (e) {
    if (e && typeof e.stdout === 'string') return e.stdout.split('\n');
    return null;
  }
}

const collected = collect(ROOT, []);

// Гигиена проверяет то, что попадает в репозиторий и в патч. Файлы, которые git
// игнорирует (spike/report.json — отчёт прогона стенда, release/ …), исходниками не
// являются: на машине разработчика они есть, в песочнице нет, и тест не должен от этого
// зависеть. Если git недоступен — откатываемся к явному списку из .gitignore.
const ignoredRels = (() => {
  const rels = collected.map(relOf);
  const out = gitLines(['check-ignore', '--stdin'], rels.length ? rels.join('\n') + '\n' : '');
  if (out === null) return new Set(['spike/report.json', 'spike/report.md']);
  return new Set(out.map((s) => s.trim()).filter(Boolean));
})();

const files = collected.filter((f) => !ignoredRels.has(relOf(f)));

// Переводы строк смотрим в ИНДЕКСЕ git: именно эти байты уходят в коммит, в патч и к
// другому разработчику. Рабочее дерево на Windows при core.autocrlf=true (дефолт Git for
// Windows) содержит CRLF при LF в индексе — это локальное поведение git, а не дефект,
// и ловить его как ошибку значит навсегда закрыть разработку под Windows.
// Формат строки: «i/<eol> w/<eol> attr/<атрибуты>\t<путь>».
const indexEol = (() => {
  const map = new Map();
  for (const line of gitLines(['ls-files', '--eol']) || []) {
    const m = /^i\/(\S+)\s+w\/(\S+)\s+attr\/(.*?)\t(.+)$/.exec(line);
    if (m) map.set(m[4].trim(), m[1]);
  }
  return map;
})();

// Письменности, которым в этом проекте взяться неоткуда: комментарии и строки русские,
// идентификаторы латинские.
const FOREIGN = /[\u0590-\u05ff\u0600-\u06ff\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/;

test('гигиена: в исходниках нет посторонних письменностей', () => {
  assert.ok(files.length > 20, `собрано подозрительно мало файлов: ${files.length}`);
  const hits = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    s.split('\n').forEach((line, i) => {
      if (FOREIGN.test(line)) hits.push(`${relOf(f)}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(hits, [], 'найдены посторонние символы:\n' + hits.join('\n'));
});

test('гигиена: кириллица и латиница не смешаны внутри одного слова', () => {
  // Опечатки такого рода невидимы глазу (латинские буквы внутри кириллического слова)
  // и не ломают исполнение, поэтому без теста живут вечно. Проверяем именно соседство
  // букв разных письменностей, а не «есть ли латиница»: идентификаторы целиком латинские,
  // комментарии целиком кириллические.
  const mixed = /[А-Яа-яЁё][A-Za-z]+|[A-Za-z]+[А-Яа-яЁё]/;
  const hits = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    s.split('\n').forEach((line, i) => {
      // '\n' и прочие экранированные последовательности вырезаем: иначе '\nТекст'
      // выглядит как латинская n вплотную к кириллической Т
      const cleaned = line.replace(/\\(?:x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|u\{[0-9A-Fa-f]+\}|[a-zA-Z])/g, ' ');
      const m = mixed.exec(cleaned);
      if (m) hits.push(`${relOf(f)}:${i + 1}: «${m[0]}» в ${line.trim().slice(0, 70)}`);
    });
  }
  assert.deepEqual(hits, [], 'смешение письменностей внутри слова:\n' + hits.join('\n'));
});

test('гигиена: в исходниках нет литеральных NUL-байтов', () => {
  // Из-за NUL git считает файл двоичным: diff, review и blame по нему недоступны,
  // а патчи приходится собирать с --binary. Разделители пишутся как '\u0000'.
  const hits = [];
  for (const f of files) {
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) hits.push(relOf(f));
  }
  assert.deepEqual(hits, [], 'файлы с NUL-байтом: ' + hits.join(', '));
});

test('гигиена: нет забытых отладочных конструкций', () => {
  const hits = [];
  for (const f of files) {
    if (path.basename(f).includes('test')) continue; // в тестах отладка уместна
    // relOf даёт прямые косые на любой ОС: белый список 'spike/' на Windows не срабатывал
    // против 'spike\main.js', и стенд (где console.log уместен) валил весь тест
    const rel = relOf(f);
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

test('гигиена: в репозитории LF, файлы оканчиваются переводом строки', () => {
  // CRLF в репозитории даёт шумные diff на весь файл и ломает git am у соседа, поэтому
  // LF держим явно (.gitattributes: * text=auto eol=lf). Проверяем байты ИНДЕКСА: при
  // core.autocrlf=true git выдаёт в рабочее дерево CRLF, хотя в коммит уходит LF, —
  // это не дефект исходников, и тест обязан проходить на Windows так же, как в песочнице.
  const hits = [];
  for (const f of files) {
    if (path.extname(f) === '.bat') continue; // в .bat для Windows CRLF уместен
    const rel = relOf(f);
    const buf = fs.readFileSync(f);
    if (!buf.length) continue;
    const idx = indexEol.get(rel);
    if (idx === 'crlf' || idx === 'mixed') {
      hits.push(`${rel}: в индексе ${idx} — в репозиторий обязан попадать LF`);
      continue;
    }
    // Файл ещё не добавлен в git (или git недоступен) — проверяем байты как есть:
    // именно они попадут в коммит следующим git add.
    if (idx === undefined && buf.includes(Buffer.from('\r\n'))) hits.push(rel + ': CRLF');
    if (buf[buf.length - 1] !== 0x0a) hits.push(rel + ': нет перевода строки в конце');
  }
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('гигиена: .gitattributes держит LF в рабочем дереве на всех платформах', () => {
  // Без него переводы строк определяет локальный core.autocrlf разработчика:
  // на Windows рабочее дерево становится CRLF, и проверка LF выше теряет смысл.
  const p = path.join(ROOT, '.gitattributes');
  assert.ok(fs.existsSync(p), '.gitattributes на месте');
  const s = fs.readFileSync(p, 'utf8');
  assert.match(s, /^\* text=auto eol=lf$/m, 'правило «всегда LF» для текстовых файлов');
  assert.match(s, /^\*\.png binary$/m, 'бинарники исключены из нормализации');
});

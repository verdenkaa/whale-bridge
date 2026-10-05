'use strict';
// Частичные правки в формате SEARCH/REPLACE. Чистые функции, без Electron и DOM.
//
//   <<<<<<< SEARCH
//   точные строки из файла
//   =======
//   на что заменить
//   >>>>>>> REPLACE
//
// и замена функции/метода/класса целиком по заголовку (старый код повторять не нужно):
//
//   <<<<<<< REPLACE_BLOCK
//   def main():
//       print("новая версия")
//   >>>>>>> REPLACE_BLOCK

const SEARCH_RE = /^\s*<{5,9}\s*SEARCH\s*$/i;
const DIV_RE = /^\s*={5,9}\s*$/;
const REPLACE_RE = /^\s*>{5,9}\s*REPLACE\s*$/i;
const BLOCK_RE = /^\s*<{5,9}\s*REPLACE_BLOCK\s*$/i;
const BLOCK_END_RE = /^\s*>{5,9}\s*REPLACE_BLOCK\s*$/i;

function hasPatchMarkers(body) {
  return body.split('\n').some((l) => SEARCH_RE.test(l) || BLOCK_RE.test(l));
}

/** @returns {{edits:Array<{search:string[],replace:string[]}>, issues:string[], open:boolean}} */
function parsePatch(body) {
  const lines = body.split('\n');
  const edits = [];
  const issues = [];
  let state = 'out'; // out | search | replace | block
  let cur = null;
  lines.forEach((l, i) => {
    if (state === 'out') {
      if (SEARCH_RE.test(l)) {
        state = 'search';
        cur = { search: [], replace: [] };
      } else if (BLOCK_RE.test(l)) {
        state = 'block';
        cur = { kind: 'block', lines: [] };
      } else if (l.trim() !== '') {
        issues.push(`Лишний текст вне блоков SEARCH/REPLACE (строка ${i + 1})`);
      }
    } else if (state === 'search') {
      if (DIV_RE.test(l)) state = 'replace';
      else if (REPLACE_RE.test(l)) {
        issues.push(`В блоке ${edits.length + 1} нет разделителя =======`);
        state = 'out';
        cur = null;
      } else cur.search.push(l);
    } else if (state === 'block') {
      if (BLOCK_END_RE.test(l)) {
        edits.push(cur);
        state = 'out';
        cur = null;
      } else cur.lines.push(l);
    } else if (REPLACE_RE.test(l)) {
      edits.push(cur);
      state = 'out';
      cur = null;
    } else cur.replace.push(l);
  });
  return { edits, issues, open: state !== 'out' };
}

const indentOf = (l) => /^[ \t]*/.exec(l)[0];

function trimEdges(lines) {
  let a = 0, b = lines.length;
  while (a < b && lines[a].trim() === '') a++;
  while (b > a && lines[b - 1].trim() === '') b--;
  return lines.slice(a, b);
}

const LEVELS = [
  ['exact', (x) => x],
  ['trimEnd', (x) => x.trimEnd()],
  ['trim', (x) => x.trim()],
];

// Поиск последовательности строк; каждый следующий уровень допуска включается, только если на предыдущем совпадений нет
function findMatch(arr, s) {
  for (const [method, norm] of LEVELS) {
    const ns = s.map(norm);
    const hits = [];
    for (let i = 0; i <= arr.length - s.length; i++) {
      let ok = true;
      for (let j = 0; j < s.length; j++) {
        if (norm(arr[i + j]) !== ns[j]) { ok = false; break; }
      }
      if (ok) hits.push(i);
    }
    if (hits.length === 1) return { status: 'ok', index: hits[0], method };
    if (hits.length > 1) return { status: 'ambiguous', hits: hits.map((h) => h + 1).slice(0, 6), method };
  }
  return { status: 'notfound' };
}

// При поиске без учёта отступов переносим разницу отступов и на REPLACE
function adjustIndent(replace, fileLine, searchLine) {
  const fi = indentOf(fileLine), si = indentOf(searchLine);
  if (fi === si) return replace;
  if (fi.startsWith(si)) {
    const extra = fi.slice(si.length);
    return replace.map((l) => (l.trim() === '' ? l : extra + l));
  }
  if (si.startsWith(fi)) {
    const cut = si.slice(fi.length);
    if (replace.every((l) => l.trim() === '' || l.startsWith(cut))) {
      return replace.map((l) => (l.trim() === '' ? l : l.slice(cut.length)));
    }
  }
  return replace;
}

// ---------- замена функции / метода / класса целиком ----------
const CONTROL = /^(if|elif|else|while|for|foreach|switch|case|catch|with|return|await|yield|print|assert|throw|new|do)\b/;
const isDecorator = (l) => /^@[\w.]+(\(.*\))?\s*$/.test(l.trim());
const wsLen = (l) => indentOf(l).length;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Имя функции/класса из заголовка: идентификатор перед первой «(» либо после class/struct/…
function symbolName(header) {
  const t = header.trim();
  let m = /\b(?:class|struct|enum|interface|trait|impl|namespace|module|object|record)\s+([A-Za-z_]\w*)/.exec(t);
  if (m) return { name: m[1], isType: true };
  m = /([A-Za-z_]\w*)\s*(?:<[^<>]*>)?\s*\(/.exec(t);
  if (m) return { name: m[1], isType: false };
  m = /\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=/.exec(t);
  return m ? { name: m[1], isType: false } : null;
}

// Определяем, где кончается заголовок (с учётом многострочной сигнатуры) и каким способом ограничен блок
function analyzeHeader(arr, i) {
  let depth = 0;
  let j = i;
  for (; j < arr.length && j < i + 30; j++) {
    for (const ch of arr[j].replace(/(["'])(?:\\.|(?!\1).)*\1/g, '')) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth <= 0) break;
  }
  if (depth > 0 || j >= arr.length) return null;
  const last = arr[j].replace(/\s*(#.*|\/\/.*)$/, '').trimEnd();
  if (last.endsWith(':')) return { style: 'indent', headerEnd: j };
  if (last.includes('{')) return { style: 'brace', headerEnd: j, braceLine: j };
  let k = j + 1;
  while (k < arr.length && arr[k].trim() === '') k++;
  if (k < arr.length && arr[k].trim().startsWith('{')) return { style: 'brace', headerEnd: j, braceLine: k };
  return null;
}

// Индекс последней строки блока или null
function blockEnd(arr, headerIdx, info) {
  if (info.style === 'indent') {
    const hi = wsLen(arr[headerIdx]);
    let end = info.headerEnd;
    for (let k = info.headerEnd + 1; k < arr.length; k++) {
      if (arr[k].trim() === '') continue;
      if (wsLen(arr[k]) > hi) end = k;
      else break;
    }
    return end;
  }
  let depth = 0;
  let started = false;
  let quote = null;
  let inBlock = false;
  for (let k = info.braceLine; k < arr.length; k++) {
    const l = arr[k];
    for (let c = 0; c < l.length; c++) {
      const ch = l[c], nx = l[c + 1];
      if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; c++; } continue; }
      if (quote) {
        if (ch === '\\') c++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && nx === '/') break;
      if (ch === '/' && nx === '*') { inBlock = true; c++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') {
        depth--;
        if (started && depth === 0) return k;
      }
    }
    if (quote && quote !== '`') quote = null; // обычные строки не переносятся на следующую строку
  }
  return null;
}

// Ищем заголовок: сначала точное совпадение строки, затем — по имени функции/класса
function findBlockHeader(arr, header) {
  const target = header.trim();
  const exact = [];
  arr.forEach((l, i) => { if (l.trim() === target) exact.push(i); });
  if (exact.length === 1) return { status: 'ok', index: exact[0], method: 'block' };
  if (exact.length > 1) return { status: 'ambiguous', hits: exact.map((x) => x + 1) };

  const sym = symbolName(header);
  if (!sym) return { status: 'notfound' };
  const re = sym.isType
    ? new RegExp(`\\b(?:class|struct|enum|interface|trait|impl|namespace|module|object|record)\\s+${escapeRe(sym.name)}\\b`)
    : new RegExp(`(^|[^.\\w])${escapeRe(sym.name)}\\s*(?:<[^<>]*>)?\\s*\\(`);
  const hits = [];
  arr.forEach((l, i) => {
    const t = l.trim();
    if (!t || CONTROL.test(t) || !re.test(l)) return;
    if (analyzeHeader(arr, i)) hits.push(i);
  });
  if (hits.length === 1) return { status: 'ok', index: hits[0], method: 'block-name' };
  if (hits.length > 1) return { status: 'ambiguous', hits: hits.map((x) => x + 1).slice(0, 6) };
  return { status: 'notfound' };
}

function applyBlock(arr, rawLines) {
  const nl = trimEdges(rawLines);
  let k = 0;
  while (k < nl.length && isDecorator(nl[k])) k++;
  if (k >= nl.length) return { status: 'error', hint: 'в блоке REPLACE_BLOCK нет заголовка функции' };
  const header = nl[k];

  const found = findBlockHeader(arr, header);
  if (found.status === 'ambiguous') {
    return { status: 'ambiguous', hits: found.hits, hint: `заголовок «${header.trim().slice(0, 60)}» подходит к нескольким местам (строки ${found.hits.join(', ')}) — используйте SEARCH/REPLACE с контекстом` };
  }
  if (found.status !== 'ok') {
    return { status: 'notfound', hint: `функция или класс «${header.trim().slice(0, 60)}» не найдены в файле — для вставки нового кода используйте SEARCH/REPLACE с соседними строками` };
  }
  const idx = found.index;
  const info = analyzeHeader(arr, idx);
  const end = info ? blockEnd(arr, idx, info) : null;
  if (end == null) {
    return { status: 'error', hint: 'не удалось определить границы функции или класса — используйте SEARCH/REPLACE' };
  }
  // Существующие декораторы выше заголовка заменяем только если новый блок принёс свои
  let m = 0;
  while (idx - 1 - m >= 0 && isDecorator(arr[idx - 1 - m]) && wsLen(arr[idx - 1 - m]) === wsLen(arr[idx])) m++;
  const from = k > 0 ? idx - m : idx;
  const body = adjustIndent(nl, arr[idx], header);
  arr.splice(from, end - from + 1, ...body);
  return { status: 'ok', method: found.method, line: from + 1, endLine: from + body.length };
}

function hintFor(arr, s) {
  const first = s.find((l) => l.trim() !== '');
  if (first === undefined) return '';
  const t = first.trim();
  const at = [];
  arr.forEach((l, i) => { if (l.trim() === t && at.length < 3) at.push(i + 1); });
  return at.length
    ? `первая строка блока есть в файле (строка ${at.join(', ')}), но дальше текст отличается`
    : 'первая строка блока не найдена в файле';
}

/**
 * Применяет правки последовательно (каждая — к результату предыдущей).
 * @returns {{ok:boolean, text?:string, error?:string, results:Array}}
 * results[i]: {status:'ok'|'notfound'|'ambiguous'|'error'|'skipped', method?, line?, hint?, hits?}
 */
function applyEdits(oldText, edits) {
  const norm = oldText.replace(/\r\n?/g, '\n');
  const endsNl = norm.endsWith('\n');
  let arr = norm === '' ? [] : norm.split('\n');
  if (endsNl) arr.pop();

  const results = [];
  let failed = false;
  edits.forEach((e, idx) => {
    if (failed) { results.push({ status: 'skipped' }); return; }
    if (e.kind === 'block') {
      const res = applyBlock(arr, e.lines);
      if (res.status !== 'ok') failed = true;
      results.push(res);
      return;
    }
    const s = trimEdges(e.search);
    let r = e.replace.slice();
    if (s.length === 0) {
      if (arr.length === 0) { arr = r; results.push({ status: 'ok', method: 'exact', line: 1 }); }
      else { failed = true; results.push({ status: 'error', hint: 'пустой SEARCH допустим только для пустого файла' }); }
      return;
    }
    const whole = arr.length >= 10 && s.length >= arr.length * 0.8;
    const m = findMatch(arr, s);
    if (m.status === 'ok') {
      if (m.method === 'trim') {
        const k = s.findIndex((l) => l.trim() !== '');
        r = adjustIndent(r, arr[m.index + k], s[k]);
      }
      arr.splice(m.index, s.length, ...r);
      results.push({ status: 'ok', method: m.method, line: m.index + 1, wholeFile: whole });
    } else if (m.status === 'ambiguous') {
      failed = true;
      results.push({ status: 'ambiguous', hits: m.hits, hint: `фрагмент найден несколько раз (строки ${m.hits.join(', ')}) — нужен более длинный контекст` });
    } else {
      failed = true;
      results.push({ status: 'notfound', hint: hintFor(arr, s) });
    }
  });

  if (failed) {
    const bad = results.findIndex((x) => x.status !== 'ok');
    return { ok: false, results, error: `Блок ${bad + 1}: ${results[bad].hint || 'не удалось применить'}` };
  }
  const text = arr.join('\n') + (endsNl && arr.length ? '\n' : '');
  return { ok: true, text, results };
}

module.exports = { hasPatchMarkers, parsePatch, applyEdits };

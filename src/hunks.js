'use strict';
// Ханки предложения модели и трёхстороннее слияние (этап C, ТЗ §20–§22).
//
// UMD: модуль нужен и в main (require — proposal:merge), и в renderer (<script> —
// принятие ханков в буфер редактора и живой предпросмотр). Правило проекта: авторитетный
// дифф — src/diff.js, а не асинхронный воркер Monaco; решение о записи на диск не может
// зависеть от воркера, поэтому вся математика здесь и покрыта node-тестами.
//
// Модель принятия (согласована с пользователем):
//   base   — версия файла, которую видела модель (aiBase: снимок журнала контекста,
//            либо диск, если файл с тех пор не менялся — сверяется по хэшу);
//   ours   — текущий буфер редактора (или диск, если файл не открыт);
//   theirs — base с применёнными ВЫБРАННЫМИ ханками предложения.
// Результат = merge3(base, ours, theirs): правки пользователя и ханки модели соединяются;
// пересечения становятся конфликтами, которые интерфейс показывает, а не прячет.
//
// Принятие пишет в буфер (файл становится dirty), на диск — только Ctrl+S через
// единственный путь записи fileops.applyChange (§2, §21).

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WhaleHunks = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  const D = (typeof require === 'function')
    ? require('./diff')
    : (root && root.WhaleDiff);
  // Падаем сразу и внятно: молчаливый фолбэк означал бы две реализации слияния.
  if (!D || typeof D.diffLines !== 'function') {
    throw new Error('WhaleDiff не загружен: src/diff.js должен подключаться до src/hunks.js');
  }
  const { diffLines } = D;

  /** Строки текста: CRLF/CR нормализуются, последний пустой хвост отбрасывается (как в diff.js). */
  const linesOf = (t) => (t === '' ? [] : t.replace(/\r\n?/g, '\n').split('\n').filter((x, i, a) => !(i === a.length - 1 && x === '')));

  /** Какой перевод строки доминирует в тексте — для обратной сборки без потери EOL. */
  const eolOf = (t) => (/\r\n/.test(t) ? '\r\n' : '\n');
  const endsWithNl = (t) => /(\r\n|\n)$/.test(t);

  /**
   * Изменения base → other списком {start, end, replacement} в координатах строк base.
   * null — diffLines деградировал (слишком много различий, защита MAX_D).
   */
  function diffChanges(base, other) {
    const ops = diffLines(base, other);
    if (ops == null) return null;
    const out = []; let baseIndex = 0;
    for (let i = 0; i < ops.length;) {
      if (ops[i].type === 'eq') { baseIndex += linesOf(ops[i].text).length; i++; continue; }
      const start = baseIndex; let oldCount = 0; const replacement = [];
      while (i < ops.length && ops[i].type !== 'eq') {
        if (ops[i].type === 'del') oldCount += linesOf(ops[i].text).length;
        else replacement.push(...linesOf(ops[i].text));
        i++;
      }
      out.push({ start, end: start + oldCount, replacement });
      baseIndex += oldCount;
    }
    return out;
  }

  /**
   * Трёхстороннее слияние построчно. Переехало из src/proposals.js без изменения
   * семантики конфликтов, с двумя дополнениями:
   *   1. быстрые пути: ours == base → результат ТОЧНО theirs (байт в байт — от этого
   *      зависит честное правило контекста «результат равен тексту модели → applied»);
   *      theirs == base → точно ours;
   *   2. EOL base сохраняется при обратной сборке (прежняя версия всегда собирала LF,
   *      а CRLF-файлы после слияния теряли переводы строк до записи).
   * @returns {{ok:boolean, conflicts:number, text:string|null}}
   */
  function merge3(base, ours, theirs) {
    if (ours === base) return { ok: true, conflicts: 0, text: theirs };
    if (theirs === base) return { ok: true, conflicts: 0, text: ours };
    const a = diffChanges(base, ours), b = diffChanges(base, theirs);
    if (!a || !b) return { ok: false, conflicts: 1, text: null };
    const changes = [...a.map((x) => ({ ...x, side: 'ours' })), ...b.map((x) => ({ ...x, side: 'theirs' }))]
      .sort((x, y) => x.start - y.start || x.end - y.end || (x.side === 'ours' ? -1 : 1));
    const groups = [];
    for (const ch of changes) {
      const last = groups.at(-1);
      const overlap = last && last.some((x) =>
        (x.start === x.end && ch.start === ch.end && x.start === ch.start) ||
        (x.start < ch.end && ch.start < x.end) ||
        (x.start === x.end && x.start > ch.start && x.start < ch.end) ||
        (ch.start === ch.end && ch.start > x.start && ch.start < x.end));
      if (overlap) last.push(ch); else groups.push([ch]);
    }
    const accepted = [], conflicts = [];
    for (const group of groups) {
      const oursCh = group.filter((x) => x.side === 'ours'), theirsCh = group.filter((x) => x.side === 'theirs');
      if (!oursCh.length || !theirsCh.length) { accepted.push(group[0]); continue; }
      if (oursCh.length === 1 && theirsCh.length === 1 &&
          oursCh[0].start === theirsCh[0].start && oursCh[0].end === theirsCh[0].end &&
          oursCh[0].replacement.join('\n') === theirsCh[0].replacement.join('\n')) { accepted.push(oursCh[0]); continue; }
      conflicts.push({ start: Math.min(...group.map((x) => x.start)), end: Math.max(...group.map((x) => x.end)),
        ours: oursCh.map((x) => x.replacement.join('\n')).join('\n'),
        theirs: theirsCh.map((x) => x.replacement.join('\n')).join('\n') });
    }
    const baseLines = linesOf(base);
    const all = [...accepted.map((x) => ({ ...x, kind: 'ok' })), ...conflicts.map((x) => ({ ...x, kind: 'conflict' }))]
      .sort((x, y) => x.start - y.start || x.end - y.end);
    const eol = eolOf(base);
    const out = []; let pos = 0;
    for (const ch of all) {
      if (ch.start > pos) out.push(...baseLines.slice(pos, ch.start));
      if (ch.kind === 'ok') out.push(...ch.replacement);
      else {
        out.push('<<<<<<< YOUR CURRENT FILE');
        if (ch.ours) out.push(...linesOf(ch.ours));
        out.push('=======');
        if (ch.theirs) out.push(...linesOf(ch.theirs));
        out.push('>>>>>>> AI PROPOSAL');
      }
      pos = Math.max(pos, ch.end);
    }
    if (pos < baseLines.length) out.push(...baseLines.slice(pos));
    return { ok: conflicts.length === 0, conflicts: conflicts.length, text: out.join(eol) + (endsWithNl(base) ? eol : '') };
  }

  /**
   * Разбивает дифф base → proposed на ханки — группы изменений с контекстом, как в git.
   * Ханки не пересекаются и отсортированы по возрастанию; соседние группы изменений
   * сливаются в один ханк, если между ними не больше 2*ctx неизменённых строк.
   *
   * @returns {Array|null} null — diffLines деградировал (различий больше MAX_D):
   * применять такое по ханкам нельзя, интерфейс обязан сказать об этом явно.
   *
   * Поля ханка:
   *   index        — порядковый номер (идентификатор выбора);
   *   baseStart    — 0-based индекс первой строки ханка в base (включая контекст);
   *   baseLines    — строки стороны base (eq+del) — ТОЧНО base.slice(baseStart, baseStart+len);
   *   newLines     — строки стороны proposed (eq+add);
   *   baseLineStart/baseLineEnd — 1-based диапазон по base (для подписи);
   *   added/removed — счётчики изменений;
   *   snippet      — первая изменённая строка для списка (обрезана).
   */
  function toHunks(baseText, proposedText, ctx = 3) {
    const ops = diffLines(baseText, proposedText);
    if (ops == null) return null;
    // Плоская последовательность строк: eq/del принадлежат base, eq/add — proposed
    const items = [];
    for (const op of ops) {
      for (const text of linesOf(op.text)) items.push({ type: op.type, text });
    }
    // Префиксные счётчики строк base, чтобы знать baseStart любой позиции
    const basePrefix = new Array(items.length + 1);
    basePrefix[0] = 0;
    for (let i = 0; i < items.length; i++) {
      basePrefix[i + 1] = basePrefix[i] + (items[i].type === 'add' ? 0 : 1);
    }
    const n = items.length;
    const isChange = (it) => it.type !== 'eq';
    const hunks = [];
    let i = 0;
    while (i < n) {
      if (!isChange(items[i])) { i++; continue; }
      // группа изменений: растёт, пока пробелы неизменённых строк не длиннее 2*ctx
      const groupStart = i;
      let groupEnd = i;
      let runEq = 0;
      let j = i;
      while (j < n) {
        if (isChange(items[j])) { groupEnd = j; runEq = 0; j++; }
        else { runEq++; if (runEq > ctx * 2) break; j++; }
      }
      const from = Math.max(0, groupStart - ctx);
      const to = Math.min(n - 1, groupEnd + ctx);
      const baseLines = [], newLines = [];
      let added = 0, removed = 0, snippet = null;
      for (let k = from; k <= to; k++) {
        const it = items[k];
        if (it.type === 'eq') { baseLines.push(it.text); newLines.push(it.text); }
        else if (it.type === 'del') { baseLines.push(it.text); removed++; if (snippet == null) snippet = '- ' + it.text; }
        else { newLines.push(it.text); added++; if (snippet == null) snippet = '+ ' + it.text; }
      }
      const baseStart = basePrefix[from];
      hunks.push({
        index: hunks.length, baseStart, baseLines, newLines, added, removed,
        baseLineStart: baseStart + 1,
        baseLineEnd: baseStart + baseLines.length,
        snippet: (snippet == null ? '' : snippet).slice(0, 80),
      });
      i = groupEnd + 1;
    }
    return hunks;
  }

  /**
   * Текст base с применёнными выбранными ханками (позиционно, ханки не пересекаются).
   * Это «theirs» для merge3: что предложила бы модель, если бы пользователь принял
   * только отмеченное. selected — Set/array индексов ханков.
   *
   * proposedEndsNl передаёт вызывающий (у самого base хвост может быть другим):
   * когда выбран последний ханк, доходящий до конца файла, хвост результата
   * определяется proposed-стороной.
   */
  function applySelection(baseText, hunks, selected, proposedEndsNl = null) {
    const sel = selected instanceof Set ? selected : new Set(selected || []);
    const base = linesOf(baseText);
    const eol = eolOf(baseText);
    const sorted = [...(hunks || [])].sort((a, b) => a.baseStart - b.baseStart);
    const out = [];
    let pos = 0;
    let lastSelected = null;
    for (const hk of sorted) {
      if (!sel.has(hk.index)) continue;
      out.push(...base.slice(pos, hk.baseStart));
      out.push(...hk.newLines);
      pos = hk.baseStart + hk.baseLines.length;
      lastSelected = hk;
    }
    out.push(...base.slice(pos));
    if (!out.length) return '';
    const tailReached = !!lastSelected && lastSelected.baseStart + lastSelected.baseLines.length >= base.length;
    const nl = proposedEndsNl != null && tailReached ? proposedEndsNl : endsWithNl(baseText);
    return out.join(eol) + (nl ? eol : '');
  }

  return { linesOf, eolOf, diffChanges, merge3, toHunks, applySelection };
});

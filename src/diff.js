'use strict';
// Построчный Diff (алгоритм Майерса). Без зависимостей.
//
// UMD: модуль нужен и в main (require), и в renderer (<script>, window.WhaleDiff) —
// на этапе Crenderer сам считает ханки и предпросмотр слияния, а правило «авторитетный
// дифф — src/diff.js, а не воркер Monaco» требует, чтобы реализация была одна.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WhaleDiff = api;
})(typeof window !== 'undefined' ? window : null, function () {

const MAX_D = 3000; // защита от квадратичного роста памяти

function splitLines(t) {
  if (t === '') return [];
  const a = t.replace(/\r\n?/g, '\n').split('\n');
  if (a[a.length - 1] === '') a.pop();
  return a;
}

// Возвращает массив {type:'eq'|'add'|'del', text} или null, если различий слишком много
function myers(a, b) {
  const N = a.length, M = b.length, max = N + M;
  if (max === 0) return [];
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  v[offset + 1] = 0;
  const limit = Math.min(max, MAX_D);

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2)); // состояние до раунда d; k -> индекс k + d + 1
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= N && y >= M) return backtrack(trace, a, b, d);
    }
  }
  return null;
}

function backtrack(trace, a, b, D) {
  const out = [];
  let x = a.length, y = b.length;
  for (let d = D; d >= 0; d--) {
    const snap = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && snap[k - 1 + d + 1] < snap[k + 1 + d + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = snap[prevK + d + 1];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--; y--;
      out.push({ type: 'eq', text: a[x] });
    }
    if (d > 0) {
      if (down) { y--; out.push({ type: 'add', text: b[y] }); }
      else { x--; out.push({ type: 'del', text: a[x] }); }
    }
  }
  return out.reverse();
}

function diffLines(oldText, newText) {
  const a = splitLines(oldText), b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let ea = a.length, eb = b.length;
  while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) { ea--; eb--; }

  const midA = a.slice(start, ea), midB = b.slice(start, eb);
  let mid = myers(midA, midB);
  if (!mid) mid = [...midA.map((text) => ({ type: 'del', text })), ...midB.map((text) => ({ type: 'add', text }))];

  const ops = [
    ...a.slice(0, start).map((text) => ({ type: 'eq', text })),
    ...mid,
    ...a.slice(ea).map((text) => ({ type: 'eq', text })),
  ];
  let o = 1, n = 1;
  for (const op of ops) {
    if (op.type === 'eq') { op.oldNo = o++; op.newNo = n++; }
    else if (op.type === 'del') op.oldNo = o++;
    else op.newNo = n++;
  }
  return ops;
}

function diffStats(ops) {
  let added = 0, removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
  }
  return { added, removed };
}

// Сворачивает длинные неизменённые участки, оставляя контекст вокруг правок
function toRows(ops, ctx = 3) {
  const keep = new Uint8Array(ops.length);
  let any = false;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type === 'eq') continue;
    any = true;
    for (let j = Math.max(0, i - ctx); j <= Math.min(ops.length - 1, i + ctx); j++) keep[j] = 1;
  }
  if (!any) return [];
  const rows = [];
  let skipped = 0;
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) {
      if (skipped) { rows.push({ type: 'skip', count: skipped }); skipped = 0; }
      rows.push(ops[i]);
    } else skipped++;
  }
  if (skipped) rows.push({ type: 'skip', count: skipped });
  return rows;
}

/**
 * Обычный unified diff — то, что понимает и `patch`, и любая модель.
 *
 * Нужен именно он, а не полный текст файла: передавать модели миллион строк ради
 * одной заменённой строки импорта — значит выбросить её контекст. Diff сообщает
 * ровно то, что требуется: что изменилось с тех пор, как модель видела файл.
 *
 * @returns {string} пустая строка, если тексты идентичны
 */
function toUnifiedDiff(oldText, newText, opts = {}) {
  const ctx = opts.context == null ? 3 : opts.context;
  const ops = diffLines(oldText, newText);
  const changed = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].type !== 'eq') changed.push(i);
  if (!changed.length) return '';

  // Координаты в обоих файлах для каждой операции. diffLines проставляет только
  // «свою» сторону (у del нет newNo, у add нет oldNo), а заголовок hunk'а требует обеих.
  const coord = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    coord.push({ o, n });
    if (op.type === 'eq') { o++; n++; } else if (op.type === 'del') { o++; } else { n++; }
  }

  // Правки, разделённые больше чем двумя ширинами контекста, попадают в разные hunk'и
  const groups = [[changed[0]]];
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - changed[k - 1] <= ctx * 2) groups[groups.length - 1].push(changed[k]);
    else groups.push([changed[k]]);
  }

  const out = [];
  if (opts.oldLabel != null) out.push('--- ' + opts.oldLabel);
  if (opts.newLabel != null) out.push('+++ ' + opts.newLabel);

  for (const g of groups) {
    const from = Math.max(0, g[0] - ctx);
    const to = Math.min(ops.length - 1, g[g.length - 1] + ctx);
    const body = [];
    let oldCount = 0;
    let newCount = 0;
    for (let i = from; i <= to; i++) {
      const op = ops[i];
      if (op.type === 'eq') { body.push(' ' + op.text); oldCount++; newCount++; } else if (op.type === 'del') { body.push('-' + op.text); oldCount++; } else { body.push('+' + op.text); newCount++; }
    }
    // При нулевом количестве строк с одной из сторон git указывает предыдущую строку,
    // а не следующую. Держимся того же соглашения — иначе diff не применится патчем.
    const oldStart = oldCount === 0 ? Math.max(0, coord[from].o - 1) : coord[from].o;
    const newStart = newCount === 0 ? Math.max(0, coord[from].n - 1) : coord[from].n;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    out.push(...body);
  }
  return out.join('\n') + '\n';
}

return { diffLines, diffStats, toRows, splitLines, toUnifiedDiff };
});

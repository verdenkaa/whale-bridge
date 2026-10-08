'use strict';
const { hasPatchMarkers, parsePatch } = require('./patch');
// tokenizeArgs — общий разбор аргументов командной строки (ТЗ C3 §3.1): один и тот же
// для маркера &RUN: и для дополнительных аргументов в настройках запуска.
const { tokenizeArgs } = require('./runlangs');
// Разбор кодовых блоков: маркер файла в первой строке + эвристики «обрезанного» кода.
// Не зависит ни от DOM DeepSeek, ни от Electron.

// Комментарий (любого распространённого языка) + & + [NEW:] + путь
const MARKER_RE =
  /^\s*(?:#|\/\/|--|;|%|'|REM\s+|\/\*+|<!--|\{-)\s*&\s*(NEW\s*:\s*)?(.+?)\s*(?:\*\/|-->|-\})?\s*$/i;

// Если текст попал из HTML с двойным экранированием, «&amp;» сразу после комментария считаем «&»
const ESCAPED_AMP = /^(\s*(?:#|\/\/|--|;|%|'|\/\*+|<!--|\{-)\s*)&amp;/i;

function matchMarker(line) {
  return MARKER_RE.exec(line.replace(ESCAPED_AMP, '$1&'));
}

const COMMENT_START = /^\s*(?:#|\/\/|--|;|\/\*+|<!--|\*)/;
const ELLIPSIS_COMMENT = /^\s*(?:#|\/\/|--|;|\/\*+|<!--|\*)\s*(?:\.{3}|…)/;
const ELLIPSIS_ALONE = /^\s*(?:\.{3}|…)\s*$/;
const PHRASES =
  /(rest of (?:the )?(?:code|file|function|class|script)|remaining (?:code|part)|existing code|previous code|same as before|unchanged|остальн\w+\s+(?:код|част|функци|метод)|без изменени|прежн\w+\s+код|как (?:было|раньше)|здесь (?:был|будет|остаётся|остается))/i;

function detectIncomplete(content) {
  const found = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && found.length < 10; i++) {
    const l = lines[i];
    if (
      ELLIPSIS_COMMENT.test(l) ||
      ELLIPSIS_ALONE.test(l) ||
      (COMMENT_START.test(l) && PHRASES.test(l))
    ) {
      found.push({ line: i + 1, text: l.trim().slice(0, 120) });
    }
  }
  return found;
}

/**
 * @returns {{marker, mode:'full'|'patch', content:string, incomplete:Array, edits:Array, issues:string[], open:boolean}}
 * content — без строки маркера, с одним завершающим переводом строки.
 * mode 'patch' — в блоке есть SEARCH/REPLACE: content хранит исходный текст правок, а не файл.
 */
function parseBlock(rawText) {
  const text = String(rawText).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const NONE = { mode: 'full', incomplete: [], edits: [], issues: [], open: false };
  if (i >= lines.length) return { ...NONE, marker: null, content: '' };

  const m = matchMarker(lines[i]);
  if (!m) return { ...NONE, marker: null, content: text };

  const rawP = m[2].trim();
  const actionName = (rawP.match(/^(DELETE|MOVE|RUN|CMD)\s*:/i) || [])[1];
  const opName = actionName ? actionName.toLowerCase() : null;
  // У файловых маркеров модель иногда оборачивает путь в кавычки или бэктики — срезаем.
  // У RUN и CMD НЕ срезаем: кавычки там часть синтаксиса («&CMD:echo "a b"»,
  // «&RUN:main.py "два аргумента"»), а срезанная концевая кавычка сломала бы команду
  // и превратила бы аргументы в кашу (ТЗ §3.6: «кавычки не срезаются»).
  const p = opName === 'run' || opName === 'cmd'
    ? rawP
    : rawP.replace(/^[`'"]+|[`'"]+$/g, '');
  const body = lines.slice(i + 1).join('\n').replace(/\n+$/, '');
  const content = body === '' ? '' : body + '\n';
  let marker;
  const action = p.match(/^(DELETE|MOVE|RUN|CMD)\s*:\s*([\s\S]*)$/i);
  if (action) {
    const op = action[1].toLowerCase();
    const rest = action[2];
    if (op === 'delete') {
      marker = { op: 'delete', path: rest.trim() };
    } else if (op === 'move') {
      const parts = rest.split(/\s*->\s*/);
      marker = { op: 'move', path: parts[0].trim(), toPath: parts.slice(1).join('->').trim() };
    } else if (op === 'run') {
      // Первый токен — путь к файлу проекта (проверяется resolveInProject уже в
      // proposals), остальные — аргументы командной строки с учётом кавычек.
      const tokens = tokenizeArgs(rest.trim());
      marker = { op: 'run', path: tokens.length ? tokens[0] : '', args: tokens.slice(1) };
    } else {
      // cmd: командная строка как есть. Путь не резолвится — команда живёт в корне
      // проекта, но ссылаться может куда угодно: это осознанное действие пользователя.
      marker = { op: 'cmd', path: null, command: rest.trim() };
    }
  } else {
    marker = { op: m[1] ? 'create' : 'update', path: p };
  }
  if (opName === 'run' || opName === 'cmd') {
    // Тело блока — ввод для stdin, а не текст файла: SEARCH/REPLACE здесь неприменим,
    // и эвристики «обрезанного кода» тоже (многоточие может быть легитимным вводом).
    return { ...NONE, marker, content, incomplete: [] };
  }
  if (hasPatchMarkers(body)) {
    const patch = parsePatch(body);
    return { marker, mode: 'patch', content, incomplete: [], edits: patch.edits, issues: patch.issues, open: patch.open };
  }
  return { ...NONE, marker, content, incomplete: detectIncomplete(content) };
}

// Для ручной вставки из буфера: достаёт тела ```-блоков (или весь текст, если блоков нет)
function extractFencedBlocks(text) {
  const out = [];
  const re = /```[^\n]*\n([\s\S]*?)\n?```/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out.length ? out : [text];
}

module.exports = { parseBlock, detectIncomplete, extractFencedBlocks };

'use strict';
// Форматирование результатов запуска (ТЗ C3 §2.3): очистка вывода от ANSI-кодов и
// сборка отчёта для вставки в чат DeepSeek. Чистые функции — main только кладёт
// готовый текст в буфер обмена.

/**
 * Управляющие последовательности терминала: CSI (цвета gcc/python, курсор), OSC
 * (заголовок окна, гиперссылки) и одиночный ESC. xterm их отрисовывает, а в отчёте
 * для чата они превратились бы в нечитаемый мусор.
 */
const ANSI_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[NO][@-~]|\u001b[@-Z\\-_]/g;

const stripAnsi = (s) => (typeof s === 'string' ? s.replace(ANSI_RE, '') : '');

/**
 * Управляющие символы, которым в отчёте не место: всё из C0 кроме табуляции (\t),
 * перевода строки (\n) и возврата каретки (\r — обрабатывается отдельно), плюс DEL.
 * Сюда попадают, например, Ctrl+C (\u0003) и остатки стрелок после снятия ESC-последовательностей.
 */
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Ввод для отчёта. Три вещи, которые ломали читаемость:
 *   1. ConPTY запрашивает у терминала уведомления о фокусе (режим 1004), xterm.js
 *      отвечает '\u001b[I' / '\u001b[O' — в журнале ввода это выглядело как «[I[I1256»;
 *   2. каждое нажатие Enter приходит как '\r', и без перевода в '\n' строки ввода
 *      склеивались в одну ('12' + '56' → '1256');
 *   3. прочие управляющие символы (DEL от Backspace, Ctrl+C) в чате нечитаемы.
 * CRLF нормализуется к LF, хвостовые переводы строк убирает вызывающий.
 */
function cleanInput(text) {
  const s = typeof text === 'string' ? text : '';
  return stripAnsi(s).replace(/\r\n?/g, '\n').replace(CTRL_RE, '');
}

/**
 * Короткое имя инструмента для отчёта: 'C:\Python312\python.exe' → 'python',
 * '/usr/bin/gcc' → 'gcc'. На Windows суффикс .exe снимается — в строке, которую
 * пользователь вставляет в чат, он только шумит. Артефакты сборки сюда не попадают:
 * их раннер показывает относительным путём ('.ide_build/app.exe').
 */
function shortToolName(exe, platform) {
  const raw = typeof exe === 'string' ? exe : (exe == null ? '' : String(exe));
  if (!raw) return '';
  const base = raw.split(/[\\/]/).pop();
  return platform === 'win32' ? base.replace(/\.exe$/i, '') : base;
}

/** Сколько хвоста вывода попадает в отчёт (~200 КБ, ТЗ §2.3). */
const REPORT_OUTPUT_LIMIT = 200_000;

const fence = (text) => (text.includes('```') ? '````' : '```');

/**
 * Отчёт о прогоне: файл/команда, папка проекта, код возврата, ввод и вывод.
 * Вывод оборачивается в ```-ограждение для красивого рендера в чате; если сам вывод
 * содержит ```, ограждение повышается до ````. При обрезке хвоста — пометка.
 *
 * @param {object} s {file, command, projectDir, exitCode, inputLog, output,
 *                     running, truncated, reason}
 * @returns {string}
 */
function buildReport(s) {
  const src = s && typeof s === 'object' ? s : {};
  const lines = [];
  if (typeof src.file === 'string' && src.file) lines.push('Файл: ' + src.file);
  if (typeof src.command === 'string' && src.command) lines.push('Команда: ' + src.command);
  if (typeof src.projectDir === 'string' && src.projectDir) lines.push('Папка проекта: ' + src.projectDir);
  if (typeof src.exitCode === 'number') lines.push('Код возврата: ' + src.exitCode);
  else if (src.running) lines.push('Код возврата: процесс ещё выполняется');

  const inputText = cleanInput(Array.isArray(src.inputLog) ? src.inputLog.join('') : String(src.inputLog || ''));
  if (inputText.trim()) {
    lines.push('', 'Ввод:', inputText.replace(/\n+$/, ''));
  }

  // pty отдаёт CRLF — в отчёте для чата переводы строк нормализуются к LF
  const cleaned = stripAnsi(typeof src.output === 'string' ? src.output : '').replace(/\r\n/g, '\n');
  const trimmed = cleaned.length > REPORT_OUTPUT_LIMIT
    ? '[начало вывода обрезано]\n' + cleaned.slice(cleaned.length - REPORT_OUTPUT_LIMIT)
    : cleaned;
  const body = trimmed.replace(/\n+$/, '');
  lines.push('', 'Вывод:');
  if (body) {
    const f = fence(body);
    lines.push(f, body, f);
  } else {
    lines.push('(пусто)');
  }
  const notes = [];
  if (src.truncated) notes.push('вывод превысил лимит и обрезан');
  if (src.reason === 'timeout') notes.push('процесс остановлен по таймауту бездействия');
  if (src.reason === 'output-limit') notes.push('процесс остановлен: вывод превысил лимит');
  if (src.reason === 'stopped') notes.push('процесс остановлен пользователем');
  if (notes.length) lines.push('', 'Примечание: ' + notes.join('; ') + '.');
  return lines.join('\n') + '\n';
}

/**
 * Кольцевой буфер вывода: держит не больше max байт (по длине строк), при
 * переполнении выбрасывает НАЧАЛО — в отчёте важнее хвост с ошибкой.
 */
function createRing(maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 4 * 1024 * 1024;
  const parts = [];
  let size = 0;
  let dropped = false;
  return {
    get bytes() { return size; },
    get truncated() { return dropped; },
    push(chunk) {
      const s = typeof chunk === 'string' ? chunk : String(chunk == null ? '' : chunk);
      if (!s) return false;
      parts.push(s);
      size += s.length;
      const over = size > limit;
      while (size > limit && parts.length > 1) {
        size -= parts.shift().length;
        dropped = true;
      }
      return over; // true — лимит превышен (вызывающий решает, останавливать ли процесс)
    },
    text() { return parts.join(''); },
  };
}

module.exports = { stripAnsi, cleanInput, shortToolName, buildReport, createRing, REPORT_OUTPUT_LIMIT, ANSI_RE, CTRL_RE };

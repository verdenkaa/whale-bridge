'use strict';
// Stage 0 (ТЗ §36–38): модель версий файла. Только чистые функции — без fs, crypto и Electron.
//
// Система обязана различать ЧЕТЫРЕ версии одного файла:
//
//   aiBase — что видела модель, когда предлагала правку        (A)
//   disk   — что сейчас на диске                                (B)
//   saved  — что редактор считает сохранённым (содержимое на момент загрузки/последней записи)  (S)
//   editor — что сейчас в буфере Monaco                         (C)
//
//          AI
//           │ знает
//           ↓
//         aiBase (A)
//           │
//           ↓
//     Editor (C) ──── saved (S) ──── Disk (B)
//
// Треугольник из ТЗ (§37) — это A/B/C. Четвёртый хэш (S) нужен, потому что «dirty»
// и «файл изменился на диске» — разные события, и их нельзя вывести из трёх хэшей:
//   dirty      = C !== S   (пользователь что-то напечатал)
//   diskDrift  = B !== S   (файл изменился вне редактора после загрузки)
// Без S эти два случая неразличимы, а от них зависит, показывать ли конфликт сохранения (§11).
//
// Значения хэшей:
//   строка sha256 — обычная версия;
//   ABSENT        — файла не существует;
//   null          — версия ещё не известна (не читали). null !== ABSENT: это разные факты.

const { normalizeRel } = require('./paths');

const ABSENT = 'absent';

const isHash = (h) => typeof h === 'string' && h.length > 0;
const known = (h) => h !== null && h !== undefined;
const short = (h) => (!known(h) ? '—' : h === ABSENT ? 'нет файла' : String(h).slice(0, 8));

// ---------- Идентичности (ТЗ §36) ----------
// Файл однозначно определяется парой (projectId, relPath); proposal — тройкой (chatId, proposalId, contentHash).
// Ключи нужны, чтобы renderer и main одинаково называли один и тот же объект, а не сравнивали пути строками.

const KEY_SEP = '::';

function fileIdentity({ projectId, relPath, diskHash = null } = {}) {
  if (typeof projectId !== 'string' || !projectId.trim()) return { ok: false, error: 'Не указан projectId' };
  const n = normalizeRel(relPath);
  if (!n.ok) return { ok: false, error: n.error };
  if (diskHash !== null && !isHash(diskHash)) return { ok: false, error: 'Некорректный diskHash' };
  return { ok: true, key: projectId + KEY_SEP + n.rel, projectId, relPath: n.rel, diskHash };
}

function proposalIdentity({ chatId, proposalId, contentHash } = {}) {
  if (typeof chatId !== 'string' || !chatId.trim()) return { ok: false, error: 'Не указан chatId' };
  if (typeof proposalId !== 'string' || !proposalId.trim()) return { ok: false, error: 'Не указан proposalId' };
  if (!isHash(contentHash)) return { ok: false, error: 'Не указан contentHash' };
  return { ok: true, key: chatId + KEY_SEP + proposalId + KEY_SEP + contentHash, chatId, proposalId, contentHash };
}

/** Разбирает ключ файла обратно. Для ключей, собранных не fileIdentity, возвращает ok:false. */
function parseFileKey(key) {
  if (typeof key !== 'string') return { ok: false, error: 'Ключ должен быть строкой' };
  const i = key.indexOf(KEY_SEP);
  if (i <= 0 || i + KEY_SEP.length >= key.length) return { ok: false, error: 'Неверный формат ключа файла' };
  return fileIdentity({ projectId: key.slice(0, i), relPath: key.slice(i + KEY_SEP.length) });
}

// ---------- Классификация версий ----------

/**
 * @param {{aiBase?:string|null, disk?:string|null, saved?:string|null, editor?:string|null, dirty?:boolean}} v
 *   editor — хэш буфера. Если он неизвестен, но dirty известен точно (renderer сравнивает
 *   текст буфера с сохранённым посимвольно — это строже любого хэша), передайте dirty:
 *   в sandbox-рендерере нет Node-crypto, а дублировать хэширование в два процесса нельзя —
 *   расхождение дало бы «файл чист» при несохранённой правке.
 * @returns {{
 *   state: 'unknown'|'in-sync'|'editor-dirty'|'disk-drift'|'save-conflict',
 *   dirty: boolean, diskDrift: boolean, aiStale: boolean, saveConflict: boolean,
 *   saveDecision: 'unknown'|'noop'|'ok'|'reload'|'conflict',
 *   aiApply: 'unknown'|'direct'|'merge3',
 *   aiBaseAbsent: boolean, summary: string
 * }}
 */
function classifyVersions(v = {}) {
  const aiBase = v.aiBase === undefined ? null : v.aiBase;
  const disk = v.disk === undefined ? null : v.disk;
  const saved = v.saved === undefined ? null : v.saved;
  const editor = v.editor === undefined ? null : v.editor;

  // dirty — только если есть с чем сравнивать: буфер и точка сохранения известны.
  // Явно переданный dirty имеет приоритет при неизвестном editor (см. JSDoc выше).
  const dirty = known(editor) && known(saved)
    ? editor !== saved
    : (typeof v.dirty === 'boolean' ? v.dirty : false);
  // drift — диск уехал от того, что редактор загрузил/сохранил
  const diskDrift = known(saved) && known(disk) && disk !== saved;
  // предложение модели устарело: модель видела не ту версию, что сейчас на диске
  const aiStale = known(aiBase) && known(disk) && aiBase !== disk;
  const saveConflict = dirty && diskDrift;

  const dirtyKnown = (known(editor) && known(saved)) || typeof v.dirty === 'boolean';
  let state = 'unknown';
  if (dirtyKnown && known(saved) && known(disk)) {
    if (saveConflict) state = 'save-conflict';
    else if (dirty) state = 'editor-dirty';
    else if (diskDrift) state = 'disk-drift';
    else state = 'in-sync';
  }

  // Что делать на Ctrl+S (ТЗ §11–12). 'conflict' — запись запрещена, данные не тронуты.
  let saveDecision = 'unknown';
  if (dirtyKnown && known(saved) && known(disk)) {
    if (saveConflict) saveDecision = 'conflict';
    else if (dirty) saveDecision = 'ok';
    else if (diskDrift) saveDecision = 'reload'; // своих правок нет — достаточно перечитать файл
    else saveDecision = 'noop';
  }

  // Как применять предложение модели к буферу (ТЗ §20–22). База слияния — всегда aiBase,
  // а не disk: модель рассуждала именно про aiBase. Диск здесь не участвует — он проверяется
  // отдельно, на сохранении.
  let aiApply = 'unknown';
  if (known(aiBase) && known(editor)) aiApply = editor === aiBase ? 'direct' : 'merge3';

  return {
    state,
    dirty,
    diskDrift,
    aiStale,
    saveConflict,
    saveDecision,
    aiApply,
    aiBaseAbsent: aiBase === ABSENT,
    summary: `AI видел: ${short(aiBase)} · на диске: ${short(disk)} · сохранено: ${short(saved)} · в редакторе: ${short(editor)}`,
  };
}

/**
 * Проверка ожидаемого хэша перед записью — единая точка, чтобы renderer и main
 * не расходились в трактовке (ТЗ §9, шаги 3–5).
 * @returns {{ok:true}|{ok:false, code:'conflict'|'unknown', expected:*, actual:*}}
 */
function checkExpectedHash(expectedHash, actualHash) {
  if (!known(expectedHash) || !known(actualHash)) {
    return { ok: false, code: 'unknown', expected: expectedHash ?? null, actual: actualHash ?? null };
  }
  if (expectedHash !== actualHash) {
    return { ok: false, code: 'conflict', expected: expectedHash, actual: actualHash };
  }
  return { ok: true };
}

module.exports = {
  ABSENT,
  KEY_SEP,
  fileIdentity,
  proposalIdentity,
  parseFileKey,
  classifyVersions,
  checkExpectedHash,
  shortHash: short,
};

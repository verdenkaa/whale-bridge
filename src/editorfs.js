'use strict';
// Stage A (ТЗ §9, §11, §12): чтение и запись файла из редактора.
//
// Единственная точка записи — fileops.applyChange (ТЗ §2). Редактор НЕ заводит собственную
// логику сохранения рядом с proposal и rollback: иначе получились бы три разных способа
// испортить файл, каждый со своей проверкой конфликтов и своими бэкапами.
//
// Модуль не зависит от Electron, поэтому весь сценарий «открыл → отредактировал → сохранил»
// и конфликт из §11 покрыты node-тестами.

const crypto = require('crypto');
const { resolveInProject } = require('./paths');
const fileops = require('./fileops');
const { checkExpectedHash, ABSENT } = require('./versions');

// Тот же лимит, что и для применённых предложений: 2 последние версии файла
const MAX_BACKUPS_PER_FILE = 2;
// Ограничение совпадает с fileops.MAX_READ_BYTES, чтобы чтение и запись не расходились
const MAX_WRITE_BYTES = 5 * 1024 * 1024;

const fail = (code, error, extra) => ({ ok: false, code, error, ...(extra || {}) });

/**
 * Чтение файла для редактора.
 * hash — это sha256 БАЙТОВ на диске; renderer обязан вернуть его же в expectedHash при
 * сохранении. content — текст в виде, пригодном для Monaco (BOM снят); eol/hasBom
 * возвращаются, чтобы hashTextLike() мог пересчитать хэш буфера обратно в байты диска.
 * @returns {Promise<{ok:true, projectId, path, content, hash, eol, hasBom, size}|{ok:false, code, error}>}
 */
async function readForEditor(project, rel) {
  if (!project) return fail('no-project', 'Проект не выбран');
  const r = await resolveInProject(project.path, rel);
  if (!r.ok) return fail('path', r.error);
  if (!r.exists || !r.isFile) return fail('missing', 'Файл не найден');
  const cur = await fileops.readTextFile(r.abs);
  if (cur.error) return fail('unreadable', cur.error);
  return {
    ok: true,
    projectId: project.id,
    path: r.rel,
    content: cur.text,
    hash: cur.hash,
    eol: cur.eol,
    hasBom: cur.hasBom,
    size: cur.buf.length,
  };
}

/**
 * Хэши нескольких файлов одним вызовом — для отметки «изменён на диске» в дереве (§13).
 * Отсутствующий или нечитаемый файл приходит как null, чтобы renderer не путал
 * «файл пропал» с «хэш неизвестен».
 */
async function hashesForEditor(project, rels) {
  const out = {};
  if (!project || !Array.isArray(rels)) return out;
  for (const rel of rels.slice(0, 200)) {
    if (typeof rel !== 'string' || !rel) continue;
    const r = await resolveInProject(project.path, rel);
    if (!r.ok || !r.exists || !r.isFile) { out[rel] = null; continue; }
    const cur = await fileops.readRawFile(r.abs);
    out[rel] = cur.error ? null : cur.hash;
  }
  return out;
}

/**
 * Запись файла из редактора (§9). Порядок шагов строго по ТЗ:
 * проверка пути → чтение текущего → сравнение хэша → при несовпадении НИЧЕГО не пишем →
 * проверка UTF-8 → backup → временный файл → атомарная замена → запись в историю.
 *
 * Проверка expectedHash делается дважды: здесь (чтобы вернуть содержательный ответ с
 * фактическим хэшем и текстом для диалога §11) и внутри applyChange непосредственно перед
 * заменой файла (чтобы окно между чтением и записью не позволило перезаписать чужую правку).
 *
 * @returns {Promise<{ok:true, path, hash, historyId}|{ok:false, code, error, actualHash?, diskContent?}>}
 */
async function writeFromEditor({ project, rel, content, expectedHash, store, chatId = null, source = 'manual', aiMeta = null }) {
  if (!project) return fail('no-project', 'Проект не выбран');
  if (typeof content !== 'string') return fail('bad-content', 'Содержимое должно быть строкой');
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    return fail('too-large', `Файл слишком большой для сохранения (> ${Math.round(MAX_WRITE_BYTES / 1048576)} МБ)`);
  }

  const r = await resolveInProject(project.path, rel);
  if (!r.ok) return fail('path', r.error);

  const cur = await fileops.readTextFile(r.abs);
  if (cur.error) {
    // Сюда попадает и не-UTF-8 (например CP1251): перезапись такого файла запрещена,
    // иначе содержимое было бы молча повреждено.
    if (!r.exists || !r.isFile) return fail('missing', 'Файл не найден');
    return fail('unreadable', cur.error);
  }

  const check = checkExpectedHash(expectedHash, cur.hash);
  if (!check.ok) {
    if (check.code === 'unknown') {
      return fail('unknown-base', 'Неизвестна версия, от которой редактировался файл. Перечитайте файл.', { actualHash: cur.hash });
    }
    // §11: файл изменён на диске — запись запрещена, возвращаем фактическое состояние,
    // чтобы диалог мог показать различия без повторного чтения.
    return fail('conflict', 'Файл изменён на диске. Ваши изменения НЕ записаны.', {
      actualHash: cur.hash,
      diskContent: cur.text,
      expectedHash: check.expected === ABSENT ? ABSENT : check.expected,
    });
  }

  const opId = crypto.randomUUID();
  const res = await fileops.applyChange({
    root: project.path,
    rel: r.rel,
    op: 'update',
    newText: content,
    expectedHash: cur.hash,
    backupDir: store.backupDir,
    opId,
  });
  if (!res.ok) {
    if (res.code === 'io') {
      await store.addHistory({
        id: opId, ts: Date.now(), chatId, projectId: project.id, projectName: project.name,
        relPath: r.rel, op: 'update', status: 'failed', error: res.error,
        source: source === 'ai' ? 'ai' : 'manual', ai: aiMeta || undefined,
      });
    }
    return res;
  }

  // §10: источник записи. По умолчанию это правка пользователя в редакторе; source='ai'
  // приходит, когда в сохранении участвовали принятые ханки предложения модели —
  // подробности (какие предложения, сколько ханков) лежат в aiMeta.
  await store.addHistory({
    id: opId, ts: Date.now(), chatId, projectId: project.id, projectName: project.name,
    relPath: r.rel, op: 'update', newRelPath: null,
    status: 'applied', beforeHash: res.beforeHash, afterHash: res.afterHash, error: null,
    source: source === 'ai' ? 'ai' : 'manual',
    ai: aiMeta || undefined,
  });
  await store.pruneFile(project.id, r.rel, MAX_BACKUPS_PER_FILE).catch((e) => console.error('[prune]', e));

  return { ok: true, path: r.rel, hash: res.afterHash, historyId: opId };
}

module.exports = { readForEditor, writeFromEditor, hashesForEditor, MAX_BACKUPS_PER_FILE };

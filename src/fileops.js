'use strict';
const fs = require('fs/promises');
const fsc = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveInProject } = require('./paths');

const MAX_READ_BYTES = 5 * 1024 * 1024;
const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.godot', '.import', '__pycache__', '.venv', 'venv',
  'Library', 'Temp', 'obj', '.mono', '.gradle',
  // артефакты компиляции этапа «Запуск» (ТЗ C3): бинарники и байт-код не должны
  // попадать ни в дерево файлов, ни в промпт-генератор
  '.ide_build',
]);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function decodeUtf8(buf) {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return { text: decoder.decode(buf), valid: true };
  } catch {
    return { text: null, valid: false };
  }
}

async function readRawFile(abs) {
  let st;
  try {
    st = await fs.stat(abs);
  } catch (e) {
    return { error: 'Не удалось прочитать файл: ' + e.message };
  }
  if (!st.isFile()) return { error: 'Это не файл' };
  if (st.size > MAX_READ_BYTES) return { error: 'Файл слишком большой (> 5 МБ)' };
  try {
    const buf = await fs.readFile(abs);
    return { buf, hash: sha256(buf) };
  } catch (e) {
    return { error: 'Не удалось прочитать файл: ' + e.message };
  }
}

async function readTextFile(abs) {
  let st;
  try {
    st = await fs.stat(abs);
  } catch (e) {
    return { error: 'Не удалось прочитать файл: ' + e.message };
  }
  if (!st.isFile()) return { error: 'Это не файл' };
  if (st.size > MAX_READ_BYTES) return { error: 'Файл слишком большой (> 5 МБ)' };
  const buf = await fs.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return { error: 'Бинарный файл' };
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const decoded = decodeUtf8(buf);
  if (!decoded.valid) return { error: 'Кодировка файла не UTF-8. Запись запрещена, чтобы не повредить содержимое (возможно, это CP1251).' };
  const text = decoded.text.replace(/^\uFEFF/, '');
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return { buf, text, hasBom, eol: crlf > lf ? 'crlf' : 'lf', hash: sha256(buf) };
}

// Приводим новый текст к стилю исходного файла (EOL, BOM)
function encodeLike(newText, cur) {
  let t = newText.replace(/\r\n?/g, '\n');
  if (cur && cur.eol === 'crlf') t = t.replace(/\n/g, '\r\n');
  return Buffer.from((cur && cur.hasBom ? '\uFEFF' : '') + t, 'utf8');
}

// Хэш текста в том виде, в каком он ляжет на диск.
// Нужен для editorHash (Stage 0, src/versions.js): Monaco хранит текст с '\n', а файл на диске
// может быть CRLF и/или с BOM. Без приведения к байтам диска каждый CRLF-файл выглядел бы
// «грязным» сразу после открытия. cur — результат readTextFile того же файла (или null для нового).
function hashTextLike(newText, cur) {
  return sha256(encodeLike(newText, cur));
}

async function listDir(rootAbs, rel) {
  let abs = path.resolve(rootAbs);
  if (rel) {
    const r = await resolveInProject(rootAbs, rel);
    if (!r.ok) return { error: r.error };
    abs = r.abs;
  }
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (e) {
    return { error: e.message };
  }
  const items = entries
    .filter((e) => !(e.isDirectory() && IGNORE_DIRS.has(e.name)))
    .slice(0, 3000)
    .map((e) => ({
      name: e.name,
      rel: rel ? rel + '/' + e.name : e.name,
      isDir: e.isDirectory(),
    }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { items };
}

// ---- Индекс файлов для нечёткого поиска пути ----
const indexCache = new Map();

async function getIndex(rootAbs) {
  const hit = indexCache.get(rootAbs);
  if (hit && Date.now() - hit.ts < 15000) return hit.files;
  const files = [];
  const queue = [{ abs: rootAbs, rel: '', depth: 0 }];
  while (queue.length && files.length < 30000) {
    const { abs, rel, depth } = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && depth < 12) queue.push({ abs: path.join(abs, e.name), rel: childRel, depth: depth + 1 });
      } else if (e.isFile()) files.push(childRel);
    }
  }
  indexCache.set(rootAbs, { ts: Date.now(), files });
  return files;
}

async function suggestPaths(rootAbs, wantedRel) {
  const files = await getIndex(rootAbs);
  const want = wantedRel.toLowerCase();
  const wantBase = want.split('/').pop();
  const exact = files.filter((f) => f.toLowerCase() === want);
  if (exact.length) return exact.slice(0, 5);
  const wantParts = want.split('/').reverse();
  return files
    .filter((f) => f.toLowerCase().split('/').pop() === wantBase)
    .map((f) => {
      const parts = f.toLowerCase().split('/').reverse();
      let score = 0;
      while (score < parts.length && score < wantParts.length && parts[score] === wantParts[score]) score++;
      return { f, score };
    })
    .sort((a, b) => b.score - a.score || a.f.length - b.f.length)
    .slice(0, 5)
    .map((x) => x.f);
}

// ---- Безопасная запись ----
async function writeAtomic(abs, buf, mode) {
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.${path.basename(abs)}.aiws-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, buf, { flag: 'wx' });
    if (mode != null) await fs.chmod(tmp, mode).catch(() => {});
    const check = await fs.readFile(tmp); // проверка успешности записи
    if (!check.equals(buf)) throw new Error('Проверка записи не пройдена: содержимое временного файла отличается');
    return tmp;
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

const err = (code, error) => ({ ok: false, code, error });

/**
 * Применение предложения. code при ошибке:
 * 'path' | 'conflict' | 'exists' | 'missing' | 'no-dir' | 'io'
 */
async function applyChange({ root, rel, op, newRel, newText, expectedHash, expectedNewHash, createDirs, backupDir, opId, trash }) {
  let r = await resolveInProject(root, rel);
  if (!r.ok) return err('path', r.error);

  try {
    if (op === 'create') {
      if (r.exists) return err('exists', 'Файл уже существует — перезапись новым файлом запрещена');
      if (!r.parentExists) {
        if (!createDirs) return err('no-dir', 'Папка назначения не существует');
        await fs.mkdir(path.dirname(r.abs), { recursive: true });
        r = await resolveInProject(root, rel);
        if (!r.ok) return err('path', r.error);
      }
      const buf = Buffer.from(newText.replace(/\r\n?/g, '\n'), 'utf8');
      const tmp = await writeAtomic(r.abs, buf);
      try {
        await fs.copyFile(tmp, r.abs, fsc.constants.COPYFILE_EXCL);
      } catch (e) {
        if (e.code === 'EEXIST') return err('exists', 'Файл появился на диске во время записи');
        throw e;
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
      await fs.writeFile(path.join(backupDir, opId + '.after'), buf).catch(() => {});
      return { ok: true, beforeHash: null, afterHash: sha256(buf) };
    }

    if (op === 'delete') {
      if (!r.exists || !r.isFile) return err('missing', 'Удаляемый файл не найден');
      const cur = await readRawFile(r.abs);
      if (cur.error) return err('io', cur.error);
      if (cur.hash !== expectedHash) return err('conflict', 'Файл изменился после формирования Diff');
      try {
        await fs.writeFile(path.join(backupDir, opId + '.before'), cur.buf);
        await fs.writeFile(path.join(backupDir, opId + '.after'), Buffer.alloc(0));
      } catch (e) {
        return err('io', 'Не удалось создать резервную копию: ' + e.message);
      }
      if (typeof trash !== 'function') return err('io', 'Операция удаления требует системной корзины');
      try {
        await trash(r.abs);
      } catch (e) {
        return err('io', 'Не удалось отправить файл в корзину: ' + e.message);
      }
      return { ok: true, beforeHash: cur.hash, afterHash: null };
    }

    if (op === 'move') {
      if (!newRel) return err('path', 'Не указан новый путь для перемещения');
      const dest = await resolveInProject(root, newRel);
      if (!dest.ok) return err('path', dest.error);
      if (!r.exists || !r.isFile) return err('missing', 'Перемещаемый файл не найден');
      if (dest.exists) return err('exists', 'Файл назначения уже существует — перезапись запрещена');
      const cur = await readRawFile(r.abs);
      if (cur.error) return err('io', cur.error);
      if (cur.hash !== expectedHash) return err('conflict', 'Исходный файл изменился после формирования Diff');
      if (expectedNewHash && expectedNewHash !== 'absent') return err('exists', 'Файл назначения уже изменён после формирования Diff');
      if (!dest.parentExists) {
        if (!createDirs) return err('no-dir', 'Папка назначения не существует');
        await fs.mkdir(path.dirname(dest.abs), { recursive: true });
      }
      try {
        await fs.writeFile(path.join(backupDir, opId + '.before'), cur.buf);
        await fs.writeFile(path.join(backupDir, opId + '.after'), cur.buf);
      } catch (e) {
        return err('io', 'Не удалось создать резервную копию: ' + e.message);
      }
      await fs.rename(r.abs, dest.abs);
      return { ok: true, beforeHash: cur.hash, afterHash: cur.hash, newRel: dest.rel };
    }

    // update
    if (!r.exists || !r.isFile) return err('missing', 'Целевой файл не найден');
    const cur = await readTextFile(r.abs);
    if (cur.error) return err('io', cur.error);
    if (cur.hash !== expectedHash) return err('conflict', 'Файл изменился после формирования Diff');

    try {
      await fs.writeFile(path.join(backupDir, opId + '.before'), cur.buf);
    } catch (e) {
      return err('io', 'Не удалось создать резервную копию: ' + e.message);
    }

    const buf = encodeLike(newText, cur);
    const st = await fs.stat(r.abs);
    const tmp = await writeAtomic(r.abs, buf, st.mode);
    try {
      const again = await readTextFile(r.abs);
      if (again.error || again.hash !== expectedHash) {
        await fs.unlink(tmp).catch(() => {});
        return err('conflict', 'Файл изменился во время записи');
      }
      await fs.rename(tmp, r.abs);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
    await fs.writeFile(path.join(backupDir, opId + '.after'), buf).catch(() => {});
    return { ok: true, beforeHash: cur.hash, afterHash: sha256(buf) };
  } catch (e) {
    return err('io', 'Ошибка записи: ' + e.message);
  }
}

/** Откат операции из истории. */
async function restore({ root, rel, op, newRel, backupDir, opId, afterHash, force }) {
  const r = await resolveInProject(root, rel);
  if (!r.ok) return err('path', r.error);
  try {
    if (op === 'create') {
      if (!r.exists) return { ok: true, note: 'Файл уже отсутствует' };
      const cur = await readTextFile(r.abs);
      if (!force && (cur.error || cur.hash !== afterHash)) return err('conflict', 'Файл изменён после применения');
      await fs.unlink(r.abs);
      return { ok: true };
    }
    if (op === 'delete') {
      if (r.exists) {
        const cur = await readTextFile(r.abs);
        if (!force && (!cur.error && cur.hash !== afterHash)) return err('conflict', 'На месте удаления уже появился другой файл');
        if (!force && cur.error) return err('conflict', 'На месте удаления появился файл, который нельзя проверить');
        return { ok: true, note: 'Файл уже восстановлен вручную' };
      }
      const before = await fs.readFile(path.join(backupDir, opId + '.before'));
      if (!r.parentExists) await fs.mkdir(path.dirname(r.abs), { recursive: true });
      await fs.writeFile(r.abs, before, { flag: 'wx' });
      return { ok: true };
    }
    if (op === 'move') {
      if (!newRel) return err('path', 'Не указан исходный путь для отката перемещения');
      const dest = await resolveInProject(root, newRel);
      if (!dest.ok) return err('path', dest.error);
      if (!dest.exists || !dest.isFile) return err('missing', 'Перемещённый файл не найден');
      const cur = await readRawFile(dest.abs);
      if (cur.error) return err('io', cur.error);
      if (!force && cur.hash !== afterHash) return err('conflict', 'Перемещённый файл изменён после применения');
      if (r.exists) return err('exists', 'Исходный путь уже занят — откат перемещения небезопасен');
      if (!r.parentExists) await fs.mkdir(path.dirname(r.abs), { recursive: true });
      await fs.rename(dest.abs, r.abs);
      return { ok: true };
    }
    if (!r.exists) return err('missing', 'Файл не найден');
    const cur = await readTextFile(r.abs);
    if (cur.error) return err('io', cur.error);
    if (!force && cur.hash !== afterHash) return err('conflict', 'Файл изменён после применения');
    const before = await fs.readFile(path.join(backupDir, opId + '.before'));
    const st = await fs.stat(r.abs);
    const tmp = await writeAtomic(r.abs, before, st.mode);
    try {
      await fs.rename(tmp, r.abs);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
    return { ok: true };
  } catch (e) {
    return err('io', 'Ошибка восстановления: ' + e.message);
  }
}

// ---- Полное дерево проекта (для генератора промптов) ----
const treeCache = new Map();
const TREE_LIMIT = 8000;

async function getTree(rootAbs) {
  const hit = treeCache.get(rootAbs);
  if (hit && Date.now() - hit.ts < 10000) return hit.value;
  let count = 0;
  let truncated = false;
  async function walk(abs, rel, depth) {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    const out = [];
    for (const e of entries) {
      if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
      if (!e.isDirectory() && !e.isFile()) continue;
      if (e.name.includes('.aiws-')) continue;
      if (count >= TREE_LIMIT) { truncated = true; break; }
      count++;
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        out.push({ name: e.name, rel: childRel, isDir: true, children: depth < 14 ? await walk(path.join(abs, e.name), childRel, depth + 1) : [] });
      } else out.push({ name: e.name, rel: childRel, isDir: false });
    }
    return out;
  }
  const nodes = await walk(path.resolve(rootAbs), '', 0);
  const value = { nodes, truncated };
  treeCache.set(rootAbs, { ts: Date.now(), value });
  return value;
}

const invalidateIndex = () => { indexCache.clear(); treeCache.clear(); };

module.exports = { readTextFile, readRawFile, listDir, suggestPaths, applyChange, restore, sha256, invalidateIndex, IGNORE_DIRS, getTree, encodeLike, hashTextLike };

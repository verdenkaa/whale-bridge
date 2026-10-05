'use strict';
const path = require('path');
const fs = require('fs/promises');

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function fail(error) {
  return { ok: false, error };
}

// Проверка и нормализация относительного пути из маркера (чистая функция).
function normalizeRel(input) {
  if (typeof input !== 'string') return fail('Путь должен быть строкой');
  const s = input.trim().replace(/\\/g, '/');
  if (!s) return fail('Пустой путь');
  if (s.length > 400) return fail('Слишком длинный путь');
  if (/[\u0000-\u001f<>:"|?*]/.test(s)) return fail('Недопустимые символы в пути');
  if (s.startsWith('/')) return fail('Абсолютные пути запрещены');
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length) return fail('Пустой путь');
  if (parts.includes('..')) return fail('Выход за пределы проекта через ".." запрещён');
  if (parts.some((p) => p.toLowerCase() === '.git')) return fail('Запись в .git запрещена');
  if (parts.some((p) => /[. ]$/.test(p))) return fail('Имя не может заканчиваться точкой или пробелом');
  if (parts.some((p) => WIN_RESERVED.test(p))) return fail('Зарезервированное имя файла');
  return { ok: true, rel: parts.join('/') };
}

function isInside(root, target) {
  const r = path.relative(root, target);
  if (r === '' || path.isAbsolute(r)) return false;
  return r !== '..' && !r.startsWith('..' + path.sep);
}

async function statOrNull(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/**
 * Полная проверка: нормализация, принадлежность проекту, защита от symlink-побегов.
 * @returns {Promise<{ok:true, abs, rel, exists, isFile, parentExists}|{ok:false,error}>}
 */
async function resolveInProject(rootAbs, relInput) {
  const n = normalizeRel(relInput);
  if (!n.ok) return n;
  const root = path.resolve(rootAbs);
  const abs = path.resolve(root, ...n.rel.split('/'));
  if (!isInside(root, abs)) return fail('Путь выходит за пределы проекта');

  let realRoot;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return fail('Корневая папка проекта недоступна');
  }

  // Ближайший существующий предок должен реально лежать внутри проекта
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== realRoot && !isInside(realRoot, real)) {
        return fail('Путь ведёт за пределы проекта (символическая ссылка)');
      }
      break;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return fail(e.message);
      const parent = path.dirname(probe);
      if (parent === probe) return fail('Путь недоступен');
      probe = parent;
    }
  }

  const st = await statOrNull(abs);
  const pst = await statOrNull(path.dirname(abs));
  return {
    ok: true,
    abs,
    rel: n.rel,
    exists: !!st,
    isFile: !!st && st.isFile(),
    parentExists: !!pst && pst.isDirectory(),
  };
}

module.exports = { normalizeRel, resolveInProject, isInside };

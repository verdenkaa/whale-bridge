'use strict';
// Поиск инструментов запуска (ТЗ C3 §3.2): автопоиск в PATH, проверка ручных путей,
// версии. CommonJS для main; fs/child_process разрешены, но внедрены через DI —
// тесты работают на временной папке и фейковом execFile, без реальных тулчейнов.
//
// Пакет «which» намеренно не берём: он CJS/ESM-непредсказуем по версиям, а функция
// поиска тривиальна и полностью покрыта тестами.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const runlangs = require('./runlangs');

const WIN_PATH_EXT = '.COM;.EXE;.BAT;.CMD';

/** Фабрика: все внешние зависимости инжектируются, значения по умолчанию — боевые. */
function createToolchain(deps) {
  const d = deps || {};
  const platform = d.platform || process.platform;
  const isWin = platform === 'win32';
  const isFile = d.isFile || ((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const exec = d.execFile || execFile;
  const pathSep = isWin ? ';' : ':';
  // Пути собираем разделителем целевой платформы, а не хоста: поведение win32-режима
  // одинаково на любой ОС (и проверяемо тестами из-под Linux/macOS).
  const join = isWin
    ? (a, b) => a + '\\' + b
    : (a, b) => path.join(a, b);

  /**
   * Аналог which: перебор PATH по кандидатам (порядок дескриптора сохраняется).
   * На Windows учитывается PATHEXT и поиск в текущей папке (как это делает cmd.exe),
   * регистр переменных окружения не важен. Возвращает все найденные совпадения —
   * порядок нужен, чтобы предпочесть python 3 системному python 2.
   */
  function findAllOnPath(names, env) {
    const e = env || {};
    const pathVar = isWin ? (e.PATH ?? e.Path ?? e.path) : e.PATH;
    const dirs = String(pathVar || '').split(pathSep).filter(Boolean);
    if (isWin) dirs.unshift('.'); // cmd.exe ищет и в текущей папке
    const exts = isWin
      ? String(e.PATHEXT || WIN_PATH_EXT).split(';').filter(Boolean)
      : [''];
    const hits = [];
    for (const name of names || []) {
      if (typeof name !== 'string' || !name) continue;
      for (const dir of dirs) {
        for (const ext of exts) {
          const full = dir === '.' ? name + ext : join(dir, name + ext);
          if (isFile(full)) hits.push({ name, exe: full });
        }
        // на Windows скрипт без расширения (наследие msys/git-окружений) тоже годится
        if (isWin && exts.length) {
          const bare = dir === '.' ? name : join(dir, name);
          if (isFile(bare)) hits.push({ name, exe: bare });
        }
      }
    }
    return hits;
  }

  /** Первый найденный кандидат или null. */
  function findOnPath(names, env) {
    const hits = findAllOnPath(names, env);
    return hits.length ? hits[0].exe : null;
  }

  /** Версия инструмента: «--version» с таймаутом 3 с (вывод бывает и в stderr). */
  function toolVersion(exe) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let child;
      try {
        child = exec(exe, ['--version'], { timeout: 3000, windowsHide: true }, (err, stdout, stderr) => {
          const out = [stdout, stderr].filter((x) => typeof x === 'string').join('\n');
          finish(runlangs.parseVersion(out));
        });
      } catch {
        finish(null);
        return;
      }
      if (child && typeof child.on === 'function') child.on('error', () => finish(null));
    });
  }

  /**
   * Для Python важен major: системный python 2.x встречается до сих пор, и «первый
   * в PATH» может оказаться именно им. Если среди кандидатов есть третья версия —
   * берём её, иначе честный первый.
   */
  async function pickPreferred(hits, preferMajor3) {
    if (!hits.length) return null;
    if (!preferMajor3) return { ...hits[0], version: await toolVersion(hits[0].exe) };
    let first = null;
    for (const hit of hits) {
      const v = await toolVersion(hit.exe);
      if (!first) first = { ...hit, version: v };
      if (v && v.major === 3) return { ...hit, version: v };
    }
    return first; // третьей версии нет — честный первый кандидат со своей версией
  }

  let cacheKey = null;
  let cache = null;

  /**
   * Обнаружение инструментов по всем языкам. Результат:
   *   { python: {found, exe, source:'manual'|'path'|null, version, brokenManual, candidates}, … }
   * Ручной путь из настроек побеждает автопоиск; битый ручной путь показывается честно
   * («указан, но не найден»), а запуск деградирует в автопоиск.
   */
  async function detect(cfg, env) {
    const conf = runlangs.sanitizeRunConfig(cfg);
    // Кеш живёт до изменения конфигурации инструментов: повторный запуск не гоняет
    // «--version» по каждому языку, а смена настроек подхватывается без ручного сброса.
    const key = JSON.stringify(conf.tools);
    if (cache && cacheKey === key) return cache;
    const e = env || process.env;
    const out = {};
    for (const lang of runlangs.LANGS) {
      for (const tool of lang.tools) {
        const manual = conf.tools[tool.key];
        const candidates = findAllOnPath(tool.names, e);
        let entry = null;
        let brokenManual = false;
        if (manual) {
          const manualExe = path.isAbsolute(manual) ? manual : path.resolve(manual);
          if (isFile(manualExe)) {
            // Ручной путь всегда побеждает автопоиск
            entry = {
              found: true, exe: manualExe, source: 'manual', brokenManual: false,
              version: await toolVersion(manualExe),
            };
          } else {
            // Битый ручной путь: запуск деградирует в автопоиск, но UI обязан
            // показать «указан, но не найден» честно
            brokenManual = true;
          }
        }
        if (!entry) {
          const preferred = await pickPreferred(candidates, tool.key === 'python');
          entry = preferred
            ? {
              found: true, exe: preferred.exe, source: 'path', brokenManual,
              version: preferred.version,
            }
            : { found: false, exe: null, source: null, brokenManual, version: null };
        }
        entry.candidates = candidates.map(({ name, exe }) => ({ name, exe }));
        out[tool.key] = entry;
      }
    }
    cache = out;
    cacheKey = key;
    return out;
  }

  /** Сброс кеша («Обновить» в настройках). */
  function clearCache() { cache = null; cacheKey = null; }

  return { findOnPath, findAllOnPath, toolVersion, detect, clearCache };
}

module.exports = { createToolchain, WIN_PATH_EXT };

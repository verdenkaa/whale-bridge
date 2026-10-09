'use strict';
// Модель представления раздела «Настройки → Запуск» (ТЗ C3 §2.4, патч 0018).
//
// UMD, чистые функции: renderer рисует таблицу языков ровно тем, что возвращает этот
// модуль, а main теми же правилами проверяет, что сохранено. Никакого DOM, fs и
// child_process — иначе «что значит «найден»» и «как подписать статус» оказалось бы
// в разметке, где это не покрыть тестами.
//
// Разделение ответственности:
//   src/toolchain.js  — факты: что найдено в PATH, какой путь указан, какая версия;
//   src/runsettings.js — представление фактов (строки таблицы, подписи, подсказки)
//                        и правило изменения config.run (nextConfig → sanitize);
//   ui/app.js         — только отрисовка строк и IPC.

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WhaleRunSettings = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  const RL = (typeof require === 'function')
    ? require('./runlangs')
    : (root && root.WhaleRunLangs);
  // Падаем сразу и внятно: молчаливый фолбэк означал бы вторую таблицу языков.
  if (!RL || !Array.isArray(RL.LANGS)) {
    throw new Error('WhaleRunLangs не загружен: src/runlangs.js должен подключаться до src/runsettings.js');
  }

  const { LANGS, TOOL_KEYS, ARGS_KEYS, sanitizeRunConfig } = RL;

  /** Верхняя граница таймаута бездействия — та же, что в sanitizeRunConfig. */
  const TIMEOUT_MAX = 86400;

  /** Подсказки к полю дополнительных аргументов (данные, а не код). */
  const ARG_HINTS = Object.freeze({
    python: 'например: -X utf8',
    cpp: 'например: -Wall -O2 -std=c++17',
    c: 'например: -Wall -O2 -std=c11',
    java: 'аргументы javac, например: -Xlint:all',
    csharp: 'аргументы программы, например: --fast',
  });

  /**
   * Оболочка для команд модели (&CMD:) не настраивается — решение пользователя
   * (ТЗ §5.3, Q4: PowerShell не внедряем). Строка справочная: пользователь обязан
   * понимать, в какой оболочке выполняется команда из чата.
   */
  const SHELL_NOTE = 'Команды модели (&CMD:) выполняются через cmd.exe /d /s /c в корне проекта '
    + '(на Linux/macOS — /bin/sh -c). Оболочка не настраивается: PowerShell не используется.';

  /** Дескриптор инструмента по его ключу (python, node, cpp, c, javac, java). */
  function toolByKey(key) {
    for (const lang of LANGS) {
      for (const t of lang.tools) if (t.key === key) return { lang, tool: t };
    }
    return null;
  }

  /** Язык по ключу инструмента — для подписи и подсказки «что установить». */
  function langOfTool(key) {
    const hit = toolByKey(key);
    return hit ? hit.lang : null;
  }

  /**
   * Статус обнаружения инструмента. Виды:
   *   ok      — найден в PATH (автопоиск);
   *   manual  — взят из настроек: ручной путь существует;
   *   broken  — ручной путь указан, но не найден (запуск с ним невозможен, §9);
   *   none    — не найден нигде;
   *   unknown — обнаружение ещё не выполнялось.
   * Текст содержит символ статуса (✔/⚠/✘) — как в ТЗ §2.4, чтобы строка читалась
   * и без цвета (цветовая семантика дублируется классом kind).
   */
  function statusOf(entry) {
    const e = entry && typeof entry === 'object' ? entry : null;
    if (!e) return { kind: 'unknown', text: 'не проверялось', exe: null, version: null, source: null, brokenManual: false };
    const ver = e.version && typeof e.version.text === 'string' ? e.version.text : null;
    const withVer = (s) => (ver ? s + ' · ' + ver : s);
    if (e.found && e.source === 'manual') {
      return { kind: 'manual', text: withVer('✔ из настроек: ' + (e.exe || '')), exe: e.exe || null, version: ver, source: 'manual', brokenManual: false };
    }
    if (e.found && e.brokenManual) {
      // Путь из настроек битый, но в PATH что-то есть: показываем честно оба факта.
      // Запуск с битым ручным путём запрещён (см. src/runner.js), поэтому «используется
      // найденный в PATH» писать нельзя — это было бы обещанием, которого нет.
      return {
        kind: 'broken',
        text: '⚠ указанный путь не найден; в PATH есть ' + withVer(String(e.exe || '')),
        exe: e.exe || null, version: ver, source: 'path', brokenManual: true,
      };
    }
    if (e.found) {
      return { kind: 'ok', text: withVer('✔ ' + (e.exe || '')), exe: e.exe || null, version: ver, source: 'path', brokenManual: false };
    }
    return {
      kind: e.brokenManual ? 'broken' : 'none',
      text: e.brokenManual ? '⚠ указан, но не найден' : '✘ не найден в PATH',
      exe: null, version: null, source: null, brokenManual: !!e.brokenManual,
    };
  }

  /**
   * Строки таблицы инструментов: по одной на инструмент, а не на язык — у Java их два
   * (javac и java), и пути к ним бывают разными (JDK и JRE в разных папках).
   *
   * @param {object} cfg config.run (или что прислал settings:get)
   * @param {object} tools результат toolchain.detect (может быть null — ещё не проверяли)
   * @returns {Array<{langId, langLabel, firstOfLang, langToolCount, toolKey, toolLabel,
   *                  candidates, install, manual, status}>}
   */
  function toolRows(cfg, tools) {
    const conf = sanitizeRunConfig(cfg);
    const t = tools && typeof tools === 'object' ? tools : {};
    const rows = [];
    for (const lang of LANGS) {
      lang.tools.forEach((tool, i) => {
        rows.push({
          langId: lang.id,
          langLabel: lang.label,
          firstOfLang: i === 0,
          langToolCount: lang.tools.length,
          toolKey: tool.key,
          toolLabel: tool.label || tool.names.join(' / '),
          candidates: tool.names.slice(),
          install: tool.install || lang.label,
          manual: conf.tools[tool.key],
          status: statusOf(t[tool.key]),
        });
      });
    }
    return rows;
  }

  /**
   * Строки дополнительных аргументов. Только языки из ARGS_KEYS: у Node аргументов нет
   * (план фиксирован), аргументы Java идут в javac, а аргументы C# — в запуск программы
   * (dotnet <сборка>.dll <аргументы>) — это честно подписано подсказками.
   * @returns {Array<{key, label, hint, value}>}
   */
  function argRows(cfg) {
    const conf = sanitizeRunConfig(cfg);
    return ARGS_KEYS.map((key) => {
      // Ключ аргументов не всегда равен ключу инструмента: у Java их два (javac/java),
      // у C# инструмент называется dotnet
      const toolKey = key === 'java' ? 'javac' : key === 'csharp' ? 'dotnet' : key;
      const hit = toolByKey(toolKey);
      const lang = hit && hit.lang ? hit.lang : null;
      return {
        key,
        label: lang ? lang.label : key,
        hint: ARG_HINTS[key] || '',
        value: conf.args[key] || '',
      };
    });
  }

  /**
   * Разбор значения поля «Таймаут бездействия (сек)»: целое 0…TIMEOUT_MAX, 0 = выключен.
   * null — значение недопустимо (поле подсвечивается, конфиг не сохраняется).
   */
  function parseTimeoutInput(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (!s || !/^\d+$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(n, TIMEOUT_MAX);
  }

  /**
   * Новый config.run после правки одного поля. Всегда проходит sanitizeRunConfig на
   * выходе: то, что вернёт эта функция, можно сохранять в config.json как есть, и main
   * получит ровно тот же результат (правило одно на два процесса).
   *
   * @param {object} cfg текущий config.run
   * @param {{tool?:{key,value}, args?:{key,value}, timeoutSec?:number|string}} patch
   */
  function nextConfig(cfg, patch) {
    const conf = sanitizeRunConfig(cfg);
    const p = patch && typeof patch === 'object' ? patch : {};
    if (p.tool && typeof p.tool === 'object') {
      const key = String(p.tool.key || '');
      if (TOOL_KEYS.includes(key)) {
        const v = p.tool.value;
        conf.tools[key] = typeof v === 'string' && v.trim() ? v.trim() : null; // '' / null = «Авто»
      }
    }
    if (p.args && typeof p.args === 'object') {
      const key = String(p.args.key || '');
      if (ARGS_KEYS.includes(key)) conf.args[key] = typeof p.args.value === 'string' ? p.args.value : '';
    }
    if (p.timeoutSec !== undefined) {
      const n = parseTimeoutInput(p.timeoutSec);
      // Недопустимое значение молча не сохраняем: поле останется как есть, а UI подсветит
      if (n !== null) conf.timeoutSec = n;
    }
    return sanitizeRunConfig(conf);
  }

  /**
   * Подпись инструмента для сообщения «не найден» (его же печатает раннер в терминал):
   * «Не найден g++ в PATH. Установите MinGW-w64 (g++) или LLVM (clang++) и добавьте его
   * в PATH, либо укажите путь к исполняемому файлу в Настройках → Запуск.»
   */
  function missingToolMessage(toolKey, manualPath) {
    const hit = toolByKey(toolKey);
    const name = hit ? hit.tool.names[0] : String(toolKey || 'инструмент');
    const install = hit && hit.tool.install ? hit.tool.install : 'нужный инструмент';
    const manual = typeof manualPath === 'string' && manualPath.trim()
      ? ` Указанный в настройках путь не найден: ${manualPath.trim()}.`
      : '';
    return `Не найден ${name} в PATH. Установите ${install}, либо укажите путь к исполняемому файлу в Настройках → Запуск.${manual}`;
  }

  return {
    TIMEOUT_MAX, ARG_HINTS, SHELL_NOTE,
    toolByKey, langOfTool, statusOf, toolRows, argRows, parseTimeoutInput, nextConfig, missingToolMessage,
  };
});

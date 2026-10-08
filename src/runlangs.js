'use strict';
// Ядро этапа «Запуск» (ТЗ C3 §3.1): языки, планы запуска, разбор аргументов и
// классификатор опасных команд.
//
// Чистые функции и данные: ни fs, ни child_process, ни DOM, ни Electron. Правила одни
// на два процесса (UMD-обёртка, как у src/versions.js и ui/layout.js):
//   main     — planRun/resolveexe при старте сессии (src/runner.js);
//   renderer — LANGS/classifyCommand для карточек предложений и таблицы настроек.
//
// Языки — данные, а не код: добавить язык = добавить один объект-дескриптор в LANGS.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WhaleRunLangs = api;
})(typeof window !== 'undefined' ? window : null, function () {
  /** Папка артефактов сборки внутри проекта. Входит в fileops.IGNORE_DIRS. */
  const BUILD_DIR = '.ide_build';

  /**
   * Префикс командной строки cmd.exe: перевести консоль в UTF-8 до выполнения команды.
   * Файлы проекта Whale Bridge пишет в UTF-8, а консоль cmd.exe по умолчанию в OEM
   * (CP866) — без префикса type/findstr выводили кириллицу кракозябрами. «>nul» прячет
   * ответ chcp («Active code page: 65001»), чтобы он не смешивался с выводом команды.
   */
  const UTF8_CONSOLE_PREFIX = 'chcp 65001>nul & ';

  /**
   * Таблица языков. Поля:
   *   id, label — идентификатор и подпись для UI;
   *   exts      — расширения файлов (с точкой, нижний регистр);
   *   tools     — инструменты-кандидаты для автопоиска в PATH; у каждого свои
   *               кандидаты (names) и свой ключ ручного пути в config.run.tools (key).
   *               extraArgs — постоянные аргументы запуска (например, «-3» у py);
   *   plan(...) — чистая функция: возвращает шаги {kind, tool?, exe?, args}.
   *               tool — ключ инструмента (шаг исполняется найденным exe),
   *               exe  — литеральный исполняемый файл (шаг не зависит от автопоиска).
   *
   * Аргументы из настроек (config.run.args) вставляются по месту, определённому
   * для каждого языка: у компиляторов — перед «-o»/«-d», у интерпретаторов — в конце.
   */
  const LANGS = Object.freeze([
    Object.freeze({
      id: 'python', label: 'Python',
      exts: Object.freeze(['.py']),
      // label и install — данные для раздела «Настройки → Запуск» (src/runsettings.js):
      // подпись инструмента в таблице и подсказка, что установить, если его нет в PATH.
      tools: Object.freeze([Object.freeze({
        key: 'python', names: Object.freeze(['python', 'python3', 'py']),
        label: 'Python', install: 'Python 3 и добавьте его в PATH (или укажите путь к python.exe вручную)',
      })]),
      plan: ({ rel, args, exeSuffix }) => ({
        steps: [{ kind: 'run', tool: 'python', exeSuffix, args: ['-u', rel, ...args] }],
        // PYTHONIOENCODING — страховка от cp1251/cp866 в stdout на Windows,
        // PYTHONPATH — чтобы «import соседа» работал из корня проекта.
        env: { PYTHONPATH: '{root}', PYTHONIOENCODING: 'utf-8' },
      }),
    }),
    Object.freeze({
      id: 'node', label: 'JavaScript / TypeScript',
      exts: Object.freeze(['.js', '.mjs', '.cjs', '.ts', '.mts']),
      tools: Object.freeze([Object.freeze({
        key: 'node', names: Object.freeze(['node']),
        label: 'Node.js', install: 'Node.js 22 или новее (для запуска .ts — обязательно)',
      })]),
      // Node для JS берётся из PATH пользователя, а не встроенный в Electron:
      // запуск должен вести себя как в обычной консоли.
      plan: ({ rel, ext }) => ({
        steps: [{
          kind: 'run', tool: 'node',
          // Node 22 исполняет TS только с флагом, Node 23+ — нативно (ТЗ §4)
          args: (ext === '.ts' || ext === '.mts' ? ['--experimental-strip-types'] : []).concat(rel),
        }],
        env: null,
      }),
    }),
    Object.freeze({
      id: 'cpp', label: 'C++',
      exts: Object.freeze(['.cpp', '.cc', '.cxx']),
      tools: Object.freeze([Object.freeze({
        key: 'cpp', names: Object.freeze(['g++', 'clang++']),
        label: 'g++ / clang++', install: 'MinGW-w64 (g++) или LLVM (clang++) и добавьте его в PATH',
      })]),
      // Имя бинарника = имя исходника: два разных файла не перетирают друг друга.
      plan: ({ rel, base, args, exeSuffix }) => ({
        steps: [
          { kind: 'build', tool: 'cpp', args: [...args, rel, '-o', BUILD_DIR + '/' + base + exeSuffix] },
          { kind: 'run', exe: BUILD_DIR + '/' + base + exeSuffix, args: [] },
        ],
        env: null,
      }),
    }),
    Object.freeze({
      id: 'c', label: 'C',
      exts: Object.freeze(['.c']),
      tools: Object.freeze([Object.freeze({
        key: 'c', names: Object.freeze(['gcc', 'clang']),
        label: 'gcc / clang', install: 'MinGW-w64 (gcc) или LLVM (clang) и добавьте его в PATH',
      })]),
      plan: ({ rel, base, args, exeSuffix }) => ({
        steps: [
          { kind: 'build', tool: 'c', args: [...args, rel, '-o', BUILD_DIR + '/' + base + exeSuffix] },
          { kind: 'run', exe: BUILD_DIR + '/' + base + exeSuffix, args: [] },
        ],
        env: null,
      }),
    }),
    Object.freeze({
      id: 'java', label: 'Java',
      exts: Object.freeze(['.java']),
      tools: Object.freeze([
        Object.freeze({
          key: 'javac', names: Object.freeze(['javac']),
          label: 'javac', install: 'JDK 17 или новее (JRE не содержит javac)',
        }),
        Object.freeze({
          key: 'java', names: Object.freeze(['java']),
          label: 'java', install: 'JDK 17 или новее (JRE не содержит javac)',
        }),
      ]),
      // Байт-код уходит в .ide_build/classes и не мусорит рядом с исходниками;
      // класс запускается по полному имени (package + имя файла) с явным -cp.
      plan: ({ rel, args, fqcn }) => ({
        steps: [
          { kind: 'build', tool: 'javac', args: ['-encoding', 'UTF-8', ...args, '-d', BUILD_DIR + '/classes', rel] },
          { kind: 'run', tool: 'java', args: ['-cp', BUILD_DIR + '/classes', fqcn] },
        ],
        env: null,
      }),
    }),
  ]);

  const TOOL_KEYS = Object.freeze(['python', 'node', 'cpp', 'c', 'javac', 'java']);
  const ARGS_KEYS = Object.freeze(['python', 'cpp', 'c', 'java']);
  /** Оболочка Windows для &CMD: — только cmd.exe (решение пользователя, PowerShell не внедряем). */
  const SHELLS_WIN = Object.freeze(['cmd']);

  const langById = (id) => LANGS.find((l) => l.id === id) || null;

  /** Определение языка по расширению (с точкой или без, регистр не важен). */
  function langByExt(ext) {
    if (typeof ext !== 'string' || !ext) return null;
    const e = (ext.startsWith('.') ? ext : '.' + ext).toLowerCase();
    return LANGS.find((l) => l.exts.includes(e)) || null;
  }

  /**
   * Разбор аргументов командной строки с учётом двойных кавычек. Общий для маркера
   * &RUN: и дополнительных аргументов из настроек. Одинарные кавычки НЕ особенные —
   * в cmd.exe они обычные символы, и настройка рассчитана прежде всего на Windows.
   */
  function tokenizeArgs(str) {
    const out = [];
    if (typeof str !== 'string') return out;
    let cur = '';
    let inQ = false;
    let has = false; // в токен попало хоть что-то (включая пустую строку в кавычках)
    for (const ch of str) {
      if (ch === '"') { inQ = !inQ; has = true; continue; }
      if (!inQ && /\s/.test(ch)) {
        if (has || cur) out.push(cur);
        cur = ''; has = false;
        continue;
      }
      cur += ch; has = true;
    }
    if (has || cur) out.push(cur);
    return out;
  }

  /**
   * Полное имя Java-класса: «package x.y;» из исходника + имя файла. Без package —
   * просто имя файла. Разбираем только первую строку package: этого достаточно для
   * учебного кода, а полноценный парсер Java в задачи этапа не входит.
   */
  function javaClassFqn(sourceText, baseName) {
    const base = String(baseName || 'Main');
    const m = typeof sourceText === 'string'
      ? sourceText.match(/^[ \t]*package[ \t]+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]*;/m)
      : null;
    return m ? m[1] + '.' + base : base;
  }

  /** Первая версия x.y[.z] из вывода «--version» (python, gcc, node…). */
  function parseVersion(out) {
    if (typeof out !== 'string') return null;
    for (const line of out.split('\n')) {
      const m = line.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
      if (m) return { major: +m[1], minor: +m[2], patch: m[3] === undefined ? null : +m[3], text: m[0] };
    }
    return null;
  }

  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);

  /**
   * Приведение config.run из config.json к допустимому виду (по образцу
   * layoutMath.sanitize): чужой или битый конфиг не должен ронять приложение.
   * Любое неизвестное значение shellWin сводится к 'cmd'.
   */
  function sanitizeRunConfig(raw) {
    const src = isObj(raw) ? raw : {};
    const toolsSrc = isObj(src.tools) ? src.tools : {};
    const argsSrc = isObj(src.args) ? src.args : {};
    const tools = {};
    for (const k of TOOL_KEYS) {
      const v = toolsSrc[k];
      tools[k] = typeof v === 'string' && v.trim() && v.length <= 1000 ? v.trim() : null;
    }
    const args = {};
    for (const k of ARGS_KEYS) {
      const v = argsSrc[k];
      args[k] = typeof v === 'string' ? v.slice(0, 500) : '';
    }
    const t = Math.round(num(src.timeoutSec, 600));
    return {
      tools,
      args,
      timeoutSec: t >= 0 && t <= 86400 ? t : 600,
      shellWin: SHELLS_WIN.includes(src.shellWin) ? src.shellWin : 'cmd',
    };
  }

  /** Дефолт config.run — тот же sanitize от пустого объекта. */
  const defaultRunConfig = () => sanitizeRunConfig(null);

  /**
   * План запуска файла. Чистая функция: ничего не проверяет на диске и не ищет
   * инструменты — только собирает шаги. cwd всегда корень проекта, поэтому {rel} —
   * путь относительно корня, и команды в терминале короткие и читаемые.
   *
   * @param {string} langId идентификатор языка (LANGS)
   * @param {string} rel путь файла относительно корня проекта
   * @param {{platform?:string, args?:string[], fqcn?:string, nodeMajor?:number|null}} opts
   * @returns {{ok:true, steps:Array, env:object|null, outDir:string|null}|{ok:false, error:string}}
   */
  function planRun(langId, rel, opts) {
    const lang = langById(langId);
    if (!lang) return { ok: false, error: 'Язык не поддерживается' };
    if (typeof rel !== 'string' || !rel.trim()) return { ok: false, error: 'Не указан файл' };
    const o = isObj(opts) ? opts : {};
    const platform = o.platform === 'win32' ? 'win32' : 'posix';
    const dot = rel.lastIndexOf('.');
    const ext = dot > 0 ? rel.slice(dot).toLowerCase() : '';
    const base = (dot > 0 ? rel.slice(0, dot) : rel).split(/[\\/]/).pop();
    const nodeMajor = Number.isInteger(o.nodeMajor) ? o.nodeMajor : null;
    const ctx = {
      rel,
      base,
      ext,
      args: Array.isArray(o.args) ? o.args.filter((x) => typeof x === 'string') : [],
      exeSuffix: platform === 'win32' ? '.exe' : '',
      platform,
      fqcn: typeof o.fqcn === 'string' && o.fqcn ? o.fqcn : base,
      nodeMajor,
    };
    const p = lang.plan(ctx);
    let steps = (p.steps || []).map((s) => ({
      kind: s.kind === 'build' ? 'build' : 'run',
      tool: s.tool || null,
      exe: s.exe || null,
      // Флаг strip-types только для Node 22.x: на более старом Node он не нужен
      // (TS не исполняется вовсе, ошибка будет понятной), на 23+ — неизвестен и мешает.
      args: (s.args || []).filter((a) => !(a === '--experimental-strip-types' && nodeMajor !== null && nodeMajor !== 22)),
    }));
    // TS без подходящего Node честно не запускаем — иначе «node app.ts» упадёт
    // с загадочным SyntaxError, а должен — с понятным сообщением.
    if (lang.id === 'node' && (ctx.ext === '.ts' || ctx.ext === '.mts')) {
      if (nodeMajor === null) steps = [];
      else if (nodeMajor < 22) steps = [];
    }
    if (!steps.length) {
      return {
        ok: false,
        error: lang.id === 'node'
          ? 'Для запуска TypeScript нужен Node.js 22 или новее — не удалось определить версию node'
          : 'Пустой план запуска',
      };
    }
    const needsOutDir = steps.some((s) => s.kind === 'build');
    return {
      ok: true,
      steps,
      env: p.env || null,
      outDir: needsOutDir ? BUILD_DIR + (lang.id === 'java' ? '/classes' : '') : null,
    };
  }

  /**
   * Оболочка для &CMD: (ТЗ §5.3). Windows — всегда cmd.exe (/d отключает autorun-скрипты
   * пользователя), остальные платформы — /bin/sh. Команда передаётся одним элементом и
   * нигде не интерполируется: инъекции исключены.
   *
   * Два обстоятельства Windows, из-за которых команда доезжала до cmd.exe не той:
   *
   * 1. verbatim. node-pty собирает командную строку из массива аргументов по правилам
   *    MSVCRT (кавычка внутри аргумента превращается в «\"»), а cmd.exe такое экранирование
   *    не понимает: «findstr "fn main" poem.rs» доезжал как «findstr fn main poem.rs» —
   *    findstr принимал «fn» за шаблон, а «main» за имя файла и падал с «не удаётся открыть
   *    main». Если же args — СТРОКА, node-pty кладёт её в командную строку дословно
   *    (argsToCommandLine → isCommandLine), поэтому оболочке команда отдаётся строкой.
   * 2. utf8. Консоль cmd.exe по умолчанию в OEM-кодировке (в России CP866), а файлы
   *    проекта Whale Bridge пишет в UTF-8: type/findstr выводили кириллицу кракозябрами.
   *    Префикс «chcp 65001>nul &» выполняется в той же консоли и переводит её в UTF-8
   *    до команды. Это не порча файла, а несовпадение кодировок консоли и файла.
   *
   * @param {string} command командная строка как есть
   * @param {string} platform 'win32' | иное
   * @param {{utf8?:boolean}} opts utf8=false отключает префикс chcp (консоль OEM)
   */
  function planShell(command, platform, opts) {
    const cmd = typeof command === 'string' ? command : '';
    const o = isObj(opts) ? opts : {};
    // Чистая функция не знает process.env: ComSpec подставляет вызывающий (main),
    // а 'cmd.exe' — корректный запасной вариант (находится через PATH).
    if (platform !== 'win32') return { exe: '/bin/sh', args: ['-c', cmd], verbatim: false };
    const utf8 = o.utf8 !== false;
    const line = utf8 && cmd ? UTF8_CONSOLE_PREFIX + cmd : cmd;
    return { exe: 'cmd.exe', args: ['/d', '/s', '/c', line], verbatim: true };
  }

  /**
   * Аргументы для node-pty.spawn. На Windows команда оболочки передаётся одной строкой
   * (см. planShell, verbatim): массив node-pty экранировал бы по правилам MSVCRT и
   * cmd.exe потерял бы кавычки. На POSIX argv остаётся массивом — там аргументы
   * передаются execvp поштучно и экранирование не нужно в принципе.
   *
   * @param {string[]} args аргументы из плана
   * @param {string} platform 'win32' | иное
   * @param {boolean} verbatim передавать ли командную строку дословно
   * @returns {string[]|string}
   */
  function ptySpawnArgs(args, platform, verbatim) {
    const list = Array.isArray(args) ? args.slice() : [];
    if (platform === 'win32' && verbatim) return list.join(' ');
    return list;
  }

  // ---------- классификатор опасных команд (ТЗ §6) ----------
  //
  // Списки — данные: расширить = дописать строку. Уровень команды = максимум уровней
  // её сегментов (разбивка по && || | ; & и переводам строк, с учётом кавычек).

  /** Первые слова сегмента, которые означают безусловную опасность. */
  const DANGER_CMDS = [
    // удаление
    'rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'shred', 'remove-item',
    // форматирование и система
    'format', 'mkfs', 'mkfs.ext2', 'mkfs.ext3', 'mkfs.ext4', 'mkfs.xfs', 'mkfs.btrfs',
    'mkfs.fat', 'mkfs.ntfs', 'mkfs.vfat',
    'fdisk', 'diskpart', 'shutdown', 'reboot', 'halt',
    'schtasks', 'crontab', 'set-executionpolicy', 'takeown', 'icacls',
    // обёртки и обфускация
    'mshta', 'rundll32', 'wscript', 'cscript', 'eval', 'invoke-expression', 'iex',
  ];
  /** Флаги-токены, которые делают опасным любой сегмент. */
  const DANGER_FLAGS = ['--force', '-rf', '-fr', '--no-preserve-root', '--hard'];
  /** Подкоманды git, уничтожающие историю или данные. */
  const GIT_DANGER = new Set(['clean', 'reset', 'push', 'restore', 'rebase', 'filter-branch']);
  /** Подкоманды git, меняющие состояние, но обратимые. */
  const GIT_CAUTION = new Set(['commit', 'merge', 'stash', 'checkout', 'branch']);

  const CAUTION_CMDS = new Set([
    // установка и пакеты
    'npx', 'yarn', 'pnpm', 'apt', 'apt-get', 'dnf', 'yum',
    'pacman', 'brew', 'choco', 'winget', 'scoop',
    // сеть и скачивание
    'curl', 'wget', 'invoke-webrequest', 'iwr', 'irm', 'invoke-restmethod',
    'scp', 'sftp', 'ftp', 'nc', 'ncat', 'ssh', 'telnet',
    // процессы и права
    'taskkill', 'kill', 'killall', 'pkill', 'chmod', 'chown', 'start',
  ]);
  /**
   * pip/npm сами по себе безопасны (list, --help, audit), поэтому в общий список
   * caution не входят — «осторожно» дают только изменяющие подкоманды.
   */
  const PACKAGE_SUBS = new Set(['install', 'uninstall', 'update', 'upgrade', 'remove', 'i', 'ci', 'add', 'rm']);

  const LEVELS = { safe: 0, caution: 1, danger: 2 };

  /** Имя программы из первого токена: без пути (обе косые) и без исполняемого расширения. */
  function baseNameOf(token) {
    let s = String(token || '').split(/[\\/]/).pop();
    s = s.replace(/\.(exe|cmd|bat|com|ps1|sh)$/i, '');
    return s.toLowerCase();
  }

  /**
   * Разбивка командной строки на сегменты по разделителям командного процессора.
   * Внутри двойных кавычек разделители не действуют («findstr "a && b" f» — одна
   * команда). Одинарные кавычки в cmd.exe не особенные, поэтому не учитываются.
   */
  function splitSegments(cmdline) {
    const out = [];
    let cur = '';
    let inQ = false;
    const s = String(cmdline || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') { inQ = !inQ; cur += ch; continue; }
      if (!inQ && (ch === '\n' || ch === '\r' || ch === ';' || ch === '|' || ch === '&')) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  /** Токены сегмента с сохранением кавычек (кавычка — часть токена, как в cmd.exe). */
  function segmentTokens(seg) {
    return String(seg).split(/\s+/).filter(Boolean);
  }

  /** Классификация одного сегмента. Возвращает {level, reasons}. */
  function classifySegment(seg) {
    const tokens = segmentTokens(seg);
    if (!tokens.length) return { level: 'safe', reasons: [] };
    const reasons = [];
    let level = 'safe';
    const bump = (to, reason) => {
      if (LEVELS[to] > LEVELS[level]) level = to;
      reasons.push(reason);
    };
    const name = baseNameOf(tokens[0]);
    const sub = tokens[1] ? tokens[1].toLowerCase() : '';
    const rest = tokens.slice(1).map((t) => t.toLowerCase());

    if (DANGER_CMDS.includes(name)) bump('danger', `удаление или системная команда: ${name}`);

    if (name === 'git') {
      // «git checkout --» — явный откат рабочих правок (потеря данных). Просто
      // «git checkout main» остаётся в «осторожно»: отличить ветку от пути без git
      // нельзя, а confirm на каждое переключение ветки невыносим.
      const checkoutRestore = sub === 'checkout' && rest.includes('--');
      const branchDelete = sub === 'branch' && rest.some((t) => /^-[a-z]*d/i.test(t));
      if (branchDelete) {
        bump('danger', 'git branch -d — удаление ветки');
      } else if (sub === 'push' || sub === 'clean' || sub === 'rebase' || sub === 'filter-branch') {
        bump('danger', `git ${sub} — необратимая операция`);
      } else if (sub === 'reset' || sub === 'restore' || checkoutRestore) {
        bump('danger', `git ${sub} — потеря изменений`);
      } else if (sub === 'stash' && rest.includes('drop')) {
        bump('danger', 'git stash drop — потеря отложенных изменений');
      } else if (sub === 'tag' && rest.some((t) => /^-[a-z]*d/i.test(t))) {
        bump('caution', 'git tag -d — удаление метки');
      } else if (GIT_CAUTION.has(sub) && !(sub === 'branch' && !rest.some((t) => t.startsWith('-')))) {
        // «git branch» без аргументов и с новым именем ничего не теряет — чтение/создание
        bump('caution', `git ${sub}`);
      }
    }

    if (name === 'reg' && (sub === 'add' || sub === 'delete')) bump('danger', `reg ${sub} — правка реестра`);
    if (name === 'sc' && sub === 'create') bump('danger', 'sc create — установка службы');
    if (name === 'net' && sub === 'user') bump('danger', 'net user — правка учётных записей');
    // закодированная команда — признак обфускации (powershell -enc, -encodedcommand)
    if (rest.some((t) => /^-enc(odedcommand)?$/i.test(t))) bump('danger', 'закодированная команда (-enc)');
    // установка пакетов — «осторожно», но pip/npm без изменяющей подкоманды безопасны
    if ((name === 'pip' || name === 'pip3' || name === 'npm') && PACKAGE_SUBS.has(sub)) {
      bump('caution', `${name} ${sub} — установка пакетов`);
    } else if (CAUTION_CMDS.has(name)) bump('caution', `установка, сеть или управление процессами: ${name}`);

    for (const t of tokens) {
      const low = t.toLowerCase();
      if (DANGER_FLAGS.includes(low)) bump('danger', `опасный флаг ${low}`);
    }
    return { level, reasons };
  }

  /**
   * Классификация командной строки целиком: максимум по сегментам, причины
   * перечислены без повторов. Пустая команда — safe (делать нечего).
   */
  function classifyCommand(cmdline, platform) {
    const segments = splitSegments(cmdline).slice(0, 100);
    let level = 'safe';
    const reasons = [];
    const seen = new Set();
    for (const seg of segments) {
      const r = classifySegment(seg);
      if (LEVELS[r.level] > LEVELS[level]) level = r.level;
      for (const reason of r.reasons) {
        if (!seen.has(reason)) { seen.add(reason); reasons.push(reason); }
      }
    }
    return { level, reasons };
  }

  return {
    BUILD_DIR, LANGS, TOOL_KEYS, ARGS_KEYS, SHELLS_WIN, UTF8_CONSOLE_PREFIX,
    DANGER_CMDS, DANGER_FLAGS, CAUTION_CMDS,
    langById, langByExt, tokenizeArgs, javaClassFqn, parseVersion,
    sanitizeRunConfig, defaultRunConfig, planRun, planShell, ptySpawnArgs, classifyCommand,
  };
});

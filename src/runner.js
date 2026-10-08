'use strict';
// Оркестратор сессий запуска (ТЗ C3 §3.3). CommonJS для main; все внешние зависимости
// внедрены через DI: в Node-тестах spawnPty — фейк, в main — node-pty. Раннер НЕ пишет
// файлы проекта (кроме создания папки .ide_build перед компиляцией), НЕ трогает журнал
// контекста и историю операций: запуск — чтение мира, а не изменение проекта.

const fs = require('fs');
const path = require('path');
const runlangs = require('./runlangs');
const { buildReport, createRing, shortToolName } = require('./runfmt');

const OUTPUT_LIMIT = 4 * 1024 * 1024; // кольцевой буфер вывода на сессию, 4 МБ
const INPUT_LIMIT = 64 * 1024;        // stdin из предложения — не больше 64 КБ

function createRunner(deps) {
  const d = deps || {};
  const spawnPty = d.spawnPty || (() => { throw new Error('spawnPty не предоставлен'); });
  const killTree = d.killTree || (() => {});
  const clock = d.clock || (() => Date.now());
  const send = d.send || (() => {});
  const getRunConfig = d.getRunConfig || (() => ({}));
  const toolchain = d.toolchain || null;
  const fsx = d.fs || fs;
  // Платформа одна на весь раннер и всегда из DI (с честным запасом на хост):
  // от неё зависят суффикс .exe в плане компиляции, разделители путей и оболочка
  // для &CMD:. Читать process.platform по месту нельзя — иначе на Windows тесты,
  // которым внедрён 'linux', получают поведение боевой машины (так и было).
  const platform = d.platform || process.platform;
  const isWin = platform === 'win32';
  const pth = isWin ? path.win32 : path.posix;
  // ComSpec — путь к cmd.exe из окружения Windows. Внедряется, чтобы тест не зависел
  // от машины: на POSIX его просто нет, а на Windows он есть всегда.
  const comSpec = d.comSpec === undefined ? process.env.ComSpec : d.comSpec;
  const limits = d.limits || {};
  const maxOutputBytes = Number.isFinite(limits.maxOutputBytes) && limits.maxOutputBytes > 0
    ? limits.maxOutputBytes : OUTPUT_LIMIT;
  const onStart = d.onStart || (() => {});   // main: пауза fs.watch
  const onEnd = d.onEnd || (() => {});       // main: возобновить fs.watch
  const onError = d.onError || ((e) => { throw e; });

  let seq = 0;
  let active = null;     // одна активная сессия: новый запуск = перезапуск
  let lastSession = null; // последняя сессия (в т.ч. завершённая) — для кнопки «Отчёт»

  const sendState = () => send('run:state', {
    active: active
      ? { kind: active.kind, label: active.label, state: active.state, sessionId: active.id }
      : null,
  });

  // ---------- watchdog бездействия ----------
  // Любой вывод или ввод сбрасывает таймер: долгая компиляция с прогрессом не
  // прерывается, а программа, молча ждущая пользователя, не висит вечно.
  function armWatchdog(session) {
    const cfg = getRunConfig() || {};
    const t = Number.isFinite(cfg.timeoutSec) && cfg.timeoutSec >= 0 ? cfg.timeoutSec : 600;
    clearTimeout(session.watchdog);
    if (!t || session.state !== 'running') return;
    session.watchdog = setTimeout(() => {
      if (session !== active || session.state !== 'running') return;
      session.forced = 'timeout';
      try { killTree(session.pid, session.pty); } catch (e) { onError(e); }
    }, t * 1000);
    // В main таймер обязан держать процесс живым (иначе watchdog не сработает),
    // а в Node-тестах — наоборот (unref), чтобы тест не висел до таймаута.
    if (d.watchdogUnref && session.watchdog && typeof session.watchdog.unref === 'function') {
      session.watchdog.unref();
    }
  }

  function clearWatchdog(session) { clearTimeout(session.watchdog); session.watchdog = null; }

  // ---------- шаги ----------

  function startStep(session, index) {
    const step = session.plan.steps[index];
    session.step = index;
    const cwd = session.cwd;
    // Исполняемый файл шага с каталогом в пути обязан быть абсолютным: на Windows
    // CreateProcess ищет относительный путь относительно текущей папки РОДИТЕЛЯ
    // (Electron), а не той, что передана в cwd, — второй шаг компилируемых языков
    // ('.ide_build/app.exe') просто не находился. Голые имена ('cmd.exe' из запасного
    // пути planShell) не трогаем: их Windows находит в PATH/System32 сам, а превращение
    // в '<проект>\cmd.exe' только сломало бы запуск команд.
    // В отчёте и в терминале пути остаются короткими: командная строка собирается отдельно.
    const rawExe = step.exe || session.exes[step.tool] || '';
    if (!rawExe) {
      session.forced = 'spawn-failed';
      session.spawnError = 'Не удалось определить исполняемый файл для шага запуска';
      finish(session, -1);
      return;
    }
    const exe = !pth.isAbsolute(rawExe) && /[\\/]/.test(rawExe) ? pth.join(cwd, rawExe) : rawExe;
    const env = Object.assign({}, process.env);
    if (session.plan.env) {
      for (const [k, v] of Object.entries(session.plan.env)) env[k] = String(v).replace('{root}', cwd);
    }
    let pty;
    try {
      pty = spawnPty({
        exe, args: step.args.slice(), cwd, env,
        cols: session.cols, rows: session.rows,
      });
    } catch (e) {
      // Сбой запуска шага — ошибка сессии: reason придёт в run:exit, текст — в ответе start()
      session.forced = 'spawn-failed';
      session.spawnError = 'Не удалось запустить ' + exe + ': ' + (e && e.message ? e.message : String(e));
      finish(session, -1);
      return;
    }
    session.pty = pty;
    session.pid = typeof pty.pid === 'number' ? pty.pid : null;
    pty.onData((text) => onData(session, text));
    pty.onExit(({ exitCode, signal }) => onExit(session, exitCode, signal));
    // Ввод из предложения (тело &RUN:/&CMD:) пишется сразу: интерактивные сценарии
    // не ломаются — пользователь может дописывать ввод вручную. Написанное уходит
    // и в журнал ввода: отчёт обязан показывать ВСЁ, что получила программа (§2.3).
    if (index === 0 && typeof session.input === 'string' && session.input) {
      const payload = session.input.endsWith('\n') || session.input.endsWith('\r')
        ? session.input : session.input + '\n';
      try {
        pty.write(payload.replace(/\n/g, '\r'));
        session.inputLog.push(payload);
      } catch { /* процесс мог не стартовать */ }
    }
    armWatchdog(session);
  }

  function onData(session, text) {
    if (session.state !== 'running') return;
    send('run:data', { sessionId: session.id, step: session.step, text });
    const over = session.ring.push(text);
    armWatchdog(session);
    if (over && session.state === 'running') {
      session.forced = 'output-limit';
      try { killTree(session.pid, session.pty); } catch (e) { onError(e); }
    }
  }

  function onExit(session, code, signal) {
    if (session.state !== 'running') return; // сессию уже завершили (перезапуск, стоп)
    const exitCode = typeof code === 'number' ? code : (signal ? 1 : 0);
    const next = session.plan && session.plan.steps ? session.plan.steps[session.step + 1] : null;
    if (!session.forced && exitCode === 0 && next) {
      // Двухшаговый план: компиляция успешна — разделитель и запуск в том же терминале.
      // Разделитель печатает renderer локально (run:exit со nextStep), в pty и в отчёт
      // он не попадает.
      send('run:exit', {
        sessionId: session.id, code: exitCode, step: session.step, stepKind: session.plan.steps[session.step].kind,
        nextStep: { index: session.step + 1, kind: next.kind },
      });
      session.pty = null;
      startStep(session, session.step + 1);
      return;
    }
    finish(session, exitCode);
  }

  function finish(session, code) {
    if (session.state === 'exited') return;
    clearWatchdog(session);
    session.state = 'exited';
    session.exitCode = typeof code === 'number' ? code : null;
    session.endedAt = clock();
    const forced = session.forced;
    session.forced = null;
    let reason = null;
    if (forced === 'timeout') reason = 'timeout';
    else if (forced === 'output-limit') reason = 'output-limit';
    else if (forced === 'spawn-failed') reason = 'spawn-failed';
    else if (forced) reason = 'stopped'; // пользовательский стоп или перезапуск
    session.lastReason = reason;
    lastSession = session;
    send('run:exit', {
      sessionId: session.id, code: session.exitCode, step: session.step, reason,
      error: session.spawnError || null,
    });
    if (active === session) { active = null; onEnd(session); sendState(); }
  }

  function killActiveSession() {
    const s = active;
    if (!s) return;
    if (s.state === 'running') {
      s.forced = 'stopped';
      clearWatchdog(s);
      try { killTree(s.pid, s.pty); } catch (e) { onError(e); }
      // killTree асинхронен (taskkill/SIGTERM), но сессия закрывается сразу:
      // пользователь нажал «Стоп» и не должен ждать агонии дерева процессов.
      // Служебную строку («остановлен») печатает renderer локально по run:exit.
      finish(s, s.exitCode == null ? -1 : s.exitCode);
    } else {
      active = null;
      sendState();
    }
  }

  /**
   * Подготовка плана file-запуска: язык, инструменты, папка артефактов.
   * Все проверки — до создания сессии, чтобы старая сессия не убивалась зря.
   */
  async function prepareFilePlan(projectPath, rel, runCfg) {
    const dot = rel.lastIndexOf('.');
    const ext = dot > 0 ? rel.slice(dot).toLowerCase() : '';
    const lang = runlangs.langByExt(ext);
    if (!lang) {
      return { error: 'unsupported-ext', message: `Запуск файлов ${ext || 'без расширения'} не поддерживается` };
    }
    let tools;
    try {
      tools = await toolchain.detect(runCfg);
    } catch (e) {
      return { error: 'tool-missing', message: 'Не удалось проверить инструменты: ' + (e && e.message ? e.message : String(e)) };
    }
    const base = (dot > 0 ? rel.slice(0, dot) : rel).split(/[\\/]/).pop();
    let sourceText = null;
    if (lang.id === 'java') {
      try {
        sourceText = fsx.readFileSync(path.join(projectPath, rel), 'utf8');
      } catch (e) {
        return { error: 'file-missing', message: 'Не удалось прочитать файл: ' + (e && e.message ? e.message : String(e)) };
      }
    }
    // Версия Node нужна для решения о флаге strip-types (TS на Node 22 против 23+)
    let nodeMajor = null;
    if (lang.id === 'node' && tools.node && tools.node.found && tools.node.version) {
      nodeMajor = tools.node.version.major;
    }
    const plan = runlangs.planRun(lang.id, rel, {
      platform,
      args: runlangs.tokenizeArgs(runCfg.args && runCfg.args[lang.id] ? runCfg.args[lang.id] : ''),
      fqcn: lang.id === 'java' ? runlangs.javaClassFqn(sourceText, base) : undefined,
      nodeMajor,
    });
    if (!plan.ok) return { error: 'plan-failed', message: plan.error };
    // Разрешение инструментов: exe для каждого шага с tool
    const exes = {};
    for (const step of plan.steps) {
      if (!step.tool || exes[step.tool]) continue;
      const t = tools[step.tool];
      if (!t || !t.found) {
        const names = (runlangs.langById(lang.id).tools.find((x) => x.key === step.tool) || { names: [step.tool] }).names;
        const manualNote = t && t.brokenManual ? ' Указанный в настройках путь не найден.' : '';
        return {
          error: 'tool-missing',
          lang: lang.id,
          tool: step.tool,
          message: `Не найден ${names[0]} в PATH. Установите ${lang.label} и добавьте его в PATH,`
            + ` либо укажите путь к исполняемому файлу в Настройках → Запуск.${manualNote}`,
        };
      }
      exes[step.tool] = t.exe;
    }
    // Папка артефактов создаётся до компиляции: gcc/javac не создают промежуточные папки
    if (plan.outDir) {
      try {
        fsx.mkdirSync(path.join(projectPath, plan.outDir), { recursive: true });
      } catch (e) {
        return { error: 'build-dir-failed', message: 'Не удалось создать папку .ide_build: ' + (e && e.message ? e.message : String(e)) };
      }
    }
    return { lang, plan, exes };
  }

  /**
   * Старт сессии. target: {kind:'file', rel} | {kind:'cmd', command}.
   * @returns {Promise<{ok:true, sessionId}|{ok:false, reason, message?, lang?}>}
   */
  async function start(arg) {
    const a = arg || {};
    const project = a.project && typeof a.project === 'object' ? a.project : null;
    if (!project || typeof project.path !== 'string' || !project.path) {
      return { ok: false, reason: 'no-project', message: 'Сначала выберите проект для этого чата' };
    }
    const target = a.target || {};
    const runCfg = runlangs.sanitizeRunConfig(getRunConfig());
    let kind, label, commandLine, plan, exes, lang = null, cwd = project.path;

    if (target.kind === 'cmd') {
      kind = 'cmd';
      const cmd = typeof target.command === 'string' ? target.command.trim() : '';
      if (!cmd) return { ok: false, reason: 'empty-command', message: 'Пустая команда' };
      label = cmd;
      commandLine = cmd;
      const shell = runlangs.planShell(cmd, platform);
      // ComSpec — настоящий путь к cmd.exe ('C:\WINDOWS\system32\cmd.exe'): надёжнее,
      // чем искать cmd.exe в PATH. Берётся только для целевой Windows-платформы.
      if (isWin && comSpec) shell.exe = comSpec;
      plan = { steps: [{ kind: 'run', tool: null, exe: shell.exe, args: shell.args }], env: null, outDir: null };
      exes = {};
    } else if (target.kind === 'file') {
      kind = 'file';
      const rel = typeof target.rel === 'string' ? target.rel.replace(/\\/g, '/') : '';
      if (!rel) return { ok: false, reason: 'empty-rel', message: 'Не указан файл' };
      let abs;
      try {
        abs = path.resolve(cwd, rel);
      } catch {
        return { ok: false, reason: 'invalid-path', message: 'Неверный путь файла' };
      }
      // Путь строго внутри проекта (страховка: renderer уже проверил resolveInProject)
      const rootResolved = path.resolve(cwd);
      if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
        return { ok: false, reason: 'outside-project', message: 'Файл вне проекта' };
      }
      let st = null;
      try { st = fsx.statSync(abs); } catch { /* ниже */ }
      if (!st || !st.isFile()) {
        return { ok: false, reason: 'file-missing', message: 'Файл не найден: ' + rel };
      }
      const prepared = await prepareFilePlan(cwd, rel, runCfg);
      if (prepared.error) {
        return { ok: false, reason: prepared.error, message: prepared.message, lang: prepared.lang };
      }
      lang = prepared.lang;
      plan = prepared.plan;
      exes = prepared.exes;
      label = rel;
      // Командная строка для отчёта — читаемой: путь к инструменту укорачивается до имени
      // ('C:\…\python.exe' → 'python'), а артефакт сборки остаётся относительным
      // ('.ide_build/app.exe'). Полный путь к инструменту виден в Настройках → Запуск.
      commandLine = plan.steps
        .map((s) => [
          s.exe || shortToolName(exes[s.tool] || s.tool, platform),
          ...(s.args || []),
        ].join(' '))
        .join('  →  ');
    } else {
      return { ok: false, reason: 'bad-target', message: 'Неизвестный тип запуска' };
    }

    // Одна активная сессия: новый запуск = перезапуск (ТЗ §3.3).
    // Строку «── предыдущий процесс остановлен ──» печатает renderer по run:exit.
    if (active) killActiveSession();

    const input = typeof a.input === 'string' ? a.input.slice(0, INPUT_LIMIT) : '';
    const session = {
      id: 'run-' + (++seq) + '-' + clock().toString(36),
      kind, label, commandLine, lang: lang ? lang.id : null,
      file: kind === 'file' ? label : null,
      cwd, projectDir: project.path, projectId: project.id || null,
      plan, exes, input,
      step: 0, state: 'running', pid: null, exitCode: null,
      startedAt: clock(), endedAt: null,
      ring: createRing(maxOutputBytes),
      inputLog: [], forced: null, watchdog: null, pty: null,
      spawnError: null, lastReason: null,
      cols: Number.isFinite(a.cols) ? a.cols : 80,
      rows: Number.isFinite(a.rows) ? a.rows : 24,
    };
    active = session;
    onStart(session);
    sendState();
    startStep(session, 0);
    if (session.spawnError) return { ok: false, reason: 'spawn-failed', message: session.spawnError };
    return { ok: true, sessionId: session.id };
  }

  /** Остановить активную сессию (kill дерева). */
  function stop() {
    if (!active) return { ok: false, reason: 'no-session' };
    killActiveSession();
    return { ok: true };
  }

  /** Остановить без сообщений в терминал — для before-quit (не оставляем сирот). */
  function stopAll() {
    if (active) killActiveSession();
  }

  /** Ввод пользователя из xterm: пишем в pty и фиксируем в журнале для отчёта. */
  function input(text) {
    const s = active;
    if (!s || s.state !== 'running' || !s.pty) return;
    const t = typeof text === 'string' ? text : '';
    if (!t) return;
    try { s.pty.write(t); } catch { /* процесс завершается — ввод игнорируется */ }
    s.inputLog.push(t);
    armWatchdog(s);
  }

  /** Изменение размера терминала (addon-fit) → pty.resize. */
  function resize(cols, rows) {
    const s = active;
    if (!s || !s.pty) return;
    // Number(null) === 0, поэтому «не число» проверяем явно: мусор — к дефолту,
    // а экстремальные значения — к минимуму 2 (нулевой размер pty не переживёт)
    const norm = (v, def) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return def;
      return Math.max(2, Math.round(n));
    };
    const c = norm(cols, 80);
    const r = norm(rows, 24);
    // Холостой resize не безвреден: ConPTY на каждое изменение геометрии перерисовывает
    // экран из своего буфера, а в буфере нового pty пусто — программа, ждущая ввода,
    // «стирала» видимый терминал. Renderer дедуплицирует размер со своей стороны,
    // здесь та же страховка со стороны main (и защита от чужих вызовов).
    if (c === s.cols && r === s.rows) return;
    s.cols = c; s.rows = r;
    try { s.pty.resize(c, r); } catch { /* pty мог завершиться */ }
  }

  /** Отчёт последней сессии (активной или завершённой) — текст для буфера обмена. */
  function report() {
    const s = active || lastSession;
    if (!s) return { ok: false, error: 'Нет запуска для отчёта' };
    const text = buildReport({
      file: s.file, command: s.commandLine, projectDir: s.projectDir,
      exitCode: s.state === 'running' ? undefined : s.exitCode,
      running: s.state === 'running',
      inputLog: s.inputLog, output: s.ring.text(),
      truncated: s.ring.truncated, reason: s.lastReason || null,
    });
    return { ok: true, text };
  }

  return { start, stop, stopAll, input, resize, report, activeInfo: () => active };
}

module.exports = { createRunner, OUTPUT_LIMIT, INPUT_LIMIT };

'use strict';
// Батарея проб spike (ТЗ §26). Каждая проба отвечает на конкретный вопрос, а не «просто работает ли».
// Результаты уходят в main-процесс и складываются в spike/report.json и spike/report.md.

(function () {
  const strategy = window.spike.strategy;
  const vsUrl = (window.spike.vsUrl || '').replace(/\/+$/, '');

  const probes = [];
  const cspViolations = [];
  const runtimeErrors = [];
  const workerLog = [];
  const workerSpy = [];

  // Шпион за созданием воркеров. Ставится до загрузки Monaco, поэтому фиксирует ЛЮБОЙ воркер,
  // кем бы он ни был создан — нашим getWorker или штатным путём Monaco (blob: + module).
  // Без этого нельзя отличить «воркер поднялся» от «Monaco обошёлся без воркера».
  const NativeWorker = window.Worker;
  window.Worker = function SpiedWorker(url, opts) {
    const rec = { url: String(url), type: (opts && opts.type) || 'classic', name: (opts && opts.name) || null, errors: [] };
    workerSpy.push(rec);
    const w = new NativeWorker(url, opts);
    w.addEventListener('error', (ev) => { rec.errors.push(String(ev.message || 'worker error')); });
    return w;
  };
  window.Worker.prototype = NativeWorker.prototype;

  const logEl = document.getElementById('log');
  const listEl = document.getElementById('probes');
  const statusEl = document.getElementById('status');
  document.getElementById('strategy').textContent = 'стратегия: ' + strategy;

  function log(msg) {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    logEl.textContent += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
    console.log('[spike]', msg);
  }

  function repaint() {
    listEl.replaceChildren();
    for (const p of probes) {
      const li = document.createElement('li');
      li.className = p.ok ? 'ok' : 'bad';
      li.append(document.createTextNode(`${p.ok ? '✔' : '✘'} ${p.name}`));
      if (p.detail) {
        const d = document.createElement('span');
        d.className = 'detail';
        d.textContent = p.detail;
        li.append(d);
      }
      listEl.append(li);
    }
  }

  function rec(name, ok, detail) {
    probes.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
    repaint();
    log(`${ok ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`);
    return !!ok;
  }

  // ---------- сбор diagnostики ----------
  document.addEventListener('securitypolicyviolation', (e) => {
    const v = {
      effectiveDirective: e.effectiveDirective,
      violatedDirective: e.violatedDirective,
      blockedURI: e.blockedURI,
      disposition: e.disposition,
      sourceFile: e.sourceFile,
      lineNumber: e.lineNumber,
    };
    cspViolations.push(v);
    log(`! CSP: ${v.effectiveDirective} заблокировал ${v.blockedURI}`);
  });
  window.addEventListener('error', (e) => {
    runtimeErrors.push(String(e.message || e.error));
    log(`! error: ${e.message}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    runtimeErrors.push(String((e.reason && e.reason.message) || e.reason));
    log(`! unhandledrejection: ${(e.reason && e.reason.message) || e.reason}`);
  });

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('не загрузился ' + src));
      document.head.append(s);
    });
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- воркеры ----------
  // 'classic' — создаём воркер сами (обычный, не модульный) через MonacoEnvironment.getWorker.
  // 'default' — не вмешиваемся: Monaco сам сделает blob: + module worker.
  if (strategy !== 'default') {
    window.MonacoEnvironment = {
      getWorker(_moduleId, label) {
        const url = new URL('worker-host.js', document.baseURI);
        url.searchParams.set('vs', vsUrl);
        url.searchParams.set('label', label);
        const w = new Worker(url.href, { type: 'classic', name: label });
        w.addEventListener('error', (ev) => {
          workerLog.push(`${label}: ошибка воркера — ${ev.message || 'без сообщения'}`);
          log(`! worker error (${label}): ${ev.message || 'без сообщения'}`);
        });
        workerLog.push(`${label}: создан classic-воркер ${url.href}`);
        log(`worker создан (${label})`);
        return w;
      },
    };
  } else {
    workerLog.push('MonacoEnvironment не задан — используется штатный путь Monaco (blob: + module)');
  }

  const monacoReady = () => typeof window.monaco !== 'undefined' && !!window.monaco.editor;

  // ---------- пробы ----------

  async function probeLoader() {
    const src = vsUrl + '/loader.js';
    try {
      await loadScript(src);
    } catch (e) {
      return rec('AMD-загрузчик loader.js', false, e.message);
    }
    const ok = typeof window.require === 'function'
      && typeof window.require.config === 'function'
      && typeof window.define === 'function';
    return rec('AMD-загрузчик loader.js', ok, ok ? src : 'require/define не появились после загрузки');
  }

  function probeMonaco() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok, detail) => { if (!settled) { settled = true; clearTimeout(timer); resolve(rec('Monaco vs/editor/editor.main', ok, detail)); } };
      const timer = setTimeout(() => finish(false, 'таймаут 25 с — модуль не загрузился'), 25000);
      try {
        window.require.config({ paths: { vs: vsUrl } });
        window.require(['vs/editor/editor.main'], () => {
          finish(monacoReady() && typeof monaco.editor.create === 'function',
            monacoReady() ? 'monaco.editor доступен' : 'window.monaco не заполнен');
        }, (err) => finish(false, String((err && err.message) || err)));
      } catch (e) {
        finish(false, e.message);
      }
    });
  }

  async function probeLanguageFile() {
    try {
      await loadScript(new URL('../ui/languages/gdscript.js', document.baseURI).href);
    } catch (e) {
      return rec('Файл языка ui/languages/gdscript.js', false, e.message);
    }
    if (!window.WhaleGdscript) return rec('Файл языка ui/languages/gdscript.js', false, 'window.WhaleGdscript не появился');
    try {
      const id = window.WhaleGdscript.register(monaco);
      const known = monaco.languages.getLanguages().some((l) => l.id === id);
      return rec('Язык whale-gdscript зарегистрирован', known && id === 'whale-gdscript', known ? id : 'register() отработал, но язык не найден');
    } catch (e) {
      return rec('Язык whale-gdscript зарегистрирован', false, e.message);
    }
  }

  let editor = null;
  let mainModel = null;

  function probeEditorCreate() {
    try {
      editor = monaco.editor.create(document.getElementById('editor-host'), {
        theme: 'vs-dark',
        automaticLayout: false, // layout() вызываем сами — как в настоящей IDE
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
      });
      mainModel = monaco.editor.createModel('extends Node\n\nfunc _ready():\n\tprint("привет")\n', 'whale-gdscript');
      editor.setModel(mainModel);
      const back = editor.getValue();
      const ok = back.includes('func _ready():') && editor.getModel() === mainModel;
      return rec('editor.create + round-trip значения', ok, ok ? `${back.length} символов` : 'значение не совпало');
    } catch (e) {
      return rec('editor.create + round-trip значения', false, e.message);
    }
  }

  async function probeCodiconFont() {
    const probe = document.createElement('i');
    probe.className = 'codicon codicon-gear';
    probe.style.cssText = 'position:absolute;left:-9999px;top:0';
    document.body.append(probe);
    let ok = false;
    let detail = '';
    try {
      await document.fonts.load('16px codicon');
      await document.fonts.ready;
      ok = document.fonts.check('16px codicon');
      detail = ok ? 'шрифт загружен из data: URI' : 'document.fonts.check("16px codicon") = false';
    } catch (e) {
      detail = e.message;
    }
    probe.remove();
    if (!ok && !detail.includes('font-src')) detail += ' — проверьте, есть ли font-src data: в CSP';
    return rec('Шрифт codicon (font-src data:)', ok, detail);
  }

  function probeTokenizeApi() {
    try {
      const src = '@export var speed: float = 5.0\n# комментарий\nfunc _ready():\n\t$Node.hide()\n';
      const lines = monaco.editor.tokenize(src, 'whale-gdscript');
      // В d.ts у Token заявлены {startIndex, scopes}, а рантайм отдаёт {offset, type, language}
      const types = new Set(lines.flat().map((t) => t.type ?? t.scopes));
      const need = ['tag.gd', 'comment.gd', 'function.gd', 'variable.gd', 'type.gd', 'number.float.gd'];
      const missing = need.filter((n) => !types.has(n));
      return rec('monaco.editor.tokenize (подсветка GDScript)', missing.length === 0,
        missing.length ? `нет токенов: ${missing.join(', ')}; получено: ${[...types].join(', ') || 'пусто'}` : `${types.size} типов токенов`);
    } catch (e) {
      return rec('monaco.editor.tokenize (подсветка GDScript)', false, e.message);
    }
  }

  function probeLanguageByExtension() {
    const cases = [
      ['player.gd', 'whale-gdscript'],
      ['main.py', 'python'],
      ['app.js', 'javascript'],
      ['app.ts', 'typescript'],
      ['data.json', 'json'],
      ['index.html', 'html'],
      ['style.css', 'css'],
      ['a.cs', 'csharp'],
      ['a.cpp', 'cpp'],
    ];
    const bad = [];
    for (const [name, expected] of cases) {
      const m = monaco.editor.createModel('', null, monaco.Uri.parse('inmemory://model/' + name));
      const got = m.getLanguageId();
      if (got !== expected) bad.push(`${name}: ждали ${expected}, получили ${got}`);
      m.dispose();
    }
    return rec('Язык определяется по расширению (§16)', bad.length === 0, bad.length ? bad.join('; ') : `${cases.length} расширений`);
  }

  // Прямые проверки воркеров. Отделяют «CSP/окружение не дают создать воркер» от
  // «Monaco не стал его создавать» — без них проба Diff неоднозначна.
  function probeClassicWorker() {
    return new Promise((resolve) => {
      let w = null;
      const finish = (ok, detail) => {
        if (w) { try { w.terminate(); } catch { /* ignore */ } }
        resolve(rec('Classic-воркер создаётся (worker-src self)', ok, detail));
      };
      try {
        w = new window.Worker(new URL('echo-worker.js', document.baseURI).href, { type: 'classic', name: 'spike-classic' });
        const timer = setTimeout(() => finish(false, 'таймаут 5 с: воркер не ответил'), 5000);
        w.addEventListener('error', (e) => { clearTimeout(timer); finish(false, 'error: ' + (e.message || 'скрипт воркера не загрузился')); });
        w.onmessage = (e) => { clearTimeout(timer); finish(!!(e.data && e.data.ok), (e.data && e.data.detail) || 'эхо получено'); };
        w.postMessage({ ping: 'classic' });
      } catch (e) {
        finish(false, e.message);
      }
    });
  }

  // Штатный путь Monaco: blob-URL + type:'module'. Проверяем отдельно, потому что именно он
  // подозревается в несовместимости с file:// (модульный импорт проверяется по CORS).
  function probeBlobModuleWorker() {
    return new Promise((resolve) => {
      let w = null;
      let url = null;
      const finish = (ok, detail) => {
        if (w) { try { w.terminate(); } catch { /* ignore */ } }
        if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
        resolve(rec('Blob+module воркер создаётся (штатный путь Monaco)', ok, detail));
      };
      try {
        url = URL.createObjectURL(new Blob(["globalThis.postMessage({ ok: true, detail: 'blob module worker работает' });"], { type: 'application/javascript' }));
        w = new window.Worker(url, { type: 'module', name: 'spike-blob-module' });
        const timer = setTimeout(() => finish(false, 'таймаут 5 с: blob-воркер не ответил — нужен worker-src blob:'), 5000);
        w.addEventListener('error', (e) => { clearTimeout(timer); finish(false, 'error: ' + (e.message || 'blob module worker не создался')); });
        w.onmessage = (e) => { clearTimeout(timer); finish(!!(e.data && e.data.ok), (e.data && e.data.detail) || 'эхо получено'); };
      } catch (e) {
        finish(false, e.message);
      }
    });
  }

  // Главная проба: без работающего воркера Diff (а значит и Stage C) не получить.
  // Документы намеренно большие: на крошечных нельзя отличить «воркер ответил» от
  // «Monaco обошёлся без воркера», а именно это и нужно измерить.
  const bigDoc = (tag) => Array.from({ length: 3000 }, (_, i) => (i % 97 === 0 ? `${tag} changed line ${i}` : `line ${i} of the file`)).join('\n');

  function probeWorkerViaDiff() {
    return new Promise((resolve) => {
      let diff = null;
      let orig = null;
      let mod = null;
      try {
        const spyBefore = workerSpy.length;
        const host = document.getElementById('diff-host');
        host.classList.remove('hidden');
        diff = monaco.editor.createDiffEditor(host, { theme: 'vs-dark', automaticLayout: false, renderSideBySide: true });
        orig = monaco.editor.createModel(bigDoc('original'), 'plaintext');
        mod = monaco.editor.createModel(bigDoc('modified'), 'plaintext');
        diff.setModel({ original: orig, modified: mod });

        let settled = false;
        const finish = (ok, detail) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sub.dispose();
          host.classList.add('hidden');
          const changes = ok && diff.getLineChanges() ? diff.getLineChanges().length : 0;
          if (diff) diff.dispose();
          orig.dispose(); mod.dispose();
          const created = workerSpy.slice(spyBefore);
          const extra = ` | воркеров создано: ${created.length}` + (created.length
            ? ' → ' + created.map((w) => `${w.type}${w.errors.length ? ' (ОШИБКА: ' + w.errors.join('; ') + ')' : ''} ${w.url.slice(0, 60)}`).join(' ; ')
            : ' — Diff посчитан БЕЗ воркера');
          resolve(rec('Web worker: Diff на 3000 строк (getLineChanges)', ok, detail + (ok ? `, изменений: ${changes}` : '') + extra));
        };
        const timer = setTimeout(() => finish(false, 'таймаут 20 с: Diff не посчитался — воркер не поднялся'), 20000);
        const sub = diff.onDidUpdateDiff(() => {
          const ch = diff.getLineChanges();
          if (ch) finish(true, 'воркер ответил');
        });
        const immediate = diff.getLineChanges();
        if (immediate) finish(true, 'воркер ответил (синхронно)');
      } catch (e) {
        if (diff) { try { diff.dispose(); } catch { /* ignore */ } }
        if (orig) orig.dispose();
        if (mod) mod.dispose();
        resolve(rec('Web worker: Diff считается (getLineChanges)', false, e.message + (workerLog.length ? ' | ' + workerLog.join(' | ') : '')));
      }
    });
  }

  // ТЗ §7: Monaco живёт независимо от перерисовок — при смене файла меняется model, а не контейнер.
  function probeModelReuse() {
    try {
      const before = monaco.editor.getEditors().length;
      const m2 = monaco.editor.createModel('var second := true\n', 'whale-gdscript');
      editor.setModel(m2);
      const sameInstance = monaco.editor.getEditors().length === before && editor.getModel() === m2;
      const value = editor.getValue();
      editor.setModel(mainModel);
      m2.dispose();
      return rec('Смена файла = смена model, editor не пересоздаётся (§7)',
        sameInstance && value.includes('second'),
        `редакторов: ${before} → ${monaco.editor.getEditors().length}`);
    } catch (e) {
      return rec('Смена файла = смена model, editor не пересоздаётся (§7)', false, e.message);
    }
  }

  // ТЗ §14: позиция курсора и прокрутка сохраняются между переключениями вкладок.
  function probeViewState() {
    try {
      const m = monaco.editor.createModel(Array.from({ length: 200 }, (_, i) => `var v${i} = ${i}`).join('\n'), 'whale-gdscript');
      editor.setModel(m);
      editor.setPosition({ lineNumber: 120, column: 7 });
      editor.revealLine(120);
      editor.setScrollTop(800);
      const saved = editor.saveViewState();
      editor.setModel(mainModel);
      editor.setPosition({ lineNumber: 1, column: 1 });
      editor.setScrollTop(0);
      editor.setModel(m);
      editor.restoreViewState(saved);
      const pos = editor.getPosition();
      const scroll = editor.getScrollTop();
      const ok = !!saved && pos.lineNumber === 120 && pos.column === 7 && scroll > 0;
      const detail = `курсор ${pos.lineNumber}:${pos.column}, scrollTop ${scroll}`;
      editor.setModel(mainModel);
      m.dispose();
      return rec('saveViewState/restoreViewState (§14)', ok, detail);
    } catch (e) {
      return rec('saveViewState/restoreViewState (§14)', false, e.message);
    }
  }

  // ТЗ §5: редактор живёт в ячейке CSS Grid и корректно пересчитывает размеры.
  async function probeGridLayout() {
    try {
      const root = document.documentElement;
      editor.layout();
      const w1 = editor.getLayoutInfo().width;
      root.style.setProperty('--files-w', '340px');
      await wait(60);
      editor.layout();
      const w2 = editor.getLayoutInfo().width;
      root.style.setProperty('--files-w', '220px');
      await wait(60);
      editor.layout();
      const w3 = editor.getLayoutInfo().width;
      const ok = w1 > 0 && w2 > 0 && w3 > 0 && Math.abs(w1 - w2) > 50 && Math.abs(w1 - w3) < 2;
      return rec('Monaco внутри CSS Grid + layout() при resize', ok, `ширина: ${w1} → ${w2} → ${w3}`);
    } catch (e) {
      return rec('Monaco внутри CSS Grid + layout() при resize', false, e.message);
    }
  }

  // ТЗ §4/§28: renderer владеет геометрией, main получает готовые bounds из ResizeObserver.
  // Важно: contentRect у ResizeObserver — координаты внутри padding-box, а setBounds у
  // WebContentsView работает в координатах содержимого окна. Поэтому по уведомлению
  // ResizeObserver измеряем getBoundingClientRect() — именно он и уйдёт в chat:set-bounds.
  async function probeResizeObserver() {
    const slot = document.getElementById('chat-slot');
    if (!slot) return rec('ResizeObserver на #chat-slot (§4)', false, 'нет элемента #chat-slot');
    if (typeof ResizeObserver === 'undefined') return rec('ResizeObserver на #chat-slot (§4)', false, 'ResizeObserver недоступен');
    return new Promise((resolve) => {
      const seen = [];
      let settled = false;
      const finish = (ok, detail) => { if (!settled) { settled = true; clearTimeout(timer); ro.disconnect(); resolve(rec('ResizeObserver на #chat-slot (§4)', ok, detail)); } };
      const timer = setTimeout(() => finish(false, 'колбэк не сработал за 3 с'), 3000);
      const ro = new ResizeObserver(() => {
        const r = slot.getBoundingClientRect();
        const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        const last = seen[seen.length - 1];
        if (!last || last.width !== rect.width || last.x !== rect.x) seen.push(rect);
        log('chat-slot bounds → ' + JSON.stringify(rect));
        if (seen.length >= 2) {
          const ok = seen[0].width > 0 && seen[0].height > 0 && Math.abs(seen[0].width - seen[1].width) > 50;
          finish(ok, ok
            ? `${JSON.stringify(seen[0])} → ${JSON.stringify(seen[1])} (это и уйдёт в chat:set-bounds)`
            : `ширина не изменилась: ${JSON.stringify(seen)}`);
        }
      });
      ro.observe(slot);
      setTimeout(() => document.documentElement.style.setProperty('--chat-w', '620px'), 120);
      setTimeout(() => document.documentElement.style.setProperty('--chat-w', '420px'), 420);
    });
  }

  async function run() {
    log(`стратегия: ${strategy}, vsUrl: ${vsUrl}`);
    log(`userAgent: ${navigator.userAgent}`);

    if (!await probeLoader()) return finish();
    if (!await probeMonaco()) return finish();
    await probeLanguageFile();
    probeEditorCreate();
    await probeCodiconFont();
    probeTokenizeApi();
    probeLanguageByExtension();
    await probeClassicWorker();
    await probeBlobModuleWorker();
    await probeWorkerViaDiff();
    probeModelReuse();
    probeViewState();
    await probeGridLayout();
    await probeResizeObserver();
    // CSP — последней: к этому моменту все загрузки уже произошли
    rec('CSP: нарушений нет', cspViolations.length === 0,
      cspViolations.length ? cspViolations.map((v) => `${v.effectiveDirective} → ${v.blockedURI}`).join('; ') : 'политика из index.html достаточна');
    rec('Непойманных ошибок нет', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join('; '));
    finish();
  }

  function finish() {
    const okCount = probes.filter((p) => p.ok).length;
    statusEl.textContent = `${okCount}/${probes.length} пройдено`;
    statusEl.className = 'pill ' + (okCount === probes.length ? 'ok' : 'bad');
    window.spike.done({
      probes,
      cspViolations,
      runtimeErrors,
      workerLog,
      env: {
        strategy,
        vsUrl,
        userAgent: navigator.userAgent,
        protocol: location.protocol,
        origin: location.origin,
        monacoVersion: (window.monaco && monaco.editor && monaco.editor.EditorOptions) ? 'loaded' : 'unknown',
        monacoEnvironmentSet: !!(window.MonacoEnvironment && typeof window.MonacoEnvironment.getWorker === 'function'),
        workersRequestedByMonacoEnv: workerLog.length,
        workersCreatedTotal: workerSpy.length,
        workerSpy,
      },
    });
  }

  run().catch((e) => {
    rec('Аварийное завершение стенда', false, String((e && e.message) || e));
    finish();
  });
})();

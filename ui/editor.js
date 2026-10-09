'use strict';
// Редактор Stage A (ТЗ §7, §8, §11–16, §25).
//
// Два правила, которые здесь важнее всего:
//
// 1. Monaco создаётся ОДИН раз и переживает любые перерисовки интерфейса (§7).
//    Контейнер #ed-host не пересоздаётся никогда; при смене файла подменяется model.
//
// 2. Вся логика состояний (вкладки, dirty, точки сохранения, конфликт) живёт в
//    ui/editor-state.js и покрыта node-тестами. Этот файл — тонкая обвязка Monaco и DOM:
//    в нём не должно появляться правил про версии файла, иначе их станет две.
//
// Запись на диск идёт только через IPC file:write → src/editorfs → fileops.applyChange,
// то есть тем же путём, что и предложения модели (§2).

(function () {
  const { h } = window.WhaleDom;
  const ES = window.WhaleEditorState;
  const api = window.api;

  /**
   * Обёртка над IPC. main бросает исключения (например, «Проект не найден» или forbidden),
   * и без обёртки они улетали бы в unhandledrejection — то есть клик по дереву просто
   * ничего не делал бы, без внятной причины.
   */
  async function call(channel, arg) {
    try {
      return await api.invoke(channel, arg);
    } catch (e) {
      toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
      return null;
    }
  }

  let monaco = null;
  let editor = null;
  let els = null;
  let state = ES.createState();
  const models = new Map();          // path -> ITextModel
  const tree = {
    dirs: new Map(), expanded: new Set(),
    // Поле ввода имени в дереве (этап D): {mode:'create-file'|'create-dir'|'rename',
    // parentRel, rel, name}. Рисуется вместо строки (rename) или в конце папки (create).
    pending: null,
  };
  // «Внешние» данные дерева (этап B): их передаёт app.js из журналов — расхождения
  // контекста, файлы, которых модель не видела (этап D), последние откатимые операции,
  // предложения модели + колбэки кнопок.
  // Правила соединения с состоянием редактора — чистая ES.treeRowMarks (тестируется в Node).
  let extras = { manual: new Set(), unseen: new Set(), undo: new Map(), proposals: new Map(), callbacks: {} };
  // Доп. узлы строки вкладок (этап C3): кнопку «▶ Запустить» рисует app.js —
  // у редактора нет доступа к run-каналам, а вкладкам нужен единый ряд.
  let tabsExtras = [];
  let projectId = null;
  let visible = false;
  let toast = () => {};
  let onDirtyChange = () => {};
  let onWantEditorMode = () => {};
  let overlayClose = null;           // как закрыть текущий оверлей
  let marksTimer = null;
  let cursorInfo = { ln: 1, col: 1 };

  // ---------- Monaco ----------

  async function ensureMonaco() {
    if (editor) return editor;
    monaco = await window.WhaleMonaco.init();
    editor = monaco.editor.create(els.host, {
      theme: 'vs-dark',
      automaticLayout: true,   // панель тянут разделителем — размеры пересчитываются сами
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      fixedOverflowWidgets: true,
      unicodeHighlight: { ambiguousCharacters: false },
    });
    editor.onDidChangeModelContent(onContentChange);
    editor.onDidChangeCursorPosition((e) => {
      cursorInfo = { ln: e.position.lineNumber, col: e.position.column };
      renderStatus();
    });
    // Ctrl+S внутри Monaco: иначе команду перехватит меню браузера/ОС
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { saveActive(); });
    return editor;
  }

  function uriFor(f) {
    const parts = String(f.path).split('/').map(encodeURIComponent).join('/');
    return monaco.Uri.parse(`whale-file:///${encodeURIComponent(f.projectId)}/${parts}`);
  }

  function modelFor(f) {
    let m = models.get(f.path);
    if (m) return m;
    const uri = uriFor(f);
    m = monaco.editor.getModel(uri) || monaco.editor.createModel(f.text, f.language, uri);
    models.set(f.path, m);
    return m;
  }

  /**
   * Запоминаем курсор и прокрутку вкладки (§14).
   *
   * Путь передаётся явно, а не берётся из state.active: к моменту вызова активная вкладка
   * уже может быть другой (Ctrl+Tab, закрытие), и состояние уехало бы не в тот файл.
   * Дополнительная сверка с editor.getModel() страхует от той же ошибки: если редактор
   * показывает другую модель, сохранять нечего.
   */
  function rememberViewState(p) {
    if (!editor) return;
    const target = p || state.active;
    if (!target) return;
    const m = models.get(target);
    if (!m || editor.getModel() !== m) return;
    ES.setViewState(state, target, editor.saveViewState());
  }

  async function showInEditor(p) {
    const f = ES.get(state, p);
    if (!f) return;
    await ensureMonaco();
    const m = modelFor(f);
    if (m.getValue() !== f.text) m.setValue(f.text); // после reload с диска
    // Если модель уже показана — не переподключаем: setModel() сбрасывает вид
    // (курсор, прокрутку, выделения), а showInEditor вызывается в том числе на каждое
    // files:changed / proposals:changed через render(). Иначе курсор прыгал бы при печати.
    if (editor.getModel() !== m) {
      editor.setModel(m);
      if (f.viewState) editor.restoreViewState(f.viewState);
    }
    monaco.editor.setModelLanguage(m, f.language);
    // Узлы показываем только в режиме редактора: панель может быть занята «Промптом»
    // или просмотром предложения (их переключает app.js), а showInEditor вызывается
    // в том числе внешними событиями — редактор не должен из-под них вылезать.
    if (visible) {
      els.host.classList.remove('hidden');
      els.empty.classList.add('hidden');
      editor.focus();
      editor.layout();
    }
  }

  function showEmpty() {
    if (editor) editor.setModel(null);
    if (!visible) return; // режим редактора выключен — узлы не трогаем (см. showInEditor)
    els.host.classList.add('hidden');
    els.empty.classList.remove('hidden');
  }

  // ---------- содержимое и статус ----------

  function onContentChange() {
    const p = state.active;
    if (!p || !editor) return;
    const m = editor.getModel();
    ES.setText(state, p, m ? m.getValue() : '');
    renderTabs();
    renderStatus();
    onDirtyChange();
    clearTimeout(marksTimer);
    marksTimer = setTimeout(renderTree, 200);
  }

  // ---------- открытие/закрытие ----------

  async function openPath(rel, pid) {
    const useProject = pid || projectId;
    if (!useProject) { toast('Сначала выберите проект', 'err'); return false; }
    if (typeof rel !== 'string' || !rel) return false;
    // Панель редактора может показывать «Промпт» или просмотр предложения: открытие
    // файла — явное намерение видеть код, поэтому сначала возвращаем режим редактора.
    onWantEditorMode();
    const existing = ES.get(state, rel);
    if (existing) { await activate(rel); return true; }

    const r = await call('file:read', { projectId: useProject, path: rel });
    if (!r || !r.ok) { toast(r && r.error ? r.error : 'Не удалось прочитать файл', 'err'); return false; }
    ES.open(state, {
      projectId: useProject, path: r.path, content: r.content, hash: r.hash,
      eol: r.eol, hasBom: r.hasBom, language: window.WhaleMonaco.languageForPath(r.path),
    });
    await syncKnown([r.path]);
    try {
      await showInEditor(r.path);
    } catch (e) {
      console.error('[editor]', e);
      showFatal(e);
      return false;
    }
    renderAll();
    onDirtyChange();
    return true;
  }

  async function activate(p) {
    rememberViewState(state.active);
    if (!ES.activate(state, p)) return;
    await showInEditor(p);
    renderTabs();
    renderStatus();
  }

  async function closePath(p, { force = false } = {}) {
    const f = ES.get(state, p);
    if (!f) return;
    const res = ES.close(state, p, { force });
    if (!res.closed) {
      // §12: Сохранить / Не сохранять / Отмена
      const choice = await confirmDirty(f);
      if (choice === 'cancel') return;
      if (choice === 'save' && !(await savePath(p))) return;
      ES.close(state, p, { force: true });
    }
    const m = models.get(p);
    if (m) { m.dispose(); models.delete(p); }
    if (state.active) await showInEditor(state.active);
    else showEmpty();
    renderAll();
    onDirtyChange();
  }

  function closeActive() {
    if (state.active) closePath(state.active);
  }

  async function nextTab(dir = 1) {
    rememberViewState(state.active); // до переключения, иначе состояние уйдёт не в ту вкладку
    const f = ES.activateRelative(state, dir);
    if (f) await showInEditor(f.path);
    renderTabs();
    renderStatus();
  }

  // ---------- сохранение (§9, §11) ----------

  async function savePath(p, force = false) {
    const f = ES.get(state, p);
    if (!f) return false;
    if (ES.isMissing(f) && !force) {
      toast('Файл удалён или недоступен на диске — сохранение невозможно.', 'err');
      return false;
    }
    const d = ES.describe(state, p);
    // §11: если файл изменился на диске — НЕ пишем, а спрашиваем
    if (!force && d.diskDrift) { showConflict(f, d, null); return false; }

    const base = force ? ES.forceSaveBase(state, p) : f.savedHash;
    // Принятые в буфер ханки модели уходят вместе с сохранением (этап C): main по ним
    // ставит source:'ai' в истории, помечает предложения применёнными и решает,
    // знает ли модель итоговый текст (честное правило контекста).
    const pendingAi = ES.getPendingAi(state, p);
    const r = await call('file:write', {
      projectId: f.projectId, path: f.path, content: f.text, expectedHash: base,
      aiAccepts: pendingAi.length ? pendingAi : undefined,
    });
    if (!r) return false;
    if (r.ok) {
      ES.setSaved(state, p, { text: f.text, hash: r.hash });
      ES.clearPendingAi(state, p);
      renderAll();
      onDirtyChange();
      toast(`Сохранено: ${f.name}`, 'ok');
      return true;
    }
    if (r.code === 'conflict') { showConflict(f, ES.describe(state, p), r); return false; }
    toast(r.error || 'Не удалось сохранить', 'err');
    return false;
  }

  /**
   * Сохранить активный файл. Возвращает результат (Promise<boolean>): «Принять и
   * сохранить» из диффа ждёт ответа, чтобы не оставлять просмотр открытым при ошибке.
   */
  function saveActive() {
    if (!state.active) { toast('Нет открытого файла', 'err'); return false; }
    const f = ES.active(state);
    if (ES.isMissing(f)) {
      toast('Файл удалён или недоступен на диске — сохранение невозможно. Закройте вкладку или восстановите файл.', 'err');
      return false;
    }
    if (!ES.isDirty(f)) { toast('Изменений нет', 'ok'); return false; }
    return savePath(state.active, false);
  }

  /**
   * Сохранить ВСЕ dirty-буферы перед запуском (ТЗ C3 §2.2, шаг 1): программа обязана
   * видеть то, что пользователь напечатал, а путь записи на диск единственный —
   * file:write. Дисковый конфликт (drift) сохраняем принудительно: запуск важнее,
   * но любая ошибка (файл удалён, отказ записи) отменяет запуск — решает caller.
   * @returns {Promise<boolean>} true — несохранённых буферов не осталось
   */
  async function saveAllDirty() {
    for (const p of ES.dirtyPaths(state)) {
      const f = ES.get(state, p);
      if (!f) continue;
      // eslint-disable-next-line no-await-in-loop — порядок важен: сохраняем по одному,
      // чтобы конфликт первого файла не потерялся за ошибками остальных
      const ok = await savePath(p, ES.isDrifted(f) || ES.isMissing(f));
      if (!ok) return false;
    }
    return true;
  }

  /** Активный файл для кнопки «▶ Запустить»: projectId + относительный путь. */
  function activeFile() {
    const f = ES.active(state);
    if (!f) return null;
    return { projectId: f.projectId, rel: f.path, name: f.name };
  }

  /**
   * Перечитывает файл БЕЗ вопроса: буфер чист, терять нечего. Курсор и прокрутку
   * сохраняем — иначе файл «прыгал» бы при каждом внешнем изменении.
   */
  async function reloadSilently(p) {
    const f = ES.get(state, p);
    if (!f) return false;
    const r = await call('file:read', { projectId: f.projectId, path: p });
    if (!r || !r.ok) return false;
    const isActive = state.active === p;
    let vs = null;
    if (isActive) { rememberViewState(p); vs = f.viewState; }
    ES.reload(state, p, { content: r.content, hash: r.hash, eol: r.eol, hasBom: r.hasBom });
    const m = models.get(p);
    if (m && m.getValue() !== r.content) m.setValue(r.content);
    if (isActive && editor && vs) {
      try { editor.restoreViewState(vs); } catch { /* состояние вида не критично */ }
    }
    return true;
  }

  async function reloadFromDisk(p) {
    const f = ES.get(state, p);
    if (!f) return;
    const r = await call('file:read', { projectId: f.projectId, path: p });
    if (!r || !r.ok) { toast(r && r.error ? r.error : 'Не удалось перечитать файл', 'err'); return; }
    if (state.active === p) rememberViewState(p);
    const vs = ES.get(state, p).viewState;
    ES.reload(state, p, { content: r.content, hash: r.hash, eol: r.eol, hasBom: r.hasBom });
    const m = models.get(p);
    if (m) m.setValue(r.content);
    if (state.active === p) {
      await showInEditor(p);
      if (vs) { try { editor.restoreViewState(vs); } catch { /* не критично */ } }
    }
    renderAll();
    onDirtyChange();
    toast('Файл перечитан с диска. Ваши правки отменены.', 'ok');
  }

  // ---------- оверлеи (§24: только внутри IDE-области) ----------

  function openOverlay(node) {
    closeOverlay();
    els.overlay.replaceChildren(node);
    els.overlay.classList.remove('hidden');
    overlayClose = () => {
      els.overlay.classList.add('hidden');
      els.overlay.replaceChildren();
      overlayClose = null;
    };
  }

  function closeOverlay() {
    if (overlayClose) overlayClose();
    else { els.overlay.classList.add('hidden'); els.overlay.replaceChildren(); }
  }

  /** §12: Сохранить / Не сохранять / Отмена. Возвращает 'save' | 'discard' | 'cancel'. */
  function confirmDirty(f) {
    return new Promise((resolve) => {
      let done = false;
      const answer = (v) => { if (done) return; done = true; closeOverlay(); resolve(v); };
      openOverlay(h('div', { class: 'ed-dialog', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'ed-dialog-title' }, 'Сохранить изменения?'),
        h('div', { class: 'ed-dialog-text' }, `«${f.name}» изменён и не сохранён.`, h('br'),
          'Если закрыть вкладку без сохранения, правки будут потеряны.'),
        h('div', { class: 'ed-dialog-actions' },
          h('button', { class: 'btn primary', onclick: () => answer('save') }, 'Сохранить'),
          h('button', { class: 'btn', onclick: () => answer('discard') }, 'Не сохранять'),
          h('button', { class: 'btn ghost', onclick: () => answer('cancel') }, 'Отмена'))));
      const first = els.overlay.querySelector('.btn.primary');
      if (first) first.focus();
    });
  }

  /**
   * §11: файл изменён на диске. «Сохранить поверх» намеренно НЕ основная кнопка и без
   * подтверждения не срабатывает — она уничтожает чужие правки.
   */
  function showConflict(f, d, writeResult) {
    const diskText = writeResult && typeof writeResult.diskContent === 'string' ? writeResult.diskContent : null;
    openOverlay(h('div', { class: 'ed-dialog', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'ed-dialog-title' }, 'Файл изменён на диске'),
      h('div', { class: 'ed-dialog-text' },
        `«${f.name}» был изменён вне редактора после того, как вы его открыли.`,
        h('br'), h('b', {}, 'Ваши изменения НЕ были записаны.'), h('br'),
        h('span', { class: 'path' }, d.summary || '')),
      h('div', { class: 'ed-dialog-actions' },
        h('button', {
          class: 'btn primary',
          onclick: () => showConflictDiff(f, diskText),
        }, 'Показать различия'),
        h('button', { class: 'btn', onclick: () => { closeOverlay(); reloadFromDisk(f.path); } }, 'Перезагрузить файл'),
        h('button', {
          class: 'btn danger-subtle',
          title: 'Перезапишет файл на диске вашей версией — чужие изменения будут потеряны',
          onclick: async () => {
            const ok = window.confirm(`Файл «${f.name}» изменён вне редактора.\n\nПерезаписать его вашей версией? Изменения, сделанные другой программой, будут потеряны безвозвратно.`);
            if (!ok) return;
            closeOverlay();
            await savePath(f.path, true);
          },
        }, 'Сохранить поверх'))));
    const first = els.overlay.querySelector('.btn.primary');
    if (first) first.focus();
  }

  /** Diff «диск ↔ буфер». Monaco DiffEditor, при сбое — две текстовые панели. */
  async function showConflictDiff(f, diskText) {
    let disk = diskText;
    if (disk == null) {
      const r = await call('file:read', { projectId: f.projectId, path: f.path });
      if (!r || !r.ok) { toast(r && r.error ? r.error : 'Не удалось прочитать файл с диска', 'err'); return; }
      disk = r.content;
    }
    const box = h('div', { class: 'ed-diff' });
    const closeBtn = h('button', { class: 'btn', onclick: () => closeOverlay() }, 'Закрыть');
    openOverlay(h('div', { class: 'ed-dialog wide', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'ed-dialog-title' }, `Различия: ${f.name}`, h('span', { class: 'grow' }), closeBtn),
      h('div', { class: 'ed-diff-legend' },
        h('span', {}, 'слева — версия на диске'), h('span', {}, 'справа — ваш буфер')),
      box));

    let diff = null;
    let orig = null;
    let mod = null;
    try {
      await ensureMonaco();
      // Ширину измеряем сами и явно выбираем режим: полагаться на эвристику Monaco нельзя —
      // панель редактора узкая, и «почти side-by-side» в ней нечитаем.
      const avail = box.clientWidth || (els.overlay ? els.overlay.clientWidth : 0) || 0;
      const sideBySide = avail >= 720;
      diff = monaco.editor.createDiffEditor(box, {
        theme: 'vs-dark', readOnly: true, renderSideBySide: sideBySide,
        useInlineViewWhenSpaceIsLimited: true, automaticLayout: true,
        minimap: { enabled: false }, scrollBeyondLastLine: false, diffWordWrap: 'on',
      });
      orig = monaco.editor.createModel(disk, f.language);
      mod = monaco.editor.createModel(f.text, f.language);
      diff.setModel({ original: orig, modified: mod });
      // Раскладка считается до того, как браузер разместил оверлей, поэтому повторяем
      // на следующем кадре и ещё раз с задержкой — иначе половина диффа остаётся за границей.
      const relayout = () => { if (diff) { try { diff.layout(); } catch { /* уже закрыт */ } } };
      requestAnimationFrame(relayout);
      setTimeout(relayout, 80);
      // закрываем модели вместе с оверлеем, иначе они текут
      const prev = overlayClose;
      overlayClose = () => {
        if (diff) { try { diff.dispose(); } catch { /* ignore */ } }
        if (orig) orig.dispose();
        if (mod) mod.dispose();
        if (prev) prev();
      };
    } catch (e) {
      if (diff) { try { diff.dispose(); } catch { /* ignore */ } }
      if (orig) orig.dispose();
      if (mod) mod.dispose();
      box.replaceChildren(h('div', { class: 'ed-diff-fallback' },
        h('div', {}, h('b', {}, 'На диске:'), h('pre', { class: 'code' }, disk)),
        h('div', {}, h('b', {}, 'В буфере:'), h('pre', { class: 'code' }, f.text)),
        h('div', { class: 'path' }, 'Monaco DiffEditor недоступен, показан текст обеих версий: ' + e.message)));
    }
  }

  // ---------- быстрый поиск файла (Ctrl+P, §25) ----------

  async function showQuickOpen() {
    if (!projectId) { toast('Сначала выберите проект', 'err'); return; }
    const t = await call('prompt:tree', { projectId });
    const files = [];
    (function walk(nodes) {
      for (const n of nodes || []) {
        if (n.isDir) walk(n.children);
        else files.push(n.rel);
      }
    })((t && t.nodes) || []);
    if (!files.length) { toast('В проекте не найдено файлов', 'err'); return; }

    const listBox = h('div', { class: 'ed-quick-list' });
    const input = h('input', {
      type: 'text', class: 'ed-quick-input', placeholder: `Имя файла (${files.length} в проекте)`,
      'aria-label': 'Поиск файла', spellcheck: 'false',
      oninput: (e) => paint(e.target.value),
      onkeydown: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); return; }
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = listBox.querySelector('.ed-quick-item');
          if (first) first.click();
        }
      },
    });

    // подстрочное совпадение + ранг: чем короче промежуток, тем выше
    const rank = (rel, q) => {
      const s = rel.toLowerCase();
      const needle = q.toLowerCase();
      if (!needle) return 0;
      let i = 0;
      let spread = 0;
      let first = -1;
      for (const ch of needle) {
        const at = s.indexOf(ch, i);
        if (at < 0) return null;
        if (first < 0) first = at;
        spread = at - first;
        i = at + 1;
      }
      const base = s.endsWith(needle) ? -1000 : 0;
      const slash = s.lastIndexOf('/') + 1;
      const nameBonus = first >= slash ? -500 : 0;
      return base + nameBonus + spread;
    };

    function paint(q) {
      const found = files
        .map((rel) => ({ rel, r: rank(rel, q) }))
        .filter((x) => x.r !== null)
        .sort((a, b) => a.r - b.r || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel))
        .slice(0, 50);
      listBox.replaceChildren(...found.map((x) => h('button', {
        class: 'ed-quick-item', type: 'button', title: x.rel,
        onclick: () => { closeOverlay(); openPath(x.rel); },
      }, x.rel)));
      if (!found.length) listBox.replaceChildren(h('div', { class: 'ed-quick-empty' }, 'Ничего не найдено'));
    }

    paint('');
    openOverlay(h('div', { class: 'ed-dialog quick', role: 'dialog', 'aria-modal': 'true' }, input, listBox));
    input.focus();
  }

  // ---------- дерево файлов (§13, этап B: единственное дерево, отдельной вкладки нет) ----------

  async function loadDir(rel) {
    if (tree.dirs.has(rel)) return tree.dirs.get(rel);
    // Никогда не бросаем: loadDir вызывают из .then() и из обработчиков кликов,
    // а отказ должен показываться в самом дереве, а не в консоли.
    if (!projectId) { tree.dirs.set(rel, { error: 'Проект не выбран' }); return tree.dirs.get(rel); }
    const r = await call('fs:list', { projectId, rel });
    tree.dirs.set(rel, r || { error: 'Не удалось прочитать папку' });
    return tree.dirs.get(rel);
  }

  const fmtTs = (ts) => new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

  function nodes(rel, depth, out) {
    const dir = tree.dirs.get(rel);
    if (!dir) return;
    const pend = tree.pending;
    const pendingHere = pend && pend.mode !== 'rename' && pend.parentRel === rel;
    if (dir.error) {
      out.push(h('div', { class: 'ed-tree-err', style: `padding-left:${depth * 14 + 4}px` }, dir.error));
      // Поле ввода имени не теряем даже при ошибке чтения: операция дойдёт до main
      // и вернёт содержательную ошибку, а исчезнувшее поле выглядело бы как игнорирование клика.
      if (pendingHere) out.push(nameInputRow(depth));
      return;
    }
    for (const it of dir.items || []) {
      const open = tree.expanded.has(it.rel);
      const cb = extras.callbacks || {};
      // Отметки файла считаем одной чистой функцией: состояние буфера + журналы app.js
      const m = it.isDir ? null : ES.treeRowMarks(state, it.rel, extras);
      // Переименовываемая строка заменяется полем ввода имени (как в VS Code)
      if (pend && pend.mode === 'rename' && pend.rel === it.rel) {
        out.push(nameInputRow(depth));
        continue;
      }
      out.push(h('div', {
        class: 'ed-node' + (state.active === it.rel ? ' on' : '')
          + (m && m.dirty ? ' dirty' : '') + (m && m.drift ? ' drift' : '')
          + (m && m.diverged ? ' diverged' : '') + (m && m.unseen ? ' unseen' : '')
          + (m && m.proposal ? ' has-proposal' : ''),
        style: `padding-left:${depth * 14 + 4}px`,
        title: it.isDir ? it.rel : (m && m.drift ? 'Файл изменён вне редактора' : it.rel),
        onclick: async () => {
          if (it.isDir) {
            if (open) tree.expanded.delete(it.rel);
            else { tree.expanded.add(it.rel); await loadDir(it.rel); }
            renderTree();
          } else {
            await openPath(it.rel);
          }
        },
        // Правый клик — операции с файлами и папками (этап D)
        oncontextmenu: (e) => {
          if (e.preventDefault) e.preventDefault();
          openCtxMenu(e.clientX || 0, e.clientY || 0, it);
        },
      },
      h('span', { class: 'ed-twisty' }, it.isDir ? (open ? '▾' : '▸') : ''),
      h('span', { class: 'ed-name' }, it.name),
      m && m.dirty && h('span', { class: 'ed-mark dirty', title: 'Несохранённые изменения' }, '●'),
      m && m.drift && h('span', { class: 'ed-mark drift', title: 'Файл изменён вне редактора' }, '⚠'),
      // ◆ — модель в чате не знает текущую версию: клик ведёт в сравнение, где есть
      // «Скопировать изменения для модели» и «✓ Модель проинформирована»
      m && m.diverged && h('button', {
        class: 'ed-mark ctx', type: 'button',
        title: 'Модель в чате не знает текущую версию файла — показать отличия',
        onclick: (e) => { e.stopPropagation(); if (cb.onManual) cb.onManual(it.rel); },
      }, '◆'),
      // ✚ — модель не видела файл вовсе: создан или изменён вне чата (этап D).
      // Клик ведёт в тот же просмотр: содержимое целиком + «✓ Модель проинформирована».
      m && m.unseen && h('button', {
        class: 'ed-mark unseen', type: 'button',
        title: 'Модель не видела этот файл: он создан или изменён без её участия — показать и передать модели',
        onclick: (e) => { e.stopPropagation(); if (cb.onManual) cb.onManual(it.rel); },
      }, '✚'),
      // синяя точка — есть предложение модели по этому файлу: клик открывает предложение
      m && m.proposal && h('button', {
        class: 'ed-mark prop', type: 'button',
        title: `Предложение модели: +${m.proposal.added}${m.proposal.removed ? ' / −' + m.proposal.removed : ''} — открыть`,
        onclick: (e) => { e.stopPropagation(); if (cb.onProposal) cb.onProposal(it.rel); },
      }),
      // действия строки видны при наведении: откат последней операции и проводник
      !it.isDir && h('span', { class: 'ed-acts' },
        m && m.undo && h('button', {
          class: 'ed-act undo', type: 'button',
          title: (m.undo.op === 'create' ? 'Удалить файл, созданный приложением' : 'Вернуть версию до последнего изменения')
            + ' (' + fmtTs(m.undo.ts) + ')',
          onclick: (e) => { e.stopPropagation(); if (cb.onUndo) cb.onUndo(m.undo); },
        }, '↩'),
        h('button', {
          class: 'ed-act', type: 'button', title: 'Показать в проводнике',
          onclick: (e) => { e.stopPropagation(); if (cb.onReveal) cb.onReveal(it.rel); },
        }, '↗'))));
      if (it.isDir && open) nodes(it.rel, depth + 1, out);
    }
    // Поле «нового» имени — в конце той папки, где создаём (для корня parentRel === '')
    if (pendingHere) out.push(nameInputRow(depth));
  }

  function renderTree() {
    if (!els) return;
    if (!projectId) {
      els.tree.replaceChildren(h('div', { class: 'ed-tree-empty' }, 'Выберите проект вверху — дерево появится здесь.'));
      return;
    }
    const out = [];
    nodes('', 0, out);
    if (!out.length) out.push(h('div', { class: 'ed-tree-empty' }, 'Загрузка…'));
    els.tree.replaceChildren(...out);
  }

  /**
   * files:changed / внешние изменения: перечитать корень и раскрытые папки, сохранив
   * раскрытие. Ошибки не бросаем — loadDir кладёт в кэш {error}, дерево его показывает.
   */
  async function refreshTree() {
    if (!els) return;
    if (!projectId) { renderTree(); return; }
    const expanded = [...tree.expanded];
    tree.dirs.clear();
    await loadDir('');
    for (const rel of expanded) {
      // eslint-disable-next-line no-await-in-loop — раскрытых папок единицы, порядок не важен
      await loadDir(rel);
      const d = tree.dirs.get(rel);
      if (d && d.error) tree.expanded.delete(rel); // папку удалили
    }
    renderTree();
  }

  /**
   * app.js передаёт данные журналов для отметок дерева (контекст, история, предложения)
   * и колбэки кнопок. Разделение такое: правила — ES.treeRowMarks (чистые, в тестах),
   * данные — app.js, отрисовка — здесь.
   */
  function setTreeExtras(next) {
    extras = {
      manual: (next && next.manual) || new Set(),
      unseen: (next && next.unseen) || new Set(),
      undo: (next && next.undo) || new Map(),
      proposals: (next && next.proposals) || new Map(),
      callbacks: (next && next.callbacks) || {},
    };
    renderTree();
  }

  // ---------- операции с файлами из дерева (этап D) ----------
  //
  // Как в обычном редакторе кода: правый клик на строке или на пустом месте дерева —
  // контекстное меню; имя вводится в поле прямо в дереве (Enter — подтвердить,
  // Esc или потеря фокуса — отмена). Сами операции выполняет main (fs:create /
  // fs:rename / fs:delete): диск пишет тот же fileops.applyChange, что и всегда,
  // поэтому файлы попадают в историю и откатываются, а удаление идёт через корзину.

  const parentOf = (rel) => {
    const i = String(rel || '').lastIndexOf('/');
    return i > 0 ? String(rel).slice(0, i) : '';
  };

  let ctxMenu = null;
  let nameInputBusy = false; // защита двойного Enter: подтверждение асинхронное

  function closeCtxMenu() {
    if (!ctxMenu) return;
    const m = ctxMenu;
    ctxMenu = null;
    m.close();
  }

  function openCtxMenu(x, y, item) {
    closeCtxMenu();
    const entries = menuEntriesFor(item);
    const el = h('div', {
      class: 'ed-ctxmenu', role: 'menu',
      style: `left:${Math.max(2, x)}px;top:${Math.max(2, y)}px`,
    }, entries.map((it) => (it.sep
      ? h('div', { class: 'ed-ctxmenu-sep' })
      : h('button', {
        type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '',
        onclick: () => { closeCtxMenu(); it.onclick(); },
      }, it.label))));
    // Меню живёт в body: дерево (#ed-tree) прокручивается и обрезало бы его.
    // В тестовом стенде body может не быть — тогда вешаем в само дерево.
    const host = (typeof document !== 'undefined' && document.body) || els.tree;
    if (!host || typeof host.append !== 'function') return;
    host.append(el);
    // Не вылезать за окно: корректируем позицию, когда меню заняло место
    if (typeof window !== 'undefined' && window.innerWidth) {
      const w = el.offsetWidth || 210;
      const hh = el.offsetHeight || entries.length * 26;
      if (x + w > window.innerWidth - 4) el.style.left = Math.max(4, window.innerWidth - w - 4) + 'px';
      if (y + hh > window.innerHeight - 4) el.style.top = Math.max(4, window.innerHeight - hh - 4) + 'px';
    }
    const onDown = (e) => { if (!el.contains || !el.contains(e.target)) closeCtxMenu(); };
    const onKey = (e) => { if (e.key === 'Escape') closeCtxMenu(); };
    const onScroll = () => closeCtxMenu();
    // Слушатели ставим на следующем тике: событие правого клика, открывшее меню,
    // не должно тут же его закрыть.
    const arm = () => {
      if (!ctxMenu) return; // меню уже закрыли
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('keydown', onKey, true);
      }
      if (els.tree && els.tree.addEventListener) els.tree.addEventListener('scroll', onScroll);
    };
    setTimeout(arm, 0);
    ctxMenu = {
      el,
      close: () => {
        if (typeof window !== 'undefined' && window.removeEventListener) {
          window.removeEventListener('pointerdown', onDown, true);
          window.removeEventListener('keydown', onKey, true);
        }
        if (els.tree && els.tree.removeEventListener) els.tree.removeEventListener('scroll', onScroll);
        if (el.remove) el.remove();
        else if (host.replaceChildren && host === els.tree) renderTree();
      },
    };
  }

  /** Пункты меню: item = null — пустое место дерева (операции в корне проекта). */
  function menuEntriesFor(item) {
    const parentRel = item ? (item.isDir ? item.rel : parentOf(item.rel)) : '';
    const entries = [
      { label: 'Новый файл', onclick: () => beginNameInput('create-file', parentRel) },
      { label: 'Новая папка', onclick: () => beginNameInput('create-dir', parentRel) },
    ];
    if (item) {
      entries.push({ sep: true });
      entries.push({ label: 'Переименовать…', onclick: () => beginNameInput('rename', parentOf(item.rel), item.rel) });
      entries.push({
        label: item.isDir ? 'Удалить папку' : 'Удалить файл', danger: true,
        onclick: () => deleteTreeItem(item),
      });
      entries.push({ sep: true });
      entries.push({
        label: 'Показать в проводнике',
        onclick: () => { const cb = extras.callbacks || {}; if (cb.onReveal) cb.onReveal(item.rel); },
      });
    }
    return entries;
  }

  /** Показать поле ввода имени в дереве (создание или переименование). */
  async function beginNameInput(mode, parentRel, rel) {
    if (!projectId) { toast('Сначала выберите проект', 'err'); return; }
    closeCtxMenu();
    if (parentRel) {
      tree.expanded.add(parentRel);
      await loadDir(parentRel);
    } else {
      await loadDir('');
    }
    tree.pending = {
      mode,
      parentRel: parentRel || '',
      rel: rel || null,
      name: rel ? String(rel).split('/').pop() : '',
    };
    renderTree();
    // Фокус — после перерисовки: поле уже в дереве
    setTimeout(() => {
      const inp = els.tree && els.tree.querySelector ? els.tree.querySelector('.ed-tree-input') : null;
      if (!inp || !inp.focus) return;
      inp.focus();
      // При переименовании выделяем имя без расширения — как в VS Code
      const dot = tree.pending && tree.pending.name ? tree.pending.name.lastIndexOf('.') : -1;
      if (dot > 0 && inp.setSelectionRange) { try { inp.setSelectionRange(0, dot); } catch { /* не критично */ } }
      else if (inp.select) inp.select();
    }, 0);
  }

  function nameInputRow(depth) {
    const pend = tree.pending;
    if (!pend) return h('span');
    const placeholder = pend.mode === 'create-dir' ? 'имя папки'
      : pend.mode === 'create-file' ? 'имя файла (можно с папкой: src/файл.txt)'
        : 'новое имя';
    const inp = h('input', {
      class: 'ed-tree-input', type: 'text', value: pend.name || '', placeholder,
      'aria-label': placeholder, spellcheck: 'false',
      onclick: (e) => e.stopPropagation(),
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitNameInput(inp.value); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelNameInput(); }
      },
      onblur: () => { if (tree.pending) cancelNameInput(); },
    });
    return h('div', { class: 'ed-node editing', style: `padding-left:${depth * 14 + 4}px` },
      h('span', { class: 'ed-twisty' }, ''), inp);
  }

  function cancelNameInput() {
    if (!tree.pending) return;
    tree.pending = null;
    renderTree();
  }

  /**
   * Подтверждение имени. Валидация пути полная — в main (resolveInProject), здесь
   * только очевидное: пустое имя, «..», ведущие/хвостовые косые. Для создания '/'
   * разрешён (создание сразу в подпапке), для переименования — нет (имя на месте).
   */
  async function commitNameInput(raw) {
    if (nameInputBusy || !tree.pending) return;
    const pend = tree.pending;
    const name = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    tree.pending = null; // до await: потеря фокуса во время операции уже не «отмена»
    if (!name || name.split('/').some((s) => !s || s === '.' || s === '..')) {
      renderTree();
      if (name) toast('Недопустимое имя: пустые сегменты и «..» запрещены', 'err');
      return;
    }
    nameInputBusy = true;
    try {
      if (pend.mode === 'rename') {
        if (name.includes('/')) { toast('Новое имя не может содержать путь — переименование происходит на месте', 'err'); renderTree(); return; }
        const parent = parentOf(pend.rel);
        const newRel = parent ? parent + '/' + name : name;
        if (newRel === pend.rel) { renderTree(); return; }
        const r = await call('fs:rename', { projectId, rel: pend.rel, newRel });
        if (r && r.ok) {
          await afterTreeRename(pend.rel, newRel, r.isDir === true);
          toast(`Переименовано: ${newRel}`, 'ok');
        } else if (r) {
          toast(r.error || 'Не удалось переименовать', 'err');
        }
      } else {
        const relNew = pend.parentRel ? pend.parentRel + '/' + name : name;
        const r = await call('fs:create', { projectId, rel: relNew, kind: pend.mode === 'create-dir' ? 'dir' : 'file' });
        if (r && r.ok) {
          if (r.isDir) {
            tree.expanded.add(relNew);
            toast(`Папка создана: ${relNew}`, 'ok');
          } else {
            // Новый файл сразу открываем: как в VS Code, курсор готов к набору кода
            await openPath(relNew);
            toast(`Файл создан: ${relNew}`, 'ok');
          }
        } else if (r) {
          toast(r.error || 'Не удалось создать', 'err');
        }
      }
    } finally {
      nameInputBusy = false;
      await refreshTree();
    }
  }

  /**
   * После переименования: открытые вкладки и раскрытые папки переезжают на новый путь.
   * Буферы сохраняются — содержимое файла не изменилось, dirty-состояние остаётся честным
   * (ES.renamePath), а модель Monaco пересоздаётся под новым URI.
   */
  async function afterTreeRename(oldRel, newRel, isDir) {
    if (!isDir) {
      await retargetOpenFile(oldRel, newRel);
      return;
    }
    const prefix = oldRel + '/';
    const newPrefix = newRel + '/';
    for (const f of ES.list(state)) {
      if (f.path.startsWith(prefix)) {
        // eslint-disable-next-line no-await-in-loop — вкладок единицы, порядок не важен
        await retargetOpenFile(f.path, newPrefix + f.path.slice(prefix.length));
      }
    }
    for (const rel of [...tree.expanded]) {
      if (rel === oldRel) { tree.expanded.delete(rel); tree.expanded.add(newRel); }
      else if (rel.startsWith(prefix)) { tree.expanded.delete(rel); tree.expanded.add(newPrefix + rel.slice(prefix.length)); }
    }
  }

  async function retargetOpenFile(oldRel, newRel) {
    const f = ES.get(state, oldRel);
    if (!f) return;
    const text = f.text;
    const language = f.language;
    const vs = f.viewState;
    const wasActive = state.active === oldRel;
    const oldModel = models.get(oldRel);
    const attached = !!(editor && oldModel && editor.getModel() === oldModel);
    if (!ES.renamePath(state, oldRel, newRel)) { renderAll(); return; }
    if (oldModel) {
      models.delete(oldRel);
      const nf = ES.get(state, newRel);
      const nm = monaco.editor.createModel(text, language, uriFor(nf));
      models.set(newRel, nm);
      if (attached) {
        editor.setModel(nm);
        if (vs) { try { editor.restoreViewState(vs); } catch { /* не критично */ } }
      }
      oldModel.dispose();
    } else if (wasActive) {
      await showInEditor(newRel);
    }
    renderTabs();
    renderStatus();
  }

  /** Удаление: подтверждение → main (корзина + история) → закрытие вкладок. */
  async function deleteTreeItem(item) {
    if (!projectId) return;
    closeCtxMenu();
    const what = item.isDir
      ? `папку «${item.name}» со всем содержимым`
      : `файл «${item.name}»`;
    const note = item.isDir
      ? 'Папка будет перемещена в системную корзину целиком.'
      : 'Файл будет перемещён в системную корзину; операцию можно откатить из «Истории».';
    if (typeof window !== 'undefined' && window.confirm && !window.confirm(`Удалить ${what}?\n\n${note}`)) return;
    const r = await call('fs:delete', { projectId, rel: item.rel });
    if (!r) return;
    if (!r.ok) { toast(r.error || 'Не удалось удалить', 'err'); return; }
    // Файла больше нет — вкладки закрываем без вопроса: сохранять некуда
    if (!item.isDir) {
      await closePath(item.rel, { force: true });
    } else {
      const prefix = item.rel + '/';
      for (const f of ES.list(state).filter((x) => x.path.startsWith(prefix))) {
        // eslint-disable-next-line no-await-in-loop — порядок не важен, вкладок единицы
        await closePath(f.path, { force: true });
      }
      for (const rel of [...tree.expanded]) {
        if (rel === item.rel || rel.startsWith(prefix)) tree.expanded.delete(rel);
      }
    }
    toast(`Удалено: ${item.rel}`, 'ok');
    await refreshTree();
  }

  // ---------- diff-host: постоянный экземпляр DiffEditor (этап C, §19) ----------
  // Тот же принцип, что и с основным редактором (§7): экземпляр создаётся один раз и
  // переживает перерисовки, при смене просмотра подменяются только модели. Модели —
  // расходный материал: старые dispose'ятся, иначе они текут в хранилище Monaco.
  let diffEditor = null;
  let diffModels = null; // {orig, mod}

  /**
   * Показать две версии текста в #diff-host.
   * @returns {Promise<boolean>} true — Monaco принял дифф; false — caller показывает
   * текстовый фолбэк (app.js переключает просмотр в режим текстового отчёта).
   */
  async function showDiff(opts) {
    if (!els || !els.diffEditor || !opts) return false;
    try {
      // Только инициализация Monaco, БЕЗ ensureMonaco(): основной редактор создавать
      // рано — панель может быть в режиме просмотра, а Monaco в скрытом контейнере
      // нулевого размера — плохая примета (проверено spike).
      if (!monaco) monaco = await window.WhaleMonaco.init();
      if (!diffEditor) {
        diffEditor = monaco.editor.createDiffEditor(els.diffEditor, {
          theme: 'vs-dark', readOnly: true,
          renderSideBySide: true, useInlineViewWhenSpaceIsLimited: true,
          automaticLayout: true, minimap: { enabled: false },
          scrollBeyondLastLine: false, diffWordWrap: 'on',
          // Пробелы значимы: для кода «изменился отступ» — содержательное изменение
          ignoreTrimWhitespace: false,
        });
      }
      // Порядок: сначала отцепить старые модели, потом удалять — dispose прикреплённой
      // модели оставил бы DiffEditor в подвешенном состоянии.
      if (diffEditor.getModel()) diffEditor.setModel(null);
      if (diffModels) { diffModels.orig.dispose(); diffModels.mod.dispose(); diffModels = null; }
      const language = opts.language || 'plaintext';
      const orig = monaco.editor.createModel(typeof opts.original === 'string' ? opts.original : '', language);
      const mod = monaco.editor.createModel(typeof opts.modified === 'string' ? opts.modified : '', language);
      diffEditor.setModel({ original: orig, modified: mod });
      diffModels = { orig, mod };
      // Панель могла быть только что показана: пересчитываем раскладку на следующем кадре
      // и ещё раз с задержкой (урок showConflictDiff — иначе половина диффа за границей).
      const relayout = () => { if (diffEditor) { try { diffEditor.layout(); } catch { /* уже закрыт */ } } };
      requestAnimationFrame(relayout);
      setTimeout(relayout, 80);
      return true;
    } catch (e) {
      console.error('[editor:diff]', e);
      if (diffModels) {
        try { diffModels.orig.dispose(); diffModels.mod.dispose(); } catch { /* уже удалены */ }
        diffModels = null;
      }
      return false;
    }
  }

  /** Убрать содержимое диффа (модели освободить), экземпляр оставить до следующего просмотра. */
  function hideDiff() {
    // Порядок важен: сначала отцепить модели от редактора, потом удалять —
    // dispose прикреплённой модели оставляет DiffEditor в подвешенном состоянии.
    if (diffEditor) { try { diffEditor.setModel(null); } catch { /* ignore */ } }
    if (diffModels) {
      try { diffModels.orig.dispose(); diffModels.mod.dispose(); } catch { /* уже удалены */ }
      diffModels = null;
    }
  }

  // ---------- принятие предложения модели в буфер (этап C, §20–§21) ----------

  /** Текущий текст буфера, если файл открыт; иначе null (caller читает диск сам). */
  function getText(rel) {
    const f = ES.get(state, rel);
    return f ? f.text : null;
  }

  /**
   * Положить текст (результат слияния выбранных ханков) в буфер файла. Файл
   * открывается, если ещё не открыт; панель переключается в режим редактора —
   * принятое надо видеть. Правка идёт через executeEdits, когда модель активна:
   * стек undo сохраняется, и Ctrl+Z отменяет принятие, а не всю сессию.
   *
   * @returns {Promise<boolean>} true — буфер обновлён и помечен dirty
   */
  async function acceptIntoBuffer(projectIdArg, rel, text, aiInfo) {
    if (typeof text !== 'string') return false;
    let f = ES.get(state, rel);
    if (!f) {
      const opened = await openPath(rel, projectIdArg); // внутри — onWantEditorMode
      if (!opened) return false;
      f = ES.get(state, rel);
      if (!f) return false;
    } else {
      onWantEditorMode();
      await activate(rel);
    }
    const m = models.get(rel);
    if (m) {
      if (editor && editor.getModel() === m) {
        editor.pushUndoStop();
        editor.executeEdits('whale-accept', [{ range: m.getFullModelRange(), text, forceMoveMarkers: true }]);
        editor.pushUndoStop();
      } else if (m.getValue() !== text) {
        m.setValue(text);
      }
    }
    ES.setText(state, rel, m ? m.getValue() : text);
    ES.setPendingAi(state, rel, aiInfo || null);
    renderAll();
    onDirtyChange();
    return true;
  }

  /**
   * Какие предложения сейчас приняты в буферы и не сохранены: proposalId → сведения.
   * app.js рисует по ним бейдж «в буфере редактора» на карточках и восстанавливает
   * выбор ханков при повторном открытии диффа.
   */
  function stagedProposals() {
    const out = new Map();
    for (const f of ES.list(state)) {
      for (const info of ES.getPendingAi(state, f.path)) out.set(info.proposalId, { path: f.path, ...info });
    }
    return out;
  }

  /** Явный пересчёт размеров Monaco — страховка после разделителей и смены режимов панели. */
  function layoutEditors() {
    if (editor) { try { editor.layout(); } catch { /* редактор ещё не поднят */ } }
    if (diffEditor) { try { diffEditor.layout(); } catch { /* уже закрыт */ } }
  }

  // ---------- вкладки и статус ----------

  function renderTabs() {
    if (!els) return;
    const files = ES.list(state);
    els.tabs.replaceChildren(...files.map((f) => {
      const d = ES.describe(state, f.path);
      return h('div', {
        class: 'ed-tab' + (state.active === f.path ? ' on' : '') + (d.dirty ? ' dirty' : ''),
        title: f.path + (d.diskDrift ? ' · изменён вне редактора' : ''),
        onclick: () => activate(f.path),
      },
      h('span', {}, f.name),
      d.diskDrift && h('span', { class: 'ed-mark drift', title: 'Файл изменён вне редактора' }, '⚠'),
      d.modelDiverged && h('span', { class: 'ed-mark ctx', title: 'Модель в чате не знает текущую версию файла' }, '◆'),
      d.dirty && h('span', { class: 'ed-mark dirty', title: 'Несохранённые изменения' }, '●'),
      h('button', {
        class: 'ed-tab-close', title: 'Закрыть вкладку (Ctrl+W)', 'aria-label': `Закрыть ${f.name}`,
        onclick: (e) => { e.stopPropagation(); closePath(f.path); },
      }, '×'));
    }), ...tabsExtras);
  }

  /** app.js передаёт узлы, которые живут в строке вкладок справа (кнопка «▶ Запустить»). */
  function setTabsExtras(nodes) {
    tabsExtras = Array.isArray(nodes) ? nodes : [];
    renderTabs();
  }

  function renderStatus() {
    if (!els) return;
    const f = ES.active(state);
    if (!f) { els.status.replaceChildren(h('span', { class: 'path' }, 'Файл не открыт')); return; }
    const d = ES.describe(state, f.path);
    const badge = d.missing
      ? h('span', { class: 'badge bad', title: 'Файл удалён или недоступен — сохранение невозможно' }, 'файл недоступен')
      : d.diskDrift
      ? h('span', { class: 'badge bad', title: 'Файл изменён вне редактора — при сохранении будет предложено разрешить конфликт' }, 'изменён на диске')
      : d.dirty
        ? h('span', { class: 'badge warn' }, 'не сохранено')
        : h('span', { class: 'badge' }, 'сохранено');
    els.status.replaceChildren(
      h('span', { class: 'path grow', title: f.path }, f.path),
      h('span', {}, `${f.language}`),
      h('span', {}, `стр ${cursorInfo.ln}, кол ${cursorInfo.col}`),
      h('span', {}, f.eol === 'crlf' ? 'CRLF' : 'LF'),
      f.hasBom && h('span', {}, 'BOM'),
      badge,
      d.pendingAi && d.pendingAi.length > 0 && h('span', {
        class: 'badge', style: 'border-color: var(--accent); color: var(--accent)',
        title: 'Изменения из предложения модели приняты в буфер и ещё не сохранены на диск',
      }, `принято от модели: ${d.pendingAi.length}`),
      d.modelDiverged && h('span', {
        class: 'badge bad',
        title: 'Модель в чате видела другую версию этого файла и может предлагать правки от устаревшего кода',
      }, 'модель не знает'),
      d.modelDiverged && h('button', {
        class: 'btn tiny', onclick: ackCurrent,
        title: 'Отметить, что модель проинформирована о текущей версии файла',
      }, '✓ Модель знает'),
      h('button', { class: 'btn tiny', onclick: () => saveActive(), title: 'Сохранить (Ctrl+S)' }, 'Сохранить'));
  }

  function renderAll() {
    renderTabs();
    renderStatus();
    renderTree();
    if (!state.active && els) showEmpty();
  }

  // ---------- внешние события ----------

  /** Какую версию открытых файлов знает модель в текущем чате. */
  async function syncKnown(paths) {
    if (!projectId || !paths || !paths.length) return;
    const map = await call('context:known', { projectId, paths });
    if (!map) return;
    ES.setKnownMap(state, map);
  }

  /** Пользователь подтвердил, что модель проинформирована о текущей версии файла. */
  async function ackCurrent() {
    const f = ES.active(state);
    if (!f) return;
    const r = await call('context:ack', { projectId: f.projectId, relPath: f.path });
    if (!r) return;
    if (!r.ok) { toast(r.error, 'err'); return; }
    ES.setKnown(state, f.path, r.hash, 'ack');
    renderAll();
    toast('Отмечено: модель знает текущую версию файла', 'ok');
  }

  /**
   * files:changed / focus: что сейчас на диске. Только для файлов текущего проекта.
   *
   * Чистый буфер при внешнем изменении перечитывается сразу — иначе редактор показывает
   * устаревшее содержимое, dirty остаётся false, и Ctrl+S отвечает «изменений нет»:
   * файл оказывается заблокированным, хотя на диске он другой. Грязный буфер не трогаем —
   * это уже конфликт (§11), его разрешает пользователь.
   */
  async function refreshDisk() {
    const files = ES.list(state).filter((f) => f.projectId === projectId);
    if (!projectId || !files.length) return;
    const map = await call('file:hashes', { projectId, paths: files.map((f) => f.path) });
    if (!map) return;
    const beforeDrift = new Set(ES.driftedPaths(state));
    ES.setDiskHashes(state, map);
    await syncKnown(files.map((f) => f.path));

    const reloaded = [];
    const goneMissing = [];
    const conflicts = [];
    for (const f of ES.list(state)) {
      if (f.projectId !== projectId) continue;
      if (ES.isMissing(f)) {
        if (!beforeDrift.has(f.path)) goneMissing.push(f.name);
        continue;
      }
      if (ES.needsReload(f)) {
        // eslint-disable-next-line no-await-in-loop — порядок важен, файлов обычно единицы
        if (await reloadSilently(f.path)) reloaded.push(f.name);
      } else if (ES.isDrifted(f) && ES.isDirty(f) && !beforeDrift.has(f.path)) {
        conflicts.push(f.name);
      }
    }

    renderTabs();
    renderStatus();
    clearTimeout(marksTimer);
    marksTimer = setTimeout(renderTree, 120);

    if (reloaded.length) {
      toast(reloaded.length === 1
        ? `Файл обновлён с диска: ${reloaded[0]}`
        : `Обновлено с диска: ${reloaded.length} файла(ов)`, 'ok');
    }
    if (goneMissing.length) toast(`Файл удалён или недоступен: ${goneMissing.join(', ')}`, 'err');
    if (conflicts.length) {
      toast(`Изменён вне редактора: ${conflicts.join(', ')}. При сохранении потребуется разрешить конфликт.`, 'err');
    }
    onDirtyChange();
  }

  function setProject(project) {
    projectId = project ? project.id : null;
    tree.dirs.clear();
    tree.expanded.clear();
    tree.pending = null; // поле ввода имени от прошлого проекта не переносится
    closeCtxMenu();
    if (projectId) loadDir('').then(renderTree, renderTree);
    else renderTree();
    renderAll();
  }

  /** Monaco не поднялся — показываем причину в самой панели, а не только в консоли. */
  function showFatal(e) {
    if (!els) return;
    els.host.classList.add('hidden');
    els.empty.replaceChildren(
      h('div', {}, 'Редактор не запустился.'),
      h('div', { class: 'path' }, String((e && e.message) || e)),
      h('div', { class: 'path' }, 'Проверьте, что monaco-editor установлен (npm install) и доступен путь из main.js.'));
    els.empty.classList.remove('hidden');
  }

  async function setVisible(v) {
    const wasVisible = visible;
    visible = !!v;
    if (!visible || !els) return;
    try {
      if (!els.tree.childElementCount) renderTree();
      if (projectId && !tree.dirs.has('')) { await loadDir(''); renderTree(); }
      // При уже показанной вкладке не трогаем редактор: render() вызывается на каждое
      // внешнее событие, и лишний focus()/layout() сбивал бы работу с файлом.
      if (state.active) {
        if (!wasVisible || !editor || editor.getModel() !== models.get(state.active)) await showInEditor(state.active);
      } else {
        showEmpty();
      }
      if (editor) editor.layout();
      renderAll();
      refreshDisk();
    } catch (e) {
      console.error('[editor]', e);
      showFatal(e);
    }
  }

  // ---------- горячие клавиши (§25) ----------

  function handleKey(e) {
    if (!visible) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return false;
    if (e.shiftKey) return false; // Ctrl+Shift+S (Save As) намеренно не реализуем
    switch (e.code) {
      case 'KeyS': e.preventDefault(); saveActive(); return true;
      case 'KeyW': e.preventDefault(); closeActive(); return true;
      case 'KeyP': e.preventDefault(); showQuickOpen(); return true;
      case 'Tab': e.preventDefault(); nextTab(1); return true;
      default: return false;
    }
  }

  function installKeys() {
    window.addEventListener('keydown', (e) => {
      if (overlayClose && e.key === 'Escape') { e.preventDefault(); closeOverlay(); return; }
      handleKey(e);
    });
    // Ctrl+Tab браузер шлёт не всегда, поэтому дублируем циклом по Alt+стрелкам
    window.addEventListener('keydown', (e) => {
      if (!visible || !e.altKey) return;
      if (e.code === 'ArrowRight') { e.preventDefault(); nextTab(1); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); nextTab(-1); }
    });
    window.addEventListener('beforeunload', (e) => {
      if (!ES.hasUnsaved(state)) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  // ---------- публичный API ----------

  const REQUIRED = ['tree', 'tabs', 'host', 'empty', 'status', 'overlay'];

  function mount(elements, hooks) {
    const missing = REQUIRED.filter((k) => !elements || !elements[k]);
    if (missing.length) {
      console.error('[editor] не найдены узлы разметки: ' + missing.join(', '));
      return;
    }
    els = elements;
    // els.diffEditor/els.diffBar необязательны: на старой разметке (или в тестовом стенде)
    // их может не быть — showDiff тогда честно вернёт false, и caller покажет фолбэк.
    toast = (hooks && hooks.toast) || (() => {});
    onDirtyChange = (hooks && hooks.onDirtyChange) || (() => {});
    onWantEditorMode = (hooks && hooks.onWantEditorMode) || (() => {});
    // Правый клик на пустом месте дерева — операции в корне проекта (этап D).
    // Строки дерева обрабатывают правый клик сами; сюда событие приходит всплытием,
    // поэтому проверяем, что цель — само дерево или его пустая заглушка.
    if (els.tree && els.tree.addEventListener) {
      els.tree.addEventListener('contextmenu', (e) => {
        const t = e.target;
        const blank = t === els.tree
          || (t && t.classList && (t.classList.contains('ed-tree-empty') || t.classList.contains('ed-tree-err')));
        if (!blank) return;
        if (e.preventDefault) e.preventDefault();
        openCtxMenu(e.clientX || 0, e.clientY || 0, null);
      });
    }
    installKeys();
    renderAll();
    showEmpty();
  }

  window.WhaleEditor = {
    mount, setProject, setVisible, openPath, activate, closePath, closeActive,
    nextTab, saveActive, saveAllDirty, activeFile, showQuickOpen, refreshDisk, handleKey, ackCurrent,
    setTreeExtras, setTabsExtras, refreshTree, layout: layoutEditors, showDiff, hideDiff,
    getText, acceptIntoBuffer, stagedProposals,
    hasUnsaved: () => ES.hasUnsaved(state),
    dirtyPaths: () => ES.dirtyPaths(state),
    isVisible: () => visible,
    // для отладки и тестов: доступ к чистому состоянию и операциям дерева (этап D)
    _state: () => state,
    _tree: tree,
    _treeOps: { beginNameInput, commitNameInput, cancelNameInput, deleteTreeItem, openCtxMenu, closeCtxMenu, menuEntriesFor },
  };
})();

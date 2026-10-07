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
  const tree = { dirs: new Map(), expanded: new Set() };
  // «Внешние» данные дерева (этап B): их передаёт app.js из журналов — расхождения
  // контекста, последние откатимые операции, предложения модели + колбэки кнопок.
  // Правила соединения с состоянием редактора — чистая ES.treeRowMarks (тестируется в Node).
  let extras = { manual: new Set(), undo: new Map(), proposals: new Map(), callbacks: {} };
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
    if (dir.error) { out.push(h('div', { class: 'ed-tree-err', style: `padding-left:${depth * 14 + 4}px` }, dir.error)); return; }
    for (const it of dir.items || []) {
      const open = tree.expanded.has(it.rel);
      const cb = extras.callbacks || {};
      // Отметки файла считаем одной чистой функцией: состояние буфера + журналы app.js
      const m = it.isDir ? null : ES.treeRowMarks(state, it.rel, extras);
      out.push(h('div', {
        class: 'ed-node' + (state.active === it.rel ? ' on' : '')
          + (m && m.dirty ? ' dirty' : '') + (m && m.drift ? ' drift' : '')
          + (m && m.diverged ? ' diverged' : '') + (m && m.proposal ? ' has-proposal' : ''),
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
      undo: (next && next.undo) || new Map(),
      proposals: (next && next.proposals) || new Map(),
      callbacks: (next && next.callbacks) || {},
    };
    renderTree();
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
    }));
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
    installKeys();
    renderAll();
    showEmpty();
  }

  window.WhaleEditor = {
    mount, setProject, setVisible, openPath, activate, closePath, closeActive,
    nextTab, saveActive, showQuickOpen, refreshDisk, handleKey, ackCurrent,
    setTreeExtras, refreshTree, layout: layoutEditors, showDiff, hideDiff,
    getText, acceptIntoBuffer, stagedProposals,
    hasUnsaved: () => ES.hasUnsaved(state),
    dirtyPaths: () => ES.dirtyPaths(state),
    isVisible: () => visible,
    // для отладки и тестов: доступ к чистому состоянию
    _state: () => state,
  };
})();

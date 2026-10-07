(() => {
  'use strict';
  const api = window.api;

  // ---------- утилиты (только textContent, никакого innerHTML с чужими данными) ----------
  // h() один на весь renderer — см. ui/dom.js. Здесь только алиас, чтобы не переписывать
  // сотни вызовов; семантика прежняя, плюс разворачиваются вложенные массивы любой глубины
  // (так и работает настоящий ParentNode.append()).
  const h = window.WhaleDom.h;
  // Математика раскладки (ui/layout.js, UMD): правила одни для renderer и main —
  // clamp, минимумы и сторону чата тесты проверяют как чистые функции.
  const L = window.WhaleLayout;
  const $ = (s) => document.querySelector(s);
  const base = (p) => p.split('/').pop();
  const fmtBytes = (n) => (n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(1) + ' КБ' : (n / 1048576).toFixed(1) + ' МБ');
  const uid = () => 'u' + Math.random().toString(36).slice(2, 10);
  const fmtTime = (ts) => new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

  let toastTimer;
  let panelInit = false; // первый state:get переносит сохранённый «Промпт» в режим панели
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), kind === 'err' ? 6000 : 3000);
  }
  async function call(channel, arg) {
    try {
      return await api.invoke(channel, arg);
    } catch (e) {
      toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
      return null;
    }
  }

  const COPY_TITLE = 'Скопировать в буфер то, что изменилось в этих файлах с тех пор, как модель видела их последней: '
    + 'unified diff, а если точная версия не сохранилась или файл крошечный — файл целиком. '
    + 'Отметки при этом НЕ снимаются: скопировать в буфер не значит отправить в чат.';
  const COPY_REMINDER_TITLE = 'Скопировать короткую памятку о маркерах, Diff и формате кода — чтобы вставить её в чат';

  /** Памятка о формате нужна и вне конструктора промптов, поэтому кнопка живёт в шапке. */
  async function copyFormatReminder() {
    const r = await call('prompt:copy-reminder');
    if (!r) return;
    toast(r.ok ? 'Памятка по формату скопирована. Вставьте её в чат.' : 'Не удалось скопировать памятку.', r.ok ? 'ok' : 'err');
  }

  const STATE_LABEL = {
    update: 'Обновление', create: 'Создание', delete: 'Удаление', move: 'Перемещение', identical: 'Без изменений', missing: 'Файл не найден',
    exists: 'Файл уже существует', 'invalid-path': 'Небезопасный путь', 'no-project': 'Нет проекта',
    unreadable: 'Не прочитать', applied: 'Применено', rejected: 'Отклонено',
    'patch-failed': 'Правка не применяется', 'patch-open': 'Блок не закрыт',
  };
  const STATE_BAD = new Set(['missing', 'exists', 'invalid-path', 'unreadable', 'no-project', 'patch-failed', 'patch-open']);

  // ---------- состояние ----------
  const S = {
    projects: [], chatId: null, project: null, pendingProjectId: null, lastProjectId: null,
    proposals: [], showHistorical: false,
    view: null, // {kind:'proposal'|'history'|'manual'|'merge', data} — показывается вместо редактора
    // Режим центральной панели: 'editor' | 'prompt' | 'view'. Все три занимают одно место
    // и взаимоисключающие. Кнопка «Промпт» запоминает, откуда пользователь пришёл
    // (panelBeforePrompt), и возвращает туда же: редактор или просмотр — явное требование.
    panel: 'editor',
    panelBeforePrompt: 'editor',
    viewPane: 'diff',    // внутри режима view: Monaco-дифф или 'details' — текстовый отчёт
    diffBase: 'current', // что слева в диффе предложения: 'current' (ваш файл) | 'ai' (версия модели)
    // Ханки текущего предложения (этап C): считаются src/hunks.js от базы модели,
    // hunkBase хранит, от каких текстов они построены, — пересчёт только при смене.
    hunks: null, hunkBase: null, hunkSel: null,
    history: [], showFull: false, allowIncomplete: false,
    backup: { files: 0, bytes: 0 },
    context: { items: [], checked: 0, truncated: false }, // расхождения с тем, что знает модель
    // Раскладка (ТЗ §5): ширины панелей, открытая вкладка левой панели и режим редактора.
    // Состояние UI, main его только хранит (layout:save) — геометрию чата задаёт #chat-slot (§4).
    layout: { ...L.DEFAULTS },
    prompt: {
      loaded: false, loading: false, sections: [], presets: [], excluded: new Set(), defaults: {}, tree: null,
      treeOpen: new Set(['']), preview: false, presetId: '', presetName: '',
    },
  };
  const P = S.prompt;

  // ---------- загрузка данных ----------
  async function loadState() {
    const st = await call('state:get');
    if (!st) return;
    const projectChanged = (S.project && S.project.id) !== (st.project && st.project.id);
    const chatChanged = S.chatId !== st.chatId;
    Object.assign(S, { projects: st.projects, chatId: st.chatId, project: st.project, pendingProjectId: st.pendingProjectId, lastProjectId: st.lastProjectId });
    // Сохранённые размеры панелей (config.json) → CSS-переменные, вкладка левой панели
    // и режим редактора. sanitize защищает и от мусора в конфиге, и от окна, ставшего
    // уже минимумов, и мигрирует прежние схемы раскладки (см. ui/layout.js).
    S.layout = L.sanitize(st.layout, window.innerWidth);
    applyLayout();
    if (!panelInit) { // только первый запуск: дальше режимом владеют действия пользователя
      panelInit = true;
      if (S.layout.promptOpen) { S.panel = 'prompt'; renderPromptPanel(); }
    }
    if (projectChanged) {
      P.loaded = false;
      // Открытые файлы не закрываем: у каждого свой projectId, сохранение идёт в свой проект.
      if (window.WhaleEditor) window.WhaleEditor.setProject(S.project);
    }
    if (chatChanged) { S.view = null; S.allowIncomplete = false; }
    await loadProposals();
    if (projectChanged && S.layout.promptOpen) { // дерево и исключения принадлежат проекту
      await loadPrompt();
      renderPromptPanel();
    } else if (S.layout.promptOpen && !P.loaded && !P.loading) {
      // «Промпт» открыт с прошлого запуска: показать «Загрузка…» и запустить загрузку
      renderPromptPanel();
    }
  }

  /** CSS-переменные раскладки. Единственное место, где они ставятся. */
  function applyLayout() {
    const vars = L.cssVars(S.layout);
    for (const k of Object.keys(vars)) document.documentElement.style.setProperty(k, vars[k]);
  }

  async function closeView() {
    S.view = null;
    // Панель возвращается туда, где была до просмотра: «Промпт», если он открыт,
    // иначе редактор. renderEditorArea() делает то же как страховку.
    if (S.panel === 'view') S.panel = S.layout.promptOpen ? 'prompt' : 'editor';
    if (S.layout.leftTab === 'history') await loadHistory();
    await loadProposals();
  }

  async function loadProposals() {
    S.proposals = (await call('proposals:list', { includeHistorical: S.showHistorical })) || [];
    await loadHistory();
    // Форма «Промпта» живёт в своей панели и здесь не пересобирается — фокус в полях не теряется
    render();
  }

  // ---------- шапка и вкладки ----------
  function renderHead() {
    const head = $('#head');
    head.replaceChildren();
    head.append(
      h('div', { class: 'chat-line' },
        S.chatId
          ? ['Чат', h('b', {}, S.chatId.slice(0, 8) + '…')]
          : 'Новый чат — идентификатор появится после первого сообщения'),
    );

    const selectedProjectId = S.project?.id || S.pendingProjectId || '';
    const sel = h('select', { 'aria-label': 'Проект этого чата', onchange: onBind },
      h('option', { value: '' }, '— проект не привязан —'),
      S.projects.map((p) => h('option', { value: p.id, selected: selectedProjectId === p.id }, `${p.name}  (${p.path})`)));
    head.append(
      h('div', { class: 'proj-row' },
        sel,
        h('button', { class: 'btn', title: 'Добавить папку проекта', onclick: onAddProject }, 'Добавить папку'),
        S.project && h('button', { class: 'btn ghost danger', title: 'Убрать проект из списка (файлы не удаляются)', onclick: onRemoveProject }, 'Убрать')),
      h('span', { class: 'grow' }),
      // Переключатель режима центральной панели: «Промпт» занимает место редактора.
      // Подпись кнопки — то, что будет показано по клику: из «Промпта» она возвращает
      // в прежнее окно (просмотр предложения/истории или редактор).
      h('button', {
        class: 'btn mode' + (S.panel === 'prompt' ? ' on' : ''), type: 'button',
        title: S.panel === 'prompt'
          ? (S.view ? 'Вернуться к просмотру' : 'Вернуться к редактору кода')
          : 'Открыть конструктор промптов вместо редактора кода',
        onclick: () => (S.panel === 'prompt' ? leavePrompt() : openPrompt()),
      }, S.panel === 'prompt' ? (S.view ? '← Просмотр' : 'Редактор кода') : 'Промпт'),
      // Памятка о маркерах и формате кода нужна в любой момент, а не только внутри
      // конструктора промптов — поэтому живёт в шапке.
      h('button', {
        class: 'btn', type: 'button',
        title: COPY_REMINDER_TITLE,
        onclick: copyFormatReminder,
      }, '⧗ Напомнить формат'),
    );
    const pending = S.projects.find((p) => p.id === S.pendingProjectId);
    if (!S.chatId && pending) head.append(h('div', { class: 'hint' }, `Выбран «${pending.name}». Он будет автоматически привязан после первого сообщения.`));
    const last = S.projects.find((p) => p.id === S.lastProjectId);
    if (S.chatId && !S.project && last) {
      head.append(
        h('div', { class: 'hint' },
          h('span', {}, `Для этого чата проект не выбран. Последний использованный: ${last.name}`),
          h('button', { class: 'btn', onclick: () => bind(last.id) }, 'Привязать')));
    }
  }

  async function bind(projectId) {
    if (!S.chatId) {
      await call('project:pending', { projectId: projectId || null });
      S.pendingProjectId = projectId || null;
      renderHead();
      return;
    }
    await call('project:bind', { chatId: S.chatId, projectId: projectId || null });
    await loadState();
  }
  const onBind = (e) => bind(e.target.value);
  async function onAddProject() {
    const p = await call('project:add');
    if (p && S.chatId) await bind(p.id);
    else await loadState();
  }
  async function onRemoveProject() {
    if (!S.project || !confirm(`Убрать проект «${S.project.name}» из списка?\nФайлы на диске не изменятся, привязки чатов к нему удалятся.`)) return;
    await call('project:remove', { id: S.project.id });
    await loadState();
  }

  /**
   * Вкладки левой панели: Файлы / Предложения / История — одна колонка, три режима.
   *
   * Счётчик нерассмотренных предложений дублируется на вкладке «Файлы» намеренно:
   * пользователь обычно смотрит в дерево, и предупреждение «тебя ждут предложения»
   * обязано быть видно без перехода на другую вкладку.
   */
  function renderTabs() {
    const pending = S.proposals.filter((p) => p.status === 'pending' && !p.historical).length;
    const tabs = [['files', 'Файлы'], ['proposals', 'Предложения'], ['history', 'История']];
    $('#left-tabs').replaceChildren(
      ...tabs.map(([id, label]) => {
        const withCount = (id === 'proposals' || (id === 'files' && pending > 0)) && pending > 0;
        return h('button', {
          class: 'tab' + (S.layout.leftTab === id ? ' on' : ''),
          title: id === 'files' && pending > 0 ? `Нерассмотренных предложений: ${pending}` : null,
          onclick: () => switchTab(id),
        },
        label,
        withCount && h('span', { class: 'count' + (id === 'files' ? ' alert' : '') }, pending));
      }));
  }

  async function switchTab(id) {
    if (!L.LEFT_TABS.includes(id)) return;
    S.layout = { ...S.layout, leftTab: id };
    if (id === 'history') await loadHistory();
    render();
    await call('layout:save', { layout: S.layout });
  }

  /**
   * «Промпт» занимает центральную панель вместо редактора. Кнопка работает как
   * переключатель и помнит, откуда пользователь пришёл: закрытие возвращает в прежнее
   * окно — редактор или просмотр предложения (явное требование к раскладке).
   * Просмотр, открытый поверх «Промпта», сам возвращает в него после «← К списку»:
   * promptOpen остаётся включённым, пока пользователь не закроет промпт явно (✕ или кнопка).
   */
  async function openPrompt() {
    if (S.panel === 'prompt') return;
    S.panelBeforePrompt = S.panel === 'view' && S.view ? 'view' : 'editor';
    S.panel = 'prompt';
    S.layout = { ...S.layout, promptOpen: true };
    if (!P.loaded && !P.loading) {
      P.loading = true;
      loadPrompt().finally(() => { P.loading = false; renderPromptPanel(); });
    }
    renderPromptPanel();
    render();
    await call('layout:save', { layout: S.layout });
  }

  /**
   * Кнопка в шапке — временный уход из «Промпта» в прежнее окно (редактор или просмотр).
   * Если уходим в просмотр, «Промпт» остаётся открытым под ним: закроете просмотр —
   * форма вернётся, набранный текст на месте.
   */
  async function leavePrompt() {
    if (S.panel !== 'prompt') return;
    const back = S.panelBeforePrompt === 'view' && S.view ? 'view' : 'editor';
    S.panel = back;
    if (back === 'editor') {
      S.layout = { ...S.layout, promptOpen: false };
      render();
      await call('layout:save', { layout: S.layout });
      return;
    }
    render(); // promptOpen остаётся true — «Промпт» спрятан под просмотром
  }

  /** Крестик ✕ в панели «Промпт» — закрыть совсем (в отличие от переключателя в шапке). */
  async function closePrompt() {
    S.layout = { ...S.layout, promptOpen: false };
    if (S.panel === 'prompt') S.panel = S.view ? 'view' : 'editor';
    render();
    await call('layout:save', { layout: S.layout });
  }

  // ---------- вкладка «Предложения» ----------
  function renderProposals() {
    const box = h('div', { class: 'stack' });
    box.append(
      h('div', { class: 'toolbar' },
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: S.showHistorical, onchange: (e) => { S.showHistorical = e.target.checked; loadProposals(); } }),
          'Показывать код из истории чата'),
        h('span', { class: 'grow' }),
        S.proposals.length > 0 && h('button', { class: 'btn', title: 'Убрать все карточки из списка (файлы не меняются)', onclick: onDismissAll }, 'Очистить список'),
        h('button', { class: 'btn', title: 'Если код не подхватился автоматически: скопируйте ответ ИИ и нажмите', onclick: onClipboard }, 'Взять из буфера'),
        h('button', { class: 'btn', onclick: async () => { const r = await call('proposals:report'); if (r?.ok) toast('Отчёт скопирован. Вставьте его в чат.', 'ok'); else if (r) toast(r.error, 'err'); } }, 'Скопировать отчёт для чата')));

    if (!S.chatId) {
      box.append(h('div', { class: 'empty' }, 'Откройте чат DeepSeek или отправьте первое сообщение — предложения изменений появятся здесь.'));
      return box;
    }
    if (!S.project) {
      box.append(h('div', { class: 'notice warn' }, 'Привяжите этот чат к локальному проекту (список вверху), иначе изменения не с чем сравнивать.'));
    }
    if (!S.proposals.length) {
      box.append(h('div', { class: 'empty' },
        h('div', {}, 'Пока нет предложений.'),
        h('div', {}, 'Составьте промпт кнопкой «Промпт» вверху и отправьте его ИИ: он научит модель маркерам # &путь, замене функций (REPLACE_BLOCK) и блокам SEARCH/REPLACE.')));
      return box;
    }
    const versions = {};
    for (const p of S.proposals) if (p.status === 'pending' && !p.historical) versions[p.relPath] = (versions[p.relPath] || 0) + 1;
    for (const p of S.proposals) box.append(proposalCard(p, versions[p.relPath] || 0));
    return box;
  }

  /** Сведения о предложении, принятом в буфер редактора и ещё не сохранённом. */
  function stagedOf(proposalId) {
    const ed = window.WhaleEditor;
    return ed && ed.stagedProposals ? ed.stagedProposals().get(proposalId) || null : null;
  }

  function proposalCard(p, versions) {
    const title = p.op === 'create' ? `➕ Create ${base(p.relPath)}` : `🔍 Diff & Update ${base(p.relPath)}`;
    const done = p.status !== 'pending';
    const card = h('button', { class: 'card' + (done ? ' done' : ''), onclick: () => openProposal(p.id) },
      h('span', { class: 'card-title' }, title),
      h('span', { class: 'path' }, p.op === 'move' ? `${p.relPath} → ${p.toRelPath}` : p.relPath),
      h('span', { class: 'card-meta' },
        h('span', { class: 'badge' + (STATE_BAD.has(p.state) ? ' bad' : '') }, STATE_LABEL[p.state] || p.state),
        p.stats && p.stats.added > 0 && h('span', { class: 'badge add' }, '+' + p.stats.added),
        p.stats && p.stats.removed > 0 && h('span', { class: 'badge del' }, '−' + p.stats.removed),
        p.mode === 'patch' && h('span', { class: 'badge' }, `частичная правка · ${p.patchBlocks}`),
        p.pathFixed && h('span', { class: 'badge', title: 'ИИ указал путь вместе с именем корневой папки — оно убрано' }, 'путь исправлен'),
        p.warnings > 0 && h('span', { class: 'badge warn' }, 'возможно неполный код'),
        p.encodingWarning && h('span', { class: 'badge warn', title: p.encodingWarning }, 'не UTF-8'),
        p.manualChanged && h('span', { class: 'badge warn', title: 'Файл изменён на диске после последней операции Whale Bridge' }, 'изменён вручную'),
        stagedOf(p.id) && h('span', {
          class: 'badge', style: 'border-color: var(--accent); color: var(--accent)',
          title: `Изменения приняты в буфер редактора (${stagedOf(p.id).acceptedHunks ?? '?'} из ${stagedOf(p.id).totalHunks ?? '?'}) и ждут сохранения`,
        }, 'в буфере редактора'),
        p.status === 'pending' && versions > 1 && h('span', { class: 'badge warn' }, `версий этого файла: ${versions}`),
        p.historical && h('span', { class: 'badge' }, 'из истории чата')));
    return h('div', { class: 'card-wrap' }, card,
      h('button', { class: 'dismiss', title: 'Убрать из списка', 'aria-label': 'Убрать предложение из списка', onclick: () => onDismiss(p.id) }, '✕'));
  }

  async function onDismiss(id) {
    await call('proposal:dismiss', { id });
    await loadProposals();
  }
  async function onDismissAll() {
    await call('proposals:dismissAll', { includeHistorical: S.showHistorical });
    await loadProposals();
  }

  async function onClipboard() {
    const r = await call('proposal:fromClipboard');
    if (!r) return;
    toast(r.ok ? 'Добавлено из буфера' : r.error, r.ok ? 'ok' : 'err');
  }

  async function openProposal(id) {
    const data = await call('proposal:get', { id });
    if (!data) return;
    S.view = { kind: 'proposal', data };
    S.viewPane = diffCapable('proposal', data) ? 'diff' : 'details';
    S.diffBase = 'current';
    S.panel = 'view';
    S.showFull = false;
    S.allowIncomplete = false;
    render();
  }

  // ---------- просмотр diff ----------
  function diffTable(rows, truncated) {
    const box = h('div', { class: 'diff' });
    if (!rows.length) box.append(h('div', { class: 'dl skip' }, 'Изменений нет'));
    for (const r of rows) {
      if (r.type === 'skip') {
        box.append(h('div', { class: 'dl skip' }, `⋯ ${r.count} неизменённых строк`));
        continue;
      }
      box.append(
        h('div', { class: 'dl ' + r.type },
          h('span', { class: 'ln' }, r.oldNo ?? ''),
          h('span', { class: 'ln' }, r.newNo ?? ''),
          h('span', { class: 'sg' }, r.type === 'add' ? '+' : r.type === 'del' ? '−' : ''),
          h('span', { class: 'tx' }, r.text)));
    }
    if (truncated) box.append(h('div', { class: 'dl skip' }, 'Diff слишком большой — показана только первая часть'));
    return box;
  }

  function patchLine(r, i) {
    const n = `Блок ${i + 1}: `;
    if (r.status === 'ok' && (r.method === 'block' || r.method === 'block-name')) {
      const how = r.method === 'block-name' ? ' (найдено по имени: заголовок в файле отличался)' : '';
      return `${n}функция/класс заменены целиком, строки ${r.line}–${r.endLine}${how}`;
    }
    if (r.status === 'ok') {
      const how = r.method === 'exact' ? '' : r.method === 'trimEnd' ? ' (без учёта пробелов в конце строк)' : ' (без учёта отступов)';
      return `${n}применён, строка ${r.line}${how}`;
    }
    if (r.status === 'skipped') return n + 'пропущен из-за ошибки в предыдущем блоке';
    return `${n}${r.status === 'ambiguous' ? 'неоднозначен' : 'не найден'} — ${r.hint || ''}`;
  }

  function renderProposalView(d) {
    const box = h('div', {});
    const title = d.op === 'create' ? `➕ Create ${base(d.relPath)}` : d.op === 'delete' ? `🗑 Delete ${base(d.relPath)}` : d.op === 'move' ? `↪ Move ${base(d.relPath)}` : `🔍 Diff & Update ${base(d.relPath)}`;
    box.append(
      h('div', { class: 'view-head' },
        h('div', { class: 'actions', style: 'margin:0' },
          h('button', { class: 'btn ghost', onclick: closeView }, '← К списку'),
          diffCapable('proposal', d) && h('button', { class: 'btn ghost', title: 'Monaco DiffEditor', onclick: backToDiff }, '◧ Diff')),
        h('div', { class: 'view-title' }, title),
        h('div', { class: 'path' }, d.op === 'move' ? `${d.relPath} → ${d.newRelPath}` : d.relPath),
        h('div', { class: 'card-meta' },
          h('span', { class: 'badge' + (STATE_BAD.has(d.state) ? ' bad' : '') }, STATE_LABEL[d.state] || d.state),
          d.stats && h('span', { class: 'badge add' }, '+' + d.stats.added),
          d.stats && h('span', { class: 'badge del' }, '−' + d.stats.removed))));

    const canApply = d.state === 'update' || d.state === 'create' || d.state === 'delete' || d.state === 'move';
    const risky = d.incomplete.length > 0 || !!d.shrink;

    // сообщения по состоянию
    if (d.op === 'delete' && d.state === 'delete') {
      box.append(h('div', { class: 'notice warn' },
        h('div', {}, 'Файл будет отправлен в системную корзину. До удаления создаётся резервная копия, поэтому операцию можно откатить из Истории.'),
        h('div', { class: 'path' }, d.relPath)));
    }
    if (d.op === 'move' && d.state === 'move') {
      box.append(h('div', { class: 'notice warn' },
        h('div', {}, 'Файл будет перемещён. Если целевой файл уже существует, операция блокируется.'),
        h('div', {}, h('span', { class: 'path' }, d.relPath), ' → ', h('span', { class: 'path' }, d.toRelPath)),
        d.needsDirs && h('div', {}, 'Папки назначения будут созданы автоматически.')));
    }
    if (d.toPathFixed) {
      box.append(h('div', { class: 'notice' }, `Путь назначения исправлен автоматически: «${d.toPathFixed.from}» → «${d.toPathFixed.to}».`));
    }
    if (d.pathFixed) {
      box.append(h('div', { class: 'notice' }, `Путь исправлен автоматически: «${d.pathFixed.from}» → «${d.pathFixed.to}» (ИИ добавил имя корневой папки проекта).`));
    }
    if (d.mode === 'patch' && d.state === 'patch-open') {
      box.append(h('div', { class: 'notice warn' }, 'Блок SEARCH/REPLACE не закрыт (нет строки >>>>>>> REPLACE): ответ ещё пишется или оборван. Подождите или попросите ИИ повторить правку.'));
    }
    if (d.manualChanged) box.append(h('div', { class: 'notice warn' }, 'Файл изменён на диске после последней операции Whale Bridge. Модель могла видеть старую версию. Можно передать ей актуальную версию или выполнить трёхстороннее слияние.'));
    if (d.mode === 'patch' && d.state === 'patch-failed') {
      box.append(h('div', { class: 'notice bad' },
        h('div', {}, 'Правка не применена: ' + d.error),
        h('div', { class: 'path' }, 'Ничего на диске не изменено. Ниже показано, что ожидал SEARCH и какой фрагмент сейчас находится в файле.')));
    }
    if (d.patchResults && d.patchResults.length) {
      const partials = d.patchResults.filter((r) => r.partial);
      const fuzzy = d.patchResults.some((r) => r.status === 'ok' && r.method !== 'exact' && r.method !== 'block');
      const whole = d.patchResults.some((r) => r.wholeFile);
      box.append(
        h('div', { class: 'notice' + (d.state === 'patch-failed' ? ' bad' : fuzzy ? ' warn' : '') },
          h('div', {}, `Частичная правка: блоков ${d.patchResults.length}`),
          h('ul', {}, d.patchResults.map((r, i) => h('li', {}, patchLine(r, i)))),
          fuzzy && h('div', {}, 'Часть блоков найдена приблизительно (допуск на пробелы и отступы или поиск по имени) — внимательно проверьте Diff.'),
          whole && h('div', {}, 'В SEARCH почти весь файл — по сути это полная замена. Правка применится, но можно попросить ИИ присылать только изменяемую функцию (REPLACE_BLOCK) или короткие фрагменты.')));
      for (const r of partials) {
        box.append(
          h('div', { class: 'patch-partial' },
            h('div', { class: 'path' }, `Частичное совпадение: найдено ${r.partial.matched} из ${r.partial.total} строк, начиная со строки ${r.partial.line}.`),
            diffTable(r.partial.diff, false)));
      }
    }
    if (d.state === 'no-project') box.append(h('div', { class: 'notice warn' }, 'Чат не привязан к проекту. Выберите проект вверху.'));
    if (d.state === 'invalid-path') box.append(h('div', { class: 'notice bad' }, `Путь заблокирован: ${d.error}`));
    if (d.state === 'unreadable') box.append(h('div', { class: 'notice bad' }, d.error));
    if (d.encodingWarning && (d.state === 'delete' || d.state === 'move')) {
      box.append(h('div', { class: 'notice warn' },
        h('div', {}, 'Файл не является UTF-8, поэтому его содержимое нельзя показать как текст.'),
        h('div', {}, 'Удаление/перемещение всё равно безопасно: содержимое файла не переписывается.'),
        h('div', { class: 'path' }, d.encodingWarning)));
    }
    if (d.state === 'unreadable' && d.error && d.error.includes('не UTF-8')) {
      box.append(h('div', { class: 'notice' }, 'Для обновления этого файла сначала сохраните его в UTF-8. Исходный файл не изменён.'));
    }
    if (d.state === 'identical') box.append(h('div', { class: 'notice' }, 'Предложенная версия совпадает с файлом на диске.'));
    if (d.state === 'missing') {
      box.append(h('div', { class: 'notice warn' },
        h('div', {}, 'Файл для обновления не найден в проекте. Возможно, ИИ ошибся в пути.'),
        d.suggestions.length > 0 && h('div', {}, 'Похожие файлы:'),
        h('div', { class: 'sugg' },
          d.suggestions.map((s) => h('button', { class: 'btn', onclick: () => retarget(d.id, s, 'update') }, s)),
          d.mode !== 'patch' && h('button', { class: 'btn', onclick: () => retarget(d.id, d.relPath, 'create') }, 'Создать как новый файл'))));
    }
    if (d.state === 'exists') {
      box.append(h('div', { class: 'notice warn' },
        h('div', {}, 'Маркер просит создать новый файл, но он уже существует. Перезаписывать его как «новый» нельзя.'),
        h('div', { class: 'sugg' }, h('button', { class: 'btn', onclick: () => retarget(d.id, d.relPath, 'update') }, 'Обновить существующий файл'))));
    }
    if (d.needsDirs) box.append(h('div', { class: 'notice' }, 'Папки для этого файла ещё не существуют — они будут созданы при применении.'));
    if (risky) {
      box.append(h('div', { class: 'notice warn' },
        h('div', {}, 'Ответ похож на неполный. Обычная перезапись заблокирована, пока вы не подтвердите её вручную.'),
        d.shrink && h('div', {}, d.shrink),
        d.incomplete.length > 0 && h('ul', {}, d.incomplete.map((x) => h('li', {}, `строка ${x.line}: ${x.text}`))),
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: S.allowIncomplete, onchange: (e) => { S.allowIncomplete = e.target.checked; render(); } }),
          'Я проверил(а) Diff и всё равно хочу применить')));
    }

    // кнопки
    const actions = h('div', { class: 'actions' });
    if (d.status === 'pending') {
      actions.append(
        h('button', { class: 'btn primary', disabled: !canApply || (risky && !S.allowIncomplete), onclick: () => onApply(d) },
          d.op === 'delete' ? 'Удалить в корзину' : d.op === 'move' ? (d.needsDirs ? 'Создать папки и переместить' : 'Переместить файл') : d.needsDirs ? 'Создать папки и файл' : 'Принять изменения'),
        d.manualChanged && d.op === 'update' && h('button', { class: 'btn', onclick: () => onMerge(d) }, 'Применить и слить мои правки'),
        h('button', { class: 'btn', title: 'Закрыть предложение и убрать из списка', onclick: () => onReject(d) }, 'Отклонить'));
    }
    if (d.status === 'applied' && d.historyId) {
      actions.append(h('button', { class: 'btn', onclick: () => onRevert(d.historyId) }, 'Восстановить предыдущую версию'));
    }
    if (d.projectId && ['update', 'delete', 'move'].includes(d.op) && d.state !== 'missing') {
      actions.append(h('button', { class: 'btn', onclick: () => openFile(d.projectId, d.relPath) }, 'Открыть исходный файл'));
    }
    actions.append(h('button', { class: 'btn', onclick: () => { S.showFull = !S.showFull; render(); } }, S.showFull ? 'Показать Diff' : d.mode === 'patch' ? 'Просмотреть итоговый файл' : 'Просмотреть полный код'));
    box.append(actions);

    box.append(S.showFull ? h('pre', { class: 'code' }, d.newText ?? d.rawText) : diffTable(d.rows, d.truncated));
    return box;
  }

  async function retarget(id, relPath, op) {
    await call('proposal:retarget', { id, relPath, op });
    await openProposal(id);
  }
  async function openManual(relPath) {
    if (!S.project) return;
    const d = await call('manual:view', { projectId: S.project.id, relPath });
    if (!d) return toast('Ручные изменения не найдены', 'err');
    if (d.error) return toast(d.error, 'err'); // например: точка отсчёта — откат, копии для сравнения нет
    S.view = { kind: 'manual', data: d };
    S.viewPane = diffCapable('manual', d) ? 'diff' : 'details';
    S.panel = 'view';
    render();
  }
  /** Что знает модель в текущем чате против того, что сейчас на диске. */
  async function loadContext() {
    S.context = S.project && S.chatId
      ? ((await call('context:list', { projectId: S.project.id })) || { items: [], checked: 0, truncated: false })
      : { items: [], checked: 0, truncated: false };
  }

  async function copyManualVersions() {
    if (!S.project) return;
    const r = await call('manual:copy', { projectId: S.project.id });
    // Копирование НЕ снимает отметки: скопировать в буфер — не значит отправить в чат
    toast(r?.ok
      ? `Актуальные версии скопированы (${r.files} файлов). Вставьте их в чат, затем нажмите «✓ Модель проинформирована».`
      : r?.error, r?.ok ? 'ok' : 'err');
  }

  /**
   * «Модель проинформирована о текущей версии файла».
   * Отметка хранится как хэш содержимого, поэтому следующее изменение файла снимет её само.
   */
  async function ackManual(relPath) {
    if (!S.project) return;
    const r = await call('context:ack', { projectId: S.project.id, relPath });
    if (!r) return;
    if (!r.ok) { toast(r.error, 'err'); return; }
    toast('Отмечено: модель знает текущую версию файла', 'ok');
    await loadContext();
    if (window.WhaleEditor) await window.WhaleEditor.refreshDisk();
    if (S.view && S.view.kind === 'manual') await openManual(relPath);
    else render();
  }

  async function ackAllManual() {
    if (!S.project || !S.context.items.length) return;
    const n = S.context.items.length;
    if (!confirm(`Отметить ${n} файл(ов) как известные модели?\n\nОтметка снимется автоматически, если файл снова изменится.`)) return;
    const r = await call('context:ack-all', { projectId: S.project.id });
    if (!r) return;
    toast(r.ok
      ? `Отмечено файлов: ${r.acked}`
      : `Отмечено ${r.acked} из ${r.total}. Не удалось: ${r.failed.slice(0, 3).join('; ')}`, r.ok ? 'ok' : 'err');
    await loadContext();
    if (window.WhaleEditor) await window.WhaleEditor.refreshDisk();
    render();
  }
  async function openFile(projectId, rel) {
    const r = await call('file:open', { projectId, rel, mode: 'open' });
    if (r && !r.ok) toast(r.error, 'err');
  }
  async function onReject(d) {
    await call('proposal:reject', { id: d.id });
    S.view = null;
    await loadProposals();
  }
  async function onMerge(d) {
    const r = await call('proposal:merge', { id: d.id });
    if (!r) return;
    if (r.ok) { toast('Изменения слиты с ручными правками', 'ok'); S.view = null; await loadProposals(); return; }
    if (r.code === 'merge-conflict') {
      S.view = { kind: 'merge', data: { ...d, mergedText: r.mergedText, conflicts: r.conflicts } };
      S.viewPane = 'details'; // разметка конфликтов — текстовый отчёт, не дифф
      S.panel = 'view';
      render();
      return;
    }
    toast(r.error, 'err');
  }

  async function onApply(d) {
    if (d.op === 'delete') {
      if (!confirm(`Отправить файл «${d.relPath}» в системную корзину?\n\nПеред удалением будет создан бэкап для отката.`)) return;
    } else if (d.op === 'move') {
      if (!confirm(`Переместить файл «${d.relPath}» → «${d.toRelPath}»?\n\nСуществующий файл назначения перезаписан не будет.`)) return;
    }
    const r = await call('proposal:apply', {
      id: d.id, baseHash: d.baseHash, contentHash: d.contentHash,
      allowIncomplete: S.allowIncomplete, createDirs: !!d.needsDirs,
    });
    if (!r) return;
    if (r.ok) {
      toast(d.op === 'create' ? 'Файл создан' : d.op === 'delete' ? 'Файл отправлен в корзину' : d.op === 'move' ? 'Файл перемещён' : 'Изменения применены', 'ok');
      S.view = null;
      await loadProposals();
      return;
    }
    toast(r.error, 'err');
    if (r.code === 'conflict' || r.code === 'changed') await openProposal(d.id); // показать свежий Diff
  }
  async function onRevert(historyId) {
    let r = await call('history:revert', { id: historyId, force: false });
    if (r && !r.ok && r.code === 'conflict') {
      if (!confirm(r.error + '\nВосстановить предыдущую версию принудительно? Правки, сделанные после применения, будут потеряны.')) return;
      r = await call('history:revert', { id: historyId, force: true });
    }
    if (!r) return;
    toast(r.ok ? 'Предыдущая версия восстановлена' : r.error, r.ok ? 'ok' : 'err');
    S.view = null;
    await loadHistory();
    await loadProposals();
  }

  // ---------- панель файлов: заголовок, плашка расхождений, отметки в дереве ----------
  // Отдельной вкладки «Файлы» больше нет (этап B): дерево живёт в своей панели постоянно,
  // а всё, что вкладка умела — откат, «модель не знает версию», предложения, проводник —
  // переехало в строки того же дерева. Данные для отметок собираются здесь и передаются
  // в ui/editor.js, который их рисует (правила соединения — ES.treeRowMarks, чистые).
  function divergedPaths() {
    return S.context.items.map((x) => x.relPath);
  }

  function undoByPath() {
    // последняя применённая операция по каждому файлу (история уже отсортирована от новых к старым)
    const undo = new Map();
    for (const e of S.history) {
      if (e.status === 'applied' && e.revertible !== false && !(e.pruned && e.op !== 'create') && !undo.has(e.relPath)) undo.set(e.relPath, e);
    }
    return undo;
  }

  function proposalsByPath() {
    const out = new Map();
    for (const p of S.proposals) {
      if (p.status !== 'pending' || p.historical || p.state === 'missing') continue;
      const cur = out.get(p.relPath) || { count: 0, added: 0, removed: 0, firstId: p.id };
      cur.count += 1;
      if (p.stats) { cur.added += p.stats.added || 0; cur.removed += p.stats.removed || 0; }
      out.set(p.relPath, cur);
    }
    return out;
  }

  function renderFilesHead() {
    const head = $('#files-head');
    if (!head) return;
    const manual = divergedPaths();
    head.replaceChildren(
      h('span', { class: 'files-title' }, 'ФАЙЛЫ'),
      h('span', { class: 'path grow', title: S.project ? S.project.path : '' }, S.project ? S.project.name : 'Проект не выбран'),
      manual.length > 0 && h('button', { class: 'btn tiny', title: COPY_TITLE, onclick: copyManualVersions }, 'Скопировать для модели'),
      manual.length > 0 && h('button', {
        class: 'btn tiny', title: `Отметить все ${manual.length} файл(ов) как известные модели`,
        onclick: ackAllManual,
      }, '✓ Модель знает все'),
      h('button', {
        class: 'btn ghost tiny', title: 'Обновить дерево (обычно оно обновляется само)',
        onclick: () => window.WhaleEditor && window.WhaleEditor.refreshTree(),
      }, '⟳'));

    const banner = $('#files-banner');
    if (!banner) return;
    banner.replaceChildren();
    if (manual.length > 0) {
      // Имена перечисляем явно: файл может лежать в свёрнутой папке, и тогда отметка
      // в дереве не видна — без списка плашка выглядит необъяснимой.
      banner.append(h('div', { class: 'notice warn' },
        `Модель не знает текущую версию: ${manual.length} файл(ов). Она может предлагать правки от устаревшего кода.`,
        h('div', { class: 'path' }, manual.slice(0, 8).join(', ') + (manual.length > 8 ? ` … ещё ${manual.length - 8}` : ''))));
    }
    if (S.context.truncated) {
      banner.append(h('div', { class: 'notice' },
        `Проверено ${S.context.checked} файлов из журнала — остальные не поместились в лимит одного запроса.`));
    }
  }

  /** Передать в дерево отметки и действия. Порядок: сначала данные, потом перерисовка. */
  function pushTreeExtras() {
    const ed = window.WhaleEditor;
    if (!ed || !ed.setTreeExtras) return;
    ed.setTreeExtras({
      manual: new Set(divergedPaths()),
      undo: undoByPath(),
      proposals: proposalsByPath(),
      callbacks: {
        onManual: (rel) => openManual(rel),
        onUndo: async (entry) => {
          if (entry.op === 'create' && !confirm('Файл был создан приложением. Откат удалит его. Продолжить?')) return;
          await onRevert(entry.id);
        },
        onProposal: async (rel) => {
          const info = proposalsByPath().get(rel);
          if (!info) return;
          // просмотр откроется вместо редактора; список слева переключаем на предложения,
          // чтобы после «← К списку» пользователь вернулся к карточкам
          if (S.layout.leftTab !== 'proposals') {
            S.layout = { ...S.layout, leftTab: 'proposals' };
            call('layout:save', { layout: S.layout });
          }
          await openProposal(info.firstId);
        },
        onReveal: (rel) => { if (S.project) call('file:open', { projectId: S.project.id, rel, mode: 'reveal' }); },
      },
    });
  }


  // ---------- вкладка «История» ----------
  async function loadHistory() {
    S.history = (await call('history:list', { projectId: S.project ? S.project.id : null })) || [];
    S.backup = (await call('backups:stats')) || S.backup;
    await loadContext();
  }

  async function onClearBackups() {
    const { files, bytes } = S.backup;
    if (!confirm(`Удалить все резервные копии (${files} файлов, ${fmtBytes(bytes)})?\n\nЖурнал операций останется, но Diff и откат этих изменений станут недоступны (откат созданных файлов продолжит работать).`)) return;
    const r = await call('backups:clear');
    if (r) toast(`Удалено файлов: ${r.files} (${fmtBytes(r.bytes)})`, 'ok');
    await loadHistory();
    render();
  }

  async function openHistory(id) {
    const data = await call('history:view', { id });
    if (!data) return;
    S.view = { kind: 'history', data };
    S.viewPane = diffCapable('history', data) ? 'diff' : 'details';
    S.panel = 'view';
    render();
  }

  function renderHistory() {
    const bar = h('div', { class: 'toolbar' },
      h('span', { class: 'path grow' }, `Хранятся 2 последние версии каждого файла · копий: ${S.backup.files} (${fmtBytes(S.backup.bytes)})`),
      h('button', { class: 'btn danger', disabled: S.backup.files === 0, onclick: onClearBackups }, 'Очистить бэкапы'));
    if (!S.history.length) return h('div', { class: 'stack' }, bar, h('div', { class: 'empty' }, 'Применённых изменений пока нет.'));
    const statusLabel = { applied: 'Применено', reverted: 'Откачено', failed: 'Ошибка' };
    return h('div', { class: 'stack' }, bar,
      S.history.map((e) =>
        h('div', { class: 'row' },
          h('div', { class: 'grow' },
            h('div', {}, (e.op === 'create' ? '➕ ' : e.op === 'delete' ? '🗑 ' : e.op === 'move' ? '↪ ' : '🔍 ') + base(e.relPath)),
            h('div', { class: 'path' }, e.op === 'move' ? `${e.relPath} → ${e.newRelPath}` : e.relPath),
            h('div', { class: 'card-meta' },
              h('span', {}, fmtTime(e.ts)),
              h('span', { class: 'badge' + (e.status === 'failed' ? ' bad' : '') }, statusLabel[e.status] || e.status),
              e.source === 'rollback'
                ? h('span', { class: 'badge', title: 'Откат операции. Резервная копия не хранится — откатить повторно нельзя' }, 'откат')
                : e.pruned && h('span', { class: 'badge', title: 'Копии этой операции удалены' }, 'копия удалена'),
              e.error && h('span', { class: 'badge bad', title: e.error }, e.error.slice(0, 60)))),
          e.status !== 'failed' && !e.pruned && h('button', { class: 'btn', onclick: () => openHistory(e.id) }, 'Diff'),
          e.status === 'applied' && e.revertible !== false && !(e.pruned && e.op !== 'create') && h('button', { class: 'btn', onclick: () => onRevert(e.id) }, 'Восстановить'))));
  }

  function renderManualView(d) {
    return h('div', {},
      h('div', { class: 'view-head' },
        h('div', { class: 'actions', style: 'margin:0' },
          h('button', { class: 'btn ghost', onclick: closeView }, '← Закрыть'),
          diffCapable('manual', d) && h('button', { class: 'btn ghost', title: 'Monaco DiffEditor', onclick: backToDiff }, '◧ Diff')),
        h('div', { class: 'view-title' }, 'Мои правки'),
        h('div', { class: 'path' }, d.relPath)),
      h('div', { class: 'notice warn' }, 'Сравнение последней версии после операции Whale Bridge с текущим файлом на диске.'),
      d.diverged
        ? h('div', { class: 'notice warn' },
          'Модель в чате не знает об этом изменении и может предлагать правки от устаревшей версии.',
          d.knownVersion ? h('div', { class: 'path' }, `Известная модели версия: ${fmtTime(d.knownVersion.ts)} · ${d.knownVersion.label}`) : null,
          d.notice ? h('div', { class: 'path' }, d.notice) : null,
          h('div', {}, 'Передайте ей актуальный файл и отметьте его — или подтвердите, что уже это сделали.'))
        : h('div', { class: 'notice' }, d.note || 'Модель знает текущую версию файла. Если файл снова изменится, отметка снимется сама.'),
      d.rows && d.rows.length ? diffTable(d.rows, d.truncated) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', title: COPY_TITLE, onclick: copyManualVersions }, 'Скопировать изменения для модели'),
        d.diverged && h('button', { class: 'btn primary', onclick: () => ackManual(d.relPath) }, '✓ Модель проинформирована'),
        h('button', { class: 'btn', onclick: () => openFile(S.project.id, d.relPath) }, 'Открыть файл')));
  }

  function renderMergeView(d) {
    return h('div', {},
      h('div', { class: 'view-head' },
        h('button', { class: 'btn ghost', style: 'justify-self:start', onclick: closeView }, '← К предложению'),
        h('div', { class: 'view-title' }, 'Конфликт merge'),
        h('div', { class: 'path' }, d.relPath)),
      h('div', { class: 'notice bad' }, `Автоматическое слияние не выполнено: конфликтов ${d.conflicts}. Ни диск, ни буфер редактора не изменены.`),
      d.conflictRows?.length && h('div', { class: 'stack' },
        h('div', { class: 'path' }, 'DIFF: текущий файл → предложение ИИ'),
        diffTable(d.conflictRows, false)),
      h('div', { class: 'path' }, 'Вариант с маркерами конфликтов:'),
      h('pre', { class: 'code' }, d.mergedText),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', title: COPY_TITLE, onclick: copyManualVersions }, 'Скопировать изменения для модели'),
        h('button', { class: 'btn', onclick: closeView }, 'Назад')));
  }

  function renderHistoryView(d) {
    return h('div', {},
      h('div', { class: 'view-head' },
        h('div', { class: 'actions', style: 'margin:0' },
          h('button', { class: 'btn ghost', onclick: closeView }, '← К истории'),
          diffCapable('history', d) && h('button', { class: 'btn ghost', title: 'Monaco DiffEditor', onclick: backToDiff }, '◧ Diff')),
        h('div', { class: 'view-title' }, (d.op === 'create' ? '➕ ' : d.op === 'delete' ? '🗑 ' : d.op === 'move' ? '↪ ' : '🔍 ') + base(d.relPath)),
        h('div', { class: 'path' }, d.relPath),
        h('div', { class: 'card-meta' },
          h('span', {}, fmtTime(d.ts)),
          d.stats && h('span', { class: 'badge add' }, '+' + d.stats.added),
          d.stats && h('span', { class: 'badge del' }, '−' + d.stats.removed))),
      d.missingBackup
        ? h('div', { class: 'notice warn' }, 'Резервные копии этой операции недоступны.')
        : d.op === 'move'
          ? h('div', { class: 'notice' }, `Файл был перемещён: ${d.relPath} → ${d.newRelPath}`)
          : diffTable(d.rows, false),
      d.status === 'applied' && h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => onRevert(d.id) }, 'Восстановить предыдущую версию')));
  }

  // ---------- вкладка «Промпт» ----------
  const PLACEHOLDERS = {
    task: 'Что нужно сделать. Например: добавить игроку двойной прыжок',
    project: 'Что за проект: движок и язык, архитектура, соглашения по коду',
    limits: 'Чего делать нельзя: не менять сигнатуры, не добавлять зависимости…',
    mode: 'Например: сначала кратко план, потом код; или: только исправь ошибку, без рефакторинга',
  };
  let saveTimer, previewTimer;

  async function loadPrompt() {
    const g = await call('prompt:get', { projectId: S.project ? S.project.id : null });
    if (!g) return;
    P.sections = g.sections;
    P.presets = g.presets;
    P.excluded = new Set(g.excluded);
    P.defaults = g.defaults;
    P.tree = S.project ? await call('prompt:tree', { projectId: S.project.id }) : null;
    P.loaded = true;
  }

  // Любая правка: сохраняем черновик и пересчитываем счётчик/предпросмотр с задержкой
  function touch() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => call('prompt:save-draft', { sections: P.sections }), 400);
    schedulePreview();
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 300);
  }
  async function refreshPreview() {
    if (!S.layout.promptOpen) return;
    const r = await call('prompt:build', { sections: P.sections, projectId: S.project ? S.project.id : null });
    if (!r) return;
    const c = $('#prompt-count');
    if (c) c.textContent = `${r.text.length.toLocaleString('ru-RU')} симв.` + (r.partial ? ' · структура неполная, приписка добавлена' : '');
    const pre = $('#prompt-preview');
    if (pre) pre.textContent = r.text || '(промпт пока пустой)';
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 420) + 'px';
  }

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= P.sections.length) return;
    [P.sections[i], P.sections[j]] = [P.sections[j], P.sections[i]];
    touch();
    renderPromptPanel();
  }
  function removeSection(i) {
    P.sections.splice(i, 1);
    touch();
    renderPromptPanel();
  }

  // --- дерево проекта с переключателями ---
  const offBy = (rel) => {
    let prefix = '';
    for (const part of rel.split('/')) {
      prefix = prefix ? prefix + '/' + part : part;
      if (P.excluded.has(prefix)) return true;
    }
    return false;
  };

  function ptreeNodes(nodes, depth, out) {
    for (const n of nodes) {
      const off = offBy(n.rel);
      const own = P.excluded.has(n.rel);
      const open = P.treeOpen.has(n.rel);
      out.push(
        h('div', { class: 'pnode' + (off ? ' off' : ''), style: `padding-left:${depth * 16 + 4}px` },
          h('span', {
            class: 'twisty', role: n.isDir ? 'button' : null,
            onclick: n.isDir ? () => { if (open) P.treeOpen.delete(n.rel); else P.treeOpen.add(n.rel); paintPromptTree(); } : null,
          }, n.isDir ? (open ? '▾' : '▸') : ''),
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: !off, disabled: off && !own, onchange: (e) => toggleExcluded(n.rel, e.target.checked) }),
            h('span', {}, n.name + (n.isDir ? '/' : '')))));
      if (n.isDir && open && n.children) ptreeNodes(n.children, depth + 1, out);
    }
  }

  function paintPromptTree() {
    const box = $('#prompt-tree');
    if (!box) return;
    const nodes = [];
    if (P.tree) ptreeNodes(P.tree.nodes, 0, nodes);
    box.replaceChildren(...nodes);
    const c = $('#prompt-tree-count');
    if (c) c.textContent = P.excluded.size ? `Скрыто элементов: ${P.excluded.size} — в промпте появится приписка о неполной структуре` : 'Все файлы включены';
  }

  async function toggleExcluded(rel, on) {
    if (on) P.excluded.delete(rel); else P.excluded.add(rel);
    paintPromptTree();
    schedulePreview();
    await call('prompt:set-excluded', { projectId: S.project.id, excluded: [...P.excluded] });
  }

  function treeBody() {
    if (!S.project) return h('div', { class: 'notice warn' }, 'Привяжите чат к проекту — структура подставится автоматически.');
    if (!P.tree) return h('div', { class: 'notice' }, 'Не удалось прочитать структуру проекта.');
    const box = h('div', { class: 'stack' },
      h('div', { class: 'toolbar' },
        h('span', { id: 'prompt-tree-count', class: 'path grow' }),
        h('button', { class: 'btn', onclick: async () => { P.excluded.clear(); paintPromptTree(); schedulePreview(); await call('prompt:set-excluded', { projectId: S.project.id, excluded: [] }); } }, 'Включить всё'),
        h('button', { class: 'btn primary', title: 'Скопировать содержимое всех включённых текстовых файлов', onclick: async () => {
          const r = await call('prompt:copy-files', { projectId: S.project.id, excluded: [...P.excluded] });
          if (r && r.ok) toast(`Скопировано файлов: ${r.files}${r.skipped ? ` · пропущено: ${r.skipped}` : ''}`, 'ok');
        } }, 'Скопировать файлы')),
      h('div', { id: 'prompt-tree', class: 'ptree' }));
    if (P.tree.truncated) box.append(h('div', { class: 'notice warn' }, 'Проект очень большой: показаны не все файлы (лимит дерева), в промпт добавится приписка о неполной структуре.'));
    setTimeout(paintPromptTree, 0);
    return box;
  }

  // --- поля ---
  function sectionCard(s, i) {
    const canReset = s.type === 'text' && s.key && P.defaults[s.key];
    const head = h('div', { class: 'sec-head' },
      h('input', { type: 'text', class: 'sec-title', value: s.title, 'aria-label': 'Название поля', oninput: (e) => { s.title = e.target.value; touch(); } }),
      canReset && h('button', { class: 'btn ghost', title: 'Вернуть текст по умолчанию', onclick: () => { s.text = P.defaults[s.key]; touch(); renderPromptPanel(); } }, 'Сбросить'),
      h('button', { class: 'btn ghost', title: 'Выше', 'aria-label': 'Переместить выше', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
      h('button', { class: 'btn ghost', title: 'Ниже', 'aria-label': 'Переместить ниже', disabled: i === P.sections.length - 1, onclick: () => move(i, 1) }, '↓'),
      h('button', { class: 'btn ghost danger', title: 'Удалить поле', 'aria-label': 'Удалить поле', onclick: () => removeSection(i) }, '✕'));

    let body;
    if (s.type === 'tree') {
      body = treeBody();
    } else {
      body = h('textarea', {
        class: 'sec-text', rows: s.key === 'rules' ? 10 : 3, placeholder: PLACEHOLDERS[s.key] || 'Текст поля…', spellcheck: 'false',
        oninput: (e) => { s.text = e.target.value; autoGrow(e.target); touch(); },
      }, s.text);
      requestAnimationFrame(() => autoGrow(body));
    }
    return h('section', { class: 'sec' }, head, body);
  }

  // --- пресеты ---
  function presetBar() {
    const nameInput = h('input', {
      type: 'text', value: P.presetName, placeholder: 'Название пресета', 'aria-label': 'Название пресета',
      oninput: (e) => { P.presetName = e.target.value; },
    });
    const sel = h('select', {
      'aria-label': 'Сохранённые пресеты',
      onchange: (e) => {
        P.presetId = e.target.value;
        const pr = P.presets.find((x) => x.id === P.presetId);
        if (pr) { P.presetName = pr.name; nameInput.value = pr.name; }
        loadBtn.disabled = !P.presetId;
        delBtn.disabled = !P.presetId || !!pr?.builtin;
      },
    }, h('option', { value: '' }, '— сохранённые пресеты —'),
    P.presets.map((p) => h('option', { value: p.id, selected: p.id === P.presetId }, p.name + (p.builtin ? ' (встроенный)' : ''))));

    const loadBtn = h('button', { class: 'btn', disabled: !P.presetId, onclick: async () => {
      if (!confirm('Заменить текущие поля содержимым пресета?')) return;
      const secs = await call('prompt:preset-load', { id: P.presetId });
      if (secs) { P.sections = secs; renderPromptPanel(); toast('Пресет загружен', 'ok'); }
    } }, 'Загрузить');
    const delBtn = h('button', { class: 'btn danger', disabled: !P.presetId, onclick: async () => {
      const pr = P.presets.find((x) => x.id === P.presetId);
      if (!pr || !confirm(`Удалить пресет «${pr.name}»?`)) return;
      const list = await call('prompt:preset-delete', { id: P.presetId });
      if (list) { P.presets = list; P.presetId = ''; P.presetName = ''; renderPromptPanel(); }
    } }, 'Удалить');
    const saveBtn = h('button', { class: 'btn', title: 'Если пресет с таким названием есть, он будет перезаписан', onclick: async () => {
      const name = P.presetName.trim();
      if (!name) { toast('Введите название пресета', 'err'); return; }
      const exists = P.presets.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (exists && !confirm(`Пресет «${exists.name}» уже есть. Перезаписать текущими полями?`)) return;
      clearTimeout(saveTimer);
      await call('prompt:save-draft', { sections: P.sections });
      const list = await call('prompt:preset-save', { name, sections: P.sections });
      if (!list) return;
      P.presets = list;
      const saved = list.find((x) => x.name.toLowerCase() === name.toLowerCase());
      P.presetId = saved ? saved.id : '';
      renderPromptPanel();
      toast('Пресет сохранён', 'ok');
    } }, 'Сохранить пресет');

    return h('div', { class: 'stack presetbar' },
      h('div', { class: 'proj-row' }, sel, loadBtn, delBtn),
      h('div', { class: 'proj-row' }, nameInput, saveBtn));
  }

  function renderPrompt() {
    if (!P.loaded) {
      if (!P.loading) {
        P.loading = true;
        loadPrompt().finally(() => { P.loading = false; renderPromptPanel(); });
      }
      return h('div', { class: 'empty' }, 'Загрузка…');
    }
    const box = h('div', { class: 'stack' });
    box.append(
      h('div', { class: 'path' }, 'Заполните поля, при необходимости добавьте свои, и скопируйте промпт. Для задач под онлайн-судью используйте встроенный пресет «Судья» с полем «СРЕДА ВЫПОЛНЕНИЯ».'),
      presetBar());
    P.sections.forEach((s, i) => box.append(sectionCard(s, i)));

    const hasTree = P.sections.some((s) => s.type === 'tree');
    box.append(h('div', { class: 'toolbar' },
      h('button', { class: 'btn', onclick: () => { P.sections.push({ id: uid(), key: null, title: 'НОВОЕ ПОЛЕ', text: '', type: 'text' }); touch(); renderPromptPanel(); const pb = $('#prompt-body'); if (pb) pb.scrollTop = 1e6; } }, '＋ Добавить поле'),
      !hasTree && h('button', { class: 'btn', onclick: () => { P.sections.push({ id: uid(), key: 'tree', title: 'СТРУКТУРА ПРОЕКТА', text: '', type: 'tree' }); touch(); renderPromptPanel(); } }, '＋ Структура проекта'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn ghost danger', title: 'Вернуть стандартный набор полей и текстов', onclick: async () => {
        if (!confirm('Сбросить все поля к стандартным? Введённые тексты будут потеряны (пресеты останутся).')) return;
        const secs = await call('prompt:reset');
        if (secs) { P.sections = secs; renderPromptPanel(); }
      } }, 'Стандартные поля')));

    if (P.preview) box.append(h('pre', { id: 'prompt-preview', class: 'code' }, ''));
    box.append(h('div', { class: 'promptbar' },
      h('button', { class: 'btn primary', onclick: async () => {
        const r = await call('prompt:copy', { sections: P.sections, projectId: S.project ? S.project.id : null });
        if (!r) return;
        toast(r.ok ? `Промпт скопирован (${r.length.toLocaleString('ru-RU')} симв.). Вставьте его в чат.` : r.error, r.ok ? 'ok' : 'err');
      } }, 'Скопировать промпт'),
      h('button', { class: 'btn', onclick: () => { P.preview = !P.preview; renderPromptPanel(); } }, P.preview ? 'Скрыть предпросмотр' : 'Предпросмотр'),
      h('span', { id: 'prompt-count', class: 'path' })));
    setTimeout(refreshPreview, 0);
    return box;
  }

  // ---------- отрисовка ----------
  /**
   * Monaco живёт в #ed-host постоянно и переживает любые перерисовки (ТЗ §7): этот render
   * переключает режимы панели редактора и перерисовывает левую панель. Дерево рисует
   * ui/editor.js — сюда приходят лишь данные для отметок (pushTreeExtras).
   *
   * Форму «Промпта» render() НЕ трогает намеренно: любая пересборка по внешним событиям
   * (поток ответов модели) выбивала бы фокус из полей. Её обновляет только
   * renderPromptPanel() — по явным действиям пользователя.
   */
  function render() {
    renderHead();
    renderTabs();
    renderFilesHead();
    pushTreeExtras();
    renderLeftPane();
    renderEditorArea();
  }

  /**
   * Левая панель: на вкладке «Файлы» показывается дерево (его рисует ui/editor.js),
   * на «Предложениях» и «Истории» — списки в #body. Просмотр (Diff предложения, операция
   * истории, «мои правки») открывается не здесь, а вместо редактора: в узкой колонке
   * построчный diff не читается.
   */
  function renderLeftPane() {
    const pane = $('#files-pane');
    const body = $('#body');
    if (!pane || !body) return;
    const isFiles = S.layout.leftTab === 'files';
    pane.classList.toggle('hidden', !isFiles);
    body.classList.toggle('hidden', isFiles);
    if (isFiles) return;
    const scroll = body.scrollTop;
    body.replaceChildren();
    body.append(S.layout.leftTab === 'proposals' ? renderProposals() : renderHistory());
    body.scrollTop = scroll;
  }

  /**
   * Панель редактора показывает ровно одно из четырёх: код, просмотр, «Промпт» или
   * пустое состояние. Приоритет: просмотр > «Промпт» > код (открытый Diff важнее,
   * иначе действие пользователя выгляделось бы проигнорированным).
   */
  let panelMode = null;  // последний применённый режим центральной панели
  let lastDiffSig = null; // сигнатура показанного в Monaco диффа (защита от лишнего setModel)
  /**
   * Режимы центральной панели: редактор / просмотр / «Промпт» — взаимоисключающие,
   * активный хранится в S.panel. Просмотр внутри себя делится на две панели:
   * Monaco-дифф (#diff-host) и подробный HTML-отчёт (#view-host, viewPane='details').
   *
   * Память переходов (явное требование к раскладке): «Промпт» запоминает прежнее окно
   * и возвращает в него; просмотр, открытый поверх «Промпта», после закрытия возвращает
   * в «Промпт», если тот не был закрыт явно.
   */
  function renderEditorArea() {
    // Самоочистка: просмотр закрыли в другом месте (предложение принято/отклонено,
    // откат) — панель возвращается к «Промпту», если он открыт, иначе к редактору.
    if (S.panel === 'view' && !S.view) S.panel = S.layout.promptOpen ? 'prompt' : 'editor';
    const mode = S.panel;
    const isDiff = mode === 'view' && S.viewPane === 'diff';
    const show = (sel, on) => {
      const el = $(sel);
      if (el && el.classList) el.classList.toggle('hidden', !on);
    };
    show('#ed-tabs', mode === 'editor');
    show('#ed-status', mode === 'editor');
    show('#prompt-host', mode === 'prompt');
    show('#diff-host', isDiff);
    show('#view-host', mode === 'view' && !isDiff);
    if (mode !== 'editor') { show('#ed-host', false); show('#ed-empty', false); }
    // Видимость редактора переключает сам ui/editor.js: он знает, показывать #ed-host
    // или пустое состояние, и пересчитывает размеры Monaco (§7). Дёргаем setVisible
    // только когда режим действительно сменился: render() вызывается на каждый чих
    // потока ответов модели, а setVisible(true) тянет за собой refreshDisk (IPC).
    if (window.WhaleEditor) {
      if (mode !== panelMode) window.WhaleEditor.setVisible(mode === 'editor');
      panelMode = mode;
      if (!isDiff && window.WhaleEditor.hideDiff) { window.WhaleEditor.hideDiff(); lastDiffSig = null; }
    }

    const vh = $('#view-host');
    if (vh) {
      if (mode === 'view' && !isDiff) {
        const scroll = vh.scrollTop;
        vh.replaceChildren();
        if (S.view.kind === 'proposal') vh.append(renderProposalView(S.view.data));
        else if (S.view.kind === 'history') vh.append(renderHistoryView(S.view.data));
        else if (S.view.kind === 'manual') vh.append(renderManualView(S.view.data));
        else if (S.view.kind === 'merge') vh.append(renderMergeView(S.view.data));
        vh.scrollTop = scroll;
      } else {
        vh.replaceChildren();
      }
    }
    if (isDiff) renderDiffPane();
  }

  // ---------- просмотр в Monaco DiffEditor (этап C, §19) ----------
  // Разделение ответственности: ui/editor.js владеет экземпляром DiffEditor и моделями
  // (showDiff/hideDiff), app.js — данными и действиями (что сравниваем, какие кнопки).
  // Авторитетный дифф для решений о записи — src/diff.js в main; Monaco здесь только
  // отрисовка, поэтому сбой DiffEditor деградирует в HTML-отчёт, а не в потерю данных.

  /** Можно ли показать просмотр Monaco-диффом: нужны оба текста целиком. */
  function diffCapable(kind, d) {
    if (!d) return false;
    if (kind === 'proposal') {
      if (!['update', 'create', 'delete'].includes(d.op)) return false; // move — отчёт с пояснениями
      if (typeof d.newText !== 'string') return false;          // patch-failed/open — сравнивать нечего
      return d.op === 'create' || typeof d.baseText === 'string';
    }
    if (kind === 'manual') return d.diverged === true && typeof d.baseText === 'string' && typeof d.currentText === 'string';
    if (kind === 'history') return !d.missingBackup && typeof d.beforeText === 'string' && typeof d.afterText === 'string';
    return false; // merge — разметка конфликтов, всегда текстовый отчёт
  }

  // ---------- просмотр предложения по ханкам (этап C, §20–§22) ----------
  //
  // Правила одни и покрыты node-тестами (src/hunks.js): ханки и слияние считает он,
  // а не воркер Monaco — решение о том, какой текст попадёт в буфер, не может зависеть
  // от асинхронной отрисовки. Monaco здесь только показывает результат.
  const H = window.WhaleHunks;
  const D = window.WhaleDiff;

  /**
   * База слияния — всегда версия, которую видела модель (§22), а не диск и не последняя
   * операция Whale Bridge. Берём снимок из журнала контекста; если снимка нет, но файл
   * с тех пор не менялся (aiBaseHash === baseHash), диск и есть база. Иначе базы нет —
   * и частичное принятие честно запрещается: сливать не с чем.
   */
  function mergeBaseFor(d) {
    if (typeof d.aiBaseText === 'string') return { text: d.aiBaseText, source: 'ai' };
    if (d.aiBaseHash && d.baseHash && d.aiBaseHash === d.baseHash && typeof d.baseText === 'string') {
      return { text: d.baseText, source: 'disk-equals-ai' };
    }
    return null;
  }

  /** Выбор ханков: Set индексов. Сбрасывается при смене предложения/базы. */
  function hunkSelection() {
    return S.hunkSel || (S.hunkSel = new Set());
  }

  function computeHunks(d) {
    const base = mergeBaseFor(d);
    if (!base || typeof d.newText !== 'string') { S.hunks = null; S.hunkBase = null; return; }
    if (S.hunkBase && S.hunkBase.id === d.id && S.hunkBase.baseText === base.text && S.hunkBase.newText === d.newText) return;
    S.hunks = H ? H.toHunks(base.text, d.newText, 3) : null;
    S.hunkBase = { id: d.id, baseText: base.text, newText: d.newText };
    const sel = hunkSelection();
    sel.clear();
    // По умолчанию отмечены все ханки: «принять всё» должно остаться одним нажатием
    for (const hk of S.hunks || []) sel.add(hk.index);
    // Предложение уже принимали в буфер — восстанавливаем прежний выбор, чтобы повторное
    // открытие диффа не предлагало заново то, что пользователь уже отметил.
    const ed = window.WhaleEditor;
    const staged = ed && ed.stagedProposals ? ed.stagedProposals().get(d.id) : null;
    if (staged && Array.isArray(staged.hunkIndexes) && S.hunks) {
      const valid = staged.hunkIndexes.filter((i) => i >= 0 && i < S.hunks.length);
      if (valid.length) { sel.clear(); for (const i of valid) sel.add(i); }
    }
  }

  /** База модели с применёнными ВЫБРАННЫМИ ханками — сторона «их» для трёхстороннего слияния. */
  function selectedText(d) {
    const base = mergeBaseFor(d);
    if (!base || !S.hunks || !S.hunks.length) return null;
    return H.applySelection(base.text, S.hunks, hunkSelection(), /(\r\n|\n)$/.test(d.newText));
  }

  /** Текст, который окажется в буфере при текущем выборе. null — слияние не удалось. */
  function mergedPreview(oursText, d) {
    const base = mergeBaseFor(d);
    const theirs = selectedText(d);
    if (!base || theirs == null) return null;
    return H.merge3(base.text, oursText, theirs);
  }

  /**
   * Принять выбранные ханки В БУФЕР редактора (§20): файл становится dirty, на диск
   * изменения уйдут только по Ctrl+S — тем же путём, что и ручные правки.
   * @param {boolean} andSave сразу сохранить (кнопка «Принять и сохранить»)
   */
  async function acceptHunks(d, andSave) {
    if (!S.hunks || !S.hunks.length) return;
    const sel = hunkSelection();
    if (!sel.size) { toast('Не выбрано ни одного изменения', 'err'); return; }
    if (!S.project) { toast('Чат не привязан к проекту', 'err'); return; }
    const ed = window.WhaleEditor;
    if (!ed || !ed.acceptIntoBuffer) { toast('Редактор недоступен', 'err'); return; }

    const ours = ed.getText(d.relPath);
    const oursText = typeof ours === 'string' ? ours : await readDiskText(d);
    if (typeof oursText !== 'string') { toast('Не удалось прочитать текущую версию файла', 'err'); return; }

    const merged = mergedPreview(oursText, d);
    if (!merged) { toast('Слияние невозможно: нет версии, которую видела модель', 'err'); return; }
    if (!merged.ok) {
      // §22: пересечение принятых ханков с правками пользователя. Ничего не пишем —
      // показываем конфликт и его стороны, решение остаётся за пользователем.
      const theirs = selectedText(d);
      const ops = D ? D.diffLines(oursText, theirs) : null;
      S.view = {
        kind: 'merge',
        data: {
          ...d, mergedText: merged.text, conflicts: merged.conflicts, oursText,
          conflictRows: ops ? D.toRows(ops, 3) : [],
          conflictStats: ops ? D.diffStats(ops) : null,
        },
      };
      S.viewPane = 'details';
      render();
      toast(`Изменения пересекаются с вашими правками: конфликтов ${merged.conflicts}. В буфер ничего не записано.`, 'err');
      return;
    }

    const total = S.hunks.length;
    const accepted = sel.size;
    const ok = await ed.acceptIntoBuffer(S.project.id, d.relPath, merged.text, {
      proposalId: d.id,
      contentHash: d.contentHash,
      acceptedHunks: accepted,
      totalHunks: total,
      hunkIndexes: [...sel].sort((a, b) => a - b),
      // Текст предложения целиком: main сравнит его с сохранённым и только при точном
      // совпадении отметит, что модель знает версию (честный учёт контекста).
      proposedText: accepted === total ? d.newText : null,
    });
    if (!ok) { toast('Не удалось открыть файл в редакторе', 'err'); return; }

    if (andSave) {
      const saved = await ed.saveActive();
      if (saved) {
        // main уже отметил предложение применённым (markAppliedExternally) и решил
        // честное правило контекста — закрываем просмотр и обновляем список
        S.view = null;
        await loadProposals();
      }
      return; // ошибка/конфликт сохранения уже показаны редактором
    }
    toast(accepted === total
      ? 'Предложение принято в буфер редактора. Сохраните (Ctrl+S), чтобы записать на диск.'
      : `Принято изменений: ${accepted} из ${total}. Файл в буфере — сохраните (Ctrl+S) для записи на диск.`, 'ok');
    await loadProposals(); // карточка получает отметку «в буфере», счётчик обновляется
  }

  /** Текущий текст файла на диске (когда файл не открыт в редакторе). */
  async function readDiskText(d) {
    if (!S.project || !d.relPath) return null;
    const r = await call('file:read', { projectId: S.project.id, path: d.relPath });
    return r && r.ok ? r.content : null;
  }

  async function renderDiffPane() {
    if (!S.view) return;
    const kind = S.view.kind;
    const d = S.view.data;
    if (kind === 'proposal' && d.op === 'update') computeHunks(d);
    else { S.hunks = null; S.hunkBase = null; }

    const pair = await diffPair(kind, d);
    renderDiffBar(kind, d, pair);
    renderDiffNotices(kind, d);
    renderHunkStrip(d);
    if (!pair) { S.viewPane = 'details'; render(); return; }
    const sig = [kind, d.id || d.relPath, S.diffBase,
      pair.original.length, pair.modified.length,
      pair.original.slice(0, 64), pair.modified.slice(0, 64),
      pair.original.slice(-64), pair.modified.slice(-64)].join('::');
    if (sig === lastDiffSig) return;
    lastDiffSig = sig;
    const ok = window.WhaleEditor && window.WhaleEditor.showDiff ? await window.WhaleEditor.showDiff(pair) : false;
    if (!ok && S.view && S.viewPane === 'diff') {
      // Monaco не поднялся или разметка старая — показываем подробный отчёт с текстовым диффом
      lastDiffSig = null;
      S.viewPane = 'details';
      render();
    }
  }

  /**
   * Обе стороны диффа + подписи. null — пары нет, просмотр уходит в текстовый отчёт.
   *
   * Режимы (§19): «результат» — ваш буфер против того, что получится после принятия
   * выбранных ханков (живой предпросмотр); «предложение» — база модели против её текста.
   */
  async function diffPair(kind, d) {
    const lang = (rel) => (window.WhaleMonaco ? window.WhaleMonaco.languageForPath(rel) : 'plaintext');
    if (kind === 'proposal') {
      if (typeof d.newText !== 'string') return null;
      if (S.diffBase === 'ai') {
        const base = mergeBaseFor(d);
        const original = d.op === 'create' ? '' : (base ? base.text : d.baseText);
        if (typeof original !== 'string') return null;
        return {
          original, modified: d.newText, language: lang(d.relPath),
          leftLabel: d.op === 'create' ? 'Файла ещё нет' : (base ? 'Версия, которую видела модель' : 'Текущий файл на диске'),
          rightLabel: 'Предложение модели',
        };
      }
      const ed = window.WhaleEditor;
      const ours = ed && ed.getText ? ed.getText(d.relPath) : null;
      const oursText = typeof ours === 'string' ? ours : (d.op === 'create' ? '' : await readDiskText(d));
      if (typeof oursText !== 'string') return null;
      const preview = mergedPreview(oursText, d);
      return {
        original: oursText,
        modified: preview && preview.ok ? preview.text : d.newText,
        language: lang(d.relPath),
        leftLabel: 'Ваш файл сейчас',
        rightLabel: preview && preview.ok
          ? (hunkSelection().size === (S.hunks || []).length ? 'Результат принятия' : 'Результат: выбранные изменения')
          : 'Предложение модели',
      };
    }
    if (kind === 'manual') {
      if (typeof d.baseText !== 'string' || typeof d.currentText !== 'string') return null;
      return {
        original: d.baseText, modified: d.currentText, language: lang(d.relPath),
        leftLabel: d.base === 'backup' ? 'Версия после последней операции (приближение)' : 'Версия, которую знает модель',
        rightLabel: 'Текущий файл на диске',
      };
    }
    if (kind === 'history') {
      if (typeof d.beforeText !== 'string' || typeof d.afterText !== 'string') return null;
      return {
        original: d.beforeText, modified: d.afterText, language: lang(d.relPath),
        leftLabel: 'До операции', rightLabel: 'После операции',
      };
    }
    return null;
  }

  /** Шапка диффа: заголовок, бейджи, легенда, переключатель режима и действия. */
  function renderDiffBar(kind, d, pair) {
    const bar = $('#diff-bar');
    if (!bar) return;
    const icon = kind === 'proposal' ? (d.op === 'create' ? '➕' : d.op === 'delete' ? '🗑' : '🔍') : kind === 'manual' ? '✎' : '🕘';
    const title = kind === 'proposal'
      ? (d.op === 'create' ? 'Создание файла' : d.op === 'delete' ? 'Удаление файла' : 'Предложение модели')
      : kind === 'manual' ? 'Мои правки' : 'Операция истории';

    const head = h('div', { class: 'diff-bar-row' },
      h('div', { class: 'diff-title' }, `${icon} ${title}`, h('span', { class: 'path', title: d.relPath || '' }, d.relPath || '')),
      d.stats && h('span', { class: 'badge add' }, '+' + (d.stats.added ?? 0)),
      d.stats && h('span', { class: 'badge del' }, '−' + (d.stats.removed ?? 0)),
      kind === 'proposal' && h('span', { class: 'badge' + (STATE_BAD.has(d.state) ? ' bad' : '') }, STATE_LABEL[d.state] || d.state),
      kind === 'proposal' && d.mode === 'patch' && d.patchBlocks > 0 && h('span', { class: 'badge' }, `частичная правка · ${d.patchBlocks}`),
      kind === 'proposal' && d.warnings > 0 && h('span', { class: 'badge warn' }, 'возможно неполный код'),
      kind === 'proposal' && d.manualChanged && h('span', { class: 'badge warn', title: 'Файл на диске изменился после того, как модель его видела' }, 'изменён вручную'),
      kind === 'manual' && d.base === 'backup' && h('span', { class: 'badge warn', title: d.notice || '' }, 'база — приближение'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn ghost tiny', title: 'Закрыть просмотр', onclick: closeView }, '✕'));

    const legend = pair && h('div', { class: 'diff-bar-row' },
      h('div', { class: 'diff-legend' },
        h('span', { class: 'side' }, h('span', { class: 'swatch old' }), pair.leftLabel),
        h('span', { class: 'side' }, h('span', { class: 'swatch new' }), pair.rightLabel),
        h('span', { class: 'grow' }),
        kind === 'proposal' && d.op === 'update' && h('button', {
          class: 'btn tiny',
          title: S.diffBase === 'ai'
            ? 'Показать, что изменится в вашем файле'
            : 'Показать базу, которую видела модель, против её предложения',
          onclick: () => { S.diffBase = S.diffBase === 'current' ? 'ai' : 'current'; lastDiffSig = null; render(); },
        }, S.diffBase === 'current' ? 'Сравнение: ваш файл → результат' : 'Сравнение: версия модели → предложение')));

    const actions = h('div', { class: 'diff-bar-row' });
    if (kind === 'proposal') {
      const canApply = d.status === 'pending' && ['update', 'create', 'delete'].includes(d.state);
      const risky = (d.incomplete && d.incomplete.length > 0) || !!d.shrink;
      const sel = hunkSelection();
      const total = (S.hunks || []).length;
      if (canApply && d.op === 'update' && total > 0) {
        // §20: принятие по ханкам — в буфер редактора, на диск только по Ctrl+S
        const blocked = risky && !S.allowIncomplete;
        actions.append(
          h('button', {
            class: 'btn primary', disabled: !sel.size || blocked,
            title: blocked
              ? 'Ответ похож на неполный — сначала подтвердите, что проверили Diff'
              : `Принять выбранные изменения (${sel.size} из ${total}) в буфер редактора`,
            onclick: () => acceptHunks(d, false),
          }, sel.size === total ? `Принять все (${total}) в буфер` : `Принять выбранные (${sel.size}/${total})`),
          h('button', {
            class: 'btn', disabled: !sel.size || blocked,
            title: 'Принять в буфер и сразу записать на диск',
            onclick: () => acceptHunks(d, true),
          }, 'Принять и сохранить'),
          h('button', { class: 'btn', title: 'Закрыть предложение и убрать из списка', onclick: () => onReject(d) }, 'Отклонить'));
      } else if (canApply) {
        // Создание/удаление в буфере невыразимы — прямая операция на диске (с защитой SHA).
        // Update без базы слияния (снимка нет, а файл менялся) — тоже прямое применение
        // целиком: частичное принятие без базы было бы нечестным.
        const label = d.op === 'delete' ? 'Удалить в корзину'
          : d.op === 'create' ? (d.needsDirs ? 'Создать папки и файл' : 'Создать файл')
            : 'Принять целиком (перезаписать файл)';
        actions.append(h('button', {
          class: 'btn' + (d.op === 'update' ? ' danger-subtle' : ' primary'),
          disabled: risky && !S.allowIncomplete,
          title: d.op === 'update' ? 'Версия модели не сохранена — безопасное слияние невозможно; файл будет перезаписан предложением (проверьте Diff)' : null,
          onclick: () => onApply(d),
        }, label));
        actions.append(h('button', { class: 'btn', title: 'Закрыть предложение и убрать из списка', onclick: () => onReject(d) }, 'Отклонить'));
      }
      if (d.status === 'applied' && d.historyId) {
        actions.append(h('button', { class: 'btn', onclick: () => onRevert(d.historyId) }, 'Восстановить предыдущую версию'));
      }
      if (d.status === 'pending' && isStaged(d.id)) {
        actions.append(h('span', {
          class: 'badge', style: 'border-color: var(--accent); color: var(--accent)',
          title: 'Изменения уже приняты в буфер редактора и ждут сохранения',
        }, 'принято в буфер'));
      }
    } else if (kind === 'manual') {
      actions.append(
        h('button', { class: 'btn', title: COPY_TITLE, onclick: copyManualVersions }, 'Скопировать изменения для модели'),
        d.diverged && h('button', { class: 'btn primary', onclick: () => ackManual(d.relPath) }, '✓ Модель проинформирована'),
        S.project && h('button', { class: 'btn', onclick: () => openFile(S.project.id, d.relPath) }, 'Открыть файл'));
    } else if (kind === 'history') {
      if (d.status === 'applied' && d.revertible !== false && !(d.pruned && d.op !== 'create')) {
        actions.append(h('button', { class: 'btn', onclick: () => onRevert(d.id) }, 'Восстановить предыдущую версию'));
      }
    }

    // filter(Boolean): legend может отсутствовать (нет пары текстов) — реальный DOM
    // превратил бы null в текстовый узел «null»
    bar.replaceChildren(...[head, legend, actions].filter(Boolean));
  }

  /** Предложение уже принято в буфер редактора и ждёт Ctrl+S. */
  function isStaged(proposalId) {
    const ed = window.WhaleEditor;
    return !!(ed && ed.stagedProposals && ed.stagedProposals().has(proposalId));
  }

  /**
   * Предупреждения над диффом. Отдельного режима «Подробности» больше нет — он дублировал
   * дифф (ручная проверка 0015), поэтому всё существенное живёт здесь компактно.
   */
  function renderDiffNotices(kind, d) {
    const box = $('#diff-notices');
    if (!box) return;
    const out = [];
    const risky = kind === 'proposal' && ((d.incomplete && d.incomplete.length > 0) || !!d.shrink);
    if (risky) {
      out.push(h('div', { class: 'notice warn' },
        h('div', {}, 'Ответ похож на неполный. Обычное применение заблокировано, пока вы не подтвердите его вручную.'),
        d.shrink && h('div', { class: 'path' }, d.shrink),
        d.incomplete && d.incomplete.length > 0 && h('ul', {}, d.incomplete.slice(0, 6).map((x) => h('li', {}, `строка ${x.line}: ${x.text}`))),
        h('label', { class: 'check' },
          h('input', {
            type: 'checkbox', checked: S.allowIncomplete,
            onchange: (e) => { S.allowIncomplete = e.target.checked; render(); },
          }),
          'Я проверил(а) Diff и всё равно хочу применить')));
    }
    if (kind === 'proposal' && d.op === 'update' && !S.hunks && d.status === 'pending') {
      out.push(h('div', { class: 'notice warn' },
        'Версия, которую видела модель, не сохранена (снимка нет, а файл с тех пор изменился) — ',
        'принять отдельные изменения нельзя: сливать не с чем. «Принять целиком» перезапишет файл ',
        'предложением (запись защищена проверкой SHA-256). Безопаснее передать модели актуальную ',
        'версию («Скопировать изменения для модели» в панели файлов) и попросить повторить правку.'));
    }
    if (kind === 'proposal' && d.patchResults && d.patchResults.length) {
      out.push(h('details', { class: 'notice' },
        h('summary', {}, `Частичная правка: блоков ${d.patchResults.length}`),
        h('ul', {}, d.patchResults.map((r, i) => h('li', {}, patchLine(r, i))))));
    }
    if (kind === 'proposal' && d.pathFixed) {
      out.push(h('div', { class: 'notice' }, `Путь исправлен автоматически: «${d.pathFixed.from}» → «${d.pathFixed.to}» (ИИ добавил имя корневой папки проекта).`));
    }
    if (kind === 'proposal' && d.toPathFixed) {
      out.push(h('div', { class: 'notice' }, `Путь назначения исправлен автоматически: «${d.toPathFixed.from}» → «${d.toPathFixed.to}».`));
    }
    if (kind === 'proposal' && d.needsDirs) {
      out.push(h('div', { class: 'notice' }, 'Папки для этого файла ещё не существуют — они будут созданы при применении.'));
    }
    if (kind === 'proposal' && d.op === 'delete') {
      out.push(h('div', { class: 'notice warn' }, 'Файл будет отправлен в системную корзину. До удаления создаётся резервная копия, поэтому операцию можно откатить из Истории.'));
    }
    if (kind === 'manual' && d.notice) out.push(h('div', { class: 'notice warn' }, d.notice));
    if (kind === 'manual' && d.knownVersion) {
      out.push(h('div', { class: 'notice' }, `Известная модели версия: ${fmtTime(d.knownVersion.ts)} · ${d.knownVersion.label}`));
    }
    box.replaceChildren(...out);
  }

  /** Список ханков с чекбоксами (§20). Выбор сразу пересчитывает предпросмотр диффа. */
  function renderHunkStrip(d) {
    const strip = $('#hunk-strip');
    if (!strip) return;
    const hunks = S.hunks || [];
    if (!hunks.length || !(d && d.status === 'pending')) {
      strip.replaceChildren();
      strip.classList.add('hidden');
      return;
    }
    const sel = hunkSelection();
    const setAll = (on) => {
      sel.clear();
      if (on) for (const hk of hunks) sel.add(hk.index);
      lastDiffSig = null;
      render();
    };
    const toggle = (idx, on) => {
      if (on) sel.add(idx); else sel.delete(idx);
      lastDiffSig = null;
      render();
    };
    strip.classList.remove('hidden');
    strip.replaceChildren(
      h('div', { class: 'hunk-head' },
        h('span', {}, `Изменений: ${hunks.length}`),
        h('span', { class: 'grow' }),
        h('span', { class: 'path' }, `выбрано ${sel.size}`),
        h('button', { class: 'btn ghost tiny', onclick: () => setAll(true) }, 'Все'),
        h('button', { class: 'btn ghost tiny', onclick: () => setAll(false) }, 'Снять')),
      ...hunks.map((hk) => h('label', { class: 'hunk' + (sel.has(hk.index) ? ' on' : '') },
        h('input', {
          type: 'checkbox', checked: sel.has(hk.index),
          onchange: (e) => toggle(hk.index, e.target.checked),
        }),
        h('span', { class: 'hunk-loc' }, `стр ${hk.baseLineStart}–${hk.baseLineEnd}`),
        hk.added > 0 && h('span', { class: 'badge add' }, '+' + hk.added),
        hk.removed > 0 && h('span', { class: 'badge del' }, '−' + hk.removed),
        h('span', { class: 'hunk-snip', title: hk.snippet }, hk.snippet))));
  }

  /** Из подробного отчёта — обратно в Monaco-дифф (кнопка «◧ Diff»). */
  function backToDiff() {
    S.viewPane = 'diff';
    lastDiffSig = null;
    render();
  }

  /** Содержимое панели «Промпт». Пусто, пока панель закрыта. */
  function renderPromptPanel() {
    const root = $('#prompt-body');
    if (!root) return;
    if (!S.layout.promptOpen) { root.replaceChildren(); return; }
    const scroll = root.scrollTop;
    root.replaceChildren(renderPrompt());
    root.scrollTop = scroll;
  }

  // ---------- геометрия раскладки (этап B, ТЗ §4, §28) ----------
  // Раскладку определяет CSS: размеры панелей живут в CSS-переменных, а чат занимает
  // ровно прямоугольник #chat-slot. Renderer наблюдает за слотом через ResizeObserver
  // и отправляет измеренные bounds в main (chat:set-bounds, fire-and-forget), а main
  // просто кладёт туда WebContentsView. Никакого ratio в main больше нет.
  //
  // Чат ВСЕГДА справа: переключатель стороны существовал в 0012–0013 и удалён по итогам
  // ручной проверки — перестановка колонок ломала рендер нативного слоя. Меньше
  // подвижных частей: сторона фиксирована, остаётся только ширина.

  let chatHidden = false; // пока чат скрыт, bounds не шлём: геометрия применяется на отпускании

  function setChatVisible(v) {
    chatHidden = !v;
    if (api.send) api.send('chat:set-visible', v);
  }

  function sendChatBounds() {
    if (!api.send) return;
    const slot = $('#chat-slot');
    if (!slot || typeof slot.getBoundingClientRect !== 'function') return;
    // getBoundingClientRect отдаёт CSS-пиксели, а setBounds работает в DIP: при zoom ≠ 1
    // делим на коэффициент (штатно zoom не меняется, но в меню «Вид» он есть)
    const zoom = (typeof api.zoomFactor === 'function' && api.zoomFactor()) || 1;
    const r = slot.getBoundingClientRect();
    const rect = L.normalizeRect({ x: r.x / zoom, y: r.y / zoom, width: r.width / zoom, height: r.height / zoom });
    if (rect) api.send('chat:set-bounds', rect);
  }

  // Размер слота изменился (разделитель, resize окна, maximize, высота шапки) → новые
  // bounds. ResizeObserver сам приходит не чаще кадра, поэтому отдельный троттлинг не
  // нужен — важно лишь не дёргать setBounds у скрытого чата.
  (function observeChatSlot() {
    const slot = $('#chat-slot');
    if (!slot || typeof ResizeObserver === 'undefined' || !api.send) return;
    new ResizeObserver(() => { if (!chatHidden) sendChatBounds(); }).observe(slot);
  })();

  (function initSplitters() {
    let drag = null; // {which, startX, startLayout}
    let saveTimer = null;
    // Сохраняем размеры в config.json. После отпускания разделителя — сразу: отложенное
    // сохранение могло бы проиграть гонку внезапно пришедшему chat:changed, который
    // перечитывает сохранённую раскладку и вернул бы панели на старое место.
    const saveLayout = () => { clearTimeout(saveTimer); call('layout:save', { layout: S.layout }); };
    // Для непрерывных событий (resize окна) — с задержкой, чтобы не писать конфиг каждый кадр
    const saveLayoutSoon = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => call('layout:save', { layout: S.layout }), 400);
    };

    function setup(which, sel) {
      const el = $(sel);
      if (!el || !el.addEventListener) return;
      el.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        drag = { which, startX: e.clientX, startLayout: { ...S.layout } };
        // Захват указателя: движение мыши приходит самому разделителю, даже когда
        // курсор ушёл далеко в сторону (проверено практикой прежнего разделителя).
        if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
        el.classList.add('drag');
        // Только чатовый разделитель: WebContentsView проглатывает события мыши,
        // поэтому на время перетаскивания чат скрываем, а геометрию применяем на
        // отпускании. Разделитель левой панели чат не трогает — editor поглощает.
        if (which === 'chat') setChatVisible(false);
        if (e.preventDefault) e.preventDefault();
      });
      el.addEventListener('pointermove', (e) => {
        if (!drag || drag.which !== which) return;
        S.layout = L.drag(drag.startLayout, which, e.clientX - drag.startX, window.innerWidth);
        applyLayout();
      });
      const end = () => {
        if (!drag || drag.which !== which) return;
        drag = null;
        el.classList.remove('drag');
        if (which === 'chat') {
          // Сначала bounds, потом показ: main запоминает rect и повторно применяет его
          // при setVisible(true), поэтому чат появляется уже с новой шириной.
          sendChatBounds();
          setChatVisible(true);
          setTimeout(sendChatBounds, 150); // страховка от залипшего нативного слоя
        }
        // Monaco пересчитывает размеры сам (automaticLayout), но явный layout() после
        // перетаскивания — дешёвая страховка: spike показал, что в Grid он иногда «залипает».
        if (window.WhaleEditor.layout) window.WhaleEditor.layout();
        saveLayout();
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    }
    setup('left', '#vsplit-left');
    setup('chat', '#vsplit-chat');

    // Окно стало уже: панели ужимаются в порядке left → chat (ui/layout.js), ширина чата
    // не превышает 60% окна. Сохраняем ширины с задержкой.
    if (window.addEventListener) {
      window.addEventListener('resize', () => {
        const fitted = L.fitToWindow(S.layout, window.innerWidth);
        if (fitted.leftW !== S.layout.leftW || fitted.chatW !== S.layout.chatW) {
          S.layout = fitted;
          applyLayout();
          saveLayoutSoon();
        }
      });
    }
  })();

  // Крестик панели «Промпт» — статичный узел разметки, привязываем один раз.
  // В отличие от переключателя в шапке, крестик закрывает «Промпт» совсем.
  (function bindPromptClose() {
    const btn = $('#prompt-close');
    if (btn && btn.addEventListener) btn.addEventListener('click', () => closePrompt());
  })();

  // ---------- события от главного процесса ----------
  api.on('chat:changed', loadState);
  api.on('projects:changed', loadState);
  api.on('project:auto-bound', async ({ project }) => { toast(`Привязан ${project.name} · Изменить`, 'ok'); await loadState(); });
  api.on('files:changed', async () => {
    // Порядок важен: сначала данные, потом перерисовка. Журнал контекста и история
    // обновляются ДО отрисовки дерева — иначе отметки рисуются по прежним данным и
    // залипают до следующей перерисовки (так уже было: снятие предупреждения не видно).
    await loadHistory(); // внутри вызывает loadContext()
    const ed = window.WhaleEditor;
    if (ed) {
      if (ed.refreshTree) await ed.refreshTree(); // дерево переехало в редактор (этап B)
      // Файл мог измениться под открытым буфером: обновляем diskHash, чтобы Ctrl+S
      // вовремя показал конфликт (§11), а не перезаписал чужие правки.
      await ed.refreshDisk();
    }
    if (P.loaded && S.project) { // дерево в генераторе промпта обновляем «на месте», не трогая поля ввода
      P.tree = await call('prompt:tree', { projectId: S.project.id });
      paintPromptTree();
      refreshPreview();
    }
    const v = S.view;
    if (v && v.kind === 'proposal' && v.data.status === 'pending') { // открытый Diff пересчитываем по свежему файлу
      const d = await call('proposal:get', { id: v.data.id });
      if (d && S.view && S.view.data.id === d.id) S.view.data = d;
    }
    // Форма «Промпта» живёт в своей панели и render() не пересобирается — фокус не теряется
    render();
  });
  api.on('proposals:changed', async () => {
    if (S.view) { // открытый Diff не перерисовываем, но данные списка, счётчик и дерево обновляем
      S.proposals = (await call('proposals:list', { includeHistorical: S.showHistorical })) || [];
      renderTabs();
      pushTreeExtras();
      return;
    }
    await loadProposals();
  });

  // Редактор монтируется один раз и живёт независимо от перерисовок (§7).
  // Если разметки редактора нет (старый index.html или тестовый стенд) — просто не включаем его.
  (function mountEditor() {
    if (!window.WhaleEditor) return;
    const edEls = {
      tree: $('#ed-tree'), tabs: $('#ed-tabs'), host: $('#ed-host'),
      empty: $('#ed-empty'), status: $('#ed-status'), overlay: $('#ed-overlay'),
      // узлы Monaco DiffEditor (этап C): необязательные — без них showDiff вернёт false
      // и просмотр деградирует в подробный отчёт с текстовым диффом
      diffBar: $('#diff-bar'), diffEditor: $('#diff-editor'),
    };
    for (const k of Object.keys(edEls)) if (!edEls[k]) return;
    window.WhaleEditor.mount(edEls, {
      toast,
      // несохранённые правки видны и на вкладках вне редактора — обновляем счётчик/заголовки
      onDirtyChange: () => { renderTabs(); },
      // Пользователь открыл файл (клик в дереве, Ctrl+P) — панель редактора должна
      // показать код, даже если сейчас открыт «Промпт» или просмотр предложения.
      onWantEditorMode: () => {
        if (S.panel === 'editor' && !S.view) return;
        S.view = null;
        S.panel = 'editor';
        if (S.layout.promptOpen) {
          S.layout = { ...S.layout, promptOpen: false };
          call('layout:save', { layout: S.layout });
        }
        render();
      },
    });
    pushTreeExtras();
    renderEditorArea(); // начальный режим панели: редактор (или «Промпт», если был открыт)
  })();

  loadState();
})();

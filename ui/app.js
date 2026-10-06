(() => {
  'use strict';
  const api = window.api;

  // ---------- утилиты (только textContent, никакого innerHTML с чужими данными) ----------
  // h() один на весь renderer — см. ui/dom.js. Здесь только алиас, чтобы не переписывать
  // сотни вызовов; семантика прежняя, плюс разворачиваются вложенные массивы любой глубины
  // (так и работает настоящий ParentNode.append()).
  const h = window.WhaleDom.h;
  const $ = (s) => document.querySelector(s);
  const base = (p) => p.split('/').pop();
  const fmtBytes = (n) => (n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(1) + ' КБ' : (n / 1048576).toFixed(1) + ' МБ');
  const uid = () => 'u' + Math.random().toString(36).slice(2, 10);
  const fmtTime = (ts) => new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

  let toastTimer;
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
    tab: 'proposals', proposals: [], showHistorical: false,
    view: null, // {kind:'proposal'|'history', data}
    tree: {}, expanded: new Set(), history: [], showFull: false, allowIncomplete: false,
    backup: { files: 0, bytes: 0 },
    manual: [],
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
    document.documentElement.style.setProperty('--chat-w', st.ratio * 100 + '%');
    if (projectChanged) {
      S.tree = {}; S.expanded = new Set(); P.loaded = false;
      // Открытые файлы не закрываем: у каждого свой projectId, сохранение идёт в свой проект.
      if (window.WhaleEditor) window.WhaleEditor.setProject(S.project);
    }
    if (chatChanged) { S.view = null; S.allowIncomplete = false; }
    await loadProposals();
    if (projectChanged && S.tab === 'prompt' && !S.view) { // дерево и исключения принадлежат проекту
      await loadPrompt();
      render();
    }
  }

  async function closeView() {
    S.view = null;
    if (S.tab === 'history') await loadHistory();
    await loadProposals();
  }

  async function loadProposals() {
    S.proposals = (await call('proposals:list', { includeHistorical: S.showHistorical })) || [];
    await loadHistory();
    // На вкладке «Промпт» форму не пересобираем (пропал бы фокус в текстовом поле) — обновляем только шапку и счётчики
    if (S.tab === 'prompt' && !S.view) softRender();
    else render();
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

  function renderTabs() {
    const pending = S.proposals.filter((p) => p.status === 'pending' && !p.historical).length;
    const tabs = [['editor', 'Редактор'], ['proposals', 'Предложения'], ['files', 'Файлы'], ['history', 'История'], ['prompt', 'Промпт']];
    $('#tabs').replaceChildren(
      ...tabs.map(([id, label]) =>
        h('button', { class: 'tab' + (S.tab === id ? ' on' : ''), onclick: () => switchTab(id) },
          label, id === 'proposals' && pending > 0 && h('span', { class: 'count' }, pending))));
  }
  async function switchTab(id) {
    S.tab = id;
    S.view = null;
    if (id === 'history') await loadHistory();
    if (id === 'files') S.manual = S.project ? ((await call('manual:list', { projectId: S.project.id })) || []) : [];
    render();
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
        h('button', { class: 'btn', onclick: async () => { const r = await call('proposals:report'); if (r?.ok) toast('Отчёт скопирован. Вставьте его в чат.', 'ok'); else if (r) toast(r.error, 'err'); } }, 'Скопировать отчёт для чата'),
        h('button', { class: 'btn', title: 'Составить промпт с правилами формата — вкладка «Промпт»', onclick: () => switchTab('prompt') }, 'Промпт для ИИ')));

    if (!S.chatId) {
      box.append(h('div', { class: 'empty' }, 'Откройте чат слева или отправьте первое сообщение — предложения изменений появятся здесь.'));
      return box;
    }
    if (!S.project) {
      box.append(h('div', { class: 'notice warn' }, 'Привяжите этот чат к локальному проекту (список вверху), иначе изменения не с чем сравнивать.'));
    }
    if (!S.proposals.length) {
      box.append(h('div', { class: 'empty' },
        h('div', {}, 'Пока нет предложений.'),
        h('div', {}, 'Составьте промпт во вкладке «Промпт» и отправьте его ИИ: он научит модель маркерам # &путь, замене функций (REPLACE_BLOCK) и блокам SEARCH/REPLACE.')));
      return box;
    }
    const versions = {};
    for (const p of S.proposals) if (p.status === 'pending' && !p.historical) versions[p.relPath] = (versions[p.relPath] || 0) + 1;
    for (const p of S.proposals) box.append(proposalCard(p, versions[p.relPath] || 0));
    return box;
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
        h('button', { class: 'btn ghost', style: 'justify-self:start', onclick: closeView }, '← К списку'),
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
    S.view = { kind: 'manual', data: d }; render();
  }
  async function copyManualVersions() {
    if (!S.project) return;
    const r = await call('manual:copy', { projectId: S.project.id });
    // Копирование — ещё не отправка, поэтому отметку сами не ставим
    toast(r?.ok
      ? `Актуальные версии скопированы (${r.files} файлов). Вставьте их в чат и отметьте файлы как известные модели.`
      : r?.error, r?.ok ? 'ok' : 'err');
  }

  /**
   * «Модель проинформирована о текущей версии файла».
   * Отметка хранится как хэш содержимого, поэтому следующее изменение файла снимет её само.
   */
  async function ackManual(relPath) {
    if (!S.project) return;
    const r = await call('manual:ack', { projectId: S.project.id, relPath });
    if (!r) return;
    if (!r.ok) { toast(r.error, 'err'); return; }
    toast('Отмечено: модель знает текущую версию файла', 'ok');
    await loadHistory();
    if (S.view && S.view.kind === 'manual') await openManual(relPath);
    else render();
  }

  async function ackAllManual() {
    if (!S.project || !S.manual.length) return;
    const n = S.manual.length;
    if (!confirm(`Отметить ${n} файл(ов) как известные модели?\n\nОтметка снимется автоматически, если файл снова изменится.`)) return;
    let ok = 0;
    for (const m of S.manual) {
      const r = await call('manual:ack', { projectId: S.project.id, relPath: m.relPath });
      if (r && r.ok) ok++;
    }
    toast(`Отмечено файлов: ${ok} из ${n}`, ok === n ? 'ok' : 'err');
    await loadHistory();
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
    if (r.code === 'merge-conflict') { S.view = { kind: 'merge', data: { ...d, mergedText: r.mergedText, conflicts: r.conflicts } }; render(); return; }
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

  // ---------- вкладка «Файлы» ----------
  async function loadDir(rel) {
    if (!S.project || S.tree[rel] !== undefined) return;
    S.tree[rel] = (await call('fs:list', { projectId: S.project.id, rel })) || { error: 'Ошибка' };
  }

  function treeNodes(rel, depth, out, marks, undo, manual = new Set()) {
    const dir = S.tree[rel];
    if (!dir) return;
    if (dir.error) { out.push(h('div', { class: 'path', style: `padding-left:${depth * 14}px` }, dir.error)); return; }
    for (const it of dir.items) {
      const open = S.expanded.has(it.rel);
      out.push(
        h('div', {
          class: 'node' + (marks.has(it.rel) ? ' has-proposal' : '') + (manual.has(it.rel) ? ' manual-changed' : ''), style: `padding-left:${depth * 14 + 4}px`,
          title: it.isDir ? '' : 'Показать в проводнике',
          onclick: async () => {
            if (it.isDir) {
              if (open) S.expanded.delete(it.rel); else { S.expanded.add(it.rel); await loadDir(it.rel); }
              render();
            } else call('file:open', { projectId: S.project.id, rel: it.rel, mode: 'reveal' });
          },
        },
        h('span', { class: 'twisty' }, it.isDir ? (open ? '▾' : '▸') : ''),
        h('span', {}, it.name),
        // Клик по отметке открывает сравнение и кнопку «модель проинформирована».
        // stopPropagation обязателен: иначе вместе с этим сработает клик по строке дерева
        // (показать файл в проводнике) и откроется окно проводника.
        manual.has(it.rel) && h('button', {
          class: 'manual-warning', type: 'button',
          title: 'Файл изменён вне Whale Bridge — посмотреть отличия и отметить, что модель проинформирована',
          onclick: (e) => { e.stopPropagation(); openManual(it.rel); },
        }, '⚠ изменён'),
        marks.has(it.rel) && h('span', { class: 'dot', title: 'Есть предложение изменений' }),
        undo.has(it.rel) && undoButton(undo.get(it.rel))));
      if (it.isDir && open) treeNodes(it.rel, depth + 1, out, marks, undo, manual);
    }
  }

  function undoButton(entry) {
    const created = entry.op === 'create';
    return h('button', {
      class: 'btn undo',
      title: (created ? 'Удалить файл, созданный приложением' : 'Вернуть версию до последнего изменения') + ' (' + fmtTime(entry.ts) + ')',
      onclick: async (e) => {
        e.stopPropagation();
        if (created && !confirm('Файл был создан приложением. Откат удалит его. Продолжить?')) return;
        await onRevert(entry.id);
      },
    }, '↩ Откатить');
  }

  async function refreshTree() {
    if (!S.project) return;
    const keys = ['', ...S.expanded];
    S.tree = {};
    for (const k of keys) {
      await loadDir(k);
      if (k && S.tree[k] && S.tree[k].error) S.expanded.delete(k); // папку удалили
    }
    if (S.tab === 'files' && !S.view) render();
  }

  function renderFiles() {
    if (!S.project) return h('div', { class: 'empty' }, 'Выберите проект вверху, чтобы увидеть его файлы.');
    const marks = new Set(S.proposals.filter((p) => p.status === 'pending' && !p.historical && p.state !== 'missing').map((p) => p.relPath));
    const manual = new Set(S.manual.map((x) => x.relPath));
    const undo = new Map(); // последняя применённая операция по каждому файлу (история уже отсортирована от новых к старым)
    for (const e of S.history) if (e.status === 'applied' && e.revertible !== false && !(e.pruned && e.op !== 'create') && !undo.has(e.relPath)) undo.set(e.relPath, e);
    const box = h('div', { class: 'stack' },
      h('div', { class: 'toolbar' },
        h('span', { class: 'path grow' }, S.project.path),
        h('button', { class: 'btn', title: 'Дерево обновляется само; кнопка — на всякий случай', onclick: refreshTree }, 'Обновить'),
        manual.size > 0 && h('button', {
          class: 'btn', title: 'Скопировать содержимое файлов, изменённых вне Whale Bridge, чтобы передать его модели',
          onclick: copyManualVersions,
        }, 'Скопировать актуальные версии для модели'),
        manual.size > 0 && h('button', {
          class: 'btn', title: `Снять отметку «модель не знает» со всех ${manual.size} файл(ов)`,
          onclick: ackAllManual,
        }, '✓ Модель знает все')));
    if (S.tree[''] === undefined) {
      loadDir('').then(render);
      box.append(h('div', { class: 'empty' }, 'Загрузка…'));
      return box;
    }
    const nodes = [];
    treeNodes('', 0, nodes, marks, undo, manual);
    box.append(h('div', { class: 'tree' }, nodes));
    return box;
  }

  // ---------- вкладка «История» ----------
  async function loadHistory() {
    S.history = (await call('history:list', { projectId: S.project ? S.project.id : null })) || [];
    S.backup = (await call('backups:stats')) || S.backup;
    S.manual = S.project ? ((await call('manual:list', { projectId: S.project.id })) || []) : [];
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
        h('button', { class: 'btn ghost', style: 'justify-self:start', onclick: closeView }, '← К файлам'),
        h('div', { class: 'view-title' }, 'Мои правки'),
        h('div', { class: 'path' }, d.relPath)),
      h('div', { class: 'notice warn' }, 'Сравнение последней версии после операции Whale Bridge с текущим файлом на диске.'),
      d.synced
        ? h('div', { class: 'notice' }, 'Модель проинформирована об этой версии файла. Если файл снова изменится, отметка снимется сама.')
        : h('div', { class: 'notice warn' }, 'Модель в чате не знает об этом изменении: она может предлагать правки от устаревшей версии. Передайте ей актуальный файл и отметьте его.'),
      diffTable(d.rows, d.truncated),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: copyManualVersions }, 'Скопировать актуальные версии для модели'),
        !d.synced && h('button', { class: 'btn primary', onclick: () => ackManual(d.relPath) }, '✓ Модель проинформирована'),
        h('button', { class: 'btn', onclick: () => openFile(S.project.id, d.relPath) }, 'Открыть файл')));
  }

  function renderMergeView(d) {
    return h('div', {},
      h('div', { class: 'view-head' },
        h('button', { class: 'btn ghost', style: 'justify-self:start', onclick: closeView }, '← К предложению'),
        h('div', { class: 'view-title' }, 'Конфликт merge'),
        h('div', { class: 'path' }, d.relPath)),
      h('div', { class: 'notice bad' }, `Автоматическое слияние не выполнено: конфликтов ${d.conflicts}. Ни одна версия на диске не изменена.`),
      d.conflictRows?.length && h('div', { class: 'stack' },
        h('div', { class: 'path' }, 'DIFF: текущий файл → предложение ИИ'),
        diffTable(d.conflictRows, false)),
      h('div', { class: 'path' }, 'Вариант с маркерами конфликтов:'),
      h('pre', { class: 'code' }, d.mergedText),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: copyManualVersions }, 'Скопировать актуальные версии для модели'),
        h('button', { class: 'btn', onclick: closeView }, 'Назад')));
  }

  function renderHistoryView(d) {
    return h('div', {},
      h('div', { class: 'view-head' },
        h('button', { class: 'btn ghost', style: 'justify-self:start', onclick: closeView }, '← К истории'),
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
    if (S.tab !== 'prompt') return;
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
    render();
  }
  function removeSection(i) {
    P.sections.splice(i, 1);
    touch();
    render();
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
      canReset && h('button', { class: 'btn ghost', title: 'Вернуть текст по умолчанию', onclick: () => { s.text = P.defaults[s.key]; touch(); render(); } }, 'Сбросить'),
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
      if (secs) { P.sections = secs; render(); toast('Пресет загружен', 'ok'); }
    } }, 'Загрузить');
    const delBtn = h('button', { class: 'btn danger', disabled: !P.presetId, onclick: async () => {
      const pr = P.presets.find((x) => x.id === P.presetId);
      if (!pr || !confirm(`Удалить пресет «${pr.name}»?`)) return;
      const list = await call('prompt:preset-delete', { id: P.presetId });
      if (list) { P.presets = list; P.presetId = ''; P.presetName = ''; render(); }
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
      render();
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
        loadPrompt().finally(() => { P.loading = false; if (S.tab === 'prompt' && !S.view) render(); });
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
      h('button', { class: 'btn', onclick: () => { P.sections.push({ id: uid(), key: null, title: 'НОВОЕ ПОЛЕ', text: '', type: 'text' }); touch(); render(); $('#body').scrollTop = 1e6; } }, '＋ Добавить поле'),
      !hasTree && h('button', { class: 'btn', onclick: () => { P.sections.push({ id: uid(), key: 'tree', title: 'СТРУКТУРА ПРОЕКТА', text: '', type: 'tree' }); touch(); render(); } }, '＋ Структура проекта'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn ghost danger', title: 'Вернуть стандартный набор полей и текстов', onclick: async () => {
        if (!confirm('Сбросить все поля к стандартным? Введённые тексты будут потеряны (пресеты останутся).')) return;
        const secs = await call('prompt:reset');
        if (secs) { P.sections = secs; render(); }
      } }, 'Стандартные поля')));

    if (P.preview) box.append(h('pre', { id: 'prompt-preview', class: 'code' }, ''));
    box.append(h('div', { class: 'promptbar' },
      h('button', { class: 'btn primary', onclick: async () => {
        const r = await call('prompt:copy', { sections: P.sections, projectId: S.project ? S.project.id : null });
        if (!r) return;
        toast(r.ok ? `Промпт скопирован (${r.length.toLocaleString('ru-RU')} симв.). Вставьте его в чат.` : r.error, r.ok ? 'ok' : 'err');
      } }, 'Скопировать промпт'),
      h('button', { class: 'btn', title: 'Скопировать короткую памятку о маркерах, Diff и формате кода', onclick: async () => {
        const r = await call('prompt:copy-reminder');
        if (!r) return;
        toast(r.ok ? 'Памятка по формату скопирована. Вставьте её в чат.' : 'Не удалось скопировать памятку.', r.ok ? 'ok' : 'err');
      } }, '⧗ Напомнить формат'),
      h('button', { class: 'btn', onclick: () => { P.preview = !P.preview; render(); } }, P.preview ? 'Скрыть предпросмотр' : 'Предпросмотр'),
      h('span', { id: 'prompt-count', class: 'path' })));
    setTimeout(refreshPreview, 0);
    return box;
  }

  // ---------- отрисовка ----------
  function softRender() {
    renderHead();
    renderTabs();
  }

  /**
   * Редактор живёт в #editor-root ОТДЕЛЬНО от #body: перерисовка вкладок не должна
   * уничтожать Monaco (ТЗ §7). Поэтому панели переключаем классом, а не пересоздаём.
   * Если открыт просмотр (Diff предложения/истории), он важнее — показываем #body.
   */
  function applyTabVisibility() {
    const useEditor = S.tab === 'editor' && !S.view;
    const body = $('#body');
    const root = $('#editor-root');
    if (body) { if (useEditor) body.classList.add('hidden'); else body.classList.remove('hidden'); }
    if (root) { if (useEditor) root.classList.remove('hidden'); else root.classList.add('hidden'); }
    if (window.WhaleEditor) window.WhaleEditor.setVisible(useEditor);
    return useEditor;
  }

  function render() {
    renderHead();
    renderTabs();
    if (applyTabVisibility()) return; // содержимое вкладки «Редактор» рисует ui/editor.js
    const body = $('#body');
    const scroll = body.scrollTop;
    body.replaceChildren();
    if (S.view && S.view.kind === 'proposal') body.append(renderProposalView(S.view.data));
    else if (S.view && S.view.kind === 'history') body.append(renderHistoryView(S.view.data));
    else if (S.view && S.view.kind === 'manual') body.append(renderManualView(S.view.data));
    else if (S.view && S.view.kind === 'merge') body.append(renderMergeView(S.view.data));
    else if (S.tab === 'proposals') body.append(renderProposals());
    else if (S.tab === 'files') body.append(renderFiles());
    else if (S.tab === 'prompt') body.append(renderPrompt());
    else body.append(renderHistory());
    body.scrollTop = scroll;
  }

  // ---------- разделитель панелей ----------
  (function initSplitter() {
    const sp = $('#splitter');
    let active = false;
    let ratio = 0.5;
    sp.addEventListener('pointerdown', async (e) => {
      active = true;
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('drag');
      await call('layout:drag-start');
    });
    sp.addEventListener('pointermove', (e) => {
      if (!active) return;
      ratio = Math.min(0.8, Math.max(0.2, e.clientX / window.innerWidth));
      document.documentElement.style.setProperty('--chat-w', ratio * 100 + '%');
      call('layout:set', { ratio });
    });
    const end = async () => {
      if (!active) return;
      active = false;
      sp.classList.remove('drag');
      await call('layout:drag-end');
    };
    sp.addEventListener('pointerup', end);
    sp.addEventListener('pointercancel', end);
  })();

  // ---------- события от главного процесса ----------
  api.on('chat:changed', loadState);
  api.on('projects:changed', loadState);
  api.on('project:auto-bound', async ({ project }) => { toast(`Привязан ${project.name} · Изменить`, 'ok'); await loadState(); });
  api.on('files:changed', async () => {
    await refreshTree();
    // Файл мог измениться под открытым буфером: обновляем diskHash, чтобы Ctrl+S
    // вовремя показал конфликт (§11), а не перезаписал чужие правки.
    if (window.WhaleEditor) await window.WhaleEditor.refreshDisk();
    if (P.loaded && S.project) { // дерево в генераторе промпта обновляем «на месте», не трогая поля ввода
      P.tree = await call('prompt:tree', { projectId: S.project.id });
      paintPromptTree();
      refreshPreview();
    }
    S.manual = S.project ? ((await call('manual:list', { projectId: S.project.id })) || []) : [];
    const v = S.view;
    if (v && v.kind === 'proposal' && v.data.status === 'pending') { // открытый Diff пересчитываем по свежему файлу
      const d = await call('proposal:get', { id: v.data.id });
      if (d && S.view && S.view.data.id === d.id) { S.view.data = d; render(); }
    }
  });
  api.on('proposals:changed', async () => {
    if (S.view) { // открытый Diff не перерисовываем, но данные списка и счётчик обновляем
      S.proposals = (await call('proposals:list', { includeHistorical: S.showHistorical })) || [];
      renderTabs();
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
    };
    for (const k of Object.keys(edEls)) if (!edEls[k]) return;
    window.WhaleEditor.mount(edEls, {
      toast,
      // несохранённые правки видны и на вкладках вне редактора — обновляем счётчик/заголовки
      onDirtyChange: () => { renderTabs(); },
    });
  })();

  loadState();
})();

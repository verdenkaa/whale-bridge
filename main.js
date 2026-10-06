'use strict';
const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, clipboard, Menu, session,
} = require('electron');
const { Store } = require('./src/store');
const { ProposalManager } = require('./src/proposals');
const fileops = require('./src/fileops');
const editorfs = require('./src/editorfs');
const { resolveInProject } = require('./src/paths');
const { extractFencedBlocks } = require('./src/parser');
const pg = require('./src/promptgen');
const { pathToFileURL } = require('url');

const CHAT_URL = 'https://chat.deepseek.com';
const PARTITION = 'persist:deepseek'; // сессия (cookies) сохраняется между запусками
const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_URL_RE = /\/a\/chat\/s\/([0-9a-f-]{36})/i;
// Куда разрешено открывать popup (авторизация). Остальное уходит во внешний браузер.
const POPUP_HOSTS = /(^|\.)(deepseek\.com|google\.com|gstatic\.com|apple\.com|microsoftonline\.com|live\.com)$/i;
// Путь к AMD-сборке Monaco. Определяется здесь, а не в renderer: в упакованном приложении
// node_modules может лежать в app.asar.unpacked, и угадывать относительный путь из страницы
// нельзя — а воркеры и шрифты Monaco грузятся по абсолютному URL.
const MONACO_VS = (() => {
  const candidates = [
    path.join(__dirname, 'node_modules', 'monaco-editor', 'min', 'vs'),
    path.join(__dirname, '..', 'app.asar.unpacked', 'node_modules', 'monaco-editor', 'min', 'vs'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(path.join(c, 'loader.js')).isFile()) return pathToFileURL(c).href;
    } catch { /* пробуем следующий кандидат */ }
  }
  return null;
})();

const UNSAFE_OPEN_EXT = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.lnk', '.scr', '.sh', '.app', '.jar', '.reg',
]);

let win = null;
let chatView = null;
let store = null;
let proposals = null;
let currentChatId = null;
let pendingProjectId = null;
let ratio = 0.5;
let dragging = false;
let watcher = null;
let watchedPath = null;
let watchTimer = null;

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload ?? {});
};

// Stage 0 (ТЗ §37): фиксируем, какую версию файла видела модель. ingest() синхронный,
// поэтому печать базы — отдельный шаг. Ошибка здесь не должна ронять обработку блоков:
// незапечатанное предложение просто останется с aiBaseHash = null («версия неизвестна»).
const sealAiBase = (chatId) => {
  if (!chatId || !proposals) return;
  proposals.sealAiBase(chatId).catch((e) => console.warn('[aiBase]', e.message));
};

function layout() {
  if (!win || !chatView) return;
  const [w, h] = win.getContentSize();
  const cw = dragging ? 0 : Math.round(w * ratio);
  chatView.setBounds({ x: 0, y: 0, width: cw, height: h });
}

// Слежение за папкой проекта: файлы, созданные/изменённые вне приложения, сразу попадают в дерево и в проверку путей
function syncWatcher() {
  const project = store.getProjectForChat(currentChatId);
  const target = project ? project.path : null;
  if (target === watchedPath) return;
  if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
  watchedPath = target;
  if (!target) return;
  try {
    watcher = fs.watch(target, { recursive: true }, (_ev, filename) => {
      if (filename) {
        const parts = String(filename).split(/[\\/]/);
        if (parts.some((x) => fileops.IGNORE_DIRS.has(x) || x.includes('.aiws-'))) return;
      }
      fileops.invalidateIndex();
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { send('files:changed'); proposals.onChange(); }, 300);
    });
    watcher.on('error', () => {});
  } catch (e) {
    console.warn('[watch] недоступно:', e.message); // запасной путь — обновление при фокусе окна
  }
}

async function updateChatFromUrl() {
  const url = chatView.webContents.getURL();
  const previousChatId = currentChatId;
  const m = url.match(CHAT_URL_RE);
  currentChatId = m ? m[1].toLowerCase() : null;
  if (currentChatId) {
    const bound = store.getProjectForChat(currentChatId);
    if (!bound && pendingProjectId) {
      const project = store.getProject(pendingProjectId);
      if (project) {
        await store.bind(currentChatId, project.id);
        pendingProjectId = null;
        sealAiBase(currentChatId);
        send('project:auto-bound', { chatId: currentChatId, project });
      }
    }
  }
  syncWatcher();
  send('chat:changed', { chatId: currentChatId, url, chatIdAppeared: previousChatId === null && currentChatId !== null });
}

function createWindow() {
  ratio = store.config.layoutRatio || 0.5;

  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#12161d',
    title: 'Whale Bridge',
    icon: path.join(__dirname, 'assets', 'whale-bridge-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // в sandbox-преалоде нет ни fs, ни пути к приложению — передаём через argv
      additionalArguments: MONACO_VS ? ['--monaco-vs=' + MONACO_VS] : [],
    },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Левая панель: официальный сайт DeepSeek в отдельном изолированном контексте
  chatView = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload-chat.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(chatView);

  const wc = chatView.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && POPUP_HOSTS.test(u.hostname)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520, height: 720, autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        };
      }
      if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(url);
    } catch { /* ignore */ }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!/^https?:/i.test(url)) e.preventDefault();
  });
  wc.on('did-navigate', updateChatFromUrl);
  wc.on('did-navigate-in-page', updateChatFromUrl);
  wc.on('did-finish-load', updateChatFromUrl);
  wc.loadURL(CHAT_URL);

  win.on('resize', layout);
  win.on('focus', () => { // файлы могли измениться, пока окно было в фоне
    fileops.invalidateIndex();
    send('files:changed');
    proposals.onChange();
  });
  win.on('closed', () => { win = null; chatView = null; });
  layout();
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'Правка', role: 'editMenu' },
      {
        label: 'Вид',
        submenu: [
          { label: 'Перезагрузить чат', accelerator: 'CmdOrCtrl+R', click: () => chatView?.webContents.reload() },
          { label: 'DevTools чата (DOM DeepSeek)', accelerator: 'F12', click: () => chatView?.webContents.openDevTools({ mode: 'detach' }) },
          { label: 'DevTools Workspace', accelerator: 'CmdOrCtrl+Shift+I', click: () => win?.webContents.openDevTools({ mode: 'detach' }) },
          { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        ],
      },
    ]),
  );
}

// ---------- IPC ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, arg) => {
    // Привилегированные операции доступны только UI приложения, но не странице DeepSeek
    if (!win || event.sender !== win.webContents) throw new Error('forbidden');
    return fn(arg || {});
  });
}

// Блоки кода от наблюдателя (строгая проверка структуры)
ipcMain.on('chat:blocks', (event, payload) => {
  if (!chatView || event.sender !== chatView.webContents) return;
  try {
    if (!/(^|\.)deepseek\.com$/.test(new URL(event.senderFrame.url).hostname)) return;
  } catch { return; }
  if (!payload || typeof payload !== 'object') return;
  const { chatId, blocks } = payload;
  if (typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) return;
  if (!Array.isArray(blocks) || blocks.length > 100) return;
  const clean = [];
  for (const b of blocks) {
    if (!b || typeof b.key !== 'string' || b.key.length > 64) continue;
    if (typeof b.text !== 'string' || b.text.length > 2_000_000) continue;
    clean.push({ key: b.key, text: b.text, initial: b.initial === true });
  }
  if (clean.length) {
    proposals.ingest(chatId.toLowerCase(), clean);
    sealAiBase(chatId.toLowerCase());
  }
});

function projectOr(id) {
  const p = store.getProject(id);
  if (!p) throw new Error('Проект не найден');
  return p;
}

function registerIpc() {
  handle('state:get', () => { syncWatcher(); return {
    projects: store.config.projects,
    chatId: currentChatId,
    project: store.getProjectForChat(currentChatId),
    pendingProjectId,
    lastProjectId: store.config.lastProjectId,
    ratio,
  }; });


  handle('project:add', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Выберите корневую папку проекта' });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = await store.addProject(r.filePaths[0]);
    send('projects:changed');
    return p;
  });

  handle('project:remove', async ({ id }) => {
    await store.removeProject(String(id));
    send('projects:changed');
    proposals.onChange();
  });

  handle('project:bind', async ({ chatId, projectId }) => {
    if (typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) throw new Error('Нет идентификатора чата');
    await store.bind(chatId.toLowerCase(), projectId ? String(projectId) : null);
    if (projectId && String(projectId) === pendingProjectId) pendingProjectId = null;
    sealAiBase(chatId.toLowerCase());
    send('projects:changed');
    proposals.onChange();
  });
  handle('project:pending', async ({ projectId }) => {
    const id = projectId ? String(projectId) : null;
    if (!id) { pendingProjectId = null; return null; }
    const p = store.getProject(id);
    if (!p) throw new Error('Проект не найден');
    pendingProjectId = p.id;
    return p;
  });

  handle('fs:list', ({ projectId, rel }) => fileops.listDir(projectOr(projectId).path, rel ? String(rel) : ''));

  // ---- редактор (Stage A) ----
  // projectId может быть неизвестен (проект удалён из списка) — тогда editorfs вернёт
  // внятную ошибку вместо исключения, чтобы renderer показал её в диалоге, а не в тосте.
  const projectOf = (projectId) => (projectId ? store.getProject(String(projectId)) : null);

  handle('file:read', ({ projectId, path: rel }) => editorfs.readForEditor(projectOf(projectId), rel));

  handle('file:write', async ({ projectId, path: rel, content, expectedHash }) => {
    const project = projectOf(projectId);
    const r = await editorfs.writeFromEditor({
      project, rel, content, expectedHash, store, chatId: currentChatId,
    });
    if (r.ok) proposals.onChange(); // drift-детекция предложений зависит от нового состояния файла
    return r;
  });

  handle('file:hashes', ({ projectId, paths }) => editorfs.hashesForEditor(projectOf(projectId), paths));

  handle('file:open', async ({ projectId, rel, mode }) => {
    const r = await resolveInProject(projectOr(projectId).path, String(rel));
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.exists) return { ok: false, error: 'Файл не существует' };
    if (mode === 'open' && !UNSAFE_OPEN_EXT.has(path.extname(r.abs).toLowerCase())) {
      const err = await shell.openPath(r.abs);
      return err ? { ok: false, error: err } : { ok: true };
    }
    shell.showItemInFolder(r.abs);
    return { ok: true };
  });

  handle('proposals:list', ({ includeHistorical }) =>
    currentChatId ? proposals.list(currentChatId, !!includeHistorical) : []);
  handle('proposal:get', ({ id }) => proposals.view(String(id)));
  handle('proposal:retarget', ({ id, relPath, op }) => proposals.retarget(String(id), { relPath, op }));
  handle('proposal:reject', ({ id }) => { proposals.reject(String(id)); proposals.dismiss(String(id)); });
  handle('proposal:dismiss', ({ id }) => proposals.dismiss(String(id)));
  handle('proposals:dismissAll', ({ includeHistorical }) => {
    if (currentChatId) proposals.dismissAll(currentChatId, !!includeHistorical);
  });
  handle('proposal:apply', ({ id, baseHash, contentHash, allowIncomplete, createDirs }) =>
    proposals.apply(String(id), {
      baseHash: String(baseHash), contentHash: String(contentHash),
      allowIncomplete: allowIncomplete === true, createDirs: createDirs === true,
    }));

  // Запасной путь, если вёрстка DeepSeek изменилась: код из буфера обмена
  handle('proposal:fromClipboard', () => {
    if (!currentChatId) return { ok: false, error: 'Сначала откройте чат' };
    const text = clipboard.readText();
    if (!text.trim()) return { ok: false, error: 'Буфер обмена пуст' };
    const blocks = extractFencedBlocks(text).map((t, i) => ({
      key: 'clip-' + Date.now() + '-' + i, text: t, initial: false,
    }));
    const changed = proposals.ingest(currentChatId, blocks);
    if (changed) sealAiBase(currentChatId);
    return changed ? { ok: true } : { ok: false, error: 'Не найдено блоков с маркером # &путь или они уже добавлены' };
  });

  handle('history:list', ({ projectId }) => proposals.listHistory(projectId ? String(projectId) : null));
  handle('history:view', ({ id }) => proposals.historyView(String(id)));
  handle('history:revert', ({ id, force }) => proposals.historyRevert(String(id), force === true));
  // ---- учёт контекста: какую версию файла знает модель в текущем чате ----
  handle('context:list', ({ projectId }) => proposals.listDivergences(currentChatId, String(projectId)));
  handle('context:ack', ({ projectId, relPath }) => proposals.ackContext(currentChatId, String(projectId), String(relPath)));
  handle('context:ack-all', ({ projectId }) => proposals.ackAllDivergent(currentChatId, String(projectId)));
  handle('context:known', ({ projectId, paths }) => proposals.contextKnownHashes(currentChatId, String(projectId), paths));
  handle('manual:view', ({ projectId, relPath }) => proposals.manualView(currentChatId, String(projectId), String(relPath)));
  handle('manual:copy', async ({ projectId }) => {
    const r = await proposals.copyDivergentVersions(currentChatId, String(projectId));
    if (r.ok) clipboard.writeText(r.text);
    return r;
  });
  handle('proposals:report', async () => {
    if (!currentChatId) return { ok: false, error: 'Сначала откройте чат' };
    const r = await proposals.buildChatReport(currentChatId);
    if (r.ok) clipboard.writeText(r.text);
    return r;
  });
  handle('proposal:merge', ({ id }) => proposals.merge(String(id)));

  // ---- резервные копии ----
  handle('backups:stats', () => store.backupStats());
  handle('backups:clear', async () => {
    const r = await store.clearBackups();
    proposals.onChange();
    return r;
  });

  // ---- генератор промптов ----
  async function buildPromptFor({ sections, projectId }) {
    const project = projectId ? store.getProject(String(projectId)) : null;
    const tree = project ? await fileops.getTree(project.path) : null;
    return pg.buildPrompt({
      sections: pg.sanitizeSections(sections),
      project,
      tree,
      excluded: new Set(project ? store.getTreeOff(project.id) : []),
    });
  }
  handle('prompt:get', ({ projectId }) => ({
    sections: store.config.promptDraft ? pg.upgradeLegacy(pg.sanitizeSections(store.config.promptDraft)) : pg.defaultSections(),
    presets: [...pg.builtinPresets().map(({ id, name, builtin }) => ({ id, name, builtin })), ...store.listPresets()],
    excluded: projectId ? store.getTreeOff(String(projectId)) : [],
    defaults: pg.defaultTexts(),
  }));
  handle('prompt:tree', ({ projectId }) => {
    const p = store.getProject(String(projectId));
    return p ? fileops.getTree(p.path) : null;
  });
  handle('prompt:save-draft', ({ sections }) => store.setPromptDraft(pg.sanitizeSections(sections)));
  handle('prompt:set-excluded', ({ projectId, excluded }) => {
    const p = projectOr(projectId);
    if (!Array.isArray(excluded) || excluded.length > 5000) throw new Error('Неверный список');
    const clean = excluded.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 400);
    return store.setTreeOff(p.id, clean);
  });
  handle('prompt:build', async (arg) => {
    const r = await buildPromptFor(arg);
    return { text: r.text, partial: r.partial };
  });
  handle('prompt:copy', async (arg) => {
    const r = await buildPromptFor(arg);
    if (!r.text.trim()) return { ok: false, error: 'Промпт пустой — заполните хотя бы одно поле' };
    clipboard.writeText(r.text);
    return { ok: true, length: r.text.length, partial: r.partial };
  });
  handle('prompt:copy-reminder', () => {
    clipboard.writeText(pg.FORMAT_REMINDER);
    return { ok: true, length: pg.FORMAT_REMINDER.length };
  });
  handle('prompt:copy-files', async ({ projectId, excluded }) => {
    const project = projectId ? store.getProject(String(projectId)) : null;
    if (!project) return { ok: false, error: 'Проект не выбран' };
    const excludedSet = new Set(Array.isArray(excluded) ? excluded.filter((x) => typeof x === 'string') : []);
    const tree = await fileops.getTree(project.path);
    const parts = [];
    const skipped = [];
    const sentToModel = []; // что реально ушло в буфер обмена целиком
    let totalChars = 0;
    const MAX_TOTAL_CHARS = 20_000_000;
    const isExcluded = (rel) => {
      let prefix = '';
      for (const part of rel.split('/')) {
        prefix = prefix ? prefix + '/' + part : part;
        if (excludedSet.has(prefix)) return true;
      }
      return false;
    };
    async function walk(nodes) {
      for (const node of nodes || []) {
        if (isExcluded(node.rel)) continue;
        if (node.isDir) {
          await walk(node.children);
          continue;
        }
        if (totalChars >= MAX_TOTAL_CHARS) { skipped.push(node.rel + ' (лимит общего объёма)'); continue; }
        const resolved = await resolveInProject(project.path, node.rel);
        if (!resolved.ok) { skipped.push(node.rel); continue; }
        const text = await fileops.readTextFile(resolved.abs);
        if (text.error) { skipped.push(node.rel + ' (' + text.error + ')'); continue; }
        const remaining = MAX_TOTAL_CHARS - totalChars;
        const content = text.text.slice(0, remaining);
        if (content.length < text.text.length) {
          // Обрезанный файл модель не увидит целиком — отмечать его как известный нельзя
          skipped.push(node.rel + ' (обрезан по лимиту общего объёма)');
        } else {
          sentToModel.push({ relPath: node.rel, hash: text.hash });
        }
        parts.push(`--- ${node.rel} ---\n${content}`);
        totalChars += content.length;
      }
    }
    await walk(tree.nodes);
    if (!parts.length) return { ok: false, error: 'Нет включённых текстовых файлов для копирования' };
    let output = parts.join('\n\n');
    if (skipped.length) output += `\n\n--- Пропущено ---\n${skipped.map((x) => '- ' + x).join('\n')}`;
    clipboard.writeText(output);
    // Файлы ушли в буфер обмена как контекст модели — фиксируем их версии в журнале.
    // Чат может быть ещё не открыт (currentChatId === null): тогда отмечать некого,
    // и после привязки чата файлы честно окажутся «модель не знает».
    const recorded = await proposals.recordContext(currentChatId, project.id, sentToModel, 'prompt');
    return { ok: true, files: parts.length, skipped: skipped.length, length: output.length, recorded };
  });
  handle('prompt:preset-save', async ({ name, sections }) => {
    const n = String(name || '').trim().slice(0, 80);
    if (!n) throw new Error('Введите название пресета');
    await store.savePreset(n, pg.sanitizeSections(sections));
    return store.listPresets();
  });
  handle('prompt:preset-load', async ({ id }) => {
    const sid = String(id);
    const preset = pg.builtinPresets().find((p) => p.id === sid) || store.getPreset(sid);
    if (!preset) throw new Error('Пресет не найден');
    const sections = pg.upgradeLegacy(pg.sanitizeSections(preset.sections));
    await store.setPromptDraft(sections);
    return sections;
  });
  handle('prompt:preset-delete', async ({ id }) => {
    if (String(id).startsWith('builtin-')) throw new Error('Встроенный пресет удалить нельзя');
    await store.deletePreset(String(id));
    return store.listPresets();
  });
  handle('prompt:reset', async () => {
    const s = pg.defaultSections();
    await store.setPromptDraft(s);
    return s;
  });

  // Разделитель панелей. На время перетаскивания чат скрывается, чтобы события мыши не терялись.
  handle('layout:drag-start', () => { dragging = true; chatView?.setVisible(false); layout(); });
  handle('layout:set', ({ ratio: r }) => {
    if (typeof r !== 'number' || !isFinite(r)) return;
    ratio = Math.min(0.8, Math.max(0.2, r));
  });
  handle('layout:drag-end', async () => {
    dragging = false;
    chatView?.setVisible(true);
    layout();
    store.config.layoutRatio = ratio;
    await store.saveConfig();
  });
}

// ---------- старт ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    store = new Store(app.getPath('userData'));
    await store.load();
    await store.pruneAll(2).catch((e) => console.error('[prune]', e)); // не больше 2 копий на файл, в том числе от старых версий

    let notifyTimer = null;
    proposals = new ProposalManager({
      store,
      trash: (abs) => shell.trashItem(abs),
      onChange: () => {
        clearTimeout(notifyTimer);
        notifyTimer = setTimeout(() => send('proposals:changed'), 80);
      },
    });

    // Сайту DeepSeek не даём лишних разрешений (камера, геолокация и т.п.)
    session.fromPartition(PARTITION).setPermissionRequestHandler((_wc, permission, cb) => {
      cb(['clipboard-sanitized-write', 'fullscreen'].includes(permission));
    });

    registerIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });


  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

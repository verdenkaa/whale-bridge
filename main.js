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
// Этап C3 «Запуск»: планирование языков (чистое ядро), поиск инструментов и
// оркестратор сессий. runlangs общий с renderer (UMD) — правила одни на два процесса.
const runlangs = require('./src/runlangs');
// Подписи инструментов для диалога выбора файла — те же данные, что рисует renderer
const runsettings = require('./src/runsettings');
const { createToolchain } = require('./src/toolchain');
const { createRunner } = require('./src/runner');
const { pathToFileURL } = require('url');
// Правила раскладки общие с renderer (UMD): sanitize сохранённых ширин и нормализация
// прямоугольника чата должны совпадать с тем, что считает ui/layout.js в интерфейсе.
const layoutMath = require('./ui/layout');

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
let runner = null;      // оркестратор сессий запуска (создаётся после store.load)
let toolchain = null;   // автопоиск инструментов в PATH
let currentChatId = null;
let pendingProjectId = null;
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

// Этап B (ТЗ §4, §28): main НЕ считает геометрию. Раскладку определяет CSS в renderer,
// а renderer отдаёт готовый прямоугольник #chat-slot через chat:set-bounds.
// Здесь — только физическое размещение WebContentsView.

// Слежение за папкой проекта: файлы, созданные/изменённые вне приложения, сразу попадают в дерево и в проверку путей
function syncWatcher() {
  if (watchPaused) return; // на время сессии запуска наблюдатель закрыт (resumeWatcher восстановит)
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

// ---------- запуск (этап C3, ТЗ §3) ----------

// node-pty грузим лениво и с try/catch: нативный модуль может не подняться (другая
// платформа без пребилда, повреждённая установка), а всё остальное приложение обязано
// работать. Ошибка всплывёт в момент первого запуска — понятным тостом, не падением.
let pty = null;
let ptyError = null;
function getPty() {
  if (pty === null && ptyError === null) {
    try {
      pty = require('node-pty');
    } catch (e) {
      ptyError = e;
      console.warn('[pty] node-pty недоступен:', e.message);
    }
  }
  return pty;
}

/**
 * Адаптер node-pty к интерфейсу раннера ({pid, write, resize, kill, onData, onExit}).
 * Ошибки — исключениями: раннер ловит их в startStep и превращает в понятный ответ
 * пользователю («не удалось запустить»), потому что типичная причина — битый путь
 * инструмента, и ронять main из-за этого нельзя.
 */
function spawnPtyAdapter(opts) {
  const ptyLib = getPty();
  if (!ptyLib) {
    throw new Error(ptyError
      ? 'node-pty не загружен: ' + (ptyError.message || ptyError)
      : 'node-pty не загружен');
  }
  const raw = ptyLib.spawn(opts.exe, opts.args, {
    name: 'xterm-256color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd: opts.cwd,
    env: opts.env,
  });
  return {
    pid: raw.pid,
    write: (s) => raw.write(s),
    resize: (c, r) => raw.resize(c, r),
    kill: () => raw.kill(),
    onData: (cb) => raw.onData(cb),
    onExit: (cb) => raw.onExit(cb),
  };
}

/**
 * Убийство дерева процессов (handover §4.3: на Windows — отдельно от pty.kill).
 * win32: taskkill /T /F снимает всё дерево (python-скрипт с subprocess умирает целиком);
 * posix: процесс запущен лидером группы, поэтому SIGTERM группе (-pid), через 2 с SIGKILL.
 */
function killTree(pid, ptyHandle) {
  if (pid) {
    if (process.platform === 'win32') {
      const { spawn } = require('child_process');
      try {
        // windowsHide: окно taskkill не должно мелькать поверх терминала
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
          .on('error', () => { /* процесс мог уже завершиться */ });
      } catch { /* процесс мог уже завершиться */ }
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { /* уже завершился */ }
      const t = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* уже завершился */ }
      }, 2000);
      if (typeof t.unref === 'function') t.unref();
    }
  }
  if (ptyHandle) { try { ptyHandle.kill(); } catch { /* уже завершён */ } }
}

/**
 * Пауза наблюдения за файлами на время сессии (ТЗ §3.3): компиляция и запуск создают
 * файлы (.ide_build, __pycache__), и наблюдатель не должен захлёбываться. Закрываем
 * watcher и сбрасываем watchedPath; по завершении syncWatcher() гарантированно
 * пересоздаст наблюдатель для текущего проекта (target !== watchedPath === null).
 * Пока сессия идёт, syncWatcher() из state:get/focus/смены чата — холостой:
 * флаг watchPaused не даёт возобновить наблюдение до onEnd.
 */
let watchPaused = false;
function pauseWatcher() {
  if (watchPaused) return;
  watchPaused = true;
  if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
  watchedPath = null;
}
function resumeWatcher() {
  if (!watchPaused) return;
  watchPaused = false;
  // watchedPath сброшен в pauseWatcher, поэтому syncWatcher() гарантированно
  // пересоздаст наблюдатель для текущего проекта (target !== null === watchedPath)
  syncWatcher();
}

function createAppRunner() {
  toolchain = createToolchain({});
  runner = createRunner({
    spawnPty: spawnPtyAdapter,
    killTree,
    // События терминала уходят через локальный send с литеральными именами каналов:
    // обвязочные тесты сверяют run:data/run:exit/run:state в main.js с белым списком
    // preload буквально, поэтому каналы обязаны быть видны в тексте main.js.
    send: (channel, payload) => {
      if (channel === 'run:data') send('run:data', payload);
      else if (channel === 'run:exit') send('run:exit', payload);
      else send('run:state', payload);
    },
    getRunConfig: () => store.config.run,
    toolchain,
    onStart: () => pauseWatcher(),
    onEnd: () => resumeWatcher(),
    onError: (e) => console.warn('[run]', e && e.message ? e.message : e),
  });
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

  // Геометрию чата отдаёт renderer (chat:set-bounds), поэтому win.on('resize') не нужен:
  // ResizeObserver на #chat-slot срабатывает и при resize, и при maximize, и при смене масштаба.
  win.on('focus', () => { // файлы могли измениться, пока окно было в фоне
    fileops.invalidateIndex();
    send('files:changed');
    proposals.onChange();
  });
  win.on('closed', () => { win = null; chatView = null; });
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

// Этап B (ТЗ §4): геометрия чата приходит из renderer — ResizeObserver на #chat-slot
// измеряет getBoundingClientRect() и присылает готовый прямоугольник. Fire-and-forget:
// во время перетаскивания разделителя сообщения идут каждый кадр, ответ не нужен.
//
// Последний rect запоминается и повторно применяется при показе чата: на Windows
// геометрия, заданная скрытому WebContentsView, может не пережить цикл hide/show
// (нативный слой пересоздаётся) — без этого чат «залипал» на старом месте при
// переносе на другую сторону окна.
let lastChatBounds = null;

ipcMain.on('chat:set-bounds', (event, rect) => {
  if (!chatView || !win || win.isDestroyed() || event.sender !== win.webContents) return;
  const r = layoutMath.normalizeRect(rect);
  if (!r) return; // нулевая ячейка или мусор — WebContentsView не трогаем
  const [maxW, maxH] = win.getContentSize();
  const x = Math.min(r.x, Math.max(0, maxW - 1));
  const y = Math.min(r.y, Math.max(0, maxH - 1));
  lastChatBounds = {
    x, y,
    width: Math.max(1, Math.min(r.width, maxW - x)),
    height: Math.max(1, Math.min(r.height, maxH - y)),
  };
  chatView.setBounds(lastChatBounds);
});

// На время перетаскивания разделителя чат скрывается: WebContentsView — нативный слой,
// он проглатывает события мыши, и без скрытия разделитель «терял» бы курсор.
ipcMain.on('chat:set-visible', (event, visible) => {
  if (!chatView || !win || win.isDestroyed() || event.sender !== win.webContents) return;
  const show = visible !== false;
  chatView.setVisible(show);
  // Показать ровно там, где договорились: повторное setBounds страхует от потери
  // геометрии скрытым нативным слоем (порядок сообщений от renderer: bounds → visible).
  if (show && lastChatBounds) chatView.setBounds(lastChatBounds);
});

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

// ---- терминал: ввод и размер (этап C3) ----
// Fire-and-forget, как chat:set-bounds: нажатие клавиши обязано уходить в pty мгновенно,
// round-trip invoke здесь только добавил бы задержку ввода.
ipcMain.on('run:input', (event, text) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  if (typeof text !== 'string' || !text) return;
  runner.input(text.slice(0, 4096));
});
ipcMain.on('run:resize', (event, size) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  if (!size || typeof size !== 'object') return;
  runner.resize(size.cols, size.rows);
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
    // Этап B: renderer владеет геометрией — main отдаёт сохранённые ширины панелей,
    // а не долю окна. layoutRatio больше не используется (миграция: старые конфиги
    // просто получают дефолты, число из прежней версии ничего не ломает).
    layout: layoutMath.sanitize(store.config.layout),
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

  // Этап C (§20–§21): принятые в буфер ханки предложения приходят вместе с сохранением.
  // payload — из renderer, поэтому чистим так же строго, как chat:blocks.
  function cleanAiAccepts(raw) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 20) return [];
    const out = [];
    for (const a of raw) {
      if (!a || typeof a !== 'object') continue;
      if (typeof a.proposalId !== 'string' || !a.proposalId) continue;
      const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : null);
      out.push({
        proposalId: a.proposalId.slice(0, 64),
        acceptedHunks: num(a.acceptedHunks),
        totalHunks: num(a.totalHunks),
        proposedText: typeof a.proposedText === 'string' && a.proposedText.length <= 2_000_000
          ? a.proposedText
          : null,
      });
    }
    return out;
  }

  handle('file:write', async ({ projectId, path: rel, content, expectedHash, aiAccepts }) => {
    const project = projectOf(projectId);
    // До перезаписи: если журнал знает текущее содержимое только по хэшу (записи,
    // сделанные до появления снимков, и перенесённые миграцией), успеваем сохранить его.
    // Через мгновение файл перезапишут, и сравнение «версия модели -> диск» останется
    // без второй стороны навсегда.
    if (project && rel && currentChatId) {
      try {
        const rp = await resolveInProject(project.path, rel);
        if (rp.ok && rp.exists && rp.isFile) {
          const cur = await fileops.readTextFile(rp.abs);
          if (!cur.error) await proposals.ensureContextSnapshot(currentChatId, projectId, rel, cur.hash, cur.text);
        }
      } catch { /* страховка не должна мешать сохранению */ }
    }
    const accepts = cleanAiAccepts(aiAccepts);
    const r = await editorfs.writeFromEditor({
      project, rel, content, expectedHash, store, chatId: currentChatId,
      // §10: сохранение, в котором участвовали ханки модели, — операция источника 'ai'
      source: accepts.length ? 'ai' : 'manual',
      aiMeta: accepts.length ? { proposals: accepts.map(({ proposalId, acceptedHunks, totalHunks }) => ({ id: proposalId, acceptedHunks, totalHunks })) } : null,
    });
    if (r.ok) {
      for (const a of accepts) proposals.markAppliedExternally(a.proposalId, { historyId: r.historyId });
      // Честный учёт контекста: «модель знает» ставится ТОЛЬКО если сохранённый текст
      // байт в байт равен предложенному ею и в сохранении не смешано несколько правок.
      // Частичное принятие или примесь ручных правок даёт версию, которую модель не видела, —
      // файл остаётся с отметкой расхождения, и это видно.
      // Переводы строк не смысл: модель присылает LF, файл на диске может быть CRLF —
      // сравниваем нормализованно, иначе полное принятие на CRLF-файле вечно выглядело бы
      // как «модель не знает версию».
      const normEol = (t) => (typeof t === 'string' ? t.replace(/\r\n/g, '\n') : t);
      const exact = accepts.length === 1 && typeof accepts[0].proposedText === 'string'
        && normEol(accepts[0].proposedText) === normEol(content);
      if (exact && project && r.hash) {
        await proposals.recordContext(currentChatId, project.id,
          [{ relPath: r.path, hash: r.hash, content }], 'applied').catch((e) => console.error('[context]', e));
      }
      proposals.onChange(); // drift-детекция предложений зависит от нового состояния файла
    }
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
  // Пометка «выполнено» для предложений запуска и команд (&RUN:/&CMD:, этап C3c).
  // Вызывается renderer'ом дважды: со стартом сессии и по run:exit — с кодом возврата.
  // Записи в историю и резервных копий не создаёт: запуск не меняет файлы проекта.
  handle('proposal:executed', ({ id, exitCode, error }) => proposals.markExecuted(String(id), {
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    error: typeof error === 'string' ? error.slice(0, 500) : null,
  }));
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
  handle('prompt:get', ({ projectId }) => {
    const sections = store.config.promptDraft ? pg.upgradeLegacy(pg.sanitizeSections(store.config.promptDraft)) : pg.defaultSections();
    const rules = sections.find((s) => s.key === 'rules' && s.type === 'text');
    return {
      sections,
      presets: [...pg.builtinPresets().map(({ id, name, builtin }) => ({ id, name, builtin })), ...store.listPresets()],
      excluded: projectId ? store.getTreeOff(String(projectId)) : [],
      defaults: pg.defaultTexts(),
      // Правила в черновике устарели (в них нет &RUN:/&CMD:, поэтому модель не будет
      // предлагать запуски и команды). Молча не перезаписываем: текст мог быть
      // отредактирован пользователем, поэтому отдаём признак и актуальный текст,
      // а интерфейс показывает явную кнопку «Обновить правила» (ТЗ §3.8).
      rulesUpgrade: rules && pg.rulesNeedUpgrade(rules.text)
        ? { needed: true, text: pg.DEFAULT_RULES }
        : { needed: false, text: null },
    };
  });
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
          // content обязателен: без него журнал знает только хэш, и показать модели
          // «что именно изменилось» будет нечем
          sentToModel.push({ relPath: node.rel, hash: text.hash, content: text.text });
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

  // ---- раскладка (этап B, ТЗ §4, §28) ----
  // main не считает геометрию: renderer присылает готовые ширины панелей, а позицию чата
  // задаёт прямоугольником в chat:set-bounds (ниже, в ipcMain.on).
  handle('layout:save', async ({ layout }) => {
    const [winW, winH] = win && !win.isDestroyed() ? win.getContentSize() : [null, null];
    store.config.layout = layoutMath.sanitize(layout, winW, winH);
    await store.saveConfig();
    return store.config.layout;
  });

  // ---- запуск (этап C3, ТЗ §3.4) ----
  handle('run:start', async ({ projectId, target, input, cols, rows }) => {
    const project = store.getProject(String(projectId || ''));
    if (!project) return { ok: false, reason: 'no-project', message: 'Сначала выберите проект для этого чата' };
    // payload — из renderer, поэтому чистим так же строго, как chat:blocks
    const clean = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    const t = target && typeof target === 'object' ? target : {};
    // Инструменты могли появиться в PATH после прошлого запуска («установил gcc →
    // запустил»), а кеш живёт до смены настроек — перед каждым стартом сбрасываем.
    toolchain.clearCache();
    const r = await runner.start({
      project,
      target: t.kind === 'cmd'
        ? { kind: 'cmd', command: clean(t.command, 4000) }
        : { kind: 'file', rel: clean(t.rel, 1000) },
      input: clean(input, 65536),
      cols: Number.isFinite(cols) ? cols : undefined,
      rows: Number.isFinite(rows) ? rows : undefined,
    });
    return r;
  });
  handle('run:stop', () => runner.stop());
  handle('run:copy-report', () => {
    const r = runner.report();
    if (!r.ok) return r;
    clipboard.writeText(r.text);
    return { ok: true, length: r.text.length };
  });

  // ---- настройки запуска (этап C3b, ТЗ §2.4, §3.4) ----

  // Обнаружение инструментов для таблицы настроек. Кеш toolchain живёт до смены конфига,
  // поэтому «Обновить» (fresh: true) сбрасывает его явно: пользователь мог установить
  // компилятор, не трогая настройки, и ждать, что таблица это увидит.
  handle('tools:detect', async ({ fresh }) => {
    if (fresh) toolchain.clearCache();
    const tools = await toolchain.detect(store.config.run);
    return { ok: true, tools, run: store.config.run };
  });

  // «Обзор…» — выбор исполняемого файла вручную. Фильтр включает .cmd/.bat: тулчейны
  // ставят обёртки (py.bat, npm.cmd), и жёсткий фильтр только по .exe не дал бы их выбрать.
  handle('tools:pick', async ({ toolKey }) => {
    const hit = runsettings.toolByKey(typeof toolKey === 'string' ? toolKey : '');
    const name = hit ? hit.tool.names[0] : null;
    const isWin = process.platform === 'win32';
    const r = await dialog.showOpenDialog(win, {
      title: name ? `Путь к исполняемому файлу (${name})` : 'Путь к исполняемому файлу',
      buttonLabel: 'Выбрать',
      properties: ['openFile'],
      filters: isWin
        ? [{ name: 'Исполняемые файлы', extensions: ['exe', 'cmd', 'bat', 'com'] }, { name: 'Все файлы', extensions: ['*'] }]
        : [{ name: 'Все файлы', extensions: ['*'] }],
    });
    if (r.canceled || !Array.isArray(r.filePaths) || !r.filePaths[0]) return { ok: true, path: null };
    return { ok: true, path: String(r.filePaths[0]) };
  });

  handle('settings:get', () => ({ ok: true, run: store.config.run }));

  // Сохранение мгновенное (как у черновика промпта, §2.4): раздел пока единственный,
  // а запуск обязан видеть свежие пути. Всё, что пришло из renderer, проходит тот же
  // sanitizeRunConfig, что и при загрузке config.json, — мусор не сохраняется.
  handle('settings:save', async ({ run }) => {
    store.config.run = runlangs.sanitizeRunConfig(run);
    await store.saveConfig();
    // Кеш инструментов привязан к config.tools, но сбрасываем его явно: порядок вызовов
    // не должен влиять на то, увидит ли следующий запуск новые пути.
    toolchain.clearCache();
    return { ok: true, run: store.config.run };
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

    // Раннер и поиск инструментов создаются после store (нужны config.run и путь проекта)
    // и ДО регистрации IPC и окна: обработчики tools:detect/settings:save обращаются к
    // toolchain, и первый же вызов не должен застать его не созданным.
    createAppRunner();

    registerIpc();
    buildMenu();
    createWindow();
    // Не оставляем сирот: дерево процессов запуска умирает вместе с приложением
    app.on('before-quit', () => { if (runner) runner.stopAll(); });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });


  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

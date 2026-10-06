'use strict';
// Classic-воркер для Monaco (стратегия 'classic' в spike/main.js).
//
// Зачем он нужен. Штатный путь Monaco 0.57 такой (см. min/vs/editor-BdtEMBbM.js, функции
// AJ/MJ): создаётся blob:-URL, внутри которого `await import("<абсолютный URL модуля воркера>")`,
// и воркер поднимается как `new Worker(blobUrl, { type: 'module' })`. Модульный импорт по
// CORS проверяется, а у страницы на file:// origin непрозрачный («null»), поэтому такой импорт
// в Chromium ожидаемо не проходит.
//
// Обход: MonacoEnvironment.getWorker полностью перехватывает создание воркера (Monaco проверяет
// его раньше своего blob-пути), поэтому делаем ОБЫЧНЫЙ (не модульный) воркер и поднимаем в нём
// AMD-загрузчик — min-сборка Monaco как раз AMD.
//
// Параметры передаются в query: vs — абсолютный URL каталога .../monaco-editor/min/vs.

const q = new URLSearchParams(self.location.search);
const vs = (q.get('vs') || '').replace(/\/+$/, '');
const label = q.get('label') || 'editorWorkerService';

if (!vs) throw new Error('worker-host: не передан параметр vs');

// importScripts разрешает только синхронную загрузку; порядок важен — сначала загрузчик.
importScripts(vs + '/loader.js');
self.require.config({ paths: { vs } });
self.require(['vs/editor/editor.worker'], () => {
  // vs/editor/editor.worker сам ставит self.onmessage и стартует по первому сообщению.
  // Дополнительно сообщать ничего не нужно: если мы здесь, скрипт воркера загрузился.
}, (err) => {
  // Ошибка загрузки модуля не всплывает как событие error воркера — логируем явно.
  console.error('[worker-host] не удалось загрузить vs/editor/editor.worker для', label, err);
  throw err;
});

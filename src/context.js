'use strict';
// Журнал контекста: какую версию какого файла знает модель в конкретном чате.
//
// Почему прежней схемы недостаточно. Расхождение искали так: «диск отличается от последней
// записи ИСТОРИИ Whale Bridge». Отсюда три следствия, которые и наблюдались:
//   1. файл, который приложение никогда не записывало, не проверялся вовсе — у него просто
//      не было записи в истории;
//   2. сразу после сохранения в редакторе диск совпадал с последней операцией, поэтому
//      расхождение не обнаруживалось, хотя модель новой версии не видела;
//   3. учёт жил в памяти предложений и обнулялся вместе с сессией.
//
// Правильный вопрос другой: «совпадает ли то, что сейчас на диске, с тем, что видела модель?»
// Поэтому здесь хранится не факт операции, а факт ЗНАНИЯ: версия файла, которую модель
// получила. Расхождение — это несовпадение текущей версии с последней известной модели.
//
// Ключ — chatId, а не projectId: знает модель или нет — свойство разговора, а не папки.
// Один проект может быть привязан к разным чатам, и в каждом модель знает своё.
//
// Отметка хранится как SHA-256 содержимого, а не как флаг, поэтому следующее изменение
// файла снимает её само: сравнивать нужно версии, а не «подтверждал ли пользователь».

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WhaleContext = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // Откуда взялось знание о версии. Показывается пользователю: он должен понимать,
  // почему файл считается известным модели, иначе отметке перестанут верить.
  const SOURCES = ['applied', 'prompt', 'manual-copy', 'ack', 'migrated'];
  const SOURCE_LABEL = {
    applied: 'модель сама предложила это содержимое',
    prompt: 'файл был скопирован в чат как контекст',
    // manual-copy больше не записывается: копирование в буфер не означает отправку в чат.
    // Источник оставлен, чтобы отметки, уже сохранённые в конфиге, читались внятно.
    'manual-copy': 'актуальная версия была скопирована для модели',
    ack: 'пользователь подтвердил, что модель проинформирована',
    migrated: 'перенесено из прежней отметки (до журнала контекста)',
  };

  const KEY_SEP = '::';
  // Ограничения нужны, чтобы конфиг не рос бесконечно: журнал живёт в config.json
  const MAX_KNOWN_PER_CHAT = 2000;
  const MAX_SEEN_PER_CHAT = 4000;

  const key = (projectId, relPath) => projectId + KEY_SEP + relPath;

  function splitKey(k) {
    const i = String(k).indexOf(KEY_SEP);
    if (i <= 0) return null;
    return { projectId: k.slice(0, i), relPath: k.slice(i + KEY_SEP.length) };
  }

  const chatBucket = (store, chatId) => {
    if (!store || typeof store !== 'object') return null;
    if (!store[chatId] || typeof store[chatId] !== 'object') store[chatId] = {};
    return store[chatId];
  };

  /**
   * Записывает: «модель в этом чате видела такую версию файла».
   * Повторная запись для того же файла перезаписывает прежнюю — знать две версии
   * одновременно модель не может, актуальна последняя переданная.
   */
  function record(known, chatId, entry) {
    if (!known || typeof known !== 'object') return false;
    if (!chatId || !entry || !entry.projectId || !entry.relPath || !entry.hash) return false;
    if (!SOURCES.includes(entry.source)) return false;
    const bucket = chatBucket(known, chatId);
    bucket[key(entry.projectId, entry.relPath)] = {
      hash: entry.hash,
      source: entry.source,
      ts: typeof entry.ts === 'number' ? entry.ts : Date.now(),
      historyId: entry.historyId || null,
    };
    prune(known, chatId, MAX_KNOWN_PER_CHAT);
    return true;
  }

  function knownVersion(known, chatId, projectId, relPath) {
    const e = known && chatId && known[chatId] ? known[chatId][key(projectId, relPath)] : null;
    return e || null;
  }

  /** Все записи чата по проекту — для списка расхождений. */
  function entries(known, chatId, projectId) {
    const bucket = known && chatId ? known[chatId] : null;
    if (!bucket) return [];
    const out = [];
    for (const [k, v] of Object.entries(bucket)) {
      const p = splitKey(k);
      if (!p) continue;
      if (projectId && p.projectId !== projectId) continue;
      out.push({ projectId: p.projectId, relPath: p.relPath, ...v });
    }
    return out;
  }

  /**
   * ЕДИНСТВЕННОЕ правило расхождения: известная модели версия не совпадает с тем, что на
   * диске. diskHash == null (файл удалён или не читается) — тоже расхождение.
   * knownHash == null означает, что модель файл никогда не видела: сравнивать не с чем.
   *
   * Правило вынесено сюда, потому что его пользуют и main (proposals), и renderer
   * (состояние редактора). Две формулировки рано или поздно разошлись бы, а расхождение
   * в таком правиле означает либо ложную тревогу, либо молча уехавший контекст.
   */
  const isDiverged = (knownHash, diskHash) => knownHash != null && knownHash !== (diskHash == null ? null : diskHash);

  /**
   * Расхождения: известные модели версии, которые больше не совпадают с диском.
   * @param diskHashes {{[relPath]: string|null}} текущие хэши; null — файла нет/не читается
   * Файлы, которых нет в diskHashes, не проверяются: вызывающий сам решает, что спрашивать.
   */
  function divergences(known, chatId, projectId, diskHashes) {
    if (!diskHashes || typeof diskHashes !== 'object') return [];
    const out = [];
    for (const e of entries(known, chatId, projectId)) {
      if (!Object.prototype.hasOwnProperty.call(diskHashes, e.relPath)) continue;
      const disk = diskHashes[e.relPath];
      if (!isDiverged(e.hash, disk)) continue;
      out.push({
        relPath: e.relPath,
        knownHash: e.hash,
        knownSource: e.source,
        knownLabel: SOURCE_LABEL[e.source] || e.source,
        knownTs: e.ts,
        historyId: e.historyId || null,
        diskHash: disk == null ? null : disk,
        missing: disk == null,
      });
    }
    return out;
  }

  /** Хэши известных моделей версиями файлов — одним вызовом, чтобы не читать их по одному. */
  function knownHashes(known, chatId, projectId, rels) {
    const out = {};
    for (const rel of (Array.isArray(rels) ? rels : []).slice(0, 200)) {
      if (typeof rel !== 'string' || !rel) continue;
      const e = knownVersion(known, chatId, projectId, rel);
      out[rel] = e ? e.hash : null;
    }
    return out;
  }

  function prune(known, chatId, limit = MAX_KNOWN_PER_CHAT) {
    const bucket = known && chatId ? known[chatId] : null;
    if (!bucket) return 0;
    const list = Object.entries(bucket).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    if (list.length <= limit) return 0;
    for (const [k] of list.slice(limit)) delete bucket[k];
    return list.length - limit;
  }

  function dropChat(known, chatId) {
    if (known && chatId && known[chatId]) { delete known[chatId]; return true; }
    return false;
  }

  // ---------- какие блоки ответа модели уже видели ----------
  //
  // Отдельная задача, но тот же принцип учёта. preload-chat.js считает «историей» только то,
  // что появилось в первые 2.5 с после открытия чата. При прокрутке вверх DeepSeek догружает
  // старые сообщения, их блоки приходят позже и выглядят как новые предложения — хотя модель
  // ответила ими давно. Множество уже виденных хэшей содержимого решает это без привязки ко
  // времени: блок, который мы однажды разобрали, новым стать не может.

  function markSeen(seen, chatId, contentHash) {
    if (!chatId || !contentHash) return false;
    if (!seen[chatId]) seen[chatId] = [];
    const list = seen[chatId];
    if (list.includes(contentHash)) return false;
    list.push(contentHash);
    if (list.length > MAX_SEEN_PER_CHAT) list.splice(0, list.length - MAX_SEEN_PER_CHAT);
    return true;
  }

  const wasSeen = (seen, chatId, contentHash) => !!(chatId && contentHash && seen && Array.isArray(seen[chatId]) && seen[chatId].includes(contentHash));

  function dropChatSeen(seen, chatId) {
    if (seen && chatId && seen[chatId]) { delete seen[chatId]; return true; }
    return false;
  }

  return {
    SOURCES, SOURCE_LABEL, KEY_SEP, MAX_KNOWN_PER_CHAT, MAX_SEEN_PER_CHAT,
    key, splitKey, isDiverged,
    record, knownVersion, entries, divergences, knownHashes, prune, dropChat,
    markSeen, wasSeen, dropChatSeen,
  };
});

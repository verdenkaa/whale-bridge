'use strict';
// Состояние редактора (ТЗ §8, §12, §14). Чистые функции: ни DOM, ни Monaco, ни Electron —
// поэтому вся логика вкладок, dirty и конфликтов покрыта node-тестами, а ui/editor.js
// остаётся тонкой обвязкой, которую можно проверить только руками.
//
// Модель состояния на один открытый файл (§8):
//   path, savedText, savedHash, diskHash, text, eol, hasBom, language, viewState
//
//   savedText/savedHash — точка сохранения: что редактор считает «уже на диске»
//   text                — текущее содержимое буфера Monaco
//   diskHash            — что на диске сейчас (приходит из file:hashes)
//
// dirty      = text !== savedText        (точное посимвольное сравнение — строже хэша)
// diskDrift  = diskHash !== savedHash    (файл изменился вне редактора)
// Хэш буфера не вычисляем: в sandbox-рендерере нет Node-crypto, а дублировать
// encodeLike+sha256 в два процесса нельзя (см. src/versions.js).

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WhaleEditorState = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  const V = (typeof require === 'function')
    ? require('../src/versions')
    : (root && root.WhaleVersions);

  const baseName = (p) => String(p || '').split(/[\\/]/).pop() || '';

  /** Новое пустое состояние. order — порядок вкладок, files — Map по path. */
  function createState() {
    return { order: [], files: new Map(), active: null };
  }

  const get = (state, path) => state.files.get(path) || null;
  const active = (state) => (state.active ? get(state, state.active) : null);
  const list = (state) => state.order.map((p) => get(state, p)).filter(Boolean);

  /**
   * Открывает файл (или возвращает уже открытый, делая его активным).
   * @param {{projectId:string, path:string, content:string, hash:string, eol?:string, hasBom?:boolean, language?:string}} file
   */
  function open(state, file) {
    if (!file || typeof file.path !== 'string' || !file.path) throw new Error('open: не указан path');
    const existing = get(state, file.path);
    if (existing) {
      // Уже открыт: содержимое с диска НЕ подменяем — иначе несохранённая правка исчезнет.
      // Обновляем только то, что могло устареть и не относится к буферу.
      existing.diskHash = file.hash != null ? file.hash : existing.diskHash;
      state.active = existing.path;
      return { state, entry: existing, reopened: true };
    }
    const entry = {
      projectId: file.projectId,
      path: file.path,
      name: baseName(file.path),
      savedText: typeof file.content === 'string' ? file.content : '',
      text: typeof file.content === 'string' ? file.content : '',
      savedHash: file.hash != null ? file.hash : null,
      diskHash: file.hash != null ? file.hash : null,
      eol: file.eol || 'lf',
      hasBom: !!file.hasBom,
      missing: false,
      language: file.language || 'plaintext',
      viewState: null,
      openedAt: Date.now(),
    };
    state.files.set(entry.path, entry);
    state.order.push(entry.path);
    state.active = entry.path;
    return { state, entry, reopened: false };
  }

  /** Содержимое буфера изменилось (Monaco onDidChangeModelContent). */
  function setText(state, path, text) {
    const f = get(state, path);
    if (!f) return null;
    f.text = typeof text === 'string' ? text : '';
    return f;
  }

  /** Успешное сохранение: точка сохранения догоняет буфер и диск (§12). */
  function setSaved(state, path, { text, hash }) {
    const f = get(state, path);
    if (!f) return null;
    if (typeof text === 'string') { f.savedText = text; f.text = text; }
    if (hash != null) { f.savedHash = hash; f.diskHash = hash; }
    return f;
  }

  /** Перечитали файл с диска, отказавшись от своих правок (§11, «Перезагрузить файл»). */
  function reload(state, path, { content, hash, eol, hasBom }) {
    const f = get(state, path);
    if (!f) return null;
    f.savedText = typeof content === 'string' ? content : '';
    f.text = f.savedText;
    f.savedHash = hash != null ? hash : null;
    f.diskHash = f.savedHash;
    f.missing = hash == null;
    if (eol) f.eol = eol;
    if (hasBom != null) f.hasBom = !!hasBom;
    return f;
  }

  /**
   * База для «Сохранить поверх» (§11).
   *
   * Отдельной мутации состояния здесь намеренно нет: «сохранить поверх» — это обычная
   * запись, у которой expectedHash равен фактическому хэшу диска, а не хэшу точки
   * сохранения. Если диск снова изменится до записи, main ответит conflict ещё раз.
   * После успешной записи вызывается setSaved(). Любая другая схема (например, заранее
   * приравнять savedText к буферу) пометила бы файл чистым ДО записи на диск.
   */
  function forceSaveBase(state, path) {
    const f = get(state, path);
    return f ? f.diskHash : null;
  }

  /**
   * file:hashes: обновляем, что сейчас на диске.
   * hash === null означает «файл удалён или не читается» — это отдельный факт (missing),
   * а не «хэш неизвестен»: сохранять в несуществующий файл нельзя, и молчать об этом нельзя.
   */
  function setDiskHash(state, path, hash) {
    const f = get(state, path);
    if (!f) return null;
    f.diskHash = hash == null ? null : hash;
    f.missing = hash == null;
    return f;
  }

  function setDiskHashes(state, map) {
    if (!map || typeof map !== 'object') return state;
    for (const path of state.order) {
      // Обновляем только то, что реально пришло в ответе: иначе отсутствие ключа
      // (например, файл из другого проекта) выглядело бы как удаление файла.
      if (Object.prototype.hasOwnProperty.call(map, path)) setDiskHash(state, path, map[path]);
    }
    return state;
  }

  /** §14: состояние вида (курсор, прокрутка) хранится на вкладке, а не в DOM. */
  function setViewState(state, path, viewState) {
    const f = get(state, path);
    if (f) f.viewState = viewState || null;
    return f;
  }

  const isDirty = (f) => !!f && f.text !== f.savedText;
  const isDrifted = (f) => !!f && f.savedHash != null && f.diskHash != null && f.diskHash !== f.savedHash;
  const isMissing = (f) => !!f && f.missing === true;

  /**
   * Буфер чист, а диск уехал — содержимое можно безопасно перечитать.
   * Именно этот случай раньше приводил в тупик: редактор показывал старое, dirty был false,
   * поэтому Ctrl+S отвечал «изменений нет», а новое содержимое не подтягивалось.
   */
  const needsReload = (f) => isDrifted(f) && !isDirty(f);

  /** Полная классификация версий файла (§37) — делегируем src/versions.js, не дублируем правила. */
  function describe(state, path) {
    const f = get(state, path);
    if (!f) return null;
    const v = V.classifyVersions({
      disk: f.diskHash,
      saved: f.savedHash,
      editor: null, // хэш буфера не считаем — dirty известен точно
      dirty: isDirty(f),
    });
    return {
      ...v,
      dirty: isDirty(f),
      diskDrift: isDrifted(f),
      missing: isMissing(f),
      needsReload: needsReload(f),
      path: f.path,
      name: f.name,
      language: f.language,
    };
  }

  /**
   * Закрытие вкладки (§12).
   * @returns {{closed:boolean, reason?:'dirty'}} closed=false значит «нужен вопрос пользователю»
   */
  function close(state, path, { force = false } = {}) {
    const f = get(state, path);
    if (!f) return { closed: true };
    if (isDirty(f) && !force) return { closed: false, reason: 'dirty' };
    const i = state.order.indexOf(path);
    state.files.delete(path);
    state.order.splice(i, 1);
    if (state.active !== path) return { closed: true };
    // Активной становится соседняя вкладка: правая, иначе левая, иначе ничего
    state.active = state.order[Math.min(i, state.order.length - 1)] || null;
    return { closed: true };
  }

  function activate(state, path) {
    if (!get(state, path)) return null;
    state.active = path;
    return get(state, path);
  }

  /** Ctrl+Tab: следующая вкладка по кругу. dir = 1 | -1 */
  function activateRelative(state, dir = 1) {
    if (!state.order.length) return null;
    const i = state.order.indexOf(state.active);
    const n = state.order.length;
    const next = state.order[(i < 0 ? 0 : (i + dir + n) % n)];
    state.active = next;
    return get(state, next);
  }

  /** Есть ли несохранённые правки (для предупреждения при закрытии окна). */
  const hasUnsaved = (state) => state.order.some((p) => isDirty(get(state, p)));
  const dirtyPaths = (state) => state.order.filter((p) => isDirty(get(state, p)));
  const driftedPaths = (state) => state.order.filter((p) => isDrifted(get(state, p)));

  return {
    createState, open, get, active, list,
    setText, setSaved, reload, forceSaveBase,
    setDiskHash, setDiskHashes, setViewState,
    isDirty, isDrifted, isMissing, needsReload, describe,
    close, activate, activateRelative,
    hasUnsaved, dirtyPaths, driftedPaths, baseName,
  };
});

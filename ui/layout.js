'use strict';
// Математика раскладки IDE (этап B, ТЗ §4, §28; доработка по ручной проверке).
//
// Чистые функции: ни DOM, ни Electron, ни Monaco — поэтому clamp размеров и поведение
// разделителей покрыты node-тестами (tests/layout.test.js), а не «на глаз».
//
// Правила одни на два процесса (UMD-обёртка, как у src/versions.js и src/context.js):
//   renderer — считает размеры при перетаскивании разделителей и применяет их к CSS;
//   main     — sanitize() при сохранении в config.json, normalizeRect() перед setBounds.
//
// Главный контракт этапа (§4, §28): геометрию определяет CSS в renderer. main не знает
// ни про ratio, ни про раскладку вообще: он получает готовый прямоугольник (#chat-slot)
// и физически кладёт туда WebContentsView.
//
// Раскладка (итоговая, по ручной проверке 0013):
//   .app       строки: topbar / workspace
//   .workspace колонки: IDE / разделитель / чат. Чат ВСЕГДА справа: перенос стороны
//              ломал рендер нативного слоя, поэтому переключатель удалён.
//   .ide       колонки: левая панель (Файлы/Предложения/История) / разделитель / редактор
//   «Промпт» открывается внутри панели редактора вместо кода (переключатель в topbar).

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WhaleLayout = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // Ширина разделителя в px — должна совпадать со стилем .vsplit
  const SPLITTER = 5;

  const LEFT_TABS = Object.freeze(['files', 'proposals', 'history']);

  const DEFAULTS = Object.freeze({
    leftW: 320,     // левая панель: дерево / предложения / история
    chatW: 420,     // чат DeepSeek
    promptOpen: false, // «Промпт» открыт вместо редактора
    leftTab: 'files',
    // Терминал (этап C3, ТЗ §2.1): нижняя панель внутри колонки редактора.
    // termH — высота панели вместе с её toolbar'ом; чат всегда полная высота,
    // терминал на него не наезжает.
    termOpen: false,
    termH: 260,
  });

  const LIMITS = Object.freeze({
    leftMin: 200,    // левая панель
    chatMin: 320,    // чат уже — нечитаемо
    editorMin: 240,  // редактор
    chatMaxRatio: 0.6, // чат не шире 60% окна
    termMin: 120,    // терминал ниже — нечитаемо
    termReserve: 300, // минимальный запас высоты окна редактору и topbar
  });

  const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const leftTab = (v) => (LEFT_TABS.includes(v) ? v : DEFAULTS.leftTab);

  /** Сумма фиксированных колонок: левая панель + чат + два разделителя. */
  const fixedWidth = (l) => l.leftW + l.chatW + SPLITTER * 2;

  /** Ширина колонки редактора (minmax(0,1fr) — всё, что осталось). */
  function editorWidth(l, winW) {
    return Math.max(0, Math.round(winW - fixedWidth(l)));
  }

  const copy = (l) => ({
    leftW: l.leftW, chatW: l.chatW,
    promptOpen: !!l.promptOpen, leftTab: leftTab(l.leftTab),
    termOpen: !!l.termOpen, termH: l.termH,
  });

  /**
   * Приводит что угодно (config.json, payload из IPC) к корректной раскладке.
   * Мигрирует прежние схемы: leftW берётся из leftW → filesW (дерево) → sideW
   * (боковая панель 0012), но не уже 280px: панель стала показывать ещё и списки
   * предложений, узкое дерево для них не годится. chatSide/bottomH/promptW прежних
   * схем просто игнорируются — чат теперь всегда справа, а нижняя панель этапа B
   * удалена (терминал C3 — новая панель внутри колонки редактора, termH/termOpen).
   * winW/winH неизвестны (null/undefined) — ограничиваемся абсолютными минимумами.
   */
  function sanitize(raw, winW, winH) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const legacyLeft = Math.max(280, num(src.filesW, num(src.sideW, DEFAULTS.leftW)));
    return fitToWindow({
      leftW: Math.round(num(src.leftW, legacyLeft)),
      chatW: Math.round(num(src.chatW, DEFAULTS.chatW)),
      promptOpen: bool(src.promptOpen, DEFAULTS.promptOpen),
      leftTab: leftTab(src.leftTab),
      termOpen: bool(src.termOpen, DEFAULTS.termOpen),
      termH: Math.round(num(src.termH, DEFAULTS.termH)),
    }, winW, winH);
  }

  /**
   * Укладывает раскладку в ширину окна. Редактор получает остаток, но не меньше editorMin;
   * если места не хватает, панели урезаются в порядке: левая → чат. Чат жмётся последним:
   * это рабочий инструмент, а не вспомогательная панель.
   */
  function fitToWindow(l, winW, winH) {
    const out = copy(l);
    // Высота терминала ограничена и без знания окна — абсолютным минимумом
    out.termH = Math.max(LIMITS.termMin, Math.round(num(out.termH, DEFAULTS.termH)));
    if (typeof winH === 'number' && isFinite(winH) && winH > 0) {
      out.termH = Math.min(out.termH, Math.max(LIMITS.termMin, Math.round(winH - LIMITS.termReserve)));
    }
    if (typeof winW !== 'number' || !isFinite(winW) || winW <= 0) {
      out.leftW = Math.max(LIMITS.leftMin, out.leftW);
      out.chatW = Math.max(LIMITS.chatMin, out.chatW);
      return out;
    }
    const chatMax = Math.max(LIMITS.chatMin, Math.floor(winW * LIMITS.chatMaxRatio));
    out.chatW = clamp(out.chatW, LIMITS.chatMin, chatMax);
    out.leftW = Math.max(LIMITS.leftMin, out.leftW);

    const overflow = () => fixedWidth(out) + LIMITS.editorMin - winW;
    let over = overflow();
    if (over > 0) { const d = Math.min(over, out.leftW - LIMITS.leftMin); out.leftW -= d; }
    over = overflow();
    if (over > 0) { const d = Math.min(over, out.chatW - LIMITS.chatMin); out.chatW -= d; }
    return out;
  }

  /**
   * Изменение размеров при перетаскивании разделителя.
   * @param {object} l текущая раскладка
   * @param {'left'|'chat'|'term'} which какой разделитель тянут
   * @param {number} delta сдвиг мыши в px (вправо/вниз — положительно)
   * @param {{w:number,h:number}|number} win ширина содержимого окна (h — для терминала)
   *
   * Редактор поглощает изменение, поэтому каждое движение ограничено двумя рамками:
   * минимум своей панели и минимум редактора. Чатовый разделитель стоит СЛЕВА от чата
   * (чат — правая колонка), поэтому движение вправо чат сужает: знак обратный.
   * Если рамки «схлопнулись» (окно уже всех минимумов), приоритет у абсолютного минимума.
   */
  function drag(l, which, delta, win) {
    const out = copy(l);
    const d0 = Math.round(num(delta, 0));
    const winW = num(win && typeof win === 'object' ? win.w : win, NaN);
    const ew = isFinite(winW) ? editorWidth(out, winW) : Infinity;
    if (which === 'left') {
      const lo = LIMITS.leftMin - out.leftW;       // дальше минимума панель не жмётся
      const hi = ew - LIMITS.editorMin;            // шире — пока редактор не упёрся
      out.leftW += lo > hi ? lo : clamp(d0, lo, hi);
    } else if (which === 'chat') {
      const d = -d0; // тянем влево — чат шире
      const chatMax = isFinite(winW)
        ? Math.max(LIMITS.chatMin, Math.floor(winW * LIMITS.chatMaxRatio))
        : Infinity;
      const hi = Math.min(chatMax - out.chatW, ew - LIMITS.editorMin);
      const lo = LIMITS.chatMin - out.chatW;
      out.chatW += lo > hi ? lo : clamp(d, lo, hi);
    } else if (which === 'term') {
      // Горизонтальный разделитель над терминалом: тянем ВВЕРХ (delta<0) — выше.
      // Верхняя рамка — запас высоты окна редактору (termReserve), нижняя — termMin.
      const d = -d0;
      const winH = num(win && typeof win === 'object' ? win.h : NaN, NaN);
      const hi = isFinite(winH) && winH > 0
        ? Math.max(LIMITS.termMin, Math.round(winH - LIMITS.termReserve)) - out.termH
        : Infinity;
      const lo = LIMITS.termMin - out.termH;
      out.termH += lo > hi ? lo : clamp(d, lo, hi);
    }
    return out;
  }

  /**
   * Прямоугольник для chat:set-bounds: целые неотрицательные px, без нулевого размера
   * (нулевую ячейку Grid main показывать не должен — WebContentsView нулевого размера
   * ведёт себя на Windows непредсказуемо). null — отправлять нечего.
   */
  function normalizeRect(r) {
    if (!r || typeof r !== 'object') return null;
    const rect = {
      x: Math.round(num(r.x, NaN)),
      y: Math.round(num(r.y, NaN)),
      width: Math.round(num(r.width, NaN)),
      height: Math.round(num(r.height, NaN)),
    };
    for (const v of Object.values(rect)) if (!isFinite(v) || v < 0) return null;
    if (!rect.width || !rect.height) return null;
    return rect;
  }

  /** CSS-переменные раскладки: renderer применяет их к :root одним циклом. */
  function cssVars(l) {
    return {
      '--left-w': l.leftW + 'px',
      '--chat-w': l.chatW + 'px',
      '--term-h': l.termH + 'px',
    };
  }

  return {
    SPLITTER, DEFAULTS, LIMITS, LEFT_TABS,
    sanitize, fitToWindow, editorWidth, drag, normalizeRect, cssVars,
  };
});

'use strict';
// Математика раскладки IDE (этап B, ТЗ §4–§6, §28).
//
// Чистые функции: ни DOM, ни Electron, ни Monaco — поэтому clamp ширины, поведение
// разделителей и сторона чата покрыты node-тестами (tests/layout.test.js), а не «на глаз».
//
// Правила одни на два процесса (UMD-обёртка, как у src/versions.js и src/context.js):
//   renderer — считает widths/height при перетаскивании разделителей и применяет их к CSS;
//   main     — sanitize() при сохранении в config.json, normalizeRect() перед setBounds.
//
// Главный контракт этапа (§4, §28): геометрию определяет CSS в renderer. main не знает
// ни про ratio, ни про «чат слева»: он получает готовый прямоугольник (#chat-slot)
// и физически кладёт туда WebContentsView.
//
// Раскладка (по просьбе пользователя, патч 0013):
//   .app       строки: topbar / workspace / горизонтальный разделитель / нижняя панель
//   .workspace колонки: chat-col / разделитель / IDE
//   .chat-col  колонки: чат-слот / разделитель / «Промпт» (когда открыт)
//   .ide       колонки: файлы / разделитель / редактор
//   нижняя панель — «Предложения» и «История» (как консоль в VS Code), сворачивается.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WhaleLayout = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // Ширина разделителя в px — должна совпадать со стилем .vsplit/.hsplit
  const SPLITTER = 5;

  const DEFAULTS = Object.freeze({
    chatW: 420,     // слот чата DeepSeek (без панели «Промпт»)
    filesW: 220,    // дерево файлов
    promptW: 460,   // панель «Промпт» рядом с чатом
    bottomH: 260,   // нижняя панель (Предложения/История)
    chatSide: 'left',
    promptOpen: false,
    bottomCollapsed: false,
  });

  const LIMITS = Object.freeze({
    chatMin: 320,      // чат уже — нечитаемо
    filesMin: 160,     // дерево файлов
    promptMin: 280,    // конструктор промптов
    editorMin: 240,    // редактор
    bottomMin: 120,    // нижняя панель
    bottomKeep: 260,   // сколько высоты окна обязательно остаётся рабочей области
    chatMaxRatio: 0.6, // слот чата не шире 60% окна
  });

  const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const side = (s) => (s === 'right' ? 'right' : 'left');

  /** Ширина чат-колонки: слот чата + разделитель + «Промпт», когда он открыт. */
  const chatColW = (l) => l.chatW + (l.promptOpen ? l.promptW + SPLITTER : 0);

  /** Сумма фиксированных колонок workspace: чат-колонка + файлы + два разделителя. */
  const fixedWidth = (l) => chatColW(l) + l.filesW + SPLITTER * 2;

  /** Ширина колонки редактора (minmax(0,1fr) — всё, что осталось). */
  function editorWidth(l, winW) {
    return Math.max(0, Math.round(winW - fixedWidth(l)));
  }

  const copy = (l) => ({
    chatW: l.chatW, filesW: l.filesW, promptW: l.promptW, bottomH: l.bottomH,
    chatSide: side(l.chatSide), promptOpen: !!l.promptOpen, bottomCollapsed: !!l.bottomCollapsed,
  });

  /**
   * Приводит что угодно (config.json, payload из IPC) к корректной раскладке.
   * Мигрирует раскладку патча 0012: ширина бывшей боковой панели (sideW) становится
   * шириной панели «Промпт» — это её прямой наследник.
   * winW/winH неизвестны (null/undefined) — ограничиваемся абсолютными минимумами.
   */
  function sanitize(raw, winW, winH) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return fitToWindow({
      chatW: Math.round(num(src.chatW, DEFAULTS.chatW)),
      filesW: Math.round(num(src.filesW, DEFAULTS.filesW)),
      promptW: Math.round(num(src.promptW, num(src.sideW, DEFAULTS.promptW))),
      bottomH: Math.round(num(src.bottomH, DEFAULTS.bottomH)),
      chatSide: side(src.chatSide),
      promptOpen: bool(src.promptOpen, DEFAULTS.promptOpen),
      bottomCollapsed: bool(src.bottomCollapsed, DEFAULTS.bottomCollapsed),
    }, winW, winH);
  }

  /**
   * Укладывает раскладку в размер окна. Редактор получает остаток, но не меньше editorMin;
   * если места не хватает, панели урезаются в порядке: «Промпт» → файлы → чат.
   * Чат жмётся последним: это рабочий инструмент, а не вспомогательная панель.
   * Высота нижней панели ограничена сверху так, чтобы рабочей области оставалось bottomKeep.
   */
  function fitToWindow(l, winW, winH) {
    const out = copy(l);
    if (typeof winW === 'number' && isFinite(winW) && winW > 0) {
      const chatMax = Math.max(LIMITS.chatMin, Math.floor(winW * LIMITS.chatMaxRatio));
      out.chatW = clamp(out.chatW, LIMITS.chatMin, chatMax);
      out.filesW = Math.max(LIMITS.filesMin, out.filesW);
      out.promptW = Math.max(LIMITS.promptMin, out.promptW);

      const overflow = () => fixedWidth(out) + LIMITS.editorMin - winW;
      let over = overflow();
      if (over > 0 && out.promptOpen) { const d = Math.min(over, out.promptW - LIMITS.promptMin); out.promptW -= d; }
      over = overflow();
      if (over > 0) { const d = Math.min(over, out.filesW - LIMITS.filesMin); out.filesW -= d; }
      over = overflow();
      if (over > 0) { const d = Math.min(over, out.chatW - LIMITS.chatMin); out.chatW -= d; }
    } else {
      out.chatW = Math.max(LIMITS.chatMin, out.chatW);
      out.filesW = Math.max(LIMITS.filesMin, out.filesW);
      out.promptW = Math.max(LIMITS.promptMin, out.promptW);
    }
    if (typeof winH === 'number' && isFinite(winH) && winH > 0) {
      const bottomMax = Math.max(LIMITS.bottomMin, winH - LIMITS.bottomKeep);
      out.bottomH = clamp(out.bottomH, LIMITS.bottomMin, bottomMax);
    } else {
      out.bottomH = Math.max(LIMITS.bottomMin, out.bottomH);
    }
    return out;
  }

  /**
   * Изменение размеров при перетаскивании разделителя.
   * @param {object} l текущая раскладка
   * @param {'chat'|'files'|'prompt'|'bottom'} which какой разделитель тянут
   * @param {number} delta сдвиг мыши в px (вправо/вниз — положительно)
   * @param {{w:number,h:number}} win размер содержимого окна
   *
   * Редактор поглощает изменение по ширине, поэтому каждое движение ограничено двумя
   * рамками: минимум своей панели и минимум редактора. Чат справа меняет знак: тянем
   * влево — шире. «Промпт» тянется влево — шире (слот чата при этом не уменьшается:
   * растёт вся чат-колонка, editor поглощает). Нижняя панель тянется вверх — выше.
   * Если рамки «схлопнулись» (окно уже/ниже всех минимумов), приоритет у абсолютного минимума.
   */
  function drag(l, which, delta, win) {
    const out = copy(l);
    const d0 = Math.round(num(delta, 0));
    const winW = num(win && win.w, NaN);
    const winH = num(win && win.h, NaN);
    const ew = isFinite(winW) ? editorWidth(out, winW) : Infinity;
    // допустимый сдвиг ширины панели
    const allowed = (d, min, cur) => {
      const lo = min - cur;                  // дальше минимума панель не жмётся
      const hi = ew - LIMITS.editorMin;      // шире — пока редактор не упёрся в свой минимум
      if (!isFinite(hi)) return Math.max(lo, d);
      return lo > hi ? lo : clamp(d, lo, hi);
    };
    if (which === 'chat') {
      const d = out.chatSide === 'right' ? -d0 : d0;
      const chatMax = isFinite(winW)
        ? Math.max(LIMITS.chatMin, Math.floor(winW * LIMITS.chatMaxRatio))
        : Infinity;
      const hi = Math.min(chatMax - out.chatW, ew - LIMITS.editorMin);
      const lo = LIMITS.chatMin - out.chatW;
      out.chatW += lo > hi ? lo : clamp(d, lo, hi);
    } else if (which === 'files') {
      out.filesW += allowed(d0, LIMITS.filesMin, out.filesW);
    } else if (which === 'prompt') {
      out.promptW += allowed(-d0, LIMITS.promptMin, out.promptW);
    } else if (which === 'bottom') {
      const d = -d0; // тянем вверх (delta < 0) — панель выше
      const bottomMax = isFinite(winH) ? Math.max(LIMITS.bottomMin, winH - LIMITS.bottomKeep) : Infinity;
      const lo = LIMITS.bottomMin - out.bottomH;
      const hi = bottomMax - out.bottomH;
      out.bottomH += lo > hi ? lo : clamp(d, lo, hi);
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
      '--chat-w': l.chatW + 'px',
      '--chat-col-w': chatColW(l) + 'px',
      '--files-w': l.filesW + 'px',
      '--prompt-w': l.promptW + 'px',
      '--bottom-h': l.bottomH + 'px',
    };
  }

  return {
    SPLITTER, DEFAULTS, LIMITS,
    sanitize, fitToWindow, editorWidth, chatColW, drag, normalizeRect, cssVars,
  };
});

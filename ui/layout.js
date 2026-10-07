'use strict';
// Математика раскладки IDE (этап B, ТЗ §4–§6, §28).
//
// Чистые функции: ни DOM, ни Electron, ни Monaco — поэтому clamp ширины, поведение
// разделителей и сторона чата покрыты node-тестами (tests/layout.test.js), а не «на глаз».
//
// Правила одни на два процесса (UMD-обёртка, как у src/versions.js и src/context.js):
//   renderer — считает widths при перетаскивании разделителей и применяет их к CSS;
//   main     —sanitize() при сохранении в config.json, normalizeRect() перед setBounds.
//
// Главный контракт этапа (§4, §28): геометрию определяет CSS в renderer. main не знает
// ни про ratio, ни про «чат слева»: он получает готовый прямоугольник (#chat-slot)
// и физически кладёт туда WebContentsView.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WhaleLayout = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // Ширина разделителя в px — должна совпадать со стилем .vsplit
  const SPLITTER = 5;

  const DEFAULTS = Object.freeze({ chatW: 420, filesW: 220, sideW: 380, chatSide: 'left' });

  const LIMITS = Object.freeze({
    chatMin: 320,      // чат уже — нечитаемо
    filesMin: 160,     // дерево файлов
    sideMin: 240,      // боковая панель (предложения/история/промпт)
    editorMin: 240,    // редактор
    chatMaxRatio: 0.6, // чат не шире 60% окна
  });

  const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const side = (s) => (s === 'right' ? 'right' : 'left');

  /** Сумма фиксированных колонок: чат + файлы + боковая + три разделителя. */
  const fixedWidth = (l) => l.chatW + l.filesW + l.sideW + SPLITTER * 3;

  /** Ширина колонки редактора (minmax(0,1fr) — всё, что осталось). */
  function editorWidth(l, winW) {
    return Math.max(0, Math.round(winW - fixedWidth(l)));
  }

  /**
   * Приводит что угодно (config.json, payload из IPC) к корректной раскладке.
   * winW неизвестна (null/undefined) — ограничиваемся абсолютными минимумами.
   */
  function sanitize(raw, winW) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return fitToWindow({
      chatW: Math.round(num(src.chatW, DEFAULTS.chatW)),
      filesW: Math.round(num(src.filesW, DEFAULTS.filesW)),
      sideW: Math.round(num(src.sideW, DEFAULTS.sideW)),
      chatSide: side(src.chatSide),
    }, winW);
  }

  /**
   * Укладывает раскладку в ширину окна. Редактор получает остаток, но не меньше editorMin;
   * если места не хватает, панели урезаются в порядке: боковая → файлы → чат.
   * Чат жмётся последним: это рабочий инструмент, а не вспомогательная панель.
   * Когда даже минимумы не влезают (очень узкое окно), панели остаются на минимумах —
   * колонка редактора (1fr) схлопнется сама, CSS это переживёт.
   */
  function fitToWindow(l, winW) {
    const out = { chatW: l.chatW, filesW: l.filesW, sideW: l.sideW, chatSide: side(l.chatSide) };
    if (typeof winW !== 'number' || !isFinite(winW) || winW <= 0) {
      out.chatW = Math.max(LIMITS.chatMin, out.chatW);
      out.filesW = Math.max(LIMITS.filesMin, out.filesW);
      out.sideW = Math.max(LIMITS.sideMin, out.sideW);
      return out;
    }
    const chatMax = Math.max(LIMITS.chatMin, Math.floor(winW * LIMITS.chatMaxRatio));
    out.chatW = clamp(out.chatW, LIMITS.chatMin, chatMax);
    out.filesW = Math.max(LIMITS.filesMin, out.filesW);
    out.sideW = Math.max(LIMITS.sideMin, out.sideW);

    const overflow = () => fixedWidth(out) + LIMITS.editorMin - winW;
    let over = overflow();
    if (over > 0) { const d = Math.min(over, out.sideW - LIMITS.sideMin); out.sideW -= d; }
    over = overflow();
    if (over > 0) { const d = Math.min(over, out.filesW - LIMITS.filesMin); out.filesW -= d; }
    over = overflow();
    if (over > 0) { const d = Math.min(over, out.chatW - LIMITS.chatMin); out.chatW -= d; }
    return out;
  }

  /**
   * Изменение ширины при перетаскивании разделителя.
   * @param {{chatW:number,filesW:number,sideW:number,chatSide:string}} l  текущая раскладка
   * @param {'chat'|'files'|'side'} which какой разделитель тянут
   * @param {number} dx сдвиг мыши в px (вправо — положительно)
   * @param {number} winW ширина содержимого окна
   *
   * Редактор поглощает изменение, поэтому каждое движение ограничено двумя рамками:
   * минимум своей панели и минимум редактора. Чат справа меняет знак: тянем влево — шире.
   * Если рамки «схлопнулись» (окно уже всех минимумов), приоритет у абсолютного минимума.
   */
  function drag(l, which, dx, winW) {
    const out = { chatW: l.chatW, filesW: l.filesW, sideW: l.sideW, chatSide: side(l.chatSide) };
    const delta = Math.round(num(dx, 0));
    const ew = editorWidth(out, winW);
    // допустимый сдвиг ширины панели
    const allowed = (d, min, cur) => {
      const lo = min - cur;          // дальше минимума панель не жмётся
      const hi = ew - LIMITS.editorMin; // шире — пока редактор не упёрся в свой минимум
      return lo > hi ? lo : clamp(d, lo, hi);
    };
    if (which === 'chat') {
      const d = out.chatSide === 'right' ? -delta : delta;
      const chatMax = Math.max(LIMITS.chatMin, Math.floor(winW * LIMITS.chatMaxRatio));
      // верхняя рамка чата — и 60% окна, и минимум редактора; берём строжайшую
      const hi = Math.min(chatMax - out.chatW, ew - LIMITS.editorMin);
      const lo = LIMITS.chatMin - out.chatW;
      out.chatW += lo > hi ? lo : clamp(d, lo, hi);
    } else if (which === 'files') {
      out.filesW += allowed(delta, LIMITS.filesMin, out.filesW);
    } else if (which === 'side') {
      // тянем вправо — боковая панель уже
      out.sideW += allowed(-delta, LIMITS.sideMin, out.sideW);
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
    return { '--chat-w': l.chatW + 'px', '--files-w': l.filesW + 'px', '--side-w': l.sideW + 'px' };
  }

  return {
    SPLITTER, DEFAULTS, LIMITS,
    sanitize, fitToWindow, editorWidth, drag, normalizeRect, cssVars,
  };
});

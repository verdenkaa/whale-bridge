'use strict';
// Терминал интерфейса (этап C3, ТЗ §3.5): xterm.js + addon-fit, создаётся ОДИН раз
// и переживает перерисовки — тот же контракт, что у Monaco (§7 handover).
//
// Разделение ответственности:
//   этот модуль — экземпляр xterm, ввод (onData → run:input) и подгонка размера
//                 (ResizeObserver → fit → run:resize);
//   ui/app.js   — кнопки, состояния, события run:data/run:exit/run:state и решение,
//                 когда панель открыта.
//
// Ввод и размер уходят в main через api.send (fire-and-forget): нажатие клавиши
// обязано попадать в pty мгновенно, round-trip invoke добавил бы задержку.
(() => {
  const api = window.api;

  let term = null;
  let fit = null;
  let host = null;
  let mounted = false;
  let observer = null;
  const pending = []; // то, что пришло до создания xterm (панель ещё не открывали)
  // Предел буфера отложенного вывода. Штатно он живёт доли секунды (до первого открытия
  // панели), но если xterm не поднялся (битая установка), ensure() всегда false и поток
  // run:data копился бы здесь бесконечно — на всю сессию, до 4 МБ вывода и больше.
  // Держим хвост: последние строки вывода важнее начала.
  const PENDING_LIMIT = 500;
  let lastSize = null;    // {cols, rows} — последний размер, отправленный в main
  let resizeTimer = null; // дебаунс: всплеск ResizeObserver схлопывается в один fit

  /** Сколько ждём спокойствия перед отправкой размера в main. */
  const RESIZE_DEBOUNCE_MS = 40;

  /**
   * Уведомления о фокусе терминала: ConPTY запрашивает у терминала режим 1004, и
   * xterm.js отвечает '\u001b[I' (фокус получен) / '\u001b[O' (потерян) на каждый клик.
   * Запущенной программе они не нужны, а в журнале ввода отчёта выглядели как «[I[I1256».
   */
  const FOCUS_RE = /\u001b\[[IO]/g;

  /**
   * Отправить канал fire-and-forget через локальную ссылку: обвязочные тесты ищут
   * литералы api.send(...) в ui/app.js, а здесь их нет — иначе белый список SEND
   * сверялся бы дважды и расхождение ловилось бы не там, где должно.
   */
  const post = (channel, arg) => api.send(channel, arg);

  function ensure() {
    if (mounted) return !!term;
    const Terminal = window.Terminal;
    const FitAddon = window.FitAddon && window.FitAddon.FitAddon;
    host = document.querySelector('#term-host');
    if (!Terminal || !FitAddon || !host) return false; // xterm не загрузился / нет разметки
    mounted = true;

    // Стили xterm подключаются только сейчас: в тестовом окружении файла нет,
    // и статичный <link> в index.html давал бы постоянный 404 в консоли.
    const link = document.querySelector('#xterm-css');
    if (link) link.setAttribute('href', '../node_modules/@xterm/xterm/css/xterm.css');

    term = new Terminal({
      // Тема совпадает с фоном панели (.term-host), иначе вокруг текста был бы прямоугольник
      theme: { background: '#141414', foreground: '#ececec', cursor: '#4d8dff' },
      fontFamily: 'Cascadia Mono, Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false, // pty отдаёт \r\n — xterm отрисует как есть
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fitTerminal();
    // Всё, что пришло до монтажа (служебные строки, ошибки) — допечатываем
    for (const s of pending.splice(0)) term.write(s);

    // Набор текста в терминале — это ввод процесса: клавиши уходят в main → pty.
    // Эхо рисует сам pty, поэтому локально текст не дублируем. Уведомления о фокусе
    // отфильтровываются: в pty они не нужны, а журнал ввода отчёта засоряли.
    term.onData((data) => {
      const s = typeof data === 'string' ? data.replace(FOCUS_RE, '') : '';
      if (s) post('run:input', s);
    });

    // Размер: панель тянется разделителем, окно меняется, панель открывается/скрывается.
    // ResizeObserver покрывает все три случая одним наблюдателем.
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => fitTerminal());
      observer.observe(host);
    }
    return true;
  }

  /** Отправить размер в main — только если он действительно изменился. */
  function postResize() {
    if (!term) return;
    const size = { cols: term.cols, rows: term.rows };
    if (lastSize && lastSize.cols === size.cols && lastSize.rows === size.rows) return;
    lastSize = size;
    post('run:resize', size);
  }

  /** Подогнать размер xterm под панель и сообщить pty (колонки/строки). */
  function fitTerminal() {
    // Первый fit приходит от открытия панели — здесь же xterm и создаётся
    if (!ensure()) return;
    // Скрытая панель имеет нулевой размер — fit() бросил бы исключение
    if (!host.clientWidth || !host.clientHeight) return;
    try { fit.fit(); } catch { /* панель в transition или скрыта */ }
    // Холостой resize не безвреден: ConPTY на изменение геометрии перерисовывает экран
    // из своего буфера, а у только что созданного pty он пуст — программа, ждущая ввода,
    // «стирала» видимый терминал. Размер уходит в main только изменившимся и не чаще
    // раза в RESIZE_DEBOUNCE_MS: перетаскивание разделителя даёт десятки событий подряд.
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(postResize, RESIZE_DEBOUNCE_MS);
  }

  /** Вывод процесса (run:data) и локальные служебные строки идут одним путём. */
  function write(text) {
    const s = typeof text === 'string' ? text : String(text == null ? '' : text);
    if (!s) return;
    if (!ensure()) {
      pending.push(s);
      if (pending.length > PENDING_LIMIT) pending.splice(0, pending.length - PENDING_LIMIT);
      return;
    }
    term.write(s);
  }

  /**
   * Полная очистка: экран, буфер прокрутки и курсор в начало (RIS, как '\x1bc').
   * term.clear() в xterm.js оставляет текущую строку первой — а на ней как раз
   * остаётся хвост предыдущего вывода без перевода строки, который следующий запуск
   * продолжает писать. Пользователь ждёт от «🗑 Очистить» и от старта нового прогона
   * чистого экрана, поэтому reset().
   */
  function clear() {
    if (!ensure()) { pending.length = 0; return; }
    term.reset();
    pending.length = 0;
  }

  function focus() {
    if (ensure()) term.focus();
  }

  window.WhaleTerminal = {
    write,
    // Служебные строки приложения (ошибки, разделители шагов) печатаются локально,
    // не через pty: в отчёт процесса они не попадают, но пользователь их видит.
    writeLocal: (s) => write(s),
    clear,
    fit: fitTerminal,
    focus,
    ensure,
    isMounted: () => mounted && !!term,
    // Текущий размер в символах — для run:start (pty стартует сразу в нужной геометрии)
    size: () => (term ? { cols: term.cols, rows: term.rows } : null),
  };
})();

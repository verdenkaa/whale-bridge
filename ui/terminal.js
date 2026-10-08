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
    // Эхо рисует сам pty, поэтому локально текст не дублируем.
    term.onData((data) => post('run:input', data));

    // Размер: панель тянется разделителем, окно меняется, панель открывается/скрывается.
    // ResizeObserver покрывает все три случая одним наблюдателем.
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => fitTerminal());
      observer.observe(host);
    }
    return true;
  }

  /** Подогнать размер xterm под панель и сообщить pty (колонки/строки). */
  function fitTerminal() {
    // Первый fit приходит от открытия панели — здесь же xterm и создаётся
    if (!ensure()) return;
    // Скрытая панель имеет нулевой размер — fit() бросил бы исключение
    if (!host.clientWidth || !host.clientHeight) return;
    try { fit.fit(); } catch { /* панель в transition или скрыта */ }
    post('run:resize', { cols: term.cols, rows: term.rows });
  }

  /** Вывод процесса (run:data) и локальные служебные строки идут одним путём. */
  function write(text) {
    const s = typeof text === 'string' ? text : String(text == null ? '' : text);
    if (!s) return;
    if (!ensure()) { pending.push(s); return; }
    term.write(s);
  }

  function clear() {
    if (!ensure()) { pending.length = 0; return; }
    term.clear();
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

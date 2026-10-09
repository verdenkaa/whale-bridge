'use strict';
// Работает внутри страницы DeepSeek (изолированный мир, sandbox).
// Страница НЕ получает никакого API: ipcRenderer доступен только этому скрипту.
// Скрипт только читает DOM: ничего не отправляет в чат и не обращается к API DeepSeek.
const { ipcRenderer } = require('electron');

(function () {
  if (!/(^|\.)deepseek\.com$/.test(location.hostname)) return;

  // ЕДИНСТВЕННОЕ место, зависящее от вёрстки DeepSeek. Если вёрстка изменится — правим здесь.
  const BLOCK_SELECTOR = 'pre';
  const SETTLE_MS = 1200; // блок «созрел», если текст не менялся столько времени
  const TICK_MS = 400;
  const BASELINE_MS = 2500; // всё, что появилось сразу после открытия чата, — «история»
  // Сколько блоков уходит одним сообщением chat:blocks. Совпадает с лимитом проверки
  // в main.js (blocks.length > 100 → пакет отбрасывается): больше — main не примет,
  // а блоки будут помечены отправленными и потеряны навсегда. Сверяется тестом.
  const SEND_CHUNK = 100;

  const nonce = Math.random().toString(36).slice(2, 10);
  const state = new WeakMap(); // pre -> {id, text, changedAt, sentText, initial}
  let nextId = 1;
  let chatId = chatIdFromUrl();
  let baselineUntil = Date.now() + BASELINE_MS;

  function chatIdFromUrl() {
    const m = location.pathname.match(/\/a\/chat\/s\/([0-9a-f-]{36})/i);
    return m ? m[1].toLowerCase() : null;
  }

  function trackUrl() {
    const id = chatIdFromUrl();
    if (id === chatId) return;
    const createdNow = chatId === null && id !== null; // новый чат получил id — это не смена чата
    chatId = id;
    baselineUntil = Date.now() + BASELINE_MS;
  }

  // Возвращает число блоков, которые ещё «дозревают» (текст есть, но не отправлен)
  function scan() {
    trackUrl();
    if (!chatId) return 0;
    const now = Date.now();
    const out = [];
    let pending = 0;
    document.querySelectorAll(BLOCK_SELECTOR).forEach((el) => {
      const text = el.textContent || '';
      let st = state.get(el);
      if (!st) {
        st = { id: nonce + '-' + nextId++, text, changedAt: now, sentText: null, initial: now < baselineUntil };
        state.set(el, st);
      } else if (st.text !== text) {
        st.text = text;
        st.changedAt = now;
      }
      if (st.sentText !== st.text && now - st.changedAt >= SETTLE_MS && st.text.trim()) {
        out.push({ key: st.id, text: st.text, initial: st.initial });
        st.sentText = st.text;
      } else if (st.sentText !== st.text && st.text.trim()) {
        pending++;
      }
    });
    // main принимает не больше SEND_CHUNK блоков в сообщении и отбрасывает пакет
    // целиком, если блоков больше (защита от аномального DOM). Отправлять всё одним
    // сообщением нельзя: при быстрой прокрутке длинного чата «дозревает» больше сотни
    // блоков за такт, весь пакет молча терялся, а sentText уже помечал их отправленными —
    // предложения из этих блоков не появлялись никогда. Поэтому режем на пакеты.
    for (let i = 0; i < out.length; i += SEND_CHUNK) {
      ipcRenderer.send('chat:blocks', { chatId, blocks: out.slice(i, i + SEND_CHUNK) });
    }
    return pending;
  }

  // Пока DOM меняется или есть «дозревающие» блоки — сканируем по таймеру; потом засыпаем
  let timer = null;
  let mutated = false;
  function schedule() {
    mutated = true;
    if (timer) return;
    timer = setInterval(() => {
      const wasMutated = mutated;
      mutated = false;
      const pending = scan();
      if (!wasMutated && pending === 0) {
        clearInterval(timer);
        timer = null;
      }
    }, TICK_MS);
  }

  function start() {
    // MutationObserver будит сканирование; сам интервал нужен, чтобы дождаться «успокоения» блока
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    schedule();
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();

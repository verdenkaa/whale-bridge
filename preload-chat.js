'use strict';
// Работает внутри страницы DeepSeek (изолированный мир, sandbox).
// Страница НЕ получает никакого API: ipcRenderer доступен только этому скрипту.
// Скрипт только читает DOM: ничего не отправляет в чат и не обращается к API DeepSeek.
const { ipcRenderer } = require('electron');

(function () {
  if (!/(^|\.)deepseek\.com$/.test(location.hostname)) return;

  // ЕДИНСТВЕННОЕ место, зависящее от вёрстки DeepSeek. Если вёрстка изменится — правим здесь.
  const BLOCK_SELECTOR = 'pre';
  // Только видимый текст сообщений: HTML-теги, классы и прочая разметка не считаются.
  // ds-markdown-paragraph покрывает обычный ответ и рассуждение DeepSeek,
  // ds-collapsible-text — текст пользовательского сообщения, pre — кодовые блоки.
  const TOKEN_SELECTOR = '.ds-markdown-paragraph, .ds-collapsible-text, pre';

  const SETTLE_MS = 1200; // блок «созрел», если текст не менялся столько времени
  const TICK_MS = 400;
  const BASELINE_MS = 2500; // всё, что появилось сразу после открытия чата, — «история»

  const nonce = Math.random().toString(36).slice(2, 10);
  const state = new WeakMap(); // pre -> {id, text, changedAt, sentText, initial}
  let nextId = 1;
  let chatId = chatIdFromUrl();
  let baselineUntil = Date.now() + BASELINE_MS;
  let tokenState = new WeakMap(); // element -> последнее число оценённых токенов
  let tokenTotal = 0;
  let lastSentTokens = -1;

  function chatIdFromUrl() {
    const m = location.pathname.match(/\/a\/chat\/s\/([0-9a-f-]{36})/i);
    return m ? m[1].toLowerCase() : null;
  }

  function trackUrl() {
    const id = chatIdFromUrl();
    if (id === chatId) return;
    const createdNow = chatId === null && id !== null; // новый чат получил id — это не смена чата
    chatId = id;
    tokenState = new WeakMap();
    tokenTotal = 0;
    lastSentTokens = -1;
    baselineUntil = Date.now() + BASELINE_MS;
  }

  // Грубая оценка токенов. Это намеренно не попытка повторить внутренний tokenizer DeepSeek:
  // для интерфейсного индикатора достаточно стабильной приблизительной оценки.
  function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.5);
  }

  function scanTokens() {
    if (!chatId) return;
    const seen = new Set();
    document.querySelectorAll(TOKEN_SELECTOR).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const text = el.textContent || '';
      const next = estimateTokens(text);
      const prev = tokenState.get(el);
      if (prev === undefined) {
        tokenState.set(el, next);
        tokenTotal += next;
      } else if (prev !== next) {
        tokenState.set(el, next);
        tokenTotal += next - prev;
      }
    });
    tokenTotal = Math.max(0, tokenTotal);
    if (tokenTotal !== lastSentTokens) {
      lastSentTokens = tokenTotal;
      ipcRenderer.send('chat:tokens', { chatId, tokens: tokenTotal });
    }
  }

  // Возвращает число блоков, которые ещё «дозревают» (текст есть, но не отправлен)
  function scan() {
    trackUrl();
    if (!chatId) return 0;
    scanTokens();
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
    if (out.length) ipcRenderer.send('chat:blocks', { chatId, blocks: out });
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

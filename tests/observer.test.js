'use strict';
// Проверка preload-chat.js на имитации DOM (без Electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

// Реальный фрагмент вёрстки DeepSeek из ТЗ; textContent = конкатенация текстовых узлов
const REAL_TEXT = '# &main.py\nprint("Hello, World!")';

test('observer: стабильный блок отправляется один раз, дописываемый — только после «успокоения»', async () => {
  const sent = [];
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { ipcRenderer: { send: (ch, payload) => sent.push({ ch, payload }) } };
    return origLoad.call(this, request, ...rest);
  };

  const el = { textContent: '# &main.py\nprint("Hel' }; // идёт генерация
  global.location = { hostname: 'chat.deepseek.com', pathname: '/a/chat/s/17b45023-2aba-4a1a-a966-17bbe41926ea' };
  let mutate = () => {};
  global.MutationObserver = class { constructor(cb) { mutate = cb; } observe() {} };
  global.document = { documentElement: {}, querySelectorAll: (selector) => selector === 'pre' || selector.includes('ds-markdown-paragraph') ? [el] : [] };

  const file = path.join(__dirname, '..', 'preload-chat.js');
  delete require.cache[file];
  require(file);
  try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(700);
    el.textContent = '# &main.py\nprint("Hello'; mutate(); // продолжается стриминг
    await wait(700);
    assert.equal(sent.filter((x) => x.ch === 'chat:blocks').length, 0, 'во время генерации код не отправляется');

    el.textContent = REAL_TEXT; mutate();
    await wait(2200);
    const blockMessages = sent.filter((x) => x.ch === 'chat:blocks');
    assert.equal(blockMessages.length, 1);
    const { ch, payload } = blockMessages[0];
    assert.equal(ch, 'chat:blocks');
    assert.equal(payload.chatId, '17b45023-2aba-4a1a-a966-17bbe41926ea');
    assert.equal(payload.blocks[0].text, REAL_TEXT);
    assert.equal(payload.blocks[0].initial, true, 'блок, появившийся сразу после загрузки, считается историей');

    await wait(1200);
    assert.equal(sent.filter((x) => x.ch === 'chat:blocks').length, 1, 'повторной отправки нет');
  } finally {
    Module._load = origLoad;
    delete global.location; delete global.MutationObserver; delete global.document;
  }
});


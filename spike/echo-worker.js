'use strict';
// Эхо-воркер для прямой проверки: создаётся ли classic-воркер при нашей CSP вообще.
// Отвечает на {ping} и заодно проверяет, что внутри воркера доступен importScripts.
self.onmessage = (e) => {
  let importScriptsOk = null;
  try {
    importScriptsOk = typeof self.importScripts === 'function';
  } catch (err) {
    importScriptsOk = 'throw: ' + err.message;
  }
  self.postMessage({
    ok: true,
    detail: `эхо получено (${e && e.data && e.data.ping}), importScripts: ${importScriptsOk}`,
  });
};

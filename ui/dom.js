'use strict';
// Общий помощник создания DOM для всего renderer. Один на app.js и editor.js:
// две реализации h() рано или поздно разошлись бы по семантике (например, по
// обработке null среди детей), а это уже видимая разница в интерфейсе.
//
// Правило проекта сохраняется: только textContent/createTextNode, никакого innerHTML
// с данными извне (ответ модели, пути файлов, имена проектов).

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WhaleDom = api;
})(typeof window !== 'undefined' ? window : null, function () {
  /**
   * Как настоящий ParentNode.append(): вложенные массивы разворачиваются,
   * null/undefined/false игнорируются, остальное становится текстовым узлом.
   */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v; // через CSSOM: inline-атрибуты запрещены CSP
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const clear = (el) => { if (el) el.replaceChildren(); return el; };

  /** Клавиша без учёта раскладки: e.code стабилен, e.key — нет. */
  const isKey = (e, code) => e.code === code;
  const mod = (e) => e.ctrlKey || e.metaKey;

  return { h, $, clear, isKey, mod };
});

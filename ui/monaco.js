'use strict';
// Загрузка Monaco и регистрация языков (ТЗ §7, §15, §16).
//
// Monaco берётся локальный, из node_modules, без CDN. Загружается ОДИН раз: экземпляр
// редактора переживает любые перерисовки интерфейса, поэтому бутстрап отделён от UI.
//
// Путь к min/vs приходит из main-процесса (--monaco-vs в additionalArguments), потому что
// в упакованном приложении node_modules может лежать в app.asar.unpacked, и угадывать
// относительный путь из renderer нельзя.

(function () {
  const FALLBACK_VS = '../node_modules/monaco-editor/min/vs';

  function vsUrl() {
    const fromMain = window.api && window.api.monacoVs;
    const rel = fromMain || new URL(FALLBACK_VS, document.baseURI).href;
    return String(rel).replace(/\/+$/, '');
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Не удалось загрузить ' + src));
      document.head.append(s);
    });
  }

  let ready = null;

  /** @returns {Promise<object>} monaco — один и тот же промис при повторных вызовах */
  function init() {
    if (ready) return ready;
    ready = (async () => {
      const base = vsUrl();
      await loadScript(base + '/loader.js');
      if (typeof window.require !== 'function' || typeof window.require.config !== 'function') {
        throw new Error('AMD-загрузчик Monaco не поднялся');
      }
      window.require.config({ paths: { vs: base } });
      await new Promise((resolve, reject) => {
        window.require(['vs/editor/editor.main'], resolve, (err) => reject(new Error('Monaco не загрузился: ' + ((err && err.message) || err))));
      });
      if (!window.monaco || !window.monaco.editor) throw new Error('window.monaco недоступен после загрузки');
      // Язык определён в ui/languages/gdscript.js и проверяется node-тестами
      if (window.WhaleGdscript) window.WhaleGdscript.register(window.monaco);
      return window.monaco;
    })();
    ready.catch(() => { ready = null; }); // после сбоя разрешаем повторить попытку
    return ready;
  }

  /**
   * Язык по расширению (§16): свои highlighter'ы не пишем там, где у Monaco уже есть.
   * Monaco сам сопоставляет расширения для встроенных языков, этот список — только для
   * случая, когда модель создаётся без URI (например, буфер предложения модели).
   */
  const BY_EXT = {
    gd: 'whale-gdscript', gdscript: 'whale-gdscript', tscn: 'ini', godot: 'ini',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'json',
    py: 'python', pyw: 'python', cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
    h: 'cpp', hpp: 'cpp', c: 'c', rs: 'rust', go: 'go', rb: 'ruby', php: 'php',
    java: 'java', kt: 'kotlin', swift: 'swift', sh: 'shell', bash: 'shell',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml', toml: 'ini', md: 'markdown',
    sql: 'sql', lua: 'lua', r: 'r', pl: 'perl', ps1: 'powershell', dockerfile: 'dockerfile',
  };

  function languageForPath(relPath) {
    const name = String(relPath || '').split(/[\\/]/).pop() || '';
    const lower = name.toLowerCase();
    if (lower === 'dockerfile') return 'dockerfile';
    const dot = lower.lastIndexOf('.');
    if (dot < 0) return 'plaintext';
    return BY_EXT[lower.slice(dot + 1)] || 'plaintext';
  }

  window.WhaleMonaco = { init, languageForPath, vsUrl };
})();

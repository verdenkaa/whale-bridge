'use strict';
// Отдельный стенд для технического spike (ТЗ §26). Основное приложение не трогает.
//
// Задача: измерить, а не угадать, при каких условиях Monaco работает в наших настройках
// безопасности (contextIsolation, sandbox, nodeIntegration: false, file://, строгая CSP).
// Проверяются script/loader, web worker, blob:, локальные ассеты и шрифты.
//
// Запуск:  npm run spike
// Результат: таблица в терминал + spike/report.json + spike/report.md (их и присылайте).

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const MONACO_VS = path.join(ROOT, 'node_modules', 'monaco-editor', 'min', 'vs');
const SCHEME = 'whale-spike';
const PER_STRATEGY_TIMEOUT = 45000;

// Три стратегии. Прогоняем все за один запуск:
//  classic  — file://, воркер создаём сами через MonacoEnvironment.getWorker (classic, не module)
//  default  — file://, штатный путь Monaco (blob: + module worker + await import(file://))
//  protocol — свой стандартный scheme вместо file://; запасной вариант, если file:// режет воркеры
const STRATEGIES = [
  { id: 'classic', vsUrl: pathToFileURL(MONACO_VS).href },
  { id: 'default', vsUrl: pathToFileURL(MONACO_VS).href },
  { id: 'protocol', vsUrl: `${SCHEME}://app/node_modules/monaco-editor/min/vs` },
];

// Регистрируем до app.ready: privileges нельзя назначить позже
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

function reportLine(r) {
  const mark = r.ok ? '✔' : '✘';
  return `  ${mark} ${String(r.name).padEnd(46)} ${r.detail || ''}`.trimEnd();
}

async function runStrategy(strategy) {
  const logs = [];
  const win = new BrowserWindow({
    width: 1280, height: 860, show: false, title: `Monaco spike — ${strategy.id}`,
    webPreferences: {
      // намеренно те же настройки, что и у основного окна приложения
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // в sandbox-преалоде нет ни location, ни query — параметры стратегии передаём через argv
      additionalArguments: [
        `--spike-strategy=${strategy.id}`,
        `--spike-vs=${strategy.vsUrl}`,
      ],
    },
  });
  const wc = win.webContents;
  wc.on('console-message', (_e, level, message, line, source) => {
    logs.push(`[console.${level}] ${message} (${source}:${line})`);
  });
  wc.on('did-fail-load', (_e, code, desc, url) => logs.push(`[did-fail-load] ${code} ${desc} ${url}`));
  wc.on('render-process-gone', (_e, d) => logs.push(`[render-process-gone] ${JSON.stringify(d)}`));

  const done = new Promise((resolve) => {
    const channel = `spike:done:${strategy.id}`;
    const handler = (_e, payload) => { ipcMain.removeListener(channel, handler); resolve(payload); };
    ipcMain.on(channel, handler);
  });

  const target = strategy.id === 'protocol'
    ? `${SCHEME}://app/spike/index.html?strategy=${strategy.id}`
    : pathToFileURL(path.join(__dirname, 'index.html')).href + `?strategy=${strategy.id}`;

  win.show();
  await wc.loadURL(target);

  const timeout = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), PER_STRATEGY_TIMEOUT));
  const payload = await Promise.race([done, timeout]);
  if (!win.isDestroyed()) win.destroy();

  if (payload && payload.timeout) {
    return { id: strategy.id, ok: false, timeout: true, probes: [], logs: logs.concat('[spike] стенд не ответил за отведённое время') };
  }
  const probes = (payload && payload.probes) || [];
  const csp = (payload && payload.cspViolations) || [];
  return {
    id: strategy.id,
    ok: probes.length > 0 && probes.every((p) => p.ok) && csp.length === 0,
    probes,
    cspViolations: csp,
    env: (payload && payload.env) || null,
    logs,
  };
}

function writeReports(all) {
  const jsonPath = path.join(__dirname, 'report.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), results: all }, null, 2));

  const lines = ['# Отчёт Monaco spike', '', `Сформирован: ${new Date().toISOString()}`, ''];
  for (const r of all) {
    lines.push(`## Стратегия \`${r.id}\` — ${r.ok ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : 'ЕСТЬ ПРОВАЛЫ'}`, '');
    if (r.timeout) { lines.push('Стенд не ответил (таймаут).', ''); }
    if (r.env) {
      const { workerSpy, ...env } = r.env;
      lines.push(`Окружение: ${JSON.stringify(env)}`, '');
      if (Array.isArray(workerSpy) && workerSpy.length) {
        lines.push(`Создано воркеров: ${workerSpy.length}`, '');
        for (const w of workerSpy) {
          lines.push(`- type: \`${w.type}\`, name: ${w.name || '—'}, ошибок: ${w.errors.length}`);
          lines.push(`  url: ${w.url}`);
          for (const e of w.errors) lines.push(`  ! ${e}`);
        }
        lines.push('');
      } else {
        lines.push('Создано воркеров: 0 — Monaco обошёлся без них', '');
      }
    }
    for (const p of r.probes) lines.push(reportLine(p));
    if (r.cspViolations && r.cspViolations.length) {
      lines.push('', 'Нарушения CSP (их нужно учесть в политике):', '');
      for (const v of r.cspViolations) lines.push(`- ${v.effectiveDirective}: ${v.blockedURI} (source: ${v.sourceFile || '?'})`);
    }
    if (r.logs && r.logs.length) {
      lines.push('', 'Консоль:', '', '```', ...r.logs.slice(-80), '```');
    }
    lines.push('');
  }
  const winner = all.find((r) => r.ok);
  lines.push('---', '', winner
    ? `**Рабочая стратегия: \`${winner.id}\`.** Её и берём за основу в Stage A.`
    : '**Ни одна стратегия не прошла полностью.** Смотрите провалы выше — по ним правим CSP/воркеры.', '');
  fs.writeFileSync(path.join(__dirname, 'report.md'), lines.join('\n'));
  return jsonPath;
}

app.whenReady().then(async () => {
  protocol.handle(SCHEME, (req) => {
    try {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const abs = path.resolve(ROOT, rel);
      if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(abs).href);
    } catch (e) {
      return new Response('bad request: ' + e.message, { status: 400 });
    }
  });

  if (!fs.existsSync(path.join(MONACO_VS, 'loader.js'))) {
    console.error('\n[spike] Не найден node_modules/monaco-editor/min/vs/loader.js — выполните npm install\n');
    app.exit(1);
    return;
  }

  const all = [];
  console.log('\n=== Monaco spike (ТЗ §26) ===\n');
  for (const s of STRATEGIES) {
    console.log(`— стратегия ${s.id} …`);
    const r = await runStrategy(s); // последовательно: окна не должны мешать друг другу
    all.push(r);
    console.log(`  ${r.ok ? '✔ все проверки пройдены' : '✘ есть провалы'}`);
    for (const p of r.probes) console.log(reportLine(p));
    for (const v of r.cspViolations || []) {
      console.log(`  ! CSP ${v.effectiveDirective}: ${v.blockedURI}`);
    }
    const spy = (r.env && r.env.workerSpy) || [];
    console.log(`  воркеров создано: ${spy.length}` + (spy.length
      ? ' → ' + spy.map((w) => `${w.type}${w.errors.length ? '(!)' : ''}`).join(', ')
      : ''));
    for (const w of spy) for (const e of w.errors) console.log(`    ! воркер ${w.type}: ${e}`);
    if (r.timeout) console.log('  ! таймаут — смотрите spike/report.md');
    console.log('');
  }

  const jsonPath = writeReports(all);
  const winner = all.find((r) => r.ok);
  console.log('=== Итог ===');
  for (const r of all) console.log(`  ${r.ok ? '✔' : '✘'} ${r.id}`);
  console.log(winner ? `\nРабочая стратегия: ${winner.id}` : '\nНи одна стратегия не прошла полностью');
  console.log(`Отчёт: ${jsonPath}\n      ${path.join(__dirname, 'report.md')}\n`);
  app.exit(0);
});

app.on('window-all-closed', () => { /* выходим сами, после всех стратегий */ });

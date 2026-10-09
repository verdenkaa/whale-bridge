# Сборка и тесты

## Требования

- Node.js 20+ и npm (CI использует Node 22);
- Windows — целевая платформа сборок; разработка и тесты работают также на Linux
  и macOS;
- `node-pty` — нативный модуль: при установке нужны инструменты сборки
  (Windows: Visual Studio Build Tools + Python; Linux: make + g++; macOS: Xcode
  CLT) либо доступный пребилд. В приложении он грузится лениво и с try/catch:
  даже если модуль не поднялся, остальное работает, а ошибка всплывёт понятным
  тостом при первом запуске терминала.

## Запуск из исходников

```bash
npm install
npm start
```

- Windows: `start.bat` сам проверит Node.js, установит зависимости и запустит
  приложение.
- Linux/macOS: `./start.sh`.
- `npm run spike` — технический стенд Monaco (CSP, воркеры, WebContentsView);
  в сборку не попадает, использовался для проверки решений раскладки.

## Тесты

```bash
npm test        # node --test tests/*.test.js
```

Electron для тестов не нужен: логика вынесена в чистые модули, внешние
зависимости внедряются через DI (фейковый pty у раннера, фейковый execFile у
toolchain, временные папки у store, имитация DOM у smoke-теста интерфейса).

Устройство набора:

| группа | файлы | что проверяет |
|---|---|---|
| ядро | `core`, `features`, `parser-run`, `hunks`, `context*`, `versions`, `rollback` | разбор блоков и маркеры, SEARCH/REPLACE, журнал контекста, классификация версий, сценарии отката |
| файлы и хранилище | `editorfs`, `treefs`, `store-settings` | чтение/запись редактора, операции дерева, конфигурация и история |
| запуск | `runner`, `runlangs`, `runsettings`, `runfmt`, `toolchain`, `classify-command` | планы, сессии на фейковом pty, поиск инструментов, отчёт, классификатор команд |
| интерфейс | `ui-smoke`, `layout`, `editor-state`, `gdscript`, `observer` | связи app.js/terminal.js на имитации DOM, раскладка, состояние вкладок, наблюдатель DOM страницы чата |
| обвязка | `wiring`, `ipc-channels` | main.js и преагрузчики разбираются как текст: белые списки каналов сверяются с фактическими вызовами и обработчиками |
| гигиена и аудит | `source-hygiene`, `audit-fixes` | LF в индексе git, отсутствие посторонних письменностей, NUL-байтов, отладочного кода и смешения кириллицы с латиницей внутри слова; регрессии пред-релизного аудита |

Правила, которые тесты защищают от случайной поломки:

- **wiring**: канал, разрешённый preload, обязан иметь обработчик в main и
  наоборот; события, которые слушает renderer, обязаны кем-то отправляться;
  литералы каналов видны в тексте main.js (обвязочные тесты сверяют их дословно).
- **гигиена**: в репозиторий попадает только LF (`.gitattributes`:
  `* text=auto eol=lf`), файлы оканчиваются переводом строки, `console.log` и
  `debugger` в продуктивных файлах запрещены (console.warn/error — разрешены),
  комментарии русские, идентификаторы латинские, без смешения внутри слова.

## Сборка релизов для Windows

Whale Bridge использует `electron-builder`:

```bash
npm run build:win              # установщик NSIS + portable, x64
npm run build:win:installer    # только установщик
npm run build:win:portable     # только portable
```

Готовые артефакты записываются в `release/`. Вспомогательный `build.bat`
прогоняет проверки Node.js, зависимости, тесты и сборку одним запуском.

Параметры упаковки (секция `build` в `package.json`):

- `asar: true`; `asarUnpack` для `monaco-editor` (воркеры и шрифты грузятся по
  абсолютному URL — путь к распакованной `min/vs` main передаёт в renderer через
  `additionalArguments`) и `node-pty` (нативный модуль);
- из упаковки исключены `tests/`, `spike/`, `release/`, `docs/`, `README.md`,
  dev-часть monaco (`dev/`, `esm/`) — в рантайме нужна только `min/`;
- xterm.js грузится из asar обычным скриптом (воркеров у него нет).

## CI (GitHub Actions)

`.github/workflows/release.yml` (`Windows Release`):

- триггеры: `workflow_dispatch` (ручной) и push тега `v*`;
- шаги: checkout → Node 22 + кеш npm → `npm ci` → `npm test` (тесты обязаны
  пройти до сборки) → `npm run build:win -- --publish never` → артефакты
  (`release/*.exe`);
- для тегов: публикация GitHub Release (`gh release create/upload --clobber`),
  права `contents: write`.

Релизный тег — единственный путь к публике: сборка без тэга остаётся артефактом
прогона.

# Monaco spike (ТЗ §26)

Отдельный стенд, который **измеряет**, а не угадывает, при каких условиях Monaco работает
в наших настройках безопасности. Основное приложение (`main.js`, `ui/`) стенд не трогает —
запускается своим процессом.

## Зачем

Перед Stage A нужно закрыть неприятные вопросы, которые потом дорого переделывать:

- поднимается ли AMD-загрузчик Monaco с `file://` при строгой CSP;
- **поднимаются ли web worker'ы** — без них не будет Diff, а значит и Stage C;
- нужны ли `blob:`, `data:` для шрифтов и картинок, и какие именно директивы CSP необходимы;
- работает ли Monaco внутри CSS Grid и дружит ли с `ResizeObserver` (основа Stage B).

## Запуск

```bash
npm install          # поставит monaco-editor
npm run spike
```

Откроется окно стенда; он сам прогонит три стратегии подряд, напечатает таблицу в терминал
и запишет `spike/report.json` + `spike/report.md`.

**Пришлите обратно `spike/report.md`** (или вывод терминала) — по нему принимается решение,
какую стратегию брать в Stage A.

## Три стратегии

| id | страница | воркеры | зачем |
|---|---|---|---|
| `classic` | `file://` | свои, через `MonacoEnvironment.getWorker` → `worker-host.js` (`type: 'classic'`) | основной кандидат |
| `default` | `file://` | штатный путь Monaco: `blob:` + `type: 'module'` + `await import('file://…')` | замерить, правда ли он ломается на `file://` |
| `protocol` | `whale-spike://app/…` | как в `classic` | запасной: свой scheme даёт настоящий origin, если `file://` режет воркеры |

Во всех трёх пробах за созданием воркеров следит шпион: `window.Worker` оборачивается до
загрузки Monaco, поэтому в отчёт попадает **каждый** созданный воркер с его URL, типом и
ошибками. Без этого невозможно отличить «воркер поднялся» от «Monaco обошёлся без воркера».

Документы в пробе Diff намеренно большие (3000 строк): на крошечных нельзя отличить ответ
воркера от любого внутреннего быстрого пути, и проба теряет смысл.

Почему `classic` — основной кандидат. Штатный путь Monaco 0.57 (см. `AJ`/`MJ` в
`min/vs/editor-BdtEMBbM.js`) создаёт blob-воркер, внутри которого выполняется
`await import("<абсолютный URL>")`, и поднимает его как `new Worker(blobUrl, { type: 'module' })`.
Модульный импорт проверяется по CORS, а у страницы на `file://` origin непрозрачный (`null`),
поэтому такой импорт в Chromium не проходит. `MonacoEnvironment.getWorker` перехватывает
создание воркера раньше штатного пути, и минимальная сборка Monaco — AMD, то есть грузится
обычным `importScripts` без модулей и без CORS.

## Что проверяется

| проба | вопрос |
|---|---|
| AMD-загрузчик `loader.js` | грузится ли скрипт с `file://` / своего scheme при `script-src 'self'` |
| `vs/editor/editor.main` | собирается ли сам Monaco |
| `ui/languages/gdscript.js` | регистрируется ли наш язык |
| `editor.create` + round-trip | создаётся ли редактор в ненулевой ячейке Grid |
| шрифт codicon | хватает ли `font-src data:` (в min-сборке шрифт инлайнится base64) |
| `monaco.editor.tokenize` | работает ли подсветка GDScript в рантайме |
| язык по расширению | `.gd → whale-gdscript`, остальные — встроенные языки Monaco (§16) |
| classic-воркер напрямую | создаётся ли обычный воркер при нашей CSP (`worker-src 'self'`) |
| blob+module воркер напрямую | создаётся ли воркер штатным способом Monaco (`worker-src blob:`) |
| **Diff на 3000 строк через `getLineChanges()`** | **поднялся ли web worker** — ключевая проба |
| смена model без пересоздания editor | требование §7 |
| `saveViewState`/`restoreViewState` | требование §14 |
| `layout()` после изменения Grid | требование §5 |
| `ResizeObserver` на `#chat-slot` | основа `chat:set-bounds` (§4, §28) |
| нарушения CSP | слушается `securitypolicyviolation`, сообщается недостающая директива |

## CSP стенда

Политика в `spike/index.html` — та, которую предполагается перенести в `ui/index.html`:

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
font-src 'self' data:;
img-src 'self' data: blob:;
worker-src 'self' blob:;
connect-src 'self'
```

`style-src 'unsafe-inline'` — единственное вынужденное ослабление относительно текущей
политики приложения: Monaco сам создаёт `<style>`-элементы (`createElement("style")`),
nonce им не проставляет, и обойти это нельзя. При этом `script-src` остаётся строгим —
`'unsafe-inline'` для скриптов **не** добавляется.

Если какой-то директивы не хватит, стенд не упадёт молча: событие
`securitypolicyviolation` попадёт в отчёт с названием директивы и заблокированным URI.

## Файлы

```
spike/
├── main.js          отдельный main-процесс: 3 стратегии, сбор отчёта
├── preload.js       contextBridge (те же contextIsolation + sandbox, что в приложении)
├── index.html       CSP + разметка целевой IDE-раскладки
├── spike.css        CSS Grid: chat-slot | файлы | редактор | боковая панель | нижняя панель
├── renderer.js      батарея проб + шпион за window.Worker
├── echo-worker.js   эхо-воркер для прямой проверки worker-src 'self'
└── worker-host.js   classic-воркер Monaco: importScripts(loader.js) → vs/editor/editor.worker
```

Определение GDScript лежит в `ui/languages/gdscript.js`, а не здесь: оно проверяется
node-тестами (`tests/gdscript.test.js`) настоящим токенайзером Monaco и в Stage A
переезжает в приложение без изменений.

Стенд не попадает в сборку: в `package.json` → `build.files` есть `!spike{,/**/*}`.
Отчёты `report.json` / `report.md` в git не коммитятся.

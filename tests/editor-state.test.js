'use strict';
// Состояние редактора (ТЗ §8, §12, §14): вкладки, dirty, drift, конфликт сохранения.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ES = require('../ui/editor-state');
const V = require('../src/versions');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const opened = (p, content = 'v0\n', hash = A, extra = {}) => ({
  projectId: 'p1', path: p, content, hash, eol: 'lf', hasBom: false, language: 'plaintext', ...extra,
});

test('editor-state: открытие, порядок вкладок, активный файл', () => {
  const s = ES.createState();
  assert.equal(ES.list(s).length, 0);
  assert.equal(ES.active(s), null);

  ES.open(s, opened('a.gd'));
  ES.open(s, opened('b.gd'));
  ES.open(s, opened('c.gd'));
  assert.deepEqual(ES.list(s).map((f) => f.path), ['a.gd', 'b.gd', 'c.gd']);
  assert.equal(ES.active(s).path, 'c.gd');

  ES.activate(s, 'a.gd');
  assert.equal(ES.active(s).path, 'a.gd');
  assert.equal(ES.activate(s, 'нет-такого.gd'), null);
  assert.equal(ES.active(s).path, 'a.gd', 'активный не сбрасывается на неизвестном пути');
  assert.throws(() => ES.open(s, {}), /path/);
});

test('editor-state: повторное открытие не затирает несохранённую правку', () => {
  const s = ES.createState();
  ES.open(s, opened('a.gd', 'v0\n', A));
  ES.setText(s, 'a.gd', 'мои правки\n');
  assert.equal(ES.isDirty(ES.get(s, 'a.gd')), true);

  // файл перечитали с диска (например, по files:changed) — буфер трогать нельзя
  const r = ES.open(s, opened('a.gd', 'v0\n', B));
  assert.equal(r.reopened, true);
  assert.equal(ES.get(s, 'a.gd').text, 'мои правки\n');
  assert.equal(ES.get(s, 'a.gd').savedText, 'v0\n');
  assert.equal(ES.get(s, 'a.gd').diskHash, B); // а вот состояние диска обновилось
  assert.equal(ES.list(s).length, 1, 'вторая вкладка не появилась');
});

test('editor-state: dirty считается по тексту, а не по хэшу (§12)', () => {
  const s = ES.createState();
  ES.open(s, opened('a.gd', 'v0\n', A));
  const f = ES.get(s, 'a.gd');
  assert.equal(ES.isDirty(f), false);

  ES.setText(s, 'a.gd', 'v1\n');
  assert.equal(ES.isDirty(f), true);

  // вернули исходный текст — файл снова чист, хотя промежуточные правки были
  ES.setText(s, 'a.gd', 'v0\n');
  assert.equal(ES.isDirty(f), false);

  ES.setText(s, 'a.gd', 'v1\n');
  ES.setSaved(s, 'a.gd', { text: 'v1\n', hash: B });
  assert.equal(ES.isDirty(f), false);
  assert.equal(f.savedHash, B);
  assert.equal(f.diskHash, B);
  assert.equal(ES.setText(s, 'нет.gd', 'x'), null);
});

test('editor-state: drift — файл изменился вне редактора', () => {
  const s = ES.createState();
  ES.open(s, opened('a.gd', 'v0\n', A));
  ES.open(s, opened('b.gd', 'v0\n', A));
  assert.equal(ES.isDrifted(ES.get(s, 'a.gd')), false);

  ES.setDiskHashes(s, { 'a.gd': B, 'b.gd': A, 'нет-в-списке.gd': C });
  assert.equal(ES.isDrifted(ES.get(s, 'a.gd')), true);
  assert.equal(ES.isDrifted(ES.get(s, 'b.gd')), false);
  assert.deepEqual(ES.driftedPaths(s), ['a.gd']);

  // null означает «файл пропал/нечитаем» — это не совпадает с savedHash, значит drift
  ES.setDiskHash(s, 'a.gd', null);
  assert.equal(ES.isDrifted(ES.get(s, 'a.gd')), false, 'неизвестный диск не выдаём за drift');
});

test('editor-state: needsReload — чистый буфер при уехавшем диске можно перечитать', () => {
  const s = ES.createState();
  ES.open(s, opened('a.gd', 'v0\n', A));
  const f = ES.get(s, 'a.gd');

  // диск не менялся — перечитывать нечего
  assert.equal(ES.needsReload(f), false);
  assert.equal(ES.describe(s, 'a.gd').needsReload, false);

  // файл изменили вне редактора (например, откатили), буфер чист → перечитываем молча.
  // Раньше здесь был тупик: редактор показывал старое, dirty=false, Ctrl+S отвечал
  // «изменений нет», и новое содержимое не подтягивалось.
  ES.setDiskHash(s, 'a.gd', B);
  assert.equal(ES.isDrifted(f), true);
  assert.equal(ES.isDirty(f), false);
  assert.equal(ES.needsReload(f), true);
  assert.equal(ES.describe(s, 'a.gd').needsReload, true);

  // есть несохранённые правки → это конфликт, молча перечитывать нельзя
  ES.setText(s, 'a.gd', 'мои правки\n');
  assert.equal(ES.needsReload(f), false);
  assert.equal(ES.describe(s, 'a.gd').saveDecision, 'conflict');

  // после перечитывания буфер снова синхронен
  ES.reload(s, 'a.gd', { content: 'с диска\n', hash: B });
  assert.equal(ES.needsReload(f), false);
  assert.equal(ES.isDrifted(f), false);
  assert.equal(ES.isDirty(f), false);
  assert.equal(ES.needsReload(null), false);
});

test('editor-state: missing — файл удалён или недоступен, это не «хэш неизвестен»', () => {
  const s = ES.createState();
  ES.open(s, opened('a.gd', 'v0\n', A));
  const f = ES.get(s, 'a.gd');
  assert.equal(ES.isMissing(f), false);
  assert.equal(ES.describe(s, 'a.gd').missing, false);

  ES.setDiskHash(s, 'a.gd', null);
  assert.equal(ES.isMissing(f), true);
  assert.equal(ES.describe(s, 'a.gd').missing, true);
  // исчезнувший файл не должен выглядеть как drift: сохранять всё равно некуда
  assert.equal(ES.isDrifted(f), false);
  assert.equal(ES.needsReload(f), false);

  // отсутствие ключа в ответе file:hashes (например, файл другого проекта) — НЕ удаление
  ES.setDiskHash(s, 'a.gd', A);
  ES.setDiskHashes(s, { 'другой.gd': null });
  assert.equal(ES.isMissing(ES.get(s, 'a.gd')), false);

  // успешное перечитывание снимает missing
  ES.setDiskHash(s, 'a.gd', null);
  assert.equal(ES.isMissing(f), true);
  ES.reload(s, 'a.gd', { content: 'v0\n', hash: A });
  assert.equal(ES.isMissing(f), false);
});

test('editor-state: конфликт сохранения (§11) — уехали и буфер, и диск', () => {
  const s = ES.createState();
  ES.open(s, opened('a.gd', 'v0\n', A));
  ES.setText(s, 'a.gd', 'мои правки\n');
  ES.setDiskHash(s, 'a.gd', B);

  const d = ES.describe(s, 'a.gd');
  assert.equal(d.dirty, true);
  assert.equal(d.diskDrift, true);
  assert.equal(d.saveConflict, true);
  assert.equal(d.state, 'save-conflict');
  assert.equal(d.saveDecision, 'conflict'); // писать на диск нельзя
  assert.equal(d.path, 'a.gd');
  assert.equal(d.language, 'plaintext');

  // только буфер — обычное сохранение
  ES.setDiskHash(s, 'a.gd', A);
  assert.equal(ES.describe(s, 'a.gd').saveDecision, 'ok');
  // только диск — достаточно перечитать
  ES.setText(s, 'a.gd', 'v0\n');
  ES.setDiskHash(s, 'a.gd', B);
  const reload = ES.describe(s, 'a.gd');
  assert.equal(reload.saveDecision, 'reload');
  assert.equal(reload.state, 'disk-drift');
  // ничего не менялось
  ES.setDiskHash(s, 'a.gd', A);
  assert.equal(ES.describe(s, 'a.gd').saveDecision, 'noop');
  assert.equal(ES.describe(s, 'нет.gd'), null);
});

test('editor-state: описание версий берётся из src/versions, а не дублируется', () => {
  const s = ES.createState();
  ES.open(s, opened('a.gd', 'v0\n', A));
  ES.setText(s, 'a.gd', 'x\n');
  const d = ES.describe(s, 'a.gd');
  const direct = V.classifyVersions({ disk: A, saved: A, editor: null, dirty: true });
  for (const k of ['state', 'saveDecision', 'diskDrift', 'aiStale', 'saveConflict', 'summary']) {
    assert.deepEqual(d[k], direct[k], `поле ${k} расходится с src/versions`);
  }
});

test('editor-state: закрытие вкладки спрашивает про несохранённое (§12)', () => {
  const s = ES.createState();
  ES.open(s, opened('a.gd'));
  ES.open(s, opened('b.gd'));
  ES.setText(s, 'b.gd', 'правки\n');

  const refused = ES.close(s, 'b.gd');
  assert.deepEqual(refused, { closed: false, reason: 'dirty' });
  assert.equal(ES.list(s).length, 2, 'файл не закрыт');

  assert.deepEqual(ES.close(s, 'a.gd'), { closed: true });
  assert.equal(ES.active(s).path, 'b.gd');
  assert.deepEqual(ES.close(s, 'b.gd', { force: true }), { closed: true });
  assert.equal(ES.active(s), null);
  assert.deepEqual(ES.close(s, 'b.gd'), { closed: true }, 'закрытие уже закрытого не ошибка');
});

test('editor-state: после закрытия активной открывается соседняя вкладка', () => {
  const s = ES.createState();
  for (const p of ['a', 'b', 'c', 'd']) ES.open(s, opened(p));
  assert.deepEqual(ES.list(s).map((f) => f.path), ['a', 'b', 'c', 'd']);

  ES.activate(s, 'b');
  ES.close(s, 'b');
  assert.equal(ES.active(s).path, 'c', 'берём правого соседа');

  ES.close(s, 'd');
  assert.equal(ES.active(s).path, 'c');
  ES.close(s, 'c');
  assert.equal(ES.active(s).path, 'a', 'справа никого — берём левого');

  // закрытие неактивной вкладки не меняет активную
  ES.activate(s, 'a');
  ES.open(s, opened('z'));
  ES.activate(s, 'a');
  ES.close(s, 'z');
  assert.equal(ES.active(s).path, 'a');
});

test('editor-state: Ctrl+Tab идёт по кругу (§25)', () => {
  const s = ES.createState();
  assert.equal(ES.activateRelative(s), null);
  for (const p of ['a', 'b', 'c']) ES.open(s, opened(p));
  ES.activate(s, 'a');
  assert.equal(ES.activateRelative(s, 1).path, 'b');
  assert.equal(ES.activateRelative(s, 1).path, 'c');
  assert.equal(ES.activateRelative(s, 1).path, 'a', 'зацикливается');
  assert.equal(ES.activateRelative(s, -1).path, 'c', 'и в обратную сторону');
});

test('editor-state: перечитывание с диска снимает dirty и drift (§11)', () => {
  const s = ES.createState();
  ES.open(s, opened('a.gd', 'v0\n', A));
  ES.setText(s, 'a.gd', 'мои правки\n');
  ES.setDiskHash(s, 'a.gd', B);
  assert.equal(ES.describe(s, 'a.gd').saveDecision, 'conflict');

  ES.reload(s, 'a.gd', { content: 'с диска\n', hash: B, eol: 'crlf', hasBom: true });
  const f = ES.get(s, 'a.gd');
  assert.equal(f.text, 'с диска\n');
  assert.equal(f.savedText, 'с диска\n');
  assert.equal(f.eol, 'crlf');
  assert.equal(f.hasBom, true);
  assert.equal(ES.describe(s, 'a.gd').saveDecision, 'noop');
});

test('editor-state: «сохранить поверх» (§11) — запись от фактического хэша диска', () => {
  const s = ES.createState();
  ES.open(s, opened('a.gd', 'v0\n', A));
  ES.setText(s, 'a.gd', 'мои правки\n');
  ES.setDiskHash(s, 'a.gd', B);
  const f = ES.get(s, 'a.gd');

  // обычный путь: savedHash = A, поэтому main ответит conflict
  assert.equal(f.savedHash, A);
  assert.equal(ES.describe(s, 'a.gd').saveDecision, 'conflict');
  // «поверх» — та же запись, но базой признаётся текущий диск
  assert.equal(ES.forceSaveBase(s, 'a.gd'), B);
  assert.equal(ES.forceSaveBase(s, 'нет.gd'), null);
  // ДО записи файл остаётся грязным: помечать его чистым заранее нельзя
  assert.equal(ES.isDirty(f), true);
  assert.equal(f.text, 'мои правки\n');

  // успешная запись → точка сохранения догоняет буфер и диск
  ES.setSaved(s, 'a.gd', { text: 'мои правки\n', hash: C });
  assert.equal(ES.isDirty(f), false);
  assert.equal(f.savedHash, C);
  assert.equal(f.diskHash, C);
  assert.equal(ES.describe(s, 'a.gd').saveDecision, 'noop');
});

test('editor-state: viewState хранится на вкладке, а не в DOM (§14)', () => {
  const s = ES.createState();
  ES.open(s, opened('a.gd'));
  const vs = { cursorState: [{ lineNumber: 12, column: 3 }], scrollTop: 400 };
  ES.setViewState(s, 'a.gd', vs);
  assert.equal(ES.get(s, 'a.gd').viewState, vs);
  ES.setViewState(s, 'a.gd', null);
  assert.equal(ES.get(s, 'a.gd').viewState, null);
  assert.equal(ES.setViewState(s, 'нет.gd', vs), null);
});

test('editor-state: hasUnsaved/dirtyPaths для предупреждения при закрытии окна', () => {
  const s = ES.createState();
  assert.equal(ES.hasUnsaved(s), false);
  ES.open(s, opened('a.gd'));
  ES.open(s, opened('b.gd'));
  assert.equal(ES.hasUnsaved(s), false);
  ES.setText(s, 'b.gd', 'x');
  assert.equal(ES.hasUnsaved(s), true);
  assert.deepEqual(ES.dirtyPaths(s), ['b.gd']);
});

test('editor-state: baseName и язык', () => {
  assert.equal(ES.baseName('src/player.gd'), 'player.gd');
  assert.equal(ES.baseName('src\\player.gd'), 'player.gd');
  assert.equal(ES.baseName(''), '');
  const s = ES.createState();
  ES.open(s, opened('src/player.gd', 'x', A, { language: 'whale-gdscript' }));
  assert.equal(ES.get(s, 'src/player.gd').name, 'player.gd');
  assert.equal(ES.get(s, 'src/player.gd').language, 'whale-gdscript');
  assert.equal(ES.describe(s, 'src/player.gd').language, 'whale-gdscript');
});

test('editor-state: загружается в браузере через window.WhaleVersions (без require)', () => {
  const fakeWindow = {};
  const ctx = vm.createContext({ window: fakeWindow, console });
  // порядок как в index.html: сначала versions, потом editor-state
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'versions.js'), 'utf8'), ctx, { filename: 'versions.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'editor-state.js'), 'utf8'), ctx, { filename: 'editor-state.js' });

  const browserES = fakeWindow.WhaleEditorState;
  assert.ok(browserES, 'window.WhaleEditorState появился');
  assert.ok(fakeWindow.WhaleVersions, 'window.WhaleVersions появился');
  const s = browserES.createState();
  browserES.open(s, { projectId: 'p1', path: 'a.gd', content: 'v0\n', hash: A });
  browserES.setText(s, 'a.gd', 'x\n');
  browserES.setDiskHash(s, 'a.gd', B);
  const d = browserES.describe(s, 'a.gd');
  assert.equal(d.saveDecision, 'conflict', 'классификация в браузере совпадает с node');
  assert.equal(d.state, 'save-conflict');
});

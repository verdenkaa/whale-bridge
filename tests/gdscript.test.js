'use strict';
// GDScript-подсветка (ТЗ §15) проверяется НАСТОЯЩИМ токенайзером Monaco — без Electron и без DOM:
// monarchCompile и monarchLexer из node_modules браузер не требуют. Это единственная возможность
// тестировать подсветку в CI, поэтому определение языка живёт в ui/languages/gdscript.js,
// а не внутри spike.
const test = require('node:test');
const assert = require('node:assert/strict');

const gd = require('../ui/languages/gdscript');

const MONARCH = '../node_modules/monaco-editor/esm/vs/editor/standalone/common/monarch/';

// ESM-файлы Monaco подхватываются по синтаксису (Node ≥ 20.10 / 22). На более старой Node
// тесты честно помечаются пропущенными через t.skip() — важно вызывать это внутри теста,
// потому что опция `skip` вычисляется в момент объявления, ещё до разрешения import().
let monarchCache;
async function monarch(t) {
  if (monarchCache === undefined) {
    try {
      const c = await import(MONARCH + 'monarchCompile.js');
      const l = await import(MONARCH + 'monarchLexer.js');
      monarchCache = { compile: c.compile, MonarchTokenizer: l.MonarchTokenizer };
    } catch (e) {
      monarchCache = { error: String((e && e.message) || e) };
    }
  }
  if (monarchCache.error) {
    t.skip('Monaco ESM недоступен в этой Node (нужен Node ≥ 20.10 или 22+): ' + monarchCache.error);
    return null;
  }
  return monarchCache;
}

// Минимальные заглушки сервисов: MonarchTokenizer обращается только к этим методам.
function makeTokenizer(compile, MonarchTokenizer) {
  const lexer = compile(gd.LANGUAGE_ID, gd.monarch);
  const noop = () => ({ dispose() {} });
  return new MonarchTokenizer(
    { isRegisteredLanguageId: () => false, getRegisteredLanguageIds: () => [] },
    {
      getColorTheme: () => ({ tokenTheme: { match: () => ({ foreground: 1 }), hasTextMateRules: false } }),
      onDidChange: noop,
    },
    gd.LANGUAGE_ID,
    lexer,
    { getValue: () => 20000, onDidChangeConfiguration: noop },
  );
}

/** Разбирает текст построчно с переносом состояния и возвращает [{text, type}] на строку. */
async function tokenize(mod, text) {
  const tk = makeTokenizer(mod.compile, mod.MonarchTokenizer);
  let state = tk.getInitialState();
  return text.split('\n').map((line) => {
    const res = tk.tokenize(line, true, state);
    state = res.endState;
    return res.tokens.map((t, i, arr) => ({
      type: t.type,
      text: line.slice(t.offset, i + 1 < arr.length ? arr[i + 1].offset : line.length),
    }));
  });
}

const typesIn = (tokens) => tokens.map((t) => t.type);
const typeOfText = (tokens, text) => tokens.filter((t) => t.text === text).map((t) => t.type);

test('gdscript: определение Monaco компилируется без ошибок', async (t) => {
  const M = await monarch(t);
  if (!M) return;
  const lexer = M.compile(gd.LANGUAGE_ID, gd.monarch);
  // compile() бросает исключение на любую ошибку определения: несуществующий @атрибут,
  // битый regexp, ссылку на неопределённое состояние
  assert.ok(lexer);
  assert.equal(lexer.languageId, gd.LANGUAGE_ID);
  assert.ok(Array.isArray(lexer.tokenizer.root) && lexer.tokenizer.root.length > 10);
  for (const st of ['stringDouble', 'stringSingle', 'stringTripleDouble', 'stringTripleSingle']) {
    assert.ok(Array.isArray(lexer.tokenizer[st]), `состояние ${st} не скомпилировано`);
  }
});

test('gdscript: регистрация языка — id, расширения, псевдонимы', () => {
  assert.equal(gd.LANGUAGE_ID, 'whale-gdscript');
  const registered = [];
  const stubMonaco = {
    languages: {
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      register: (d) => registered.push(d),
      setLanguageConfiguration: (id, conf) => registered.push({ confId: id, conf }),
      setMonarchTokensProvider: (id, m) => registered.push({ tokenId: id, monarch: m }),
    },
  };
  assert.equal(gd.register(stubMonaco), 'whale-gdscript');
  const decl = registered[0];
  assert.equal(decl.id, 'whale-gdscript');
  assert.deepEqual(decl.extensions, ['.gd', '.gdscript']); // ТЗ §16: .gd → gdscript
  assert.ok(decl.aliases.includes('GDScript'));
  assert.equal(registered[1].confId, 'whale-gdscript');
  assert.equal(registered[2].tokenId, 'whale-gdscript');
  assert.equal(registered[2].monarch, gd.monarch);
});

test('gdscript: конфигурация языка — комментарии, скобки, отступы', () => {
  const conf = gd.configuration({ languages: { IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } } });
  assert.equal(conf.comments.lineComment, '#'); // ТЗ §15: комментарий — '#'
  assert.ok(conf.brackets.some(([o, c]) => o === '(' && c === ')'));
  assert.ok(conf.autoClosingPairs.some((p) => p.open === '"' && p.close === '"'));
  assert.ok(conf.autoClosingPairs.some((p) => p.open === "'" && p.close === "'"));
  // GDScript значимыми отступами задаёт блоки: строка с ':' ведёт внутрь
  assert.ok(conf.indentationRules.increaseIndentPattern.test('func _ready():'));
  assert.ok(conf.indentationRules.increaseIndentPattern.test('\tif hp > 0:'));
  assert.ok(!conf.indentationRules.increaseIndentPattern.test('var hp = 100'));
  assert.ok(conf.folding.offSide, 'блоки сворачиваются по отступу, а не по скобкам');
  // onEnterRules используют значение перечисления Monaco, а не строку
  assert.equal(conf.onEnterRules[0].action.indentAction, 1);
});

test('gdscript: ключевые слова и управляющие конструкции (§15)', async (t) => {
  const M = await monarch(t);
  if (!M) return;
  const [extendsLine, ifLine] = await tokenize(M, 'extends Node\nif hp > 0 and not dead:');
  assert.deepEqual(typeOfText(extendsLine, 'extends'), ['keyword.gd']);
  assert.deepEqual(typeOfText(extendsLine, 'Node'), ['type.identifier.gd']);
  assert.deepEqual(typeOfText(ifLine, 'if'), ['keyword.control.gd']);
  assert.deepEqual(typeOfText(ifLine, 'and'), ['keyword.gd']);
  assert.deepEqual(typeOfText(ifLine, 'not'), ['keyword.gd']);
  assert.deepEqual(typeOfText(ifLine, '>'), ['operator.gd']);
});

test('gdscript: объявления func/var/const/signal/class_name/enum', async (t) => {
  const M = await monarch(t);
  if (!M) return;
  const lines = await tokenize(M, [
    'func _ready() -> void:',
    'var hp = 100',
    'const MAX_SPEED = 5.0',
    'signal health_changed(value)',
    'class_name Player',
    'enum State { IDLE, RUN }',
    'static func create():',
    'super._ready()',
  ].join('\n'));

  assert.deepEqual(typeOfText(lines[0], 'func'), ['keyword.gd']);
  assert.deepEqual(typeOfText(lines[0], '_ready'), ['function.gd']);
  assert.deepEqual(typeOfText(lines[0], 'void'), ['keyword.gd']);
  assert.deepEqual(typeOfText(lines[1], 'var'), ['keyword.gd']);
  assert.deepEqual(typeOfText(lines[1], 'hp'), ['variable.gd']);
  assert.deepEqual(typeOfText(lines[1], '100'), ['number.gd']);
  assert.deepEqual(typeOfText(lines[2], 'const'), ['keyword.gd']);
  assert.deepEqual(typeOfText(lines[2], 'MAX_SPEED'), ['variable.gd']);
  assert.deepEqual(typeOfText(lines[2], '5.0'), ['number.float.gd']);
  assert.deepEqual(typeOfText(lines[3], 'signal'), ['keyword.gd']);
  assert.deepEqual(typeOfText(lines[3], 'health_changed'), ['type.identifier.gd']);
  assert.deepEqual(typeOfText(lines[4], 'class_name'), ['keyword.gd']);
  assert.deepEqual(typeOfText(lines[4], 'Player'), ['type.identifier.gd']);
  assert.deepEqual(typeOfText(lines[5], 'enum'), ['keyword.gd']);
  assert.deepEqual(typeOfText(lines[5], 'State'), ['type.identifier.gd']);
  assert.deepEqual(typeOfText(lines[6], 'static'), ['keyword.gd']);
  assert.deepEqual(typeOfText(lines[6], 'create'), ['function.gd']);
  assert.deepEqual(typeOfText(lines[7], 'super'), ['keyword.gd']);
});

test('gdscript: аннотации Godot — @export, @onready, @tool, @rpc', async (t) => {
  const M = await monarch(t);
  if (!M) return;
  const lines = await tokenize(M, ['@tool', '@export var speed: float = 5.0', '@onready var sprite = $Sprite2D', '@rpc("any_peer")'].join('\n'));
  assert.deepEqual(typeOfText(lines[0], '@tool'), ['tag.gd']);
  assert.deepEqual(typeOfText(lines[1], '@export'), ['tag.gd']);
  assert.deepEqual(typeOfText(lines[1], 'float'), ['type.gd']);
  assert.deepEqual(typeOfText(lines[2], '@onready'), ['tag.gd']);
  assert.deepEqual(typeOfText(lines[3], '@rpc'), ['tag.gd']);
  // неизвестная аннотация тоже подсвечивается: в Godot их добавляют, ломать подсветку нельзя
  const [unknown] = await tokenize(M, '@brand_new_annotation var x = 1');
  assert.deepEqual(typeOfText(unknown, '@brand_new_annotation'), ['tag.gd']);
});

test('gdscript: узлы $Node, $"Path", %Unique и NodePath', async (t) => {
  const M = await monarch(t);
  if (!M) return;
  const lines = await tokenize(M, ['var a = $Sprite2D', 'var b = $"../Player/Body"', 'var c = %UniqueNode', 'var d = NodePath("a/b")', 'var e = ^"a/b"'].join('\n'));
  assert.deepEqual(typeOfText(lines[0], '$Sprite2D'), ['variable.gd']);
  assert.deepEqual(typeOfText(lines[1], '$"../Player/Body"'), ['variable.gd']);
  assert.deepEqual(typeOfText(lines[2], '%UniqueNode'), ['variable.predefined.gd']);
  assert.deepEqual(typeOfText(lines[3], 'NodePath'), ['type.gd']);
  // сигил NodePath входит в тот же токен, что и открывающая кавычка
  assert.deepEqual(typeOfText(lines[4], '^"'), ['string.quote.gd']);
  assert.deepEqual(typeOfText(lines[4], 'a/b'), ['string.gd']);
  const [sn] = await tokenize(M, 'var g = &"meta_name"');
  assert.deepEqual(typeOfText(sn, '&"'), ['string.quote.gd']);
  assert.deepEqual(typeOfText(sn, 'meta_name'), ['string.gd']);
});

test('gdscript: комментарии, строки и экранирование', async (t) => {
  const M = await monarch(t);
  if (!M) return;
  const lines = await tokenize(M, ['# обычный комментарий', '## документация', 'print("строка \\n и \\" кавычка")', "print('одинарные')"].join('\n'));
  assert.deepEqual(typeOfText(lines[0], '# обычный комментарий'), ['comment.gd']);
  assert.deepEqual(typeOfText(lines[1], '## документация'), ['comment.doc.gd']);
  assert.deepEqual(typeOfText(lines[2], 'print'), ['identifier.gd']);
  assert.ok(typesIn(lines[2]).includes('string.gd'), 'двойная строка распознана');
  assert.ok(typesIn(lines[2]).includes('string.escape.gd'), '\\n распознан как экранирование');
  assert.ok(typesIn(lines[3]).includes('string.gd'), 'одинарная строка распознана');
  // одинарная кавычка внутри двойной строки не закрывает её
  const [q] = await tokenize(M, 'print("it\'s ok") # хвост');
  assert.deepEqual(typeOfText(q, '# хвост'), ['comment.gd']);
});

test('gdscript: числа — int, float, hex, binary, с подчёркиваниями', async (t) => {
  const M = await monarch(t);
  if (!M) return;
  const [line] = await tokenize(M, 'var v = [42, 3.14, 1e6, 0xFF, 0b1010, 1_000_000]');
  assert.deepEqual(typeOfText(line, '42'), ['number.gd']);
  assert.deepEqual(typeOfText(line, '3.14'), ['number.float.gd']);
  assert.deepEqual(typeOfText(line, '1e6'), ['number.float.gd']);
  assert.deepEqual(typeOfText(line, '0xFF'), ['number.hex.gd']);
  assert.deepEqual(typeOfText(line, '0b1010'), ['number.binary.gd']);
  assert.deepEqual(typeOfText(line, '1_000_000'), ['number.gd']);
});

test('gdscript: управляющие конструкции и циклы', async (t) => {
  const M = await monarch(t);
  if (!M) return;
  const lines = await tokenize(M, ['for i in range(3):', 'while alive:', 'match state:', '\telif hp == 0:', '\telse:', '\t\tawait tick()', '\t\treturn', '\t\tbreak', '\t\tcontinue', '\t\tpass'].join('\n'));
  assert.deepEqual(typeOfText(lines[0], 'for'), ['keyword.control.gd']);
  assert.deepEqual(typeOfText(lines[0], 'in'), ['keyword.gd']);
  assert.deepEqual(typeOfText(lines[1], 'while'), ['keyword.control.gd']);
  assert.deepEqual(typeOfText(lines[2], 'match'), ['keyword.control.gd']);
  assert.deepEqual(typeOfText(lines[3], 'elif'), ['keyword.control.gd']);
  assert.deepEqual(typeOfText(lines[4], 'else'), ['keyword.control.gd']);
  assert.deepEqual(typeOfText(lines[5], 'await'), ['keyword.control.gd']);
  assert.deepEqual(typeOfText(lines[6], 'return'), ['keyword.control.gd']);
  assert.deepEqual(typeOfText(lines[7], 'break'), ['keyword.control.gd']);
  assert.deepEqual(typeOfText(lines[8], 'continue'), ['keyword.control.gd']);
  assert.deepEqual(typeOfText(lines[9], 'pass'), ['keyword.control.gd']);
});

test('gdscript: многострочная строка держит состояние между строками', async (t) => {
  const M = await monarch(t);
  if (!M) return;
  const text = 'var s = """\nпервая\nвторая\n"""\nvar after = 1';
  const tkz = makeTokenizer(M.compile, M.MonarchTokenizer);
  let state = tkz.getInitialState();
  const initial = tkz.getInitialState();
  const perLine = text.split('\n').map((line) => {
    const wasInside = !state.equals(initial);
    const res = tkz.tokenize(line, true, state);
    state = res.endState;
    return { line, tokens: res.tokens.map((x) => x.type), inside: wasInside };
  });
  // строки внутри """ продолжают считаться строкой
  assert.ok(perLine[1].tokens.every((x) => x === 'string.gd'), JSON.stringify(perLine[1].tokens));
  assert.ok(perLine[2].tokens.every((x) => x === 'string.gd'), JSON.stringify(perLine[2].tokens));
  assert.ok(perLine[1].inside, 'на второй строке токенайзер всё ещё внутри строки');
  // после закрытия состояние возвращается к корневому
  assert.deepEqual(typeOfText((await tokenize(M, text))[4], 'after'), ['variable.gd']);
});

test('gdscript: одиночный Godot-код из реального проекта разбирается целиком', async (t) => {
  const M = await monarch(t);
  if (!M) return;
  const src = [
    '@tool',
    'extends Node2D',
    'class_name Simulation',
    '',
    'signal batch_ready(items: Array)',
    '',
    '@export_range(0.0, 1.0) var friction := 0.5',
    '@onready var body: RigidBody2D = $Body',
    '',
    'const MAX_BATCH := 64',
    'var label := "готово"',
    'var done := false',
    'var ref = null',
    'enum Mode { IDLE, RUN, DONE }',
    '',
    '# Основной цикл',
    'func _physics_process(delta: float) -> void:',
    '\tif Engine.is_editor_hint():',
    '\t\treturn',
    '\tfor i in range(MAX_BATCH):',
    '\t\tvar item = $"Items/Item%d" % i',
    '\t\tmatch item.mode:',
    '\t\t\tMode.RUN:',
    '\t\t\t\titem.velocity *= 1.0 - friction',
    '\t\t\t_:',
    '\t\t\t\tpass',
    '\tawait get_tree().process_frame',
    '\tbatch_ready.emit(%Pool.take(0xFF))',
    '',
  ].join('\n');
  const lines = await tokenize(M, src);
  assert.equal(lines.length, src.split('\n').length);

  const all = lines.flat();
  const used = new Set(all.map((t) => t.type));
  for (const expected of ['keyword.gd', 'keyword.control.gd', 'tag.gd', 'comment.gd', 'string.gd',
    'number.gd', 'number.hex.gd', 'number.float.gd', 'function.gd', 'variable.gd',
    'variable.predefined.gd', 'type.gd', 'type.identifier.gd', 'operator.gd', 'constant.gd']) {
    assert.ok(used.has(expected), `в образце не встретился токен ${expected}: ${[...used].join(', ')}`);
  }
  // ни один фрагмент кода не должен остаться нераспознанным «пустым» токеном
  const empty = all.filter((t) => t.type === '' || t.type === '.gd');
  assert.deepEqual(empty, [], 'найдены нераспознанные фрагменты');
  // обратная сборка текста из токенов не теряет и не добавляет ни одного символа
  assert.equal(lines.map((l) => l.map((t) => t.text).join('')).join('\n'), src);
});

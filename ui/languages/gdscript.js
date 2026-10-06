'use strict';
// GDScript для Monaco (ТЗ §15). Отдельный файл намеренно: в Stage A он переедет в
// ui/languages/gdscript.js почти без изменений, а spike проверяет его как есть.
//
// Задача этого этапа — «хорошая подсветка + нормальное редактирование», без language server.
// Подключается как классический скрипт (без ESM/бандлера) и кладёт фабрику в window.WhaleGdscript.

(function (global) {
  const LANGUAGE_ID = 'whale-gdscript';

  const CONTROL_KEYWORDS = [
    'if', 'elif', 'else', 'for', 'while', 'match', 'return', 'break', 'continue', 'pass',
    'await', 'yield', 'when',
  ];

  // Объявления и модификаторы из ТЗ + то, без чего подсветка Godot-кода выглядит сломанной
  const KEYWORDS = [
    'extends', 'class_name', 'func', 'var', 'const', 'signal', 'enum', 'static', 'super',
    'class', 'namespace', 'in', 'is', 'as', 'and', 'or', 'not', 'self', 'void', 'export',
    'onready', 'tool', 'setget', 'breakpoint', 'rpc', 'master', 'puppet', 'sync', 'remotesync',
  ];

  const CONSTANTS = ['true', 'false', 'null', 'PI', 'TAU', 'INF', 'NAN'];

  // Встроенные типы Godot 4 (часто встречающиеся; список не обязан быть полным)
  const BUILTIN_TYPES = [
    'int', 'float', 'bool', 'String', 'StringName', 'NodePath', 'Array', 'Dictionary',
    'Vector2', 'Vector2i', 'Vector3', 'Vector3i', 'Vector4', 'Vector4i',
    'Rect2', 'Rect2i', 'Transform2D', 'Transform3D', 'Basis', 'Quaternion', 'Projection',
    'Color', 'Plane', 'AABB', 'RID', 'Object', 'Variant', 'Callable', 'Signal',
    'PackedByteArray', 'PackedInt32Array', 'PackedInt64Array', 'PackedFloat32Array',
    'PackedFloat64Array', 'PackedStringArray', 'PackedVector2Array', 'PackedVector3Array',
    'PackedColorArray', 'Node', 'Resource', 'RefCounted',
  ];

  // Глобальные синглтоны: их принято писать с большой буквы, и они не типы
  const SINGLETONS = [
    'OS', 'Input', 'InputMap', 'Engine', 'DisplayServer', 'RenderingServer', 'AudioServer',
    'PhysicsServer2D', 'PhysicsServer3D', 'NavigationServer2D', 'NavigationServer3D',
    'ResourceLoader', 'ResourceSaver', 'ProjectSettings', 'TranslationServer', 'Time', 'IP', 'JSON',
  ];

  // Аннотации Godot 4. Из ТЗ обязательны @export, @onready, @tool, @rpc; остальные — частые.
  const ANNOTATIONS = [
    'export', 'export_range', 'export_enum', 'export_flags', 'export_file', 'export_dir',
    'export_global_file', 'export_global_dir', 'export_multiline', 'export_node_path',
    'export_color_no_alpha', 'export_group', 'export_subgroup', 'export_category',
    'export_placeholder', 'export_storage', 'onready', 'tool', 'rpc', 'icon', 'warning_ignore',
    'static_unload', 'global_class', 'debug_history',
  ];

  const monarch = {
    defaultToken: '',
    tokenPostfix: '.gd',

    brackets: [
      { open: '{', close: '}', token: 'delimiter.curly' },
      { open: '[', close: ']', token: 'delimiter.square' },
      { open: '(', close: ')', token: 'delimiter.parenthesis' },
    ],

    controlKeywords: CONTROL_KEYWORDS,
    keywords: KEYWORDS,
    constants: CONSTANTS,
    builtinTypes: BUILTIN_TYPES,
    singletons: SINGLETONS,
    annotations: ANNOTATIONS,

    operators: [
      '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '<>',
      '+', '-', '*', '/', '&', '|', '^', '%', '**', '<<', '>>', '+=', '-=', '*=', '/=', '%=',
      '&=', '|=', '^=', '<<=', '>>=', '==', '&&', '||', ':=',
    ],
    // ':' включён, иначе ':=' (вывод типа) не находится ни одним правилом и даёт пустой токен
    symbols: /[=><!~&|+\-*/%^@.:]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[0-7]{1,3})/,
    digits: /\d+(?:_\d+)*/,

    tokenizer: {
      root: [
        // аннотации: @export, @onready, @tool, @rpc
        // (список annotations оставлен как документация: неизвестная аннотация тоже
        // подсвечивается — в Godot их добавляют, и ломать подсветку из-за новой не стоит)
        [/@[a-zA-Z_]\w*/, 'tag'],

        // doc-комментарий и обычный комментарий
        [/##.*$/, 'comment.doc'],
        [/#.*$/, 'comment'],

        // объявление функции/сигнала — имя подсвечиваем отдельно
        [/(func)(\s+)([a-zA-Z_]\w*)/, ['keyword', 'white', 'function']],
        [/(signal|enum)(\s+)([a-zA-Z_]\w*)/, ['keyword', 'white', 'type.identifier']],
        [/(class_name|extends)(\s+)([a-zA-Z_]\w*)/, ['keyword', 'white', 'type.identifier']],
        [/(var|const)(\s+)([a-zA-Z_]\w*)/, ['keyword', 'white', 'variable']],

        // доступ к узлам: $Node, $"Path/To/Node", %UniqueNode
        [/\$"[^"]*"/, 'variable'],
        [/\$[a-zA-Z_]\w*(?:\/[a-zA-Z_]\w*)*/, 'variable'],
        [/%[a-zA-Z_]\w*/, 'variable.predefined'],

        // StringName &"name" и NodePath ^"path"
        [/&"/, { token: 'string.quote', next: '@stringDouble' }],
        [/\^"/, { token: 'string.quote', next: '@stringDouble' }],

        // строки: тройные и одинарные
        [/"""/, { token: 'string.quote', next: '@stringTripleDouble' }],
        [/'''/, { token: 'string.quote', next: '@stringTripleSingle' }],
        [/"/, { token: 'string.quote', next: '@stringDouble' }],
        [/'/, { token: 'string.quote', next: '@stringSingle' }],

        // числа
        [/0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*/, 'number.hex'],
        [/0[bB][01](?:_?[01])*/, 'number.binary'],
        // числа: сначала более длинные формы, иначе '5.0' распалось бы на '5' + '.0'
        [/@digits\.\d*(?:[eE][+-]?@digits)?/, 'number.float'],
        [/\.\d+(?:[eE][+-]?@digits)?/, 'number.float'],
        [/@digits[eE][+-]?@digits/, 'number.float'],
        [/@digits/, 'number'],

        // идентификаторы
        [/[a-zA-Z_]\w*/, {
          cases: {
            '@controlKeywords': 'keyword.control',
            '@constants': 'constant',
            '@builtinTypes': 'type',
            '@singletons': 'variable.predefined',
            '@keywords': 'keyword',
            '@default': 'identifier',
          },
        }],

        // пробелы и отступы
        [/[ \t\r\n]+/, 'white'],

        // разделители и операторы
        [/[:](?=\s|$)/, 'delimiter'],
        [/[{}()[\]]/, '@brackets'],
        [/@symbols/, {
          cases: {
            '@operators': 'operator',
            '@default': 'delimiter',
          },
        }],
        [/[.,;]/, 'delimiter'],
      ],

      stringDouble: [
        [/[^\\"]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/"/, { token: 'string.quote', next: '@pop' }],
      ],
      stringSingle: [
        [/[^\\']+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/'/, { token: 'string.quote', next: '@pop' }],
      ],
      stringTripleDouble: [
        [/[^"]+/, 'string'],
        [/""(?!")/, 'string'],
        [/@escapes/, 'string.escape'],
        [/"""/, { token: 'string.quote', next: '@pop' }],
      ],
      stringTripleSingle: [
        [/[^']+/, 'string'],
        [/''(?!')/, 'string'],
        [/@escapes/, 'string.escape'],
        [/'''/, { token: 'string.quote', next: '@pop' }],
      ],
    },
  };

  function configuration(monaco) {
    const IndentAction = monaco.languages.IndentAction;
    return {
      comments: { lineComment: '#' },
      brackets: [['(', ')'], ['[', ']'], ['{', '}']],
      autoClosingPairs: [
        { open: '(', close: ')' },
        { open: '[', close: ']' },
        { open: '{', close: '}' },
        { open: '"', close: '"', notIn: ['string'] },
        { open: "'", close: "'", notIn: ['string'] },
      ],
      surroundingPairs: [
        { open: '(', close: ')' }, { open: '[', close: ']' }, { open: '{', close: '}' },
        { open: '"', close: '"' }, { open: "'", close: "'" },
      ],
      // Отступы в GDScript значимы: после строки, заканчивающейся на ':', — отступ внутрь
      indentationRules: {
        increaseIndentPattern: /^.*:\s*(#.*)?$/,
        decreaseIndentPattern: /^\s*(?:elif|else|pass)\b.*$/,
      },
      onEnterRules: [
        { beforeText: /^.*:\s*(#.*)?$/, action: { indentAction: IndentAction.Indent } },
        { beforeText: /^\s*(?:elif|else)\b.*:\s*(#.*)?$/, action: { indentAction: IndentAction.Indent } },
      ],
      folding: {
        offSide: true, // блоки задаются отступами, а не скобками
        markers: { start: /^\s*#region\b/, end: /^\s*#endregion\b/ },
      },
    };
  }

  function register(monaco) {
    monaco.languages.register({
      id: LANGUAGE_ID,
      extensions: ['.gd', '.gdscript'],
      aliases: ['GDScript', 'gdscript', 'Godot'],
      mimetypes: [],
    });
    monaco.languages.setLanguageConfiguration(LANGUAGE_ID, configuration(monaco));
    monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, monarch);
    return LANGUAGE_ID;
  }

  const api = { LANGUAGE_ID, monarch, configuration, register };
  global.WhaleGdscript = api;
  // Дублируем в module.exports, чтобы определение языка можно было прогонять
  // node-тестами (Monarch-компилятор Monaco не требует DOM). В браузере ветка не выполняется.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

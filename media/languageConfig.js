export const languageConfig_js = {
    // 设置默认标记
    defaultToken: 'invalid',
        
    // 类型关键字
    typeKeywords: [
        'function', 'class', 'struct', 'interface', 'enum', 'type', 'namespace'
    ],
    
    // 流程控制关键字
    flowKeywords: [
        'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 
        'break', 'continue', 'return', 'throw', 'try', 'catch', 'finally', 'await', 'yield',
        'delete', 'new'
    ],
    
    // 其他关键字
    keywords: [
        'var', 'let', 'const', 'this', 'super', 'extends', 'implements',
        'import', 'export', 'from', 'as', 'async', 'void', 'typeof', 'instanceof', 'in', 'of', 'with',
        'get', 'set', 'constructor', 'static', 'private', 'protected', 'public', 'declare'
    ],
    
    // 操作符
    operators: [
        '<=', '>=', '==', '!=', '===', '!==', '=>', '+', '-', '**',
        '*', '/', '%', '++', '--', '<<', '</', '>>', '>>>', '&',
        '|', '^', '!', '~', '&&', '||', '?', ':', '=', '+=', '-=',
        '*=', '**=', '/=', '%=', '<<=', '>>=', '>>>=', '&=', '|=',
        '^=', '@',
    ],
    
    // 符号
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    
    // 转义字符
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    
    // 整数部分的正则表达式
    digits: /\d+(_+\d+)*/,
    
    // 标记化规则
    tokenizer: {
        root: [
            // 注释 - 优先处理注释，确保注释中的关键字不被识别
            [/\/\*/, 'comment', '@comment'],
            [/\/\/.*$/, 'comment'],

            // 正则表达式 - 优先处理
            [/\/(?:[^\/\\]|\\.)*\/[gimuy]*/, 'regexp'],
            
            // 字符串
            [/"([^"\\]|\\.)*$/, 'string.invalid'],
            [/'([^'\\]|\\.)*$/, 'string.invalid'],
            [/"/, 'string', '@string_double'],
            [/'/, 'string', '@string_single'],
            [/`/, 'string', '@string_backtick'],
            
            // 数字
            [/(@digits)[eE]([\-+]?(@digits))?/, 'number'],
            [/(@digits)\.(@digits)([eE][\-+]?(@digits))?/, 'number'],
            [/0[xX][0-9a-fA-F]+/, 'number'],
            [/0[oO]?[0-7]+/, 'number'],
            [/0[bB][0-1]+/, 'number'],
            [/(@digits)/, 'number'],

            // 模板参数
            [/<(?!<)/, { token: 'delimiter.angle', next: '@template' }],

            // 布尔值
            [/\b(true|false)\b/, 'boolean'],
            
            // null
            [/\bnull\b/, 'null'],

            // test
            //[/(?<!int)\s*(dddata)/, { token: 'keyword.flow', log: console.log('[definition] 1')}],
            //[/int2/, { token: 'keyword.flow', log: console.log('[definition] 2')}],

            [/(\bget|set\b)(?=\s*\()/, 'method.name'],
            
            // 关键字
            [/\b(this|readonly|undefined|unknown|any|global|string|super|abstract|extends|implements|Promise|declare|import|export|from|async|void|boolean|Boolean|Number|String|number|typeof|instanceof|in|of|with|get|set|constructor|static|private|protected|public)\b/, 'keyword'],

            [/\bfunction\b/, { token: 'keyword.type', next: '@afterFunction' }],
            // 类型关键字 - function, class, struct 等
            [/\b(function|class|struct|interface|enum|type|namespace)\b/, { token: 'keyword.type', next: '@afterClass' }],

            [/\bas\b/, { token: 'keyword', next: '@afterAs' }],

            // 流程控制关键字 - if, else 等
            [/\b(if|else|for|while|do|switch|case|default|break|continue|return|throw|try|catch|finally|new|delete|await|yield)\b/, 'keyword.flow'],

            // 函数定义 - 改进的函数名识别
            [/([a-zA-Z_$][\w$]*)(?=\s*:\s*function\b)/, 'function.name'],
            [/\b(function)\b\s*([a-zA-Z_$][\w$]*)/, ['keyword.type', 'function.name']],
            
            [/(\b[a-zA-Z_$][\w$]*)(?=\s*\()/, 'method.name'],
            [/([a-zA-Z_$][\w$]*)\s*(?=<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*\()/, 'method.name'],
            [/([a-zA-Z_$][\w$]*)\s*(?=<[^<>]*(?:<[^<>]*>[^<>]*)*>)/, 'type'],

            [/\b(var|let|const)\b/, { token: 'keyword', next: '@afterVariableDeclaration' }],
            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=\=\s*function)/, 'method.name'],
            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=:|\?\s*:)/, 'variable.name'],

            [/\=>(?=\s*\b[a-zA-Z_$][\w$]*\b)/, { token: 'operator', next: '@afterArrow' }],
            [/\=>/, 'operator'],

            // ?<= may not supported
            // get() : type
            //[/(?<=\)\s*:)\s*\b([a-zA-Z_$][\w$]*)\b/, 'type'],
            [/\)\s*:(?=\s*\b([a-zA-Z_$][\w$]*)\b)/, { token: 'delimiter', next: '@afterDelimiterType' }],
            // : type = value;
            //[/(?<=:)\s*\b([a-zA-Z_$][\w$]*)\b(?=\s*\=)/, 'type'],
            [/:(?=\s*\b([a-zA-Z_$][\w$]*)\b\s*\=)/, { token: 'delimiter', next: '@afterDelimiterType' }],
            
            // 函数参数 - 改进的参数识别
            // Match function parameters (exclude keywords)
            [/\(\s*(?!true|false|null|undefined|unknown\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            [/,\s*(?!true|false|null|undefined|unknown\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            
            // 标识符 - 捕获所有其他标识符
            [/\b[a-zA-Z_$][\w$]*\b(?=\s*extends)/, { token: 'type', next: '@afterClass' }],
            [/[a-zA-Z_$][\w$]*/, 'identifier'],
            
            // 分隔符和括号
            [/[{}()\[\]]/, 'delimiter.bracket'],
            [/[<>](?!@symbols)/, 'delimiter.bracket'],
            [/@symbols/, {
                cases: {
                    '@operators': 'operator',
                    '@default': 'delimiter'
                }
            }],
            
            // 分隔符：. , ; ...
            [/[;,.]/, 'delimiter'],
            
            // 空格
            [/\s+/, 'white'],
        ],

        template: [
            [/>/, { token: 'delimiter.angle', next: '@pop' }],
            { include: 'root' }
        ],

        afterAs: [
            [/\s+/, 'white'],  // 跳过空白
            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=\.)/, 'type'],
            [/\b([a-zA-Z_$][\w$]*)\b/, { token: 'type', next: '@pop' }],
            [/\./, 'delimiter'],
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterArrow: [
            [/\s+/, 'white'],  // 跳过空白
            [/\b([a-zA-Z_$][\w$]*)\b/, { token: 'type', next: '@pop' }],
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterDelimiterType: [
            [/\s+/, 'white'],  // 跳过空白
            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=\.)/, 'type'],
            [/\b([a-zA-Z_$][\w$]*)\b/, { token: 'type', next: '@pop' }],
            [/\./, 'delimiter'],
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],
        
        // 多行注释 - 确保注释中的关键字不被识别
        comment: [
            [/[^\/*]+/, 'comment'],
            [/\*\//, 'comment', '@pop'],
            [/[\/*]/, 'comment']
        ],
        
        // 双引号字符串
        string_double: [
            [/[^\\"]+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/"/, 'string', '@pop']
        ],
        
        // 单引号字符串
        string_single: [
            [/[^\\']+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/'/, 'string', '@pop']
        ],
        
        // 反引号字符串（模板字符串）
        string_backtick: [
            [/\$\{/, { token: 'delimiter.bracket', next: '@bracketCounting' }],
            [/[^\\`$]+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/`/, 'string', '@pop']
        ],
        
        // 模板字符串中的表达式
        bracketCounting: [
            [/\{/, 'delimiter.bracket', '@bracketCounting'],
            [/\}/, 'delimiter.bracket', '@pop'],
            { include: 'root' }
        ],
        
        // 类名识别状态
        afterClass: [
            [/\s+/, 'white'],  // 跳过空白
            [/extends\b/, { token: 'keyword', next: '@afterExtends' }], // extends
            [/\bimplements\b/, { token: 'keyword', next: '@afterImplements' }], // implements
            [/[a-zA-Z_$][\w$]*/, 'class.name'],  // 识别类名
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterClassName: [
            [/\s+/, 'white'],  // 跳过空白
            [/\bextends\b/, { token: 'keyword', next: '@afterExtends' }], // extends
            [/\bimplements\b/, { token: 'keyword', next: '@afterImplements' }], // implements
            [/[{;=]/, { token: 'delimiter.bracket', next: '@root' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@root' }]  // 其他情况返回并重新匹配
        ],

        // 状态内规则如果没有显式指定next，匹配后会回到状态其实位置重新执行，因此要先识别implements
        // export class AppMain extends LoggerImpl(BehaviourDelegate) implements IPlatform {
        // fromNative: <T extends NativeTemplateType>(nativeArray: NativeArray<T>) => NativeNumberFilter<T>[];
        afterExtends: [
            [/\s+/, 'white'],  // 跳过空白
            [/\bimplements\b/, { token: 'keyword', next: '@afterImplements' }], // implements
            [/(\b[a-zA-Z_$][\w$]*)(?=\s*\()/, 'method.name'],
            [/([a-zA-Z_$][\w$]*)\s*(?=<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*\()/, 'method.name'],
            [/[()<>]/, 'delimiter'],
            [/[a-zA-Z_$][\w$]*(?=\s*>)/, { token: 'type', next: '@pop' }],  // 识别基类
            [/[a-zA-Z_$][\w$]*/, 'type'],  // 识别基类
            [/[\.|]/, 'delimiter'],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@root' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@root' }]  // 其他情况返回并重新匹配
        ],

        afterImplements: [
            [/\s+/, 'white'],  // 跳过空白
            [/(\b[a-zA-Z_$][\w$]*)(?=\s*\()/, 'method.name'],
            [/([a-zA-Z_$][\w$]*)\s*(?=<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*\()/, 'method.name'],
            [/[()<>]/, 'delimiter'],
            [/[a-zA-Z_$][\w$]*/, 'type'],  // 识别接口
            [/[\.|]/, 'delimiter'],
            [/\s*,/, 'delimiter.bracket'], // 不用显式next: '@afterImplements'
            [/[{;=]/, { token: 'delimiter.bracket', next: '@root' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@root' }]  // 其他情况返回并重新匹配
        ],

        afterVariableDeclaration: [
            [/\s+/, 'white'],  // 跳过空白
            [/[a-zA-Z_$][\w$]*/, 'variable.name'],  // 识别变量名
            [/\s+/, 'white'],  // 跳过空白
            [/[({;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/:\s*([a-zA-Z_$][\w$]*)/, { token: 'type', next: '@pop' }],
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterFunction: [
            [/\s+/, 'white'],  // 跳过空白
            [/[a-zA-Z_$][\w$]*/, { token: 'function.name', next: '@pop' }],//, log: '[definition] Entering function return value processing' }],  // 识别函数名
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],
    }
}

// https://microsoft.github.io/monaco-editor/monarch.html
export const languageConfig_cpp = {
    // 设置默认标记
    defaultToken: 'invalid',
        
    // 类型关键字
    typeKeywords: [
        'class', 'struct', 'union', 'enum', 'typedef', 'template', 'namespace', 'using'
    ],
    
    // 流程控制关键字
    flowKeywords: [
        'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 
        'break', 'continue', 'return', 'goto', 'try', 'catch', 'throw', 'new', 'delete', 'await', 'yield', 'typedef'
    ],
    
    // 其他关键字
    keywords: [
        'auto', 'const', 'constexpr', 'static', 'extern', 'register', 'volatile', 'mutable',
        'inline', 'virtual', 'explicit', 'friend', 'public', 'protected', 'private',
        'operator', 'sizeof', 'alignof', 'typeid', 'decltype',
        'this', 'nullptr', 'true', 'false', 'and', 'or', 'not', 'bitand', 'bitor', 'xor',
        'compl', 'and_eq', 'or_eq', 'xor_eq', 'not_eq', 'typename', 'virtual'
    ],
    
    // 操作符
    operators: [
        '<=', '>=', '==', '!=', '===', '!==', '=>', '+', '-', '**',
        '*', '/', '%', '++', '--', '<<', '>>', '&', '|', '^', '!', '~',
        '&&', '||', '?', ':', '=', '+=', '-=', '*=', '/=', '%=', '<<=',
        '>>=', '&=', '|=', '^=', '->', '.*', '->*'
    ],

    // innerTypes: [
    //     'auto', 'signed', 'short', 'char', 'unsigned', 'long', 'int', 'bool', 'float', 'double', 'void'
    // ],
    innerTypes: /\bauto|signed|short|char|unsigned|long|int|bool|float|double|void\b/,
    
    // 符号
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    
    // 转义字符
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    
    // 整数部分的正则表达式
    digits: /\d+(_+\d+)*/,
    
    // 标记化规则
    tokenizer: {
        root: [
            // 注释 - 优先处理注释，确保注释中的关键字不被识别
            [/\/\*/, 'comment', '@comment'],
            [/\/\/.*$/, 'comment'],
            [/#\s*include\b/, 'keyword.directive'],
            [/#\s*pragma\b/, 'keyword.directive'],
            [/#\s*define\b/, { token: 'keyword.directive.control', next: '@afterMacro' }],
            [/#\s*undef\b/, { token: 'keyword.directive.control', next: '@afterMacro' }],
            [/#\s*ifdef\b/, { token: 'keyword.directive.control', next: '@afterMacro' }],
            [/#\s*ifndef\b/, { token: 'keyword.directive.control', next: '@afterMacro' }],
            [/#\s*elif\b/, { token: 'keyword.directive.control', next: '@afterMacro' }],
            [/#\s*if\b/, 'keyword.directive.control'],
            [/#\s*else\b/, 'keyword.directive.control'],
            [/#\s*endif\b/, 'keyword.directive.control'],
            
            // 字符串
            [/"([^"\\]|\\.)*$/, 'string.invalid'],
            [/'([^'\\]|\\.)*$/, 'string.invalid'],
            [/"/, 'string', '@string_double'],
            [/'/, 'string', '@string_single'],
            [/`/, 'string', '@string_backtick'],
            
            // 数字
            [/(@digits)[eE]([\-+]?(@digits))?[fF]?/, 'number'],
            [/(@digits)\.(@digits)([eE][\-+]?(@digits))?[fF]?/, 'number'],
            [/0[xX][0-9a-fA-F]+/, 'number'],
            [/0[oO]?[0-7]+/, 'number'],
            [/0[bB][0-1]+/, 'number'],
            [/(@digits)/, 'number'],
            
            // 模板参数
            [/<(?!<)/, { token: 'delimiter.angle', next: '@template' }],

            // [/(int)\s+([a-zA-Z_][\w]*)?/gm, { 
            //     cases: { 
            //         '$1': 'keyword.type',  // int 始终作为类型关键字
            //         '$2': 'keyword.flow' // 变量名使用单独样式
            //     }
            // }],

            //[/([A-Z](?:[\n\r\s]|[a-zA-Z0-9_]|\-[a-zA-Z])*)(\.?)/, { cases: { '$2': ['keyword.flow','identifier'], 
            //                                                        '@default': 'keyword' }}],

            //[/void\b/, { token: '@rematch', next: '@afterVoidCheck' }],

            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*static|const\b)/, 'keyword'],
            [/\b(template)\b/, 'keyword.type'],

            // 关键字
            [/\b(extern|const|volatile|static|operator|thread_local|constexpr|abstract|this|decltype|inline|friend|typename|explicit|nullptr|null|override|super|extends|implements|virtual|import|export|sizeof|from|as|async|typeof|instanceof|in|of|with|get|set|constructor|private|protected|public)\b/, 'keyword'],

            [/\b(typedef)\b/, 'keyword.flow'],

            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*class|struct\b)/, 'keyword'],

            //[/\b([a-zA-Z_$][\w$]*)\b/, { token: '@rematch', next: '@preClassCheck' }],

            // [dllexport] class [dllexport] AEFCharacterBase : public ACharacter
            //[/\b([a-zA-Z_$][\w$]*)\b\s+(?=class|struct)/, 'macro.name'],

            // 类型关键字 - class, struct 等
            [/\b(class|struct|interface|enum|union)\b/, { token: 'keyword.type', next: '@afterClass' }],
            [/\bnamespace\b/, { token: 'keyword.type', next: '@afterNameSpace' }],

            [/(?<=\[)\s*\b(using)\b/, 'keyword.type'],
            [/\b(using)\b/, { token: 'keyword.type', next: '@afterUsing' }],

            // 流程控制关键字 - if, else 等
            [/\b(if|else|for|while|do|switch|case|default|break|continue|return|throw|try|catch|finally|goto|new|delete|await|yield)\b/, 'keyword.flow'],

            // 方法定义
            // uint Game::GetNumVertex()
            [/\b([a-zA-Z_$][\w$]*)\b\s+(?=[a-zA-Z_$][\w$]*\s*::\s*[a-zA-Z_$][\w$]*\s*\()/, { token: 'type', next: '@functionAfter' }],
            // uint GetNumVertex()
            [/\b([a-zA-Z_$][\w$]*)\b\s+(?=[a-zA-Z_$][\w$]*\s*\()/, { token: 'type', next: '@functionAfterClass' }],
            // int Game::GetNumVertex(), int has be tokenized by keyword, Game::~Game()
            // todo: Game::Game() : var1(0), var2(NULL)
            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=::\s*~*\s*[a-zA-Z_$][\w$]*\s*\()/, { token: 'type', next: '@functionAfterClass' }],
            [/(\b[a-zA-Z_$][\w$]*)(?=\s*\()/, 'method.name'],
            // func<type>()
            // Func<Dictionary<K,V>>()
            //[/([a-zA-Z_$][\w$]*)\s*(?=<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*\()/, 'method.name'],
            // Func<Dictionary<vector<int>,string<char>>>()
            [/([a-zA-Z_$][\w$]*)\s*(?=<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>\s*\()/, 'method.name'],

            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=::)/, { token: 'type', next: '@afterScope' }],
            [/(?<=::)\s*\b([a-zA-Z_$][\w$]*)\b\s+(?=[a-zA-Z_$][\w$]*\s*::\s*[a-zA-Z_$][\w$]*\s*\()/, { token: 'type', next: '@functionAfter' }],
            [/(?<=::)\s*\b([a-zA-Z_$][\w$]*)\b/, { token: 'type', next: '@typeDeclare' }],

            // parse variable
            [/\b(@innerTypes|[a-zA-Z_$][\w$]*)\b(?=\s*[\*&]*\s*[a-zA-Z_$][\w$]*)/, { token: 'type', next: '@afterType' }],
            [/\b@innerTypes\b/, 'type'],

            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*<(?!<))/, { token: 'type', next: '@preTemplateType' }],

            // 通用类名后跟变量名的模式识别
            //[/\b([a-zA-Z_$][\w$]*)\b\s+([a-zA-Z_$][\w$]*)/, ['class.name', 'variable.name']],
            //[/\b([a-zA-Z_$][\w$]*)\b\s+([a-zA-Z_$][\w$]*)/, ['class.name', 'variable.name']],
            // 添加类型名识别规则
            //[/\b([a-zA-Z_$][\w$]*)\b\s+([a-zA-Z_$][\w$]*)/, ['class.name', 'variable.name']],

            //[/\b([a-zA-Z_$][\w$]*)\b\s+(?=\b[a-zA-Z_$][\w$]*\b)/, 'type'],
            //[/\b([a-zA-Z_$][\w$]*)\b\s*(?=[\={])/, 'variable.name'],
            
            // 对象属性
            [/([a-zA-Z_$][\w$]*)\s*(?=:)/, 'property'],
            
            // 函数参数 - 改进的参数识别
            [/\(\s*(?!true|false|null|nullptr\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            [/,\s*(?!true|false|null|nullptr\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            
            // 布尔值
            [/\b(true|false)\b/, 'boolean'],

            // 标识符 - 捕获所有其他标识符
            [/[a-zA-Z_$][\w$]*/, 'identifier'],
            
            // 分隔符和括号
            [/[{}\(\)\[\]]/, 'delimiter.bracket'],
            [/[<>](?!@symbols)/, 'delimiter.bracket'],
            [/@symbols/, {
                cases: {
                    '@operators': 'operator',
                    '@default': 'delimiter'
                }
            }],
            
            // 分隔符：. , ; ...
            [/[;,.]/, 'delimiter'],
            
            // 空格
            [/\s+/, 'white'],
        ],
        template: [
            [/>/, { token: 'delimiter.angle', next: '@pop' }],
            { include: 'root' }
        ],
        
        // 多行注释 - 确保注释中的关键字不被识别
        comment: [
            [/[^\/*]+/, 'comment'],
            [/\*\//, 'comment', '@pop'],
            [/[\/*]/, 'comment']
        ],
        
        // 双引号字符串
        string_double: [
            [/[^\\"]+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/"/, 'string', '@pop']
        ],
        
        // 单引号字符串
        string_single: [
            [/[^\\']+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/'/, 'string', '@pop']
        ],
        
        // 反引号字符串（模板字符串）
        string_backtick: [
            [/\$\{/, { token: 'delimiter.bracket', next: '@bracketCounting' }],
            [/[^\\`$]+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/`/, 'string', '@pop']
        ],
        
        // 模板字符串中的表达式
        bracketCounting: [
            [/\{/, 'delimiter.bracket', '@bracketCounting'],
            [/\}/, 'delimiter.bracket', '@pop'],
            { include: 'root' }
        ],

        afterType: [
            [/\s+/, 'white'],  // 跳过空白
            [/\bconst|volatile|static|thread_local|constexpr|operator\b/, 'keyword'],
            [/\b(@innerTypes|[a-zA-Z_$][\w$]*)\b(?=\s*[\*&]*\s*[a-zA-Z_$][\w$]*)/, 'type'],
            [/\b([a-zA-Z_$][\w$]*)\b(?!\s*\()/, 'variable.name'],
            [/[\*&,]/, 'delimiter'],
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        // 类名识别状态
        afterClass: [
            [/\s+/, 'white'],  // 跳过空白
            // (class classname *cls,)
            [/([a-zA-Z_$][\w$]*)\b(?=\s*[\*&]*\s*[a-zA-Z_$][\w$]*[,\)])/, { token: 'keyword', next: '@afterType' }],
            [/([a-zA-Z_$][\w$]*)\b(?=\s*[a-zA-Z_$][\w$]*)/, 'keyword'],  // 识别其它 dllexport
            [/[a-zA-Z_$][\w$]*\b(?!\s*[\*&])/, 'class.name'],  // 识别类名
            [/[a-zA-Z_$][\w$]*\b/, 'type'], // void test(class A &a)
            [/</, { token: 'delimiter.angle', next: '@afterTypeTemplate' }],
            [/::/, { token: 'delimiter', next: '@pop' }],
            [/:/, { token: 'delimiter', next: '@classExtends' }],
            [/[{;,:=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        classExtends: [
            [/\s+/, 'white'],  // 跳过空白
            [/\bvirtual|public|protected|private\b/, 'keyword'],
            [/</, { token: 'delimiter.angle', next: '@afterTypeTemplate' }],
            [/[a-zA-Z_$][\w$]*\b/, 'type'],
            [/,/, 'delimiter'],
            [/[{;]/, { token: 'delimiter.bracket', next: '@root' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@root' }]  // 其他情况返回并重新匹配
        ],

        // 宏名识别状态
        afterMacro: [
            [/\s+/, 'white'],  // 跳过空白
            //[/\b*defined\b/, { token: 'keyword.directive.control', next: '@pop' }],
            [/[a-zA-Z_$][\w$]*/, { token: 'macro', next: '@pop' }],  // 识别类名
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        functionAfter: [
            [/\s+/, 'white'],  // 跳过空白
            [/([a-zA-Z_$][\w$]*\b)/, { token: 'type', next: '@functionAfterClass' }],  // 识别类名
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        functionAfterClass: [
            [/\s+/, 'white'],  // 跳过空白
            [/::/, 'delimiter'],
            [/~\s*/, 'delimiter'],
            [/([a-zA-Z_$][\w$]*\b)/, { token: 'method.name', next: '@pop' }],  // 识别方法名
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterUsing: [
            [/\s+/, 'white'],  // 跳过空白
            [/\bnamespace\b/, { token: 'keyword.type', next: '@afterUsingNamespace' }],
            [/([a-zA-Z_$][\w$]*)(?=\s*\=)/, 'class.name'],
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterUsingNamespace: [
            [/\s+/, 'white'],  // 跳过空白
            [/([a-zA-Z_$][\w$]*)/, { token: 'type', next: '@root' }],
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@root' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@root' }]  // 其他情况返回并重新匹配
        ],

        typeDeclare: [
            [/\s+/, 'white'],  // 跳过空白
            [/([a-zA-Z_$][\w$]*)/, 'variable.name'],
            [/,/, 'delimiter.bracket'],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterScope: [
            [/\s+/, 'white'],  // 跳过空白
            [/::/, 'delimiter'],
            [/<</, { token: 'operator', next: '@pop' }],
            [/</, { token: 'delimiter.angle', next: '@templateType' }],
            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*[a-zA-Z_$][\w$]*\s*\()/, { token: 'type', next: '@pop' }],
            [/\b([a-zA-Z_$][\w$]*)\b(?=::)/, 'type'],
            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*<(?!<))/, 'type'],
            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*[a-zA-Z_$][\w$]*)/, { token: 'type', next: '@afterType' }],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterNameSpace: [
            [/\s+/, 'white'],  // 跳过空白
            [/::/, 'delimiter'],
            [/\b([a-zA-Z_$][\w$]*)\b/, 'class.name'],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterTypeTemplate: [
            [/>/, { token: 'delimiter.angle', next: '@pop' }],
            { include: 'root' }
        ],

        preTemplateType: [
            [/</, { token: 'delimiter.angle', next: '@templateType' }],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        templateType: [
            [/>(?=\s*[a-zA-Z_$][\w$]*(?!\s*\())/, { token: 'delimiter.angle', next: '@afterType' }],
            [/>/, { token: 'delimiter.angle', next: '@pop' }],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            { include: 'root' }
        ]
    }
}

export const languageConfig_cs = {
    // 设置默认标记
    defaultToken: 'invalid',
        
    // 类型关键字
    typeKeywords: [
        'class', 'struct', 'union', 'enum', 'typedef', 'template', 'namespace', 'using'
    ],
    
    // 流程控制关键字
    flowKeywords: [
        'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 
        'break', 'continue', 'return', 'goto', 'try', 'catch', 'throw', 'new', 'delete', 'await', 'yield', 'typedef'
    ],
    
    // 其他关键字
    keywords: [
        'auto', 'const', 'constexpr', 'static', 'extern', 'register', 'volatile', 'mutable',
        'inline', 'virtual', 'explicit', 'friend', 'public', 'protected', 'private',
        'operator', 'sizeof', 'alignof', 'typeid', 'decltype',
        'this', 'nullptr', 'true', 'false', 'and', 'or', 'not', 'bitand', 'bitor', 'xor',
        'compl', 'and_eq', 'or_eq', 'xor_eq', 'not_eq', 'typename', 'virtual'
    ],
    
    // 操作符
    operators: [
        '<=', '>=', '==', '!=', '===', '!==', '=>', '+', '-', '**',
        '*', '/', '%', '++', '--', '<<', '>>', '&', '|', '^', '!', '~',
        '&&', '||', '?', ':', '=', '+=', '-=', '*=', '/=', '%=', '<<=',
        '>>=', '&=', '|=', '^=', '->', '.*', '->*'
    ],
    
    innerTypes: /\bvar|string|String|signed|short|char|unsigned|long|int|bool|float|double|void|delegate\b/,
    
    // 符号
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    
    // 转义字符
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    
    // 整数部分的正则表达式
    digits: /\d+(_+\d+)*/,
    
    // 标记化规则
    tokenizer: {
        root: [
            // 注释 - 优先处理注释，确保注释中的关键字不被识别
            [/\/\*/, 'comment', '@comment'],
            [/\/\/.*$/, 'comment'],
            [/#\s*include\b/, 'keyword.directive'],
            [/#\s*pragma\b/, 'keyword.directive'],
            [/#\s*define\b/, { token: 'keyword.directive.control', next: '@afterMacro' }],
            [/#\s*undef\b/, { token: 'keyword.directive.control', next: '@afterMacro' }],
            [/#\s*ifdef\b/, { token: 'keyword.directive.control', next: '@afterMacro' }],
            [/#\s*ifndef\b/, { token: 'keyword.directive.control', next: '@afterMacro' }],
            [/#\s*elif\b/, { token: 'keyword.directive.control', next: '@afterMacro' }],
            [/#\s*if\b/, { token: 'keyword.directive.control', next: '@afterMacro' }],
            [/#\s*else\b/, 'keyword.directive.control'],
            [/#\s*endif\b/, 'keyword.directive.control'],
            
            // 字符串
            [/"([^"\\]|\\.)*$/, 'string.invalid'],
            [/'([^'\\]|\\.)*$/, 'string.invalid'],
            [/"/, 'string', '@string_double'],
            [/'/, 'string', '@string_single'],
            [/`/, 'string', '@string_backtick'],
            
            // 数字
            [/(@digits)[eE]([\-+]?(@digits))?[fF]?/, 'number'],
            [/(@digits)\.(@digits)([eE][\-+]?(@digits))?[fF]?/, 'number'],
            [/0[xX][0-9a-fA-F]+/, 'number'],
            [/0[oO]?[0-7]+/, 'number'],
            [/0[bB][0-1]+/, 'number'],
            [/(@digits)/, 'number'],
            
            // 模板参数
            [/<(?!<)/, { token: 'delimiter.angle', next: '@template' }],

            [/#\s*(region|endregion)$/, 'keyword.directive'],
            [/#\s*(region|endregion)\b/, { token: 'keyword.directive', next: '@region' }],

            // [/(int)\s+([a-zA-Z_][\w]*)?/gm, { 
            //     cases: { 
            //         '$1': 'keyword.type',  // int 始终作为类型关键字
            //         '$2': 'keyword.flow' // 变量名使用单独样式
            //     }
            // }],

            //[/([A-Z](?:[\n\r\s]|[a-zA-Z0-9_]|\-[a-zA-Z])*)(\.?)/, { cases: { '$2': ['keyword.flow','identifier'], 
            //                                                        '@default': 'keyword' }}],

            //[/void\b/, { token: '@rematch', next: '@afterVoidCheck' }],

            // 关键字
            [/\b(extern|const|constexpr|this|null|inline|global|abstract|override|super|extends|auto|implements|virtual|import|export|sizeof|from|as|ref|async|typeof|instanceof|in|out|of|with|get|set|constructor|static|private|protected|public)\b/, 'keyword'],

            [/\b(typedef)\b/, 'keyword.flow'],

            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*class|struct\b)/, 'keyword'],

            // 类型关键字 - class, struct 等
            [/\b(class|struct|interface|enum|union|type)\b/, { token: 'keyword.type', next: '@afterClass' }],
            [/\bnamespace\b/, { token: 'keyword.type', next: '@afterNameSpace' }],

            // using ()
            [/\b(using)\b(?=\s*\()/, 'keyword.type'],
            [/\b(using)\b/, { token: 'keyword.type', next: '@afterUsing' }],

            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*static|const\b)/, 'keyword'],

            // 流程控制关键字 - if, else 等
            [/\b(if|else|for|while|do|switch|case|default|break|continue|return|throw|try|catch|finally|goto|new|delete|await|yield)\b/, 'keyword.flow'],

            // 方法定义
            // uint GetNumVertex()
            [/\b([a-zA-Z_$][\w$]*)\b\s+(?=[a-zA-Z_$][\w$]*\s*\()/, { token: 'type', next: '@functionAfterClass' }],

            [/\b([a-zA-Z_$][\w$]*)\s*(?=<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*\()/, 'method.name'],
            [/(\b[a-zA-Z_$][\w$]*)(?=\s*\()/, 'method.name'],
            
            // 对象属性
            [/([a-zA-Z_$][\w$]*)\s*(?=:)/, 'property'],
            
            // 函数参数 - 改进的参数识别
            [/\(\s*(?!true|false|null\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            [/,\s*(?!true|false|null\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            
            // 变量声明 - 改进的变量识别
            [/\b(@innerTypes|[a-zA-Z_$][\w$]*)\b\s+(?=[a-zA-Z_$][\w$]*\s*)/, { token: 'type', next: '@afterType' }],
            [/\b@innerTypes\b/, 'type'],
            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*<(?!<))/, { token: 'type', next: '@preTemplateType' }],
            
            // 布尔值
            [/\b(true|false)\b/, 'boolean'],
            
            // 标识符 - 捕获所有其他标识符
            [/[a-zA-Z_$][\w$]*/, 'identifier'],
            
            // 分隔符和括号
            [/[{}()\[\]]/, 'delimiter.bracket'],
            [/[<>](?!@symbols)/, 'delimiter.bracket'],
            [/@symbols/, {
                cases: {
                    '@operators': 'operator',
                    '@default': 'delimiter'
                }
            }],
            
            // 分隔符：. , ; ...
            [/[;,.]/, 'delimiter'],
            
            // 空格
            [/\s+/, 'white'],
        ],
        template: [
            [/>/, { token: 'delimiter.angle', next: '@pop' }],
            { include: 'root' }
        ],

        region: [
            [/.*$/, { token: 'comment', next: '@pop' }],
            [/./, { token: '@rematch', next: '@pop' }]
        ],
        
        // 多行注释 - 确保注释中的关键字不被识别
        comment: [
            [/[^\/*]+/, 'comment'],
            [/\*\//, 'comment', '@pop'],
            [/[\/*]/, 'comment']
        ],
        
        // 双引号字符串
        string_double: [
            [/[^\\"]+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/"/, 'string', '@pop']
        ],
        
        // 单引号字符串
        string_single: [
            [/[^\\']+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/'/, 'string', '@pop']
        ],
        
        // 反引号字符串（模板字符串）
        string_backtick: [
            [/\$\{/, { token: 'delimiter.bracket', next: '@bracketCounting' }],
            [/[^\\`$]+/, 'string'],
            [/@escapes/, 'string.escape'],
            [/\\./, 'string.escape.invalid'],
            [/`/, 'string', '@pop']
        ],
        
        // 模板字符串中的表达式
        bracketCounting: [
            [/\{/, 'delimiter.bracket', '@bracketCounting'],
            [/\}/, 'delimiter.bracket', '@pop'],
            { include: 'root' }
        ],

        // 类名识别状态
        afterClass: [
            [/\s+/, 'white'],  // 跳过空白
            [/([a-zA-Z_$][\w$]*)\b(?=\s*[a-zA-Z_$][\w$]*)/, 'keyword'],  // 识别其它
            [/[a-zA-Z_$][\w$]*/, 'class.name'],  // 识别类名
            [/</, { token: 'delimiter.angle', next: '@afterTypeTemplate' }],
            [/:/, { token: 'delimiter', next: '@classExtends' }],
            [/[{;,:=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        classExtends: [
            [/\s+/, 'white'],  // 跳过空白
            [/\bwhere\b/, { token: 'keyword', next: '@afterWhere' }],
            [/</, { token: 'delimiter.angle', next: '@afterTypeTemplate' }],
            [/[a-zA-Z_$][\w$]*\b/, 'type'],
            [/[,\.]/, 'delimiter'],
            [/[{;]/, { token: 'delimiter.bracket', next: '@root' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@root' }]  // 其他情况返回并重新匹配
        ],

        afterWhere: [
            [/\s+/, 'white'],  // 跳过空白
            [/:/, 'delimiter'],
            [/[a-zA-Z_$][\w$]*/, 'type'],  // 识别类名
            [/</, { token: 'delimiter.angle', next: '@afterTypeTemplate' }],
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterTypeTemplate: [
            [/>/, { token: 'delimiter.angle', next: '@pop' }],
            { include: 'root' }
        ],

        // 宏名识别状态
        afterMacro: [
            [/\s+/, 'white'],  // 跳过空白
            [/[\(\)]/, 'delimiter.parenthesis'],  // 括号
            [/\|\||&&/, 'operator'],  // 逻辑运算符
            [/[!~]/, 'operator'],  // 一元运算符
            [/[a-zA-Z_$][\w$]*(?=.*\b[a-zA-Z_$][\w$]*\b)/, 'macro'],  // 宏名称
            [/[a-zA-Z_$][\w$]*/, { token: 'macro', next: '@pop' }],  // 宏名称
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        functionAfter: [
            [/\s+/, 'white'],  // 跳过空白
            [/([a-zA-Z_$][\w$]*\b)/, { token: 'type', next: '@functionAfterClass' }],  // 识别类名
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        functionAfterClass: [
            [/\s+/, 'white'],  // 跳过空白
            [/::/, 'delimiter'],
            [/~\s*/, 'delimiter'],
            [/([a-zA-Z_$][\w$]*\b)/, { token: 'method.name', next: '@pop' }],  // 识别方法名
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterUsingEqual: [
            [/\s+/, 'white'],  // 跳过空白
            [/[a-zA-Z_$][\w$]*/, 'type'],
            [/[\.=]/, 'delimiter'],
            [/[{;,]/, { token: 'delimiter.bracket', next: '@root' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@root' }]  // 其他情况返回并重新匹配
        ],

        afterUsing: [
            [/\s+/, 'white'],  // 跳过空白
            [/\bstatic\b/, { token: 'keyword', next: '@afterUsingStatic' }],
            [/([a-zA-Z_$][\w$]*)(?=\s+[a-zA-Z_$][\w$]*)/, { token: 'type', next: '@afterType' }],  // var or type
            [/[a-zA-Z_$][\w$]*(?=\s*\=)/, { token: 'class.name', next: '@afterUsingEqual' }],  // 识别类名
            [/[a-zA-Z_$][\w$]*/, 'class.name'],  // 识别类名
            [/\./, 'delimiter'],
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterType: [
            [/\s+/, 'white'],  // 跳过空白
            [/[a-zA-Z_$][\w$]*/, { token: 'variable.name', next: '@root' }],  // 识别类名
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@root' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@root' }]  // 其他情况返回并重新匹配
        ],

        afterUsingStatic: [
            [/\s+/, 'white'],  // 跳过空白
            [/[a-zA-Z_$][\w$]*/, 'type'],
            [/\./, 'delimiter'],
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@root' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@root' }]  // 其他情况返回并重新匹配
        ],

        afterNameSpace: [
            [/\s+/, 'white'],  // 跳过空白
            [/\./, 'delimiter'],
            [/\b([a-zA-Z_$][\w$]*)\b/, 'class.name'],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        preTemplateType: [
            [/</, { token: 'delimiter.angle', next: '@templateType' }],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        templateType: [
            [/>(?=\s*[a-zA-Z_$][\w$]*(?!\s*\())/, { token: 'delimiter.angle', next: '@afterType' }],
            [/>/, { token: 'delimiter.angle', next: '@pop' }],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            { include: 'root' }
        ]
    }
}
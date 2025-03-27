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

            // 布尔值
            [/\b(true|false)\b/, 'boolean'],
            
            // null
            [/\bnull\b/, 'null'],
            
            // 关键字
            [/\b(this|readonly|undefined|any|string|super|extends|implements|Promise|declare|import|export|from|as|async|void|boolean|Boolean|Number|String|number|typeof|instanceof|in|of|with|get|set|constructor|static|private|protected|public)\b/, 'keyword'],

            [/\bfunction\b/, { token: 'keyword.type', next: '@afterFunction' }],
            // 类型关键字 - function, class, struct 等
            [/\b(function|class|struct|interface|enum|type|namespace)\b/, { token: 'keyword.type', next: '@afterClass' }],

            // 流程控制关键字 - if, else 等
            [/\b(if|else|for|while|do|switch|case|default|break|continue|return|throw|try|catch|finally|new|delete|await|yield)\b/, 'keyword.flow'],

            // 函数定义 - 改进的函数名识别
            [/([a-zA-Z_$][\w$]*)(?=\s*:\s*function\b)/, 'function.name'],
            [/\b(function)\b\s*([a-zA-Z_$][\w$]*)/, ['keyword.type', 'function.name']],
            
            // 方法定义 (类内部)
            [/([a-zA-Z_$][\w$]*)(?=\s*\()/, 'method.name'],

            [/\b(var|let|const)\b/, { token: 'keyword', next: '@afterVariableDeclaration' }],
            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=:|\?\s*:)/, 'variable.name'],
            
            // 对象属性
            [/([a-zA-Z_$][\w$]*)\s*(?=:)/, 'property'],
            
            // 函数参数 - 改进的参数识别
            // Match function parameters (exclude keywords)
            [/\(\s*(?!true\b|false\b|null\b|undefined\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            [/,\s*(?!true\b|false\b|null\b|undefined\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            
            // this
            [/\bthis\b/, 'variable.predefined'],
            
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
            [/[a-zA-Z_$][\w$]*/, { token: 'class.name', next: '@afterClassName' }],  // 识别类名
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
        afterExtends: [
            [/\s+/, 'white'],  // 跳过空白
            [/\bimplements\b/, { token: 'keyword', next: '@afterImplements' }], // implements
            [/[a-zA-Z_$][\w$]*/, 'type'],  // 识别基类
            [/[{;=]/, { token: 'delimiter.bracket', next: '@root' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@root' }]  // 其他情况返回并重新匹配
        ],

        afterImplements: [
            [/\s+/, 'white'],  // 跳过空白
            [/[a-zA-Z_$][\w$]*/, 'type'],  // 识别接口
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
            [/[a-zA-Z_$][\w$]*/, 'function.name'],//, log: '[definition] Entering function return value processing' }],  // 识别函数名
            [/\s+/, 'white'],  // 跳过空白
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/\(/, { token: 'delimiter.parenthesis', next: '@functionParam' }],
            [/[({;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        functionParam: [
            [/\)/, { token: 'delimiter.parenthesis', next: '@functionRet' }],
            { include: 'root' }
        ],

        functionRet: [
            [/\s+/, 'white'],  // Skip whitespace
            // Match the colon and optional whitespace
            [/:\s*([a-zA-Z_$][\w$]*)/, { token: 'type', next: '@pop' }],
            [/[({;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // Return if directly encounter {
            [/./, { token: '@rematch', next: '@pop' }]  // Other cases return and rematch
        ]
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
            [/</, { token: 'delimiter.angle', next: '@template' }],

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

            // 关键字
            [/\b(var|extern|const|constexpr|this|inline|template|typename|override|super|extends|auto|implements|signed|short|char|unsigned|long|virtual|import|export|sizeof|from|as|async|int|bool|float|double|void|typeof|instanceof|in|of|with|get|set|constructor|static|private|protected|public)\b/, 'keyword'],

            [/\b(typedef)\b/, 'keyword.flow'],

            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*class|struct\b)/, 'keyword'],

            //[/\b([a-zA-Z_$][\w$]*)\b/, { token: '@rematch', next: '@preClassCheck' }],

            // [dllexport] class [dllexport] AEFCharacterBase : public ACharacter
            //[/\b([a-zA-Z_$][\w$]*)\b\s+(?=class|struct)/, 'macro.name'],

            // 类型关键字 - class, struct 等
            [/\b(class|struct|interface|enum|union|namespace)\b/, { token: 'keyword.type', next: '@afterClass' }],

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

            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=::)/, { token: 'type', next: '@afterNameSpace' }],
            [/(?<=::)\s*\b([a-zA-Z_$][\w$]*)\b\s+(?=[a-zA-Z_$][\w$]*\s*::\s*[a-zA-Z_$][\w$]*\s*\()/, { token: 'type', next: '@functionAfter' }],
            [/(?<=::)\s*\b([a-zA-Z_$][\w$]*)\b/, { token: 'type', next: '@typeDeclare', log: '[definition] type2' }],

            // 通用类名后跟变量名的模式识别
            //[/\b([a-zA-Z_$][\w$]*)\b\s+([a-zA-Z_$][\w$]*)/, ['class.name', 'variable.name']],
            //[/\b([a-zA-Z_$][\w$]*)\b\s+([a-zA-Z_$][\w$]*)/, ['class.name', 'variable.name']],
            // 添加类型名识别规则
            //[/\b([a-zA-Z_$][\w$]*)\b\s+([a-zA-Z_$][\w$]*)/, ['class.name', 'variable.name']],
            
            // 对象属性
            [/([a-zA-Z_$][\w$]*)\s*(?=:)/, 'property'],
            
            // 函数参数 - 改进的参数识别
            [/\(\s*([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            [/,\s*([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            
            // 变量声明 - 改进的变量识别
            [/\b(var|let|const)\b\s+([a-zA-Z_$][\w$]*)/, ['keyword', 'variable.name']],
            
            // 布尔值
            [/\b(true|false)\b/, 'boolean'],
            
            // null
            [/\bnull\b/, 'null'],
            
            // this
            [/\bthis\b/, 'variable.predefined'],
            
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

        // 类名识别状态
        afterClass: [
            [/\s+/, 'white'],  // 跳过空白
            [/([a-zA-Z_$][\w$]*)\b(?=\s*[a-zA-Z_$][\w$]*)/, { token: 'keyword', next: '@afterClass'}],  // 识别其它
            [/[a-zA-Z_$][\w$]*/, 'class.name'],  // 识别类名
            [/::/, 'delimiter'],
            [/[{;,:=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        // 宏名识别状态
        afterMacro: [
            [/\s+/, 'white'],  // 跳过空白
            //[/\b*defined\b/, { token: 'keyword.directive.control', next: '@pop' }],
            [/[a-zA-Z_$][\w$]*/, { token: 'macro.name', next: '@pop' }],  // 识别类名
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
            [/\s+/, 'white'],  // 跳过空白
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

        afterNameSpace: [
            [/\s+/, 'white'],  // 跳过空白
            [/::/, 'delimiter'],
            [/([a-zA-Z_$][\w$]*)(?=::)/, 'type'],
            [/([a-zA-Z_$][\w$]*)(?=\s+[a-zA-Z_$][\w$]*)/, 'type'],
            [/([a-zA-Z_$][\w$]*)(?=\s*[{;])/, 'variable'],
            [/([a-zA-Z_$][\w$]*)/, 'variable.name'],
            [/,/, 'delimiter.bracket'],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],
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
            [/</, { token: 'delimiter.angle', next: '@template' }],

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
            [/\b(var|extern|const|constexpr|this|string|inline|override|super|extends|auto|implements|signed|short|char|unsigned|long|virtual|import|export|sizeof|from|as|async|int|bool|float|double|void|typeof|instanceof|in|of|with|get|set|constructor|static|private|protected|public)\b/, 'keyword'],

            [/\b(typedef)\b/, 'keyword.flow'],

            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*class|struct\b)/, 'keyword'],

            //[/\b([a-zA-Z_$][\w$]*)\b/, { token: '@rematch', next: '@preClassCheck' }],

            // [dllexport] class [dllexport] AEFCharacterBase : public ACharacter
            //[/\b([a-zA-Z_$][\w$]*)\b\s+(?=class|struct)/, 'macro.name'],

            // 类型关键字 - class, struct 等
            [/\b(class|struct|interface|enum|union|type|namespace)\b/, { token: 'keyword.type', next: '@afterClass' }],

            // using ()
            [/\b(using)\b(?=\s*\()/, 'keyword.type'],
            //[/\b(using)\b\s+([a-zA-Z_$][\w$]*)(?=\s*\=)/, ['keyword.type', 'class.name']],
            [/\b(using)\b/, { token: 'keyword.type', next: '@afterUsing' }],
            //[/\b(using)\b\s+([A-Za-z_][\w]*\.)*([A-Za-z_][\w]*)\s*;/, ['keyword.type', 'type', 'type']],

            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*static|const\b)/, 'keyword'],

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

            // 通用类名后跟变量名的模式识别
            //[/\b([a-zA-Z_$][\w$]*)\b\s+([a-zA-Z_$][\w$]*)/, ['class.name', 'variable.name']],
            //[/\b([a-zA-Z_$][\w$]*)\b\s+([a-zA-Z_$][\w$]*)/, ['class.name', 'variable.name']],
            // 添加类型名识别规则
            //[/\b([a-zA-Z_$][\w$]*)\b\s+([a-zA-Z_$][\w$]*)/, ['class.name', 'variable.name']],
            
            // 对象属性
            [/([a-zA-Z_$][\w$]*)\s*(?=:)/, 'property'],
            
            // 函数参数 - 改进的参数识别
            [/\(\s*([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            [/,\s*([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            
            // 变量声明 - 改进的变量识别
            [/\b([a-zA-Z_$][\w$]*)\b\s+(?=[a-zA-Z_$][\w$]*\s*[;=])/, { token: 'type', next: '@afterType' }],
            
            // 布尔值
            [/\b(true|false)\b/, 'boolean'],
            
            // null
            [/\bnull\b/, 'null'],
            
            // this
            [/\bthis\b/, 'variable.predefined'],
            
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
            [/([a-zA-Z_$][\w$]*)\b(?=\s*[a-zA-Z_$][\w$]*)/, { token: 'keyword', next: '@afterClass'}],  // 识别其它
            [/[a-zA-Z_$][\w$]*/, { token: 'class.name', next: '@pop' }],  // 识别类名
            [/[{;,:=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        // 宏名识别状态
        afterMacro: [
            [/\s+/, 'white'],  // 跳过空白
            //[/\b*defined\b/, { token: 'keyword.directive.control', next: '@pop' }],
            [/[a-zA-Z_$][\w$]*/, { token: 'macro.name', next: '@pop' }],  // 识别类名
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
            [/\s+/, 'white'],  // 跳过空白
            [/~\s*/, 'delimiter'],
            [/([a-zA-Z_$][\w$]*\b)/, { token: 'method.name', next: '@pop' }],  // 识别方法名
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterUsing: [
            [/\s+/, 'white'],  // 跳过空白
            [/\bstatic\b/, { token: 'keyword', next: '@afterUsingStatic' }],
            [/([a-zA-Z_$][\w$]*)(?=\s+[a-zA-Z_$][\w$]*)/, { token: 'type', next: '@afterType' }],  // var or type
            [/[a-zA-Z_$][\w$]*(?=\s*\=)/, { token: 'class.name', next: '@pop' }],  // 识别类名
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
    }
}
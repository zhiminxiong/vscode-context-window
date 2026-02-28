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

            [/(\bget|set\b)(?=\s*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*)?\()/, 'method.name'],

            [/\b(import|export)\b(?=\s+type\b)/, { token: 'keyword', next: '@importType' }],
            
            // 类成员变量声明 - private/public/protected + 变量名 + =
            [/\b(private|public|protected)\b(?=\s+(?:(?:static|readonly|abstract|override)\s+)*[a-zA-Z_$][\w$]*\s*\??[=:;])/, { token: 'keyword', next: '@afterAccessModifier' }],
            
            // 关键字
            [/\b(this|readonly|undefined|unknown|any|global|string|super|abstract|override|extends|implements|Promise|declare|import|export|from|async|void|boolean|Boolean|Number|String|never|number|bigint|typeof|instanceof|in|of|with|get|set|constructor|static|private|protected|public)\b/, 'keyword'],

            [/\bfunction\b/, { token: 'keyword.type', next: '@afterFunction' }],
            // 类型关键字 - function, class, struct 等
            [/\b(function|class|struct|interface|enum)\b/, { token: 'keyword.type', next: '@afterClass' }],
            [/\bnamespace\b/, { token: 'keyword.type', next: '@afterNamespace' }],
            [/\b(type)\b(?!\s*:)/, { token: 'keyword.type', next: '@afterClass' }],

            [/\bas\b/, { token: 'keyword', next: '@afterAs' }],

            // 流程控制关键字 - if, else 等
            [/\b(if|else|for|while|do|switch|case|default|break|continue|return|throw|try|catch|finally|new|await|yield)\b/, 'keyword.flow'],
            [/\bdelete\b(?!\s*\()/, 'keyword.flow'],

            // 函数定义 - 改进的函数名识别
            [/([a-zA-Z_$][\w$]*)(?=\s*:\s*function\b)/, 'function.name'],
            [/\b(function)\b\s*([a-zA-Z_$][\w$]*)/, ['keyword.type', 'function.name']],
            
            [/([a-zA-Z_$][\w$]*)(?=\s*\()/, 'method.name'],
            [/([a-zA-Z_$][\w$]*)\s*(?=<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*\()/, 'method.name'],
            [/([a-zA-Z_$][\w$]*)\s*(?=<[^<>]*(?:<[^<>]*>[^<>]*)*>)/, 'type'],

            [/\b(var|let|const)\b(?!\s*enum)(?=\s+[a-zA-Z_$][\w$]*\s*\??[=:;])/, { token: 'keyword', next: '@afterAccessModifier' }],
            [/\b(var|let|const)\b(?!\s*enum)/, { token: 'keyword', next: '@afterVariableDeclaration' }],
            [/\b(const)\b/, 'keyword'],
            [/\s+([a-zA-Z_$][\w$]*)\b\s*(?=\=\s*function)/, 'method.name'],
            // ternary: ? expr : — enter state to prevent misidentifying value as variable.name
            // exclude ?: (optional property) and ?. (optional chain)
            [/\?(?!\s*[.:]|\s*\?\s*:)/, { token: 'operator', next: '@ternaryTrue' }],
            [/([a-zA-Z_$][\w$]*)\b\s*(?=:\s*\S|\?\s*:\s*\S)/, 'variable.name'],

            [/\=>(?=\s*\b[a-zA-Z_$][\w$]*\b)/, { token: 'operator', next: '@afterArrow' }],
            [/\=>/, 'operator'],

            // ?<= may not supported
            // get() : type
            //[/(?<=\)\s*:)\s*\b([a-zA-Z_$][\w$]*)\b/, 'type'],
            [/\)\s*:(?=\s*[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*\s*[<\[])/, { token: 'delimiter', next: '@afterDelimiterTypeEx' }],
            [/\)\s*:(?=\s*\b([a-zA-Z_$][\w$]*)\b)/, { token: 'delimiter', next: '@afterDelimiterType' }],
            // : type = value;
            //[/(?<=:)\s*\b([a-zA-Z_$][\w$]*)\b(?=\s*\=)/, 'type'],
            [/:(?=\s*\b([a-zA-Z_$][\w$]*)\b\s*\=)/, { token: 'delimiter', next: '@afterDelimiterType' }],

            [/\?\s*:(?=\s*[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*\s*[|&])/, { token: 'delimiter', next: '@afterDelimiterTypeEx' }],
            [/:(?=\s*[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*\s*[|&])/, { token: 'delimiter', next: '@afterDelimiterTypeEx' }],
            // 处理冒号后跟类型名（可能包含命名空间）+ 泛型或数组的情况
            // 例如: Map<T>, CS.UnityEngine.Material[], Array<string>
            [/:(?=\s*[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*\s*[<\[])/, { token: 'delimiter', next: '@afterDelimiterTypeEx' }],

            [/\.\.\.(?=[a-zA-Z_$])/, 'operator'],
            
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
            [/\.(?=type\b)/, { token: 'delimiter', next: '@typeFix' }],
            
            // 分隔符：. , ; ...
            [/[;,.]/, 'delimiter'],

            
            // 空格
            [/\s+/, 'white'],
        ],

        importType: [
            [/\btype\b/, { token: 'keyword', next: '@pop' }],
        ],

        typeFix: [
            [/\btype\b/, { token: 'identifier', next: '@pop' }],
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

        // ternary true-branch: after ?, treat "identifier :" as plain identifier (not variable.name)
        ternaryTrue: [
            [/\s+/, 'white'],
            [/\b(this|super)\b/, 'keyword'],
            [/([a-zA-Z_$][\w$]*)\b\s*(?=\s*:)/, { token: 'identifier', next: '@pop' }],  // 找到 identifier : 退出
            [/[a-zA-Z_$][\w$]*(?=\s*\.)/, 'identifier'],                                  // 跳过 aaa. / this. 前缀
            [/\./, 'delimiter'],                                                            // 跳过点号
            [/./, { token: '@rematch', next: '@pop' }]
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

        // 入口状态：刚进入或刚过 | & 后，允许 { 进入对象类型
        afterDelimiterTypeEx: [
            [/\b(private|public|protected|constructor|class|interface|type|enum|declare|export|import|namespace|module)\b/, { token: '@rematch', next: '@pop' }],
            [/\s+/, 'white'],
            [/\|/, 'operator'],  // 联合类型，继续留在入口（后面可能还有 {）
            [/&/, 'operator'],   // 交叉类型，继续留在入口
            [/</, { token: 'delimiter.bracket', next: '@typeGeneric' }],
            [/{/, { token: 'delimiter.bracket', next: '@typeObject' }],  // : { 或 | { 进入对象类型
            [/\(/, { token: 'delimiter.bracket', next: '@typeFunctionType' }],
            [/"([^"\\]|\\.)*"/, { token: 'string', switchTo: '@afterDelimiterTypeExTail' }],
            [/'([^'\\]|\\.)*'/, { token: 'string', switchTo: '@afterDelimiterTypeExTail' }],
            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=\.)/, { token: 'type', switchTo: '@afterDelimiterTypeExTail' }],  // 命名空间类型
            [/\b([a-zA-Z_$][\w$]*)\b/, { token: 'type', switchTo: '@afterDelimiterTypeExTail' }],  // 类型名，解析完后切换到尾部状态
            [/[;,=)\]]/, { token: '@rematch', next: '@pop' }],
            [/./, { token: '@rematch', next: '@pop' }]
        ],

        // 尾部状态：已解析完一个类型名，只允许 | & [] < .，遇到 { 退出（函数体）
        afterDelimiterTypeExTail: [
            [/\b(private|public|protected|constructor|class|interface|type|enum|declare|export|import|namespace|module)\b/, { token: '@rematch', next: '@pop' }],
            [/\s+/, 'white'],
            [/\|/, { token: 'operator', switchTo: '@afterDelimiterTypeEx' }],  // | 后回到入口（允许 {）
            [/&/, { token: 'operator', switchTo: '@afterDelimiterTypeEx' }],   // & 后回到入口
            [/</, { token: 'delimiter.bracket', next: '@typeGeneric' }],
            [/\./, 'delimiter'],       // 命名空间分隔符（如 React.FC）
            [/\[\]/, 'delimiter.bracket'],  // 数组类型后缀
            [/./, { token: '@rematch', next: '@pop' }]  // { ; , ) 等都退出
        ],

        // 对象结构体类型：{ a: string, b: boolean }
        typeObject: [
            [/\s+/, 'white'],
            [/\bnew\b/, 'keyword.flow'],
            [/}/, { token: 'delimiter.bracket', next: '@pop' }],  // 对象类型结束
            [/,/, 'delimiter'],  // 属性分隔符
            [/;/, 'delimiter'],  // 属性分隔符（分号形式）
            [/\?/, 'operator'],  // 可选属性标记
            // 属性名后跟 : —— 进入类型解析
            [/([a-zA-Z_$][\w$]*)\s*(?=\s*\??\s*:)/, { token: 'variable.name', next: '@typeObjectColon' }],
            [/[a-zA-Z_$][\w$]*/, 'variable.name'],
            // 字符串字面量属性名
            [/"([^"\\]|\\.)*"/, 'string'],
            [/'([^'\\]|\\.)*'/, 'string'],
            // 嵌套对象类型
            [/{/, { token: 'delimiter.bracket', next: '@typeObject' }],
            [/./, 'delimiter'],
        ],

        // 消费属性名后的 ?: 或 : 然后进入类型解析
        typeObjectColon: [
            [/\s+/, 'white'],
            [/\?/, 'operator'],  // 可选标记
            [/:/, { token: 'delimiter', next: '@afterDelimiterTypeEx' }],  // 消费冒号，进入类型解析
            [/./, { token: '@rematch', next: '@pop' }],  // 没有冒号则退出
        ],

        // 处理泛型参数中的类型
        typeGeneric: [
            [/\s+/, 'white'],
            [/\|/, 'operator'],  // 泛型中的联合类型
            [/&/, 'operator'],  // 泛型中的交叉类型
            [/</, { token: 'delimiter.bracket', next: '@typeGeneric' }],  // 嵌套泛型
            [/>/, { token: 'delimiter.bracket', next: '@pop' }],  // 泛型结束
            [/\(/, { token: 'delimiter.bracket', next: '@typeFunctionType' }],  // 箭头函数类型
            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=\.)/, 'type'],
            [/\b([a-zA-Z_$][\w$]*)\b/, 'type'],
            [/\./, 'delimiter'],
            [/,/, 'delimiter'],  // 泛型参数分隔符
            [/\[/, 'delimiter.bracket'],  // 数组类型
            [/\]/, 'delimiter.bracket'],
            [/./, { token: '@rematch', next: '@pop' }]
        ],

        // 箭头函数类型：(param: type, ...) => returnType
        typeFunctionType: [
            [/\s+/, 'white'],
            [/\)/, { token: 'delimiter.bracket', switchTo: '@typeFunctionTypeArrow' }],  // 参数列表结束，替换自身不新增栈帧
            [/\(/, { token: 'delimiter.bracket', next: '@typeFunctionType' }],  // 嵌套括号
            [/</, { token: 'delimiter.bracket', next: '@typeGeneric' }],  // 参数中的泛型
            [/{/, { token: 'delimiter.bracket', next: '@typeObject' }],  // 参数中的对象类型
            [/[a-zA-Z_$][\w$]*\s*\??(?=\s*:)/, 'variable.parameter'],  // 参数名
            [/:/, 'delimiter'],  // 参数类型冒号
            [/,/, 'delimiter'],  // 参数分隔符
            [/\.\.\./, 'operator'],  // rest 参数
            [/\b[a-zA-Z_$][\w$]*\b/, 'type'],  // 参数类型
            [/\[\]/, 'delimiter.bracket'],
            [/\|/, 'operator'],
            [/&/, 'operator'],
            [/./, 'delimiter'],
        ],

        // 消费 ) 之后的 => 和返回类型
        typeFunctionTypeArrow: [
            [/\s+/, 'white'],
            [/=>/, { token: 'operator', switchTo: '@typeFunctionTypeReturn' }],  // 箭头：替换当前状态，不新增栈帧
            [/./, { token: '@rematch', next: '@pop' }],  // 没有 => 则退出
        ],

        // 箭头函数返回类型（识别完后 @pop 直接回到 typeFunctionType 的调用方）
        typeFunctionTypeReturn: [
            [/\s+/, 'white'],
            [/</, { token: 'delimiter.bracket', next: '@typeGeneric' }],
            [/{/, { token: 'delimiter.bracket', next: '@typeObject' }],
            [/\(/, { token: 'delimiter.bracket', next: '@typeFunctionType' }],
            [/\b[a-zA-Z_$][\w$]*\b\s*(?=\.)/, 'type'],
            [/\b[a-zA-Z_$][\w$]*\b/, { token: 'type', next: '@pop' }],  // 返回类型后退出
            [/\[\]/, 'delimiter.bracket'],
            [/./, { token: '@rematch', next: '@pop' }],
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
        afterNamespace: [
            [/\s+/, 'white'],  // 跳过空白
            [/[a-zA-Z_$][\w$]*/, 'class.name'],  // 识别命名空间名称片段
            [/\./, 'delimiter'],  // 支持 aaa.bbb.ccc 链式
            [/[{;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 遇到 { 等返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

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
            [/([a-zA-Z_$][\w$]*)(?=\s*\()/, 'method.name'],
            [/([a-zA-Z_$][\w$]*)\s*(?=<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*\()/, 'method.name'],
            [/[()]/, 'delimiter'],
            [/>/, { token: '@rematch', next: '@pop' }],  // 遇到 > 时 pop 回上层（如 afterClass 或 template）
            //[/[a-zA-Z_$][\w$]*(?=\s*>)/, { token: 'type', next: '@pop' }],  // 识别基类
            [/[a-zA-Z_$][\w$]*/, 'type'],  // 识别基类
            [/[\.|]/, 'delimiter'],
            [/\s*,/, 'delimiter.bracket'],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@root' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@root' }]  // 其他情况返回并重新匹配
        ],

        afterImplements: [
            [/\s+/, 'white'],  // 跳过空白
            [/([a-zA-Z_$][\w$]*)(?=\s*\()/, 'method.name'],
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
            [/[({;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/:/, { token: 'delimiter', next: '@afterColonType' }],  // 冒号后进入类型识别状态
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterColonType: [
            [/\s+/, 'white'],  // 跳过空白
            [/[a-zA-Z_$][\w$]*(?=\s*\.)/, 'type'],  // 识别命名空间前缀（后面跟点号）
            [/\./, 'delimiter'],  // 点号
            [/[a-zA-Z_$][\w$]*/, { token: 'type', next: '@pop' }],  // 最后的类型名，识别后返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        afterAccessModifier: [
            [/\b(private|public|protected|constructor|class|interface|type|enum|declare|export|import|namespace|module)\b/, { token: '@rematch', next: '@pop' }],
            [/\s+/, 'white'],  // 跳过空白
            [/\b(static|readonly|abstract|override)\b/, 'keyword'],  // 跳过修饰词（如 static readonly）
            [/[a-zA-Z_$][\w$]*/, 'variable.name'],  // 识别变量名
            [/[({;,=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/\??:/, { token: 'delimiter', next: '@afterDelimiterTypeEx' }],  // 冒号后进入类型识别状态（支持 ?: 可选属性）
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
            [/#\s*pragma\s+(region|endregion)$/, 'keyword.directive'],
            [/#\s*pragma\s+(region|endregion)\b/, { token: 'keyword.directive', next: '@region' }],
            [/#\s*error\b/, { token: 'keyword.directive', next: '@region' }],
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
            [/\b(extern|const|volatile|static|operator|thread_local|final|mutable|constexpr|noexcept|final|abstract|this|decltype|inline|friend|typename|explicit|nullptr|null|override|super|extends|implements|virtual|import|export|sizeof|async|typeid|private|protected|public)\b/, 'keyword'],

            [/\b(typedef)\b/, 'keyword.flow'],

            [/\b(enum)\b\s*(?=class|struct\b)/, 'keyword.type'],
            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=class|struct\b)/, 'keyword'],

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
            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*virtual)/, 'type'],
            [/\b(@innerTypes|[a-zA-Z_$][\w$]*)\b(?=\s*[\*&]*\s*[a-zA-Z_$][\w$]*<)/, 'type'],
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
            //[/([a-zA-Z_$][\w$]*)\s*(?=:)/, 'property'],
            
            // 函数参数 - 改进的参数识别
            [/\(\s*(?!true|false|null|nullptr|void\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            [/,\s*(?!true|false|null|nullptr|void\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],

            [/\}\s*(?=\b[a-zA-Z_$][\w$]*\s*;$)/, { token: 'delimiter', next: '@typedefStructName'}],
            
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

        afterType: [
            [/\s+/, 'white'],  // 跳过空白
            [/\bconst|volatile|static|thread_local|constexpr|operator|mutable\b/, 'keyword'],
            [/\b(@innerTypes|[a-zA-Z_$][\w$]*)\b(?=\s*::)/, 'type'],
            [/\b(@innerTypes|[a-zA-Z_$][\w$]*)\b(?=\s*[\*&]*\s*[a-zA-Z_$][\w$]*)/, 'type'],
            [/\b([a-zA-Z_$][\w$]*)\b(?!\s*\()/, 'variable.name'],//{ token: 'variable.name', next: '@pop' }],
            [/[\*&,]/, 'delimiter'],
            [/,/, 'delimiter.bracket'],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
        ],

        // 类名识别状态
        afterClass: [
            [/\s+/, 'white'],  // 跳过空白
            [/final\b/, 'keyword'],
            [/([a-zA-Z_$][\w$]*)\b(?=\s+final\b)/, 'class.name'],
            // (class classname *cls,)
            [/([a-zA-Z_$][\w$]*)\b(?=\s*[\*&]*\s*[a-zA-Z_$][\w$]*\s*[,\)])/, { token: 'keyword', next: '@afterType' }],
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
            [/::/, 'delimiter'],
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

        typedefStructName: [
            [/\s+/, 'white'],  // 跳过空白
            [/([a-zA-Z_$][\w$]*)/, 'class.name'],
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
            [/\b(extern|const|readonly|volatile|sealed|constexpr|this|null|inline|global|abstract|partial|override|super|extends|auto|implements|virtual|import|export|sizeof|from|as|ref|async|typeof|instanceof|in|out|of|with|get|set|constructor|static|private|protected|public|internal)\b/, 'keyword'],

            [/\b(typedef)\b/, 'keyword.flow'],

            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*class|struct\b)/, 'keyword'],

            // 类型关键字 - class, struct 等
            [/\b(class|struct|interface|enum|union|type)\b/, { token: 'keyword.type', next: '@afterClass' }],
            [/\bnamespace\b/, { token: 'keyword.type', next: '@afterNameSpace' }],

            // using ()
            [/\b(using)\b(?=\s*\()/, 'keyword.type'],
            [/\b(using)\b/, { token: 'keyword.type', next: '@afterUsing' }],

            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*static|const\b)/, 'keyword'],

            [/\bwhere\b/, { token: 'keyword', next: '@afterWhere' }],

            // 流程控制关键字 - if, else 等
            [/\b(if|else|for|while|do|switch|case|default|break|continue|return|throw|try|catch|finally|goto|new|delete|await|yield)\b/, 'keyword.flow'],

            // 方法定义
            // uint GetNumVertex()
            [/\b([a-zA-Z_$][\w$]*)\b\s+(?=[a-zA-Z_$][\w$]*\s*\()/, { token: 'type', next: '@functionAfterClass' }],

            //[/\b([a-zA-Z_$][\w$]*)\s*(?=<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*\()/, 'method.name'],
            [/(\b[a-zA-Z_$][\w$]*)(?=\s*\()/, 'method.name'],
            [/([a-zA-Z_$][\w$]*)\s*(?=<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>\s*\()/, 'method.name'],
            
            // 对象属性
            [/([a-zA-Z_$][\w$]*)\s*(?=:)/, 'property'],
            
            // 函数参数 - 改进的参数识别
            [/\(\s*(?!true|false|null\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            [/,\s*(?!true|false|null\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            
            // 变量声明 - 改进的变量识别
            [/\b(@innerTypes|[a-zA-Z_$][\w$]*)\b\s+(?=[a-zA-Z_$][\w$]*\s*<)/, 'type'],
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

export const languageConfig_go = {
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

    innerTypes: /\bauto|signed|short|char|unsigned|long|int|bool|float|double|void|string|map\b/,
    
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
            [/\bnil\b/, 'null'],

            // test
            //[/(?<!int)\s*(dddata)/, { token: 'keyword.flow', log: console.log('[definition] 1')}],
            //[/int2/, { token: 'keyword.flow', log: console.log('[definition] 2')}],

            [/(\bget|set\b)(?=\s*\()/, 'method.name'],
            
            // 关键字
            [/\b(this|readonly|undefined|unknown|any|global|string|int|map|super|abstract|extends|implements|Promise|declare|import|export|from|async|void|boolean|Boolean|Number|String|number|typeof|instanceof|in|of|with|get|set|constructor|static|private|protected|public|package)\b/, 'keyword'],

            [/\bfunc\b/, { token: 'keyword.type', next: '@afterFunction' }],
            // 类型关键字 - function, class, struct 等
            [/\b(func|class|struct|interface|enum|namespace)\b/, { token: 'keyword.type', next: '@afterClass' }],
            [/\b(type)\b(?!\s*:)/, { token: 'keyword.type', next: '@afterClass' }],

            [/\bas\b/, { token: 'keyword', next: '@afterAs' }],

            // 流程控制关键字 - if, else 等
            [/\b(if|else|for|while|do|switch|case|default|break|continue|return|throw|range|try|catch|finally|new|delete|await|yield)\b/, 'keyword.flow'],

            // 函数定义 - 改进的函数名识别
            [/([a-zA-Z_$][\w$]*)(?=\s*:\s*func\b)/, 'function.name'],
            [/\b(func)\b\s*([a-zA-Z_$][\w$]*)/, ['keyword.type', 'function.name']],
            
            [/(\b[a-zA-Z_$][\w$]*)(?=\s*\()/, 'method.name'],
            [/([a-zA-Z_$][\w$]*)\s*(?=<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*\()/, 'method.name'],
            [/([a-zA-Z_$][\w$]*)\s*(?=<[^<>]*(?:<[^<>]*>[^<>]*)*>)/, 'type'],

            [/\b(var|let|const)\b/, { token: 'keyword', next: '@afterVariableDeclaration' }],
            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=\=\s*function)/, 'method.name'],
            [/\b([a-zA-Z_$][\w$]*)\b(?=(\s*,\s*[a-zA-Z_$][\w$]*)*\s*:|\?\s*:)/, 'variable.name'],
            [/\b([a-zA-Z_$][\w$]*)\b\s*(?=:|\?\s*:)/, 'variable.name'],

            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*(\.\.\.\s*)?(\[\s*\]\s*)?\**\s*(@innerTypes|[a-zA-Z_$][\w$]*))/, { token: 'variable.name', next: '@postVariableType' }],
            [/\b@innerTypes\b/, 'type'],

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
            [/\(\s*(?!true|false|nil|undefined|unknown\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            [/,\s*(?!true|false|nil|undefined|unknown\b)([a-zA-Z_$][\w$]*)\s*(?=[,)])/, 'variable.parameter'],
            
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
            [/.(?=type)/, { token: 'delimiter', next: '@typeFix' }],
            
            // 分隔符：. , ; ...
            [/[;,.]/, 'delimiter'],
            
            // 空格
            [/\s+/, 'white'],
        ],

        typeFix: [
            [/type/, { token: 'identifier', next: '@pop' }],
        ],

        template: [
            [/>/, { token: 'delimiter.angle', next: '@pop' }],
            { include: 'root' }
        ],

        postVariableType: [
            [/\s+/, 'white'],  // 跳过空白
            [/\.\.\./, 'delimiter'],
            [/\[\s*\]/, 'delimiter'],
            [/\b(@innerTypes|[a-zA-Z_$][\w$]*)\b/, { token: 'type', next: '@pop' }],
            [/[\*&,]/, 'delimiter'],
            [/,/, 'delimiter.bracket'],
            [/[{;=]/, { token: 'delimiter.bracket', next: '@pop' }],  // 如果直接遇到 { 则返回
            [/./, { token: '@rematch', next: '@pop' }]  // 其他情况返回并重新匹配
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
            [/struct/, 'keyword.type'],
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
            //[/[a-zA-Z_$][\w$]*(?=\s*>)/, { token: 'type', next: '@pop' }],  // 识别基类
            [/[a-zA-Z_$][\w$]*/, 'type'],  // 识别基类
            [/[\.|]/, 'delimiter'],
            [/\s*,/, 'delimiter.bracket'],
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
            [/\b([a-zA-Z_$][\w$]*)\b(?=\s*(\.\.\.\s*)?(\[\s*\]\s*)?\**\s*(@innerTypes|[a-zA-Z_$][\w$]*))/, { token: 'variable.name', next: '@postVariableType' }],
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

// Document Symbol Provider 用于支持 Sticky Scroll
// 正确处理嵌套花括号和换行花括号的情况
export function createDocumentSymbolProvider(monaco) {
    return {
        provideDocumentSymbols: (model) => {
            const symbols = [];
            const text = model.getValue();
            const lines = text.split('\n');
            const languageId = model.getLanguageId();
            
            // 控制流关键字集合（用于过滤）
            const controlFlowKeywords = new Set([
                'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
                'try', 'catch', 'finally', 'throw', 'return', 'break', 'continue',
                'goto', 'sizeof', 'typeof', 'delete', 'new'
            ]);
            
            // 定义不同语言的符号识别模式
            const patterns = {
                cpp: [
                    // 命名空间
                    { 
                        regex: /^\s*namespace\s+([\w:]+)\s*(?:\{|$)/, 
                        kind: monaco.languages.SymbolKind.Namespace,
                        nameGroup: 1
                    },
                    // 类/结构体/枚举
                    { 
                        regex: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union|interface|enum(?:\s+(?:class|struct))?)\s+([\w:]+)/, 
                        kind: monaco.languages.SymbolKind.Class,
                        nameGroup: 1
                    },
                    // 带类作用域的函数（如 Ball::init, EffectBuffer &EffectBuffer::get, static void __fastcall Ball::normalize）
                    // 匹配：[修饰符/调用约定]* [返回类型]? [修饰符/调用约定]* [类::函数名]
                    { 
                        regex: /^\s*(?:(?:virtual|static|inline|explicit|constexpr|friend|__\w+|WINAPI|CALLBACK|APIENTRY|STDCALL|CDECL)\s+)*(?:[\w:]+(?:<[^>]*>)?\s*[*&]*\s*)?(?:(?:__\w+|WINAPI|CALLBACK|APIENTRY|STDCALL|CDECL)\s+)?(\w+::[~\w]+)\s*\(/, 
                        kind: monaco.languages.SymbolKind.Function,
                        nameGroup: 1
                    },
                    // 带修饰符的函数（如 virtual void init, static __forceinline void rotateZ, __forceinline int getValue）
                    // 匹配：[修饰符/调用约定]+ [返回类型]? [修饰符/调用约定]* [函数名]
                    { 
                        regex: /^\s*(?:(?:virtual|static|inline|explicit|constexpr|friend|__\w+|WINAPI|CALLBACK|APIENTRY|STDCALL|CDECL)\s+)+(?:[\w:]+(?:<[^>]*>)?\s*[*&]*\s*)?(?:(?:__\w+|WINAPI|CALLBACK|APIENTRY|STDCALL|CDECL)\s+)?([\w~]+)\s*\(/, 
                        kind: monaco.languages.SymbolKind.Function,
                        nameGroup: 1
                    },
                    // 带指针/引用返回类型的函数（如 int* getValue, const char& getName）
                    { 
                        regex: /^\s*(?:const\s+)?[\w:]+(?:<[^>]*>)?\s*([*&]+)\s*([\w~]+)\s*\(/, 
                        kind: monaco.languages.SymbolKind.Function,
                        nameGroup: 2
                    },
                    // 带返回类型的函数（返回类型必须是大写开头或包含下划线，如 HRESULT, D3D11_TEXTURE2D）
                    { 
                        regex: /^\s*([A-Z][A-Z0-9_]*(?:<[^>]*>)?)\s+([*&]*)\s*([\w~]+)\s*\(/, 
                        kind: monaco.languages.SymbolKind.Function,
                        nameGroup: 3
                    },
                    // 带常见返回类型的函数（void, int, bool, char, float, double, long, short, auto）
                    { 
                        regex: /^\s*(void|int|bool|char|float|double|long|short|auto|size_t|uint|uint32_t|uint64_t|int32_t|int64_t)\s+([*&]*)\s*([\w~]+)\s*\(/, 
                        kind: monaco.languages.SymbolKind.Function,
                        nameGroup: 3
                    }
                ],
                csharp: [
                    // 命名空间
                    { 
                        regex: /^\s*namespace\s+([\w.]+)\s*(?:\{|$)/, 
                        kind: monaco.languages.SymbolKind.Namespace,
                        nameGroup: 1
                    },
                    // 类/接口/结构体/枚举/记录
                    { 
                        regex: /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|interface|struct|enum|record)\s+([\w<>]+)/, 
                        kind: monaco.languages.SymbolKind.Class,
                        nameGroup: 1
                    },
                    // 方法
                    { 
                        regex: /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new)\s+)*(?:[\w<>[\]?]+\s+)?([\w]+)\s*(?:<[^>]*>)?\s*\(/, 
                        kind: monaco.languages.SymbolKind.Method,
                        nameGroup: 1
                    },
                    // 属性
                    { 
                        regex: /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract)\s+)*(?:[\w<>[\]?]+\s+)([\w]+)\s*\{\s*(?:get|set)/, 
                        kind: monaco.languages.SymbolKind.Property,
                        nameGroup: 1
                    }
                ],
                c: [
                    // 结构体/枚举/联合体
                    { 
                        regex: /^\s*(?:typedef\s+)?(?:struct|union|enum|interface)\s+([\w]+)(?:\s*\{|$)/, 
                        kind: monaco.languages.SymbolKind.Struct,
                        nameGroup: 1
                    },
                    // 函数
                    { 
                        regex: /^\s*(?:static|inline|extern)?\s*(?:[\w]+(?:\s*\*)*\s+)?([\w]+)\s*\([^)]*\)\s*(?:\{|$)/, 
                        kind: monaco.languages.SymbolKind.Function,
                        nameGroup: 1
                    }
                ]
            };
            
            // 获取当前语言的模式
            let activePatterns = [];
            if (languageId === 'cpp') {
                activePatterns = patterns.cpp;
            } else if (languageId === 'csharp') {
                activePatterns = patterns.csharp;
            } else if (languageId === 'c') {
                activePatterns = patterns.c;
            }
            
            if (activePatterns.length === 0) {
                return symbols;
            }
            
            // 符号栈：用于跟踪嵌套的符号
            const symbolStack = [];
            // 等待花括号的符号
            let pendingSymbol = null;
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const lineNumber = i + 1;
                const trimmedLine = line.trim();
                
                // 跳过注释行
                if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*')) {
                    continue;
                }
                
                // 标记：这一行是否创建了新符号（避免重复计数花括号）
                let symbolCreatedOnThisLine = false;
                
                // 如果没有等待的符号，尝试匹配新符号
                if (!pendingSymbol) {
                    for (const pattern of activePatterns) {
                        const match = line.match(pattern.regex);
                        if (match) {
                            const name = match[pattern.nameGroup];
                            
                            // 过滤控制流关键字（仅对函数/方法模式）
                            if (pattern.kind === monaco.languages.SymbolKind.Function || 
                                pattern.kind === monaco.languages.SymbolKind.Method) {
                                // 提取函数名（去掉类作用域前缀，如 Ball::init -> init）
                                const functionName = name.includes('::') ? name.split('::').pop() : name;
                                // 如果是控制流关键字，跳过
                                if (controlFlowKeywords.has(functionName.trim())) {
                                    continue;
                                }
                            }
                            
                            const hasOpenBrace = line.includes('{');
                            const hasSemicolon = line.includes(';');
                            
                            // 如果有分号但没有花括号，说明是函数声明而不是定义，跳过
                            if (hasSemicolon && !hasOpenBrace) {
                                continue;
                            }
                            
                            if (hasOpenBrace) {
                                // 同一行有花括号，创建符号并入栈
                                const symbol = {
                                    name: name,
                                    kind: pattern.kind,
                                    range: new monaco.Range(lineNumber, 1, lineNumber, 1),
                                    selectionRange: new monaco.Range(lineNumber, 1, lineNumber, line.length + 1),
                                    children: []
                                };
                                
                                // 添加到父符号或根列表
                                if (symbolStack.length > 0) {
                                    symbolStack[symbolStack.length - 1].symbol.children.push(symbol);
                                } else {
                                    symbols.push(symbol);
                                }
                                
                                // 计算这行的花括号数量
                                const openCount = (line.match(/\{/g) || []).length;
                                const closeCount = (line.match(/\}/g) || []).length;
                                const netBraces = openCount - closeCount;
                                
                                // 只有当净增加花括号时才入栈
                                if (netBraces > 0) {
                                    symbolStack.push({
                                        symbol: symbol,
                                        startLine: lineNumber,
                                        braceLevel: netBraces  // 直接使用净花括号数
                                    });
                                } else if (netBraces === 0) {
                                    // 单行函数/类，直接设置结束位置
                                    symbol.range = new monaco.Range(lineNumber, 1, lineNumber, line.length + 1);
                                }
                                
                                symbolCreatedOnThisLine = true;
                            } else {
                                // 没有花括号，等待下一行
                                pendingSymbol = {
                                    name: name,
                                    kind: pattern.kind,
                                    startLine: lineNumber
                                };
                            }
                            break;
                        }
                    }
                } else {
                    // 检查等待的符号是否找到了开括号或分号
                    if (line.includes(';')) {
                        // 遇到分号，说明这是函数声明而不是定义，放弃这个符号
                        pendingSymbol = null;
                    } else if (line.includes('{')) {
                        const symbol = {
                            name: pendingSymbol.name,
                            kind: pendingSymbol.kind,
                            range: new monaco.Range(pendingSymbol.startLine, 1, lineNumber, 1),
                            selectionRange: new monaco.Range(pendingSymbol.startLine, 1, pendingSymbol.startLine, lines[pendingSymbol.startLine - 1].length + 1),
                            children: []
                        };
                        
                        // 添加到父符号或根列表
                        if (symbolStack.length > 0) {
                            symbolStack[symbolStack.length - 1].symbol.children.push(symbol);
                        } else {
                            symbols.push(symbol);
                        }
                        
                        // 计算这行的花括号数量
                        const openCount = (line.match(/\{/g) || []).length;
                        const closeCount = (line.match(/\}/g) || []).length;
                        const netBraces = openCount - closeCount;
                        
                        // 只有当净增加花括号时才入栈
                        if (netBraces > 0) {
                            symbolStack.push({
                                symbol: symbol,
                                startLine: pendingSymbol.startLine,
                                braceLevel: netBraces  // 直接使用净花括号数
                            });
                        } else if (netBraces === 0) {
                            // 单行函数/类
                            symbol.range = new monaco.Range(pendingSymbol.startLine, 1, lineNumber, line.length + 1);
                        }
                        
                        pendingSymbol = null;
                        symbolCreatedOnThisLine = true;
                    }
                }
                
                // 处理花括号以更新符号范围（但跳过刚创建符号的行，避免重复计数）
                if (symbolStack.length > 0 && !symbolCreatedOnThisLine) {
                    const openCount = (line.match(/\{/g) || []).length;
                    const closeCount = (line.match(/\}/g) || []).length;
                    
                    // 更新栈顶符号的花括号层级
                    symbolStack[symbolStack.length - 1].braceLevel += openCount;
                    symbolStack[symbolStack.length - 1].braceLevel -= closeCount;
                    
                    // 处理闭括号 - 可能需要弹出多个符号
                    while (symbolStack.length > 0 && symbolStack[symbolStack.length - 1].braceLevel === 0) {
                        const item = symbolStack.pop();
                        item.symbol.range = new monaco.Range(
                            item.startLine,
                            1,
                            lineNumber,
                            line.length + 1
                        );
                    }
                }
            }
            
            // 处理未闭合的符号（设置到文件末尾）
            while (symbolStack.length > 0) {
                const item = symbolStack.pop();
                item.symbol.range = new monaco.Range(
                    item.startLine,
                    1,
                    lines.length,
                    lines[lines.length - 1].length + 1
                );
            }
            
            return symbols;
        }
    };
}
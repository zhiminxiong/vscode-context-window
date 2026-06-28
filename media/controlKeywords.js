//@ts-check

// 把「控制流关键字」从通用 keyword 中拆出来单独着色，对齐 VSCode 的 keyword.control(.conditional)。
//
// 背景：Monaco 内置 Monarch 把一门语言的所有关键字统一标成 `keyword`，于是 if/else（VSCode 里是
// keyword.control.conditional，常为红色）与 const/class（storage，常为蓝色）在上下文窗口里只能共用
// 一个颜色。当前 monaco-editor 是打包版（各语言 Monarch 按需懒加载，无公开 API 反查已注册的语法）。
//
// 方案：
//   1) installControlKeywordPatch —— 劫持 monaco.languages.setMonarchTokensProvider，
//      任何语言注册 Monarch 时自动注入控制流分类（只对该语言真实存在的关键字生效）。通用、覆盖所有语言。
//   2) patchControlKeywords —— 内嵌一份 TS Monarch 兜底覆盖 typescript/javascript，
//      以防 TS 语法在劫持安装之前就已加载。

// 关键字细分桶：把 Monaco 统一的 `keyword` 拆成对齐 TextMate 的多种 scope，便于分别配色。
// 每个桶：scope（发出的 token 类型，= TextMate scope）、prop（挂到 language 上的关键字数组属性名）、
// words（跨语言英文关键字，最终与各语言自身 keywords 取交集，不会误伤同名标识符）。
// 顺序即匹配优先级；各桶词表互斥。
const KEYWORD_BUCKETS = [
    { scope: 'keyword.control.conditional', prop: 'ctxKwConditional', words: ['if', 'elif', 'elseif', 'else', 'switch', 'case', 'default', 'when', 'unless', 'match', 'cond', 'guard'] },
    { scope: 'keyword.control.loop', prop: 'ctxKwLoop', words: ['for', 'foreach', 'while', 'do', 'loop', 'repeat', 'until', 'each'] },
    { scope: 'keyword.control.trycatch', prop: 'ctxKwTry', words: ['try', 'catch', 'finally', 'except', 'raise', 'ensure', 'rescue', 'throw', 'throws'] },
    { scope: 'keyword.control.flow', prop: 'ctxKwFlow', words: ['return', 'yield', 'await', 'break', 'continue', 'goto', 'fallthrough', 'defer', 'pass'] },
    { scope: 'keyword.control.import', prop: 'ctxKwImport', words: ['import', 'export', 'from', 'using', 'include', 'require', 'use'] },
    { scope: 'keyword.operator.expression', prop: 'ctxKwOp', words: ['new', 'typeof', 'instanceof', 'delete', 'void', 'sizeof', 'in', 'of'] },
    // storage.type 按具体关键字再细分（对齐 VSCode 的 storage.type.class / storage.type.enum 等）
    { scope: 'storage.type.class', prop: 'ctxStClass', words: ['class'] },
    { scope: 'storage.type.enum', prop: 'ctxStEnum', words: ['enum'] },
    { scope: 'storage.type.struct', prop: 'ctxStStruct', words: ['struct'] },
    { scope: 'storage.type.interface', prop: 'ctxStInterface', words: ['interface'] },
    { scope: 'storage.type.function', prop: 'ctxStFunction', words: ['function', 'func', 'fn', 'def'] },
    { scope: 'storage.type.namespace', prop: 'ctxStNamespace', words: ['namespace', 'module'] },
    { scope: 'storage.type', prop: 'ctxStorageType', words: ['const', 'let', 'var', 'val', 'type', 'trait', 'impl', 'record', 'constructor', 'union', 'template'] },
    { scope: 'storage.modifier', prop: 'ctxStorageMod', words: ['public', 'private', 'protected', 'readonly', 'static', 'abstract', 'final', 'virtual', 'override', 'async', 'declare', 'extern', 'inline', 'unsafe', 'mutable', 'volatile', 'sealed', 'partial', 'internal', 'synchronized', 'transient', 'native', 'register', 'friend', 'explicit', 'constexpr'] },
    { scope: 'constant.language', prop: 'ctxConstLang', words: ['true', 'false', 'null', 'nil', 'none', 'undefined', 'nan'] },
    { scope: 'variable.language', prop: 'ctxVarLang', words: ['this', 'self', 'super', 'base'] },
];

const INJECTED_FLAG = '__ctxControlKwInjected';

// 往一个 Monarch language 定义里注入关键字细分：在映射 @keywords 的规则前，按桶顺序插入
// @<prop> -> <scope> 的 case。仅对该语言真实存在的关键字生效。
function injectIntoLanguage(language) {
    try {
        if (!language || typeof language !== 'object' || !language.tokenizer) { return language; }
        if (language[INJECTED_FLAG]) { return language; }
        const langKeywords = Array.isArray(language.keywords) ? language.keywords : null;
        if (!langKeywords) { return language; } // 无关键字表则不处理，避免误判
        const inLang = (k) => langKeywords.indexOf(k) >= 0;

        // 计算每个桶在该语言下实际命中的关键字
        const active = [];
        for (const b of KEYWORD_BUCKETS) {
            const words = b.words.filter(inLang);
            if (words.length) { active.push({ ...b, words }); }
        }
        if (!active.length) { return language; }

        let injected = false;
        for (const state of Object.keys(language.tokenizer)) {
            const rules = language.tokenizer[state];
            if (!Array.isArray(rules)) { continue; }
            for (const rule of rules) {
                const action = Array.isArray(rule) ? rule[1] : (rule && rule.action);
                if (
                    action && action.cases &&
                    Object.prototype.hasOwnProperty.call(action.cases, '@keywords') &&
                    !active.some(b => Object.prototype.hasOwnProperty.call(action.cases, '@' + b.prop))
                ) {
                    const newCases = {};
                    for (const b of active) { newCases['@' + b.prop] = b.scope; }
                    for (const k of Object.keys(action.cases)) { newCases[k] = action.cases[k]; }
                    action.cases = newCases;
                    injected = true;
                }
            }
        }
        if (injected) {
            for (const b of active) { language[b.prop] = b.words; }
            try { Object.defineProperty(language, INJECTED_FLAG, { value: true, enumerable: false }); }
            catch (_) { language[INJECTED_FLAG] = true; }
        }
        return language;
    } catch (e) {
        console.warn('[context-window] inject control keywords failed:', e);
        return language;
    }
}

// 处理「language 可能是 Promise/Thenable」的情况（打包版懒加载常以异步形式提供）。
function maybeInject(language) {
    if (language && typeof language.then === 'function') {
        return language.then((lang) => injectIntoLanguage(lang));
    }
    return injectIntoLanguage(language);
}

// 劫持 setMonarchTokensProvider：之后任何语言注册 Monarch 都会被自动注入控制流分类。
// 应在编辑器/任何模型创建之前尽早调用。
export function installControlKeywordPatch(monaco) {
    try {
        const langsApi = monaco && monaco.languages;
        if (!langsApi || typeof langsApi.setMonarchTokensProvider !== 'function') { return; }
        if (langsApi.__ctxControlKwPatched) { return; }
        const original = langsApi.setMonarchTokensProvider.bind(langsApi);
        langsApi.setMonarchTokensProvider = function (languageId, language) {
            return original(languageId, maybeInject(language));
        };
        langsApi.__ctxControlKwPatched = true;
    } catch (e) {
        console.warn('[context-window] install control keyword patch failed:', e);
    }
}

// 照搬自 monaco-editor 的 TypeScript Monarch（仅 language 对象），用作 TS/JS 的兜底覆盖。
function buildTsLanguage() {
    return {
        defaultToken: 'invalid',
        tokenPostfix: '.ts',
        keywords: [
            'abstract', 'any', 'as', 'asserts', 'bigint', 'boolean', 'break', 'case', 'catch', 'class',
            'continue', 'const', 'constructor', 'debugger', 'declare', 'default', 'delete', 'do', 'else',
            'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if',
            'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let', 'module',
            'namespace', 'never', 'new', 'null', 'number', 'object', 'out', 'package', 'private', 'protected',
            'public', 'override', 'readonly', 'require', 'global', 'return', 'satisfies', 'set', 'static',
            'string', 'super', 'switch', 'symbol', 'this', 'throw', 'true', 'try', 'type', 'typeof',
            'undefined', 'unique', 'unknown', 'var', 'void', 'while', 'with', 'yield', 'async', 'await', 'of',
        ],
        operators: [
            '<=', '>=', '==', '!=', '===', '!==', '=>', '+', '-', '**', '*', '/', '%', '++', '--', '<<',
            '</', '>>', '>>>', '&', '|', '^', '!', '~', '&&', '||', '??', '?', ':', '=', '+=', '-=', '*=',
            '**=', '/=', '%=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '@',
        ],
        symbols: /[=><!~?:&|+\-*\/\^%]+/,
        escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
        digits: /\d+(_+\d+)*/,
        octaldigits: /[0-7]+(_+[0-7]+)*/,
        binarydigits: /[0-1]+(_+[0-1]+)*/,
        hexdigits: /[[0-9a-fA-F]+(_+[0-9a-fA-F]+)*/,
        regexpctl: /[(){}\[\]\$\^|\-*+?\.]/,
        regexpesc: /\\(?:[bBdDfnrstvwWn0\\\/]|@regexpctl|c[A-Z]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/,
        tokenizer: {
            root: [[/[{}]/, 'delimiter.bracket'], { include: 'common' }],
            common: [
                [/#?[a-z_$][\w$]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
                [/[A-Z][\w\$]*/, 'type.identifier'],
                { include: '@whitespace' },
                [
                    /\/(?=([^\\\/]|\\.)+\/([dgimsuy]*)(\s*)(\.|;|,|\)|\]|\}|$))/,
                    { token: 'regexp', bracket: '@open', next: '@regexp' },
                ],
                [/[()\[\]]/, '@brackets'],
                [/[<>](?!@symbols)/, '@brackets'],
                [/!(?=([^=]|$))/, 'delimiter'],
                [/@symbols/, { cases: { '@operators': 'delimiter', '@default': '' } }],
                [/(@digits)[eE]([\-+]?(@digits))?/, 'number.float'],
                [/(@digits)\.(@digits)([eE][\-+]?(@digits))?/, 'number.float'],
                [/0[xX](@hexdigits)n?/, 'number.hex'],
                [/0[oO]?(@octaldigits)n?/, 'number.octal'],
                [/0[bB](@binarydigits)n?/, 'number.binary'],
                [/(@digits)n?/, 'number'],
                [/[;,.]/, 'delimiter'],
                [/"([^"\\]|\\.)*$/, 'string.invalid'],
                [/'([^'\\]|\\.)*$/, 'string.invalid'],
                [/"/, 'string', '@string_double'],
                [/'/, 'string', '@string_single'],
                [/`/, 'string', '@string_backtick'],
            ],
            whitespace: [
                [/[ \t\r\n]+/, ''],
                [/\/\*\*(?!\/)/, 'comment.doc', '@jsdoc'],
                [/\/\*/, 'comment', '@comment'],
                [/\/\/.*$/, 'comment'],
            ],
            comment: [
                [/[^\/*]+/, 'comment'],
                [/\*\//, 'comment', '@pop'],
                [/[\/*]/, 'comment'],
            ],
            jsdoc: [
                [/[^\/*]+/, 'comment.doc'],
                [/\*\//, 'comment.doc', '@pop'],
                [/[\/*]/, 'comment.doc'],
            ],
            regexp: [
                [/(\{)(\d+(?:,\d*)?)(\})/, ['regexp.escape.control', 'regexp.escape.control', 'regexp.escape.control']],
                [/(\[)(\^?)(?=(?:[^\]\\\/]|\\.)+)/, ['regexp.escape.control', { token: 'regexp.escape.control', next: '@regexrange' }]],
                [/(\()(\?:|\?=|\?!)/, ['regexp.escape.control', 'regexp.escape.control']],
                [/[()]/, 'regexp.escape.control'],
                [/@regexpctl/, 'regexp.escape.control'],
                [/[^\\\/]/, 'regexp'],
                [/@regexpesc/, 'regexp.escape'],
                [/\\\./, 'regexp.invalid'],
                [/(\/)([dgimsuy]*)/, [{ token: 'regexp', bracket: '@close', next: '@pop' }, 'keyword.other']],
            ],
            regexrange: [
                [/-/, 'regexp.escape.control'],
                [/\^/, 'regexp.invalid'],
                [/@regexpesc/, 'regexp.escape'],
                [/[^\]]/, 'regexp'],
                [/\]/, { token: 'regexp.escape.control', next: '@pop', bracket: '@close' }],
            ],
            string_double: [
                [/[^\\"]+/, 'string'],
                [/@escapes/, 'string.escape'],
                [/\\./, 'string.escape.invalid'],
                [/"/, 'string', '@pop'],
            ],
            string_single: [
                [/[^\\']+/, 'string'],
                [/@escapes/, 'string.escape'],
                [/\\./, 'string.escape.invalid'],
                [/'/, 'string', '@pop'],
            ],
            string_backtick: [
                [/\$\{/, { token: 'delimiter.bracket', next: '@bracketCounting' }],
                [/[^\\`$]+/, 'string'],
                [/@escapes/, 'string.escape'],
                [/\\./, 'string.escape.invalid'],
                [/`/, 'string', '@pop'],
            ],
            bracketCounting: [
                [/\{/, 'delimiter.bracket', '@bracketCounting'],
                [/\}/, 'delimiter.bracket', '@pop'],
                { include: 'common' },
            ],
        },
    };
}

// 兜底：显式覆盖 typescript / javascript（经劫持后的 setMonarchTokensProvider 会自动注入控制流分类）。
// 立即 + 延迟多次应用，以覆盖打包版可能稍后异步注册的默认 Monarch。
export function patchControlKeywords(monaco, languages) {
    const supported = ['typescript', 'javascript'];
    const targets = (languages || supported).filter(l => supported.includes(l));
    if (!targets.length) { return; }
    const apply = () => {
        for (const id of targets) {
            try {
                monaco.languages.setMonarchTokensProvider(id, buildTsLanguage());
            } catch (e) {
                console.warn('[context-window] setMonarchTokensProvider failed for', id, e);
            }
        }
    };
    apply();
    setTimeout(apply, 0);
    setTimeout(apply, 800);
}

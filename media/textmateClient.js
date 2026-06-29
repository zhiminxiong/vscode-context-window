//@ts-check

// 方案 B 前端编排：用真实 TextMate 语法（从用户已装语言扩展收割）为基础语法层着色。
//
// 链路：
//   1) 动态 import 打包好的 textmate.bundle.js（仅在启用时拉取，避免无谓体积）；
//   2) fetch oniguruma 的 onig.wasm 并加载，得到正则引擎；
//   3) 创建 vscode-textmate Registry，其 loadGrammar 通过 postMessage 向扩展端按需索取语法文件原始内容；
//   4) 对每种语言，loadGrammar(scope) 完成后用 monaco.languages.setTokensProvider 接管该语言的分词，
//      把 Monaco 内置 Monarch 换成真实 TextMate 分词；
//   5) 每个 token 取其 scope 栈中「当前主题能着色（命中主题规则前缀）的最深 scope」交给 Monaco，
//      Monaco 主题 trie 据此着色——与 VSCode 的基础语法层高度一致。语义层（标识符精确分类）继续叠加在其上。

let _registry = null;
let _INITIAL = null;
let _parseRawGrammar = null;
let _monaco = null;
let _vscode = null;
let _enabled = false;

let _languageToScope = {};
let _injections = {};

let _themeScopeSet = new Set();

const _grammarByLang = new Map();      // languageId -> grammar
const _pendingByLang = new Map();      // languageId -> Promise<grammar|null>
const _registeredLang = new Set();     // 已 setTokensProvider 的语言
const _grammarWaiters = new Map();     // scopeName -> { resolve, promise }

// ===== 主题 scope 集合：用于挑选「主题能着色的最深 scope」=====
// 重建可着色 scope 集合：纳入「主题全部 tokenColors」+「用户自定义规则（右键取色保存的）」。
// 把用户自定义规则也算进来，使用户为某个深层 scope（如 storage.type.struct.cpp）配色后，
// 渲染端的 pickScope 也会优先挑中该 scope，做到「弹窗所见 === 编辑器所染」。
// 主题切换 / 自定义规则变更时由 main.js 调用（无需传参，直接读最新配置）。
export function updateThemeScopes() {
    const cfg = window.vsCodeEditorConfiguration || {};
    const set = new Set();
    const add = (rules) => {
        if (Array.isArray(rules)) {
            for (const r of rules) {
                if (r && typeof r.token === 'string') { set.add(r.token); }
            }
        }
    };
    add(cfg.themeTextmateRules);
    add(cfg.customThemeRules);
    _themeScopeSet = set;
}

// scope 是否能被主题着色：按 '.' 逐级回退做前缀匹配（与 Monaco 主题 trie 的最长前缀一致）。
function hasThemeMatch(scope) {
    let s = scope;
    while (s) {
        if (_themeScopeSet.has(s)) { return true; }
        const i = s.lastIndexOf('.');
        if (i <= 0) { break; }
        s = s.slice(0, i);
    }
    return false;
}

// 从 token 的 scope 栈（[0]=根 ... [n]=最深）里，挑选「主题能着色的最深 scope」。
// 这样既保留 VSCode「更深 scope 优先」的直觉，又能在最深 scope 无主题规则时回退到更外层
// （如引号字符的 punctuation.* 无规则时回退到外层 string.* 拿到字符串色）。都不命中则用最深 scope。
function pickScope(scopes) {
    for (let i = scopes.length - 1; i >= 0; i--) {
        if (hasThemeMatch(scopes[i])) { return scopes[i]; }
    }
    return scopes.length ? scopes[scopes.length - 1] : '';
}

// ===== 语法源按需拉取（向扩展端要语法文件原始内容）=====
function fetchGrammarSource(scopeName) {
    const existing = _grammarWaiters.get(scopeName);
    if (existing) { return existing.promise; }

    let resolve;
    const promise = new Promise(r => { resolve = r; });
    _grammarWaiters.set(scopeName, { resolve, promise });
    _vscode.postMessage({ type: 'requestGrammar', scopeName });

    // 超时保护：避免某个 scope 永远收不到回包卡死 loadGrammar
    setTimeout(() => {
        const w = _grammarWaiters.get(scopeName);
        if (w) {
            _grammarWaiters.delete(scopeName);
            w.resolve(null);
        }
    }, 5000);

    return promise;
}

// 扩展端语法回包：resolve 对应等待者（在 main.js 的消息分发里调用，或本模块自挂监听）。
export function handleGrammarData(message) {
    const w = _grammarWaiters.get(message.scopeName);
    if (!w) { return; }
    _grammarWaiters.delete(message.scopeName);
    w.resolve(message && message.found ? { content: message.content, path: message.path } : null);
}

// ===== Monaco IState 适配 =====
// vscode-textmate 的 ruleStack（StateStack）本身是不可变的、且自带 clone()/equals()，
// 这里薄封装成 Monaco TokensProvider 所需的 IState。
class TMState {
    constructor(ruleStack) { this.ruleStack = ruleStack; }
    clone() { return new TMState(this.ruleStack); }
    equals(other) {
        if (other === this) { return true; }
        if (!other || !other.ruleStack || !this.ruleStack) { return false; }
        try { return other.ruleStack.equals(this.ruleStack); }
        catch (_) { return other.ruleStack === this.ruleStack; }
    }
}

function makeProvider(grammar) {
    return {
        getInitialState() { return new TMState(_INITIAL); },
        tokenize(line, state) {
            const ruleStack = (state && state.ruleStack) ? state.ruleStack : _INITIAL;
            let r;
            try {
                r = grammar.tokenizeLine(line, ruleStack);
            } catch (e) {
                return { tokens: [{ startIndex: 0, scopes: '' }], endState: new TMState(ruleStack) };
            }
            const tokens = [];
            for (const t of r.tokens) {
                tokens.push({ startIndex: t.startIndex, scopes: pickScope(t.scopes) });
            }
            return { tokens, endState: new TMState(r.ruleStack) };
        }
    };
}

// 确保某语言的语法已加载并注册到 Monaco。可重复调用：已加载/进行中则复用。
// 返回 Promise<grammar|null>。无对应 scope（未知语言）或加载失败返回 null（前端回退到默认着色）。
export function ensureGrammar(languageId) {
    if (!_enabled || !_registry || !languageId) { return Promise.resolve(null); }
    if (_grammarByLang.has(languageId)) { return Promise.resolve(_grammarByLang.get(languageId)); }
    if (_pendingByLang.has(languageId)) { return _pendingByLang.get(languageId); }

    const scope = _languageToScope[languageId];
    if (!scope) { return Promise.resolve(null); }

    const p = (async () => {
        try {
            const grammar = await _registry.loadGrammar(scope);
            if (grammar) {
                _grammarByLang.set(languageId, grammar);
                if (!_registeredLang.has(languageId)) {
                    _monaco.languages.setTokensProvider(languageId, makeProvider(grammar));
                    _registeredLang.add(languageId);
                    console.log('[context-window] TextMate grammar registered:', languageId, scope);
                    // 关键：setTokensProvider 对「注册前就已存在的 model」不保证自动重新分词。
                    // 首屏竞态下（grammar 异步加载晚于内容到达 / setModel，如首次安装、reload 窗口时 wasm 加载较慢），
                    // 该 model 会停留在 Monaco 内置 Monarch 的回退着色——这正是「reload 窗口后着色不正确、
                    // 重开工程才正常」的根因。这里显式让该语言的现有 model 重新分词，切换到真实 TextMate 着色。
                    try {
                        for (const m of _monaco.editor.getModels()) {
                            if (m.getLanguageId() !== languageId) { continue; }
                            if (typeof m.resetTokenization === 'function') {
                                m.resetTokenization();
                            } else {
                                // 兜底：同语言重设也会重建 tokenization（取到新注册的 TextMate provider）
                                _monaco.editor.setModelLanguage(m, languageId);
                            }
                        }
                    } catch (e) {
                        console.warn('[context-window] reset tokenization after grammar register failed:', e);
                    }
                }
            } else {
                console.warn('[context-window] TextMate grammar not found for:', languageId, scope);
            }
            return grammar;
        } catch (e) {
            console.warn('[context-window] textmate loadGrammar failed:', languageId, scope, e);
            return null;
        } finally {
            _pendingByLang.delete(languageId);
        }
    })();

    _pendingByLang.set(languageId, p);
    return p;
}

// 取某位置（Monaco 1-based position）所在 token 的真实 TextMate scope。
// 直接用已加载的 grammar 分词（携带跨行上下文以保证状态正确），返回：
//   { scopes: 完整 scope 栈, picked: 与渲染一致挑出的最优 scope, startColumn, endColumn, text }
// 用途：右键取色弹窗显示/编辑真实 TextMate scope（如 storage.type.struct.cpp），
// 而非 Monaco 内置 Monarch 的 keyword.struct.cpp。grammar 未就绪时触发加载并返回 null（调用方回退）。
export function getScopeAtPosition(model, position) {
    if (!_enabled || !model || !position) { return null; }
    const languageId = model.getLanguageId();
    const grammar = _grammarByLang.get(languageId);
    if (!grammar) {
        // 触发异步加载，本次先回退；下次右键即可命中
        ensureGrammar(languageId);
        return null;
    }

    const CONTEXT_LINES = 100;
    const startLine = Math.max(1, position.lineNumber - CONTEXT_LINES);
    let ruleStack = _INITIAL;
    let target = null;
    let targetText = '';
    for (let ln = startLine; ln <= position.lineNumber; ln++) {
        const text = model.getLineContent(ln);
        let r;
        try {
            r = grammar.tokenizeLine(text, ruleStack);
        } catch (_) {
            return null;
        }
        if (ln === position.lineNumber) { target = r; targetText = text; }
        ruleStack = r.ruleStack;
    }
    if (!target) { return null; }

    const col0 = position.column - 1;
    const toks = target.tokens;
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (col0 >= t.startIndex && col0 < t.endIndex) {
            return {
                scopes: t.scopes.slice(),
                picked: pickScope(t.scopes),
                startColumn: t.startIndex + 1,
                endColumn: t.endIndex + 1,
                text: targetText.slice(t.startIndex, t.endIndex)
            };
        }
    }
    return null;
}

// 初始化 TextMate 高亮。成功返回 { ensureGrammar, updateThemeScopes }，未启用/失败返回 null。
// cfg 来自扩展端注入的 window.ctxTextmate：{ enabled, wasmUri, languageToScope, injections }。
export async function setupTextmate({ monaco, vscode, cfg }) {
    if (!cfg || !cfg.enabled || !cfg.wasmUri) { return null; }

    _monaco = monaco;
    _vscode = vscode;
    _languageToScope = cfg.languageToScope || {};
    _injections = cfg.injections || {};
    updateThemeScopes();

    // 1) 动态加载打包好的 textmate 运行时
    console.log('[context-window] textmate: importing bundle ./textmate.bundle.js ...');
    const tm = await import('./textmate.bundle.js');
    console.log('[context-window] textmate: bundle loaded');
    _parseRawGrammar = tm.parseRawGrammar;
    _INITIAL = tm.INITIAL;

    // 2) 加载 oniguruma WASM
    console.log('[context-window] textmate: fetching wasm', cfg.wasmUri);
    const resp = await fetch(cfg.wasmUri);
    console.log('[context-window] textmate: wasm fetch status =', resp.status, 'ok =', resp.ok);
    const wasmBuf = await resp.arrayBuffer();
    console.log('[context-window] textmate: wasm bytes =', wasmBuf.byteLength);
    const onigLib = await tm.loadOnig(wasmBuf);
    console.log('[context-window] textmate: oniguruma loaded');

    // 3) 创建 Registry：loadGrammar 通过消息向扩展端按需取语法文件
    _registry = tm.createRegistry({
        onigLib: Promise.resolve(onigLib),
        loadGrammar: async (scopeName) => {
            const src = await fetchGrammarSource(scopeName);
            if (!src) { return null; }
            try {
                return _parseRawGrammar(src.content, src.path);
            } catch (e) {
                console.warn('[context-window] parseRawGrammar failed:', scopeName, e);
                return null;
            }
        },
        getInjections: (scopeName) => _injections[scopeName]
    });

    // 监听扩展端语法回包
    window.addEventListener('message', (event) => {
        const m = event.data;
        if (m && m.type === 'grammarData') { handleGrammarData(m); }
    });

    _enabled = true;
    console.log('[context-window] TextMate runtime ready');
    return { ensureGrammar, updateThemeScopes };
}

export function isTextmateEnabled() { return _enabled; }

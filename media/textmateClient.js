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

// 右键取色用的逐行结束状态缓存：把「从第 1 行逐行分词」的成本摊销到多次取色。
// 结构：WeakMap<model, { versionId, states: ruleStack[] }>，states[ln] = 第 ln 行分词后的 ruleStack
// （states[0] 恒为 _INITIAL，即第 1 行的起始状态）。仅在 getScopeAtPosition（右键 pick）里按需生长，
// 渲染等高频路径不碰它。model 内容变化（versionId 变）即整体失效重建；model 销毁后由 WeakMap 自动回收。
const _stateCacheByModel = new WeakMap();

// 某语言的 TextMate grammar 完成 setTokensProvider 注册时的回调（应用层据此对当前同语言 model 触发重分词）。
let _onGrammarRegistered = null;
export function setOnGrammarRegistered(cb) {
    _onGrammarRegistered = (typeof cb === 'function') ? cb : null;
}

// 统一调试日志开关：默认关闭，排查问题（如 wasm/语法加载、provider 注册时序）时置为 true 即可恢复全部输出。
const DEBUG = false;
function log(...args) {
    if (DEBUG) { console.log('[context-window]', ...args); }
}

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
                    const provider = makeProvider(grammar);

                    // 关键（消除偶现回到 Monarch 蓝色的根因）：Monaco 内置语言的 Monarch 分词器是经
                    // registerTokensProviderFactory 惰性异步加载的。首屏内容到达时会触发该 factory 的 resolve()
                    // （异步 import Monarch chunk）。即便我们随后用 setTokensProvider 注册了 TextMate，
                    // 那个 pending 的 Monarch _create() 一旦 resolve 完成，会**无条件** register 覆盖我们的 provider
                    // （见 tokenizationRegistry.js: _create 里 `if (value && !this._isDisposed) register(...)`），
                    // 并触发重分词 → if 回到蓝色。谁的异步先完成不确定，故偶现。
                    //
                    // 修复：再注册一个「返回 TextMate provider」的 factory。registerFactory 会先 dispose 掉已存在的
                    // 内置 Monarch factory（见 registerFactory: `_factories.get(id)?.dispose()`），使其 _isDisposed=true，
                    // 那个 pending 的 Monarch resolve 完成时便不再 register —— TextMate 由此永久胜出。
                    try {
                        _monaco.languages.registerTokensProviderFactory(languageId, { create: () => provider });
                    } catch (e) {
                        console.warn('[context-window] registerTokensProviderFactory failed:', languageId, e);
                    }
                    // 直接注册一份 support，使当前已存在的 model 立即（经 onDidChange）切换到 TextMate。
                    _monaco.languages.setTokensProvider(languageId, provider);
                    _registeredLang.add(languageId);
                    log('TextMate grammar registered:', languageId, scope);

                    // 注册完成的确定性触发点：由应用层对「当前同语言 model」做一次可靠重分词（重建 model），
                    // 覆盖「首屏已带内容、grammar 后到」时已缓存 Monarch 分词不自动刷新的情况。
                    if (typeof _onGrammarRegistered === 'function') {
                        try { _onGrammarRegistered(languageId); }
                        catch (e) { console.warn('[context-window] onGrammarRegistered callback failed:', e); }
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

    // TextMate 分词是有状态的：第 ln 行需要第 ln-1 行结束时的 ruleStack 作为起点，故起点必须是真正的
    // 文档顶层（_INITIAL）才能与渲染（Monaco 从文档顶部逐行维护 ruleStack）保持一致；用 position-N 的窗口
    // 起点可能落在多行构造（块注释 / 模板字符串 / JSX / 跨行类型等）中间，导致取到与渲染不同的 scope。
    // 为避免每次都从第 1 行重算，这里缓存逐行结束状态：首次取色仍逐行算到目标行（并缓存沿途状态），
    // 之后往下点只增量补算、往回点直接命中，近 O(1)；model 内容变化则整体重建，准确性与全量一致。
    const targetLine = position.lineNumber;
    const versionId = model.getVersionId();

    let cache = _stateCacheByModel.get(model);
    if (!cache || cache.versionId !== versionId) {
        cache = { versionId, states: [_INITIAL] }; // states[0] = 第 1 行的起始状态
        _stateCacheByModel.set(model, cache);
    }

    let target = null;
    let targetText = '';
    // states.length 表示「下一行要算的行号」(1-based)；states[ln-1] 即第 ln 行的起始 ruleStack。
    let ln = cache.states.length;
    let ruleStack = cache.states[ln - 1];
    for (; ln <= targetLine; ln++) {
        const text = model.getLineContent(ln);
        let r;
        try {
            r = grammar.tokenizeLine(text, ruleStack);
        } catch (_) {
            return null;
        }
        if (ln === targetLine) { target = r; targetText = text; }
        ruleStack = r.ruleStack;
        cache.states[ln] = ruleStack; // 缓存第 ln 行结束后的状态
    }

    // 目标行此前已被缓存（之前点过更靠下的行）：用其起始状态补算一次，仅为拿到该行 tokens。
    if (!target) {
        const text = model.getLineContent(targetLine);
        try {
            target = grammar.tokenizeLine(text, cache.states[targetLine - 1]);
            targetText = text;
        } catch (_) {
            return null;
        }
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
    log('textmate: importing bundle ./textmate.bundle.js ...');
    const tm = await import('./textmate.bundle.js');
    log('textmate: bundle loaded');
    _parseRawGrammar = tm.parseRawGrammar;
    _INITIAL = tm.INITIAL;

    // 2) 加载 oniguruma WASM
    log('textmate: fetching wasm', cfg.wasmUri);
    const resp = await fetch(cfg.wasmUri);
    log('textmate: wasm fetch status =', resp.status, 'ok =', resp.ok);
    const wasmBuf = await resp.arrayBuffer();
    log('textmate: wasm bytes =', wasmBuf.byteLength);
    const onigLib = await tm.loadOnig(wasmBuf);
    log('textmate: oniguruma loaded');

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
    log('TextMate runtime ready');
    return { ensureGrammar, updateThemeScopes };
}

export function isTextmateEnabled() { return _enabled; }

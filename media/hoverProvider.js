//@ts-check

// 自定义 Hover Provider：通过 postMessage 把 hover 请求转给扩展端，扩展端用
// vscode.executeHoverProvider 复用主编辑区已就绪的 LSP（TS server / clangd / Pylance 等）
// 拿到结果后回包 webview，由这里 resolve 出 monaco.languages.Hover。
//
// 关键问题与对策：
//   1) Monaco 内的 model.uri 是 'inmemory://model/N' 之类的虚拟 URI，跟用户文档真实 URI 不同。
//      扩展端 executeHoverProvider 必须用真实文档 URI 才能拿到 LSP 结果。
//      → 通过 editorState.uri 取真实 URI（扩展端 updateMetadata 阶段下发并保存于 editorState）。
//   2) 注册必须覆盖所有语言，避免 setModel 切换语言时漏覆盖（用 '*' 一次注册到所有语言）。
//   3) Monaco hover widget 在 webview 内会同时等待自带 worker 的 hover provider；这些 worker 在
//      webview 中常长期 pending，导致即便我们 resolve(null) 浮窗依然 Loading。
//      因此：拿到空内容时也 resolve 一个最小的合法 Hover（不是 null），让 Monaco 视作"已有结果"，
//      浮窗会立刻显示空内容并随鼠标离开自动消失，不再卡 Loading。
//   4) 调试日志：构造 reqId、收到回包、超时三处都打日志，便于定位链路问题。

const HOVER_TIMEOUT_MS = 1500;
const DEBUG = true; // 排障期打开

function dlog(...args) {
    if (DEBUG) {
        try { console.log('[hover]', ...args); } catch (_) { /* noop */ }
    }
}

let _vscode = null;
let _state = null; // editorState：{ uri, content, language, ... }
let _registered = false;
let _seq = 0;
const _pending = new Map(); // reqId -> { resolve, timer }

// 注册一次到所有语言（'*'）。后续不会再次注册（幂等）。
export function ensureHoverProvider(_languageIdIgnored) {
    if (_registered) { return; }
    if (!window.monaco || !monaco.languages || typeof monaco.languages.registerHoverProvider !== 'function') {
        return;
    }
    _registered = true;

    monaco.languages.registerHoverProvider('*', {
        provideHover: (model, position, token) => {
            if (!_vscode || !model) { return null; }

            // 必须用 editorState 中的真实文档 URI（扩展端 updateMetadata 下发），
            // 不要用 model.uri（那是 Monaco 自动生成的 inmemory 虚拟 URI）。
            const realUri = (_state && _state.uri) ? _state.uri : '';
            if (!realUri) {
                dlog('skip: no real uri in editorState');
                return null;
            }

            const reqId = ++_seq;
            dlog('provideHover ->', { reqId, uri: realUri, line: position.lineNumber, col: position.column });
            return new Promise(resolve => {
                const timer = setTimeout(() => {
                    if (_pending.has(reqId)) {
                        _pending.delete(reqId);
                        dlog('timeout', reqId);
                        // 超时也返回最小空 Hover，避免 Monaco 继续等其他 provider 转圈
                        resolve({ contents: [{ value: '' }] });
                    }
                }, HOVER_TIMEOUT_MS);

                _pending.set(reqId, { resolve, timer });

                try {
                    _vscode.postMessage({
                        type: 'requestHover',
                        reqId,
                        uri: realUri,
                        // 转 0-based（VSCode Position 与扩展端 vscode.Position 一致）
                        position: { line: position.lineNumber - 1, character: position.column - 1 }
                    });
                } catch (e) {
                    clearTimeout(timer);
                    _pending.delete(reqId);
                    dlog('postMessage failed', e);
                    resolve({ contents: [{ value: '' }] });
                    return;
                }

                if (token && typeof token.onCancellationRequested === 'function') {
                    token.onCancellationRequested(() => {
                        const p = _pending.get(reqId);
                        if (p) {
                            clearTimeout(p.timer);
                            _pending.delete(reqId);
                            dlog('cancelled', reqId);
                            // 取消时返回 null 是安全的（Monaco 已主动取消，不会再渲染）
                            resolve(null);
                        }
                    });
                }
            });
        }
    });
    dlog('hover provider registered for "*"');
}

// 接收扩展端的 hover 回包（main.js 在 message 分发里调用）。
// message: { type: 'hoverResult', reqId, contents: string[], range?: {startLine,startCol,endLine,endCol} (1-based) }
export function handleHoverResult(message) {
    if (!message || typeof message.reqId !== 'number') { return; }
    const p = _pending.get(message.reqId);
    if (!p) {
        dlog('hoverResult no pending', message.reqId);
        return;
    }
    _pending.delete(message.reqId);
    clearTimeout(p.timer);

    const list = Array.isArray(message.contents) ? message.contents.filter(s => typeof s === 'string' && s.length) : [];
    dlog('hoverResult', { reqId: message.reqId, count: list.length });
    if (!list.length) {
        // 关键：返回最小合法 Hover（而不是 null），让 Monaco 视作已经"有结果"，
        // 不会继续等待自带 worker provider，浮窗自然消失。
        p.resolve({ contents: [{ value: '' }] });
        return;
    }

    /** @type {{ contents: { value: string, isTrusted?: boolean, supportHtml?: boolean }[], range?: any }} */
    const hover = {
        contents: list.map(value => ({ value, isTrusted: false, supportHtml: false }))
    };
    if (message.range && typeof message.range.startLine === 'number') {
        hover.range = new monaco.Range(
            message.range.startLine,
            message.range.startCol,
            message.range.endLine,
            message.range.endCol
        );
    }
    p.resolve(hover);
}

// 注入 vscode api（acquireVsCodeApi 的返回对象）与 editorState 引用。
// editorState 必须在 main.js 已创建该对象后传入，后续无需再调用。
export function setupHoverProvider(vscodeApi, editorState) {
    _vscode = vscodeApi;
    _state = editorState || null;
    dlog('setup', { hasState: !!_state });
}

// 禁用 Monaco 内置 TS/JS 模块自动注册的 hover / signatureHelp / completion 等 provider。
//
// 背景：vscode-context-window 引入的是 monaco-editor 完整包，'typescript' / 'javascript' 语言被首次
// 使用时，Monaco 会按需加载 vs/language/typescript/tsMode，自动注册一组依赖 ts.worker.js 的 provider。
// webview 内 worker 启动机制未配置 → 这些 provider 的 Promise 永不 resolve。表现是浮窗顶部已展示
// 我们 hover provider 返回的内容，但下方继续追加 "Loading..."（来自 Monaco 自带 ts hover provider）。
//
// 处置：调用 monaco.languages.typescript.{typescript,javascript}Defaults.setModeConfiguration({...:false})
// 把内置 hover / signatureHelp / completion / definitions 等全部关掉。setModeConfiguration 必须在
// tsMode 已加载后才有效——这里通过 onLanguage('typescript'|'javascript') 等待激活时机，再做兼容性
// 多次重试（部分 monaco 版本 setModeConfiguration 在首次注册前调用会被覆盖）。
export function disableMonacoBuiltinTsJsProviders() {
    if (!window.monaco || !monaco.languages || typeof monaco.languages.onLanguage !== 'function') {
        return;
    }

    const tryDisable = (langId) => {
        try {
            const ns = monaco.languages.typescript;
            if (!ns) { return false; }
            const defaults = (langId === 'typescript') ? ns.typescriptDefaults : ns.javascriptDefaults;
            if (!defaults || typeof defaults.setModeConfiguration !== 'function') { return false; }
            defaults.setModeConfiguration({
                completionItems: false,
                hovers: false,
                documentSymbols: false,
                definitions: false,
                references: false,
                documentHighlights: false,
                rename: false,
                diagnostics: false,
                documentRangeFormattingEdits: false,
                signatureHelp: false,
                onTypeFormattingEdits: false,
                codeActions: false,
                inlayHints: false
            });
            dlog('disabled monaco builtin providers for', langId);
            return true;
        } catch (e) {
            dlog('disable failed for', langId, e);
            return false;
        }
    };

    const ensureFor = (langId) => {
        // 立即尝试一次（已加载时直接成功）
        if (tryDisable(langId)) { return; }
        // 否则在该语言激活时再尝试，最多重试若干次（覆盖 setModeConfiguration 在 mode 加载完成后才生效的情况）
        monaco.languages.onLanguage(langId, () => {
            let n = 0;
            const tick = () => {
                if (tryDisable(langId)) { return; }
                if (++n < 20) { setTimeout(tick, 50); } // 最多重试 ~1s
            };
            tick();
        });
    };

    ensureFor('typescript');
    ensureFor('javascript');
}

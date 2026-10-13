//@ts-check

// 编辑器内容更新逻辑：设置 model / 语言 / 缩进、清理与重建装饰高亮、
// 滚动定位到目标行、刷新 sticky scroll 等。
// 以工厂函数形式创建，通过 ctx 共享 editor 引用、可变会话状态（state）与若干回调。
// monaco / document 直接使用全局对象（与其它模块一致）。

import { BRACE_LANGS } from './braceLangs.js';

// 大文件各自保留一个 model，切走再切回时直接挂回，不再 setValue 重建分词/括号/折叠。
// 小文件共用一个 scratch model，照旧 setValue。
const BIG_MODEL_CHARS = 512 * 1024;
const BIG_MODEL_MAX = 3;

export function createUpdateEditorContent(ctx) {
    /** @type {import('monaco-editor').editor.IStandaloneCodeEditor} */
    const editor = ctx.editor;
    const { state, applyIndentationForModel, updateFilenameDisplay, hideCursor, ensureGrammar, ensureLanguageConfig } = ctx;

    /** @type {Map<string, { model: any, key: string, versionId: number }>} uri → 大文件 model（Map 顺序即 LRU） */
    const bigModels = new Map();
    let scratchModel = null;

    function isBigModel(model) {
        for (const entry of bigModels.values()) {
            if (entry.model === model) {
                return true;
            }
        }
        return false;
    }

    // 换 model 前清掉挂在旧 model 上的指令装饰，避免切回时重复叠加。
    function attachModel(model) {
        const prev = editor.getModel();
        if (prev === model) {
            return false;
        }
        if (state.directiveDecorations && state.directiveDecorations.length) {
            state.directiveDecorations = editor.deltaDecorations(state.directiveDecorations, []);
        }
        editor.setModel(model);
        if (prev && !prev.isDisposed() && !scratchModel && !isBigModel(prev)) {
            scratchModel = prev;
        }
        return true;
    }

    function useScratchModel(languageId) {
        if (!scratchModel || scratchModel.isDisposed()) {
            const current = editor.getModel();
            scratchModel = current && !current.isDisposed() && !isBigModel(current)
                ? current
                : monaco.editor.createModel('', languageId || 'plaintext');
        }
        const switched = attachModel(scratchModel);
        return { model: scratchModel, switched };
    }

    function evictBigModels(keepUri) {
        while (bigModels.size > BIG_MODEL_MAX) {
            let victim = null;
            for (const [uri, entry] of bigModels) {
                if (uri !== keepUri && entry.model !== editor.getModel()) {
                    victim = uri;
                    break;
                }
            }
            if (!victim) {
                return;
            }
            const entry = bigModels.get(victim);
            bigModels.delete(victim);
            try { entry.model.dispose(); } catch (_) {}
        }
    }

    function acquireBigModel(uri, key, content, languageId) {
        const hit = bigModels.get(uri);
        if (hit && !hit.model.isDisposed() && hit.key === key && hit.model.getVersionId() === hit.versionId) {
            bigModels.delete(uri);
            bigModels.set(uri, hit);
            return { model: hit.model, created: false };
        }
        let stale = null;
        if (hit) {
            bigModels.delete(uri);
            if (hit.model === editor.getModel()) {
                stale = hit.model;
            } else {
                try { hit.model.dispose(); } catch (_) {}
            }
        }
        const model = monaco.editor.createModel(content, languageId || 'plaintext');
        bigModels.set(uri, { model, key, versionId: model.getVersionId() });
        evictBigModels(uri);
        return { model, created: true, stale };
    }

    function dropBigModel(uri) {
        const entry = bigModels.get(uri);
        if (!entry) {
            return;
        }
        bigModels.delete(uri);
        if (entry.model === editor.getModel()) {
            state.renderedContentKey = '';
            return;
        }
        try { entry.model.dispose(); } catch (_) {}
    }

    // ===== #include / #pragma / #region / #endregion 等预处理指令高亮 =====
    // 与扩展端 VSCode 编辑器的装饰（extension.ts: registerDirectiveDecorations）同源：
    // 同样的语言范围、同样的正则、同样从 editor.tokenColorCustomizations 解析出的配色与字重，
    // 由 contextEditorCfg.fixToken 开关控制，使 Monaco 上下文窗口内的指令着色与主编辑器一致。
    const DIRECTIVE_LANGS = ['c', 'cc', 'cpp', 'h', 'hpp', 'csharp'];

    // 注入/刷新指令高亮的样式（颜色 + 字重 + 斜体），随配置变化即时更新
    function refreshDirectiveStyle() {
        const cfg = window.vsCodeEditorConfiguration?.contextEditorCfg || {};
        const color = cfg.directiveColor || '#0000FF';
        const fontWeight = String(window.vsCodeEditorConfiguration?.editorOptions?.fontWeight || 'normal');
        // 对齐扩展端：字重为 bold 时用 oblique 斜体强调
        const fontStyle = fontWeight === 'bold' ? 'oblique' : 'normal';
        let styleEl = document.getElementById('cw-directive-style');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'cw-directive-style';
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = `.cw-directive-token { color: ${color} !important; font-weight: ${fontWeight}; font-style: ${fontStyle}; }`;
    }

    // 返回落点 token 高亮的配色：与扩展端下发的 selectionHighlight 配色保持一致
    // （editorTheme.js 用同样两个配置项写 Monaco 主题），这样看上去仍是熟悉的同词高亮外观。
    function refreshReturnTokenStyle() {
        const cfg = window.vsCodeEditorConfiguration?.contextEditorCfg || {};
        const bg = cfg.selectionHighlightBackground || '#5bdb0771';
        const border = cfg.selectionHighlightBorder || '#5bdb0791';
        let styleEl = document.getElementById('cw-return-token-style');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'cw-return-token-style';
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = `.cw-return-token { background-color: ${bg}; border: 1px solid ${border}; }`;
    }

    // 逐行匹配行首（允许前导空白）的 # 指令，返回从 '#' 到关键字结束的范围
    function computeDirectiveRanges(model) {
        const ranges = [];
        const lineCount = model.getLineCount();
        const re = /^([ \t]*)#[ \t]*(include|pragma|region|endregion)\b/;
        for (let line = 1; line <= lineCount; line++) {
            const text = model.getLineContent(line);
            const m = re.exec(text);
            if (m) {
                const hashCol = m[1].length + 1; // '#' 所在列（1-based）
                const endCol = m[0].length + 1;  // 关键字结束后的列
                ranges.push(new monaco.Range(line, hashCol, line, endCol));
            }
        }
        return ranges;
    }

    // 应用（或在关闭/语言不符时清除）指令高亮装饰
    function applyDirectiveDecorations() {
        const model = editor.getModel();
        const prev = state.directiveDecorations || [];
        if (!model) { state.directiveDecorations = []; return; }

        const cfg = window.vsCodeEditorConfiguration?.contextEditorCfg || {};
        const lang = model.getLanguageId();
        if (!cfg.fixToken || !DIRECTIVE_LANGS.includes(lang)) {
            // 开关关闭或语言不匹配：清除已有装饰
            state.directiveDecorations = prev.length ? editor.deltaDecorations(prev, []) : [];
            return;
        }

        refreshDirectiveStyle();
        const ranges = computeDirectiveRanges(model);
        state.directiveDecorations = editor.deltaDecorations(
            prev,
            ranges.map(r => ({ range: r, options: { inlineClassName: 'cw-directive-token' } }))
        );
    }

    // 按当前文件语言选择 sticky scroll 模型并刷新（顶部粘附的函数/类标题行）。
    //
    // 关键背景：stickyScroll.defaultModel 是【全局】编辑器选项，无法按语言分别设置；但本面板每次只显示
    // 单一文件、单一语言，因此可在每次内容更新时根据 languageId 动态切换全局 defaultModel，等价于「按语言选模型」：
    //   · 花括号系语言（BRACE_LANGS：TS/JS/C/C++/C#/Java/Go/Rust/PHP/Swift/Kotlin）：统一用
    //     foldingProviderModel，配合 braceFoldingProvider.js 注册的花括号折叠 provider。花括号配对 +
    //     声明行上提是语言无关的，能统一处理 Allman/K&R/多行签名（纯缩进模型无法处理「{ 独占一行」：
    //     孤立的 '{' 会被当成标题行，且方法层级整体丢失）；且对每对 { } 都出区间，控制流块也会进sticky。
    //     该 provider 解析不出区间时返回 null，Monaco 会自动继续回退到 indentationModel。
    //   · 其它语言：用 outlineModel（纯缩进/end型语言在 webview 中多为空 → 自动回退缩进）。
    //
    // 注意：不能同步「disable→enable」——同一帧内两次 updateOptions 会被 Monaco 选项 diff 合并、视为无变化、
    // 刷新无效。必须跨一个渲染帧再 enable，让控制器真正重建并重新取数。
    function refreshStickyScroll() {
        const cur = editor.getOption(monaco.editor.EditorOption.stickyScroll);
        if (!cur || !cur.enabled) { return; }
        const model = editor.getModel();
        const lang = model ? model.getLanguageId() : '';
        const defaultModel = BRACE_LANGS.includes(lang) ? 'foldingProviderModel' : 'outlineModel';
        editor.updateOptions({ stickyScroll: { enabled: false } });
        setTimeout(() => {
            editor.updateOptions({
                stickyScroll: {
                    enabled: true,
                    defaultModel: defaultModel,
                    maxLineCount: cur.maxLineCount || 5,
                    scrollWithEditor: cur.scrollWithEditor !== false
                }
            });
            editor.layout();
            // layout / 重建 sticky 可能把滚动打回顶部，按当前定位再居中一次。
            revealCurrent();
        }, 0);
    }

    // 垂直居中 + 水平尽量靠左（与首次跳转同一策略）。
    // 面包屑/历史跳转后，以及 sticky 重建后，都走这里，避免目标行贴在视口顶。
    function revealCurrent() {
        const range = state.range;
        if (!editor || !range || !range.start) {
            return;
        }
        const curLine = state.curLine;
        const revealStartLine = (curLine && curLine > 0) ? curLine : range.start.line + 1;
        const revealRange = new monaco.Range(
            revealStartLine,
            range.start.character + 1,
            range.end.line + 1,
            range.end.character + 1
        );
        editor.setScrollLeft(0, monaco.editor.ScrollType.Immediate);
        editor.revealRangeInCenter(revealRange, monaco.editor.ScrollType.Immediate);
    }

    // 强制当前 model 用「已注册的 TextMate provider」重新分词。
    //
    // 背景与根因：TextMate 语法是异步加载的，常常晚于内容到达（setModel）。内容先到时 model 已被 Monaco
    // 内置 Monarch 分词并缓存（if → keyword → 蓝、非粗），等 grammar 注册后，仅靠 setTokensProvider 不会让
    // 「已存在并已缓存分词的 model」重新分词——这就是「重载窗口时若 context 已有内容则 if 必现蓝色，
    // 而重载后无内容、之后再点击则正确显示」的根因（点击时 grammar 已就绪，新内容直接走 TextMate）。
    //
    // 修复方式：Monaco 0.55 没有可用的 model.resetTokenization()，「同语言重设 / 语言 bounce」对已缓存
    // 分词的 model 也不可靠。最稳妥且版本无关的做法是「重建 model」——新建的 model 必定用当前已注册的
    // TextMate provider 重新分词。这里同时保留滚动/光标（viewState）与高亮行 / 符号高亮装饰（按范围重建），
    // 保证用户无感知。
    function forceRetokenize(languageId) {
        const old = editor.getModel();
        if (!old) { return; }
        const lang = languageId || old.getLanguageId();
        if (old.getLanguageId() !== lang) { return; }
        try {
            const value = old.getValue();
            const viewState = editor.saveViewState();
            // 快照现有装饰范围，重建后按原样恢复（装饰 id 绑定旧 model，dispose 后失效）
            const activeRanges = (state.activeLineDecorations || [])
                .map(id => old.getDecorationRange(id)).filter(Boolean);
            const symbolRanges = (state.symboleDecorations || [])
                .map(id => old.getDecorationRange(id)).filter(Boolean);
            const returnTokenRanges = (state.returnTokenDecorations || [])
                .map(id => old.getDecorationRange(id)).filter(Boolean);

            const fresh = monaco.editor.createModel(value, lang);
            applyIndentationForModel(fresh);
            editor.setModel(fresh);
            if (viewState) { editor.restoreViewState(viewState); }
            if (scratchModel === old) {
                scratchModel = fresh;
            }
            // 停放中的同语言大文件还是旧分词，挂回来会显示旧颜色；直接丢掉，下次按内容重建。
            for (const [uri, entry] of [...bigModels]) {
                if (entry.model === old) {
                    entry.model = fresh;
                    entry.versionId = fresh.getVersionId();
                } else if (entry.model.getLanguageId() === lang) {
                    bigModels.delete(uri);
                    try { entry.model.dispose(); } catch (_) {}
                }
            }

            state.activeLineDecorations = activeRanges.length
                ? editor.deltaDecorations([], activeRanges.map(r => ({
                    range: r,
                    options: { isWholeLine: true, className: 'highlighted-line', glyphMarginClassName: 'highlighted-glyph' }
                })))
                : [];
            state.symboleDecorations = symbolRanges.length
                ? editor.deltaDecorations([], symbolRanges.map(r => ({
                    range: r,
                    options: { className: 'highlighted-symbol-range', inlineClassName: 'highlighted-symbol-inline', zIndex: 100 }
                })))
                : [];
            state.returnTokenDecorations = returnTokenRanges.length
                ? editor.deltaDecorations([], returnTokenRanges.map(r => ({
                    range: r,
                    options: { className: 'cw-return-token', zIndex: 90 }
                })))
                : [];

            old.dispose();
            // 重建后按新 token 类型重新着色（主题对象已含 textmate scope 规则与用户自定义规则）
            try { monaco.editor.setTheme('custom-vs'); } catch (_) {}
            // 模型已重建，旧装饰 id 失效：重置后按当前内容重新计算指令高亮
            state.directiveDecorations = [];
            applyDirectiveDecorations();
            // 关键：model 被整体替换后，sticky scroll 控制器不会自动重建粘附渲染，必须主动刷新，
            // 否则 TextMate 模式下（grammar 就绪触发重建）TS/JS 顶部粘附行会彻底消失。
            refreshStickyScroll();
        } catch (e) {
            console.warn('[context-window] forceRetokenize failed:', e);
        }
    }

    function logBracketPaint() {
        const cfg = window.vsCodeEditorConfiguration?.contextEditorCfg;
        if (!cfg || !cfg.logging || !window.vscode || !editor) {
            return;
        }
        setTimeout(() => {
            const root = editor.getDomNode();
            if (!root) {
                return;
            }
            const cs = getComputedStyle(document.documentElement);
            const colors = [];
            for (let i = 1; i <= 6; i++) {
                colors.push(i + '=' + cs.getPropertyValue('--vscode-editorBracketHighlight-foreground' + i).trim());
            }
            const lines = [
                'enabled=' + (cfg.bracketPairColorization !== false)
                    + ' independentPool=' + (cfg.independentColorPoolPerBracketType === true)
                    + ' language=' + (editor.getModel()?.getLanguageId() || ''),
                'background=' + cs.getPropertyValue('--vscode-editor-background').trim()
                    + ' brackets=' + colors.join(' ')
                    + ' unexpected=' + cs.getPropertyValue('--vscode-editorBracketHighlight-unexpectedBracket-foreground').trim()
            ];
            const want = { '[': 0, ']': 0, '(': 0, ')': 0, '{': 0, '}': 0 };
            const spans = root.querySelectorAll('.view-line span');
            for (let s = 0; s < spans.length; s++) {
                const span = spans[s];
                const text = span.textContent || '';
                for (let c = 0; c < text.length; c++) {
                    const ch = text[c];
                    if (!(ch in want) || want[ch] >= 2) {
                        continue;
                    }
                    want[ch]++;
                    const style = getComputedStyle(span);
                    let background = style.backgroundColor;
                    let node = span;
                    while (node && (!background || background === 'transparent' || background === 'rgba(0, 0, 0, 0)')) {
                        node = node.parentElement;
                        background = node ? getComputedStyle(node).backgroundColor : '';
                    }
                    lines.push(ch
                        + ' class=' + span.className
                        + ' color=' + style.color
                        + ' background=' + background
                        + ' opacity=' + style.opacity
                        + ' fontSize=' + style.fontSize);
                }
            }
            const missing = Object.keys(want).filter(ch => want[ch] === 0);
            if (missing.length) {
                lines.push('not in view: ' + missing.join(''));
            }
            window.vscode.postMessage({ type: 'debugLog', module: 'bracket', lines });
        }, 10000);
    }

    const updateEditorContent = function updateEditorContent(newContent, options) {
        //console.log('[definition] Updating editor content with options:', options);
        const {
            newUri,
            languageId,
            range,
            curLine,
            curColumn,
            contentKey
        } = options || {};

        // 显示编辑器，隐藏原始内容区域
        document.getElementById('container').style.display = 'block';
        document.getElementById('main').style.display = 'none';

        //console.log('[definition] Updating editor content with range:', range);

        const prevUri = state.renderedUri;
        state.uri = newUri;

        // 更新 URI 和文件名显示
        if (state.uri) {
            updateFilenameDisplay(state.uri);
        }

        // 更新编辑器内容和语言
        if (editor) {
            let model = editor.getModel();

            // 更新全局变量
            state.content = newContent;
            state.language = languageId;

            // 方案 B：确保该语言的真实 TextMate 语法已加载并接管分词（fire-and-forget）。
            // grammar 异步就绪、setTokensProvider 注册完成后，会经 textmateClient 的注册回调
            // （main.js 里 setOnGrammarRegistered）对当前同语言 model 触发一次可靠重分词（重建 model），
            // 故此处无需自行重分词；已注册语言的后续内容更新会直接走 TextMate provider。
            if (typeof ensureGrammar === 'function' && languageId) {
                try { ensureGrammar(languageId); } catch (_) {}
            }
            if (typeof ensureLanguageConfig === 'function' && languageId) {
                try { ensureLanguageConfig(languageId); } catch (_) {}
            }

            // 避免Monaco将旧装饰迁移到新内容的相同位置
            if (state.symboleDecorations.length > 0) {
                state.symboleDecorations = editor.deltaDecorations(state.symboleDecorations, []);
            }
            if (state.activeLineDecorations.length > 0) {
                state.activeLineDecorations = editor.deltaDecorations(state.activeLineDecorations, []);
            }
            if (state.returnTokenDecorations && state.returnTokenDecorations.length > 0) {
                state.returnTokenDecorations = editor.deltaDecorations(state.returnTokenDecorations, []);
            }

            const sameFile = !!(newUri && prevUri === newUri && model);
            let contentChanged = !model;
            // 同一份正文已在编辑器里：只换定位，不比较也不重设整篇。
            const alreadyShown = !!(contentKey && model && !model.isDisposed()
                && contentKey === state.renderedContentKey);
            if (!alreadyShown) {
                const big = !!(contentKey && newUri && newContent && newContent.length >= BIG_MODEL_CHARS);
                if (big) {
                    const target = acquireBigModel(newUri, contentKey, newContent, languageId);
                    model = target.model;
                    if (attachModel(model) || target.created) {
                        contentChanged = true;
                    }
                    if (target.stale && target.stale !== editor.getModel()) {
                        try { target.stale.dispose(); } catch (_) {}
                    }
                } else {
                    const target = useScratchModel(languageId);
                    model = target.model;
                    if (target.switched) {
                        contentChanged = true;
                    }
                    if (newContent && model.getValue() !== newContent) {
                        model.setValue(newContent);
                        contentChanged = true;
                    }
                }
                if (model.getLanguageId() !== languageId && languageId) {
                    monaco.editor.setModelLanguage(model, languageId);
                }
                state.renderedContentKey = contentKey || '';
            }

            state.renderedUri = newUri || prevUri;

            if (!sameFile || contentChanged) {
                applyIndentationForModel(model);

                const lineCount = model.getLineCount();
                const requiredChars = Math.max(1, lineCount.toString().length);

                editor.updateOptions({ lineNumbersMinChars: requiredChars });
                // 强制刷新 sticky scroll（跨渲染帧 disable→enable），更新顶部粘附行显示
                refreshStickyScroll();
                editor.layout();
                logBracketPaint();
            }

            // const existingDecorations = editor.getDecorationsInRange(new monaco.Range(
            //     1, 1,
            //     model.getLineCount(),
            //     Number.MAX_SAFE_INTEGER
            // ));

            // const symbolDecorations = existingDecorations?.filter(d => d.options.className === 'highlighted-symbol-range' && d.options.inlineClassName === 'highlighted-symbol-inline');

            // if (symbolDecorations && symbolDecorations.length > 0) {
            //     editor.deltaDecorations(symbolDecorations.map(d => d.id), []);
            // }

            // 滚动到指定行
            if (range && range.start) {
                let targetLine = range.start.line+1;
                if (curLine && curLine > 0) {
                    targetLine = curLine;
                }
                // 原来（只垂直居中，横向不动）：
                // editor.revealLineInCenter(targetLine, monaco.editor.ScrollType.Immediate);

                // 改为：每次强制垂直居中 + 水平尽量回到最左，必要时才右移保证可见
                const revealStartLine = (curLine && curLine > 0) ? curLine : range.start.line + 1;
                const revealRange = new monaco.Range(
                    revealStartLine,
                    range.start.character + 1,   // 起始列 → 横向可见的关键
                    range.end.line + 1,
                    range.end.character + 1
                );
                // 1) 水平强制回到最左（scrollLeft = 0），保证默认"从左开始"
                editor.setScrollLeft(0, monaco.editor.ScrollType.Immediate);
                // 2) 垂直强制居中；水平仅当目标在最左状态下看不见时才右移保证可见
                editor.revealRangeInCenter(
                    revealRange,
                    monaco.editor.ScrollType.Immediate
                );

                // 添加行高亮装饰，只高亮开始行
                state.activeLineDecorations = editor.deltaDecorations(state.activeLineDecorations, [{
                    range: new monaco.Range(range.start.line+1, 1, range.start.line+1, 1),
                    options: {
                        isWholeLine: true,
                        className: 'highlighted-line',
                        glyphMarginClassName: 'highlighted-glyph'
                    }
                }]);

                let column = 1;
                let hlEndLine = range.end.line + 1;
                let hlEndCol = range.end.character + 1;
                // 如果有定义名，高亮它
                if (range.start.character !== range.end.character || range.start.line !== range.end.line) {
                    // 默认按原 range 高亮
                    let hlStartLine = range.start.line + 1;
                    let hlStartCol = range.start.character + 1;

                    try {
                        // 1) 判定原 range 是否是"单一的单词"：跨行 或 文本中含空白都视为非单词
                        const isMultiLine = range.start.line !== range.end.line;
                        const rangeText = model.getValueInRange(new monaco.Range(
                            hlStartLine, hlStartCol, hlEndLine, hlEndCol
                        ));
                        const isSingleWord = !isMultiLine && !/\s/.test(rangeText);

                        // 2) 不是单一的单词时，在这段范围文本里找独立的 constructor，
                        //    命中则只高亮 constructor；否则保持原 range 全部高亮。
                        if (!isSingleWord) {
                            const m = rangeText.match(/\bconstructor\b/);
                            if (m && typeof m.index === 'number') {
                                const startModelOffset = model.getOffsetAt({
                                    lineNumber: hlStartLine,
                                    column: hlStartCol
                                });
                                const startPos = model.getPositionAt(startModelOffset + m.index);
                                const endPos = model.getPositionAt(startModelOffset + m.index + m[0].length);
                                hlStartLine = startPos.lineNumber;
                                hlStartCol = startPos.column;
                                hlEndLine = endPos.lineNumber;
                                hlEndCol = endPos.column;
                            } else {
                                hlEndLine = hlStartLine;
                                hlEndCol = hlStartCol;
                            }
                        }
                    } catch (e) {
                        // 任意异常都回落到原 range
                    }

                    // 添加符号高亮装饰
                    state.symboleDecorations = editor.deltaDecorations(state.symboleDecorations, [{
                        range: new monaco.Range(hlStartLine, hlStartCol, hlEndLine, hlEndCol),
                        options: {
                            className: 'highlighted-symbol-range',
                            inlineClassName: 'highlighted-symbol-inline',
                            // 设置高优先级，覆盖Monaco的自动装饰
                            zIndex: 100,
                            // 阻止Monaco的自动高亮装饰影响
                            overviewRuler: {
                                color: '#198844',
                                position: monaco.editor.OverviewRulerLane.Full
                            }
                        }
                    }]);
                }

                if (curLine && curLine > 0) {
                    // 优先用精确列，把光标放回当初点出去的那个 token（如 HasInput）；没有列才退回行尾。
                    const lineMaxColumn = model.getLineMaxColumn(curLine);
                    const targetColumn = (typeof curColumn === 'number' && curColumn >= 0)
                        ? Math.min(curColumn, lineMaxColumn)
                        : lineMaxColumn;
                    editor.setPosition(new monaco.Position(
                        curLine,
                        lineMaxColumn
                    ));
                    // 显式高亮落点 token。不能指望 Monaco 的同词高亮来表达「选中」：
                    // 它只认光标所在的词，光标差一列就框到旁边的标识符上（这正是返回后框跑到 this 的原因），
                    // 所以 occurrencesHighlight 已在 main.js 里关掉，这里由我们按词范围精确画。
                    const returnWord = model.getWordAtPosition({
                        lineNumber: curLine,
                        column: targetColumn
                    });
                    if (returnWord) {
                        refreshReturnTokenStyle();
                        state.returnTokenDecorations = editor.deltaDecorations(state.returnTokenDecorations || [], [{
                            range: new monaco.Range(
                                curLine, returnWord.startColumn,
                                curLine, returnWord.endColumn
                            ),
                            options: { className: 'cw-return-token', zIndex: 90 }
                        }]);
                    }
                } else {
                    // editor.setSelection({
                    //     startLineNumber: range.end.line + 1,
                    //     startColumn: range.end.character + 1,
                    //     endLineNumber: range.end.line + 1,
                    //     endColumn: range.end.character + 1
                    // });
                    editor.setPosition(new monaco.Position(
                        0, // hlStartLine,
                        0 //hlStartCol
                    ));
                }

                hideCursor();
            }
            // 内容/语言更新完成后，按当前开关与语言重算指令高亮（#include 等）
            applyDirectiveDecorations();
        } else {
            console.error('[definition] Editor not initialized');
        }

        document.querySelector('.progress-container').style.display = 'none';
    };

    // 暴露 forceRetokenize，供 main.js 在 setupTextmate 完成（grammar 注册）后，对「首屏即已渲染、
    // 当时 grammar 未就绪」的当前 model 触发一次可靠重分词（覆盖内容先于 textmate 初始化到达的竞态）。
    updateEditorContent.forceRetokenize = forceRetokenize;
    // 暴露指令高亮重算入口，供 main.js 在 fixToken 开关 / 配色变更（updateContextEditorCfg）后即时刷新
    updateEditorContent.applyDirectiveDecorations = applyDirectiveDecorations;
    updateEditorContent.revealCurrent = revealCurrent;
    // 「No symbol found.」之类的占位文本只能写进 scratch model，不能覆盖停放的大文件。
    updateEditorContent.useScratchModel = (languageId) => {
        const target = useScratchModel(languageId);
        state.renderedContentKey = '';
        return target.model;
    };
    updateEditorContent.dropModel = dropBigModel;
    return updateEditorContent;
}

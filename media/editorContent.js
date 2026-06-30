//@ts-check

// 编辑器内容更新逻辑：设置 model / 语言 / 缩进、清理与重建装饰高亮、
// 滚动定位到目标行、刷新 sticky scroll 等。
// 以工厂函数形式创建，通过 ctx 共享 editor 引用、可变会话状态（state）与若干回调。
// monaco / document 直接使用全局对象（与其它模块一致）。

export function createUpdateEditorContent(ctx) {
    const { editor, state, applyIndentationForModel, updateFilenameDisplay, hideCursor, ensureGrammar } = ctx;

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

    // 刷新 sticky scroll（顶部粘附的函数/类标题行）。
    //
    // 背景与根因：Monaco 的 sticky 控制器在 model 被「整体替换」（forceRetokenize 重建 model）后，
    // 不会自动重建粘附渲染——新 model 的符号树（OutlineModel，来自 DocumentSymbolProvider）需异步重算，
    // 而控制器没有被重新触发，导致 TS/JS 等语言顶部粘附行彻底消失。
    //
    // 注意：不能同步「disable→enable」——同一帧内连续两次 updateOptions 会被 Monaco 的选项 diff 合并，
    // 净值不变即视为无变化，刷新无效。必须跨一个渲染帧再 enable，让控制器真正重建并重新向符号 provider 取数。
    function refreshStickyScroll() {
        const cur = editor.getOption(monaco.editor.EditorOption.stickyScroll);
        if (!cur || !cur.enabled) { return; }
        editor.updateOptions({ stickyScroll: { enabled: false } });
        setTimeout(() => {
            // 保留原有子选项（maxLineCount / defaultModel / scrollWithEditor），仅借开关重建控制器
            editor.updateOptions({
                stickyScroll: {
                    enabled: true,
                    maxLineCount: cur.maxLineCount,
                    defaultModel: cur.defaultModel,
                    scrollWithEditor: cur.scrollWithEditor
                }
            });
            editor.layout();
        }, 0);
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

            const fresh = monaco.editor.createModel(value, lang);
            applyIndentationForModel(fresh);
            editor.setModel(fresh);
            if (viewState) { editor.restoreViewState(viewState); }

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

    const updateEditorContent = function updateEditorContent(newContent, options) {
        //console.log('[definition] Updating editor content with options:', options);
        const {
            newUri,
            languageId,
            range,
            curLine
        } = options || {};

        // 显示编辑器，隐藏原始内容区域
        document.getElementById('container').style.display = 'block';
        document.getElementById('main').style.display = 'none';

        //console.log('[definition] Updating editor content with range:', range);

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

            // 避免Monaco将旧装饰迁移到新内容的相同位置
            if (state.symboleDecorations.length > 0) {
                state.symboleDecorations = editor.deltaDecorations(state.symboleDecorations, []);
            }
            if (state.activeLineDecorations.length > 0) {
                state.activeLineDecorations = editor.deltaDecorations(state.activeLineDecorations, []);
            }

            if (!model) {
                // 创建新模型
                model = monaco.editor.createModel(newContent || '', languageId || 'plaintext');
                editor.setModel(model);
                //console.log('[definition] create Model content updated');
            } else {
                // 更新现有模型
                // 如果语言变了，更新语言
                if (model.getLanguageId() !== languageId && languageId) {
                    monaco.editor.setModelLanguage(model, languageId);
                }
                // 更新内容（只有在内容变化时才更新）
                if (newContent && model.getValue() !== newContent) {
                    //console.log('[definition] Model content updated');
                    model.setValue(newContent);
                }
            }

            applyIndentationForModel(model);

            const lineCount = model.getLineCount();
            const requiredChars = Math.max(1, lineCount.toString().length);

            editor.updateOptions({ lineNumbersMinChars: requiredChars });
            // 强制刷新 sticky scroll（跨渲染帧 disable→enable），更新顶部粘附行显示
            refreshStickyScroll();
            editor.layout();

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
                editor.revealLineInCenter(targetLine);

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
                    const lineMaxColumn = editor.getModel().getLineMaxColumn(curLine);
                    editor.setPosition(new monaco.Position(
                        curLine,
                        lineMaxColumn
                    ));
                } else {
                    // editor.setSelection({
                    //     startLineNumber: range.end.line + 1,
                    //     startColumn: range.end.character + 1,
                    //     endLineNumber: range.end.line + 1,
                    //     endColumn: range.end.character + 1
                    // });
                    editor.setPosition(new monaco.Position(
                        hlEndLine,
                        hlEndCol
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
    return updateEditorContent;
}

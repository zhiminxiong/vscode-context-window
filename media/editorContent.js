//@ts-check

// 编辑器内容更新逻辑：设置 model / 语言 / 缩进、清理与重建装饰高亮、
// 滚动定位到目标行、刷新 sticky scroll 等。
// 以工厂函数形式创建，通过 ctx 共享 editor 引用、可变会话状态（state）与若干回调。
// monaco / document 直接使用全局对象（与其它模块一致）。

export function createUpdateEditorContent(ctx) {
    const { editor, state, applyIndentationForModel, updateFilenameDisplay, hideCursor } = ctx;

    return function updateEditorContent(newContent, options) {
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
            // 强制刷新 sticky scroll 以更新装饰器显示
            // 获取当前 sticky scroll 设置
            const currentStickyScroll = editor.getOption(monaco.editor.EditorOption.stickyScroll);
            if (currentStickyScroll && currentStickyScroll.enabled) {
                // 先禁用
                editor.updateOptions({
                    stickyScroll: { enabled: false }
                });
                // 立即重新启用，触发重新渲染
                editor.updateOptions({
                    stickyScroll: currentStickyScroll
                });
            }
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
            if (range.start) {
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
        } else {
            console.error('[definition] Editor not initialized');
        }

        document.querySelector('.progress-container').style.display = 'none';
    };
}

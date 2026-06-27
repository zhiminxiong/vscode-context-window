//@ts-check

// 编辑器鼠标交互逻辑：悬停高亮（onMouseMove + mouseleave 清理）与点击跳转 / 取色（onMouseUp）。
// 以 setup 形式创建，内部持有悬停高亮的可变状态（currentDecorations / lastWordKey），
// 并完成 onMouseMove / onMouseUp / mouseleave 的事件注册。
// 通过 ctx 共享 editor 引用、可变会话状态（state）、主题色标志（light）、vscode 通信对象，
// 以及缩进、光标显隐等回调。monaco / document / window 直接使用全局对象（与其它模块一致）。

import { getTokenColorFromDOM } from './colorUtils.js';
import { requestTokenStyle } from './tokenStyleClient.js';
import { pickTokenStyle } from './tokenPicker.js';
import { tokenAtPosition } from './tokenize.js';

export function setupEditorMouseHandlers(ctx) {
    const {
        editor,
        state,
        light,
        vscode,
        applyIndentationForModel,
        forcePointerCursor,
        showCursor,
        hideCursor
    } = ctx;

    // 悬停高亮的可变状态
    let currentDecorations = [];
    // 记录上一次高亮的单词，范围未变则跳过 deltaDecorations，避免在同一单词上抖动时反复重画
    let lastWordKey = '';

    // 性能优化：mouseleave 监听只在初始化时绑定一次，避免每次移动到新单词都堆叠 once 监听器（监听器泄漏）
    const editorDomForLeave = editor.getDomNode();
    if (editorDomForLeave) {
        editorDomForLeave.addEventListener('mouseleave', () => {
            if (currentDecorations.length) {
                currentDecorations = editor.deltaDecorations(currentDecorations, []);
            }
            lastWordKey = '';
        });
    }

    function handleEditorMouseMove(e) {
        // 默认使用默认光标
        let isOverText = false;

        // 获取当前单词
        const model = editor.getModel();
        const position = e.target.position;
        if (model && position && e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT) {
            const word = model.getWordAtPosition(position);
            if (word) {
                // 鼠标悬停在文本上，使用手型光标
                isOverText = true;
                // 单词范围未变化则不重复重画装饰
                const key = position.lineNumber + ':' + word.startColumn + ':' + word.endColumn;
                if (key !== lastWordKey) {
                    lastWordKey = key;
                    currentDecorations = editor.deltaDecorations(currentDecorations, [{
                        range: new monaco.Range(
                        position.lineNumber,
                        word.startColumn,
                        position.lineNumber,
                        word.endColumn
                        ),
                        options: {
                            inlineClassName: light ? 'ctrl-hover-link' : 'ctrl-hover-link-dark'
                        }
                    }]);
                }
            }
        }

        if (!isOverText && lastWordKey) {
            // 离开文本区域，清除装饰
            currentDecorations = editor.deltaDecorations(currentDecorations, []);
            lastWordKey = '';
        }
        // 根据鼠标位置更新光标样式
        forcePointerCursor(isOverText);
        return true;
    }

    // 处理链接点击事件 - 在Monaco内部跳转
    async function handleEditorMouseUp(e) {
        //console.log('[definition] Mouse up event:', e.target, e.event);
        // 完全阻止事件传播
        //e.event.preventDefault();
        //e.event.stopPropagation();
        // 使用 e.event.buttons 判断鼠标按键
        //const isLeftClick = (e.event.buttons & 1) === 1; // 左键
        //const isRightClick = (e.event.buttons & 2) === 2; // 右键

        if (e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT) {
            // 获取当前单词
            let model = editor.getModel();
            if (!model) {
                //console.log('[definition] **********************no model found************************');
                model = monaco.editor.createModel(state.content, state.language);
                applyIndentationForModel(model);
                editor.setModel(model);
            }
            const position = e.target.position;
            // 检查点击位置是否在当前选择范围内
            const selection = editor.getSelection();
            const isClickedTextSelected = selection && !selection.isEmpty() && selection.containsPosition(position);
            if (model && position && !isClickedTextSelected) {
                //console.log('[definition] start to mid + jump definition: ', e);
                const word = model.getWordAtPosition(position);
                if (word) {
                    if (e.event.rightButton) {
                        //console.log('[definition] start to mid + jump definition: ', word);
                        if (window.pickTokenStyle) {
                            let tokenInfo = tokenAtPosition(model, editor, position);
                            if (tokenInfo && tokenInfo.token) {
                                //console.log('[definition] pickColor action for token:', tokenInfo);
                                try {
                                    const style = await requestTokenStyle(tokenInfo.token);
                                    let token = tokenInfo.token;
                                    if (!style || !style.found) {
                                        const lastDot = tokenInfo.token.lastIndexOf('.');
                                        token = lastDot > 0 ? tokenInfo.token.slice(0, lastDot) : tokenInfo.token;
                                    }
                                    //console.log('[definition] token style:', style);
                                    const newStyle = await pickTokenStyle({
                                        token,
                                        foreground: style?.foreground,
                                        fontStyle: style?.fontStyle,
                                        description: style?.description
                                    }, getTokenColorFromDOM(editor, position) || '#808080', word.word);
                                    //console.log('[definition] picked new style:', newStyle);
                                    if (newStyle) {
                                        // 回传扩展端，后续用于更新规则
                                        vscode.postMessage({
                                            type: 'tokenStyle.set',
                                            newStyle,
                                            token
                                        });
                                    }
                                } catch (err) {
                                    console.error('[context-window] pickColor action failed:', err);
                                }
                            }
                        } else {
                            editor.setSelection({
                                startLineNumber: position.lineNumber,
                                startColumn: word.startColumn,
                                endLineNumber: position.lineNumber,
                                endColumn: word.endColumn
                            });
                            hideCursor();
                        }
                    } else if (e.event.leftButton) {
                        //console.log(`[definition] start to jump definition: ${word} with uri ${uri}`);
                        vscode.postMessage({
                            type: 'jumpDefinition',
                            uri: state.uri,
                            token: word.word,
                            position: {
                                line: position.lineNumber - 1,
                                character: position.column - 1
                            }
                        });
                    }
                }
            }
        } else {
            if (e.event.rightButton) {
                editor.focus();
                showCursor();
            }
        }
        return true;
    }

    editor.onMouseMove(handleEditorMouseMove);
    editor.onMouseUp(handleEditorMouseUp);

    return { handleEditorMouseMove, handleEditorMouseUp };
}

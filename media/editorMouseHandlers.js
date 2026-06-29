//@ts-check

// 编辑器鼠标交互逻辑：悬停高亮（onMouseMove + mouseleave 清理）与点击跳转 / 取色（onMouseUp）。
// 以 setup 形式创建，内部持有悬停高亮的可变状态（currentDecorations / lastWordKey），
// 并完成 onMouseMove / onMouseUp / mouseleave 的事件注册。
// 通过 ctx 共享 editor 引用、可变会话状态（state）、主题色标志（light）、vscode 通信对象，
// 以及缩进、光标显隐等回调。monaco / document / window 直接使用全局对象（与其它模块一致）。

import { getTokenColorFromDOM } from './colorUtils.js';
import { requestTokenStyle } from './tokenStyleClient.js';
import { pickTokenStyle } from './tokenPicker.js';
import { tokenAtPosition, semanticTokenAtPosition } from './tokenize.js';
import { getScopeAtPosition } from './textmateClient.js';
import { getTokenStyleSource } from './editorTheme.js';

export function setupEditorMouseHandlers(ctx) {
    const {
        editor,
        state,
        light,
        vscode,
        applyIndentationForModel,
        forcePointerCursor,
        showCursor,
        hideCursor,
        semanticState
    } = ctx;

    // 悬停高亮的可变状态
    let currentDecorations = [];
    // 记录上一次高亮的单词，范围未变则跳过 deltaDecorations，避免在同一单词上抖动时反复重画
    let lastWordKey = '';

    // 兼容读取点击次数：优先 Monaco IMouseEvent.detail，回退到原生 browserEvent.detail。
    // 用它在 onMouseUp 里识别双击——原生 DOM dblclick 在 Monaco 虚拟化内容上常因两次点击落在
    // 被重渲染替换的不同 DOM 节点而无法合成；而 detail（点击计数）来自输入层，不受 DOM 重建影响。
    const getClickCount = (e) => {
        const ev = e && e.event;
        if (!ev) { return 1; }
        return ev.detail || (ev.browserEvent && ev.browserEvent.detail) || 1;
    };

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
                            // 取色一律按「用户看到的高亮单词」的起始列做 token 查找，而非鼠标原始点击列。
                            // 原因：getWordAtPosition 对词尾边界是包含的（点在 if 右边缘仍判定为 if），
                            // 而各 token 查找用的是右开区间 [startIndex, endIndex)，原始点击列若落在词尾边界，
                            // 会命中相邻的空白/标点 token，取到其容器 scope（如 meta.block.ts）而非关键字本身
                            // （keyword.control.conditional.ts）——这正是「偶现取错 token、改色后无变化」的根因。
                            // 用 word.startColumn（单词首字符列）可确定性命中单词自身的 token。
                            const lookupPosition = {
                                lineNumber: position.lineNumber,
                                column: word.startColumn
                            };
                            // 优先用后端语义 token 识别（右键即可知道该标识符的语义类型，如 variable/function/class）；
                            // 该位置无语义 token（如关键字/操作符走基础层）时，回退到 Monaco 基础 tokenizer。
                            let tokenInfo = (semanticState && semanticState.data)
                                ? semanticTokenAtPosition(lookupPosition, semanticState)
                                : null;
                            if (!tokenInfo || !tokenInfo.token) {
                                // 方案 B：优先用真实 TextMate 语法取该位置的 scope（如 storage.type.struct.cpp），
                                // 与编辑器渲染同源；grammar 未就绪/未启用时回退到 Monaco 基础 tokenizer。
                                let tm = null;
                                if (window.ctxTextmate && window.ctxTextmate.enabled) {
                                    const sc = getScopeAtPosition(model, lookupPosition);
                                    if (sc && sc.picked) {
                                        tm = {
                                            token: sc.picked,
                                            startColumn: sc.startColumn,
                                            endColumn: sc.endColumn,
                                            text: sc.text,
                                            textmate: true // 标记：真实 TextMate scope，展示/写入用完整 scope，不做语言后缀裁剪
                                        };
                                    }
                                }
                                tokenInfo = tm || tokenAtPosition(model, editor, lookupPosition);
                            }
                            if (tokenInfo && tokenInfo.token) {
                                //console.log('[definition] pickColor action for token:', tokenInfo);
                                try {
                                    // 语义 token 会带 modifiers 数组；Monarch 回退 token 不带
                                    const isSemantic = Array.isArray(tokenInfo.modifiers);
                                    let token, style;
                                    if (isSemantic) {
                                        // 与 Monaco 内部 getTokenStyleMetadata 一致：
                                        // 把「类型 + 修饰符」拼成 "type.mod1.mod2"（如 parameter.declaration），
                                        // 右键即可看到带修饰符的完整身份，并能针对它单独配色。
                                        // requestTokenStyle 内部已按最长前缀匹配用户规则、并回退到前端默认语义规则
                                        // （含 *.declaration 系列），故此处直接取其结果作初值，写回目标仍是完整名。
                                        token = tokenInfo.modifiers.length
                                            ? [tokenInfo.token].concat(tokenInfo.modifiers).join('.')
                                            : tokenInfo.token;
                                        // 语义 token：按 VSCode 选择器匹配（类型 + 修饰符子集）
                                        style = await requestTokenStyle(token, true);
                                    } else {
                                        // 基础语法层 token：TextMate 前缀匹配。
                                        style = await requestTokenStyle(tokenInfo.token, false);
                                        token = tokenInfo.token;
                                        // 方案 B 的真实 TextMate scope（如 storage.type.struct.cpp）已是可渲染的完整 scope，
                                        // 保持完整展示/写入（对齐 VSCode）；仅对 Monarch 基础 token 在无规则时裁剪语言后缀。
                                        if (!tokenInfo.textmate && (!style || !style.found)) {
                                            const lastDot = tokenInfo.token.lastIndexOf('.');
                                            token = lastDot > 0 ? tokenInfo.token.slice(0, lastDot) : tokenInfo.token;
                                        }
                                    }
                                    //console.log('[definition] token style:', style);
                                    // 计算当前生效 token 的来源：自定义 > 语义/textmate > monaco，
                                    // 供取色面板展示（monaco/语义/textmate/自定义）。
                                    const source = getTokenStyleSource(token, isSemantic, !!tokenInfo.textmate);
                                    const newStyle = await pickTokenStyle({
                                        token,
                                        foreground: style?.foreground,
                                        fontStyle: style?.fontStyle,
                                        description: style?.description,
                                        source
                                    }, getTokenColorFromDOM(editor, lookupPosition) || '#808080', word.word);
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
            } else if (e.event.leftButton && getClickCount(e) >= 2) {
                // 在「空白处」（非文本：CONTENT_EMPTY 等）双击 → 让 VSCode 主编辑区定位到当前上下文行。
                // 空白处没有单词，天然不会进入上面的 jumpDefinition 分支，故无需防抖即可与单击跳转共存。
                // 走 Monaco 的 onMouseUp（点击计数可靠），替代此前失效的原生 DOM dblclick。
                vscode.postMessage({
                    type: 'doubleClick',
                    location: 'bottomArea'
                });
            }
        }
        return true;
    }

    editor.onMouseMove(handleEditorMouseMove);
    editor.onMouseUp(handleEditorMouseUp);

    return { handleEditorMouseMove, handleEditorMouseUp };
}

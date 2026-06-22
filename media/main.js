//@ts-check

// 导入语言配置与各功能模块
import { languageConfig_js, languageConfig_cpp, languageConfig_cs, languageConfig_go, createDocumentSymbolProvider } from './languageConfig.js';
import { getTokenColorFromDOM } from './colorUtils.js';
import { requestTokenStyle } from './tokenStyleClient.js';
import { pickTokenStyle, resetPickColorPosition } from './tokenPicker.js';
import { tokenAtPosition } from './tokenize.js';
import { applyMonacoTheme, isLightTheme } from './editorTheme.js';
import { injectEditorStyles } from './editorStyles.js';
import { createDefinitionList } from './definitionList.js';
import { createUpdateEditorContent } from './editorContent.js';

const fileContentCache = new Map();  // uri -> { version, content, metadata }

// 颜色工具、token 样式请求、颜色选择弹窗、分词、内容更新等已抽离到独立模块（见顶部 import）
// 编辑器的可变会话状态（uri/content/language 与两类装饰）统一收拢到 editorState 共享对象

// Monaco Editor 初始化和消息处理
(function() {
    const vscode = acquireVsCodeApi();
    window.vscode = vscode;
    window.isPinned = false;
    window.pickTokenStyle = false;
    window.stickyScroll = false;
    //console.log('[definition] WebView script started from main.js');

    // 确保 WebView 使用 VS Code 的颜色主题
    //document.body.classList.add('vscode-light', 'vscode-dark', 'vscode-high-contrast');
    
    // 显示加载状态
    document.getElementById('main').style.display = 'block';
    document.getElementById('main').innerHTML = '';
    document.getElementById('container').style.display = 'none';
    
    // 添加错误处理
    window.onerror = function(message, source, lineno, colno, error) {
        console.error('[definition] Global error:', message, 'at', source, lineno, colno, error);
        document.getElementById('main').style.display = 'block';
        document.getElementById('main').innerHTML = `<div style="color: var(--vscode-errorForeground); font-size: var(--vscode-editor-font-size);">load error: ${message}</div>`;
        return true;
    };
    
    try {
        // 尝试从window对象获取Monaco路径
        const monacoPath = window.monacoScriptUri || '../node_modules/monaco-editor/min/vs';
        //console.log('[definition] Using Monaco path:', monacoPath);

        let detectIndent = false;

        // 添加高亮样式（已抽离到 editorStyles.js）
        injectEditorStyles();
        
        // 动态加载Monaco loader.js
        const loaderScript = document.createElement('script');
        loaderScript.src = `${monacoPath}/loader.js`;
        loaderScript.onload = function() {
            //console.log('[definition] Monaco loader.js loaded');
            
            // 现在可以安全地使用require
            require.config({ 
                paths: { 'vs': monacoPath }
            });
            
            //console.log('[definition] Require.js configured, attempting to load Monaco');
            
            // 初始化编辑器
            require(['vs/editor/editor.main'], function() {
                //console.log('[definition] Monaco editor loaded');
                // applyMonacoTheme / isLightTheme 已抽离到 editorTheme.js（见顶部 import）

                const contextEditorCfg = window.vsCodeEditorConfiguration.contextEditorCfg || {};
                let light = isLightTheme();

                // 如果有自定义主题规则
                if (window.vsCodeEditorConfiguration && window.vsCodeEditorConfiguration.customThemeRules) {
                    // 定义自定义主题
                    applyMonacoTheme(window.vsCodeEditorConfiguration, contextEditorCfg, light);
                    
                    // 使用自定义主题
                    window.vsCodeTheme = 'custom-vs';
                }
                
                // 隐藏加载状态，显示编辑器容器
                document.getElementById('main').style.display = 'none';
                document.getElementById('main-container').style.display = 'flex';
                
                // 初始化时显示Monaco编辑器（显示"Ready for content."）
                document.getElementById('container').style.display = 'block';
                document.getElementById('main').style.display = 'none';
                
                try {
                    //console.log('[definition] editor settings: ', window.vsCodeEditorConfiguration);
                    //console.log('[definition] theme settings: ', window.vsCodeTheme);

                    var openerService = {
                        open: function (resource, options) {
                            // do something here, resource will contain the Uri
                            //console.log('[definition] open service: ', resource);
                        }
                    };

                    let defaultTabSize = 4;
                    let defaultInsertSpaces = true;

                    // 处理 VS Code 编辑器配置
                    const createEditorOptions = () => {
                        const vsCodeConfig = window.vsCodeEditorConfiguration?.editorOptions || {};
                        vsCodeConfig.fontSize = contextEditorCfg.fontSize || vsCodeConfig.fontSize;
                        vsCodeConfig.fontFamily = contextEditorCfg.fontFamily || vsCodeConfig.fontFamily;
                        vsCodeConfig.minimap = { enabled: contextEditorCfg.minimap };
                        
                        // 基础配置
                        const baseOptions = {
                            value: 'Ready for content.',
                            language: 'plaintext',
                            readOnly: true,
                            theme: window.vsCodeTheme || 'vs',
                            automaticLayout: true
                        };

                        // 从 VS Code 配置中提取相关选项
                        const {
                            fontSize,
                            fontFamily,
                            lineHeight,
                            letterSpacing,
                            tabSize,
                            insertSpaces,
                            wordWrap,
                            minimap,
                            scrollBeyondLastLine,
                            lineNumbers,
                            renderWhitespace,
                            cursorStyle,
                            cursorWidth,
                            cursorBlinking,
                            links,
                            mouseWheelZoom,
                            smoothScrolling,
                            tokenColorCustomizations,
                            detectIndentation,
                            ...otherOptions
                        } = vsCodeConfig;

                        detectIndent = detectIndentation ?? false;
                        defaultTabSize = typeof tabSize === 'number' ? tabSize : 4;
                        defaultInsertSpaces = typeof insertSpaces === 'boolean' ? insertSpaces : true;

                        return {
                            ...baseOptions,
                            // 字体相关
                            fontSize,
                            fontFamily,
                            lineHeight,
                            letterSpacing,
                            // 编辑器行为
                            tabSize,
                            detectIndentation: detectIndent,
                            insertSpaces,
                            wordWrap,
                            // 视图选项
                            minimap: minimap || { enabled: false },
                            scrollBeyondLastLine: scrollBeyondLastLine ?? false,
                            lineNumbers: lineNumbers || 'on',
                            lineNumbersMinChars: 1,
                            renderWhitespace: renderWhitespace || 'all',
                            // 光标选项
                            cursorStyle: 'pointer',
                            mouseStyle: 'pointer',
                            smoothScrolling: smoothScrolling ?? true,
                            tokenColorCustomizations,
                            // 其他有效选项
                            ...otherOptions,
                            hover: {
                                enabled: true,
                                above: true,
                                delay: 200,
                                sticky: true
                            },
                            // 启用快速建议
                            quickSuggestions: true,
                            // 启用导航历史
                            history: {
                                undoStopAfter: false,
                                undoStopBefore: false
                            }
                        };
                    };

                    function applyIndentationForModel(model) {
                        if (!model) return;
                        if (detectIndent) {
                            //让 Monaco 按 Vs Code 策略检测，并以 Vs Code 的默认值作为回退
                            model.detectIndentation(defaultInsertSpaces, defaultTabSize);
                        } else {
                            //跟随 VS Code 明确配置
                            model.updateOptions({ insertSpaces: defaultInsertSpaces, tabSize: defaultTabSize });
                        }
                    }

                    // 创建编辑器实例
                    const editor = monaco.editor.create(document.getElementById('container'), createEditorOptions(),
                    {
                        openerService: openerService
                    });

                    const currentStickyScroll = editor.getOption(monaco.editor.EditorOption.stickyScroll);
                    window.stickyScroll = currentStickyScroll?.enabled;

                    // 编辑器可变会话状态（供 onMouseUp / 消息处理 / 内容更新等多处共享读写）
                    const editorState = {
                        uri: '',
                        content: '',
                        language: '',
                        activeLineDecorations: [],
                        symboleDecorations: []
                    };

                    // 添加ResizeObserver来监听容器大小变化（仅用于拖拽分隔条时重新布局）
                    const containerElement = document.getElementById('container');
                    if (containerElement && window.ResizeObserver) {
                        const resizeObserver = new ResizeObserver(() => {
                            // 当容器大小变化时，重新布局Monaco编辑器
                            if (editor) {
                                editor.layout();
                            }
                        });
                        resizeObserver.observe(containerElement);
                        
                        // 确保在编辑器销毁时清理ResizeObserver
                        editor.onDidDispose(() => {
                            resizeObserver.disconnect();
                        });
                    }

                    // 添加禁用选择的配置
                    editor.updateOptions({
                        readOnly: true,
                        domReadOnly: false,
                        mouseStyle: 'pointer',
                        cursorWidth: 0,
                        selectOnLineNumbers: true,
                        selectionClipboard: true,    // 禁用选择到剪贴板
                        contextmenu: false,           // 禁用右键菜单
                        links: false,  // 禁用所有链接功能
                        quickSuggestions: false,  // 禁用快速建议
                        keyboardHandler: null,       // 禁用键盘处理
                        find: {                     // 禁用查找功能
                            addExtraSpaceOnTop: false,
                            autoFindInSelection: 'never',
                            seedSearchStringFromSelection: 'select'
                        }
                    });

                    // 1) DOM 捕获阶段拦截 Ctrl/Cmd + 鼠标，先于 Monaco 内部监听器
                    const dom = editor.getDomNode();
                    // 'pointerdown', 'mousedown', 'mouseup', 'click', 
                    ['auxclick', 'dblclick'].forEach(type => {
                    dom.addEventListener(type, (ev) => {
                        if (ev.ctrlKey || ev.metaKey) {
                            ev.preventDefault();
                            ev.stopImmediatePropagation();
                            return false;
                        }
                    }, { capture: true });
                    });

                    // 2) 兜底：屏蔽所有“打开编辑器/跳转”调用
                    if (editor._codeEditorService && typeof editor._codeEditorService.openCodeEditor === 'function') {
                        editor._codeEditorService.openCodeEditor = function() {
                            return Promise.resolve(null); // 不进行任何跳转
                        };
                    }

                    // 3) 可选：直接卸载相关内置贡献（能找到就 dispose）
                    [
                        'editor.contrib.gotodefinitionatposition',
                        'editor.contrib.gotodefinition',
                        'editor.contrib.linkDetector',
                        'editor.contrib.link',
                        'editor.contrib.peek',
                        'editor.contrib.referencesController'
                    ].forEach(id => {
                        try {
                            const contrib = editor.getContribution && editor.getContribution(id);
                            contrib && contrib.dispose && contrib.dispose();
                        } catch (_) {}
                    });

                    // 强制设置鼠标样式
                    const forcePointerCursor = (isOverText = false) => {
                        const editorContainer = editor.getDomNode();
                        if (editorContainer) {
                            // 根据是否悬停在文本上设置不同的光标样式
                            const cursorStyle = isOverText ? 'pointer' : 'default';
                            editorContainer.style.cursor = cursorStyle;
                            
                            // 遍历所有子元素，设置光标样式
                            const elements = editorContainer.querySelectorAll('*');
                            elements.forEach(el => {
                                el.style.cursor = cursorStyle;
                            });
                        }
                    };

                    // 初始化时设置为默认光标
                    forcePointerCursor(false);

                    // ========== 动态光标显示/隐藏功能 ==========
                    let cursorHideTimer = null;
                    const CURSOR_HIDE_DELAY = 5000; // 5秒后隐藏光标（可调整）

                    // 显示光标
                    function showCursor() {
                        const editorDom = editor.getDomNode();
                        if (editorDom) {
                            editorDom.classList.add('cursor-active');
                        }
                        
                        // 清除之前的隐藏计时器
                        if (cursorHideTimer) {
                            clearTimeout(cursorHideTimer);
                            cursorHideTimer = null;
                        }
                        
                        // 设置新的隐藏计时器（可选：如果不想自动隐藏，注释掉这部分）
                        cursorHideTimer = setTimeout(() => {
                            hideCursor();
                        }, CURSOR_HIDE_DELAY);
                    }

                    // 隐藏光标
                    function hideCursor() {
                        const editorDom = editor.getDomNode();
                        if (editorDom) {
                            editorDom.classList.remove('cursor-active');
                        }
                        if (cursorHideTimer) {
                            clearTimeout(cursorHideTimer);
                            cursorHideTimer = null;
                        }
                    }

                    // 监听键盘输入事件
                    editor.onKeyDown((e) => {
                        showCursor();
                    });

                    editor.onKeyUp((e) => {
                        showCursor();
                    });

                    // 监听鼠标点击事件
                    editor.onMouseDown((e) => {
                        // 只在点击编辑器内容区域时显示光标
                        if (e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT ||
                            e.target.type === monaco.editor.MouseTargetType.CONTENT_EMPTY) {
                            showCursor();
                        }
                    });

                    // 监听编辑器获得焦点
                    editor.onDidFocusEditorText(() => {
                        //showCursor();
                    });

                    // 监听编辑器失去焦点时隐藏光标
                    editor.onDidBlurEditorText(() => {
                        //hideCursor();
                    });

                    // 监听光标位置变化（用户通过键盘或鼠标移动光标）
                    editor.onDidChangeCursorPosition((e) => {
                        // 只有在用户主动操作时才显示光标
                        // source可能是: 'keyboard', 'mouse', 'api', 'paste', 'undo', 'redo'
                        if (e.source === 'keyboard' || e.source === 'mouse') {
                            showCursor();
                        }
                    });

                    // 监听内容变化（用户输入）
                    editor.onDidChangeModelContent((e) => {
                        // 只有在用户主动输入时才显示光标（排除程序设置内容）
                        if (!e.isFlush && !e.isRedoing && !e.isUndoing) {
                            showCursor();
                        }
                    });

                    // 初始状态：隐藏光标
                    hideCursor();
                    // ========== 动态光标显示/隐藏功能结束 ==========

                    if (!contextEditorCfg.useDefaultTokenizer) {
                        // 定义使用JavaScript提供器作为默认的语言列表
                        const defaultLanguages = [
                            'python', 'java', 'rust', 'php', 'ruby', 'swift', 'kotlin', 'perl', 'lua', 'vb', 'vbnet', 'cobol', 'fortran', 'pascal', 'delphi', 'ada',
                            'erlang', 
                        ];

                        // 为默认语言设置JavaScript提供器
                        defaultLanguages.forEach(lang => {
                            monaco.languages.setMonarchTokensProvider(lang, languageConfig_js);
                        });

                        // 为 JavaScript 定义自定义 token 提供器
                        monaco.languages.setMonarchTokensProvider('javascript', languageConfig_js);
                        monaco.languages.setMonarchTokensProvider('typescript', languageConfig_js);

                        // 为 C/C++ 定义自定义 token 提供器
                        monaco.languages.setMonarchTokensProvider('cpp', languageConfig_cpp);
                        monaco.languages.setMonarchTokensProvider('c', languageConfig_cpp);

                        monaco.languages.setMonarchTokensProvider('csharp', languageConfig_cs);
                        monaco.languages.setMonarchTokensProvider('go', languageConfig_go);
                    }

                    // 为 C++, C, C# 注册 Document Symbol Provider（从 languageConfig.js 导入）
                    if (contextEditorCfg.fixStickyScroll) {
                        monaco.languages.registerDocumentSymbolProvider('cpp', createDocumentSymbolProvider(monaco));
                        monaco.languages.registerDocumentSymbolProvider('c', createDocumentSymbolProvider(monaco));
                        monaco.languages.registerDocumentSymbolProvider('csharp', createDocumentSymbolProvider(monaco));
                    }

                    //editor.onDidScrollChange(forcePointerCursor);
                    //editor.onDidChangeConfiguration(forcePointerCursor);

                    // 检查readOnly设置
                    //console.log('[definition]cursor type:', editor.getOption(monaco.editor.EditorOption.mouseStyle));

                    // 完全禁用键盘事件
                    // editor.onKeyDown((e) => {
                    //     // 允许 Ctrl+C 复制操作
                    //     // if (e.ctrlKey && e.code === 'KeyC') {
                    //     //     return;
                    //     // }
                    //     // e.preventDefault();
                    //     // e.stopPropagation();
                    // });

                    // 完全禁用选择
                    // editor.onDidChangeCursorSelection(() => {
                    //     // 获取当前光标位置
                    //     const position = editor.getPosition();
                    //     if (position) {
                    //         // 将选择范围设置为光标所在位置
                    //         editor.setSelection({
                    //             startLineNumber: position.lineNumber,
                    //             startColumn: position.column,
                    //             endLineNumber: position.lineNumber,
                    //             endColumn: position.column
                    //         });
                    //     }
                    // });

                    const editorDomNode = editor.getDomNode();
                    if (editorDomNode) {
                        editorDomNode.addEventListener('dblclick', (e) => {
                            if (e.target && (
                                e.target.tagName === 'TEXTAREA' && e.target.className === 'input' ||
                                e.target.getAttribute('aria-label') === 'Find' ||
                                e.target.getAttribute('placeholder') === 'Find' ||
                                e.target.getAttribute('title') === 'Find'
                            )) {
                                return true;
                            }
                            //e.preventDefault();
                            //e.stopPropagation();
                            //console.log('[definition] DOM 级别拦截到双击事件', e.target);
                            
                            if (e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) {
                                vscode.postMessage({
                                    type: 'doubleClick',
                                    location: 'bottomArea'
                                });
                            }

                            return true;
                        }, true); // 使用捕获阶段，确保在事件到达 Monaco 之前拦截

                        editorDomNode.addEventListener('contextmenu', (e) => {
                            if (e.ctrlKey || e.shiftKey || e.metaKey) {
                                // shift+右键，手动弹出 Monaco 菜单
                                // 需要调用 Monaco 的菜单 API
                                // 下面是常见做法（不同版本API略有不同）
                                if (editor._contextMenuService) {
                                    // 6.x/7.x 版本
                                    editor._contextMenuService.showContextMenu({
                                        getAnchor: () => ({ x: e.clientX, y: e.clientY }),
                                        getActions: () => editor._getMenuActions(),
                                        onHide: () => {},
                                    });
                                } else if (editor.trigger) {
                                    // 旧版
                                    editor.trigger('keyboard', 'editor.action.showContextMenu', {});
                                }
                            } else {
                                // 普通右键，执行你自己的逻辑
                                editor.focus();
                                e.preventDefault();
                                e.stopPropagation();
                                // 这里写你自己的右键菜单逻辑
                                //console.log('自定义右键菜单');
                            }
                        }, true);
                    }

                    editorDomNode.addEventListener('selectstart', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        return false;
                    }, true);

                    // 处理鼠标侧键
                    editor.getDomNode().addEventListener('auxclick', (e) => {
                        //console.log('[definition] auxclick:', e);
                        // 阻止默认行为
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.button === 3) { // 鼠标后退键
                            vscode.postMessage({
                                type: 'navigate',
                                direction: 'back'
                            });
                        } else if (e.button === 4) { // 鼠标前进键
                            vscode.postMessage({
                                type: 'navigate',
                                direction: 'forward'
                            });
                        }
                    });

                    // editor.onMouseDown((e) => {
                    //     e.event.preventDefault();
                    //     e.event.stopPropagation();
                    //     //console.log('[definition] onMouseDown: ', e);
                    //     return false;  // 阻止默认处理
                    // });

                    // editor.onMouseLeave((e) => {
                    //     //e.event.preventDefault();
                    //     //e.event.stopPropagation();
                    //     forcePointerCursor(false);
                    //     return true;  // 阻止默认处理
                    // });

                    // 添加鼠标悬停事件处理
                    let currentDecorations = [];
                    editor.onMouseMove((e) => {
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
                                // 添加新装饰
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

                                // 鼠标移出时清除装饰
                                const container = editor.getDomNode();
                                if (container) {
                                    container.addEventListener('mouseleave', () => {
                                        currentDecorations = editor.deltaDecorations(currentDecorations, []);
                                    }, { once: true });
                                }
                            }
                        } else {
                            // 当Ctrl键未按下时清除装饰
                            currentDecorations = editor.deltaDecorations(currentDecorations, []);
                        }
                        // 根据鼠标位置更新光标样式
                        forcePointerCursor(isOverText);
                        return true;

                        // if (isOverText) {
                        //     e.event.preventDefault();
                        //     e.event.stopPropagation();
                        //     return false;  // 阻止默认处理
                        // }
                        // else {
                        //     return true;
                        // }
                    });

                    // 处理链接点击事件 - 在Monaco内部跳转
                    editor.onMouseUp(async (e) => {
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
                                model = monaco.editor.createModel(editorState.content, editorState.language);
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
                                                    console.error('[definition] pickColor action failed:', err);
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
                                            uri: editorState.uri,
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
                    });

                    // 在创建编辑器实例后添加以下代码
                    const originalGetDefinitionsAtPosition = editor._codeEditorService.getDefinitionsAtPosition;
                    editor._codeEditorService.getDefinitionsAtPosition = function(model, position, token) {
                        // 返回空数组，表示没有定义可跳转
                        return Promise.resolve([]);
                    };

                    // 覆盖peek实现
                    const originalPeekDefinition = editor._codeEditorService.peekDefinition;
                    editor._codeEditorService.peekDefinition = function(model, position, token) {
                        // 返回空数组，表示没有定义可peek
                        return Promise.resolve([]);
                    };

                    // 覆盖reference实现
                    const originalFindReferences = editor._codeEditorService.findReferences;
                    editor._codeEditorService.findReferences = function(model, position, token) {
                        // 返回空数组，表示没有引用可查找
                        return Promise.resolve([]);
                    };

                    // 覆盖implementation实现
                    const originalFindImplementations = editor._codeEditorService.findImplementations;
                    editor._codeEditorService.findImplementations = function(model, position, token) {
                        // 返回空数组，表示没有实现可查找
                        return Promise.resolve([]);
                    };

                    // 覆盖type definition实现
                    const originalFindTypeDefinition = editor._codeEditorService.findTypeDefinition;
                    editor._codeEditorService.findTypeDefinition = function(model, position, token) {
                        // 返回空数组，表示没有类型定义可查找
                        return Promise.resolve([]);
                    };

                    // 完全禁用所有与跳转相关的命令
                    // 使用Monaco Editor 0.52.0的正确API
                    const disabledCommands = [
                        'editor.action.openLink',
                        'editor.action.openLinkToSide',
                        'editor.action.openLinkInPeek',
                        'editor.action.goToDefinition',
                        'editor.action.goToTypeDefinition',
                        'editor.action.goToImplementation',
                        'editor.action.goToReferences',
                        'editor.action.peekDefinition',
                        'editor.action.peekTypeDefinition',
                        'editor.action.peekImplementation',
                        'editor.action.peekReferences'
                    ];

                    // 使用addDynamicKeybindings批量禁用命令（推荐方式）
                    if (editor._standaloneKeybindingService && editor._standaloneKeybindingService.addDynamicKeybindings) {
                        const keybindingRules = disabledCommands.map(command => ({
                            keybinding: 0,  // 0表示没有键绑定
                            command: `-${command}`,  // 使用负号前缀禁用命令
                            when: undefined
                        }));
                        
                        try {
                            editor._standaloneKeybindingService.addDynamicKeybindings(keybindingRules);
                        } catch (error) {
                            console.warn('Failed to disable commands using addDynamicKeybindings:', error);
                        }
                    }

                    editorState.symboleDecorations = editor.deltaDecorations(editorState.symboleDecorations, [{ range: new monaco.Range(1, 1, 1, 1 + 5), options: { className: 'highlighted-symbol-range', inlineClassName: 'highlighted-symbol-inline' } }]);

                    //console.log('[definition] Monaco editor created');

                    // 通知扩展编辑器已准备好
                    vscode.postMessage({ type: 'editorReady' });
                    //console.log('[definition] Editor ready message sent');
                    
                    // 请求初始内容
                    //vscode.postMessage({ type: 'requestContent' });
                    //console.log('[definition] Content requested');

                    // 定义列表面板逻辑已抽离到 definitionList.js（工厂函数持有 editor 引用）
                    const { updateDefinitionList, clearDefinitionList, updateFilenameDisplay } = createDefinitionList(editor);

                    // 内容更新逻辑已抽离到 editorContent.js（工厂持有 editor / editorState 及缩进、文件名、光标等回调）
                    const updateEditorContent = createUpdateEditorContent({
                        editor,
                        state: editorState,
                        applyIndentationForModel,
                        updateFilenameDisplay,
                        hideCursor
                    });

                    window.addEventListener('blur', () => {
                        const menu = document.getElementById('custom-context-menu');
                        if (menu) menu.remove();
                    });

                    const doubleClickArea = document.querySelector('.double-click-area');
                    
                    // 处理来自扩展的消息
                    window.addEventListener('message', event => {
                        const message = event.data;
                        //console.log('[definition] Received message:', message);
                        try {
                            switch (message.type) {
                                case 'StickyScroll':
                                    window.stickyScroll = !window.stickyScroll;
                                    
                                    editor.updateOptions({
                                        stickyScroll: { enabled: window.stickyScroll }
                                    });
                                    break;
                                case 'PickTokenStyle':
                                    if (!contextEditorCfg.useDefaultTokenizer) {
                                        window.pickTokenStyle = !window.pickTokenStyle;
                                        resetPickColorPosition();
                                    }
                                    break;
                                case 'pinState':
                                    window.isPinned = message.pinned;
                                    if (doubleClickArea) {
                                        if (window.isPinned) {
                                            doubleClickArea.style.backgroundColor = 'rgba(255, 0, 0, 0.08)'; // 淡红色
                                        } else {
                                            doubleClickArea.style.backgroundColor = 'transparent'; // 你现在的默认色
                                        }
                                    }
                                    break;
                                /*case 'updateEditorConfiguration':
                                    // 更新编辑器配置
                                    if (editor && message.configuration) {
                                        //console.log('[definition] Updating editor configuration');
                                        
                                        // 更新编辑器选项
                                        editor.updateOptions(message.configuration || {});
                                        
                                        // 更新主题
                                        if (message.configuration.tokenColorCustomizations) {
                                            // 确保colors是有效对象
                                            const safeColors = {};
                                            const colors = window.vsCodeEditorConfiguration.tokenColorCustomizations;
                                            if (colors && typeof colors === 'object') {
                                                Object.keys(colors).forEach(key => {
                                                    if (typeof colors[key] === 'string') {
                                                        safeColors[key] = colors[key];
                                                    }
                                                });
                                            }
                                            monaco.editor.defineTheme('vscode-custom', {
                                                base: message.configuration.theme || 'vs',
                                                inherit: true,
                                                rules: [],
                                                colors: safeColors
                                            });
                                            try {
                                                monaco.editor.setTheme('vscode-custom');
                                                //console.log('[definition] 自定义主题已应用2');
                                            } catch (themeError) {
                                                //console.error('[definition] 应用自定义主题失败2:', themeError);
                                                monaco.editor.setTheme('vs'); // 回退到默认主题
                                            }
                                        } else if (message.configuration.theme) {
                                            monaco.editor.setTheme(message.configuration.theme);
                                        }

                                        // 更新语义高亮
                                        if (message.configuration.semanticTokenColorCustomizations) {
                                            try {
                                                // Monaco不支持为所有语言(*)设置通用的语义标记提供程序
                                                const supportedLanguages = ['javascript', 'typescript', 'html', 'css', 'json', 'markdown', 'cpp', 'python', 'java', 'go'];
                                                
                                                // 为每种支持的语言设置语义标记提供程序
                                                supportedLanguages.forEach(lang => {
                                                    try {
                                                        monaco.languages.setTokensProvider(lang, {
                                                            getInitialState: () => null,
                                                            tokenize: (line) => {
                                                                return { tokens: [], endState: null };
                                                            }
                                                        });
                                                    } catch (langError) {
                                                        //console.warn(`[definition] 为 ${lang} 更新语义标记提供程序失败:`, langError);
                                                    }
                                                });
                                                
                                                //console.log('[definition] 语义高亮配置已更新');
                                            } catch (error) {
                                                //console.error('[definition] 更新语义高亮配置失败:', error);
                                            }
                                        }
                                    }
                                    break;*/
                                case 'updateContextEditorCfg':
                                    if (message.contextEditorCfg) {
                                        window.vsCodeEditorConfiguration.contextEditorCfg = message.contextEditorCfg;
                                        window.vsCodeEditorConfiguration.customThemeRules = message.customThemeRules;

                                        // 重新定义主题
                                        applyMonacoTheme(window.vsCodeEditorConfiguration, message.contextEditorCfg, isLightTheme());
                                        
                                        // 重新应用主题
                                        if (editor) {
                                            editor.updateOptions(
                                                {
                                                    theme: 'custom-vs',
                                                    minimap: { enabled: message.contextEditorCfg.minimap },
                                                    fontSize: message.contextEditorCfg.fontSize,
                                                    fontFamily: message.contextEditorCfg.fontFamily
                                                }
                                            );
                                            editor.layout();
                                        }
                                    }
                                    break;
                                case 'updateTheme':
                                    // 更新编辑器主题
                                    if (editor && message.theme) {
                                        //monaco.editor.setTheme(message.theme);
                                    }
                                    break;
                                case 'noSymbolFound':
                                    const models = monaco.editor.getModels();
                                    let model = models.length > 0 ? models[0] : null;
                                    if (editor && model) {
                                        const monacoPos = {
                                            lineNumber: message.pos.line + 1,  // VS Code是0-based，Monaco是1-based
                                            column: message.pos.character + 1   // VS Code是0-based，Monaco是1-based
                                        };

                                        //console.info('[definition] noSymbolFound, setting selection to:', monacoPos);
                                        
                                        const word = model.getWordAtPosition(monacoPos);
                                        if (word) {
                                            //console.info('[definition] noSymbolFound, setSelection:', word);
                                            editor.setSelection({
                                                startLineNumber: message.pos.line+1,
                                                startColumn: word.startColumn,
                                                endLineNumber: message.pos.line+1,
                                                endColumn: word.endColumn
                                            });
                                        }
                                    }
                                    break;
                                case 'updateDefinitionList':
                                    // 更新定义列表
                                    if (message.definitions && Array.isArray(message.definitions)) {
                                        updateDefinitionList(message.definitions);
                                    }
                                    break;
                                case 'clearDefinitionList':
                                    // 清空定义列表
                                    clearDefinitionList();
                                    break;
                                case 'beginProgress':
                                    document.querySelector('.progress-container').style.display = 'block';
                                    break;
                                case 'endProgress':
                                    document.querySelector('.progress-container').style.display = 'none';
                                    break;
                                case 'updateMetadata':
                                    editorState.uri = message.uri;
                                    const requestVersion = message.documentVersion;
                                    
                                    // 检查前端缓存
                                    const cached = fileContentCache.get(editorState.uri);
                                    if (cached && cached.version === requestVersion) {
                                        //console.log(`[definition] Cache hit for ${uri} with version ${requestVersion}`);
                                        // 缓存命中且版本匹配，直接使用
                                        updateEditorContent(cached.content, {
                                            newUri: message.uri,
                                            languageId: message.languageId,
                                            range: message.range,
                                            scrollToLine: message.scrollToLine,
                                            curLine: message.curLine
                                        });
                                    } else {
                                        // 缓存未命中或版本不匹配，请求完整内容
                                        // 如果版本不匹配，先清除旧缓存
                                        if (cached && cached.version !== requestVersion) {
                                            fileContentCache.delete(editorState.uri);
                                        }

                                        const contentHash = `${editorState.uri}:${requestVersion}`;

                                        //console.log(`[definition] Cache miss for ${uri} with version ${requestVersion}, requesting content`);
                                        
                                        vscode.postMessage({
                                            type: 'requestContent',
                                            contentHash: contentHash
                                        });
                                    }
                                    break;
                                case 'updateContent':
                                    // 收到完整内容，缓存（使用 URI 作为键，自动覆盖旧版本）
                                    const cacheUri = message.uri;
                                    fileContentCache.set(cacheUri, {
                                        version: message.documentVersion,
                                        content: message.body,
                                        lines: message.lineCount,  // 添加行数信息
                                        timestamp: Date.now(),  // 添加时间戳
                                        metadata: {
                                            languageId: message.languageId
                                        }
                                    });

                                    //console.log(`[definition] Cache set for ${cacheUri} size ${fileContentCache.size}`);

                                    // 从配置中获取缓存限制和大文件阈值
                                    const cacheConfig = window.vsCodeEditorConfiguration?.contextEditorCfg || {};
                                    const cacheSizeLimit = cacheConfig.cacheSizeLimit || 20;
                                    const largeFileThreshold = cacheConfig.largeFileThreshold || 2000;
                                    
                                    // 限制前端缓存大小
                                    if (fileContentCache.size > cacheSizeLimit) {
                                        // 将缓存转换为数组以便排序
                                        const cacheEntries = Array.from(fileContentCache.entries());
                                        
                                        // 分类：大文件（>2000行）和小文件（<=2000行）
                                        const largeFiles = cacheEntries.filter(([_, entry]) => entry.lines > largeFileThreshold);
                                        const smallFiles = cacheEntries.filter(([_, entry]) => entry.lines <= largeFileThreshold);
                                        
                                        let keyToDelete;
                                        
                                        if (smallFiles.length > 0) {
                                            // 优先淘汰小文件中最旧的
                                            smallFiles.sort((a, b) => a[1].timestamp - b[1].timestamp);
                                            keyToDelete = smallFiles[0][0];
                                        } else {
                                            // 所有都是大文件，淘汰最旧的大文件
                                            largeFiles.sort((a, b) => a[1].timestamp - b[1].timestamp);
                                            keyToDelete = largeFiles[0][0];
                                        }
                                        
                                        if (keyToDelete) {
                                            fileContentCache.delete(keyToDelete);
                                            //console.log(`[definition] Cache evicted: ${keyToDelete} (${fileContentCache.size} entries remaining)`);
                                        }
                                    }

                                    //console.log(`[definition] updateContent content for ${cacheUri} with version ${message.documentVersion}`);
                                    
                                    updateEditorContent(message.body, {
                                        newUri: message.uri,
                                        languageId: message.languageId,
                                        range: message.range,
                                        curLine: message.curLine
                                    });
                                    break;
                                case 'noContent':
                                    //console.log('[definition] Showing no content message');
                                    // 隐藏左侧定义列表
                                    clearDefinitionList();
                                    
                                    // 检查编辑器是否已创建
                                    if (typeof editor !== 'undefined' && editor) {
                                        // 使用Monaco编辑器显示"No symbol found."并高亮"No symbol"
                                        document.getElementById('container').style.display = 'block';
                                        document.getElementById('main').style.display = 'none';
                                        
                                        // 设置编辑器内容
                                        const model = editor.getModel();
                                        if (model) {
                                            model.setValue('No symbol found.');
                                            editor.updateOptions({ lineNumbersMinChars: 1 });
                                            // 高亮"No symbol"（前9个字符）
                                            // 保存装饰ID，以便后续清除
                                            editorState.symboleDecorations = editor.deltaDecorations(editorState.symboleDecorations, [{ 
                                                range: new monaco.Range(1, 1, 1, 1 + 9), 
                                                options: { 
                                                    className: 'highlighted-symbol-range', 
                                                    inlineClassName: 'highlighted-symbol-inline' 
                                                } 
                                            }]);
                                            
                                            // 将光标移到超大列值，使其不可见
                                            editor.setSelection({
                                                startLineNumber: 1,
                                                startColumn: 999999,
                                                endLineNumber: 1,
                                                endColumn: 999999
                                            });
                                            
                                            // 强制编辑器重新布局以占满整个空间
                                            setTimeout(() => {
                                                editor.layout();
                                            }, 100);
                                        }
                                    } else {
                                        // 编辑器未创建，使用原始HTML显示
                                        document.getElementById('container').style.display = 'none';
                                        document.getElementById('main').style.display = 'block';
                                        document.getElementById('main').innerHTML = message.body;
                                    }
                                    break;
                                //default:
                                    //console.log('[definition] Unknown message type:', message.type);
                            }
                        } catch (error) {
                            console.error('[definition] Error handling message:', error);
                            document.getElementById('main').style.display = 'block';
                            document.getElementById('main').innerHTML = '<div style="color: red; padding: 20px;">处理消息时出错: ' + error.message + '</div>';
                        }
                    });
                    

                } catch (error) {
                    console.error('[definition] Error initializing editor:', error);
                    document.getElementById('main').style.display = 'block';
                    document.getElementById('main').innerHTML = '<div style="color: red; padding: 20px;">Error initializing editor: ' + error.message + '</div>';
                }
            }, function(error) {
                console.error('[definition] Failed to load Monaco editor:', error);
                document.getElementById('main').style.display = 'block';
                document.getElementById('main').innerHTML = '<div style="color: red; padding: 20px;">Failed to load Monaco editor: ' + (error ? error.message : 'Unknown error') + '</div>';
            });
        };
        
        loaderScript.onerror = function(error) {
            console.error('[definition] Failed to load Monaco loader.js:', error);
            document.getElementById('main').style.display = 'block';
            document.getElementById('main').innerHTML = '<div style="color: red; padding: 20px;">Failed to load Monaco loader.js</div>';
        };
        
        // 将脚本添加到文档中
        document.head.appendChild(loaderScript);
        
    } catch (error) {
        console.error('[definition] Error in main script:', error);
        document.getElementById('main').style.display = 'block';
        document.getElementById('main').innerHTML = '<div style="color: red; padding: 20px;">初始化失败: ' + error.message + '</div>';
    }
})();
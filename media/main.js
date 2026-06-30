//@ts-check

// 导入语言配置与各功能模块
import { createDocumentSymbolProvider } from './documentSymbolProvider.js';
import { resetPickColorPosition } from './tokenPicker.js';
import { applyMonacoTheme, isLightTheme, installSemanticRenderMatch } from './editorTheme.js';
import { injectEditorStyles } from './editorStyles.js';
import { createDefinitionList } from './definitionList.js';
import { createUpdateEditorContent } from './editorContent.js';
import { createMessageHandlers } from './messageHandlers.js';
import { setupEditorMouseHandlers } from './editorMouseHandlers.js';
import { setupTextmate, ensureGrammar as tmEnsureGrammar, updateThemeScopes as tmUpdateThemeScopes, setOnGrammarRegistered as tmSetOnGrammarRegistered } from './textmateClient.js';
import { setupHoverProvider, ensureHoverProvider, handleHoverResult, disableMonacoBuiltinTsJsProviders, disposeHoverProvider } from './hoverProvider.js';

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
    // Hover Tips 初值：从后端下发的 contextEditorCfg.enableHover 读取，不存在时默认 false。
    // 右键菜单 "Hover Tips" 切换后反转该值，同时以 'setEnableHover' 消息告知后端持久化。
    {
        const cfg0 = window.vsCodeEditorConfiguration && window.vsCodeEditorConfiguration.contextEditorCfg;
        window.enableHover = (cfg0 && typeof cfg0.enableHover === 'boolean') ? cfg0.enableHover : false;
    }

    // 统一调试日志开关：默认关闭，排查问题时置为 true 即可恢复所有调试输出，
    // 避免历史遗留的 [definition] 前缀散落各处且无法集中控制。
    const DEBUG = false;
    function log(...args) {
        if (DEBUG) {
            console.log('[context-window]', ...args);
        }
    }

    // 禁用 Monaco 内置的跳转 / Peek / 查找引用 / 实现 / 类型定义能力。
    // 警告：依赖 Monaco 内部实现（下划线私有成员），升级 monaco-editor 版本后需重新验证。
    function disableEditorNavigation(ed) {
        const svc = ed._codeEditorService;
        if (svc) {
            // 覆盖定义/Peek/引用/实现/类型定义查询，统一返回空，阻止内部跳转
            svc.getDefinitionsAtPosition = () => Promise.resolve([]);
            svc.peekDefinition = () => Promise.resolve([]);
            svc.findReferences = () => Promise.resolve([]);
            svc.findImplementations = () => Promise.resolve([]);
            svc.findTypeDefinition = () => Promise.resolve([]);
        }

        // 通过负号前缀键绑定批量禁用跳转相关命令
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
        const kbService = ed._standaloneKeybindingService;
        if (kbService && kbService.addDynamicKeybindings) {
            const keybindingRules = disabledCommands.map(command => ({
                keybinding: 0,           // 0 表示没有键绑定
                command: `-${command}`,  // 负号前缀禁用命令
                when: undefined
            }));
            try {
                kbService.addDynamicKeybindings(keybindingRules);
            } catch (error) {
                log('Failed to disable commands using addDynamicKeybindings:', error);
            }
        }
    }

    // 确保 WebView 使用 VS Code 的颜色主题
    //document.body.classList.add('vscode-light', 'vscode-dark', 'vscode-high-contrast');
    
    // 显示加载状态
    document.getElementById('main').style.display = 'block';
    document.getElementById('main').innerHTML = '';
    document.getElementById('container').style.display = 'none';
    
    // 添加错误处理
    window.onerror = function(message, source, lineno, colno, error) {
        console.error('[context-window] Global error:', message, 'at', source, lineno, colno, error);
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

                // 诊断：打印从扩展端解析到的「当前主题语义配色」。若为 undefined，说明未读到主题文件（多半是扩展宿主未重载）。
                log('themeSemanticRules:', window.vsCodeEditorConfiguration?.themeSemanticRules);

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
                            automaticLayout: true,
                            // 开启语义着色：标识符的精确分类由后端透传的 VSCode 语义 token 提供
                            'semanticHighlighting.enabled': true
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
                            // 自定义 Hover Provider 走扩展端 LSP（vscode.executeHoverProvider），
                            // 不依赖 Monaco 内置 Worker，规避了「webview 中 Worker 长期 pending → 浮窗一直 loading」。
                            // 见 hoverProvider.js / contextView.ts 的 requestHover 处理。
                            hover: {
                                enabled: true,
                                delay: 300,
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
                    // sticky scroll 的 defaultModel 由 editorContent.js 的 refreshStickyScroll 按当前文件语言动态切换：
                    // TS/JS 用 indentationModel（其 outline 在 webview 中不可用），其它语言用 outlineModel（显示函数名）。

                    // 让语义着色渲染按 VSCode 选择器匹配「类型+修饰符」组合规则（如 class.constructorOrDestructor），
                    // 而非 Monaco 默认的 TextMate 前缀匹配。须在语义 token 到达前安装。
                    installSemanticRenderMatch(editor);

                    // 编辑器可变会话状态（供 onMouseUp / 消息处理 / 内容更新等多处共享读写）
                    const editorState = {
                        uri: '',
                        content: '',
                        language: '',
                        // 定位信息（range/curLine）归前端管：在 updateMetadata 阶段保存，
                        // 回源拿到内容（updateContent）时复用，避免后端现取时丢失光标定位。
                        range: null,
                        curLine: -1,
                        activeLineDecorations: [],
                        symboleDecorations: [],
                        // #include/#pragma/#region/#endregion 等指令高亮的装饰 id
                        directiveDecorations: []
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
                        // 与 createEditorOptions 保持一致：自定义 hover 走扩展端 LSP，启用浮窗
                        hover: { enabled: true, delay: 300, sticky: true },
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
                    // 性能优化：通过切换 class 让 CSS 处理光标样式，避免每次鼠标移动都
                    // querySelectorAll('*') 遍历成百上千个 DOM 节点并逐个写 inline style（强制重排）
                    const forcePointerCursor = (isOverText = false) => {
                        const editorContainer = editor.getDomNode();
                        if (editorContainer) {
                            editorContainer.classList.toggle('cw-cursor-pointer', isOverText);
                            editorContainer.classList.toggle('cw-cursor-default', !isOverText);
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

                    // 语义着色会话状态：后端透传的整文档语义 token（legend + data）。
                    // 前端不再用手写 Monarch 去"猜"标识符语义，改由 VSCode 语言服务器的语义 token 驱动着色。
                    const semanticState = { legend: null, data: null };
                    // 语义 token 变更通知：内容相同但语义数据更新（如缓存命中/live 重取）时，
                    // 主动触发 Monaco 重新向 provider 索取语义 token 并重着色。
                    const semanticTokensEmitter = new monaco.Emitter();

                    // 写入后端发来的语义 token 并通知 Monaco 刷新（在 setValue 前调用，保证 provide 时数据已就绪）
                    function applySemanticTokens(semantic) {
                        if (semantic && Array.isArray(semantic.data) && semantic.legend && Array.isArray(semantic.legend.tokenTypes)) {
                            semanticState.legend = semantic.legend;
                            semanticState.data = semantic.data;
                        } else {
                            // 无语义 token（未装语言扩展 / 不支持 / 文档未纳入分析）：清空，回退到基础着色
                            semanticState.legend = null;
                            semanticState.data = null;
                        }
                        try { semanticTokensEmitter.fire(); } catch (_) {}
                    }

                    if (!contextEditorCfg.useDefaultTokenizer) {
                        // 非默认 tokenizer 模式：基础语法层由真实 TextMate 语法（见 textmateClient）接管，
                        // 语义叠加层（variable/parameter/property/type/class/function/method/namespace…）由后端语义 token 提供，
                        // 故注册"查表型"语义 token provider。默认模式（useDefaultTokenizer=true）纯用 Monaco 内置 Monarch，不注册语义。
                        const semanticLanguages = [
                            'python', 'java', 'rust', 'php', 'ruby', 'swift', 'kotlin', 'perl', 'lua', 'vb', 'vbnet', 'cobol', 'fortran', 'pascal', 'delphi', 'ada',
                            'erlang',
                            'javascript', 'typescript', 'cpp', 'c', 'csharp', 'go'
                        ];

                        const semanticProvider = {
                            onDidChange: semanticTokensEmitter.event,
                            getLegend() {
                                return semanticState.legend || { tokenTypes: [], tokenModifiers: [] };
                            },
                            provideDocumentSemanticTokens() {
                                if (!semanticState.data || !semanticState.legend) {
                                    return null;
                                }
                                return { data: new Uint32Array(semanticState.data), resultId: undefined };
                            },
                            releaseDocumentSemanticTokens() {}
                        };

                        semanticLanguages.forEach(lang => {
                            monaco.languages.registerDocumentSemanticTokensProvider(lang, semanticProvider);
                        });
                    }

                    // 为 C++, C, C# 注册 Document Symbol Provider（从 documentSymbolProvider.js 导入）
                    // 这些语言走 sticky scroll 的 outlineModel，依赖此同步 symbol provider 显示函数/类名。
                    // （TS/JS 走 indentationModel，不需要 symbol provider，故不注册。）
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

                    // 精准兜底原生 Cut/Copy/Paste 菜单：
                    // 上面的 editorDomNode 监听只挂在「主 .monaco-editor 节点」上，漏掉了 Monaco 为
                    // 跟随光标的隐藏输入框/overflow widget 挂到 document.body 的另一个 .monaco-editor 容器，
                    // 这正是「能识别语义 token 的标识符(如 vscode.Disposable)右键必现原生菜单」的根因
                    // （此时 contextmenu 的 target 在主节点子树之外，原监听收不到，无法 preventDefault）。
                    // 这里在 document 捕获阶段统一处理右键：默认禁用浏览器原生菜单，
                    // 仅放行底部状态栏（导航栏 / 文件名区）——它有自己的自定义右键菜单（见 navigation.js）。
                    // 之前用 closest('.monaco-editor') 判定是否屏蔽，但 Monaco 为语义 token 标识符
                    // (如 vscode.Disposable) 创建的隐藏输入框 / overflow widget 会挂到该子树之外，导致这次
                    // contextmenu 漏网、原生菜单盖在 token 浮窗上——这正是「浮窗弹出后又马上变菜单」的根因。
                    // 改为「默认屏蔽 + 仅放行状态栏」即可彻底解决；shift/ctrl/meta+右键 放行给 Monaco 菜单逻辑。
                    if (!window.__ctxMenuSuppressorInstalled) {
                        window.__ctxMenuSuppressorInstalled = true;
                        document.addEventListener('contextmenu', (e) => {
                            if (e.ctrlKey || e.shiftKey || e.metaKey) {
                                return;
                            }
                            const t = e.target;
                            // 底部状态栏保留自身的自定义右键菜单，放行让 navigation.js 处理
                            if (t && typeof t.closest === 'function' &&
                                (t.closest('.nav-bar') || t.closest('.double-click-area'))) {
                                return;
                            }
                            // 其它区域：统一禁用浏览器原生右键菜单
                            e.preventDefault();
                            e.stopPropagation();
                        }, true);
                    }

                    editorDomNode.addEventListener('selectstart', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        return false;
                    }, true);

                    // 处理鼠标侧键（前进/后退）
                    // 关键：必须走 Monaco 自身的鼠标事件 API（与双击的修复同源），而不是在 DOM 节点上
                    // addEventListener。本版 Monaco 内容区基于 pointer 事件，会拦截/消费原生 mouse 事件，
                    // 导致挂在 DOM 上的 auxclick / mousedown 监听器都收不到侧键；而 editor.onMouseDown
                    // 由 Monaco 自身派发，能稳定拿到侧键——通过 e.event.browserEvent.button 识别 3/4。
                    editor.onMouseDown((e) => {
                        const be = e && e.event && e.event.browserEvent;
                        const btn = be && be.button;
                        if (btn === 3) { // 鼠标后退键
                            vscode.postMessage({
                                type: 'navigate',
                                direction: 'back'
                            });
                        } else if (btn === 4) { // 鼠标前进键
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

                    // 鼠标交互逻辑（悬停高亮 + 点击跳转/取色）已抽离到 editorMouseHandlers.js
                    // （内部持有悬停高亮状态并完成 onMouseMove / onMouseUp / mouseleave 注册）
                    setupEditorMouseHandlers({
                        editor,
                        state: editorState,
                        light,
                        vscode,
                        applyIndentationForModel,
                        forcePointerCursor,
                        showCursor,
                        hideCursor,
                        semanticState
                    });

                    // === 禁用 Monaco 内置的跳转 / Peek / 查找引用能力 ===
                    // 警告：以下逻辑依赖 Monaco 内部实现（下划线私有成员 _codeEditorService /
                    // _standaloneKeybindingService）。升级 monaco-editor 版本后需重新验证可用性。
                    disableEditorNavigation(editor);

                    editorState.symboleDecorations = editor.deltaDecorations(editorState.symboleDecorations, [{ range: new monaco.Range(1, 1, 1, 1 + 5), options: { className: 'highlighted-symbol-range', inlineClassName: 'highlighted-symbol-inline' } }]);

                    //console.log('[definition] Monaco editor created');

                    // 自定义 Hover Provider：所有 hover 请求转发给扩展端，复用 VSCode 已就绪的 LSP，
                    // 避免 Monaco 自带 Worker 在 webview 里长期 pending 导致浮窗一直 loading。
                    // 直接注册到 '*'（所有语言），无需在语言切换时补注册；
                    // 真实文档 URI 通过 editorState.uri 取得（扩展端 updateMetadata 下发并保存）。
                    setupHoverProvider(vscode, editorState);
                    // 仅在 enableHover=true 时注册 provider；关闭时不注册，叠加 disableMonacoBuiltinTsJsProviders
                    // 后 ts/js 文件 hover 完全无任何源 → 浮窗根本不出现。
                    if (window.enableHover) {
                        ensureHoverProvider();
                    }
                    // 关闭 Monaco 内置 ts/js 模块自动注册的 hover/signatureHelp/completion 等依赖 worker 的 provider，
                    // 避免浮窗顶部已有我们的内容、下方又追加 "Loading..." （来自 Monaco 自带 ts hover provider）。
                    disableMonacoBuiltinTsJsProviders();

                    // 通知扩展编辑器已准备好
                    vscode.postMessage({ type: 'editorReady' });
                    //console.log('[definition] Editor ready message sent');
                    
                    // 请求初始内容
                    //vscode.postMessage({ type: 'requestContent' });
                    //console.log('[definition] Content requested');

                    // 定义列表面板逻辑已抽离到 definitionList.js（工厂函数持有 editor 引用）
                    const { updateDefinitionList, clearDefinitionList, updateFilenameDisplay } = createDefinitionList(editor);

                    // 初始化真实 TextMate 高亮：仅在非默认模式（useDefaultTokenizer 关闭）下启用，
                    // 启用与否由扩展端注入的 ctxTextmate.enabled 决定（= !useDefaultTokenizer）。
                    // 语法源加载失败时 Monaco 自动回退到内置 Monarch，tmEnsureGrammar 返回 null，editorContent 调用无害。
                    log('ctxTextmate config =', window.ctxTextmate);
                    if (window.ctxTextmate && window.ctxTextmate.enabled) {
                        // 确定性刷新：grammar 注册完成时回调，对当前同语言 model 做一次可靠重分词（重建 model）。
                        // 无论「首屏已带内容（grammar 后到）」还是「grammar 先到、内容后到」，注册一旦完成必刷新，
                        // 彻底消除 if 停留在 Monaco Monarch 蓝色着色的竞态。
                        tmSetOnGrammarRegistered((langId) => {
                            const m = editor.getModel();
                            if (m && m.getLanguageId() === langId && typeof updateEditorContent.forceRetokenize === 'function') {
                                updateEditorContent.forceRetokenize(langId);
                            }
                        });
                        setupTextmate({ monaco, vscode, cfg: window.ctxTextmate })
                            .then(() => {
                                // 尽早为当前模型语言触发 grammar 加载（加载完成后会经上面的回调自动重分词）
                                const m = editor.getModel();
                                if (m) { tmEnsureGrammar(m.getLanguageId()); }
                            })
                            .catch(err => console.error('[context-window] setup textmate failed:', err));
                    }

                    // 内容更新逻辑已抽离到 editorContent.js（工厂持有 editor / editorState 及缩进、文件名、光标等回调）
                    const updateEditorContent = createUpdateEditorContent({
                        editor,
                        state: editorState,
                        applyIndentationForModel,
                        updateFilenameDisplay,
                        hideCursor,
                        // 方案 B：真实 TextMate 语法按需加载入口（未启用时为 no-op）
                        ensureGrammar: tmEnsureGrammar
                    });

                    // 消息处理逻辑已抽离到 messageHandlers.js（工厂持有 editor / editorState /
                    // 前端缓存 / vscode 通信 及内容更新、定义列表清理等回调）
                    const { handleUpdateMetadata, handleUpdateContent, handleNoContent } = createMessageHandlers({
                        editor,
                        state: editorState,
                        fileContentCache,
                        vscode,
                        updateEditorContent,
                        clearDefinitionList,
                        applySemanticTokens
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
                                    window.pickTokenStyle = !window.pickTokenStyle;
                                    resetPickColorPosition();
                                    break;
                                case 'EnableHover':
                                    // 右键菜单切换：反转状态、按需 register/dispose provider、并告知后端持久化。
                                    window.enableHover = !window.enableHover;
                                    if (window.enableHover) {
                                        ensureHoverProvider();
                                    } else {
                                        disposeHoverProvider();
                                    }
                                    vscode.postMessage({ type: 'setEnableHover', value: window.enableHover });
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
                                case 'updateContextEditorCfg':
                                    if (message.contextEditorCfg) {
                                        window.vsCodeEditorConfiguration.contextEditorCfg = message.contextEditorCfg;
                                        window.vsCodeEditorConfiguration.customThemeRules = message.customThemeRules;

                                        // Hover Tips 开关同步：用户在「设置」UI 改了 enableHover、或多窗口同步时，
                                        // 这里需要按最新值调整 provider 的注册状态，并刷新 window.enableHover 以驱动右键菜单的勾选。
                                        if (typeof message.contextEditorCfg.enableHover === 'boolean'
                                            && window.enableHover !== message.contextEditorCfg.enableHover) {
                                            window.enableHover = message.contextEditorCfg.enableHover;
                                            if (window.enableHover) {
                                                ensureHoverProvider();
                                            } else {
                                                disposeHoverProvider();
                                            }
                                        }

                                        // 方案 B：用户自定义规则变化后，刷新可着色 scope 集合，
                                        // 使新配色的深层 scope 也能被 pickScope 选中（弹窗所见 === 编辑器所染）
                                        tmUpdateThemeScopes();

                                        // 重新定义主题（defineTheme 会生成新的同名 custom-vs 主题对象）
                                        applyMonacoTheme(window.vsCodeEditorConfiguration, message.contextEditorCfg, isLightTheme());
                                        
                                        // 重新应用主题
                                        if (editor) {
                                            editor.updateOptions(
                                                {
                                                    minimap: { enabled: message.contextEditorCfg.minimap },
                                                    fontSize: message.contextEditorCfg.fontSize,
                                                    fontFamily: message.contextEditorCfg.fontFamily
                                                }
                                            );
                                            // 必须用 setTheme 显式重应用：主题名仍是 'custom-vs'，updateOptions({theme})
                                            // 会因字符串未变而短路、不重渲染；setTheme 能识别 defineTheme 生成的新主题对象并
                                            // 触发 onDidColorThemeChange 重新着色，使右键取色的改动即时生效（修复"取到的对、渲染没刷新"）。
                                            monaco.editor.setTheme('custom-vs');
                                            editor.layout();
                                        }
                                        // 同步指令高亮（#include 等）：fixToken 开关或配色/字重变化后即时重算
                                        if (typeof updateEditorContent.applyDirectiveDecorations === 'function') {
                                            updateEditorContent.applyDirectiveDecorations();
                                        }
                                    }
                                    break;
                                case 'updateTheme':
                                    // 主题切换：更新主题名与解析出的语义配色，并重建 Monaco 自定义主题，使配色实时跟随 VSCode
                                    if (message.theme) {
                                        window.vsCodeEditorConfiguration.theme = message.theme;
                                        if (Array.isArray(message.themeSemanticRules)) {
                                            window.vsCodeEditorConfiguration.themeSemanticRules = message.themeSemanticRules;
                                        }
                                        // 方案 B：同步刷新「全部 textmate scope → 颜色」，并更新前端 scope 集合
                                        if (Array.isArray(message.themeTextmateRules)) {
                                            window.vsCodeEditorConfiguration.themeTextmateRules = message.themeTextmateRules;
                                        }
                                        tmUpdateThemeScopes();
                                        const ctxCfg = window.vsCodeEditorConfiguration.contextEditorCfg || {};
                                        applyMonacoTheme(window.vsCodeEditorConfiguration, ctxCfg, isLightTheme());
                                        if (editor) {
                                            monaco.editor.setTheme('custom-vs');
                                        }
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
                                    handleUpdateMetadata(message);
                                    break;
                                case 'updateContent':
                                    handleUpdateContent(message);
                                    break;
                                case 'noContent':
                                    handleNoContent(message);
                                    break;
                                case 'hoverResult':
                                    handleHoverResult(message);
                                    break;
                                //default:
                                    //console.log('[definition] Unknown message type:', message.type);
                            }
                        } catch (error) {
                            console.error('[context-window] Error handling message:', error);
                            document.getElementById('main').style.display = 'block';
                            document.getElementById('main').innerHTML = '<div style="color: red; padding: 20px;">处理消息时出错: ' + error.message + '</div>';
                        }
                    });
                    

                } catch (error) {
                    console.error('[context-window] Error initializing editor:', error);
                    document.getElementById('main').style.display = 'block';
                    document.getElementById('main').innerHTML = '<div style="color: red; padding: 20px;">Error initializing editor: ' + error.message + '</div>';
                }
            }, function(error) {
                console.error('[context-window] Failed to load Monaco editor:', error);
                document.getElementById('main').style.display = 'block';
                document.getElementById('main').innerHTML = '<div style="color: red; padding: 20px;">Failed to load Monaco editor: ' + (error ? error.message : 'Unknown error') + '</div>';
            });
        };
        
        loaderScript.onerror = function(error) {
            console.error('[context-window] Failed to load Monaco loader.js:', error);
            document.getElementById('main').style.display = 'block';
            document.getElementById('main').innerHTML = '<div style="color: red; padding: 20px;">Failed to load Monaco loader.js</div>';
        };
        
        // 将脚本添加到文档中
        document.head.appendChild(loaderScript);
        
    } catch (error) {
        console.error('[context-window] Error in main script:', error);
        document.getElementById('main').style.display = 'block';
        document.getElementById('main').innerHTML = '<div style="color: red; padding: 20px;">初始化失败: ' + error.message + '</div>';
    }
})();
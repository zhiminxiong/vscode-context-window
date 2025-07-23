//@ts-check

// 导入语言配置
import { languageConfig_js, languageConfig_cpp, languageConfig_cs } from './languageConfig.js';

// Monaco Editor 初始化和消息处理
(function() {
    const vscode = acquireVsCodeApi();
    window.vscode = vscode;
    //console.log('[definition] WebView script started from main.js');

    // 确保 WebView 使用 VS Code 的颜色主题
    //document.body.classList.add('vscode-light', 'vscode-dark', 'vscode-high-contrast');
    
    // 显示加载状态
    document.getElementById('main').style.display = 'block';
    document.getElementById('main').innerHTML = '正在加载编辑器...';
    document.getElementById('container').style.display = 'none';
    
    // 添加错误处理
    window.onerror = function(message, source, lineno, colno, error) {
        console.error('[definition] Global error:', message, 'at', source, lineno, colno, error);
        document.getElementById('main').style.display = 'block';
        document.getElementById('main').innerHTML = `<div style="color: red; padding: 20px;">加载错误: ${message}</div>`;
        return true;
    };
    
    try {
        // 尝试从window对象获取Monaco路径
        const monacoPath = window.monacoScriptUri || '../node_modules/monaco-editor/min/vs';
        //console.log('[definition] Using Monaco path:', monacoPath);

        let uri = '';
        let content = '';
        let language = '';

        // 添加高亮样式
        const styleElement = document.createElement('style');
        styleElement.textContent = `
            .highlighted-line {
                background-color: rgba(173, 214, 255, 0.25);
            }
            .highlighted-glyph {
                background-color: #0078d4;
                width: 5px !important;
                margin-left: 3px;
            }
            .highlighted-symbol {
                background-color: #198844!important;
                color: #ffffff!important;
                font-weight: bold!important;
                border: 1px solid #5bdb0791 !important;
                border-radius: 2px;
                padding: 0 2px;
                text-shadow: 0 0 1px rgba(0, 0, 0, 0.5);
            }
            .ctrl-hover-link {
                text-decoration: underline;
                text-decoration-color: #0000ff;
                font-weight: bold!important;
            }
            .ctrl-hover-link-dark {
                text-decoration: underline;
                text-decoration-color: #ffffff;
                font-weight: bold!important;
            }
            .monaco-editor {
                cursor: pointer !important;
                user-select: none !important;
                -webkit-user-select: none !important;
                -moz-user-select: none !important;
                -ms-user-select: none !important;
            }
            #main {
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                padding: 20px;
            }
            body {
                user-select: none;
                -webkit-user-select: none;
                -moz-user-select: none;
                -ms-user-select: none;
            }
        `;
        document.head.appendChild(styleElement);
        
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

                let light = window.vsCodeEditorConfiguration?.theme === 'vs';

                // 如果有自定义主题规则
                if (window.vsCodeEditorConfiguration && window.vsCodeEditorConfiguration.customThemeRules) {
                    const contextEditorCfg = window.vsCodeEditorConfiguration.contextEditorCfg || {};
                    // 定义自定义主题
                    monaco.editor.defineTheme('custom-vs', {
                        base: light ? 'vs' : 'vs-dark',  // 基于 vs 主题
                        inherit: true,  // 继承基础主题的规则
                        rules: window.vsCodeEditorConfiguration.customThemeRules,
                        colors: {
                            "editor.selectionBackground": contextEditorCfg.selectionBackground || "#07c2db71",// #ffb7007f
                            //"editor.selectionForeground": "#ffffffff",
                            "editor.inactiveSelectionBackground": contextEditorCfg.inactiveSelectionBackground || "#07c2db71",
                            "editor.selectionHighlightBackground": contextEditorCfg.selectionHighlightBackground || "#5bdb0771",// Ffb700a0
                            "editor.selectionHighlightBorder": contextEditorCfg.selectionHighlightBorder || "#5bdb0791",
                            "editor.findMatchBackground": "#F4D03F",
                            //"editor.background": "#e6e6e6",
                        }
                    });
                    
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

                    // 处理 VS Code 编辑器配置
                    const createEditorOptions = () => {
                        const vsCodeConfig = window.vsCodeEditorConfiguration?.editorOptions || {};
                        
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
                            ...otherOptions
                        } = vsCodeConfig;

                        return {
                            ...baseOptions,
                            // 字体相关
                            fontSize,
                            fontFamily,
                            lineHeight,
                            letterSpacing,
                            // 编辑器行为
                            tabSize,
                            insertSpaces,
                            wordWrap,
                            // 视图选项
                            minimap: minimap || { enabled: false },
                            scrollBeyondLastLine: scrollBeyondLastLine ?? false,
                            lineNumbers: lineNumbers || 'on',
                            renderWhitespace: renderWhitespace || 'true',
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
                            },
                        };
                    };
                    
                    // 创建编辑器实例
                    const editor = monaco.editor.create(document.getElementById('container'), createEditorOptions(),
                    {
                        openerService: openerService
                    });

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
                        domReadOnly: true,
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

                    // 定义使用JavaScript提供器作为默认的语言列表
                    const defaultLanguages = [
                        'python', 'java', 'go', 'rust', 'php', 'ruby', 'swift', 'kotlin', 'perl', 'lua', 'vb', 'vbnet', 'cobol', 'fortran', 'pascal', 'delphi', 'ada',
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

                    // 添加一个简单的 token 检测函数
                    // function logTokenInfo() {
                    //     const testCode = 'AA::BB::CC a, b, c = 0;';//editor.getValue();
                    //     const languageId = editor.getModel().getLanguageId();
                        
                    //     console.log('[definition] 测试代码:', testCode);
                    //     console.log('[definition] 语言ID:', languageId);
                        
                    //     // 使用 Monaco 的 tokenize 函数解析代码
                    //     const tokens = monaco.editor.tokenize(testCode, languageId);
                        
                    //     console.log('[definition] Token 解析结果:', tokens);
                        
                    //     // 详细打印每个 token
                    //     if (tokens && tokens.length > 0) {
                    //         let lastOffset = 0;
                    //         tokens[0].forEach(token => {
                    //             const tokenType = token.type;
                    //             const startOffset = lastOffset;
                    //             const endOffset = token.offset || testCode.length;
                    //             const tokenText = testCode.substring(startOffset, endOffset);
                    //             lastOffset = endOffset;
                                
                    //             console.log(`[definition] Token: "${tokenType}",  : "${tokenText}"`);
                    //         });
                    //     } else {
                    //         console.log('[definition] 没有找到 token 信息');
                    //     }
                    // }

                    // // 在可能重置样式的场景中重新设置
                    // editor.onDidChangeModelContent(() => {
                    //     console.log('[definition] 编辑器内容已更改，token 解析结果:');
                    //     logTokenInfo();
                    // });
                    //editor.onDidScrollChange(forcePointerCursor);
                    //editor.onDidChangeConfiguration(forcePointerCursor);

                    // 检查readOnly设置
                    //console.log('[definition]cursor type:', editor.getOption(monaco.editor.EditorOption.mouseStyle));

                    // 在创建编辑器实例后添加以下代码
                    editor._standaloneKeybindingService.addDynamicKeybinding(
                        '-editor.action.openLink',
                        null,
                        () => {} // 空函数，阻止Ctrl+Click跳转
                    );

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
                                if (e.ctrlKey) {
                                    // Ctrl+右键，手动弹出 Monaco 菜单
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

                    // 完全禁用定义跳转功能
                    editor._standaloneKeybindingService.addDynamicKeybinding(
                        '-editor.action.goToDefinition',
                        null,
                        () => {} // 空函数，阻止跳转
                    );

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

                    disabledCommands.forEach(command => {
                        editor._standaloneKeybindingService.addDynamicKeybinding(
                            `-${command}`,
                            null,
                            () => {}
                        );
                    });

                    // 处理链接点击事件 - 在Monaco内部跳转
                    editor.onMouseUp((e) => {
                        //console.log('[definition] Mouse up event:', e.target, e.event);
                        // 完全阻止事件传播
                        //e.event.preventDefault();
                        //e.event.stopPropagation();
                        // 使用 e.event.buttons 判断鼠标按键
                        //const isLeftClick = (e.event.buttons & 1) === 1; // 左键
                        //const isRightClick = (e.event.buttons & 2) === 2; // 右键
                        
                        if (e.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT) {
                            // 获取当前单词
                            const model = editor.getModel();
                            if (!model) {
                                //console.log('[definition] **********************no model found************************');
                                model = monaco.editor.createModel(content, language);
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
                                        editor.setSelection({
                                            startLineNumber: position.lineNumber,
                                            startColumn: word.startColumn,
                                            endLineNumber: position.lineNumber,
                                            endColumn: word.endColumn
                                        });
                                    } else {
                                        //console.log('[definition] start to jump definition: ', word);
                                        vscode.postMessage({
                                                        type: 'jumpDefinition',
                                                        uri: uri,
                                                        token: word.word,
                                                        position: {
                                                            line: position.lineNumber - 1,
                                                            character: position.column - 1
                                                        }
                                                    });
                                    }
                                }
                            }
                        }
                        return true;
                    });

                    //console.log('[definition] Monaco editor created');

                    // 通知扩展编辑器已准备好
                    vscode.postMessage({ type: 'editorReady' });
                    //console.log('[definition] Editor ready message sent');
                    
                    // 请求初始内容
                    vscode.postMessage({ type: 'requestContent' });
                    //console.log('[definition] Content requested');

                    // 更新文件名显示函数
                    function updateFilenameDisplay(uri) {
                        const filenameDisplay = document.querySelector('.filename-display');
                        if (uri && filenameDisplay) {
                            // 从URI中提取文件名
                            const filename = uri.split('/').pop().split('\\').pop();
                            let filePath = uri;
                            try {
                                filePath = decodeURIComponent(uri);
                            } catch (e) {
                                //console.log('[definition] Error decoding URI:', e);
                                filePath = uri;
                            }
                            const displayText = `${filename}       (${filePath})`;
                            //console.log('[definition] File name:', filename, uri);
                            filenameDisplay.textContent = displayText || '';
                        } else if (filenameDisplay) {
                            filenameDisplay.textContent = '';
                        }
                    }

                    function updateDefinitionList(definitions) {
                        const listItems = document.querySelector('#definition-list .list-items');
                        if (!listItems) {
                            return;
                        }

                        // 只有在有多个定义时才显示定义列表面板
                        const definitionList = document.querySelector('#definition-list');
                        if (definitionList) {
                            if (definitions && definitions.length > 1) {
                                definitionList.style.display = 'flex';
                            } else {
                                // 如果只有一个或没有定义，隐藏列表面板
                                definitionList.style.display = 'none';
                                // 强制Monaco编辑器重新布局以占满整个空间
                                if (editor) {
                                    setTimeout(() => {
                                        editor.layout();
                                    }, 100);
                                }
                                return;
                            }
                        }

                        // 清空现有内容
                        listItems.innerHTML = '';

                        // 如果没有定义，显示空状态
                        if (!definitions || definitions.length === 0) {
                            listItems.innerHTML = '<div style="padding: 10px; color: var(--vscode-descriptionForeground); font-style: italic;">No definitions found</div>';
                            return;
                        }

                        const getFileName = (path) => path.replace(/^.*[\\/]/, '');

                        // 创建定义项
                        definitions.forEach((def, index) => {
                            const item = document.createElement('div');
                            item.className = `definition-item${def.isActive ? ' active' : ''}`;
                            
                            // 直接使用def中的数据，不需要解析location字符串
                            const filePath = def.filePath;
                            const lineNumber = def.lineNumber + 1; // 转换为1-based行号
                            const columnNumber = def.columnNumber || 1;

                            //console.log('[definition] File name:', filePath, lineNumber, columnNumber);
                            const fileNameWithExt = getFileName(filePath);
                            const symbolName = fileNameWithExt || `Definition ${index + 1}`;
                            
                            item.innerHTML = `
                                <span class="definition-number">${symbolName}</span>
                                <div class="definition-info">
                                    <span class="file-path">${filePath}</span>
                                    <span class="line-info">- Line: ${lineNumber}, Column: ${columnNumber}</span>
                                </div>
                            `;

                            // 添加点击事件
                            item.addEventListener('click', () => {
                                selectDefinitionItem(index, def);
                            });

                            // 添加双击事件 - 直接复用底部导航栏的双击跳转功能
                            item.addEventListener('dblclick', () => {
                                // 先选择当前定义项，更新Context Window的内容
                                selectDefinitionItem(index, def);
                                
                                // 然后直接调用底部导航栏的双击跳转逻辑
                                setTimeout(() => {
                                    vscode.postMessage({
                                        type: 'doubleClick',
                                        location: 'bottomArea'
                                    });
                                }, 100); // 稍微延迟确保内容已更新
                            });

                            listItems.appendChild(item);
                            
                            // 如果是默认激活的项，自动选择它
                            if (def.isActive) {
                                setTimeout(() => {
                                    selectDefinitionItem(index, def);
                                }, 100);
                            }
                        });

                        // 添加键盘事件监听
                        setupDefinitionListKeyboardNavigation(definitions);
                        
                        // 强制Monaco编辑器重新布局以适应新的容器大小
                        if (editor) {
                            setTimeout(() => {
                                editor.layout();
                            }, 100);
                        }
                    }

                    function selectDefinitionItem(index, def) {
                        // 移除其他项的active状态
                        document.querySelectorAll('.definition-item').forEach(i => i.classList.remove('active'));
                        // 添加当前项的active状态
                        const items = document.querySelectorAll('.definition-item');
                        if (items[index]) {
                            items[index].classList.add('active');
                            // 滚动到可见区域
                            items[index].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        }

                        // 发送消息到扩展
                        vscode.postMessage({
                            type: 'definitionItemSelected',
                            symbolName: def.title,
                            filePath: def.filePath,
                            lineNumber: def.lineNumber,
                            index: index
                        });
                    }

                    // 全局变量存储当前定义数据和键盘处理函数
                    let currentDefinitions = [];
                    let handleDefinitionListKeydown = null;

                    function setupDefinitionListKeyboardNavigation(definitions) {
                        currentDefinitions = definitions;
                        
                        // 移除之前的事件监听器
                        if (handleDefinitionListKeydown) {
                            document.removeEventListener('keydown', handleDefinitionListKeydown);
                        }
                        
                        // 创建新的事件处理函数
                        handleDefinitionListKeydown = function(e) {
                            const items = document.querySelectorAll('.definition-item');
                            if (items.length === 0) return;

                            const currentActive = document.querySelector('.definition-item.active');
                            let currentIndex = currentActive ? Array.from(items).indexOf(currentActive) : 0;

                            switch (e.key) {
                                case 'ArrowUp':
                                case 'Up':
                                    e.preventDefault();
                                    currentIndex = Math.max(0, currentIndex - 1);
                                    selectDefinitionItem(currentIndex, currentDefinitions[currentIndex]);
                                    break;
                                
                                case 'ArrowDown':
                                case 'Down':
                                    e.preventDefault();
                                    currentIndex = Math.min(items.length - 1, currentIndex + 1);
                                    selectDefinitionItem(currentIndex, currentDefinitions[currentIndex]);
                                    break;
                                
                                case 'p':
                                    if (e.ctrlKey) {
                                        e.preventDefault();
                                        currentIndex = Math.max(0, currentIndex - 1);
                                        selectDefinitionItem(currentIndex, currentDefinitions[currentIndex]);
                                    }
                                    break;
                                
                                case 'n':
                                    if (e.ctrlKey) {
                                        e.preventDefault();
                                        currentIndex = Math.min(items.length - 1, currentIndex + 1);
                                        selectDefinitionItem(currentIndex, currentDefinitions[currentIndex]);
                                    }
                                    break;
                                
                                case 'Escape':
                                    e.preventDefault();
                                    // 发送消息关闭定义列表
                                    vscode.postMessage({
                                        type: 'closeDefinitionList'
                                    });
                                    break;
                                
                                case 'Enter':
                                    e.preventDefault();
                                    // Enter键选择当前项（已经通过selectDefinitionItem处理了）
                                    break;
                            }
                        };
                        
                        // 添加新的事件监听器
                        document.addEventListener('keydown', handleDefinitionListKeydown);
                    }

                    function clearDefinitionList() {
                        const listItems = document.querySelector('#definition-list .list-items');
                        if (listItems) {
                            listItems.innerHTML = '';
                        }
                        
                        // 隐藏定义列表，让Monaco编辑器占满整个空间
                        const definitionList = document.querySelector('#definition-list');
                        const mainContainer = document.querySelector('#main-container');
                        
                        if (definitionList) {
                            definitionList.style.display = 'none';
                        }
                        
                        if (mainContainer) {
                            mainContainer.style.flexDirection = 'row';
                        }
                        
                        // 强制Monaco编辑器重新布局以适应新的容器大小
                        if (editor) {
                            setTimeout(() => {
                                editor.layout();
                            }, 100);
                        }
                        
                        // 移除键盘事件监听器
                        if (handleDefinitionListKeydown) {
                            document.removeEventListener('keydown', handleDefinitionListKeydown);
                            handleDefinitionListKeydown = null;
                        }
                    }
                    
                    // 处理来自扩展的消息
                    window.addEventListener('message', event => {
                        const message = event.data;
                        //console.log('[definition] Received message:', message);
                        
                        try {
                            switch (message.type) {
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
                                        // 重新定义主题
                                        monaco.editor.defineTheme('custom-vs', {
                                            base: light ? 'vs' : 'vs-dark',
                                            inherit: true,
                                            rules: window.vsCodeEditorConfiguration.customThemeRules,
                                            colors: {
                                                "editor.selectionBackground": message.contextEditorCfg.selectionBackground,
                                                "editor.inactiveSelectionBackground": message.contextEditorCfg.inactiveSelectionBackground,
                                                "editor.selectionHighlightBackground": message.contextEditorCfg.selectionHighlightBackground,
                                                "editor.selectionHighlightBorder": message.contextEditorCfg.selectionHighlightBorder,
                                                // ... 其他颜色
                                            }
                                        });
                                        
                                        // 重新应用主题
                                        if (editor) {
                                            editor.updateOptions({ theme: 'custom-vs' });
                                        }
                                    }
                                    break;
                                case 'updateTheme':
                                    // 更新编辑器主题
                                    if (editor && message.theme) {
                                        //monaco.editor.setTheme(message.theme);
                                    }
                                    break;
                                case 'shortJump':
                                    if (editor) {
                                        const models = monaco.editor.getModels();
                                        let model = models.length > 0 ? models[0] : null;
                                        
                                        if (!model) {
                                            //console.log('[definition] no model', models);
                                            //console.log('[definition] ***********Creating new model with language*************:', message.languageId);
                                            model = monaco.editor.createModel(content, language || 'plaintext');
                                            editor.setModel(model);
                                        }

                                        // 清除之前的装饰
                                        const existingDecorations = editor.getDecorationsInRange(new monaco.Range(
                                            1, 1,
                                            model.getLineCount(),
                                            Number.MAX_SAFE_INTEGER
                                        ));
                                        const symbolDecorations = existingDecorations?.filter(d => d.options.inlineClassName === 'highlighted-symbol');
                                        if (symbolDecorations && symbolDecorations.length > 0) {
                                            editor.deltaDecorations(symbolDecorations.map(d => d.id), []);
                                        }
                                        
                                        // 滚动到指定行
                                        if (message.scrollToLine) {
                                            //console.log('[definition] Scrolling to line:', message.scrollToLine);
                                            

                                            // 添加行高亮装饰
                                            const lineDecorations = editor.deltaDecorations([], [{
                                                range: new monaco.Range(message.scrollToLine, 1, message.scrollToLine, 1),
                                                options: {
                                                    isWholeLine: true,
                                                    className: 'highlighted-line',
                                                    glyphMarginClassName: 'highlighted-glyph'
                                                }
                                            }]);

                                            let line = message.scrollToLine;
                                            let column = 1;
                                            
                                            // 如果有定义名，高亮它
                                            if (message.symbolName) {
                                                const text = model.getValue();
                                                const lines = text.split('\n');
                                                const lineText = lines[message.scrollToLine - 1] || '';
                                                
                                                // 在当前行查找符号名
                                                const symbolIndex = lineText.indexOf(message.symbolName);
                                                //console.log('[definition] Symbol index:', symbolIndex);
                                                if (symbolIndex !== -1) {
                                                    column = symbolIndex + 1;
                                                    // 添加符号高亮装饰
                                                    editor.deltaDecorations([], [{
                                                        range: new monaco.Range(
                                                            message.scrollToLine,
                                                            symbolIndex + 1,
                                                            message.scrollToLine,
                                                            symbolIndex + message.symbolName.length + 1
                                                        ),
                                                        options: {
                                                            inlineClassName: 'highlighted-symbol'
                                                        }
                                                    }]);
                                                } else {
                                                    //console.log('[definition] Symbol not found in line: ', lineText);
                                                    //console.log(`[definition] Symbol not found in line: ${message.symbolName}`);
                                                }
                                            }
                                            editor.setSelection({
                                                            startLineNumber: line,
                                                            startColumn: column,
                                                            endLineNumber: line,
                                                            endColumn: column
                                                        });
                                            // force layout before scrolling
                                            //editor.layout();
                                            editor.revealLineInCenter(message.scrollToLine);
                                        }
                                    } else {
                                        //console.error('[definition] Editor not initialized');
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
                                case 'update':
                                    //console.log('[definition] Updating editor content');
                                    // 显示编辑器，隐藏原始内容区域
                                    document.getElementById('container').style.display = 'block';
                                    document.getElementById('main').style.display = 'none';

                                    uri = message.uri;
                                    //console.log('[definition] Updating editor content with URI:', uri);
                                    updateFilenameDisplay(uri);
                                    
                                    // 更新编辑器内容和语言
                                    if (editor) {
                                        const models = monaco.editor.getModels();
                                        let model = models.length > 0 ? models[0] : null;

                                        content = message.body;
                                        language = message.languageId;
                                        
                                        if (!model) {
                                            //console.log('[definition] no model', models);
                                            //console.log('[definition] ***********Creating new model with language*************:', message.languageId);
                                            model = monaco.editor.createModel(message.body, message.languageId || 'plaintext');
                                            editor.setModel(model);
                                        } else {
                                            //console.log('[definition] Updating existing model');
                                            // 如果语言变了，更新语言
                                            if (model.getLanguageId() !== message.languageId && message.languageId) {
                                                //console.log('[definition] Changing language from', model.getLanguageId(), 'to', message.languageId);
                                                monaco.editor.setModelLanguage(model, message.languageId);
                                            }
                                            // 更新内容
                                            model.setValue(message.body);
                                        }

                                        const initialTheme = editor.getOption(monaco.editor.EditorOption.theme);
                                        //console.log('[definition] 初始主题:', initialTheme);

                                        // 清除之前的装饰
                                        const existingDecorations = editor.getDecorationsInRange(new monaco.Range(
                                            1, 1,
                                            model.getLineCount(),
                                            Number.MAX_SAFE_INTEGER
                                        ));
                                        const symbolDecorations = existingDecorations?.filter(d => d.options.inlineClassName === 'highlighted-symbol');
                                        if (symbolDecorations && symbolDecorations.length > 0) {
                                            editor.deltaDecorations(symbolDecorations.map(d => d.id), []);
                                        }
                                        
                                        // 滚动到指定行
                                        if (message.scrollToLine) {
                                            //console.log('[definition] Scrolling to line:', message.curLine);
                                            // force layout before scrolling
                                            editor.layout();

                                            let line = message.scrollToLine;
                                            if (message.curLine && message.curLine !== -1)
                                                line = message.curLine;
                                            editor.revealLineInCenter(line);

                                            // 添加行高亮装饰
                                            const lineDecorations = editor.deltaDecorations([], [{
                                                range: new monaco.Range(message.scrollToLine, 1, message.scrollToLine, 1),
                                                options: {
                                                    isWholeLine: true,
                                                    className: 'highlighted-line',
                                                    glyphMarginClassName: 'highlighted-glyph'
                                                }
                                            }]);
                                            let column = 1;
                                            // 如果有定义名，高亮它
                                            if (message.symbolName) {
                                                const text = model.getValue();
                                                const lines = text.split('\n');
                                                const lineText = lines[message.scrollToLine - 1] || '';
                                                
                                                // 在当前行查找符号名
                                                const symbolRegex = new RegExp(`\\b${message.symbolName}\\b`);
                                                const symbolMatch = lineText.match(symbolRegex);
                                                const symbolIndex = symbolMatch ? symbolMatch.index : -1;
                                                //console.log('[definition] Symbol index:', symbolIndex);
                                                if (symbolIndex !== -1) {
                                                    column = symbolIndex + 1;
                                                    // 添加符号高亮装饰
                                                    editor.deltaDecorations([], [{
                                                        range: new monaco.Range(
                                                            message.scrollToLine,
                                                            symbolIndex + 1,
                                                            message.scrollToLine,
                                                            symbolIndex + message.symbolName.length + 1
                                                        ),
                                                        options: {
                                                            inlineClassName: 'highlighted-symbol'
                                                        }
                                                    }]);
                                                } else {
                                                    //console.log('[definition] Symbol not found in line: ', lineText);
                                                    //console.log(`[definition] Symbol not found in line: ${message.symbolName}`);
                                                }
                                            }
                                        }
                                        // 内容设置完成后，发送确认消息
                                        setTimeout(() => {
                                            vscode.postMessage({ type: 'contentReady' });
                                        }, 1); // 稍微延迟确保渲染完成
                                    } else {
                                        console.error('[definition] Editor not initialized');
                                    }
                                    break;
                                    
                                case 'noContent':
                                    //console.log('[definition] Showing no content message');
                                    // 显示原始内容区域，隐藏编辑器
                                    document.getElementById('container').style.display = 'none';
                                    document.getElementById('main').style.display = 'block';
                                    document.getElementById('main').innerHTML = message.body;
                                    break;
                                    
                                case 'startLoading':
                                    //console.log('[definition] Starting loading animation');
                                    document.querySelector('.loading').classList.add('active');
                                    setTimeout(() => {
                                        document.querySelector('.loading').classList.add('show');
                                    }, 0);
                                    break;
                                    
                                case 'endLoading':
                                    //console.log('[definition] Ending loading animation');
                                    document.querySelector('.loading').classList.remove('show');
                                    setTimeout(() => {
                                        document.querySelector('.loading').classList.remove('active');
                                    }, 200);
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
import * as vscode from 'vscode';
import { Renderer, FileContentInfo } from './renderer';

enum UpdateMode {
    Live = 'live',
    Sticky = 'sticky',
}
const maxHistorySize = 50;

interface HistoryInfo {
    content: FileContentInfo | undefined;
    curLine: number;
}

export class ContextWindowProvider implements vscode.WebviewViewProvider {
    // Add a new property to cache the last content
    private _history: HistoryInfo[] = [];
    private _historyIndex: number = 0;

    private _mousePressed: boolean = false;
    private _mouseTimer?: NodeJS.Timeout;  // 添加timer引用

    //private static readonly outputChannel = vscode.window.createOutputChannel('Context View');

    private currentUri: vscode.Uri | undefined = undefined;
    private currentLine: number = 0; // 添加行号存储
    public static readonly viewType = 'contextView.context';

    private static readonly pinnedContext = 'contextView.contextWindow.isPinned';

    private readonly _disposables: vscode.Disposable[] = [];

    private readonly _renderer = new Renderer();

    private _view?: vscode.WebviewView;
    private _currentCacheKey: CacheKey = cacheKeyNone;
    private _loading?: { cts: vscode.CancellationTokenSource }

    private _updateMode = UpdateMode.Sticky;
    private _pinned = false;
    private _currentPanel?: vscode.WebviewPanel; // 添加成员变量存储当前面板
    private _pickItems: any[] | undefined; // 添加成员变量存储选择项

    private _themeListener: vscode.Disposable | undefined;

    private _isFirstStart: boolean = true;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) {
        // 监听主题变化
        this._themeListener = vscode.window.onDidChangeActiveColorTheme(theme => {
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'updateTheme',
                    theme: this._getVSCodeTheme(theme)
                });
            }
        });

        // 监听编辑器配置变化
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('editor')) {
                if (this._view) {
                    const updatedConfig = this._getVSCodeEditorConfiguration();
                    this._view.webview.postMessage({
                        type: 'updateEditorConfiguration',
                        configuration: updatedConfig
                    });
                }
            }
        }, null, this._disposables);

        // Listens for changes to workspace folders (when user adds/removes folders)
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            if (this._currentPanel) {
                //ContextWindowProvider.outputChannel.appendLine('[definition] onDidChangeWorkspaceFolders dispose');
                this._currentPanel.dispose();
                this._currentPanel = undefined;
            }
        }, null, this._disposables);

        // 失去焦点时
        vscode.window.onDidChangeWindowState((e) => {
            if (!e.focused && this._currentPanel) {
                //ContextWindowProvider.outputChannel.appendLine('[definition] onDidChangeWindowState dispose');
                this._currentPanel.dispose();
                this._currentPanel = undefined;
            }
        }, null, this._disposables);

        // when the extension is deactivated，clean up resources
        this._disposables.push(
            vscode.Disposable.from({
                dispose: () => {
                    if (this._currentPanel) {
                        //ContextWindowProvider.outputChannel.appendLine('[definition] dispose');
                        this._currentPanel.dispose();
                        this._currentPanel = undefined;
                    }
                }
            })
        );
        let lastPosition: vscode.Position | undefined;
        let lastDocumentVersion: number | undefined;
        // 修改选择变化事件处理
        vscode.window.onDidChangeTextEditorSelection((e) => {
            // 跳过非空选区的更新
            if (!e.selections[0].isEmpty) {
                return;
            }

            const currentPosition = e.selections[0].active;
            const currentDocumentVersion = e.textEditor.document.version;

            // 检查是否是输入事件（文档版本变化）
            if (lastDocumentVersion && currentDocumentVersion !== lastDocumentVersion) {
                //console.log('[definition] onDidChangeTextEditorSelection ret: ', currentDocumentVersion, lastDocumentVersion);
                lastDocumentVersion = currentDocumentVersion;
                lastPosition = currentPosition;
                return;
            }

            lastPosition = currentPosition;
            lastDocumentVersion = currentDocumentVersion;

            //console.log('[definition] onDidChangeTextEditorSelection: ', e);

            // 只处理鼠标和键盘触发的事件
            if (e.kind === vscode.TextEditorSelectionChangeKind.Mouse || 
                e.kind === vscode.TextEditorSelectionChangeKind.Keyboard) {
                
                if (e.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
                    // 鼠标事件：标记需要更新，但等待鼠标松开
                    this._mousePressed = true;

                    // 清除之前的timer
                    if (this._mouseTimer) {
                        clearTimeout(this._mouseTimer);
                    }
                    
                    // 设置一个延时检测鼠标松开状态
                    this._mouseTimer = setTimeout(() => {
                        if (this._mousePressed) {
                            this._mousePressed = false;
                            const editor = vscode.window.activeTextEditor;
                            if (editor?.selection.isEmpty) {
                                this.update();
                            }
                        }
                    }, 300); // 300ms 后检查鼠标状态
                } else {
                    // 键盘事件：直接更新
                    this.update();
                }
            }
        }, null, this._disposables);

        this._renderer.needsRender(() => {
            //console.log('[definition] needsRender update');
            this.update(/* force */ true);
        }, undefined, this._disposables);

        // Listens for VS Code settings changes
        vscode.workspace.onDidChangeConfiguration(() => {
            this.updateConfiguration();
        }, null, this._disposables);

        this.updateConfiguration();
        //this.update(); // 此时view还未创建，无法更新

        // Add delayed initial update，保底更新
        setTimeout(() => {
            //console.log('[definition] timeout update');
            this.update(/* force */ true);
        }, 2000); // Wait for 2 seconds after initialization

        // listen for language status changes
        vscode.languages.onDidChangeDiagnostics(e => {
            if (!this._isFirstStart)
                return;
            this._isFirstStart = false;
            const editor = vscode.window.activeTextEditor;
            
            if (editor && e.uris.some(uri => uri.toString() === editor.document.uri.toString())) {
                //console.log('[definition] Document diagnostics updated, updating definitions');
                this.update(/* force */ true);
            }
        }, null, this._disposables);
    }

    private getCurrentContent() : HistoryInfo {
        return (this._history && this._history.length > this._historyIndex) ? this._history[this._historyIndex] : { content: undefined, curLine: -1 };
    }

    private addToHistory(contentInfo: FileContentInfo, fromLine: number =-1) {
        // 清除_historyIndex后的内容
        this._history = this._history.slice(0, this._historyIndex + 1);
        this._history.push({ content: contentInfo, curLine: -1 });
        this._historyIndex++;

        this._history[this._historyIndex-1].curLine = fromLine;

        //console.log('[definition] add history', this._history);

        if (this._history.length > maxHistorySize) {
            this._history.shift();
            this._historyIndex--;
        }
    }

    // 获取 VS Code 主题对应的 Monaco 主题
    private _getVSCodeTheme(theme?: vscode.ColorTheme): string {
        if (!theme) {
            theme = vscode.window.activeColorTheme;
        }
        
        switch (theme.kind) {
            case vscode.ColorThemeKind.Dark:
                return 'vs-dark';
            case vscode.ColorThemeKind.HighContrast:
                return 'hc-black';
            default:
                return 'vs';
        }
    }

    // 获取 VS Code 编辑器完整配置
    private _getVSCodeEditorConfiguration(): any {
        // 获取所有编辑器相关配置
        const editorConfig = vscode.workspace.getConfiguration('editor');
        const currentTheme = this._getVSCodeTheme();
        
        // 构建配置对象
        const config: {
            theme: string;
            editorOptions: any;
            customThemeRules?: any[];
        } = {
            theme: this._getVSCodeTheme(),
            // 将编辑器配置转换为对象
            editorOptions: {
                ...Object.assign({}, editorConfig),
                links: true
            },
        };

        // 只在 light 主题下添加自定义主题规则
        if (currentTheme === 'vs') {
            config.customThemeRules = [
                // 关键字和控制流
                { token: 'keyword', foreground: '#0000ff' },           // 关键字：蓝色
                { token: 'keyword.type', foreground: '#ff0000', fontStyle: 'bold' },      // 流程控制关键字：红色
                { token: 'keyword.flow', foreground: '#ff0000', fontStyle: 'bold' },      // 流程控制关键字：红色
                { token: 'keyword.control', foreground: '#ff0000' },   // 控制关键字：红色
                { token: 'keyword.operator', foreground: '#ff0000' },  // 操作符关键字：红色
                { token: 'keyword.declaration', foreground: '#0000ff' }, // 声明关键字：蓝色
                { token: 'keyword.modifier', foreground: '#0000ff' },  // 修饰符关键字：蓝色
                { token: 'keyword.conditional', foreground: '#ff0000' }, // 条件关键字：红色
                { token: 'keyword.repeat', foreground: '#ff0000' },    // 循环关键字：红色
                { token: 'keyword.exception', foreground: '#ff0000' }, // 异常关键字：红色
                { token: 'keyword.other', foreground: '#0000ff' },     // 其他关键字：蓝色
                { token: 'keyword.predefined', foreground: '#0000ff' }, // 预定义关键字：蓝色
                { token: 'keyword.function', foreground: '#ff0000', fontStyle: 'bold' }, // 预定义关键字：蓝色
                { token: 'keyword.directive', foreground: '#0000ff' }, // include
                { token: 'keyword.directive.control', foreground: '#ff0000', fontStyle: 'bold' }, // #if #else
                
                // 变量和标识符
                { token: 'variable', foreground: '#000080' },          // 变量：红色
                { token: 'variable.name', foreground: '#000080', fontStyle: 'bold' },     // 变量名：红色
                { token: 'variable.parameter', foreground: '#000080' },//, fontStyle: 'bold' }, // 参数变量：红色
                { token: 'variable.predefined', foreground: '#ff0000', fontStyle: 'bold' }, // 预定义变量：红色
                { token: 'identifier', foreground: '#000080' },        // 标识符：青色
                
                // 类型和类
                { token: 'type', foreground: '#0000ff' },              // 类型：蓝色
                { token: 'type.declaration', foreground: '#0000ff' },  // 类型声明：蓝色
                { token: 'class', foreground: '#ff0000' },             // 类：红色
                { token: 'class.name', foreground: '#0000ff', fontStyle: 'bold' },        // 类名：蓝色
                { token: 'entity.name.type.class', foreground: '#ff0000', fontStyle: 'bold' },  // 类名：红色加粗
                { token: 'entity.name.type', foreground: '#ff0000', fontStyle: 'bold' },        // 类型名：红色加粗
                { token: 'interface', foreground: '#ff0000' },         // 接口：青色
                { token: 'enum', foreground: '#ff0000' },              // 枚举：青色
                { token: 'struct', foreground: '#ff0000' },            // 结构体：青色
                
                // 函数和方法
                { token: 'function', foreground: '#a00000' },          // 函数：棕色
                { token: 'function.name', foreground: '#a00000', fontStyle: 'bold' },     // 函数名：棕色
                { token: 'function.call', foreground: '#a00000' },     // 函数调用：棕色
                { token: 'method', foreground: '#a00000' },            // 方法：棕色
                { token: 'method.name', foreground: '#a00000', fontStyle: 'bold' },       // 方法名：棕色
                
                // 字面量
                { token: 'string', foreground: '#005700' },            // 字符串：红色
                { token: 'string.escape', foreground: '#005700' },     // 转义字符：红色
                { token: 'number', foreground: '#ff0000' },            // 数字：绿色
                { token: 'boolean', foreground: '#800080' },           // 布尔值：蓝色
                { token: 'regexp', foreground: '#811f3f' },            // 正则表达式：暗红色
                { token: 'null', foreground: '#0000ff' },              // null：蓝色
                
                // 注释
                { token: 'comment', foreground: '#005700' },           // 注释：绿色
                { token: 'comment.doc', foreground: '#005700' },       // 文档注释：绿色
                
                // 属性和成员
                { token: 'property', foreground: '#000080' },          // 属性：深蓝色
                { token: 'property.declaration', foreground: '#000080' }, // 属性声明：深蓝色
                { token: 'member', foreground: '#000080' },            // 成员：深蓝色
                { token: 'field', foreground: '#000080' },             // 字段：深蓝色
                
                // 操作符和分隔符
                { token: 'operator', foreground: '#800080' },          // 运算符：紫色
                { token: 'delimiter', foreground: '#000000' },         // 分隔符：黑色
                { token: 'delimiter.bracket', foreground: '#000000' }, // 括号：黑色
                { token: 'delimiter.parenthesis', foreground: '#000000' }, // 圆括号：黑色
                
                // 标签和特殊元素
                { token: 'tag', foreground: '#800000' },               // 标签：暗红色
                { token: 'tag.attribute.name', foreground: '#ff0000' }, // 标签属性名：红色
                { token: 'attribute.name', foreground: '#ff0000' },    // 属性名：红色
                { token: 'attribute.value', foreground: '#0000ff' },   // 属性值：蓝色
                
                // 其他类型
                { token: 'namespace', foreground: '#ff0000' },         // 命名空间：青色
                { token: 'constant', foreground: '#800080' },          // 常量：暗红色
                { token: 'constant.language', foreground: '#0000ff' }, // 语言常量：蓝色
                { token: 'modifier', foreground: '#0000ff' },          // 修饰符：蓝色
                { token: 'constructor', foreground: '#a00000' },       // 构造函数：棕色
                { token: 'decorator', foreground: '#ff0000' },         // 装饰器：青色
                { token: 'macro', foreground: '#800080', fontStyle: 'italic' }              // 宏：紫色
            ];
        }

        //console.log('[definition] editor', editorConfig);
        
        // 添加语法高亮配置
        // if (tokenColorCustomizations) {
        //     console.log('[definition] tokenColorCustomizations', tokenColorCustomizations);
        //     config.tokenColorCustomizations = tokenColorCustomizations;
        // }
        
        // 添加语义高亮配置
        // if (semanticTokenColorCustomizations) {
        //     console.log('[definition] semanticTokenColorCustomizations', semanticTokenColorCustomizations);
        //     config.semanticTokenColorCustomizations = semanticTokenColorCustomizations;
        // }
        
        return config;
    }

    dispose() {
        //ContextWindowProvider.outputChannel.appendLine('[definition] Provider disposing...');
        // 确保关闭定义选择面板
        if (this._currentPanel) {
            this._currentPanel.dispose();
            this._currentPanel = undefined;
        }

        // 清理其他资源
        let item: vscode.Disposable | undefined;
        while ((item = this._disposables.pop())) {
            item.dispose();
        }

        //ContextWindowProvider.outputChannel.dispose();
        if (this._themeListener) {
            this._themeListener.dispose();
            this._themeListener = undefined;
        }
    }

    private navigate(direction: 'back' | 'forward') {
        let lastIdx = this._historyIndex;
        // 实现导航逻辑
        if (direction === 'back' && this._historyIndex > 0) {
            this._historyIndex--;
        } else if (direction === 'forward' && this._historyIndex < this._history.length - 1) {
            this._historyIndex++;
        }
        if (lastIdx !== this._historyIndex) {
            const contentInfo = this._history[this._historyIndex];
            this.updateContent(contentInfo?.content, contentInfo.curLine);
        }
    }

    private isSameDefinition(uri: string, line: number, token: string): boolean {
        let curFileContentInfo = (this._historyIndex < this._history.length) ? this._history[this._historyIndex] : undefined;
        return (curFileContentInfo && curFileContentInfo.content) ? (curFileContentInfo.content.jmpUri === uri && curFileContentInfo.content.line === line && curFileContentInfo.content.symbolName === token) : false;
    }

    private isSameUri(uri: string): boolean {
        let curFileContentInfo = (this._historyIndex < this._history.length) ? this._history[this._historyIndex] : undefined;
        return (curFileContentInfo && curFileContentInfo.content) ? (curFileContentInfo.content.jmpUri === uri) : false;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        const editor = vscode.window.activeTextEditor;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'),
                vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'monaco-editor') // 添加 Monaco Editor 资源路径
            ]
        };
    
        // 使用 _getHtmlForWebview 方法生成 HTML 内容
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // 添加webview消息处理
        webviewView.webview.onDidReceiveMessage(async message => {
            //console.log('[definition] webview message', message);
            switch (message.type) {
                case 'navigate':
                    this.navigate(message.direction);
                    break;
                case 'jumpDefinition':
                    if (editor && message.uri?.length > 0) {
                        if (this.isSameDefinition(message.uri, message.position.line, message.token)) {
                            // 不需处理
                        } else {
                            let definitions = await vscode.commands.executeCommand<vscode.Location[]>(
                                'vscode.executeDefinitionProvider',
                                vscode.Uri.parse(message.uri),
                                new vscode.Position(message.position.line, message.position.character)
                            );

                            if (definitions && definitions.length > 0) {
                                //console.log('[definition] jumpDefinition: ', definitions);
                                // 如果有多个定义，传递给 Monaco Editor
                                if (definitions.length > 1) {
                                    const selectedDefinition = await this.showDefinitionPicker(definitions, editor);
                                    definitions = selectedDefinition ? [selectedDefinition] : [];
                                }
                                //console.log('[definition] jumpDefinition: ', message.token);
                                if (definitions && definitions.length > 0) {
                                    const contentInfo = await this._renderer.renderDefinitions(editor.document, definitions, message.token);
                                    this.updateContent(contentInfo);
                                    this.addToHistory(contentInfo, message.position.line);
                                    //console.log('[definition] jumpDefinition: ', contentInfo);
                                }
                            }
                        }
                    }
                    break;
                case 'doubleClick':
                    if (message.location === 'bottomArea') {
                        let curContext = this.getCurrentContent();
                        this.currentUri = (curContext && curContext.content)? vscode.Uri.parse(curContext.content.jmpUri) : undefined;
                        this.currentLine = (curContext && curContext.content)? curContext.content.line : 0;
                        if (this.currentUri) {
                            // 打开文件
                            const document = await vscode.workspace.openTextDocument(this.currentUri);
                            const editor = await vscode.window.showTextDocument(document);
                            
                            // 跳转到指定行
                            const line = this.currentLine;//message.line - 1; // VSCode的行号从0开始
                            const range = new vscode.Range(line, 0, line, 0);
                            
                            // 移动光标并显示该行
                            editor.selection = new vscode.Selection(range.start, range.start);
                            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                            this._currentCacheKey = createCacheKey(vscode.window.activeTextEditor);
                        }
                    }
                    break;
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (this._view?.visible) {
                let curContext = this.getCurrentContent();
                //console.log('[definition] onDidChangeVisibility');
                // If we have cached content, restore it immediately
                if (curContext?.content) {
                    // Show loading
                    //this._view?.webview.postMessage({ type: 'startLoading' });
                    this._view.webview.postMessage({
                        type: 'update',
                        body: curContext.content.content,
                        uri: curContext.content.jmpUri,
                        languageId: curContext.content.languageId,
                        updateMode: this._updateMode,
                        scrollToLine: curContext.content.line + 1,
                        curLine: curContext.curLine + 1,
                        symbolName: curContext.content.symbolName
                    });
                    // Hide loading after content is updated
                    //this._view?.webview.postMessage({ type: 'endLoading' });
                }
                else {
                    this._view?.webview.postMessage({
                        type: 'noContent',
                        body: '&nbsp;&nbsp;No symbol found at current cursor position',
                        updateMode: this._updateMode,
                    });
                    this.update(/* force */ true);
                }
            } else {
                if (this._currentPanel) {
                    this._currentPanel.dispose();
                    this._currentPanel = undefined;
                }
            }
        });

        webviewView.onDidDispose(() => {
            this._view = undefined;
        });

        this.updateTitle();

        let curContext = this.getCurrentContent();

        // 初始加载时如果有缓存内容就直接使用
        if (curContext?.content) {
            //console.log('[definition] Using cached content for initial load');
            // Show loading
            //this._view?.webview.postMessage({ type: 'startLoading' });
            this._view.webview.postMessage({
                type: 'update',
                body: curContext.content.content,
                languageId: curContext.content.languageId,
                updateMode: this._updateMode,
                scrollToLine: curContext.content.line + 1,
                curLine: curContext.curLine + 1,
                symbolName: curContext.content.symbolName
            });
            // Hide loading after content is updated
            //this._view?.webview.postMessage({ type: 'endLoading' });
        } else {
            //console.log('[definition] resolveWebviewView to update');
            // 没有缓存才触发更新
            this.update(/* force */ true);
        }
    }

    public pin() {
        this.updatePinned(true);
    }

    public unpin() {
        this.updatePinned(false);
    }

    private updatePinned(value: boolean) {
        if (this._pinned === value) {
            return;
        }

        this._pinned = value;
        vscode.commands.executeCommand('setContext', ContextWindowProvider.pinnedContext, value);

        this.update();
    }

    private updateTitle() {
        if (!this._view) {
            return;
        }
        this._view.description = this._pinned ? "(pinned)" : undefined;
    }
    private _getHtmlForWebview(webview: vscode.Webview) {
        // 获取Monaco Editor资源的URI
        const monacoScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'monaco-editor', 'min', 'vs')
        ).toString();
        
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

        const nonce = getNonce();

        // 获取当前主题
        const currentTheme = this._getVSCodeTheme();
        const editorConfiguration = this._getVSCodeEditorConfiguration();

        //console.log('[definition] ', currentTheme);
        //console.log('[definition] ', editorConfiguration);

        return /* html */`<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">

            <meta http-equiv="Content-Security-Policy" content="
                default-src 'none';
                style-src ${webview.cspSource} 'unsafe-inline';
                script-src 'nonce-${nonce}' 'unsafe-eval' ${webview.cspSource};
                img-src data: https: ${webview.cspSource};
                font-src ${webview.cspSource};
                ">

            <meta name="viewport" content="width=device-width, initial-scale=1.0">

            <style>
                .loading {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.08);
                    display: none;
                    justify-content: center;
                    align-items: center;
                    z-index: 1000;
                    opacity: 0;
                    transition: opacity 0.2s ease-in-out;
                }
                .loading.active {
                    display: flex;
                }
                .loading.show {
                    opacity: 1;
                }
                .loading::after {
                    content: '';
                    width: 20px;
                    height: 20px;
                    border: 2px solid #0078d4;
                    border-radius: 50%;
                    border-top-color: transparent;
                    animation: spin 1s linear infinite;
                }
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
                
                body, html, #container {
                    margin: 0;
                    padding: 0;
                    width: 100%;
                    height: 100%;
                    overflow: hidden;
                    cursor: pointer !important; /* 强制全局手型光标 */
                    box-sizing: border-box; /* 添加此行确保边框和内边距包含在元素宽高内 */
                }

                /* 添加以下样式确保没有顶部留白 */
                body {
                    position: absolute;
                    top: 0;
                    left: 0;
                    margin: 0 !important;
                    padding: 0 !important;
                }
                
                #container {
                    height: 100vh;
                    cursor: pointer !important; /* 强制容器手型光标 */
                    position: absolute;
                    top: 0;
                    left: 0;
                    margin-top: 0 !important;
                    padding-top: 0 !important;
                    overflow-x: auto !important; /* 添加横向滚动条 */
                    overflow-y: hidden; /* 保持垂直方向不滚动 */
                }

                /* 专门针对 Monaco Editor 的滚动条样式 */
                .monaco-editor .monaco-scrollable-element .slider.horizontal {
                    height: 15px !important; /* 增加横向滚动条高度 */
                }
                
                /* 确保 Monaco 滚动条容器有足够的高度 */
                .monaco-editor .monaco-scrollable-element .scrollbar.horizontal {
                    height: 18px !important; /* 滚动条容器高度 */
                    bottom: 0 !important;
                }

                /* 确保Monaco编辑器内容可以横向滚动 */
                .monaco-editor {
                    overflow-x: visible !important;
                }
                
                /* 确保编辑器内容区域可以横向滚动 */
                .monaco-editor .monaco-scrollable-element {
                    overflow-x: visible !important;
                }
                
                #main {
                    display: none;
                    padding: 10px;
                    cursor: pointer !important; /* 强制主内容区手型光标 */
                    margin-top: 0 !important;
                    overflow-x: auto !important; /* 添加横向滚动条 */
                }
                /* 新增底部导航栏样式 */
                .nav-bar {
                    position: fixed;
                    bottom: 0;
                    left: 0;
                    right: 0;
                    height: 24px;
                    background-color: var(--vscode-editor-background);
                    border-top: 1px solid var(--vscode-editorWidget-border);
                    display: flex;
                    align-items: center;
                    justify-content: flex-start;
                    gap: 8px;
                    z-index: 1000;
                    padding-left: 20px; /* 添加左侧内边距 */
                }

                .nav-button {
                    background-color: transparent;
                    color: var(--vscode-editor-foreground);
                    border: none;
                    padding: 0;
                    cursor: pointer;
                    width: 24px;
                    height: 16px;
                    position: relative;
                    border-radius: 4px;
                    transition: all 0.2s ease;
                    opacity: 0.7;
                }

                .nav-button:hover {
                    background-color: var(--vscode-editorWidget-background);
                    opacity: 1;
                }

                .nav-button::before {
                    content: '';
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    width: 8px;
                    height: 8px;
                    border: 2px solid var(--vscode-editor-foreground);
                    border-top: none;
                    border-right: none;
                    transform: translate(-50%, -50%) rotate(45deg);
                    opacity: 0.7;
                    transition: opacity 0.2s ease;
                }

                #nav-forward::before {
                    transform: translate(-50%, -50%) rotate(225deg);
                }

                .nav-button:hover::before {
                    opacity: 1;
                }
                /* 添加双击区域样式 */
                .double-click-area {
                    position: fixed;
                    bottom: 0; /* 与导航栏高度一致 */
                    left: 80px;
                    right: 0;
                    height: 24px;
                    z-index: 1001;
                    cursor: pointer;
                    background-color: rgba(89, 255, 0, 0.11); /* 调试用，可移除 */
                    display: flex;
                    align-items: left;
                    justify-content: left;
                    color: rgba(128, 128, 128, 0.8);
                    font-size: 14px;
                    font-style: italic;
                    padding-left: 10px;
                }
                /* 添加文件名显示样式 */
                .filename-display {
                    text-align: left;
                    color: rgba(128, 128, 128, 0.8);
                    font-size: 14px;
                    font-weight: normal;
                    font-style: normal;
                    max-width: 100%;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    z-index: 1002;
                    padding-left: 60px;
                }
            </style>

            <link href="${styleUri}" rel="stylesheet">
            
            <title>Definition View</title>
        </head>
        <body>
            <div class="loading"></div>
            <article id="main">加载中...</article>
            <div id="container"></div>

            <!-- 添加双击区域 -->
            <div class="double-click-area">
                <span>dbclick to open...</span>
                <span class="filename-display"></span>
            </div>
            
            <!-- 添加一个简单的初始化脚本，用于调试和传递Monaco路径 -->
            <script nonce="${nonce}">
                //console.log('[definition] HTML loaded');
                window.monacoScriptUri = '${monacoScriptUri}';
                //console.log('[definition] Monaco path set to:', window.monacoScriptUri);

                // 设置当前主题 - 确保使用有效的Monaco主题名称
                window.vsCodeTheme = '${currentTheme}';
                //console.log('[definition] Theme set to:', window.vsCodeTheme);
                
                // 传递完整编辑器配置 - 使用try-catch避免JSON序列化错误
                try {
                    window.vsCodeEditorConfiguration = ${JSON.stringify(editorConfiguration)};
                    //console.log('[definition] Editor configuration loaded', window.vsCodeEditorConfiguration);
                } catch (error) {
                    console.error('[definition] Failed to parse editor configuration:', error);
                    window.vsCodeEditorConfiguration = { 
                        editorOptions: {}, 
                        theme: '${currentTheme}' 
                    };
                }
            </script>
            
            <!-- 加载我们的主脚本，它会动态加载Monaco -->
            <script type="module" nonce="${nonce}" src="${scriptUri}" onerror="console.error('[definition] Failed to load main.js'); document.getElementById('main').innerHTML = '<div style=\\'color: red; padding: 20px;\\'>Failed to load main.js</div>'"></script>
            
            <!-- 新增底部导航栏 -->
            <div class="nav-bar">
                <button class="nav-button" id="nav-back">  </button>
                <button class="nav-button" id="nav-forward">  </button>
            </div>

            <script nonce="${nonce}">
                // 导航按钮事件处理
                const backButton = document.getElementById('nav-back');
                const forwardButton = document.getElementById('nav-forward');

                backButton.addEventListener('click', () => {
                    window.vscode.postMessage({
                        type: 'navigate',
                        direction: 'back'
                    });
                });

                forwardButton.addEventListener('click', () => {
                    window.vscode.postMessage({
                        type: 'navigate',
                        direction: 'forward'
                    });
                });

                // 更新按钮状态
                function updateNavButtons(canGoBack, canGoForward) {
                    backButton.disabled = !canGoBack;
                    forwardButton.disabled = !canGoForward;
                }
                // 双击事件处理
                const doubleClickArea = document.querySelector('.double-click-area');
                doubleClickArea.addEventListener('dblclick', () => {
                    //console.log('[definition] doubleClickArea');
                    window.vscode.postMessage({
                        type: 'doubleClick',
                        location: 'bottomArea'
                    });
                });
            </script>
        </body>
        </html>`;
    }

    private async updateContent(contentInfo?: FileContentInfo, curLine: number =-1) {
        //console.log('[definition] updateContent', contentInfo);
        if (contentInfo && contentInfo.content.length && contentInfo.jmpUri) {
            //console.log(`definition: update content ${contentInfo.content}`);
            //console.log(`definition: update content ${curLine}`);
            // Show loading
            //this._view?.webview.postMessage({ type: 'startLoading' });

            this._view?.webview.postMessage({
                type: 'update',
                body: contentInfo.content,
                uri: contentInfo.jmpUri.toString(),
                languageId: contentInfo.languageId, // 添加语言ID
                updateMode: this._updateMode,
                scrollToLine: contentInfo.line + 1,
                curLine: (curLine !== -1) ? curLine + 1 : -1,
                symbolName: contentInfo.symbolName // 添加符号名称
            });

            // Hide loading after content is updated
            //this._view?.webview.postMessage({ type: 'endLoading' });
        } else {
            this._view?.webview.postMessage({
                type: 'noContent',
                body: '&nbsp;&nbsp;No symbol found at current cursor position',
                updateMode: this._updateMode,
            });
        }
    }

    private async update(ignoreCache = false) {
        if (!this._view?.visible) {
            //console.log('[definition] update no view');
            return;
        }

        this.updateTitle();

        if (this._pinned) {
            //console.log('[definition] update pinned');
            return;
        }

        const newCacheKey = createCacheKey(vscode.window.activeTextEditor);
        if (!ignoreCache && cacheKeyEquals(this._currentCacheKey, newCacheKey)) {
            //console.log('[definition] the same cache key');
            return;
        }

        // Cancel any existing loading
        if (this._loading) {
            this._loading.cts.cancel();
            this._loading = undefined;
        }

        // 检查是否有有效的选择
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            //console.log('[definition] update no editor');
            return;
        }

        this._currentCacheKey = newCacheKey;
        
        //console.log('[definition] update');
        const loadingEntry = { cts: new vscode.CancellationTokenSource() };
        this._loading = loadingEntry;

        const updatePromise = (async () => {
            const contentInfo = await this.getHtmlContentForActiveEditor(loadingEntry.cts.token);
            if (loadingEntry.cts.token.isCancellationRequested) {
                return;
            }

            if (this._loading !== loadingEntry) {
                // A new entry has started loading since we started
                return;
            }
            this._loading = undefined;
            
            if (contentInfo.jmpUri) {
                this.currentUri = vscode.Uri.parse(contentInfo.jmpUri);
                this.currentLine = contentInfo.line;
            }
            
            if (this._updateMode === UpdateMode.Live || contentInfo.jmpUri) {
                this._history = [];
                this._history.push({ content: contentInfo, curLine: this.currentLine });
                this._historyIndex = 0;

                this.updateContent(contentInfo);
            }
        })();

        await Promise.race([
            updatePromise,

            // Don't show progress indicator right away, which causes a flash
            new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => {
                if (loadingEntry.cts.token.isCancellationRequested) {
                    return;
                }
                return vscode.window.withProgress({ location: { viewId: ContextWindowProvider.viewType } }, () => updatePromise);
            }),
        ]);
    }

    // 修改选择事件处理方法
    private async getHtmlContentForActiveEditor(token: vscode.CancellationToken): Promise<FileContentInfo> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            //console.log('No editor');
            // Around line 452, there's likely a return statement like this:
            // It needs to be updated to include the languageId property:
            return { content: '', line: 0, column: 0, jmpUri: '', languageId: 'plaintext', symbolName: '' };
        }
        // 获取当前光标位置
        const position = editor.selection.active;
        
        // 获取当前光标位置下的单词或标识符的范围
        const wordRange = editor.document.getWordRangeAtPosition(position);

        // 获取该范围内的文本内容
        const selectedText = wordRange ? editor.document.getText(wordRange) : '';
        //vscode.window.showInformationMessage(`Selected text: ${selectedText}`);

        let definitions = await this.getDefinitionAtCurrentPositionInEditor(editor);

        if (token.isCancellationRequested || !definitions || definitions.length === 0) {
            //console.log('[definition] No definitions found');
            return { content: '', line: 0, column: 0, jmpUri: '', languageId: 'plaintext', symbolName: '' };
        }

        // 确保关闭之前的面板
        if (this._currentPanel) {
            this._currentPanel.dispose();
            this._currentPanel = undefined;
        }

        if (definitions.length > 1) {
            const selectedDefinition = await this.showDefinitionPicker(definitions, editor);
            if (!selectedDefinition) {
                return { content: '', line: 0, column: 0, jmpUri: '', languageId: 'plaintext', symbolName: '' };
            }
            definitions = [selectedDefinition];
        }
        //console.log(definitions);
        return definitions.length ? await this._renderer.renderDefinitions(editor.document, definitions, selectedText) : {
            content: '',
            line: 0,
            column: 0,
            jmpUri: '',
            languageId: 'plaintext',
            symbolName: ''
        };
    }

    private async getDefinitionAtCurrentPositionInEditor(editor: vscode.TextEditor) {
        return await vscode.commands.executeCommand<vscode.Location[]>(
           'vscode.executeDefinitionProvider',
           editor.document.uri,
           editor.selection.active
        );
    }

    private updateConfiguration() {
        const config = vscode.workspace.getConfiguration('contextView');
        this._updateMode = config.get<UpdateMode>('contextWindow.updateMode') || UpdateMode.Sticky;
    }

    private async showDefinitionPicker(definitions: any[], editor: vscode.TextEditor): Promise<any> {
        return new Promise<any>((resolve) => {
            this._currentPanel = vscode.window.createWebviewPanel(
                'definitionPicker',
                'Select a Definition',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            const panel = this._currentPanel;
            let isResolved = false;

            // 先设置事件监听
            panel.webview.onDidReceiveMessage(async message => {
                //console.log('[definition] Received message from webview:', message);
                if (message.command === 'selectDefinition' && !isResolved) {
                    const selected = this._pickItems?.find(item => item.label === message.label);
                    if (selected) {
                        isResolved = true;
                        this._currentPanel = undefined;
                        panel.dispose();
                        resolve(selected.definition);
                    } else
                        resolve(undefined);
                    // 让编辑器重新获得焦点
                    if (editor) {
                        vscode.window.showTextDocument(editor.document, {
                            viewColumn: editor.viewColumn,
                            preserveFocus: false
                        });
                    }
                } else if (message.command === 'escapePressed' && !isResolved) {
                    // 处理 ESC 键按下事件
                    isResolved = true;
                    this._currentPanel = undefined;
                    panel.dispose();
                    // 让编辑器重新获得焦点
                    if (editor) {
                        vscode.window.showTextDocument(editor.document, {
                            viewColumn: editor.viewColumn,
                            preserveFocus: false
                        });
                    }
                    resolve(undefined);
                }
            });

            panel.onDidDispose(() => {
                this._pickItems = undefined; // Clear stored items
                if (!isResolved) {
                    isResolved = true;
                    this._currentPanel = undefined;
                    resolve(undefined);
                }
            });

            //console.log(`[definition] Showing definition picker with ${definitions.length} definitions`);
            //ContextWindowProvider.outputChannel.appendLine(`[definition] Showing definition picker with ${definitions.length} definitions`);

            // 然后准备并设置内容
            Promise.all(definitions.map(async (definition, index) => {
                try {
                    let def = definition;
                    let uri = (def instanceof vscode.Location) ? def.uri : def.targetUri;
                    // targetSelectionRange更准确，会有targetRange不正确的情况
                    let range = (def instanceof vscode.Location) ? def.range : (def.targetSelectionRange ?? def.targetRange);

                    const document = await vscode.workspace.openTextDocument(uri);
                    if (!document) {
                        //ContextWindowProvider.outputChannel.appendLine(`Could not open document: ${uri.toString()}`);
                        return null;
                    }
    
                    const startLine = Math.max(range.start.line - 3, 0);
                    const endLine = Math.min(range.start.line + 3, document.lineCount - 1);
                    
                    const codeLines = [];
                    for (let i = startLine; i <= endLine; i++) {
                        const line = document.lineAt(i).text;
                        if (i === range.start.line) {
                            codeLines.push(`<mark>${line}</mark>`);
                        } else {
                            codeLines.push(line);
                        }
                    }
                    // 留点空白
                    const codeSnippet = codeLines.join('        \n');
    
                    return {
                        label: `Definition ${index + 1}: ${uri.fsPath}`,
                        description: `Line: ${range.start.line + 1}, Column: ${range.start.character + 1}`,
                        detail: codeSnippet,
                        definition
                    };
                } catch (error) {
                    //ContextWindowProvider.outputChannel.appendLine(`Error processing definition: ${error}`);
                    return null;
                }
            })).then(items => {
                // Filter out any null items from errors
                const validItems = items.filter(item => item !== null);
                if (validItems.length === 0) {
                    //console.error('No valid definitions found');
                    panel.dispose();
                    resolve(undefined);
                    return;
                }
    
                this._pickItems = validItems;
                panel.webview.html = this.getDefinitionSelectorWebviewContent(validItems);
            }).catch(error => {
                //console.error('Error preparing definitions:', error);
                panel.dispose();
                resolve(undefined);
            });
        });
    }

    private getDefinitionSelectorWebviewContent(items: any[]): string {
        const itemsHtml = items.map(item => `
            <div class="item" ondblclick="selectDefinition('${item.label}')">
                <div class="header">
                    <strong>${item.label}</strong>
                    <p>${item.description}</p>
                </div>
                <div class="code-container">
                    <pre><code>${item.detail}</code></pre>
                </div>
            </div>
        `).join('');

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        margin: 0;
                        padding: 0;
                        max-height: 100vh;
                        overflow-y: auto;
                        overflow-x: hidden;
                    }
                    .item { 
                        padding: 10px; 
                        border-bottom: 1px solid #ccc; 
                        cursor: pointer;
                    }
                    .item:hover { 
                        background-color:rgba(0, 120, 212, 0.27);
                    }
                    .item.selected {
                        background-color: rgba(0, 120, 212, 0.27);
                        border-left: 3px solid #0078d4;
                    }
                    .header {
                        margin-bottom: 8px;
                    }
                    .code-container {
                        position: relative;
                        width: 100%;
                        overflow-x: auto;
                        background-color: #fafafa;
                        border-radius: 4px;
                        padding: 8px;  // Add horizontal padding to container
                    }
                    pre { 
                        margin: 0;
                        white-space: pre !important;
                        word-wrap: normal !important;
                        padding: 8px 24px;
                        background: transparent;
                        display: inline-block;
                        min-width: fit-content;
                    }
                    code {
                        white-space: pre !important;
                        word-wrap: normal !important;
                        display: inline-block;
                        font-family: var(--vscode-editor-font-family);
                        width: max-content;
                    }
                    mark {
                        background-color: #ffe58f;
                        padding: 2px 0;
                    }
                </style>
            </head>
            <body>
                ${itemsHtml}
                <script>
                    const vscode = acquireVsCodeApi();
                    let mouseDownTarget = null;
                let mouseDownPosition = null;

                function selectDefinition(label) {
                    vscode.postMessage({ command: 'selectDefinition', label });
                }

                // 添加键盘事件监听，处理 ESC 键
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') {
                        vscode.postMessage({ command: 'escapePressed' });
                    }
                     else if ((e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) || 
                            (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n'))) {
                        //console.log('[definition] ArrowUp or ArrowDown pressed');
                        // 防止默认滚动行为
                        e.preventDefault();
                        // 获取所有选项
                        const items = Array.from(document.querySelectorAll('.item'));
                        // 获取当前选中项
                        const current = document.querySelector('.item.selected');
                        let index = current ? items.indexOf(current) : -1;
                        
                        // 计算新选中项的索引
                        if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
                            index = Math.max(index - 1, 0);
                        } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
                            index = Math.min(index + 1, items.length - 1);
                        }
                        
                        // 更新选中状态
                        items.forEach((item, i) => {
                            item.classList.toggle('selected', i === index);
                        });
                        // 添加滚动居中效果
                        if (index >= 0) {
                            const selectedItem = items[index];
                            const itemHeight = selectedItem.offsetHeight;
                            const containerHeight = document.body.offsetHeight;
                            const scrollTop = selectedItem.offsetTop - (containerHeight / 2) + (itemHeight / 2);
                            
                            // 确保滚动容器是 body 元素
                            const scrollContainer = document.documentElement || document.body;
                            
                            // 添加边界检查
                            const maxScroll = scrollContainer.scrollHeight - containerHeight;
                            const finalScrollTop = Math.max(0, Math.min(scrollTop, maxScroll));
                            
                            scrollContainer.scrollTo({
                                top: finalScrollTop,
                                behavior: 'smooth'
                            });
                        }
                    } else if (e.key === 'Enter') {
                        // 处理回车键
                        const selected = document.querySelector('.item.selected');
                        if (selected) {
                            const label = selected.querySelector('strong').textContent;
                            selectDefinition(label);
                        }
                    }
                });

                // Handle mouse events on items
                document.querySelectorAll('.item').forEach(item => {
                    // Remove the ondblclick attribute from HTML
                    item.removeAttribute('ondblclick');
                    
                    // Track mouse down position
                    item.addEventListener('mousedown', (e) => {
                        mouseDownTarget = e.target;
                        mouseDownPosition = { x: e.clientX, y: e.clientY };
                    });

                    // Check on mouse up if we should trigger the click
                    item.addEventListener('mouseup', (e) => {
                        if (mouseDownTarget && mouseDownPosition) {
                            // Check if mouse moved significantly
                            const moveThreshold = 5; // pixels
                            const xDiff = Math.abs(e.clientX - mouseDownPosition.x);
                            const yDiff = Math.abs(e.clientY - mouseDownPosition.y);
                            
                            if (xDiff <= moveThreshold && yDiff <= moveThreshold) {
                                const label = item.querySelector('strong').textContent;
                                selectDefinition(label);
                            }
                        }
                        // Reset tracking variables
                        mouseDownTarget = null;
                        mouseDownPosition = null;
                    });
                });

                // Reset tracking variables if mouse leaves the item
                document.addEventListener('mouseleave', () => {
                    mouseDownTarget = null;
                    mouseDownPosition = null;
                });
                </script>
            </body>
            </html>
        `;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

type CacheKey = typeof cacheKeyNone | DocumentCacheKey;

const cacheKeyNone = { type: 'none' } as const;

class DocumentCacheKey {
    readonly type = 'document';

    constructor(
        public readonly url: vscode.Uri,
        public readonly version: number,
        public readonly wordRange: vscode.Range | undefined,
    ) { }

    public equals(other: DocumentCacheKey): boolean {
        if (this.url.toString() !== other.url.toString()) {
            return false;
        }

        if (this.version !== other.version) {
            return false;
        }

        if (other.wordRange === this.wordRange) {
            return true;
        }

        if (!other.wordRange || !this.wordRange) {
            return false;
        }

        return this.wordRange.isEqual(other.wordRange);
    }
}

function cacheKeyEquals(a: CacheKey, b: CacheKey): boolean {
    if (a === b) {
        return true;
    }

    if (a.type !== b.type) {
        return false;
    }

    if (a.type === 'none' || b.type === 'none') {
        return false;
    }

    return a.equals(b);
}

function createCacheKey(editor: vscode.TextEditor | undefined): CacheKey {
    if (!editor) {
        return cacheKeyNone;
    }

    return new DocumentCacheKey(
        editor.document.uri,
        editor.document.version,
        editor.document.getWordRangeAtPosition(editor.selection.active));
}

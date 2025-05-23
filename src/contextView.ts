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
                { token: 'keyword.operator', foreground: '#800080' },  // 操作符关键字：红色
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
                { token: 'tag.attribute.name', foreground: '#000080' }, // 标签属性名：红色
                { token: 'attribute.name', foreground: '#000080' },    // 属性名：红色
                { token: 'attribute.value', foreground: '#0000ff' },   // 属性值：蓝色
                
                // 其他类型
                { token: 'namespace', foreground: '#ff0000' },         // 命名空间：青色
                { token: 'constant', foreground: '#800080' },          // 常量：暗红色
                { token: 'constant.language', foreground: '#0000ff' }, // 语言常量：蓝色
                { token: 'modifier', foreground: '#0000ff' },          // 修饰符：蓝色
                { token: 'constructor', foreground: '#a00000' },       // 构造函数：棕色
                { token: 'decorator', foreground: '#800080' },         // 装饰器：青色
                { token: 'macro', foreground: '#A00000', fontStyle: 'italic' }              // 宏：紫色
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
            
            // 隐藏定义选择器，因为导航到了不同的上下文
            if (this._view) {
                this._view.webview.postMessage({ type: 'hideDefinitionPicker' });
            }
            // 清空选择项缓存
            this._pickItems = undefined;
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
                case 'showDefinitionPicker':
                    // 直接处理显示定义选择器的消息
                    if (message.items && Array.isArray(message.items)) {
                        // 不需要重新发送消息，webview会通过window.addEventListener接收到这个消息
                    }
                    break;
                case 'hideDefinitionPicker':
                    // 直接处理隐藏定义选择器的消息
                    // 不需要重新发送消息，webview会通过window.addEventListener接收到这个消息
                    break;
                case 'selectDefinition':
                    // 处理用户在定义选择器中选择不同定义的情况
                    if (this._pickItems && message.label) {
                        const selected = this._pickItems.find(item => item.label === message.label);
                        if (selected && editor) {
                            // 获取当前光标位置的token
                            const position = editor.selection.active;
                            const wordRange = editor.document.getWordRangeAtPosition(position);
                            const selectedText = wordRange ? editor.document.getText(wordRange) : '';
                            
                            // 渲染选中的定义
                            this._renderer.renderDefinitions(editor.document, [selected.definition], selectedText).then(contentInfo => {
                                this.updateContent(contentInfo);
                                // 更新历史记录的内容，但保持当前行号
                                if (this._history.length > this._historyIndex) {
                                    this._history[this._historyIndex].content = contentInfo;
                                }
                            });
                        }
                    }
                    break;
                case 'escapePressed':
                    // 用户按ESC时隐藏定义选择器，但保持当前内容
                    if (this._view) {
                        this._view.webview.postMessage({ type: 'hideDefinitionPicker' });
                    }
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
                                if (definitions.length > 0) {
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

    public show() {
        if (!this._view) {
            vscode.commands.executeCommand('contextView.context.focus').then(() => {
            });
            return;
        }
        this._view.show?.();
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
                
                body, html {
                    margin: 0;
                    padding: 0;
                    width: 100%;
                    height: 100%;
                    overflow: hidden;
                    box-sizing: border-box;
                    position: absolute;
                    top: 0;
                    left: 0;
                }

                /* 主容器 - 左右分栏布局 */
                .main-container {
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 24px; /* 为底部导航栏留空间 */
                    display: flex;
                    overflow: hidden;
                }

                /* 左侧定义选择器 */
                .definition-picker {
                    width: 30%;
                    min-width: 200px;
                    max-width: 50%;
                    height: calc(100% - 16px); /* 确保高度不会延伸到底部导航栏 */
                    background-color: var(--vscode-editor-background);
                    border-right: 1px solid var(--vscode-editorWidget-border);
                    overflow-y: auto;
                    overflow-x: auto;
                    display: none; /* 默认隐藏 */
                    flex-shrink: 0;
                    padding-bottom: 0px; /* 减少底部空间，让滚动条更贴近导航栏 */
                    box-sizing: border-box; /* 确保padding计算在内 */
                }

                .definition-picker.visible {
                    display: block;
                }

                /* 自定义滚动条样式 */
                .definition-picker::-webkit-scrollbar {
                    width: 12px;
                    height: 12px;
                }

                .definition-picker::-webkit-scrollbar-track {
                    background: var(--vscode-scrollbarSlider-background);
                    border-radius: 6px;
                }

                .definition-picker::-webkit-scrollbar-thumb {
                    background: var(--vscode-scrollbarSlider-background);
                    border-radius: 6px;
                    border: 2px solid var(--vscode-editor-background);
                }

                .definition-picker::-webkit-scrollbar-thumb:hover {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                }

                .definition-picker::-webkit-scrollbar-thumb:active {
                    background: var(--vscode-scrollbarSlider-activeBackground);
                }

                .definition-picker::-webkit-scrollbar-corner {
                    background: var(--vscode-editor-background);
                    border-radius: 8px;
                }

                /* 定义选择器内容样式 */
                .picker-item {
                    padding: 6px 10px;
                    border-bottom: 1px solid var(--vscode-editorWidget-border);
                    cursor: pointer;
                    transition: background-color 0.2s ease;
                }

                .picker-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }

                .picker-item.selected {
                    background-color: var(--vscode-list-activeSelectionBackground);
                    border-left: 3px solid var(--vscode-list-activeSelectionForeground);
                    color: var(--vscode-list-activeSelectionForeground);
                }

                .picker-item .header {
                    margin: 0;
                    white-space: nowrap;
                    min-width: max-content;
                }

                .picker-item .code-container {
                    position: relative;
                    width: 100%;
                    overflow-x: auto;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-editorWidget-border);
                    border-radius: 3px;
                    padding: 6px 8px;
                }

                .picker-item pre {
                    margin: 0;
                    white-space: pre !important;
                    word-wrap: normal !important;
                    padding: 4px 8px;
                    background: transparent;
                    display: inline-block;
                    min-width: fit-content;
                    font-family: var(--vscode-editor-font-family);
                    font-size: calc(var(--vscode-editor-font-size) * 0.9);
                }

                .picker-item code {
                    white-space: pre !important;
                    word-wrap: normal !important;
                    display: inline-block;
                    font-family: var(--vscode-editor-font-family);
                    width: max-content;
                    color: var(--vscode-editor-foreground);
                }

                .picker-item mark {
                    background-color: var(--vscode-editor-findMatchHighlightBackground);
                    border: 1px solid var(--vscode-editor-findMatchBorder);
                    border-radius: 2px;
                    padding: 1px 2px;
                    color: var(--vscode-editor-foreground);
                }

                /* 右侧内容区域 */
                .content-area {
                    flex: 1;
                    position: relative;
                    overflow: hidden;
                    padding-bottom: 8px; /* 增加底部空间，确保滚动条不被遮挡 */
                }

                #container {
                    width: 100%;
                    height: calc(100% - 8px); /* 减去底部padding */
                    cursor: pointer !important;
                    overflow: hidden; /* 禁用容器滚动条，使用Monaco滚动条 */
                    position: relative;
                }

                /* 确保Monaco Editor填满容器并显示自己的滚动条 */
                .monaco-editor {
                    width: 100% !important;
                    height: 100% !important;
                }
                
                .monaco-editor .monaco-scrollable-element {
                    width: 100% !important;
                    height: 100% !important;
                }

                /* Monaco Editor 滚动条样式 */
                .monaco-editor .monaco-scrollable-element .scrollbar {
                    background: transparent;
                }

                .monaco-editor .monaco-scrollable-element .slider {
                    background: var(--vscode-scrollbarSlider-background);
                    border-radius: 6px;
                }

                .monaco-editor .monaco-scrollable-element .slider:hover {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                }

                .monaco-editor .monaco-scrollable-element .slider.active {
                    background: var(--vscode-scrollbarSlider-activeBackground);
                }

                /* 确保内容正常显示 */
                .monaco-editor .view-lines {
                    width: max-content !important;
                }
                
                #main {
                    display: none;
                    padding: 10px;
                    cursor: pointer !important;
                    margin-top: 0 !important;
                    overflow: hidden;
                }

                /* 底部导航栏样式 */
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
                    padding-left: 20px;
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

                /* 双击区域样式 */
                .double-click-area {
                    position: fixed;
                    bottom: 0;
                    left: 80px;
                    right: 0;
                    height: 24px;
                    z-index: 1001;
                    cursor: pointer;
                    background-color: rgba(89, 255, 0, 0.11);
                    display: flex;
                    align-items: left;
                    justify-content: left;
                    color: rgba(128, 128, 128, 0.8);
                    font-size: 14px;
                    font-style: italic;
                    padding-left: 10px;
                }

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

                /* 分割线调整 */
                .resize-handle {
                    width: 4px;
                    background-color: var(--vscode-editorWidget-border);
                    cursor: ew-resize;
                    position: relative;
                    flex-shrink: 0;
                    display: none;
                    transition: background-color 0.2s ease;
                    z-index: 10;
                }

                .resize-handle.visible {
                    display: block;
                }

                .resize-handle:hover {
                    background-color: var(--vscode-focusBorder);
                }

                .resize-handle:active {
                    background-color: var(--vscode-focusBorder);
                }

                /* 增加拖拽区域 */
                .resize-handle::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: -6px;
                    right: -6px;
                    bottom: 0;
                    cursor: ew-resize;
                }

                /* 添加拖动时的全局样式 */
                body.resizing {
                    cursor: ew-resize !important;
                    user-select: none !important;
                }

                body.resizing * {
                    cursor: ew-resize !important;
                    user-select: none !important;
                }
            </style>

            <link href="${styleUri}" rel="stylesheet">
            
            <title>Definition View</title>
        </head>
        <body>
            <div class="loading"></div>
            
            <!-- 主容器 - 左右分栏 -->
            <div class="main-container">
                <!-- 左侧定义选择器 -->
                <div class="definition-picker" id="definition-picker">
                    <!-- 定义选择器内容将通过JavaScript动态填充 -->
                </div>
                
                <!-- 分割线 -->
                <div class="resize-handle" id="resize-handle"></div>
                
                <!-- 右侧内容区域 -->
                <div class="content-area">
                    <article id="main">加载中...</article>
                    <div id="container"></div>
                </div>
            </div>

            <!-- 双击区域 -->
            <div class="double-click-area">
                <span>dbclick to open...</span>
                <span class="filename-display"></span>
            </div>
            
            <!-- 底部导航栏 -->
            <div class="nav-bar">
                <button class="nav-button" id="nav-back">  </button>
                <button class="nav-button" id="nav-forward">  </button>
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

                // 抑制 ResizeObserver 循环警告
                const resizeObserverErrorHandler = (e) => {
                    if (e.message && e.message.includes('ResizeObserver loop completed with undelivered notifications')) {
                        e.stopImmediatePropagation();
                        return false;
                    }
                };

                // 监听错误事件
                window.addEventListener('error', resizeObserverErrorHandler);
                window.addEventListener('unhandledrejection', (e) => {
                    if (e.reason && e.reason.message && e.reason.message.includes('ResizeObserver loop')) {
                        e.preventDefault();
                        return false;
                    }
                });

                // 重写 console.error 来过滤 ResizeObserver 警告
                const originalConsoleError = console.error;
                console.error = function(...args) {
                    const message = args.join(' ');
                    if (message.includes('ResizeObserver loop completed with undelivered notifications')) {
                        return; // 忽略这个特定的警告
                    }
                    originalConsoleError.apply(console, args);
                };
            </script>
            
            <!-- 加载我们的主脚本，它会动态加载Monaco -->
            <script type="module" nonce="${nonce}" src="${scriptUri}" onerror="console.error('[definition] Failed to load main.js'); document.getElementById('main').innerHTML = '<div style=\\'color: red; padding: 20px;\\'>Failed to load main.js</div>'"></script>
            
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

                // 定义选择器相关功能
                function showDefinitionPicker(items) {
                    const picker = document.getElementById('definition-picker');
                    const resizeHandle = document.getElementById('resize-handle');
                    const mainContainer = document.querySelector('.main-container');
                    
                    // 清空现有内容
                    picker.innerHTML = '';
                    
                    // 设置初始宽度为30%
                    if (mainContainer) {
                        const containerWidth = mainContainer.offsetWidth;
                        picker.style.width = Math.floor(containerWidth * 0.3) + 'px';
                    }
                    
                    // 添加定义项
                    items.forEach((item, index) => {
                        const itemDiv = document.createElement('div');
                        itemDiv.className = 'picker-item';
                        if (index === 0) itemDiv.classList.add('selected'); // 默认选中第一项
                        
                        itemDiv.innerHTML = \`
                            <div class="header">
                                <strong>\${item.label}</strong> - \${item.description}
                            </div>
                        \`;
                        
                        // 添加点击事件
                        itemDiv.addEventListener('click', () => {
                            // 更新选中状态
                            document.querySelectorAll('.picker-item').forEach(el => el.classList.remove('selected'));
                            itemDiv.classList.add('selected');
                            
                            // 发送选择消息
                            window.vscode.postMessage({
                                type: 'selectDefinition',
                                label: item.label
                            });
                        });
                        
                        picker.appendChild(itemDiv);
                    });
                    
                    // 显示选择器和分割线
                    picker.classList.add('visible');
                    resizeHandle.classList.add('visible');
                    
                    // 键盘导航支持
                    document.addEventListener('keydown', handlePickerKeydown);
                }

                function hideDefinitionPicker() {
                    const picker = document.getElementById('definition-picker');
                    const resizeHandle = document.getElementById('resize-handle');
                    
                    picker.classList.remove('visible');
                    resizeHandle.classList.remove('visible');
                    
                    // 移除键盘事件监听
                    document.removeEventListener('keydown', handlePickerKeydown);
                }

                function handlePickerKeydown(e) {
                    const picker = document.getElementById('definition-picker');
                    if (!picker.classList.contains('visible')) return;
                    
                    if (e.key === 'Escape') {
                        window.vscode.postMessage({
                            type: 'escapePressed'
                        });
                    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || 
                               (e.ctrlKey && (e.key === 'p' || e.key === 'n'))) {
                        e.preventDefault();
                        
                        const items = Array.from(document.querySelectorAll('.picker-item'));
                        const current = document.querySelector('.picker-item.selected');
                        let index = current ? items.indexOf(current) : -1;
                        
                        if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
                            index = Math.max(index - 1, 0);
                        } else {
                            index = Math.min(index + 1, items.length - 1);
                        }
                        
                        items.forEach((item, i) => {
                            item.classList.toggle('selected', i === index);
                        });
                        
                        // 滚动到选中项
                        if (index >= 0) {
                            const selectedItem = items[index];
                            selectedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            
                            // 立即选择该定义
                            const label = selectedItem.querySelector('strong').textContent;
                            window.vscode.postMessage({
                                type: 'selectDefinition',
                                label: label
                            });
                        }
                    }/*  else if (e.key === 'Enter') {
                        const selected = document.querySelector('.picker-item.selected');
                        if (selected) {
                            const label = selected.querySelector('strong').textContent;
                            window.vscode.postMessage({
                                type: 'selectDefinition',
                                label: label
                            });
                        }
                    } */
                }

                // 暴露函数给外部使用
                window.showDefinitionPicker = showDefinitionPicker;
                window.hideDefinitionPicker = hideDefinitionPicker;

                // 实现拖动调整大小功能
                function initializeResizer() {
                    const resizeHandle = document.getElementById('resize-handle');
                    const leftPanel = document.getElementById('definition-picker');
                    const mainContainer = document.querySelector('.main-container');
                    
                    if (!resizeHandle || !leftPanel || !mainContainer) return;
                    
                    let isResizing = false;
                    let startX = 0;
                    let startWidth = 0;
                    let animationFrameId = null;
                    let windowResizeTimeout = null;
                    
                    // 简化的更新函数，移除复杂的节流逻辑
                    const updateWidth = (newWidth) => {
                        if (animationFrameId) {
                            cancelAnimationFrame(animationFrameId);
                        }
                        
                        animationFrameId = requestAnimationFrame(() => {
                            try {
                                const containerWidth = mainContainer.offsetWidth;
                                const minWidth = 150;
                                const maxWidth = containerWidth * 0.75;
                                
                                if (newWidth >= minWidth && newWidth <= maxWidth) {
                                    leftPanel.style.width = newWidth + 'px';
                                }
                            } catch (error) {
                                // 忽略resize相关的错误
                                if (!error.message.includes('ResizeObserver')) {
                                    console.error('Resize error:', error);
                                }
                            }
                            animationFrameId = null;
                        });
                    };
                    
                    // 改进事件监听，支持触摸事件和鼠标捕获
                    const handleStart = (e) => {
                        isResizing = true;
                        startX = e.clientX || (e.touches && e.touches[0].clientX);
                        startWidth = leftPanel.offsetWidth;
                        
                        // 添加拖动状态的CSS类
                        document.body.classList.add('resizing');
                        
                        // 设置鼠标捕获，确保即使鼠标移出元素也能跟踪
                        if (e.setPointerCapture && e.pointerId !== undefined) {
                            resizeHandle.setPointerCapture(e.pointerId);
                        } else {
                            // 对于不支持 Pointer Events 的浏览器，使用鼠标捕获
                            if (resizeHandle.setCapture) {
                                resizeHandle.setCapture();
                            }
                        }
                        
                        e.preventDefault();
                        e.stopPropagation();
                    };
                    
                    const handleMove = (e) => {
                        if (!isResizing) return;
                        
                        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
                        const deltaX = clientX - startX;
                        const newWidth = startWidth + deltaX;
                        
                        // 直接更新，不使用复杂的节流
                        updateWidth(newWidth);
                        
                        e.preventDefault();
                        e.stopPropagation();
                    };
                    
                    const handleEnd = (e) => {
                        if (isResizing) {
                            isResizing = false;
                            document.body.classList.remove('resizing');
                            
                            // 释放鼠标捕获
                            if (e && e.releasePointerCapture && e.pointerId !== undefined) {
                                try {
                                    resizeHandle.releasePointerCapture(e.pointerId);
                                } catch (err) {
                                    // 忽略释放捕获时的错误
                                }
                            } else {
                                // 对于不支持 Pointer Events 的浏览器
                                if (document.releaseCapture) {
                                    document.releaseCapture();
                                }
                            }
                            
                            // 清理动画帧
                            if (animationFrameId) {
                                cancelAnimationFrame(animationFrameId);
                                animationFrameId = null;
                            }
                        }
                    };
                    
                    // 使用 Pointer Events（更现代的方式）
                    resizeHandle.addEventListener('pointerdown', handleStart, { passive: false });
                    document.addEventListener('pointermove', handleMove, { passive: false });
                    document.addEventListener('pointerup', handleEnd, { passive: true });
                    document.addEventListener('pointercancel', handleEnd, { passive: true });
                    
                    // 兼容性：同时支持鼠标事件
                    resizeHandle.addEventListener('mousedown', handleStart, { passive: false });
                    document.addEventListener('mousemove', handleMove, { passive: false });
                    document.addEventListener('mouseup', handleEnd, { passive: true });
                    
                    // 触摸事件（移动端支持）
                    resizeHandle.addEventListener('touchstart', handleStart, { passive: false });
                    document.addEventListener('touchmove', handleMove, { passive: false });
                    document.addEventListener('touchend', handleEnd, { passive: true });
                    
                    // 处理鼠标离开窗口的情况
                    document.addEventListener('mouseleave', handleEnd, { passive: true });
                    
                    // 窗口大小改变时重新计算（使用更长的防抖时间）
                    window.addEventListener('resize', () => {
                        if (windowResizeTimeout) {
                            clearTimeout(windowResizeTimeout);
                        }
                        
                        windowResizeTimeout = setTimeout(() => {
                            try {
                                if (leftPanel.classList.contains('visible')) {
                                    const containerWidth = mainContainer.offsetWidth;
                                    const currentWidth = leftPanel.offsetWidth;
                                    const maxWidth = containerWidth * 0.75;
                                    
                                    if (currentWidth > maxWidth) {
                                        const newWidth = Math.min(containerWidth * 0.5, maxWidth);
                                        leftPanel.style.width = newWidth + 'px';
                                    }
                                }
                            } catch (error) {
                                // 忽略resize相关的错误
                                if (!error.message.includes('ResizeObserver')) {
                                    console.error('Window resize error:', error);
                                }
                            }
                            windowResizeTimeout = null;
                        }, 250); // 增加到250ms防抖
                    }, { passive: true });
                }

                // 初始化调整大小功能
                initializeResizer();

                // 处理来自VS Code的消息
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'showDefinitionPicker':
                            if (message.items && Array.isArray(message.items)) {
                                showDefinitionPicker(message.items);
                            }
                            break;
                        case 'hideDefinitionPicker':
                            hideDefinitionPicker();
                            break;
                    }
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
        
        // 隐藏定义选择器，因为移动到了新的上下文
        if (this._view) {
            this._view.webview.postMessage({ type: 'hideDefinitionPicker' });
        }
        this._pickItems = undefined;
        
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

                this._currentCacheKey = newCacheKey;
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

        if (definitions.length > 0) {
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
        // 如果只有一个定义，直接返回该定义，不显示选择器
        if (definitions.length <= 1) {
            //return definitions.length === 1 ? definitions[0] : undefined;
        }

        if (!this._view) {
            return undefined;
        }

        // 准备定义项数据
        const items = await Promise.all(definitions.map(async (definition, index) => {
            try {
                let def = definition;
                let uri = (def instanceof vscode.Location) ? def.uri : def.targetUri;
                // targetSelectionRange更准确，会有targetRange不正确的情况
                let range = (def instanceof vscode.Location) ? def.range : (def.targetSelectionRange ?? def.targetRange);

                // const document = await vscode.workspace.openTextDocument(uri);
                // if (!document) {
                //     return null;
                // }

                // const startLine = Math.max(range.start.line - 3, 0);
                // const endLine = Math.min(range.start.line + 3, document.lineCount - 1);
                
                // const codeLines = [];
                // for (let i = startLine; i <= endLine; i++) {
                //     const line = document.lineAt(i).text;
                //     if (i === range.start.line) {
                //         codeLines.push(`<mark>${line}</mark>`);
                //     } else {
                //         codeLines.push(line);
                //     }
                // }
                // // 留点空白
                // const codeSnippet = codeLines.join('        \n');

                return {
                    label: `Definition ${index + 1}: ${uri.fsPath}`,
                    description: `Line: ${range.start.line + 1}, Column: ${range.start.character + 1}`,
                    //detail: codeSnippet,
                    definition
                };
            } catch (error) {
                return null;
            }
        }));

        // 过滤掉null项
        const validItems = items.filter(item => item !== null);
        if (validItems.length === 0) {
            return undefined;
        }

        this._pickItems = validItems;
        
        // 显示定义选择器
        this._view.webview.postMessage({
            type: 'showDefinitionPicker',
            items: validItems
        });

        // 立即返回第一个定义，不等待用户选择
        return validItems[0]?.definition;
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

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
    private _currentSelectedText: string = ''; // 添加成员变量存储当前选中的文本

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
            if (e.affectsConfiguration('contextView.contextWindow')) {
                // 重新获取配置并发送给webview
                const newConfig = this._getVSCodeEditorConfiguration();
                this._view?.webview.postMessage({
                    type: 'updateContextEditorCfg',
                    contextEditorCfg: newConfig.contextEditorCfg
                });
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
        const contextWindowConfig = vscode.workspace.getConfiguration('contextView.contextWindow');
        const currentTheme = this._getVSCodeTheme();
        
        // 构建配置对象
        const config: {
            theme: string;
            editorOptions: any;
            contextEditorCfg: any;
            customThemeRules?: any[];
        } = {
            theme: this._getVSCodeTheme(),
            // 将编辑器配置转换为对象
            editorOptions: {
                ...Object.assign({}, editorConfig),
                links: true
            },
            contextEditorCfg: {
                selectionBackground: contextWindowConfig.get('selectionBackground', '#07c2db71'),
                inactiveSelectionBackground: contextWindowConfig.get('inactiveSelectionBackground', '#07c2db71'),
                selectionHighlightBackground: contextWindowConfig.get('selectionHighlightBackground', '#5bdb0771'),
                selectionHighlightBorder: contextWindowConfig.get('selectionHighlightBorder', '#5bdb0791')
            }
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
            // 主动隐藏定义列表
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'clearDefinitionList'
                });
            }
            
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
                            // 缓存点击的token文本
                            this._currentSelectedText = message.token || '';

                            let definitions = await vscode.commands.executeCommand<vscode.Location[]>(
                                'vscode.executeDefinitionProvider',
                                vscode.Uri.parse(message.uri),
                                new vscode.Position(message.position.line, message.position.character)
                            );

                            if (definitions && definitions.length > 0) {
                                console.log('[definition] jumpDefinition: ', definitions);
                                
                                // 主动隐藏定义列表（在处理新的跳转前）
                                if (this._view && definitions.length === 1) {
                                    this._view.webview.postMessage({
                                        type: 'clearDefinitionList'
                                    });
                                }
                                
                                // 如果有多个定义，传递给 Monaco Editor
                                if (definitions.length > 1) {
                                    const currentPosition = new vscode.Position(message.position.line, message.position.character);
                                    const selectedDefinition = await this.showDefinitionPicker(definitions, editor, currentPosition);
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
                case 'definitionItemSelected':
                    // 处理定义列表项被选中的情况
                    //console.log('[definition] Definition item selected:', message);
                    
                    if (this._pickItems && message.index !== undefined) {
                        const selected = this._pickItems[message.index];
                        if (selected && editor) {
                            // 使用缓存的选中文本，而不是重新获取
                            const selectedText = this._currentSelectedText;
                            
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
                case 'closeDefinitionList':
                    // 处理关闭定义列表的请求
                    this._view?.webview.postMessage({
                        type: 'clearDefinitionList'
                    });
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
                    // 没有缓存内容时，保持Monaco编辑器的"Ready for content."状态
                    // 不主动查找定义，也不显示"No symbol found..."
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
            //console.log('[definition] No cached content, keeping Ready for content state');
            // 没有缓存内容时，保持Monaco编辑器的"Ready for content."状态，不主动查找定义
            // 只有用户主动点击符号时才会触发定义查找
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

                /* ========== 左侧列表布局样式 ========== */
                #main-container {
                    display: flex;
                    flex-direction: row;
                    height: calc(100vh - 24px); /* 减去底部导航栏高度 */
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                }

                #definition-list {
                    width: 30%;
                    min-width: 150px;
                    max-width: 50%;
                    cursor: default !important;
                    background-color: var(--vscode-editor-background);
                    border-right: 1px solid var(--vscode-editorWidget-border);
                    overflow-y: auto;
                    overflow-x: auto;
                    resize: horizontal;
                    display: none; /* 默认隐藏 */
                    flex-direction: column;
                    padding-bottom: 10px;
                }

                /* todo: 以下滚动条的控制都可去掉，实际使用的是浏览器自己滚动条，以下代码无法控制 */

                /* 调整垂直滚动条，避免覆盖拖拽区域 */
                #definition-list::-webkit-scrollbar-track-piece:end {
                    margin-bottom: 10px;
                }

                #definition-list::-webkit-scrollbar-thumb {
                    background: rgba(128, 128, 128, 0);
                    border-radius: 4px;
                    transition: all 0.3s ease;
                    margin-bottom: 10px;
                }

                /* 定义列表滚动条样式 */
                #definition-list::-webkit-scrollbar {
                    width: 6px;
                    height: 6px;
                }

                #definition-list::-webkit-scrollbar-track {
                    background: transparent;
                    border-radius: 4px;
                }

                #definition-list::-webkit-scrollbar-thumb {
                    background: rgba(128, 128, 128, 0);
                    border-radius: 4px;
                    transition: all 0.3s ease;
                }

                #definition-list:hover::-webkit-scrollbar-thumb {
                    background: rgba(128, 128, 128, 0.4);
                }

                #definition-list::-webkit-scrollbar-thumb:hover {
                    background: rgba(128, 128, 128, 0.6);
                }

                #definition-list::-webkit-scrollbar-thumb:active {
                    background: rgba(128, 128, 128, 0.8);
                }

                #definition-list::-webkit-scrollbar-corner {
                    background: transparent;
                }

                /* 列表项容器滚动条样式 */
                #definition-list .list-items::-webkit-scrollbar {
                    width: 6px;
                }

                #definition-list .list-items::-webkit-scrollbar-track {
                    background: transparent;
                    border-radius: 3px;
                }

                #definition-list .list-items::-webkit-scrollbar-thumb {
                    background: rgba(128, 128, 128, 0);
                    border-radius: 3px;
                    transition: all 0.3s ease;
                }

                #definition-list .list-items:hover::-webkit-scrollbar-thumb {
                    background: rgba(128, 128, 128, 0.3);
                }

                #definition-list .list-items::-webkit-scrollbar-thumb:hover {
                    background: rgba(128, 128, 128, 0.5);
                }

                #definition-list .list-header {
                    padding: 8px 12px;
                    background-color: var(--vscode-editorGroupHeader-tabsBackground);
                    border-bottom: 1px solid var(--vscode-editorWidget-border);
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                    flex-shrink: 0;
                }

                #definition-list .list-items {
                    flex: 1;
                    overflow-y: auto;
                    overflow-x: visible;
                    width: max-content;
                    min-width: 100%;
                }

                .definition-item {
                    padding: 4px 6px;
                    cursor: pointer;
                    color: var(--vscode-foreground);
                    font-size: 13px;
                    transition: background-color 0.2s ease;
                    white-space: nowrap;
                    overflow: visible;
                    flex-shrink: 0;
                    width: 100%;
                    box-sizing: border-box;
                    display: flex;
                    align-items: center;
                    min-height: 16px;
                }

                .definition-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                    color: var(--vscode-list-hoverForeground);
                }

                .definition-item.active {
                    background-color: var(--vscode-list-activeSelectionBackground);
                    color: var(--vscode-list-activeSelectionForeground);
                }

                .definition-item .definition-number {
                    font-weight: bold;
                    margin-right: 8px;
                    color: inherit;
                }

                .definition-item .definition-info {
                    flex: 1;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                }

                .definition-item .file-path {
                    color: inherit;
                    font-weight: bold;
                }

                .definition-item .line-info {
                    color: inherit;
                    margin-left: 4px;
                }

                #container {
                    flex: 1;
                    position: relative;
                }
                
                /* ========== 底部导航栏样式 ========== */
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
                    white-space: pre;
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
            
            <!-- 主容器：左侧列表 + 右侧Monaco编辑器 -->
            <div id="main-container">
                <!-- 左侧定义列表 -->
                <div id="definition-list">
                    <div class="list-items">
                        <!-- 定义列表将通过JavaScript动态填充 -->
                    </div>
                </div>
                
                <!-- 右侧Monaco编辑器 -->
                <div id="container"></div>
            </div>

            <!-- 添加双击区域 -->
            <div class="double-click-area">
                <span>double-click: Jump to definition</span>
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

    // 添加等待面板准备就绪的方法
    private waitForPanelReady(): Promise<void> {
        return new Promise((resolve) => {
            if (!this._view) {
                resolve();
                return;
            }

            // 设置超时，避免无限等待
            const timeout = setTimeout(() => {
                resolve();
            }, 5000); // 5秒超时

            // 监听面板的确认消息
            const messageListener = this._view.webview.onDidReceiveMessage((message) => {
                if (message.type === 'contentReady') {
                    clearTimeout(timeout);
                    messageListener.dispose();
                    resolve();
                }
            });
        });
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
            // 等待面板确认渲染完成
            await this.waitForPanelReady();
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
        this._currentSelectedText = selectedText; // 缓存选中的文本
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
            const currentPosition = editor.selection.active;
            const selectedDefinition = await this.showDefinitionPicker(definitions, editor, currentPosition);
            if (!selectedDefinition) {
                return { content: '', line: 0, column: 0, jmpUri: '', languageId: 'plaintext', symbolName: '' };
            }
            definitions = [selectedDefinition];
        } else {
            // 主动隐藏定义列表
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'clearDefinitionList'
                });
            }
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

    private async showDefinitionPicker(definitions: any[], editor: vscode.TextEditor, currentPosition?: vscode.Position): Promise<any> {
        // 准备定义列表数据并发送到webview
        try {
            const definitionListData = await Promise.all(definitions.map(async (definition, index) => {
                try {
                    let def = definition;
                    let uri = (def instanceof vscode.Location) ? def.uri : def.targetUri;
                    let range = (def instanceof vscode.Location) ? def.range : (def.targetSelectionRange ?? def.targetRange);

                    // 使用全路径
                    const displayPath = uri.fsPath;

                    // 获取符号名称
                    const document = await vscode.workspace.openTextDocument(uri);
                    const wordRange = document.getWordRangeAtPosition(new vscode.Position(range.start.line, range.start.character));
                    const symbolName = wordRange ? document.getText(wordRange) : `Definition ${index + 1}`;

                    return {
                            title: symbolName,
                            location: `${displayPath}:${range.start.line + 1}`,
                            filePath: displayPath, // 使用文件系统路径而不是URI
                            lineNumber: range.start.line,
                            columnNumber: range.start.character + 1, // 添加列号信息（转换为1-based）
                            isActive: index === 0, // 第一个定义默认激活
                            definition: definition,
                            uri: uri.toString(),
                            startLine: range.start.line,
                            startCharacter: range.start.character
                        };
                } catch (error) {
                    return null;
                }
            }));
            
            // 过滤掉null项
            const validDefinitions = definitionListData.filter(item => item !== null);
            
            // 缓存定义项供后续使用
            this._pickItems = validDefinitions;
            
            // 只有在多个定义时才发送定义列表数据到webview
            if (this._view && validDefinitions.length > 1) {
                // 尝试找到与当前位置最匹配的定义作为默认选择
                const currentFileUri = editor.document.uri.toString();
                let defaultIndex = 0;
                let bestMatch = -1;
                let minDistance = Number.MAX_SAFE_INTEGER;
                
                // 如果有当前位置信息，进行精确匹配
                if (currentPosition) {
                    for (let i = 0; i < validDefinitions.length; i++) {
                        const def = validDefinitions[i];
                        if (def && def.uri === currentFileUri) {
                            // 计算位置距离（行数差 * 1000 + 列数差）
                            const lineDiff = Math.abs(def.startLine - currentPosition.line);
                            const charDiff = Math.abs(def.startCharacter - currentPosition.character);
                            const distance = lineDiff * 1000 + charDiff;
                            
                            if (distance < minDistance) {
                                minDistance = distance;
                                bestMatch = i;
                            }
                        }
                    }
                }
                
                // 如果找到了最佳匹配，使用它；否则查找同文件的第一个定义
                if (bestMatch !== -1) {
                    defaultIndex = bestMatch;
                } else {
                    // 回退到文件匹配
                    for (let i = 0; i < validDefinitions.length; i++) {
                        const def = validDefinitions[i];
                        if (def && def.uri === currentFileUri) {
                            defaultIndex = i;
                            break;
                        }
                    }
                }
                
                // 更新激活状态
                validDefinitions.forEach((def, index) => {
                    if (def) {
                        def.isActive = index === defaultIndex;
                    }
                });
                
                this._view.webview.postMessage({
                    type: 'updateDefinitionList',
                    definitions: validDefinitions
                });
                
                // 返回匹配当前位置的定义
                return validDefinitions[defaultIndex] && validDefinitions[defaultIndex]?.definition ? validDefinitions[defaultIndex]!.definition : (validDefinitions[0]?.definition || definitions[0]);
            }
            
            // 返回第一个定义作为默认选择
            return validDefinitions.length > 0 && validDefinitions[0] ? validDefinitions[0].definition : definitions[0];
            
        } catch (error) {
            //console.error('Error preparing definitions:', error);
            return definitions[0]; // 出错时返回第一个定义
        }
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

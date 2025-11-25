import * as vscode from 'vscode';
import { Renderer, FileContentInfo } from './renderer';
import * as path from 'path';
import { time } from 'console';

enum UpdateMode {
    Live = 'live',
    Sticky = 'sticky',
}
const maxHistorySize = 50;

interface HistoryInfo {
    content: FileContentInfo | undefined;
    navigateLine: number;
}

export class ContextWindowProvider implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer {
    // Add a new property to cache the last content
    private _history: HistoryInfo[] = [];
    private _historyIndex: number = 0;

    private _mousePressed: boolean = false;
    private _mouseTimer?: NodeJS.Timeout;  // 添加timer引用

    private _keyboardUpdateTimer: NodeJS.Timeout | null = null;
    private _lastKeyboardUpdateTime = 0;
    private readonly _keyboardUpdateDebounce = 500;

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
    private _lastUpdateEditor: vscode.TextEditor | undefined;

    private _lastContentHash: string | undefined;  // 最近一次的内容标识
    private _lastContent: FileContentInfo | undefined;  // 最近一次的内容

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) {
        // 监听主题变化
        this._themeListener = vscode.window.onDidChangeActiveColorTheme(theme => {
            this.postMessageToWebview({
                    type: 'updateTheme',
                    theme: this._getVSCodeTheme(theme)
                });
        });

        // 监听编辑器配置变化
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('editor')) {
                const updatedConfig = this._getVSCodeEditorConfiguration();
                this.postMessageToWebview({
                        type: 'updateEditorConfiguration',
                        configuration: updatedConfig
                    });
            }
            if (e.affectsConfiguration('contextView.contextWindow')) {
                // 重新获取配置并发送给webview
                const newConfig = this._getVSCodeEditorConfiguration();
                this.postMessageToWebview({
                    type: 'updateContextEditorCfg',
                    contextEditorCfg: newConfig.contextEditorCfg,
                    customThemeRules: newConfig.customThemeRules
                });
                this.updateConfiguration();
            }
        }, null, this._disposables);

        // Listens for changes to workspace folders (when user adds/removes folders)
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            if (this._currentPanel) {
                //ContextWindowProvider.outputChannel.appendLine('[definition] onDidChangeWorkspaceFolders dispose');
                //this._currentPanel.dispose();
                //this._currentPanel = undefined;
            }
        }, null, this._disposables);

        // 失去焦点时
        vscode.window.onDidChangeWindowState((e) => {
            if (!e.focused && this._currentPanel) {
                //ContextWindowProvider.outputChannel.appendLine('[definition] onDidChangeWindowState dispose');
                //this._currentPanel.dispose();
                //this._currentPanel = undefined;
            }
        }, null, this._disposables);

        // when the extension is deactivated，clean up resources
        this._disposables.push(
            vscode.Disposable.from({
                dispose: () => {
                    if (this._currentPanel) {
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
                    this._handleKeyboardUpdate();
                }
            }
        }, null, this._disposables);

        this._renderer.needsRender(() => {
            //console.log('[definition] needsRender update');
            this.update(/* force */ true);
        }, undefined, this._disposables);

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

    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: any): Promise<void> {
        this._currentPanel = webviewPanel;
        //console.log('[definition] deserializeWebviewPanel');
        
        webviewPanel.webview.options = {
            enableScripts: true,
            enableForms: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'),
                vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'monaco-editor')
            ]
        };

        webviewPanel.title = "Context Window";

        this.resetWebviewPanel(this._currentPanel);
    }

    // 键盘更新防抖方法
    private _handleKeyboardUpdate() {
        const now = Date.now();
        
        // 清除之前的timer
        if (this._keyboardUpdateTimer) {
            clearTimeout(this._keyboardUpdateTimer);
        }
        
        // 如果距离上次更新时间太短，使用防抖
        if (now - this._lastKeyboardUpdateTime < this._keyboardUpdateDebounce) {
            this._keyboardUpdateTimer = setTimeout(() => {
                this._performKeyboardUpdate();
            }, this._keyboardUpdateDebounce);
        } else {
            // 直接更新
            this._performKeyboardUpdate();
        }
    }

    // 执行键盘更新
    private _performKeyboardUpdate() {
        this._lastKeyboardUpdateTime = Date.now();
        
        // 使用异步方式执行更新，避免阻塞键盘响应
        setImmediate(() => {
            this.update();
        });
    }

    private getCurrentContent() : HistoryInfo {
        return (this._history && this._history.length > this._historyIndex) ? this._history[this._historyIndex] : { content: undefined, navigateLine: -1 };
    }

    private addToHistory(contentInfo: FileContentInfo, fromLine: number =-1) {
        //console.log('[definition] add history from line', fromLine);
        // 清除_historyIndex后的内容
        this._history = this._history.slice(0, this._historyIndex + 1);
        this._history.push({ content: contentInfo, navigateLine: -1 });
        this._historyIndex++;

        this._history[this._historyIndex-1].navigateLine = fromLine;

        // this._history.forEach(element => {
        //     console.log('[definition] history element', element);
        // });

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

    // 返回当前主题对应的配置键：lightThemeRules 或 darkThemeRules
    private getThemeRuleKey(): 'lightThemeRules' | 'darkThemeRules' {
        const current = this._getVSCodeTheme(); // 约定：返回 'vs'（light）或其他（dark/hc）
        return current === 'vs' ? 'lightThemeRules' : 'darkThemeRules';
    }

    // 读取当前主题的规则数组（仅 rules）
    private getThemeRules(): any[] {
        const cfg = vscode.workspace.getConfiguration('contextView.contextWindow');
        const key = this.getThemeRuleKey();
        const rules = cfg.get<any[]>(key, []);
        return Array.isArray(rules) ? rules : [];
    }

    // 写回当前主题的规则数组（仅 rules，global = true）
    private async setThemeRules(rules: any[]): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('contextView.contextWindow');
        const key = this.getThemeRuleKey();
        await cfg.update(key, rules, true);
    }

    // upsert：按 token 更新/新增一条规则（仅 foreground/fontStyle）
    private upsertRule(rules: any[], token: string, patch: { foreground?: string; fontStyle?: string }): any[] {
        const idx = rules.findIndex(r => r && r.token === token);
        if (idx >= 0) {
            // 克隆原条目，按需求设置或清除字段（patch 中不存在则清空）
            const base = { ...rules[idx] };
            base.token = token;

            if (Object.prototype.hasOwnProperty.call(patch, 'foreground')) {
                base.foreground = patch.foreground;
            } else {
                delete base.foreground;
            }

            if (Object.prototype.hasOwnProperty.call(patch, 'fontStyle')) {
                base.fontStyle = patch.fontStyle;
            } else {
                delete base.fontStyle;
            }

            const out = rules.slice();
            out[idx] = base;
            return out;
        } else {
            // 新增：只包含 token 和 patch 中存在的字段
            const next: any = { token };
            if (Object.prototype.hasOwnProperty.call(patch, 'foreground')) {
                next.foreground = patch.foreground;
            }
            if (Object.prototype.hasOwnProperty.call(patch, 'fontStyle')) {
                next.fontStyle = patch.fontStyle;
            }
            return [...rules, next];
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
            theme: currentTheme,
            // 将编辑器配置转换为对象
            editorOptions: {
                ...Object.assign({}, editorConfig),
                links: false
            },
            contextEditorCfg: {
                selectionBackground: contextWindowConfig.get('selectionBackground', '#07c2db71'),
                inactiveSelectionBackground: contextWindowConfig.get('inactiveSelectionBackground', '#07c2db71'),
                selectionHighlightBackground: contextWindowConfig.get('selectionHighlightBackground', '#5bdb0771'),
                selectionHighlightBorder: contextWindowConfig.get('selectionHighlightBorder', '#5bdb0791'),
                fontSize: contextWindowConfig.get('fontSize', 14),
                fontFamily: contextWindowConfig.get('fontFamily', 'Consolas, monospace'),
                minimap: contextWindowConfig.get('minimap', true),
                useDefaultTokenizer: contextWindowConfig.get('useDefaultTokenizer', true),
                cacheSizeLimit: contextWindowConfig.get('cacheSizeLimit', 20),
                largeFileThreshold: contextWindowConfig.get('largeFileThreshold', 2000),
            }
        };

        // 根据当前主题类型获取对应的自定义主题规则
        if (!config.contextEditorCfg.useDefaultTokenizer) {
            if (currentTheme === 'vs') {
                // light主题
                config.customThemeRules = contextWindowConfig.get('lightThemeRules', []);
            } else {
                // dark或hc-black主题
                config.customThemeRules = contextWindowConfig.get('darkThemeRules', []);
            }
            /*
            [
                    { "token": "keyword", "foreground": "#0000ff", "description": "static|private|protected|public etc." },
                    { "token": "keyword.type", "foreground": "#ff0000", "fontStyle": "bold", "description": "keyword such as function class etc." },
                    { "token": "keyword.flow", "foreground": "#ff0000", "fontStyle": "bold", "description": "if|else|for|while etc." },
                    { "token": "keyword.directive", "foreground": "#0000ff", "description": "#include|#pragma|#region|#endregion etc." },
                    { "token": "keyword.directive.control", "foreground": "#ff0000", "fontStyle": "bold", "description": "#define|#undef|#if|#elif|#else|#endif etc." },
                    { "token": "variable.name", "foreground": "#000080", "fontStyle": "bold" },
                    { "token": "variable.parameter", "foreground": "#000080" },
                    { "token": "identifier", "foreground": "#000080" },
                    { "token": "type", "foreground": "#0000ff" },
                    { "token": "class.name", "foreground": "#0000ff", "fontStyle": "bold" },
                    { "token": "function.name", "foreground": "#a00000", "fontStyle": "bold" },
                    { "token": "method.name", "foreground": "#a00000", "fontStyle": "bold" },
                    { "token": "string", "foreground": "#005700" },
                    { "token": "string.escape", "foreground": "#005700" },
                    { "token": "number", "foreground": "#ff0000" },
                    { "token": "boolean", "foreground": "#800080" },
                    { "token": "regexp", "foreground": "#811f3f" },
                    { "token": "null", "foreground": "#0000ff" },
                    { "token": "comment", "foreground": "#005700" },
                    { "token": "property", "foreground": "#000080" },
                    { "token": "operator", "foreground": "#800080" },
                    { "token": "delimiter", "foreground": "#000000" },
                    { "token": "delimiter.bracket", "foreground": "#000000" },
                    { "token": "delimiter.parenthesis", "foreground": "#000000" },
                    { "token": "delimiter.angle", "foreground": "#000000" },
                    { "token": "macro", "foreground": "#A00000", "fontStyle": "italic" },
                    
                    { "token": "variable", "foreground": "#000080" },
                    { "token": "variable.predefined", "foreground": "#ff0000", "fontStyle": "bold" },
                    { "token": "type.declaration", "foreground": "#0000ff" },
                    { "token": "class", "foreground": "#ff0000" },
                    { "token": "entity.name.type.class", "foreground": "#ff0000", "fontStyle": "bold" },
                    { "token": "entity.name.type", "foreground": "#ff0000", "fontStyle": "bold" },
                    { "token": "interface", "foreground": "#ff0000" },
                    { "token": "enum", "foreground": "#ff0000" },
                    { "token": "struct", "foreground": "#ff0000" },
                    { "token": "function", "foreground": "#a00000" },
                    { "token": "function.call", "foreground": "#a00000" },
                    { "token": "method", "foreground": "#a00000" },
                    { "token": "comment.doc", "foreground": "#005700" },
                    { "token": "property.declaration", "foreground": "#000080" },
                    { "token": "member", "foreground": "#000080" },
                    { "token": "field", "foreground": "#000080" },
                    { "token": "tag", "foreground": "#800000" },
                    { "token": "tag.attribute.name", "foreground": "#000080" },
                    { "token": "attribute.name", "foreground": "#000080" },
                    { "token": "attribute.value", "foreground": "#0000ff" },
                    { "token": "namespace", "foreground": "#ff0000" },
                    { "token": "constant", "foreground": "#800080" },
                    { "token": "constant.language", "foreground": "#0000ff" },
                    { "token": "modifier", "foreground": "#0000ff" },
                    { "token": "constructor", "foreground": "#a00000" },
                    { "token": "decorator", "foreground": "#800080" },
                    { "token": "keyword.control", "foreground": "#ff0000" },
                    { "token": "keyword.operator", "foreground": "#800080" },
                    { "token": "keyword.declaration", "foreground": "#0000ff" },
                    { "token": "keyword.modifier", "foreground": "#0000ff" },
                    { "token": "keyword.conditional", "foreground": "#ff0000" },
                    { "token": "keyword.repeat", "foreground": "#ff0000" },
                    { "token": "keyword.exception", "foreground": "#ff0000" },
                    { "token": "keyword.other", "foreground": "#0000ff" },
                    { "token": "keyword.predefined", "foreground": "#0000ff" },
                    { "token": "keyword.function", "foreground": "#ff0000", "fontStyle": "bold" }
                    ]
            */
        } else {
            config.customThemeRules = [];
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
            this.postMessageToWebview({
                    type: 'clearDefinitionList'
                });
            
            const contentInfo = this._history[this._historyIndex];
            this.updateContent(contentInfo?.content, contentInfo.navigateLine);
        }
    }

    private isSameUri(uri: string): boolean {
        let curFileContentInfo = (this._historyIndex < this._history.length) ? this._history[this._historyIndex] : undefined;
        return (curFileContentInfo && curFileContentInfo.content) ? (curFileContentInfo.content.jmpUri === uri) : false;
    }

    public showFloatingWebview() {
        if (this._currentPanel) {
            return;
            // 如果面板已经存在，直接显示, 但会导致进入preview模式
            //this._currentPanel.reveal(vscode.ViewColumn.Beside, true);
        } else {
            // 创建新的浮动Webview
            this.createFloatingWebview();
        }
    }

    private postMessageToWebview(message: any) {
        this._view?.webview.postMessage(message);
        this._currentPanel?.webview.postMessage(message);
    }

    private async handleWebviewMessage(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async message => {
            const editor = vscode.window.activeTextEditor || this._lastUpdateEditor;
            // if (!vscode.window.activeTextEditor && this._lastUpdateEditor) {
            //     console.error('[definition] No active text editor found, using last updated editor');
            // }
            //console.log('[definition] Received message from webview:', message);
            switch (message.type) {
                // 通过 token 查询颜色与字体样式（仅从 rules 读取）
                case 'tokenStyle.get': {
                    try {
                        const token = String(message.token ?? '');
                        const rules = this.getThemeRules();
                        //console.log('[definition] tokenStyle.get rules', rules);
                        let rule = rules.find(r => r && r.token === token);
                        //console.log('[definition] tokenStyle.get exact rule: ', rule);
                        // 如果找不到，去掉语言后缀（最后一个 . 之后的部分）再尝试一次
                        if (!rule) {
                            const lastDot = token.lastIndexOf('.');
                            if (lastDot > 0) {
                                const tokenNoLang = token.slice(0, lastDot);
                                rule = rules.find(r => r && r.token === tokenNoLang);
                            }
                            //console.log('[definition] tokenStyle.get second rule: ', rule);
                        }
                        
                        this.postMessageToWebview({
                            type: 'tokenStyle.get.result',
                            token,
                            found: !!rule,
                            style: rule,
                        });
                    } catch (err) {
                        this.postMessageToWebview({
                            type: 'tokenStyle.get.result',
                            error: String(err),
                            token: message?.token,
                            found: false,
                            style: null,
                        });
                    }
                    break;
                }

                // 通过 token 设置颜色与字体样式（仅写入 rules，并只下发 rules 的更新消息）
                case 'tokenStyle.set': {
                    try {
                        const token = String(message.token ?? '').trim();
                        const patch: { foreground?: string; fontStyle?: string } = {};

                        if (message.newStyle && typeof message.newStyle.foreground === 'string' && message.newStyle.foreground.trim()) {
                            patch.foreground = message.newStyle.foreground.trim();
                        }
                        if (message.newStyle && (message.newStyle.bold || message.newStyle.italic)) {
                            if (message.newStyle.bold && message.newStyle.italic) {
                                patch.fontStyle = "bold italic";
                            } else if (message.newStyle.bold) {
                                patch.fontStyle = "bold";
                            } else if (message.newStyle.italic) {
                                patch.fontStyle = "italic";
                            }
                        }
                        if (!token) {
                            throw new Error('token is required');
                        }

                        //console.log('[definition] tokenStyle.set token:', token, 'patch:', patch);

                        const prev = this.getThemeRules();
                        const next = this.upsertRule(prev, token, patch);
                        await this.setThemeRules(next);

                        //console.log('[definition] tokenStyle.set updated rules', next);
                        //const cur = this.getThemeRules();
                        //console.log('[definition] tokenStyle.set cur rules', cur);

                        // 仅推送 rules 的变更，不带其它配置
                        // this.postMessageToWebview({
                        //     type: 'customThemeRules.update',
                        //     customThemeRules: next,
                        // });

                        // 回传设置结果
                        // this.postMessageToWebview({
                        //     type: 'tokenStyle.set.result',
                        //     ok: true,
                        //     token,
                        //     style: { foreground: patch.foreground, fontStyle: patch.fontStyle },
                        // });
                    } catch (err) {
                        this.postMessageToWebview({
                            type: 'tokenStyle.set.result',
                            ok: false,
                            token: message?.token,
                            error: String(err),
                        });
                    }
                    break;
                }
                case 'editorReady':
                    if (this._currentPanel && webview == this._currentPanel.webview) {
                        let curContext = this.getCurrentContent();
                        //console.log('[definition] editorReady');
                        // If we have cached content, restore it immediately
                        if (curContext?.content) {
                            //console.log('[definition] editorReady update');

                            const uri = curContext.content.jmpUri.toString();
                            const currentVersion = curContext.content.documentVersion;
                            
                            // 生成内容的唯一标识
                            const contentHash = `${uri}:${currentVersion}`;

                            this._currentPanel.webview.postMessage({
                                type: 'updateMetadata',
                                contentHash: contentHash,
                                uri: uri,
                                languageId: curContext.content.languageId,
                                updateMode: this._updateMode,
                                curLine: curContext.navigateLine + 1,
                                documentVersion: currentVersion
                            });
                        }
                    }
                    break;
                case 'pin':
                    await vscode.commands.executeCommand('contextView.contextWindow.pin');
                    break;
                case 'unpin':
                    await vscode.commands.executeCommand('contextView.contextWindow.unpin');
                    break;
                case 'float':
                    this.showFloatingWebview();
                    break;
                case 'revealInFileExplorer':
                    if (message.filePath) {
                        try {
                            const uri = vscode.Uri.parse(message.filePath);
                            await vscode.commands.executeCommand('revealFileInOS', uri);
                        } catch (error) {
                            console.error('[definition] revealInExplorer error:', error);
                        }
                    }
                    break;
                case 'navigate':
                    this.navigate(message.direction);
                    break;
                case 'requestContent':
                    // WebView 请求完整内容（只返回最近一次的内容）
                    if (message.contentHash && message.contentHash === this._lastContentHash && this._lastContent) {
                        this.postMessageToWebview({
                            type: 'updateContent',
                            contentHash: this._lastContentHash,
                            body: this._lastContent.content,
                            uri: this._lastContent.jmpUri.toString(),
                            languageId: this._lastContent.languageId,
                            updateMode: this._updateMode,
                            range: this._lastContent.range,
                            documentVersion: this._lastContent.documentVersion,
                            lineCount: this._lastContent.lineCount
                        });
                    } else {
                        // 缓存不存在或已过期
                        this.postMessageToWebview({
                            type: 'contentError',
                            contentHash: message.contentHash,
                            message: 'Content not available, cache expired'
                        });
                    }
                    break;
                case 'jumpDefinition':
                    if (editor && message.uri?.length > 0) {
                        /* if (this.isSameDefinition(message.uri, message.position.line, message.token)) {
                            // 不需处理
                            //console.log('[definition] SameDefinition:', message.position);
                        } else  */{
                            // 缓存点击的token文本
                            this._currentSelectedText = message.token || '';

                            const updatePromise = (async () => {
                                let definitions = await vscode.commands.executeCommand<vscode.Location[]>(
                                    'vscode.executeDefinitionProvider',
                                    vscode.Uri.parse(message.uri),
                                    new vscode.Position(message.position.line, message.position.character)
                                );

                                if (definitions && definitions.length > 0) {
                                    //console.log('[definition] jumpDefinition: ', definitions);
                                    
                                    // 主动隐藏定义列表（在处理新的跳转前）
                                    if (definitions.length === 1) {
                                        this.postMessageToWebview({
                                            type: 'clearDefinitionList'
                                        });
                                    }

                                    let definition = definitions[0];
                                    
                                    // 如果有多个定义，传递给 Monaco Editor
                                    if (definitions.length > 1) {
                                        const currentPosition = new vscode.Position(message.position.line, message.position.character);
                                        definition = await this.showDefinitionPicker(definitions, editor, currentPosition);
                                    }
                                    //console.log('[definition] jumpDefinition: ', message.token);

                                    const contentInfo = await this._renderer.renderDefinition(editor.document, definition, message.token);
                                    this.updateContent(contentInfo);
                                    this.addToHistory(contentInfo, message.position.line);
                                } else {
                                    //console.log('[definition] No symbol found at position:', message.position);
                                    this.postMessageToWebview({
                                            type: 'noSymbolFound',
                                            pos: message.position,
                                            token: message.token
                                        });
                                }
                            })();

                            this.withProgress<void>(()=>updatePromise);
                        }
                    }
                    break;
                case 'doubleClick':
                    if (message.location === 'bottomArea') {
                        let curContext = this.getCurrentContent();
                        this.currentUri = (curContext && curContext.content)? vscode.Uri.parse(curContext.content.jmpUri) : undefined;
                        this.currentLine = (curContext && curContext.content)? curContext.content.range.start.line : 0;
                        if (this.currentUri) {
                            // 打开文件
                            const document = await vscode.workspace.openTextDocument(this.currentUri);
                            
                            // 跳转到指定行
                            const line = this.currentLine;//message.line - 1; // VSCode的行号从0开始
                            const range = new vscode.Range(line, 0, line, 0);

                            let column = this._currentPanel ? vscode.ViewColumn.One : vscode.ViewColumn.Active;

                            const editor = await vscode.window.showTextDocument(document, {
                                selection: range,
                                viewColumn: column,
                                preserveFocus: false,
                                preview: false
                            });

                            if (editor != vscode.window.activeTextEditor) {
                                console.error('[definition] Failed to open text editor');
                            }
                            
                            // 移动光标并显示该行
                            //editor.selection = new vscode.Selection(range.start, range.start);
                            //editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
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
                            // this._renderer.renderDefinition(editor.document, selected.definition, selectedText).then(contentInfo => {
                            //     this.updateContent(contentInfo);
                            //     // 更新历史记录的内容，但保持当前行号
                            //     if (this._history.length > this._historyIndex) {
                            //         this._history[this._historyIndex].content = contentInfo;
                            //     }
                            // });
                            const updatePromise = (async () => {
                                try {
                                    const contentInfo = await this._renderer.renderDefinition(
                                        editor.document, 
                                        selected.definition, 
                                        selectedText
                                    );
                                    
                                    this.updateContent(contentInfo);
                                    
                                    // 更新历史记录
                                    if (this._history.length > this._historyIndex) {
                                        this._history[this._historyIndex].content = contentInfo;
                                    }
                                } catch (error) {
                                    // 错误处理
                                    this.postMessageToWebview({
                                        type: 'showContentError',
                                        message: 'Failed to load definition content'
                                    });
                                }
                            })();

                            setTimeout(() => {
                                this.withProgress<void>(()=>updatePromise);
                            }, 0); 
                        }
                    }
                    break;
                case 'closeDefinitionList':
                    // 处理关闭定义列表的请求
                    this.postMessageToWebview({
                        type: 'clearDefinitionList'
                    });
                    break;
            }
        });
    }

    private resetWebviewPanel(panel: vscode.WebviewPanel) {
        panel.webview.html = this._getHtmlForWebview(panel.webview);

        const iconPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'icon.png');

        panel.iconPath = { light: iconPath, dark: iconPath };

        this.handleWebviewMessage(panel.webview);

        panel.onDidDispose(() => {
            // this.saveState();
            this._currentPanel = undefined;
        });
    }

    private async createFloatingWebview() {
        let title = "Context Window";
        let curContext = this.getCurrentContent();
        if (curContext?.content && curContext.content.jmpUri) {
            let filePath;
            try {
                filePath = decodeURIComponent(curContext.content.jmpUri);
            } catch (e) {
                filePath = curContext.content.jmpUri;
            }
            let filename = filePath.split('/').pop()?.split('\\').pop();
            title = filename ?? "Context Window";
        }

        this._currentPanel = vscode.window.createWebviewPanel(
            'FloatContextView',
            title,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                enableForms: true,
                retainContextWhenHidden: true
            }
        );

        this.resetWebviewPanel(this._currentPanel);

        this._currentPanel?.webview.postMessage({
            type: 'pinState',
            pinned: this._pinned
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

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
        this.handleWebviewMessage(webviewView.webview);

        webviewView.onDidChangeVisibility(() => {
            if (this._view?.visible) {
                let curContext = this.getCurrentContent();
                //console.log('[definition] onDidChangeVisibility');
                // If we have cached content, restore it immediately
                if (curContext?.content) {
                    // Show loading
                    //this._view?.webview.postMessage({ type: 'startLoading' });
                    const uri = curContext.content.jmpUri.toString();
                    const currentVersion = curContext.content.documentVersion;
                    
                    // 生成内容的唯一标识
                    const contentHash = `${uri}:${currentVersion}`;
                    this._view.webview.postMessage({
                        type: 'updateMetadata',
                        contentHash: contentHash,
                        uri: uri,
                        languageId: curContext.content.languageId,
                        updateMode: this._updateMode,
                        curLine: curContext.navigateLine + 1,
                        documentVersion: currentVersion
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
                    //this._currentPanel.dispose();
                    //this._currentPanel = undefined;
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
            const uri = curContext.content.jmpUri.toString();
            const currentVersion = curContext.content.documentVersion;
            
            // 生成内容的唯一标识
            const contentHash = `${uri}:${currentVersion}`;
            this._view.webview.postMessage({
                type: 'updateMetadata',
                contentHash: contentHash,
                uri: uri,
                languageId: curContext.content.languageId,
                updateMode: this._updateMode,
                curLine: curContext.navigateLine + 1,
                documentVersion: currentVersion
            });
            // Hide loading after content is updated
            //this._view?.webview.postMessage({ type: 'endLoading' });
        } else {
            //console.log('[definition] No cached content, keeping Ready for content state');
            // 没有缓存内容时，保持Monaco编辑器的"Ready for content."状态，不主动查找定义
            // 只有用户主动点击符号时才会触发定义查找
        }

        this._view.webview.postMessage({
            type: 'pinState',
            pinned: this._pinned
        });
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
        // 通知 Webview
        this.postMessageToWebview({
            type: 'pinState',
            pinned: this._pinned
        });

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
        const navigationScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'navigation.js'));

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
            <div class="double-click-area" title="double-click: Jump to definition">
                <span class="filename-display">
                    <span class="filename-text"></span>
                    <span class="filename-path">
                        <span class="filename-icon"></span>
                        <span class="filename-path-text"></span>
                    </span>
                </span>
            </div>

            <div class="progress-container">
                <div class="progress-bar"></div>
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
                <button class="nav-button" id="nav-back" title="Go Back">  </button>
                <button class="nav-button" id="nav-forward" title="Go Forward">  </button>
                <button class="nav-jump" id="nav-jump" title="Jump to definition"></button>
            </div>

            <script nonce="${nonce}" src="${navigationScriptUri}">
                // 导航按钮事件处理
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
            const uri = contentInfo.jmpUri.toString();
            const currentVersion = contentInfo.documentVersion;
            
            // 生成内容的唯一标识
            const contentHash = `${uri}:${currentVersion}`;
            
            // 只缓存最近一次的内容（供前端请求使用）
            this._lastContentHash = contentHash;
            this._lastContent = contentInfo;

            // this.postMessageToWebview({
            //     type: 'update',
            //     body: contentInfo.content,
            //     uri: contentInfo.jmpUri.toString(),
            //     languageId: contentInfo.languageId, // 添加语言ID
            //     updateMode: this._updateMode,
            //     curLine: (curLine !== -1) ? curLine + 1 : -1,
            //     symbolName: contentInfo.symbolName // 添加符号名称
            // });

            //console.log(`[definition] updateContent: Sending metadata for contentHash ${contentHash}`);

            // 先发送元数据（不包含 body）
            this.postMessageToWebview({
                type: 'updateMetadata',
                contentHash: contentHash,
                uri: uri,
                languageId: contentInfo.languageId,
                updateMode: this._updateMode,
                range: contentInfo.range,
                curLine: (curLine !== -1) ? curLine + 1 : -1,
                documentVersion: currentVersion
            });

            if (this._currentPanel) {
                let filePath;
                try {
                    filePath = decodeURIComponent(contentInfo.jmpUri);
                } catch (e) {
                    filePath = contentInfo.jmpUri;
                }
                let filename = filePath.split('/').pop()?.split('\\').pop();
                this._currentPanel.title = filename ?? "Context Window";
            }

            // Hide loading after content is updated
            //this._view?.webview.postMessage({ type: 'endLoading' });
            // 等待面板确认渲染完成
            //await this.waitForPanelReady();
        } else {
            this.postMessageToWebview({
                type: 'noContent',
                body: '&nbsp;&nbsp;No symbol found at current cursor position',
                updateMode: this._updateMode,
            });
        }
    }

    private async withProgress<T>(operation: () => Promise<T>): Promise<T> {
        this.postMessageToWebview({ type: 'beginProgress' });
        //console.log('[definition] beginProgress', new Date().toLocaleTimeString());
        
        try {
            // for test
            //await new Promise(resolve => setTimeout(resolve, 5000));
            return await operation();
        } finally {
            //console.log('[definition] endProgress', new Date().toLocaleTimeString());
            this.postMessageToWebview({ type: 'endProgress' });
        }
    }

    private async update(ignoreCache = false) {
        if (!this._view?.visible && !this._currentPanel?.visible) {
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

        this._lastUpdateEditor = editor;
        
        //console.log('[definition] update');
        const loadingEntry = { cts: new vscode.CancellationTokenSource() };
        this._loading = loadingEntry;

        const updatePromise = (async () => {
            const contentInfo = await this.getHtmlContentForActiveEditor(loadingEntry.cts.token);
            //console.log('[definition] updatePromise', contentInfo);
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
                this.currentLine = contentInfo.range.start.line;
            }
            
            if (this._updateMode === UpdateMode.Live || contentInfo.jmpUri) {
                this._currentCacheKey = newCacheKey;
                
                this._history = [];
                this._history.push({ content: contentInfo, navigateLine: this.currentLine });
                this._historyIndex = 0;

                this.updateContent(contentInfo);
            }
        })();

        this.withProgress<void>(()=>updatePromise);
/*
        await Promise.race([
            updatePromise,

            // Don't show progress indicator right away, which causes a flash
            new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => {
                if (loadingEntry.cts.token.isCancellationRequested) {
                    return;
                }
                return vscode.window.withProgress({ location: { viewId: ContextWindowProvider.viewType } }, () => updatePromise);
            }),
        ]);*/
    }

    // 修改选择事件处理方法
    private async getHtmlContentForActiveEditor(token: vscode.CancellationToken): Promise<FileContentInfo> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            //console.log('No editor');
            // Around line 452, there's likely a return statement like this:
            // It needs to be updated to include the languageId property:
            return { 
                content: '', column: 0, 
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 }
                },
                jmpUri: '', languageId: 'plaintext', documentVersion: 0, lineCount: 0 
            };
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
            return { 
                content: '', column: 0, 
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 0 }
                },
                jmpUri: '', languageId: 'plaintext', documentVersion: 0, lineCount: 0 
            };
        }

        // 确保关闭之前的面板
        if (this._currentPanel) {
            //this._currentPanel.dispose();
            //this._currentPanel = undefined;
        }

        let definition = definitions[0];

        if (definitions.length > 1) {
            const currentPosition = editor.selection.active;
            definition = await this.showDefinitionPicker(definitions, editor, currentPosition);
            if (!definition) {
                return { 
                    content: '', column: 0, 
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 0 }
                    },
                    jmpUri: '', languageId: 'plaintext', documentVersion: 0, lineCount: 0 
                };
            }
        } else {
            // 主动隐藏定义列表
            this.postMessageToWebview({
                type: 'clearDefinitionList'
            });
        }

        //console.log('[definition] ', definitions);
        return definitions.length ? await this._renderer.renderDefinition(editor.document, definition, selectedText) : { 
            content: '', column: 0, 
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 }
            },
            jmpUri: '', languageId: 'plaintext', documentVersion: 0, lineCount: 0 
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
            const definitionListData = definitions.map((definition, index) => {
                try {
                    let def = definition;
                    let uri = (def instanceof vscode.Location) ? def.uri : def.targetUri;
                    let range = (def instanceof vscode.Location) ? def.range : (def.targetSelectionRange ?? def.targetRange);
            
                    // 使用全路径
                    const displayPath = uri.fsPath;

                    // 使用传入的符号名称，避免异步文件操作
                    const symbolName = this._currentSelectedText || `Definition ${index + 1}`;
                    
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
            });
            
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
                
                this.postMessageToWebview({
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

import * as vscode from 'vscode';
import { Renderer, FileContentInfo } from './renderer';

enum UpdateMode {
    Live = 'live',
    Sticky = 'sticky',
}
const maxHistorySize = 50;
const MOUSE_RELEASE_DELAY = 300;   // 鼠标松开检测延时（ms）
const INITIAL_UPDATE_DELAY = 2000; // 初始化后保底更新延时（ms）

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

    private _initialUpdateTimer?: NodeJS.Timeout; // 构造时的保底更新延时引用

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
    private _lastUpdateEditor: vscode.TextEditor | undefined;

    private _lastContentHash: string | undefined;  // 最近一次的内容标识
    private _lastContent: FileContentInfo | undefined;  // 最近一次的内容

    private _progressDepth = 0;  // 进度条嵌套计数：归零才隐藏，避免并发更新时进度条错配

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
        let lastDocumentVersion: number | undefined;
        // 修改选择变化事件处理
        vscode.window.onDidChangeTextEditorSelection((e) => {
            // 跳过非空选区的更新
            if (!e.selections[0].isEmpty) {
                return;
            }

            const currentDocumentVersion = e.textEditor.document.version;

            // 检查是否是输入事件（文档版本变化）
            if (lastDocumentVersion && currentDocumentVersion !== lastDocumentVersion) {
                // 输入事件（文档版本变化）：仅记录版本，不触发更新
                lastDocumentVersion = currentDocumentVersion;
                return;
            }

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
                    }, MOUSE_RELEASE_DELAY);
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
        this._initialUpdateTimer = setTimeout(() => {
            this._initialUpdateTimer = undefined;
            this.update(/* force */ true);
        }, INITIAL_UPDATE_DELAY);

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
                cacheSizeLimit: contextWindowConfig.get('cacheSizeLimit', 30),
                fixStickyScroll: contextWindowConfig.get('fixStickyScroll', false),
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
        } else {
            config.customThemeRules = [];
        }

        return config;
    }

    dispose() {
        //ContextWindowProvider.outputChannel.appendLine('[definition] Provider disposing...');
        // 清理所有 pending 定时器，避免插件停用后回调到已释放对象上
        if (this._mouseTimer) {
            clearTimeout(this._mouseTimer);
            this._mouseTimer = undefined;
        }
        if (this._keyboardUpdateTimer) {
            clearTimeout(this._keyboardUpdateTimer);
            this._keyboardUpdateTimer = null;
        }
        if (this._initialUpdateTimer) {
            clearTimeout(this._initialUpdateTimer);
            this._initialUpdateTimer = undefined;
        }

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

    public async navigateCommand(uri: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }, token: string = '') {
        // Validate input parameters
        if (!uri || typeof uri !== 'string') {
            vscode.window.showErrorMessage('Invalid URI provided');
            return;
        }

        if (!range) {
            vscode.window.showErrorMessage('Range parameter is required');
            return;
        }

        // Validate range parameters
        if (range.start.line < 1 || range.end.line < 1 || 
            range.start.character < 1 || range.end.character < 1) {
            vscode.window.showErrorMessage('Invalid range parameters: line numbers must be >= 1 and characters must be >= 1');
            return;
        }

        if (range.start.line > range.end.line || 
            (range.start.line === range.end.line && range.start.character > range.end.character)) {
            vscode.window.showErrorMessage('Invalid range: start position must be before or equal to end position');
            return;
        }

        // Parse and validate URI
        let targetUri: vscode.Uri;
        try {
            targetUri = vscode.Uri.parse(uri);
        } catch (error) {
            vscode.window.showErrorMessage(`Invalid URI format: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return;
        }

        // Check if file exists and is accessible
        try {
            // Use workspace.fs to check if file exists
            try {
                const stats = await vscode.workspace.fs.stat(targetUri);
                if (stats.type !== vscode.FileType.File) {
                    vscode.window.showErrorMessage('The provided URI does not point to a file');
                    return;
                }
            } catch (statError) {
                // File doesn't exist or is not accessible
                vscode.window.showErrorMessage(`File not found or not accessible: ${uri}`);
                return;
            }
        } catch (error) {
            vscode.window.showWarningMessage(`Unable to verify file accessibility, proceeding anyway: ${error instanceof Error ? error.message : 'Unknown error'}`);
            // Continue anyway - might be a remote file or special URI scheme
        }

        const editor = vscode.window.activeTextEditor || this._lastUpdateEditor;
        const languageId = editor ? editor.document.languageId : 'plaintext';

        // Create location using the range
        const definition = new vscode.Location(
            targetUri,
            new vscode.Range(
                new vscode.Position(range.start.line - 1, range.start.character-1),
                new vscode.Position(range.end.line - 1, range.end.character-1)
            )
        );

        const contentInfo = await this._renderer.renderDefinition(languageId, definition);
        this.updateContent(contentInfo);
        
        // 使用range的起始位置作为导航行号用于历史记录
        this.addToHistory(contentInfo, range.start.line);
    }

    private async handleWebviewMessage(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async message => {
            const editor = vscode.window.activeTextEditor || this._lastUpdateEditor;
            switch (message.type) {
                case 'tokenStyle.get':
                    this.handleTokenStyleGet(message);
                    break;
                case 'tokenStyle.set':
                    await this.handleTokenStyleSet(message);
                    break;
                case 'editorReady':
                    this.handleEditorReady(webview);
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
                    await this.handleRevealInFileExplorer(message);
                    break;
                case 'navigate':
                    this.navigate(message.direction);
                    break;
                case 'requestContent':
                    this.handleRequestContent(message);
                    break;
                case 'jumpDefinition':
                    this.handleJumpDefinition(message, editor);
                    break;
                case 'doubleClick':
                    await this.handleDoubleClick(message);
                    break;
                case 'definitionItemSelected':
                    this.handleDefinitionItemSelected(message, editor);
                    break;
                case 'closeDefinitionList':
                    this.postMessageToWebview({ type: 'clearDefinitionList' });
                    break;
            }
        });
    }

    /**
     * 统一发送 updateMetadata 消息，避免在多处重复构造 contentHash + postMessage。
     * @param content      内容信息
     * @param curLine      1-based 当前行（-1 表示无）
     * @param includeRange 是否附带 range（updateContent 场景需要）
     * @param target       指定目标 webview；不传则广播到 view + panel
     */
    private postMetadata(content: FileContentInfo, curLine: number, includeRange: boolean, target?: vscode.Webview) {
        const uri = content.jmpUri.toString();
        const currentVersion = content.documentVersion;
        const msg: any = {
            type: 'updateMetadata',
            contentHash: `${uri}:${currentVersion}`,
            uri,
            languageId: content.languageId,
            updateMode: this._updateMode,
            curLine,
            documentVersion: currentVersion
        };
        if (includeRange) {
            msg.range = content.range;
        }
        if (target) {
            target.postMessage(msg);
        } else {
            this.postMessageToWebview(msg);
        }
    }

    // 通过 token 查询颜色与字体样式（仅从 rules 读取）
    private handleTokenStyleGet(message: any) {
        try {
            const token = String(message.token ?? '');
            const rules = this.getThemeRules();
            let rule = rules.find(r => r && r.token === token);
            // 如果找不到，去掉语言后缀（最后一个 . 之后的部分）再尝试一次
            if (!rule) {
                const lastDot = token.lastIndexOf('.');
                if (lastDot > 0) {
                    const tokenNoLang = token.slice(0, lastDot);
                    rule = rules.find(r => r && r.token === tokenNoLang);
                }
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
    }

    // 通过 token 设置颜色与字体样式（仅写入 rules）
    private async handleTokenStyleSet(message: any) {
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

            const prev = this.getThemeRules();
            const next = this.upsertRule(prev, token, patch);
            await this.setThemeRules(next);
        } catch (err) {
            this.postMessageToWebview({
                type: 'tokenStyle.set.result',
                ok: false,
                token: message?.token,
                error: String(err),
            });
        }
    }

    // 浮动面板的编辑器就绪：若有缓存内容则立即恢复
    private handleEditorReady(webview: vscode.Webview) {
        if (!(this._currentPanel && webview === this._currentPanel.webview)) {
            return;
        }
        const curContext = this.getCurrentContent();
        if (curContext?.content) {
            // 恢复时携带 range，确保面板重新就绪后能滚动并高亮到定义行
            this.postMetadata(curContext.content, curContext.navigateLine + 1, true, this._currentPanel.webview);
        }
        this.postMessageToWebview({
            type: 'pinState',
            pinned: this._pinned
        });
    }

    private async handleRevealInFileExplorer(message: any) {
        if (!message.filePath) {
            return;
        }
        try {
            const uri = vscode.Uri.parse(message.filePath);
            await vscode.commands.executeCommand('revealFileInOS', uri);
        } catch (error) {
            console.error('[context-window] revealInExplorer error:', error);
        }
    }

    // WebView 请求完整内容（优先命中最近一次的单槽缓存，未命中则按 uri 现取）
    private handleRequestContent(message: any) {
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
            return;
        }

        // 单槽快照未命中：不再放弃，改为按 uri 现取。
        // 大文件自动命中后端 _fileCache，小文件重新读取也很便宜；
        // 不再依赖会被下一次 updateContent 覆盖的 _lastContent 单槽。
        (async () => {
            try {
                const reqUri = vscode.Uri.parse(message.uri);
                const info = await this._renderer.getContentByUri(reqUri);
                this.postMessageToWebview({
                    type: 'updateContent',
                    contentHash: message.contentHash,
                    body: info.content,
                    uri: message.uri,
                    languageId: info.languageId,
                    updateMode: this._updateMode,
                    documentVersion: info.documentVersion,
                    lineCount: info.lineCount
                    // 不回传 range/curLine：前端用 updateMetadata 阶段保存的定位信息
                });
            } catch (e) {
                this.postMessageToWebview({
                    type: 'contentError',
                    contentHash: message.contentHash,
                    uri: message.uri,
                    message: 'Content not available'
                });
            }
        })();
    }

    // 点击符号：查找定义并渲染
    private handleJumpDefinition(message: any, editor: vscode.TextEditor | undefined) {
        if (!editor || !(message.uri?.length > 0)) {
            return;
        }

        const updatePromise = (async () => {
            const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                vscode.Uri.parse(message.uri),
                new vscode.Position(message.position.line, message.position.character)
            );

            if (definitions && definitions.length > 0) {
                // 主动隐藏定义列表（在处理新的跳转前）
                if (definitions.length === 1) {
                    this.postMessageToWebview({ type: 'clearDefinitionList' });
                }

                let definition = definitions[0];

                // 如果有多个定义，传递给 Monaco Editor
                if (definitions.length > 1) {
                    const currentPosition = new vscode.Position(message.position.line, message.position.character);
                    definition = await this.showDefinitionPicker(definitions, editor, currentPosition);
                }

                const contentInfo = await this._renderer.renderDefinition(editor.document.languageId, definition);
                this.updateContent(contentInfo);
                this.addToHistory(contentInfo, message.position.line);
            } else {
                this.postMessageToWebview({
                    type: 'noSymbolFound',
                    pos: message.position,
                    token: message.token
                });
            }
        })();

        this.withProgress<void>(() => updatePromise);
    }

    // 双击底部区域：在主编辑区打开当前上下文文件并跳转
    private async handleDoubleClick(message: any) {
        if (message.location !== 'bottomArea') {
            return;
        }

        const curContext = this.getCurrentContent();
        this.currentUri = curContext?.content ? vscode.Uri.parse(curContext.content.jmpUri) : undefined;
        this.currentLine = curContext?.content ? curContext.content.range.start.line : 0;
        if (!this.currentUri) {
            return;
        }

        const document = await vscode.workspace.openTextDocument(this.currentUri);
        const line = this.currentLine;
        const range = new vscode.Range(line, 0, line, 0);
        const column = this._currentPanel ? vscode.ViewColumn.One : vscode.ViewColumn.Active;

        const openedEditor = await vscode.window.showTextDocument(document, {
            selection: range,
            viewColumn: column,
            preserveFocus: false,
            preview: false
        });

        if (openedEditor !== vscode.window.activeTextEditor) {
            console.error('[context-window] Failed to open text editor');
        }

        this._currentCacheKey = createCacheKey(vscode.window.activeTextEditor);
    }

    // 定义列表项被选中：渲染对应定义
    private handleDefinitionItemSelected(message: any, editor: vscode.TextEditor | undefined) {
        if (!this._pickItems || message.index === undefined) {
            return;
        }
        const selected = this._pickItems[message.index];
        if (!selected || !editor) {
            return;
        }

        const updatePromise = (async () => {
            try {
                const contentInfo = await this._renderer.renderDefinition(
                    editor.document.languageId,
                    selected.definition
                );

                this.updateContent(contentInfo);

                // 更新历史记录
                if (this._history.length > this._historyIndex) {
                    this._history[this._historyIndex].content = contentInfo;
                }
            } catch (error) {
                this.postMessageToWebview({
                    type: 'showContentError',
                    message: 'Failed to load definition content'
                });
            }
        })();

        setTimeout(() => {
            this.withProgress<void>(() => updatePromise);
        }, 0);
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
                const curContext = this.getCurrentContent();
                // 有缓存内容时立即恢复；没有则保持 Monaco "Ready for content." 状态，不主动查找定义
                if (curContext?.content) {
                    // 恢复时携带 range，确保视图重新可见后能滚动并高亮到定义行
                    this.postMetadata(curContext.content, curContext.navigateLine + 1, true, this._view.webview);
                }
            }
        });

        webviewView.onDidDispose(() => {
            this._view = undefined;
        });

        this.updateTitle();

        const curContext = this.getCurrentContent();

        // 初始加载时如果有缓存内容就直接使用；否则保持 "Ready for content." 状态
        if (curContext?.content) {
            // 携带 range，确保初次加载缓存内容后能滚动并高亮到定义行
            this.postMetadata(curContext.content, curContext.navigateLine + 1, true, this._view.webview);
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
                worker-src ${webview.cspSource} blob:;
                child-src ${webview.cspSource} blob:;
                img-src data: https: ${webview.cspSource};
                font-src ${webview.cspSource} data:;
                ">

            <meta name="viewport" content="width=device-width, initial-scale=1.0">

            <link href="${styleUri}" rel="stylesheet">
            
            <title>Definition View</title>
        </head>
        <body>
            <div class="loading"></div>
            <article id="main"></article>
            
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

    private async updateContent(contentInfo?: FileContentInfo, curLine: number =-1) {
        if (contentInfo && contentInfo.content.length && contentInfo.jmpUri) {
            // 只缓存最近一次的内容（供前端请求使用）
            this._lastContentHash = `${contentInfo.jmpUri.toString()}:${contentInfo.documentVersion}`;
            this._lastContent = contentInfo;

            // 先发送元数据（不包含 body），body 由前端按需 requestContent 拉取
            this.postMetadata(contentInfo, (curLine !== -1) ? curLine + 1 : -1, true);

            if (this._currentPanel) {
                let filePath;
                try {
                    filePath = decodeURIComponent(contentInfo.jmpUri);
                } catch (e) {
                    filePath = contentInfo.jmpUri;
                }
                const filename = filePath.split('/').pop()?.split('\\').pop();
                this._currentPanel.title = filename ?? "Context Window";
            }
        } else {
            this.postMessageToWebview({
                type: 'noContent',
                body: '&nbsp;&nbsp;No symbol found.',
                updateMode: this._updateMode,
            });
        }
    }

    private async withProgress<T>(operation: () => Promise<T>): Promise<T> {
        // 用计数器配对 begin/end：只有首个开始时显示、最后一个结束时隐藏，
        // 避免多次更新交叠导致进度条提前消失或卡住。
        if (this._progressDepth === 0) {
            this.postMessageToWebview({ type: 'beginProgress' });
        }
        this._progressDepth++;

        try {
            return await operation();
        } finally {
            this._progressDepth--;
            if (this._progressDepth === 0) {
                this.postMessageToWebview({ type: 'endProgress' });
            }
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

        this.withProgress<void>(() => updatePromise);
    }

    private async getHtmlContentForActiveEditor(token: vscode.CancellationToken): Promise<FileContentInfo> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return createEmptyContent();
        }

        const definitions = await this.getDefinitionAtCurrentPositionInEditor(editor);

        if (token.isCancellationRequested || !definitions || definitions.length === 0) {
            return createEmptyContent();
        }

        let definition = definitions[0];

        if (definitions.length > 1) {
            const currentPosition = editor.selection.active;
            definition = await this.showDefinitionPicker(definitions, editor, currentPosition);
            if (!definition) {
                return createEmptyContent();
            }
        } else {
            // 主动隐藏定义列表
            this.postMessageToWebview({
                type: 'clearDefinitionList'
            });
        }

        // 此处 definitions 必非空，直接渲染选中的定义
        return await this._renderer.renderDefinition(editor.document.languageId, definition);
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

                    return {
                        location: `${displayPath}:${range.start.line + 1}`,
                        filePath: displayPath, // 使用文件系统路径而不是URI
                        lineNumber: range.start.line,
                        columnNumber: range.start.character + 1, // 添加列号信息（转换为1-based）
                        isActive: index === 0, // 第一个定义默认激活
                        definition: definition,
                        uri: uri.toString()
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
                            const lineDiff = Math.abs(def.lineNumber - currentPosition.line);
                            const charDiff = Math.abs(def.columnNumber - currentPosition.character);
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

// 统一的空内容工厂，替代多处重复的空 FileContentInfo 字面量
function createEmptyContent(): FileContentInfo {
    return {
        content: '',
        range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
        },
        jmpUri: '',
        languageId: 'plaintext',
        documentVersion: 0,
        lineCount: 0
    };
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

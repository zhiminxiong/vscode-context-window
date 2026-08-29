import * as vscode from 'vscode';
import { showPanelInNewWindow } from './auxiliaryWindow';
import { Renderer, FileContentInfo } from './renderer';
import { resolveSemanticRules, resolveRawTokenColors } from './themeColorResolver';
import { getGrammarMaps, getGrammarContent } from './grammarRegistry';
import { blameLine, blameLineDiff, openBlameDiff } from './lineBlame';
import { enclosingSymbolRange } from './enclosingSymbol';

enum UpdateMode {
    Live = 'live',
    Sticky = 'sticky',
}

type JumpMode = 'definition' | 'typeDefinition' | 'implementation' | 'references';

const JUMP_MODES: readonly JumpMode[] = ['definition', 'typeDefinition', 'implementation', 'references'];

const JUMP_PROVIDER_COMMAND: Record<JumpMode, string> = {
    definition: 'vscode.executeDefinitionProvider',
    typeDefinition: 'vscode.executeTypeDefinitionProvider',
    implementation: 'vscode.executeImplementationProvider',
    references: 'vscode.executeReferenceProvider',
};
const maxHistorySize = 50;
const MOUSE_RELEASE_DELAY = 300;   // 鼠标松开检测延时（ms）
const INITIAL_UPDATE_DELAY = 2000; // 初始化后保底更新延时（ms）

interface HistoryInfo {
    content: FileContentInfo | undefined;
    // 「返回该条时光标应落回的位置」，均为 0-based，-1 表示未知。
    // navigateLine 由来源侧写入（离开该段时点击的行）；navigateColumn 是同一次点击的列，
    // 有了列才能精确回到当初点出去的那个 token，否则前端只能退回行尾。
    navigateLine: number;
    navigateColumn: number;
    // 这一跳落到的符号名，供顶栏跳转链（foo → bar → baz）显示。
    symbolName: string;
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
    private currentColumn: number = 0; // 与 currentLine 配对的列号（0-based）
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

    // —— 对齐 VSCode ModelSemanticColoring 的 semantic 异步补取（内容先出、data 后覆盖）——
    // 内容下发后不阻塞，延迟(debounce)向语言服务器取整篇 semantic data，取到再单独postMessage 下发。
    private _semanticTimer: NodeJS.Timeout | null = null;
    private _semanticCts?: vscode.CancellationTokenSource;
    // 自适应 debounce：对齐 VSCode 的 min 300 / max 2000 + SlidingWindowAverage(6)。
    private _semanticDelays: number[] = [];
    private static readonly SEMANTIC_MIN_DELAY = 300;
    private static readonly SEMANTIC_MAX_DELAY = 2000;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) {
        // 监听主题变化：除主题名外，同步下发新主题解析出的语义配色，使 Monaco 实时跟随 VSCode 配色
        this._themeListener = vscode.window.onDidChangeActiveColorTheme(theme => {
            this.postMessageToWebview({
                    type: 'updateTheme',
                    theme: this._getVSCodeTheme(theme),
                    themeSemanticRules: resolveSemanticRules(),
                    // 方案 B：主题切换时同步刷新「全部 textmate scope → 颜色」，使基础语法层实时跟随主题
                    themeTextmateRules: this._isTextmateEnabled() ? resolveRawTokenColors() : undefined
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
                // 指令高亮（#include 等）的配色/字重，或括号对着色开关变化时，同步最新 contextEditorCfg，
                // 使 webview 内的对应样式与 VSCode 保持一致。
                if (e.affectsConfiguration('editor.tokenColorCustomizations') ||
                    e.affectsConfiguration('editor.fontWeight') ||
                    e.affectsConfiguration('editor.bracketPairColorization.enabled') ||
                    // 主编辑器 sticky scroll 开关变化时，若本插件未显式设置（跟随模式），
                    // 需回推最新有效值刷新 webview 的粘附行显示。
                    e.affectsConfiguration('editor.stickyScroll.enabled')) {
                    this.postMessageToWebview({
                        type: 'updateContextEditorCfg',
                        contextEditorCfg: updatedConfig.contextEditorCfg,
                        customThemeRules: updatedConfig.customThemeRules
                    });
                }
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
                if (e.affectsConfiguration('contextView.contextWindow.jumpMode')) {
                    this.postMessageToWebview({ type: 'clearDefinitionList' });
                    this.invalidateCacheKey();
                    this.update();
                }
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

    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, _state: any): Promise<void> {
        // Reload / 再次打开工作区时 VS Code 会还原浮动 Context 标签，但内容无法可靠恢复。
        // 与 Call Relation 一样：反序列化时直接关掉，需要时再从命令打开。
        webviewPanel.dispose();
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
        return (this._history && this._history.length > this._historyIndex)
            ? this._history[this._historyIndex]
            : { content: undefined, navigateLine: -1, navigateColumn: -1, symbolName: '' };
    }

    // fromLine / fromColumn：离开「当前这一条」时用户点击的位置（0-based），写回旧的当前条，
    // 返回时据此把光标精确放回当初点出去的那个 token 上。只有行没有列时前端只能退到行尾，
    // 光标会落在无关标识符上（Monaco 的同词高亮跟着跑偏）。
    // symbolName：落到的符号名；缺省则从定义 range 截标识符。
    private addToHistory(contentInfo: FileContentInfo, fromLine: number =-1, fromColumn: number =-1, symbolName?: string) {
        //console.log('[definition] add history from line', fromLine, 'column', fromColumn);
        // 清除_historyIndex后的内容
        this._history = this._history.slice(0, this._historyIndex + 1);
        const name = (symbolName && symbolName.trim()) || nameFromContent(contentInfo);
        this._history.push({ content: contentInfo, navigateLine: -1, navigateColumn: -1, symbolName: name });
        this._historyIndex++;

        this._history[this._historyIndex-1].navigateLine = fromLine;
        this._history[this._historyIndex-1].navigateColumn = fromColumn;

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

    // 基础语法层是否用真实 TextMate：仅在非默认模式（useDefaultTokenizer 关闭）下启用，
    // 默认模式纯用 Monaco 内置 Monarch。原 useTextmateGrammar 开关已移除，非默认模式直接走 TextMate。
    private _isTextmateEnabled(): boolean {
        return !vscode.workspace
            .getConfiguration('contextView.contextWindow')
            .get<boolean>('useDefaultTokenizer', true);
    }

    // 解析 Sticky Scroll 的有效开关值（三态 → 布尔）。
    //插件自身配置 contextView.contextWindow.stickyScroll：
    //   · 未设置（null / undefined）→ 跟随主编辑器 editor.stickyScroll.enabled（保持与VSCode 同步）；
    //   · 显式 true/false → 以插件设置为准（右键菜单切换会写入此项，从而覆盖 VSCode 全局值）。
    private _resolveStickyScrollEnabled(
        contextWindowConfig: vscode.WorkspaceConfiguration,
        editorConfig: vscode.WorkspaceConfiguration
    ): boolean {
        const own = contextWindowConfig.get<boolean | null>('stickyScroll', null);
        if (typeof own === 'boolean') {
            return own;
        }
        // 未设置：跟随主编辑器全局开关（VSCode 默认 true）。
        return editorConfig.get<boolean>('stickyScroll.enabled', true);
    }

    // 持久化跳转链顶栏开关：右键菜单切换时由 webview 发来，写入用户全局配置。
    // 写入后 onDidChangeConfiguration 会通过 updateContextEditorCfg 把最新值广播回 webview。
    private async handleSetLineBlame(message: any) {
        try {
            const value = !!message?.value;
            const cfg = vscode.workspace.getConfiguration('contextView.contextWindow');
            await cfg.update('lineBlame', value, true);
        } catch (err) {
            console.error('[context-window] setLineBlame failed:', err);
        }
    }

    // 浮窗 Changes：在主编辑区打开 previousSha ↔ sha 的文件 diff。
    private async handleOpenLineBlameChanges(message: any) {
        const uri = String(message?.uri ?? '');
        const previousSha = String(message?.previousSha ?? '');
        const sha = String(message?.sha ?? '');
        const workingTree = !!message?.workingTree;
        const line = message?.line | 0;
        if (!uri || (!sha && !workingTree)) {
            return;
        }
        try {
            await openBlameDiff(uri, previousSha, sha, { workingTree, line });
        } catch (err) {
            console.error('[context-window] openLineBlameChanges failed:', err);
            vscode.window.showErrorMessage('Failed to open git changes');
        }
    }

    private async handleSetJumpTrail(message: any) {
        try {
            const value = !!message?.value;
            const cfg = vscode.workspace.getConfiguration('contextView.contextWindow');
            await cfg.update('jumpTrail', value, true);
        } catch (err) {
            console.error('[context-window] setJumpTrail failed:', err);
        }
    }

    // 底栏上拉列表切换跳转模式。写入后 onDidChangeConfiguration 会回推 webview 并按新 provider 重查。
    private async handleSetJumpMode(message: any) {
        try {
            const mode = normalizeJumpMode(message?.mode);
            const cfg = vscode.workspace.getConfiguration('contextView.contextWindow');
            await cfg.update('jumpMode', mode, true);
        } catch (err) {
            console.error('[context-window] setJumpMode failed:', err);
        }
    }

    private async handleSetUpdateMode(message: any) {
        try {
            const mode = message?.value === 'sticky' ? 'sticky' : 'live';
            const cfg = vscode.workspace.getConfiguration('contextView.contextWindow');
            await cfg.update('updateMode', mode, true);
        } catch (err) {
            console.error('[context-window] setUpdateMode failed:', err);
        }
    }

    // 持久化 Sticky Scroll 开关：右键菜单切换时由webview 发来，写入插件自身配置（覆盖跟随 VSCode 的默认行为）。
    // 写入后 onDidChangeConfiguration 回调会通过 updateContextEditorCfg 把最新有效值广播回 webview。
    private async handleSetStickyScroll(message: any) {
        try {
            const value = !!message?.value;
            const cfg = vscode.workspace.getConfiguration('contextView.contextWindow');
            await cfg.update('stickyScroll', value, true);
        } catch (err) {
            console.error('[context-window] setStickyScroll failed:', err);
        }
    }

    // 从 editor.tokenColorCustomizations 读取 #include 等预处理指令的前景色。
    // 与扩展端 VSCode 装饰（registerDirectiveDecorations）取色保持一致，使 webview Monaco 高亮同源。
    private _readDirectiveColor(): string {
        const config = vscode.workspace.getConfiguration('editor.tokenColorCustomizations');
        const textMateRules = (config?.get('textMateRules') || []) as Array<{
            scope: string;
            settings: { foreground?: string };
        }>;
        for (const rule of textMateRules) {
            if (rule.scope === 'keyword.control.directive.include') {
                return rule.settings.foreground || '#0000FF';
            }
        }
        return '#0000FF'; // 默认颜色
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
            themeSemanticRules?: any[];
            themeTextmateRules?: any[];
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
                // VSCode 的括号对着色开关：下发给 webview，使 Monaco 括号对着色行为与 VSCode 一致。
                bracketPairColorization: editorConfig.get<boolean>('bracketPairColorization.enabled', true),
                cacheSizeLimit: contextWindowConfig.get('cacheSizeLimit', 30),
                fixStickyScroll: contextWindowConfig.get('fixStickyScroll', false),
                // 是否启用自定义 hover 提示（右键菜单可切换，默认 false）。
                // webview 启动/运行期读取该值决定是否注册低延迟、复用主编辑区 LSP 的 hover provider。
                enableHover: contextWindowConfig.get('enableHover', false),
                // #include/#pragma/#region/#endregion 等指令高亮：开关与配色同步给 webview，
                // 使 Monaco 编辑器内做与 VSCode 编辑器一致的指令着色。
                fixToken: contextWindowConfig.get('fixToken', false),
                directiveColor: this._readDirectiveColor(),
                // 「双击选中整对括号/引号（含定界符）」开关：下发给 webview，用于底部导航栏 {si} 指示器的开/关显示。
                doubleClickSelectsBracketPair: contextWindowConfig.get('doubleClickSelectsBracketPair', false),
                // Context Window 行号栏双击选中当前行所属的最小函数/类/命名空间。默认开。
                contextDoubleClickSelectsSymbol: contextWindowConfig.get('contextDoubleClickSelectsSymbol', true),
                // Monaco 内置「光标处同词高亮」开关，默认关。本面板的光标是程序设置的（跳转/返回定位），
                // 而该高亮只认光标所在的词，差一列就框到旁边的无关标识符上。
                occurrencesHighlight: contextWindowConfig.get('occurrencesHighlight', false),
                // Sticky Scroll（顶部粘附的函数/类标题行）是否显示的「有效值」。
                // 本插件配置 contextView.contextWindow.stickyScroll 为三态：
                //   · null（默认，未设置）→ 跟随主编辑器 editor.stickyScroll.enabled；
                //   · true/false → 以插件自身设置为准（右键菜单切换即写入此项，从而覆盖 VSCode 全局值）。
                // 后端在此把三态解析成一个明确的布尔值下发，前端启动/运行期据此设置 Monaco 的 stickyScroll.enabled。
                stickyScroll: this._resolveStickyScrollEnabled(contextWindowConfig, editorConfig),
                // 跳转链顶栏（定义 hop 面包屑）：右键可关，默认开。
                jumpTrail: contextWindowConfig.get('jumpTrail', true),
                // 顶栏最多显示几个具名 crumb（不含 › / …）。超出收进 … 下拉。
                jumpTrailMaxItems: contextWindowConfig.get('jumpTrailMaxItems', 8),
                // 用户点击某行后，在该行行尾显示 git 摘要。跳转定位不显示。
                lineBlame: contextWindowConfig.get('lineBlame', true),
                // 勾选：指针移到行尾摘要即出浮窗。不勾选（默认）：按住 Alt 才出。lineBlame 关或没有摘要时仍不出现。
                lineBlameHover: contextWindowConfig.get('lineBlameHover', false),
                // 点击符号时走哪一种 LSP 跳转。默认 Definition；底栏上拉列表可改。
                jumpMode: normalizeJumpMode(contextWindowConfig.get('jumpMode', 'definition')),
                updateMode: String(contextWindowConfig.get('updateMode') || 'live') === 'sticky' ? 'sticky' : 'live',
            }
        };

        // 自定义主题规则：始终下发当前主题对应的用户规则（右键改色保存的内容），
        // 不再受 useDefaultTokenizer 门控——无论默认 tokenizer 还是语义模式，保存的配色都应生效。
        config.customThemeRules = this.getThemeRules();

        // 从当前 VSCode 主题解析出的语义 token 真实配色，作为 Monaco 的默认色（前端可被用户规则覆盖）。
        // 解析失败时为 undefined，前端回退到硬编码兜底色。
        config.themeSemanticRules = resolveSemanticRules();

        // 方案 B：启用真实 TextMate 语法时，下发主题全部 tokenColors（scope → 颜色），供基础语法层着色。
        if (this._isTextmateEnabled()) {
            config.themeTextmateRules = resolveRawTokenColors();
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

        // 取消并释放正在进行的更新加载
        // 否则 CancellationTokenSource 与其内部 emitter 会随 provider 实例长驻，
        // 且未 cancel 的异步链仍可能在 dispose 后触发 postMessageToWebview。
        if (this._loading) {
            try { this._loading.cts.cancel(); } catch (_) { /* noop */ }
            try { this._loading.cts.dispose(); } catch (_) { /* noop */ }
            this._loading = undefined;
        }

        // 清理 semantic 异步补取的定时器与进行中的请求，避免 dispose 后回调到已释放对象
        if (this._semanticTimer) {
            clearTimeout(this._semanticTimer);
            this._semanticTimer = null;
        }
        if (this._semanticCts) {
            try { this._semanticCts.cancel(); } catch (_) { /* noop */ }
            try { this._semanticCts.dispose(); } catch (_) { /* noop */ }
            this._semanticCts = undefined;
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

        // 释放对大对象的强引用：历史里每条 HistoryInfo.content 含整文件文本，
        // 多次跳转后可达 MB 级；provider 实例自身可能被外部弱引用滞留，主动清空有助 GC。
        this._history = [];
        this._historyIndex = 0;
        this._lastContent = undefined;
        this._lastContentHash = undefined;
        this._pickItems = undefined;
        this._lastUpdateEditor = undefined;
        this._view = undefined;
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
            this.revealHistoryEntry();
        }
    }

    // 跳转链随机访问：点中间某一截，等价于前进/后退落到该条。
    private navigateTo(index: number) {
        if (index < 0 || index >= this._history.length || index === this._historyIndex) {
            return;
        }
        this._historyIndex = index;
        this.revealHistoryEntry();
    }

    private revealHistoryEntry() {
        this.postMessageToWebview({
                type: 'clearDefinitionList'
            });

        const contentInfo = this._history[this._historyIndex];
        // 面包屑/前进后退都按「这一跳的定义」定位：垂直居中、水平靠左。
        // 不传 navigateLine——那是离开时点出去的位置，拿来 reveal 会落到无关行且容易贴顶。
        this.updateContent(contentInfo?.content);
        // 历史导航后展示的已不是「主编辑区当前光标处」的上下文，缓存键必须失效，
        // 否则再点主编辑区那个原 token 会被 update() 的同键判定挡掉（见 invalidateCacheKey 说明）
        this.invalidateCacheKey();
    }

    // 把当前跳转链推给前端。只有多于 1 条时顶栏才显示。
    private postHistory() {
        this.postMessageToWebview({
            type: 'updateHistory',
            index: this._historyIndex,
            items: this._history.map(h => {
                const startLine = h.content?.range?.start?.line;
                return {
                    name: h.symbolName || nameFromContent(h.content),
                    file: basenameFromUri(h.content?.jmpUri),
                    uri: h.content?.jmpUri || '',
                    // 定义落点，1-based，供拷贝调用链给 AI。
                    line: (typeof startLine === 'number' && startLine >= 0) ? startLine + 1 : 0
                };
            })
        });
    }

    // 让 update() 的缓存键失效。
    // _currentCacheKey 记录的是「webview 当前展示的内容对应主编辑区的哪个位置(uri+版本+词范围)」，
    // update() 靠它跳过重复计算。但 webview 内部的跳转 / 定义列表选择 / 历史前进后退都会把展示内容
    // 换成别处，而主编辑区光标并没有动 —— 此时缓存键仍是旧 token 的键，与实际展示内容已经不符。
    // 用户再点主编辑区那个原 token（uri、文档版本、词范围都没变）就会命中同键判定被直接 return，
    // 表现为「点了没反应」。所以凡是在插件内单方面改过展示内容，都要把键置空，让下一次 update 必定重算。
    private invalidateCacheKey() {
        this._currentCacheKey = cacheKeyNone;
    }

    public showFloatingWebview() {
        if (this._currentPanel) {
            return;
            // 如果面板已经存在，直接显示, 但会导致进入preview模式
            //this._currentPanel.reveal(vscode.ViewColumn.Beside, true);
        } else {
            this.createFloatingWebview(vscode.ViewColumn.Beside);
            void this.lockPanelGroup(this._currentPanel);
        }
    }

    public async showFloatingWebviewIndependent(): Promise<void> {
        await showPanelInNewWindow(this._currentPanel, column => this.createFloatingWebview(column));
    }

    private postMessageToWebview(message: any) {
        this._view?.webview.postMessage(message);
        this._currentPanel?.webview.postMessage(message);
    }

    public async navigateCommand(
        uri: string,
        range: { start: { line: number; character: number }; end: { line: number; character: number } },
        token: string = '',
        recordTrail: boolean = true
    ) {
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

        const startLine = range.start.line - 1;
        const startChar = range.start.character - 1;
        let endLine = range.end.line - 1;
        let endChar = range.end.character - 1;
        // 点位置 range 是零宽，前端不会画符号高亮。有 token 时扩到该标识符。
        const tokenName = (token || '').trim();
        if (tokenName && startLine === endLine && startChar === endChar) {
            const ident = tokenName.replace(/\(.*\)$/, '').split(/::|\./).pop() || tokenName;
            endChar = startChar + ident.length;
        }

        const definition = new vscode.Location(
            targetUri,
            new vscode.Range(
                new vscode.Position(startLine, startChar),
                new vscode.Position(endLine, endChar)
            )
        );

        const contentInfo = await this._renderer.renderDefinition(languageId, definition);
        this._pickItems = undefined;
        this.postMessageToWebview({ type: 'clearDefinitionList' });
        // 先入历史再刷新内容，这样 updateContent 下发的跳转链已含本条。
        if (recordTrail) {
            this.addToHistory(contentInfo, range.start.line - 1, range.start.character - 1, token);
        }
        this.updateContent(contentInfo);
        this.currentUri = targetUri;
        this.currentLine = startLine;
        this.currentColumn = startChar;

        // 同 handleJumpDefinition：命令式跳转同样只改了展示内容，主编辑区光标没动，缓存键需失效
        this.invalidateCacheKey();
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
                case 'floatIndependent':
                    void this.showFloatingWebviewIndependent();
                    break;
                case 'revealInFileExplorer':
                    await this.handleRevealInFileExplorer(message);
                    break;
                case 'navigate':
                    if (typeof message.index === 'number') {
                        this.navigateTo(message.index);
                    } else {
                        this.navigate(message.direction);
                    }
                    break;
                case 'requestContent':
                    this.handleRequestContent(message);
                    break;
                case 'requestSemantic':
                    // 前端命中缓存直接渲染（不走 requestContent）但尚无 data时，主动来要一次。
                    this.handleRequestSemantic(message);
                    break;
                case 'requestGrammar':
                    this.handleRequestGrammar(message);
                    break;
                case 'jumpDefinition':
                    this.handleJumpDefinition(message, editor);
                    break;
                case 'requestHover':
                    this.handleRequestHover(message);
                    break;
                case 'requestLineBlame':
                    await this.handleRequestLineBlame(message);
                    break;
                case 'requestLineBlameDiff':
                    await this.handleRequestLineBlameDiff(message);
                    break;
                case 'setEnableHover':
                    await this.handleSetEnableHover(message);
                    break;
                case 'setStickyScroll':
                    await this.handleSetStickyScroll(message);
                    break;
                case 'setJumpTrail':
                    await this.handleSetJumpTrail(message);
                    break;
                case 'setJumpMode':
                    await this.handleSetJumpMode(message);
                    break;
                case 'setUpdateMode':
                    await this.handleSetUpdateMode(message);
                    break;
                case 'setLineBlame':
                    await this.handleSetLineBlame(message);
                    break;
                case 'openLineBlameChanges':
                    await this.handleOpenLineBlameChanges(message);
                    break;
                case 'toggleSelectBracketPair':
                    // 底部导航栏 {si} 指示器点击：切换「双击选中整对括号/引号」开关。
                    // 复用命令统一逻辑；配置变更会经 onDidChangeConfiguration 广播 updateContextEditorCfg 回推 webview 刷新指示器。
                    await vscode.commands.executeCommand('contextView.contextWindow.toggleSelectBracketPair');
                    break;
                case 'doubleClick':
                    await this.handleDoubleClick(message);
                    break;
                case 'selectEnclosingSymbol':
                    await this.handleSelectEnclosingSymbol(message);
                    break;
                case 'definitionItemSelected':
                    this.handleDefinitionItemSelected(message, editor);
                    break;
                case 'closeDefinitionList':
                    this.postMessageToWebview({ type: 'clearDefinitionList' });
                    break;
                case 'copyToClipboard':
                    // 粘附行(sticky scroll)区域的选中内容不占用 Monaco 的 model 选区，
                    // 故 Monaco 自带的复制命令拿不到它；而 webview 内的 navigator.clipboard
                    // 受焦点/权限限制经常静默失败，因此统一交给扩展端用 VSCode 官方 API 写入。
                    if (typeof message.text === 'string' && message.text.length > 0) {
                        await vscode.env.clipboard.writeText(message.text);
                        if (typeof message.notify === 'string' && message.notify) {
                            vscode.window.setStatusBarMessage(message.notify, 2000);
                        }
                    }
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
     * @param curColumn    1-based 当前列（-1 表示无，前端退回行尾）
     */
    private postMetadata(content: FileContentInfo, curLine: number, includeRange: boolean, target?: vscode.Webview, curColumn: number = -1) {
        const uri = content.jmpUri.toString();
        const currentVersion = content.documentVersion;
        const msg: any = {
            type: 'updateMetadata',
            contentHash: `${uri}:${currentVersion}`,
            uri,
            languageId: content.languageId,
            updateMode: this._updateMode,
            curLine,
            curColumn,
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
                // Monaco 主题规则要求颜色不含 '#'（与 themeColorResolver 下发的规则一致）；
                // 取色弹窗的 <input type=color> 返回 "#rrggbb"，这里统一去掉前导 '#' 再持久化，避免渲染时颜色被丢弃。
                patch.foreground = message.newStyle.foreground.trim().replace(/^#/, '');
            }
            if (message.newStyle) {
                // 始终按取色面板两个复选框「显式」写入 fontStyle（含都不勾时写空串 ""）。
                // 关键：空串 = 显式「无粗体/斜体」，会覆盖主题默认样式；若像旧逻辑那样「都不勾就不写」，
                // upsertRule 会删除 fontStyle 字段，token 便回退继承主题默认字体样式——如语义 token
                // method.declaration.async 会继承 *.declaration 默认的 bold，表现为「去掉 italic 后 bold 又冒出来」。
                // 显式写入后，复选框状态 === 存储 === 渲染，彻底消除样式泄漏与不一致。
                const parts: string[] = [];
                if (message.newStyle.bold) { parts.push('bold'); }
                if (message.newStyle.italic) { parts.push('italic'); }
                patch.fontStyle = parts.join(' ');
            }
            if (!token) {
                throw new Error('token is required');
            }

            const prev = this.getThemeRules();
            const next = this.upsertRule(prev, token, patch);
            await this.setThemeRules(next);

            // 立即把最新规则下发前端并重建主题，使保存的配色即时生效
            // （不依赖 onDidChangeConfiguration 的异步回调，避免延迟或丢失）
            const cfg = this._getVSCodeEditorConfiguration();
            this.postMessageToWebview({
                type: 'updateContextEditorCfg',
                contextEditorCfg: cfg.contextEditorCfg,
                customThemeRules: cfg.customThemeRules
            });
            this.postMessageToWebview({
                type: 'tokenStyle.set.result',
                ok: true,
                token,
            });
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
            this.postMetadata(curContext.content, curContext.navigateLine + 1, true, this._currentPanel.webview, curContext.navigateColumn + 1);
        }
        this.postMessageToWebview({
            type: 'pinState',
            pinned: this._pinned
        });
        this.postHistory();
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
            const hitUri = vscode.Uri.parse(this._lastContent.jmpUri.toString());
            const hitVersion = this._lastContent.documentVersion;
            this.postMessageToWebview({
                type: 'updateContent',
                contentHash: this._lastContentHash,
                body: this._lastContent.content,
                uri: this._lastContent.jmpUri.toString(),
                languageId: this._lastContent.languageId,
                updateMode: this._updateMode,
                range: this._lastContent.range,
                documentVersion: hitVersion,
                lineCount: this._lastContent.lineCount,
                // 对齐 VSCode：内容阶段带 legend（快、供首帧建 styling），不带 data（TextMate 先着色）
                semantic: null,
                legend: this._lastContent.legend ?? null
            });
            // 内容已下发，异步补 semantic data（带 debounce + 版本校验），取到后单独覆盖
            this.scheduleSemanticUpdate(hitUri, hitVersion);
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
                    lineCount: info.lineCount,
                    // 对齐 VSCode：内容阶段带 legend（快、供首帧建 styling），不带 data（TextMate 先着色）
                    semantic: null,
                    legend: info.legend ?? null
                    // 不回传 range/curLine：前端用 updateMetadata 阶段保存的定位信息
                });
                // 内容已下发，异步补 semantic data（带 debounce + 版本校验），取到后单独覆盖
                this.scheduleSemanticUpdate(reqUri, info.documentVersion);
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

    // 前端命中缓存直接渲染时（不经 requestContent），若本地无 data 则发此消息补取。
    // 复用 scheduleSemanticUpdate 的 debounce + 版本校验，取到后以 updateSemantic 单独下发。
    private handleRequestSemantic(message: any) {
        if (!message?.uri) {
            return;
        }
        try {
            const reqUri = vscode.Uri.parse(message.uri);
            const version = typeof message.documentVersion === 'number' ? message.documentVersion : 0;
            this.scheduleSemanticUpdate(reqUri, version);
        } catch {
            // uri 解析失败：静默忽略，前端保持 TextMate 着色
        }
    }

    // 自适应 debounce 延迟：对齐 VSCode的 min/max + 最近 N 次耗时滑动平均。
    private currentSemanticDelay(): number {
        if (this._semanticDelays.length === 0) {
            return ContextWindowProvider.SEMANTIC_MIN_DELAY;
        }
        const avg = this._semanticDelays.reduce((a, b) => a + b, 0) / this._semanticDelays.length;
        return Math.max(
            ContextWindowProvider.SEMANTIC_MIN_DELAY,
            Math.min(ContextWindowProvider.SEMANTIC_MAX_DELAY, avg)
        );
    }

    /**
     * 对齐 VSCode ModelSemanticColoring：内容渲染后，延迟(debounce)异步取整篇 semantic data 再单独下发。
     * - 每次调用取消上一轮定时器与请求（RunOnceScheduler 语义），避免快速跳转时请求堆积；
     * - 带 documentVersion 版本校验，等待期间文档若已变/切走则丢弃结果（对齐 getVersionId 过期丢弃）；
     * - 记录请求耗时更新滑动平均，驱动自适应 debounce。
     */
    private scheduleSemanticUpdate(uri: vscode.Uri, documentVersion: number) {
        // 取消上一轮（定时器 + 进行中的请求）
        if (this._semanticTimer) {
            clearTimeout(this._semanticTimer);
            this._semanticTimer = null;
        }
        this._semanticCts?.cancel();

        const delay = this.currentSemanticDelay();
        this._semanticTimer = setTimeout(async () => {
            this._semanticTimer = null;
            const cts = new vscode.CancellationTokenSource();
            this._semanticCts = cts;
            const start = Date.now();
            try {
                const semantic = await this._renderer.fetchSemanticForUri(uri);

                // 更新滑动平均（保留最近 6 次，与 VSCode SlidingWindowAverage(6) 一致）
                const elapsed = Date.now() - start;
                this._semanticDelays.push(elapsed);
                if (this._semanticDelays.length > 6) {
                    this._semanticDelays.shift();
                }

                if (cts.token.isCancellationRequested) {
                    return;
                }
                // 版本校验：等待期间文档可能被编辑或已切换到别的文件
                const nowVersion = await this._renderer.getDocumentVersion(uri);
                if (nowVersion !== documentVersion) {
                    return;
                }

                this.postMessageToWebview({
                    type: 'updateSemantic',
                    uri: uri.toString(),
                    documentVersion,
                    semantic: semantic ?? null
                });
            } catch {
                // 静默：取不到 semantic 时前端保持 TextMate 着色
            }
        }, delay);
    }

    // 用户点击的那一行的 git blame 摘要。查不到就回空，前端清掉装饰。
    private async handleRequestLineBlame(message: any) {
        const reqId = message?.reqId;
        const uri = String(message?.uri ?? '');
        const line = message?.line | 0;
        const empty = () => this.postMessageToWebview({ type: 'lineBlameResult', reqId, uri, line, text: '' });
        if (typeof reqId !== 'number' || !uri || line < 1) {
            empty();
            return;
        }
        try {
            const info = await blameLine(uri, line);
            this.postMessageToWebview({
                type: 'lineBlameResult',
                reqId,
                uri,
                line,
                text: info?.text || '',
                hover: info?.hover
            });
        } catch {
            empty();
        }
    }

    // 浮窗打开后再取当前行增删，点行尾摘要时不打 git diff。
    private async handleRequestLineBlameDiff(message: any) {
        const reqId = message?.reqId;
        const uri = String(message?.uri ?? '');
        const line = message?.line | 0;
        const empty = () => this.postMessageToWebview({ type: 'lineBlameDiffResult', reqId, uri, line, diff: [] });
        if (typeof reqId !== 'number' || !uri || line < 1) {
            empty();
            return;
        }
        try {
            const diff = await blameLineDiff(uri, line);
            this.postMessageToWebview({
                type: 'lineBlameDiffResult',
                reqId,
                uri,
                line,
                diff: diff || []
            });
        } catch {
            empty();
        }
    }

    // Webview hover：转发到主编辑区已就绪的 LSP（vscode.executeHoverProvider），
    // 把 markdown 内容回传给前端 hoverProvider，由其 resolve monaco.languages.Hover。
    // 使用 reqId 配对避免乱序串扰；拿到结果即可，超时由前端兜底 resolve(null)。
    private async handleRequestHover(message: any) {
        const reqId = message?.reqId;
        const empty = () => this.postMessageToWebview({ type: 'hoverResult', reqId, contents: [] });
        if (typeof reqId !== 'number' || !message?.uri || !message?.position) {
            empty();
            return;
        }
        try {
            const targetUri = vscode.Uri.parse(message.uri);
            const pos = new vscode.Position(
                Math.max(0, message.position.line | 0),
                Math.max(0, message.position.character | 0)
            );

            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                'vscode.executeHoverProvider',
                targetUri,
                pos
            );

            if (!hovers || !hovers.length) {
                empty();
                return;
            }

            // 把 (vscode.MarkdownString | { language, value } | string)[] 统一展平为 markdown 字符串数组
            const contents: string[] = [];
            let mergedRange: vscode.Range | undefined;
            for (const h of hovers) {
                if (!h) { continue; }
                if (h.range) {
                    mergedRange = mergedRange ? mergedRange.union(h.range) : h.range;
                }
                for (const c of (h.contents || [])) {
                    if (typeof c === 'string') {
                        if (c.trim()) { contents.push(c); }
                    } else if (c && typeof (c as vscode.MarkdownString).value === 'string') {
                        const v = (c as vscode.MarkdownString).value;
                        if (v.trim()) { contents.push(v); }
                    } else if (c && typeof (c as { language?: string; value?: string }).value === 'string') {
                        // { language, value } 形式：包成代码块
                        const cb = c as { language?: string; value?: string };
                        const lang = cb.language || '';
                        contents.push('```' + lang + '\n' + (cb.value ?? '') + '\n```');
                    }
                }
            }

            const range = mergedRange ? {
                // Monaco 1-based
                startLine: mergedRange.start.line + 1,
                startCol: mergedRange.start.character + 1,
                endLine: mergedRange.end.line + 1,
                endCol: mergedRange.end.character + 1
            } : undefined;

            this.postMessageToWebview({ type: 'hoverResult', reqId, contents, range });
        } catch (e) {
            empty();
        }
    }

    // 持久化 Hover Tips 开关：右键菜单切换时由 webview 发来，此处写入用户全局配置；
    // 写入后 onDidChangeConfiguration 回调会自动通过 updateContextEditorCfg 把最新值广播回 webview。
    private async handleSetEnableHover(message: any) {
        try {
            const value = !!message?.value;
            const cfg = vscode.workspace.getConfiguration('contextView.contextWindow');
            await cfg.update('enableHover', value, true);
        } catch (err) {
            console.error('[context-window] setEnableHover failed:', err);
        }
    }

    // 方案 B：webview 按 scopeName 请求语法文件原始内容，这里读文件并回包。
    private handleRequestGrammar(message: any) {
        const scopeName = String(message?.scopeName ?? '');
        if (!scopeName) {
            this.postMessageToWebview({ type: 'grammarData', scopeName, found: false });
            return;
        }
        try {
            const src = getGrammarContent(scopeName);
            if (src) {
                this.postMessageToWebview({
                    type: 'grammarData',
                    scopeName,
                    found: true,
                    content: src.content,
                    path: src.path
                });
            } else {
                this.postMessageToWebview({ type: 'grammarData', scopeName, found: false });
            }
        } catch (err) {
            this.postMessageToWebview({ type: 'grammarData', scopeName, found: false, error: String(err) });
        }
    }

    // 点击符号：查找定义并渲染
    private handleJumpDefinition(message: any, editor: vscode.TextEditor | undefined) {
        if (!editor || !(message.uri?.length > 0)) {
            return;
        }

        const updatePromise = (async () => {
            const position = new vscode.Position(message.position.line, message.position.character);
            const definitions = await this.getDefinitionsAt(vscode.Uri.parse(message.uri), position);

            if (definitions && definitions.length > 0) {
                // 主动隐藏定义列表（在处理新的跳转前）
                if (definitions.length === 1) {
                    this.postMessageToWebview({ type: 'clearDefinitionList' });
                }

                let definition = definitions[0];

                // 如果有多个定义，传递给 Monaco Editor
                if (definitions.length > 1) {
                    definition = await this.showDefinitionPicker(definitions, editor, position);
                }

                const contentInfo = await this._renderer.renderDefinition(editor.document.languageId, definition);
                // message.position 是「离开当前段时点击的行/列」，行列一起记，返回时才能落回该 token。
                // message.token 是用户点的词，即这一跳的目的地名字。
                this.addToHistory(contentInfo, message.position.line, message.position.character, message.token);
                this.updateContent(contentInfo);
            } else {
                this.postMessageToWebview({
                    type: 'noSymbolFound',
                    pos: message.position,
                    token: message.token
                });
            }

            // 插件内跳转后（无论跳成功还是显示 No symbol found），展示内容已与主编辑区光标位置脱钩，
            // 缓存键必须失效，否则回到 VSCode 再点原来那个 token 会因同键判定而无响应
            this.invalidateCacheKey();
        })();

        this.withProgress<void>(() => updatePromise);
    }

    // 双击底部区域：在主编辑区打开当前上下文文件并跳转
    private async handleDoubleClick(message: any) {
        if (message.location !== 'bottomArea') {
            return;
        }

        const shown = this._lastContent ?? this.getCurrentContent()?.content;
        if (!shown?.jmpUri) {
            return;
        }

        this.currentUri = vscode.Uri.parse(shown.jmpUri.toString());
        this.currentLine = shown.range?.start.line ?? 0;
        this.currentColumn = shown.range?.start.character ?? 0;
        if (!this.currentUri) {
            return;
        }

        const document = await vscode.workspace.openTextDocument(this.currentUri);
        const line = this.currentLine;
        const character = Math.max(0, this.currentColumn);
        const range = new vscode.Range(line, character, line, character);
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

    // Context Window 行号栏双击：查出当前行所属的最小函数/类/命名空间，把 range 回给 webview 设选区。
    private async handleSelectEnclosingSymbol(message: any) {
        const reqId = message.reqId;
        const reply = (range?: vscode.Range) => {
            this.postMessageToWebview({
                type: 'selectEnclosingSymbol.result',
                reqId,
                range: range ? {
                    startLineNumber: range.start.line + 1,
                    startColumn: range.start.character + 1,
                    endLineNumber: range.end.line + 1,
                    endColumn: range.end.character + 1
                } : null
            });
        };

        const uriStr = typeof message.uri === 'string' ? message.uri : '';
        const line = message.line;
        if (!uriStr || typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
            reply();
            return;
        }

        try {
            const range = await enclosingSymbolRange(vscode.Uri.parse(uriStr), line);
            reply(range);
        } catch (err) {
            console.error('[context-window] selectEnclosingSymbol failed:', err);
            reply();
        }
    }

    // 定义列表项被选中：渲染对应定义
    private handleDefinitionItemSelected(message: any, editor: vscode.TextEditor | undefined) {
        if (!this._pickItems || message.index === undefined) {
            return;
        }
        const selected = this._pickItems[message.index];
        if (!selected) {
            return;
        }

        const updatePromise = (async () => {
            try {
                const contentInfo = await this._renderer.renderDefinition(
                    editor?.document.languageId || 'plaintext',
                    selected.definition
                );

                // 先改当前槽再 updateContent，跳转链名字与展示内容一致。
                if (this._history.length > this._historyIndex) {
                    this._history[this._historyIndex].content = contentInfo;
                    this._history[this._historyIndex].symbolName = nameFromContent(contentInfo);
                }

                this.updateContent(contentInfo);

                // 同 handleJumpDefinition：从多定义列表里选了另一条，展示内容已与主编辑区光标脱钩
                this.invalidateCacheKey();
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

    private createFloatingWebview(column: vscode.ViewColumn): vscode.WebviewPanel {
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
            column,
            {
                enableScripts: true,
                enableForms: true,
                retainContextWhenHidden: true
            }
        );

        this.resetWebviewPanel(this._currentPanel);

        this._currentPanel.webview.postMessage({
            type: 'pinState',
            pinned: this._pinned
        });
        return this._currentPanel;
    }

    private async lockPanelGroup(panel: vscode.WebviewPanel | undefined): Promise<void> {
        if (!panel) {
            return;
        }
        panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, false);
        const groups = (vscode.window as unknown as {
            tabGroups?: { all: { viewColumn?: vscode.ViewColumn; isLocked: boolean }[] };
        }).tabGroups;
        const column = panel.viewColumn;
        const group = groups?.all.find(g => g.viewColumn === column);
        if (group?.isLocked) {
            return;
        }
        try {
            await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
        } catch {
            // Older VS Code builds may not have editor-group lock.
        }
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
                vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'monaco-editor'), // 添加 Monaco Editor 资源路径
                // 方案 B：oniguruma WASM 所在目录
                vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'vscode-oniguruma')
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
                    this.postMetadata(curContext.content, curContext.navigateLine + 1, true, this._view.webview, curContext.navigateColumn + 1);
                }
                this.postHistory();
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
            this.postMetadata(curContext.content, curContext.navigateLine + 1, true, this._view.webview, curContext.navigateColumn + 1);
        }

        this._view.webview.postMessage({
            type: 'pinState',
            pinned: this._pinned
        });
        this.postHistory();
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

        // 方案 B：oniguruma WASM 资源 URI + 语法/注入映射（启用时才下发，避免无谓收割与体积）
        const textmateEnabled = this._isTextmateEnabled();
        const wasmUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')
        ).toString();
        const grammarMaps = textmateEnabled ? getGrammarMaps() : { languageToScope: {}, injections: {} };
        const textmateConfig = {
            enabled: textmateEnabled,
            wasmUri,
            languageToScope: grammarMaps.languageToScope,
            injections: grammarMaps.injections
        };

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
                script-src 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval' ${webview.cspSource};
                worker-src ${webview.cspSource} blob:;
                child-src ${webview.cspSource} blob:;
                connect-src ${webview.cspSource};
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
            <div id="jump-trail" class="jump-trail" hidden></div>
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

                // 方案 B：真实 TextMate 语法接入所需的配置（WASM 资源 URI + 语言/注入映射）
                try {
                    window.ctxTextmate = ${JSON.stringify(textmateConfig)};
                } catch (error) {
                    console.error('[context-window] Failed to parse textmate config:', error);
                    window.ctxTextmate = { enabled: false };
                }
                
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
                <div class="nav-mode-cluster">
                    <div class="update-mode" id="update-mode" title="Update mode: Live">
                        <span class="nav-mode-icon" id="update-mode-icon"></span>
                        <span class="update-mode-label" id="update-mode-label">Live</span>
                    </div>
                    <!-- 跳转模式：停在底栏右侧、{ } 左侧。点击上拉选择。 -->
                    <div class="jump-mode" id="jump-mode" title="Jump mode: Go to Definition">
                        <span class="nav-mode-icon" id="jump-mode-icon"></span>
                        <span class="jump-mode-label" id="jump-mode-label">Definition</span>
                    </div>
                    <!-- 开关指示器：本会话曾开启过才显示，标识「双击选中整对括号/引号（含定界符）」是否开启，点击可切换 -->
                    <div class="si-indicator" id="si-indicator" title="Double-click selects the whole bracket/quote pair (including delimiters)">{ }</div>
                </div>
            </div>

            <script nonce="${nonce}" src="${navigationScriptUri}">
                // 导航按钮事件处理
            </script>
        </body>
        </html>`;
    }

    private async updateContent(contentInfo?: FileContentInfo, curLine: number =-1, curColumn: number =-1) {
        if (contentInfo && contentInfo.content.length && contentInfo.jmpUri) {
            // 只缓存最近一次的内容（供前端请求使用）
            this._lastContentHash = `${contentInfo.jmpUri.toString()}:${contentInfo.documentVersion}`;
            this._lastContent = contentInfo;

            // 先发送元数据（不包含 body），body 由前端按需 requestContent 拉取
            // 历史里是 0-based，消息里统一转成 Monaco 的 1-based
            this.postMetadata(contentInfo, (curLine !== -1) ? curLine + 1 : -1, true, undefined, (curColumn >= 0) ? curColumn + 1 : -1);

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
            this.postHistory();
        } else {
            this.postMessageToWebview({
                type: 'noContent',
                body: '&nbsp;&nbsp;No symbol found.',
                updateMode: this._updateMode,
            });
            this.postHistory();
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

        // 上一次 showDefinitionPicker 缓存的多定义条目（含 vscode.Location 引用）可能滞留；
        // 在新一轮 update 起始处清空，避免随 provider 实例长期持有不再用到的对象。
        // showDefinitionPicker 命中多定义分支时会立即重新赋值；单定义分支天然无需保留。
        this._pickItems = undefined;

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
                this.currentColumn = contentInfo.range.start.character;
            }
            
            if (this._updateMode === UpdateMode.Live || contentInfo.jmpUri) {
                this._currentCacheKey = newCacheKey;
                
                this._history = [];
                // 这一条没有「点击离开」的历史，落点就用定义名自身的起始位置
                this._history.push({
                    content: contentInfo,
                    navigateLine: this.currentLine,
                    navigateColumn: this.currentColumn,
                    symbolName: nameFromContent(contentInfo)
                });
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

    // 统一的跳转解析入口：主编辑区跟踪与面板内点击都走当前 jumpMode。
    private async getDefinitionsAt(uri: vscode.Uri, position: vscode.Position) {
        return await this.executeJumpProvider(JUMP_PROVIDER_COMMAND[this.getJumpMode()], uri, position);
    }

    private getJumpMode(): JumpMode {
        const cfg = vscode.workspace.getConfiguration('contextView.contextWindow');
        return normalizeJumpMode(cfg.get('jumpMode', 'definition'));
    }

    private async executeJumpProvider(command: string, uri: vscode.Uri, position: vscode.Position): Promise<any[]> {
        try {
            const result = await vscode.commands.executeCommand<any[]>(command, uri, position);
            return Array.isArray(result) ? result : [];
        } catch (err) {
            console.error('[context-window] jump provider failed:', command, err);
            return [];
        }
    }

    private async getDefinitionAtCurrentPositionInEditor(editor: vscode.TextEditor) {
        return await this.getDefinitionsAt(editor.document.uri, editor.selection.active);
    }

    private updateConfiguration() {
        const config = vscode.workspace.getConfiguration('contextView');
        this._updateMode = config.get<UpdateMode>('contextWindow.updateMode') === UpdateMode.Sticky
            ? UpdateMode.Sticky
            : UpdateMode.Live;
    }

    private async showDefinitionPicker(definitions: any[], editor: vscode.TextEditor, currentPosition?: vscode.Position): Promise<any> {
        // 准备定义列表数据并发送到webview
        try {
            const definitionListData = definitions.map((definition, index) => {
                try {
                    const def = definition;
                    const uri = (def instanceof vscode.Location) ? def.uri : def.targetUri;
                    const range = (def instanceof vscode.Location) ? def.range : (def.targetSelectionRange ?? def.targetRange);
            
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
            
            // 只有在多个结果时才发送列表到 webview（面板 + 浮动窗都走 postMessageToWebview）
            if (validDefinitions.length > 1) {
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

function normalizeJumpMode(value: unknown): JumpMode {
    return (typeof value === 'string' && (JUMP_MODES as readonly string[]).includes(value))
        ? value as JumpMode
        : 'definition';
}

function basenameFromUri(uri?: string): string {
    if (!uri) {
        return '';
    }
    let path = uri;
    try {
        path = decodeURIComponent(uri);
    } catch {
        path = uri;
    }
    return path.split('/').pop()?.split('\\').pop() || '';
}

// 从定义 range 截出标识符，供跳转链显示。range 通常是 targetSelectionRange（名字本身）。
function nameFromContent(info: FileContentInfo | undefined): string {
    if (!info || !info.content) {
        return '';
    }
    const lines = info.content.split(/\r?\n/);
    const sl = info.range?.start?.line ?? 0;
    const sc = info.range?.start?.character ?? 0;
    const el = info.range?.end?.line ?? sl;
    const ec = info.range?.end?.character ?? sc;
    if (sl < 0 || sl >= lines.length) {
        return '';
    }
    let raw = sl === el
        ? lines[sl].slice(sc, ec)
        : lines[sl].slice(sc);
    raw = raw.trim();
    if (!raw) {
        const rest = lines[sl].slice(sc);
        const m = rest.match(/[A-Za-z_]\w*/);
        raw = m ? m[0] : '';
    }
    const cut = raw.search(/[<(]/);
    const short = cut > 0 ? raw.slice(0, cut) : (raw.split(/\s+/)[0] || raw);
    return short.length > 40 ? short.slice(0, 40) + '…' : short;
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

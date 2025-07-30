import * as vscode from 'vscode';
import { Renderer, FileContentInfo } from './renderer';
import * as path from 'path';

enum UpdateMode {
    Live = 'live',
    Sticky = 'sticky',
}
const maxHistorySize = 50;

interface HistoryInfo {
    content: FileContentInfo | undefined;
    curLine: number;
}

interface TokenColorSetting {
    foreground?: string;
    background?: string;
    fontStyle?: string;
}

interface SemanticTokenColorCustomizations {
    rules?: { [scope: string]: string | TokenColorSetting };
    enabled?: boolean;
}

interface TokenColorCustomizations {
    [scope: string]: string | TokenColorSetting;
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
                this.updateConfiguration();
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

        const contextWindowConfig = vscode.workspace.getConfiguration('contextView.contextWindow');
        if (!contextWindowConfig.get('useDefaultTheme', true))
            return 'vs';
        
        switch (theme.kind) {
            case vscode.ColorThemeKind.Dark:
                return 'vs-dark';
            case vscode.ColorThemeKind.HighContrast:
                return 'hc-black';
            default:
                return 'vs';
        }
    }

    // 获取默认的Monaco token规则（基于VSCode默认主题）
private _getDefaultMonacoTokenRules(isLight: boolean): any[] {
    if (isLight) {
        // 浅色主题的默认token配色（基于VSCode Light主题）
        return [
            // 关键字类
            { token: 'keyword', foreground: '0000FF' },                    // 关键字：蓝色
            { token: 'keyword.type', foreground: '0000FF' },               // 类型关键字：蓝色
            { token: 'keyword.control', foreground: 'AF00DB' },            // 控制流：紫色
            { token: 'keyword.operator', foreground: '000000' },           // 操作符关键字：黑色
            { token: 'keyword.other', foreground: '0000FF' },              // 其他关键字：蓝色
            { token: 'keyword.declaration', foreground: '0000FF' },        // 声明关键字：蓝色
            { token: 'keyword.modifier', foreground: '0000FF' },           // 修饰符：蓝色
            { token: 'keyword.conditional', foreground: 'AF00DB' },        // 条件关键字：紫色
            { token: 'keyword.repeat', foreground: 'AF00DB' },             // 循环关键字：紫色
            { token: 'keyword.exception', foreground: 'AF00DB' },          // 异常关键字：紫色
            { token: 'keyword.function', foreground: 'AF00DB' },           // 函数关键字：紫色
            { token: 'keyword.directive', foreground: '0000FF' },          // 预处理指令：蓝色
            { token: 'keyword.directive.control', foreground: 'AF00DB' },  // 预处理控制：紫色
            
            // 字符串类
            { token: 'string', foreground: 'A31515' },                     // 字符串：红色
            { token: 'string.quoted', foreground: 'A31515' },              // 引号字符串：红色
            { token: 'string.quoted.single', foreground: 'A31515' },       // 单引号字符串：红色
            { token: 'string.quoted.double', foreground: 'A31515' },       // 双引号字符串：红色
            { token: 'string.template', foreground: 'A31515' },            // 模板字符串：红色
            { token: 'string.escape', foreground: 'FF0000' },              // 转义字符：亮红色
            
            // 注释类
            { token: 'comment', foreground: '008000' },                    // 注释：绿色
            { token: 'comment.line', foreground: '008000' },               // 行注释：绿色
            { token: 'comment.block', foreground: '008000' },              // 块注释：绿色
            { token: 'comment.doc', foreground: '008000' },                // 文档注释：绿色
            { token: 'comment.documentation', foreground: '008000' },      // 文档注释：绿色
            
            // 数字和常量类
            { token: 'number', foreground: '098658' },                     // 数字：深绿色
            { token: 'constant.numeric', foreground: '098658' },           // 数字常量：深绿色
            { token: 'constant.language', foreground: '0000FF' },          // 语言常量：蓝色
            { token: 'constant.other', foreground: '0070C1' },             // 其他常量：深蓝色
            { token: 'constant', foreground: '0070C1' },                   // 常量：深蓝色
            { token: 'boolean', foreground: '0000FF' },                    // 布尔值：蓝色
            { token: 'null', foreground: '0000FF' },                       // null：蓝色
            
            // 函数和方法类
            { token: 'function', foreground: '795E26' },                   // 函数：棕色
            { token: 'function.name', foreground: '795E26' },              // 函数名：棕色
            { token: 'function.call', foreground: '795E26' },              // 函数调用：棕色
            { token: 'method', foreground: '795E26' },                     // 方法：棕色
            { token: 'method.name', foreground: '795E26' },                // 方法名：棕色
            { token: 'method.call', foreground: '795E26' },                // 方法调用：棕色
            { token: 'constructor', foreground: '795E26' },                // 构造函数：棕色
            
            // 变量和标识符类
            { token: 'variable', foreground: '001080' },                   // 变量：深蓝色
            { token: 'variable.name', foreground: '001080' },              // 变量名：深蓝色
            { token: 'variable.other', foreground: '001080' },             // 其他变量：深蓝色
            { token: 'variable.parameter', foreground: '001080' },         // 参数变量：深蓝色
            { token: 'variable.language', foreground: 'AF00DB' },          // 语言变量：紫色
            { token: 'variable.predefined', foreground: 'AF00DB' },        // 预定义变量：紫色
            { token: 'identifier', foreground: '000000' },                 // 标识符：黑色
            
            // 类型和类
            { token: 'type', foreground: '267F99' },                       // 类型：青色
            { token: 'type.declaration', foreground: '267F99' },           // 类型声明：青色
            { token: 'class', foreground: '267F99' },                      // 类：青色
            { token: 'class.name', foreground: '267F99' },                 // 类名：青色
            { token: 'interface', foreground: '267F99' },                  // 接口：青色
            { token: 'enum', foreground: '267F99' },                       // 枚举：青色
            { token: 'struct', foreground: '267F99' },                     // 结构体：青色
            { token: 'namespace', foreground: '267F99' },                  // 命名空间：青色
            
            // 属性和成员类
            { token: 'property', foreground: '001080' },                   // 属性：深蓝色
            { token: 'property.declaration', foreground: '001080' },       // 属性声明：深蓝色
            { token: 'member', foreground: '001080' },                     // 成员：深蓝色
            { token: 'field', foreground: '001080' },                      // 字段：深蓝色
            
            // 操作符和分隔符类
            { token: 'operator', foreground: '000000' },                   // 运算符：黑色
            { token: 'delimiter', foreground: '000000' },                  // 分隔符：黑色
            { token: 'delimiter.bracket', foreground: '000000' },          // 括号：黑色
            { token: 'delimiter.parenthesis', foreground: '000000' },      // 圆括号：黑色
            { token: 'delimiter.square', foreground: '000000' },           // 方括号：黑色
            { token: 'delimiter.curly', foreground: '000000' },            // 花括号：黑色
            
            // 标签和属性类
            { token: 'tag', foreground: '800000' },                        // 标签：暗红色
            { token: 'tag.attribute.name', foreground: 'FF0000' },         // 标签属性名：红色
            { token: 'attribute.name', foreground: 'FF0000' },             // 属性名：红色
            { token: 'attribute.value', foreground: '0000FF' },            // 属性值：蓝色
            
            // 特殊类型
            { token: 'decorator', foreground: '800080' },                  // 装饰器：紫色
            { token: 'macro', foreground: 'A00000', fontStyle: 'italic' }, // 宏：暗红色斜体
            { token: 'regexp', foreground: '811F3F' },                     // 正则表达式：暗红色
            { token: 'modifier', foreground: '0000FF' },                   // 修饰符：蓝色
        ];
    } else {
        // 深色主题的默认token配色（基于VSCode Dark主题）
        return [
            // 关键字类
            { token: 'keyword', foreground: '569CD6' },                    // 关键字：浅蓝色
            { token: 'keyword.type', foreground: '569CD6' },               // 类型关键字：浅蓝色
            { token: 'keyword.control', foreground: 'C586C0' },            // 控制流：粉紫色
            { token: 'keyword.operator', foreground: 'D4D4D4' },           // 操作符关键字：灰色
            { token: 'keyword.other', foreground: '569CD6' },              // 其他关键字：浅蓝色
            { token: 'keyword.declaration', foreground: '569CD6' },        // 声明关键字：浅蓝色
            { token: 'keyword.modifier', foreground: '569CD6' },           // 修饰符：浅蓝色
            { token: 'keyword.conditional', foreground: 'C586C0' },        // 条件关键字：粉紫色
            { token: 'keyword.repeat', foreground: 'C586C0' },             // 循环关键字：粉紫色
            { token: 'keyword.exception', foreground: 'C586C0' },          // 异常关键字：粉紫色
            { token: 'keyword.function', foreground: 'C586C0' },           // 函数关键字：粉紫色
            { token: 'keyword.directive', foreground: '569CD6' },          // 预处理指令：浅蓝色
            { token: 'keyword.directive.control', foreground: 'C586C0' },  // 预处理控制：粉紫色
            
            // 字符串类
            { token: 'string', foreground: 'CE9178' },                     // 字符串：橙色
            { token: 'string.quoted', foreground: 'CE9178' },              // 引号字符串：橙色
            { token: 'string.quoted.single', foreground: 'CE9178' },       // 单引号字符串：橙色
            { token: 'string.quoted.double', foreground: 'CE9178' },       // 双引号字符串：橙色
            { token: 'string.template', foreground: 'CE9178' },            // 模板字符串：橙色
            { token: 'string.escape', foreground: 'D7BA7D' },              // 转义字符：金色
            
            // 注释类
            { token: 'comment', foreground: '6A9955' },                    // 注释：绿色
            { token: 'comment.line', foreground: '6A9955' },               // 行注释：绿色
            { token: 'comment.block', foreground: '6A9955' },              // 块注释：绿色
            { token: 'comment.doc', foreground: '6A9955' },                // 文档注释：绿色
            { token: 'comment.documentation', foreground: '6A9955' },      // 文档注释：绿色
            
            // 数字和常量类
            { token: 'number', foreground: 'B5CEA8' },                     // 数字：浅绿色
            { token: 'constant.numeric', foreground: 'B5CEA8' },           // 数字常量：浅绿色
            { token: 'constant.language', foreground: '569CD6' },          // 语言常量：浅蓝色
            { token: 'constant.other', foreground: '4FC1FF' },             // 其他常量：亮蓝色
            { token: 'constant', foreground: '4FC1FF' },                   // 常量：亮蓝色
            { token: 'boolean', foreground: '569CD6' },                    // 布尔值：浅蓝色
            { token: 'null', foreground: '569CD6' },                       // null：浅蓝色
            
            // 函数和方法类
            { token: 'function', foreground: 'DCDCAA' },                   // 函数：黄色
            { token: 'function.name', foreground: 'DCDCAA' },              // 函数名：黄色
            { token: 'function.call', foreground: 'DCDCAA' },              // 函数调用：黄色
            { token: 'method', foreground: 'DCDCAA' },                     // 方法：黄色
            { token: 'method.name', foreground: 'DCDCAA' },                // 方法名：黄色
            { token: 'method.call', foreground: 'DCDCAA' },                // 方法调用：黄色
            { token: 'constructor', foreground: 'DCDCAA' },                // 构造函数：黄色
            
            // 变量和标识符类
            { token: 'variable', foreground: '9CDCFE' },                   // 变量：浅青色
            { token: 'variable.name', foreground: '9CDCFE' },              // 变量名：浅青色
            { token: 'variable.other', foreground: '9CDCFE' },             // 其他变量：浅青色
            { token: 'variable.parameter', foreground: '9CDCFE' },         // 参数变量：浅青色
            { token: 'variable.language', foreground: 'C586C0' },          // 语言变量：粉紫色
            { token: 'variable.predefined', foreground: 'C586C0' },        // 预定义变量：粉紫色
            { token: 'identifier', foreground: 'D4D4D4' },                 // 标识符：灰色
            
            // 类型和类
            { token: 'type', foreground: '4EC9B0' },                       // 类型：青绿色
            { token: 'type.declaration', foreground: '4EC9B0' },           // 类型声明：青绿色
            { token: 'class', foreground: '4EC9B0' },                      // 类：青绿色
            { token: 'class.name', foreground: '4EC9B0' },                 // 类名：青绿色
            { token: 'interface', foreground: '4EC9B0' },                  // 接口：青绿色
            { token: 'enum', foreground: '4EC9B0' },                       // 枚举：青绿色
            { token: 'struct', foreground: '4EC9B0' },                     // 结构体：青绿色
            { token: 'namespace', foreground: '4EC9B0' },                  // 命名空间：青绿色
            
            // 属性和成员类
            { token: 'property', foreground: '9CDCFE' },                   // 属性：浅青色
            { token: 'property.declaration', foreground: '9CDCFE' },       // 属性声明：浅青色
            { token: 'member', foreground: '9CDCFE' },                     // 成员：浅青色
            { token: 'field', foreground: '9CDCFE' },                      // 字段：浅青色
            
            // 操作符和分隔符类
            { token: 'operator', foreground: 'D4D4D4' },                   // 运算符：灰色
            { token: 'delimiter', foreground: 'D4D4D4' },                  // 分隔符：灰色
            { token: 'delimiter.bracket', foreground: 'D4D4D4' },          // 括号：灰色
            { token: 'delimiter.parenthesis', foreground: 'D4D4D4' },      // 圆括号：灰色
            { token: 'delimiter.square', foreground: 'D4D4D4' },           // 方括号：灰色
            { token: 'delimiter.curly', foreground: 'D4D4D4' },            // 花括号：灰色
            
            // 标签和属性类
            { token: 'tag', foreground: '92C5F7' },                        // 标签：浅蓝色
            { token: 'tag.attribute.name', foreground: '9CDCFE' },         // 标签属性名：浅青色
            { token: 'attribute.name', foreground: '9CDCFE' },             // 属性名：浅青色
            { token: 'attribute.value', foreground: 'CE9178' },            // 属性值：橙色
            
            // 特殊类型
            { token: 'decorator', foreground: 'C586C0' },                  // 装饰器：粉紫色
            { token: 'macro', foreground: 'DCDCAA', fontStyle: 'italic' }, // 宏：黄色斜体
            { token: 'regexp', foreground: 'D16969' },                     // 正则表达式：红色
            { token: 'modifier', foreground: '569CD6' },                   // 修饰符：浅蓝色
        ];
    }
}

// 获取VSCode主题CSS变量映射
private _getVSCodeThemeVariables(): any {
    return {
        // 编辑器基础颜色
        'editor.background': '--vscode-editor-background',
        'editor.foreground': '--vscode-editor-foreground',
        'editorLineNumber.foreground': '--vscode-editorLineNumber-foreground',
        'editorLineNumber.activeForeground': '--vscode-editorLineNumber-activeForeground',
        'editorCursor.foreground': '--vscode-editorCursor-foreground',
        
        // 选择和高亮相关
        'editor.selectionBackground': '--vscode-editor-selectionBackground',
        'editor.inactiveSelectionBackground': '--vscode-editor-inactiveSelectionBackground',
        'editor.selectionHighlightBackground': '--vscode-editor-selectionHighlightBackground',
        'editor.selectionHighlightBorder': '--vscode-editor-selectionHighlightBorder',
        'editor.wordHighlightBackground': '--vscode-editor-wordHighlightBackground',
        'editor.wordHighlightStrongBackground': '--vscode-editor-wordHighlightStrongBackground',
        'editor.wordHighlightBorder': '--vscode-editor-wordHighlightBorder',
        'editor.wordHighlightStrongBorder': '--vscode-editor-wordHighlightStrongBorder',
        
        // 查找相关
        'editor.findMatchBackground': '--vscode-editor-findMatchBackground',
        'editor.findMatchBorder': '--vscode-editor-findMatchBorder',
        'editor.findMatchHighlightBackground': '--vscode-editor-findMatchHighlightBackground',
        'editor.findMatchHighlightBorder': '--vscode-editor-findMatchHighlightBorder',
        'editor.findRangeHighlightBackground': '--vscode-editor-findRangeHighlightBackground',
        'editor.findRangeHighlightBorder': '--vscode-editor-findRangeHighlightBorder',
        
        // 行高亮
        'editor.lineHighlightBackground': '--vscode-editor-lineHighlightBackground',
        'editor.lineHighlightBorder': '--vscode-editor-lineHighlightBorder',
        
        // 滚动条
        'scrollbarSlider.background': '--vscode-scrollbarSlider-background',
        'scrollbarSlider.hoverBackground': '--vscode-scrollbarSlider-hoverBackground',
        'scrollbarSlider.activeBackground': '--vscode-scrollbarSlider-activeBackground',
        
        // 编辑器装订线
        'editorGutter.background': '--vscode-editorGutter-background',
        'editorGutter.modifiedBackground': '--vscode-editorGutter-modifiedBackground',
        'editorGutter.addedBackground': '--vscode-editorGutter-addedBackground',
        'editorGutter.deletedBackground': '--vscode-editorGutter-deletedBackground',
        
        // 代码折叠
        'editorGutter.foldingControlForeground': '--vscode-editorGutter-foldingControlForeground',
        
        // 缩进参考线
        'editorIndentGuide.background': '--vscode-editorIndentGuide-background',
        'editorIndentGuide.activeBackground': '--vscode-editorIndentGuide-activeBackground',
        
        // 其他编辑器颜色
        'editor.hoverHighlightBackground': '--vscode-editor-hoverHighlightBackground',
        'editor.rangeHighlightBackground': '--vscode-editor-rangeHighlightBackground',
        'editor.symbolHighlightBackground': '--vscode-editor-symbolHighlightBackground',
        'editorLink.activeForeground': '--vscode-editorLink-activeForeground',
        
        // 错误和警告
        'editorError.foreground': '--vscode-editorError-foreground',
        'editorError.border': '--vscode-editorError-border',
        'editorWarning.foreground': '--vscode-editorWarning-foreground',
        'editorWarning.border': '--vscode-editorWarning-border',
        'editorInfo.foreground': '--vscode-editorInfo-foreground',
        'editorInfo.border': '--vscode-editorInfo-border',
        'editorHint.foreground': '--vscode-editorHint-foreground',
        'editorHint.border': '--vscode-editorHint-border',
        
        // 编辑器建议（自动完成）
        'editorSuggestWidget.background': '--vscode-editorSuggestWidget-background',
        'editorSuggestWidget.border': '--vscode-editorSuggestWidget-border',
        'editorSuggestWidget.foreground': '--vscode-editorSuggestWidget-foreground',
        'editorSuggestWidget.selectedBackground': '--vscode-editorSuggestWidget-selectedBackground',
        'editorSuggestWidget.highlightForeground': '--vscode-editorSuggestWidget-highlightForeground',
        
        // 编辑器悬停
        'editorHoverWidget.background': '--vscode-editorHoverWidget-background',
        'editorHoverWidget.border': '--vscode-editorHoverWidget-border',
        'editorHoverWidget.foreground': '--vscode-editorHoverWidget-foreground',
        
        // 编辑器状态栏
        'editorHoverWidget.statusBarBackground': '--vscode-editorHoverWidget-statusBarBackground'
    };
}

// 转换VSCode的tokenColorCustomizations到Monaco格式
private _convertVSCodeTokensToMonaco(tokenCustomizations: any): any[] {
    const rules: any[] = [];
    
    console.log('[definition] Converting VSCode token customizations...', tokenCustomizations);
    
    for (const [scope, setting] of Object.entries(tokenCustomizations)) {
        if (typeof setting === 'string') {
            // 简单颜色字符串格式: "scope": "#FF0000"
            const monacoTokens = this._mapVSCodeScopeToMonacoToken(scope);
            if (monacoTokens && monacoTokens.length > 0) {
                monacoTokens.forEach(token => {
                    rules.push({
                        token: token,
                        foreground: setting.replace('#', '').toUpperCase()
                    });
                    console.log(`[definition] Token rule: ${scope} -> ${token} (${setting})`);
                });
            }
        } else if (typeof setting === 'object' && setting) {
            // 复杂设置对象格式: "scope": { "foreground": "#FF0000", "fontStyle": "bold" }
            const settingObj = setting as any;
            const monacoTokens = this._mapVSCodeScopeToMonacoToken(scope);
            
            if (monacoTokens && monacoTokens.length > 0 && settingObj.foreground) {
                monacoTokens.forEach(token => {
                    const rule: any = {
                        token: token,
                        foreground: settingObj.foreground.replace('#', '').toUpperCase()
                    };
                    
                    // 添加背景色（如果有）
                    if (settingObj.background) {
                        rule.background = settingObj.background.replace('#', '').toUpperCase();
                    }
                    
                    // 添加字体样式（如果有）
                    if (settingObj.fontStyle) {
                        rule.fontStyle = settingObj.fontStyle;
                    }
                    
                    rules.push(rule);
                    console.log(`[definition] Complex token rule: ${scope} -> ${token}`, rule);
                });
            }
        }
    }
    
    console.log(`[definition] Converted ${rules.length} token customization rules`);
    return rules;
}

// 转换VSCode的semanticTokenColorCustomizations到Monaco格式
private _convertVSCodeSemanticTokensToMonaco(semanticRules: any): any[] {
    const rules: any[] = [];
    
    console.log('[definition] Converting VSCode semantic token customizations...');
    
    for (const [scope, setting] of Object.entries(semanticRules)) {
        if (typeof setting === 'string') {
            // 简单颜色字符串格式: "function": "#FF0000"
            const monacoTokens = this._mapVSCodeSemanticScopeToMonacoToken(scope);
            if (monacoTokens && monacoTokens.length > 0) {
                monacoTokens.forEach(token => {
                    rules.push({
                        token: token,
                        foreground: setting.replace('#', '').toUpperCase()
                    });
                    console.log(`[definition] Semantic rule: ${scope} -> ${token} (${setting})`);
                });
            }
        } else if (typeof setting === 'object' && setting) {
            // 复杂设置对象格式: "function": { "foreground": "#FF0000", "fontStyle": "bold" }
            const settingObj = setting as any;
            const monacoTokens = this._mapVSCodeSemanticScopeToMonacoToken(scope);
            
            if (monacoTokens && monacoTokens.length > 0 && settingObj.foreground) {
                monacoTokens.forEach(token => {
                    const rule: any = {
                        token: token,
                        foreground: settingObj.foreground.replace('#', '').toUpperCase()
                    };
                    
                    // 语义token通常不支持background，但我们保留这个逻辑以防万一
                    if (settingObj.background) {
                        rule.background = settingObj.background.replace('#', '').toUpperCase();
                    }
                    
                    // 添加字体样式（如果有）
                    if (settingObj.fontStyle) {
                        rule.fontStyle = settingObj.fontStyle;
                    }
                    
                    rules.push(rule);
                    console.log(`[definition] Complex semantic rule: ${scope} -> ${token}`, rule);
                });
            }
        }
    }
    
    console.log(`[definition] Converted ${rules.length} semantic token customization rules`);
    return rules;
}

// 映射VSCode的TextMate scope到Monaco token
private _mapVSCodeScopeToMonacoToken(scope: string): string[] {
    // VSCode TextMate scope到Monaco token的映射表
    const scopeMap: { [key: string]: string[] } = {
        // 关键字类
        'keyword': ['keyword'],
        'keyword.control': ['keyword.control'],
        'keyword.control.conditional': ['keyword.conditional'],
        'keyword.control.repeat': ['keyword.repeat'],
        'keyword.control.exception': ['keyword.exception'],
        'keyword.operator': ['keyword.operator'],
        'keyword.other': ['keyword.other'],
        'storage.type': ['keyword.type'],
        'storage.modifier': ['keyword.modifier'],
        'storage.modifier.async': ['keyword.modifier'],
        'keyword.function': ['keyword.function'],
        'keyword.control.import': ['keyword.control'],
        'keyword.control.export': ['keyword.control'],
        'keyword.control.from': ['keyword.control'],
        'keyword.control.as': ['keyword.control'],
        
        // 字符串类
        'string': ['string'],
        'string.quoted': ['string'],
        'string.quoted.single': ['string'],
        'string.quoted.double': ['string'],
        'string.template': ['string'],
        'string.regexp': ['regexp'],
        'constant.character.escape': ['string.escape'],
        'constant.character': ['string'],
        
        // 注释类
        'comment': ['comment'],
        'comment.line': ['comment'],
        'comment.line.double-slash': ['comment'],
        'comment.block': ['comment'],
        'comment.block.documentation': ['comment.doc'],
        'comment.documentation': ['comment.doc'],
        
        // 数字和常量类
        'constant.numeric': ['number'],
        'constant.numeric.integer': ['number'],
        'constant.numeric.float': ['number'],
        'constant.numeric.hex': ['number'],
        'constant.numeric.octal': ['number'],
        'constant.numeric.binary': ['number'],
        'constant.language': ['constant.language'],
        'constant.language.boolean': ['boolean'],
        'constant.language.null': ['null'],
        'constant.language.undefined': ['constant.language'],
        'constant.other': ['constant'],
        
        // 函数类
        'entity.name.function': ['function.name'],
        'entity.name.function.constructor': ['constructor'],
        'entity.name.function.destructor': ['function.name'],
        'support.function': ['function'],
        'support.function.builtin': ['function'],
        'meta.function-call': ['function'],
        'meta.function-call.generic': ['function'],
        
        // 变量类
        'variable': ['variable'],
        'variable.other': ['variable'],
        'variable.other.readwrite': ['variable'],
        'variable.other.constant': ['variable'],
        'variable.parameter': ['variable.parameter'],
        'variable.language': ['variable.language'],
        'variable.language.this': ['variable.language'],
        'variable.language.super': ['variable.language'],
        
        // 类型和类
        'entity.name.type': ['type'],
        'entity.name.type.class': ['class.name'],
        'entity.name.type.interface': ['interface'],
        'entity.name.type.enum': ['enum'],
        'entity.name.type.struct': ['struct'],
        'entity.name.type.union': ['type'],
        'entity.name.type.typedef': ['type'],
        'entity.other.inherited-class': ['class'],
        'support.type': ['type'],
        'support.class': ['class'],
        'support.type.primitive': ['type'],
        
        // 属性和成员类
        'variable.other.property': ['property'],
        'variable.other.object.property': ['property'],
        'support.property': ['property'],
        'meta.object-literal.key': ['property'],
        'entity.name.tag.yaml': ['property'],
        
        // 操作符类
        'keyword.operator.assignment': ['operator'],
        'keyword.operator.arithmetic': ['operator'],
        'keyword.operator.comparison': ['operator'],
        'keyword.operator.logical': ['operator'],
        'keyword.operator.bitwise': ['operator'],
        'keyword.operator.increment': ['operator'],
        'keyword.operator.decrement': ['operator'],
        'keyword.operator.ternary': ['operator'],
        'keyword.operator.sizeof': ['operator'],
        'keyword.operator.new': ['operator'],
        'keyword.operator.delete': ['operator'],
        
        // 分隔符类
        'punctuation': ['delimiter'],
        'punctuation.separator': ['delimiter'],
        'punctuation.separator.comma': ['delimiter'],
        'punctuation.separator.semicolon': ['delimiter'],
        'punctuation.terminator': ['delimiter'],
        'punctuation.bracket': ['delimiter.bracket'],
        'punctuation.bracket.round': ['delimiter.parenthesis'],
        'punctuation.bracket.square': ['delimiter.square'],
        'punctuation.bracket.curly': ['delimiter.curly'],
        'punctuation.parenthesis': ['delimiter.parenthesis'],
        'punctuation.parenthesis.begin': ['delimiter.parenthesis'],
        'punctuation.parenthesis.end': ['delimiter.parenthesis'],
        
        // 标签相关（HTML/XML）
        'entity.name.tag': ['tag'],
        'entity.other.attribute-name': ['attribute.name'],
        'entity.other.attribute-name.html': ['attribute.name'],
        'entity.other.attribute-name.id': ['attribute.name'],
        'entity.other.attribute-name.class': ['attribute.name'],
        'string.quoted.double.html': ['attribute.value'],
        'string.quoted.single.html': ['attribute.value'],
        
        // 命名空间
        'entity.name.namespace': ['namespace'],
        'entity.name.scope-resolution': ['namespace'],
        
        // 预处理器
        'meta.preprocessor': ['keyword.directive'],
        'entity.name.function.preprocessor': ['keyword.directive'],
        'keyword.control.directive': ['keyword.directive.control'],
        'keyword.control.directive.include': ['keyword.directive'],
        'keyword.control.directive.define': ['keyword.directive'],
        'keyword.control.directive.if': ['keyword.directive.control'],
        'keyword.control.directive.ifdef': ['keyword.directive.control'],
        'keyword.control.directive.ifndef': ['keyword.directive.control'],
        'keyword.control.directive.else': ['keyword.directive.control'],
        'keyword.control.directive.endif': ['keyword.directive.control'],
        
        // 特殊类型
        'entity.name.function.macro': ['macro'],
        'support.function.macro': ['macro'],
        'meta.decorator': ['decorator'],
        'entity.name.function.decorator': ['decorator'],
        'storage.modifier.static': ['modifier'],
        'storage.modifier.const': ['modifier'],
        'storage.modifier.final': ['modifier'],
        'storage.modifier.abstract': ['modifier'],
        'storage.modifier.public': ['modifier'],
        'storage.modifier.private': ['modifier'],
        'storage.modifier.protected': ['modifier'],
    };
    
    // 直接匹配
    if (scopeMap[scope]) {
        return scopeMap[scope];
    }
    
    // 前缀匹配（从最长到最短）
    const sortedScopes = Object.keys(scopeMap).sort((a, b) => b.length - a.length);
    for (const mappedScope of sortedScopes) {
        if (scope.startsWith(mappedScope)) {
            return scopeMap[mappedScope];
        }
    }
    
    // 模糊匹配（包含关系）
    const fuzzyMatches: string[] = [];
    if (scope.includes('function')) fuzzyMatches.push('function');
    if (scope.includes('method')) fuzzyMatches.push('method');
    if (scope.includes('class')) fuzzyMatches.push('class');
    if (scope.includes('type')) fuzzyMatches.push('type');
    if (scope.includes('variable')) fuzzyMatches.push('variable');
    if (scope.includes('string')) fuzzyMatches.push('string');
    if (scope.includes('comment')) fuzzyMatches.push('comment');
    if (scope.includes('keyword')) fuzzyMatches.push('keyword');
    if (scope.includes('number') || scope.includes('numeric')) fuzzyMatches.push('number');
    if (scope.includes('constant')) fuzzyMatches.push('constant');
    if (scope.includes('operator')) fuzzyMatches.push('operator');
    if (scope.includes('delimiter') || scope.includes('punctuation')) fuzzyMatches.push('delimiter');
    
    if (fuzzyMatches.length > 0) {
        console.log(`[definition] Fuzzy matched scope: ${scope} -> [${fuzzyMatches.join(', ')}]`);
        return fuzzyMatches;
    }
    
    // 无法映射
    console.warn(`[definition] Unable to map VSCode scope: ${scope}`);
    return [];
}

// 映射VSCode的semantic token scope到Monaco token
private _mapVSCodeSemanticScopeToMonacoToken(scope: string): string[] {
    // VSCode semantic token到Monaco token的映射表
    const semanticMap: { [key: string]: string[] } = {
        // 函数相关
        'function': ['function'],
        'function.declaration': ['function.name'],
        'function.defaultLibrary': ['function'],
        'method': ['method'],
        'method.declaration': ['method.name'],
        'method.defaultLibrary': ['method'],
        
        // 变量相关
        'variable': ['variable'],
        'variable.declaration': ['variable.name'],
        'variable.defaultLibrary': ['variable'],
        'variable.readonly': ['variable'],
        'variable.local': ['variable'],
        'variable.global': ['variable'],
        'parameter': ['variable.parameter'],
        'parameter.declaration': ['variable.parameter'],
        
        // 属性相关
        'property': ['property'],
        'property.declaration': ['property.declaration'],
        'property.defaultLibrary': ['property'],
        'property.readonly': ['property'],
        'property.static': ['property'],
        'member': ['member'],
        'field': ['field'],
        
        // 类型相关
        'class': ['class'],
        'class.declaration': ['class.name'],
        'class.defaultLibrary': ['class'],
        'interface': ['interface'],
        'interface.declaration': ['interface'],
        'type': ['type'],
        'type.declaration': ['type.declaration'],
        'typeParameter': ['type'],
        'typeParameter.declaration': ['type'],
        'enum': ['enum'],
        'enum.declaration': ['enum'],
        'enumMember': ['constant'],
        'enumMember.declaration': ['constant'],
        'struct': ['struct'],
        'struct.declaration': ['struct'],
        
        // 命名空间
        'namespace': ['namespace'],
        'namespace.declaration': ['namespace'],
        'module': ['namespace'],
        'module.declaration': ['namespace'],
        
        // 关键字和修饰符
        'keyword': ['keyword'],
        'modifier': ['modifier'],
        'decorator': ['decorator'],
        'annotation': ['decorator'],
        
        // 常量和字面量
        'number': ['number'],
        'string': ['string'],
        'boolean': ['boolean'],
        'regexp': ['regexp'],
        
        // 操作符
        'operator': ['operator'],
        'operatorOverloaded': ['operator'],
        
        // 注释
        'comment': ['comment'],
        'comment.documentation': ['comment.doc'],
        
        // 宏
        'macro': ['macro'],
        'macro.declaration': ['macro'],
        
        // 事件（特定语言）
        'event': ['function'],
        'event.declaration': ['function.name'],
        
        // 标签（特定语言）
        'label': ['tag'],
        'label.declaration': ['tag'],
        
        // 其他语义类型
        'selfKeyword': ['variable.language'],
        'lifetime': ['type'],
        'unresolvedReference': ['identifier'],
        'formatSpecifier': ['string.escape'],
        'generic': ['type'],
        'builtinType': ['type'],
        'magicFunction': ['function'],
        'attributeBracket': ['delimiter.bracket'],
        'attribute': ['decorator'],
        'derive': ['decorator'],
        'toolModule': ['namespace'],
        'crateRoot': ['namespace'],
        'punctuation': ['delimiter'],
        'angle': ['delimiter.bracket'],
        'arithmetic': ['operator'],
        'logical': ['operator'],
        'comparison': ['operator'],
        'bitwise': ['operator'],
        'assignment': ['operator'],
        'unaryPrefix': ['operator'],
        'unaryPostfix': ['operator'],
        'dot': ['delimiter'],
        'escapeSequence': ['string.escape'],
        'parenthesis': ['delimiter.parenthesis'],
        'bracket': ['delimiter.bracket'],
        'brace': ['delimiter.curly'],
        'semicolon': ['delimiter'],
        'comma': ['delimiter'],
        'colon': ['delimiter'],
        'typeHint': ['type'],
        'builtinConstant': ['constant.language'],
        'static': ['modifier'],
        'consuming': ['modifier'],
        'callable': ['function'],
        'intraDocLink': ['tag'],
        'library': ['namespace'],
        'controlFlow': ['keyword.control']
    };
    
    // 直接匹配
    if (semanticMap[scope]) {
        return semanticMap[scope];
    }
    
    // 处理带修饰符的语义token（如 "function.async", "variable.readonly"）
    const parts = scope.split('.');
    if (parts.length > 1) {
        const baseScope = parts[0];
        if (semanticMap[baseScope]) {
            return semanticMap[baseScope];
        }
    }
    
    // 模糊匹配
    const fuzzyMatches: string[] = [];
    if (scope.includes('function')) fuzzyMatches.push('function');
    if (scope.includes('method')) fuzzyMatches.push('method');
    if (scope.includes('variable')) fuzzyMatches.push('variable');
    if (scope.includes('property')) fuzzyMatches.push('property');
    if (scope.includes('class')) fuzzyMatches.push('class');
    if (scope.includes('type')) fuzzyMatches.push('type');
    if (scope.includes('interface')) fuzzyMatches.push('interface');
    if (scope.includes('enum')) fuzzyMatches.push('enum');
    if (scope.includes('namespace')) fuzzyMatches.push('namespace');
    if (scope.includes('constant')) fuzzyMatches.push('constant');
    if (scope.includes('keyword')) fuzzyMatches.push('keyword');
    if (scope.includes('operator')) fuzzyMatches.push('operator');
    if (scope.includes('string')) fuzzyMatches.push('string');
    if (scope.includes('number')) fuzzyMatches.push('number');
    if (scope.includes('comment')) fuzzyMatches.push('comment');
    if (scope.includes('macro')) fuzzyMatches.push('macro');
    
    if (fuzzyMatches.length > 0) {
        console.log(`[definition] Fuzzy matched semantic scope: ${scope} -> [${fuzzyMatches.join(', ')}]`);
        return fuzzyMatches;
    }
    
    // 无法映射
    console.warn(`[definition] Unable to map VSCode semantic scope: ${scope}`);
    return [];
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
            customThemeRules: any[];
            themeInfo?: any;
    tokenColorCustomizations?: any;
    semanticTokenColorCustomizations?: any;
    vsCodeThemeColors?: any;
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
                selectionHighlightBorder: contextWindowConfig.get('selectionHighlightBorder', '#5bdb0791'),
                fontSize: contextWindowConfig.get('fontSize', 14),
                fontFamily: contextWindowConfig.get('fontFamily', 'Consolas, monospace'),
                minimap: contextWindowConfig.get('minimap', true),
                useDefaultTheme: contextWindowConfig.get('useDefaultTheme', true),
            },
            customThemeRules: []
        };

        // 只在 light 主题下添加自定义主题规则
        if (currentTheme === 'vs' && !config.contextEditorCfg.useDefaultTheme) {
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
        } else if (config.contextEditorCfg.useDefaultTheme) {
            // 获取VSCode主题配置
    const workbenchConfig = vscode.workspace.getConfiguration('workbench');
    const activeTheme = vscode.window.activeColorTheme;
    
    // 获取VSCode的token配色配置
    const tokenColorCustomizations = editorConfig.get<TokenColorCustomizations>('tokenColorCustomizations', {});
    const semanticTokenColorCustomizations = editorConfig.get<SemanticTokenColorCustomizations>('semanticTokenColorCustomizations', {});
    
    console.log('[definition] VSCode Token customizations:', tokenColorCustomizations);
    console.log('[definition] VSCode Semantic customizations:', semanticTokenColorCustomizations);
    
    // **核心：始终生成Monaco token规则**
    const monacoTokenRules: any[] = [];
    
    // 1. 添加基础默认token配色（基于VSCode默认主题）
    const defaultTokenRules = this._getDefaultMonacoTokenRules(currentTheme === 'vs');
    monacoTokenRules.push(...defaultTokenRules);
    console.log('[definition] Added default token rules:', defaultTokenRules.length, 'rules');
    
    // 2. 处理VSCode的tokenColorCustomizations（覆盖默认规则）
    if (tokenColorCustomizations && Object.keys(tokenColorCustomizations).length > 0) {
        const customTokenRules = this._convertVSCodeTokensToMonaco(tokenColorCustomizations);
        monacoTokenRules.push(...customTokenRules);
        console.log('[definition] Added VSCode token customization rules:', customTokenRules.length, 'rules');
    }
    
    // 3. 处理VSCode的semanticTokenColorCustomizations（最高优先级）
    if (semanticTokenColorCustomizations.rules && Object.keys(semanticTokenColorCustomizations.rules).length > 0) {
        const semanticTokenRules = this._convertVSCodeSemanticTokensToMonaco(semanticTokenColorCustomizations.rules);
        monacoTokenRules.push(...semanticTokenRules);
        console.log('[definition] Added VSCode semantic token rules:', semanticTokenRules.length, 'rules');
    }
    
    // **关键：确保customThemeRules始终存在且不为空**
    config.customThemeRules = monacoTokenRules.length > 0 ? monacoTokenRules : this._getDefaultMonacoTokenRules(currentTheme === 'vs');
    
    // 添加其他配置信息（用于调试和扩展）
    config.themeInfo = {
        id: 'unknown',
        kind: activeTheme.kind,
        label: 'Unknown Theme'
    };
    
    config.tokenColorCustomizations = tokenColorCustomizations;
    config.semanticTokenColorCustomizations = semanticTokenColorCustomizations;
    config.vsCodeThemeColors = this._getVSCodeThemeVariables();
    
    console.log('[definition] Final Monaco token rules count:', config.customThemeRules.length);
    console.log('[definition] VSCode theme applied:', config.themeInfo.label);
    console.log('[definition] Sample rules:', config.customThemeRules.slice(0, 5));
        } else {
            // **新增：确保其他情况也有customThemeRules**
            config.customThemeRules = this._getDefaultMonacoTokenRules(currentTheme === 'vs');
            console.log('[definition] Using fallback default theme rules');
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
                case 'pin':
                    vscode.commands.executeCommand('contextView.contextWindow.pin');
                    break;
                case 'unpin':
                    vscode.commands.executeCommand('contextView.contextWindow.unpin');
                    break;
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
                            
                            // 跳转到指定行
                            const line = this.currentLine;//message.line - 1; // VSCode的行号从0开始
                            const range = new vscode.Range(line, 0, line, 0);

                            const editor = await vscode.window.showTextDocument(document, {
                                selection: range,
                                viewColumn: vscode.ViewColumn.Active,
                                preserveFocus: false,
                                preview: false
                            });
                            
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
        this._view?.webview.postMessage({
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

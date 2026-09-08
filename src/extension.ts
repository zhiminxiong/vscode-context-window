import * as vscode from 'vscode';
import { ContextWindowProvider } from './contextView';
import { CallRelationPanel, CALL_RELATION_VIEW_TYPE } from './callRelationPanel';
import { findRelation } from './findRelation';
import { registerRelationQuickSearch } from './relationQuickSearch';
import { isSingleFullLineSelection, registerLineNumberSymbolSelection } from './enclosingSymbol';
import { registerMcpToolPreview } from './mcp/preview';
import { registerMcpHost } from './mcp/host';
import { registerEditorLineBlame } from './editorLineBlame';

function parseRelationLoc(arg?: { uri?: string; line?: number; character?: number }):
    { uri?: vscode.Uri; position?: vscode.Position } | undefined {
    if (!arg || typeof arg.uri !== 'string' || typeof arg.line !== 'number') {
        return undefined;
    }
    try {
        return {
            uri: vscode.Uri.parse(arg.uri),
            position: new vscode.Position(Math.max(0, arg.line), Math.max(0, arg.character ?? 0))
        };
    } catch {
        return undefined;
    }
}

export function activate(context: vscode.ExtensionContext) {

    const provider = new ContextWindowProvider(context);
    context.subscriptions.push(provider);
    const callRelation = new CallRelationPanel(context);
    context.subscriptions.push(callRelation);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ContextWindowProvider.viewType, provider, {
            webviewOptions: {
                // 切到 Terminal/Problems 等其他面板再切回时，保留 webview 的运行上下文，
                // 避免 Monaco 编辑器被销毁重建导致字体等运行期状态丢失
                retainContextWhenHidden: true
            }
        }));

    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('FloatContextView', provider)
    );

    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer(CALL_RELATION_VIEW_TYPE, callRelation)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('contextView.contextWindow.pin', () => {
            provider.pin();
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('contextView.contextWindow.unpin', () => {
            provider.unpin();
        }));

    // 注册显示上下文窗口的命令
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-context-window.showContextWindow', () => {
            provider.show();
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-context-window.float', () => {
            provider.showFloatingWebview();
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-context-window.floatIndependent', () => {
            void provider.showFloatingWebviewIndependent();
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('contextView.callRelation.show', (arg?: { uri?: string; line?: number; character?: number }) => {
            callRelation.show(parseRelationLoc(arg));
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('contextView.callRelation.showIndependent', (arg?: { uri?: string; line?: number; character?: number }) => {
            void callRelation.showInNewWindow(parseRelationLoc(arg));
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('contextView.callRelation.findRelation', (arg?: { uri?: string; line?: number; character?: number }) => {
            return findRelation(parseRelationLoc(arg));
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('contextView.callRelation.findRelationInContext', (arg?: { uri?: string; line?: number; character?: number }) => {
            return provider.findRelationInContext(parseRelationLoc(arg));
        }));

    context.subscriptions.push(
        registerRelationQuickSearch(context, loc => {
            const independent = vscode.workspace.getConfiguration('contextView.callRelation')
                .get<boolean>('quickOpenIndependent', false);
            if (independent) {
                void callRelation.showInNewWindow({ uri: loc.uri, position: loc.position });
            } else {
                callRelation.show({ uri: loc.uri, position: loc.position });
            }
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('contextView.callRelation.find', () => {
            callRelation.find('open');
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('contextView.callRelation.findNext', () => {
            callRelation.find('next');
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('contextView.callRelation.findPrevious', () => {
            callRelation.find('prev');
        }));

    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-context-window.navigateUri', async (uri?: string, range?: { start: { line: number; character: number }; end: { line: number; character: number } }, token?: string, recordTrail: boolean = true) => {
            // 如果没有提供参数，则显示输入框
            if (!uri || !range) {
                try {
                    // 获取 URI
                    const uriInput = await vscode.window.showInputBox({
                        prompt: 'Enter file URI',
                        placeHolder: 'file:///e:/code_proj/vscode-context-window/src/extension.ts',
                        value: uri || ''
                    });
                    
                    if (!uriInput) {
                        return; // 用户取消了输入
                    }

                    // 询问用户是导航到单点还是范围
                    const navigationType = await vscode.window.showQuickPick([
                        { label: 'Single Point', description: 'Navigate to specific line and character' },
                        { label: 'Range', description: 'Navigate to a range of lines' }
                    ], {
                        placeHolder: 'Select navigation type'
                    });

                    if (!navigationType) {
                        return;
                    }

                    let inputRange: { start: { line: number; character: number }; end: { line: number; character: number } };

                    if (navigationType.label === 'Single Point') {
                        // 获取行号
                        const lineInput = await vscode.window.showInputBox({
                            prompt: 'Enter line number',
                            placeHolder: '1'
                        });
                        
                        if (!lineInput) {
                            return; // 用户取消了输入
                        }

                        const lineNumber = parseInt(lineInput);
                        if (isNaN(lineNumber) || lineNumber < 1) {
                            vscode.window.showErrorMessage('Invalid line number');
                            return;
                        }

                        // 获取字符列号
                        const characterInput = await vscode.window.showInputBox({
                            prompt: 'Enter character column',
                            placeHolder: '1'
                        });
                        
                        if (!characterInput) {
                            return; // 用户取消了输入
                        }

                        const characterNumber = parseInt(characterInput);
                        if (isNaN(characterNumber) || characterNumber < 1) {
                            vscode.window.showErrorMessage('Invalid character number');
                            return;
                        }

                        // 创建单点range
                        inputRange = {
                            start: { line: lineNumber, character: characterNumber },
                            end: { line: lineNumber, character: characterNumber }
                        };
                    } else {
                        // 获取起始行号
                        const startLineInput = await vscode.window.showInputBox({
                            prompt: 'Enter start line number',
                            placeHolder: '1'
                        });
                        
                        if (!startLineInput) {
                            return;
                        }

                        const startLineNumber = parseInt(startLineInput);
                        if (isNaN(startLineNumber) || startLineNumber < 1) {
                            vscode.window.showErrorMessage('Invalid start line number');
                            return;
                        }

                        // 获取起始字符列号
                        const startCharacterInput = await vscode.window.showInputBox({
                            prompt: 'Enter start character column',
                            placeHolder: '0'
                        });
                        
                        if (!startCharacterInput) {
                            return;
                        }

                        const startCharacterNumber = parseInt(startCharacterInput);
                        if (isNaN(startCharacterNumber) || startCharacterNumber < 1) {
                            vscode.window.showErrorMessage('Invalid start character number');
                            return;
                        }

                        // 获取结束行号
                        const endLineInput = await vscode.window.showInputBox({
                            prompt: 'Enter end line number',
                            placeHolder: startLineNumber.toString()
                        });
                        
                        if (!endLineInput) {
                            return;
                        }

                        const endLineNumber = parseInt(endLineInput);
                        if (isNaN(endLineNumber) || endLineNumber < startLineNumber) {
                            vscode.window.showErrorMessage('Invalid end line number');
                            return;
                        }

                        // 获取结束字符列号
                        const endCharacterInput = await vscode.window.showInputBox({
                            prompt: 'Enter end character column',
                            placeHolder: startCharacterNumber.toString()
                        });
                        
                        if (!endCharacterInput) {
                            return;
                        }

                        const endCharacterNumber = parseInt(endCharacterInput);
                        if (isNaN(endCharacterNumber) || endCharacterNumber < 1) {
                            vscode.window.showErrorMessage('Invalid end character number');
                            return;
                        }

                        // 创建范围range
                        inputRange = {
                            start: { line: startLineNumber, character: startCharacterNumber },
                            end: { line: endLineNumber, character: endCharacterNumber }
                        };
                    }
                    
                    // 执行导航
                    await provider.navigateCommand(uriInput, inputRange, '', recordTrail);
                    vscode.window.showInformationMessage(`Navigated to ${uriInput}:${inputRange.start.line}:${inputRange.start.character}-${inputRange.end.line}:${inputRange.end.character}`);
                    
                } catch (error) {
                    vscode.window.showErrorMessage(`Navigation failed: ${error}`);
                }
            } else {
                // 如果提供了参数，直接执行导航
                await provider.navigateCommand(uri, range, token || '', recordTrail);
            }
        }));
    
    registerDirectiveDecorations(context);
    registerBracketPairSelectionOnDoubleClick(context);
    registerBracketPairSelectionToggle(context);
    registerLineNumberSymbolSelection(context);
    registerEditorLineBlame(context);
    registerMcpToolPreview(context);
    registerMcpHost(context);
}

/**
 * 「双击选中整对括号/引号」开关命令：contextView.contextWindow.toggleSelectBracketPair。
 * 一份配置同时管主编辑器（左键双击）和 Context Window（右键双击）。
 * 快捷键、编辑器右键菜单、底部 {si} 指示器都切这一项。
 */
function registerBracketPairSelectionToggle(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('contextView.contextWindow.toggleSelectBracketPair', async (opts?: { quiet?: boolean }) => {
            const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
            // 不传 get() 的 fallback：package.json 已声明 default: true，
            // 重复一遍会在改默认值时漏改一处，出现「首次点击不生效」。
            const next = !cfg.get<boolean>(CONFIG_SELECT_BRACKET_PAIR);
            await cfg.update(CONFIG_SELECT_BRACKET_PAIR, next, vscode.ConfigurationTarget.Global);
            if (!opts?.quiet) {
                vscode.window.setStatusBarMessage(
                    next
                        ? 'Double-click selects the whole bracket/quote pair (including delimiters): ON — click to disable'
                        : 'Double-click selects the whole bracket/quote pair (including delimiters): OFF — click to enable',
                    1500
                );
            }
        })
    );
}

// 该功能的配置节 / 键名（重命名自旧的 selectBracketPairOnDoubleClick）。
// 与 VSCode 内置 editor.doubleClickSelectsBlock（只选括号内内容）对照：本项选中「整对括号/引号，含定界符本身」。
const CONFIG_SECTION = 'contextView.contextWindow';
// 主编辑器左键双击 + Context Window 右键双击共用。默认开。
const CONFIG_SELECT_BRACKET_PAIR = 'doubleClickSelectsBracketPair';

// 开括号 → 对应闭括号（含尖括号 <>，用于模板/泛型 如 vector<int>）
const BRACKET_PAIRS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '<': '>' };
// 闭括号 → 对应开括号（用于「双击紧贴闭括号左侧」时向左回溯匹配的开括号）
const CLOSE_TO_OPEN: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{', '>': '<' };
// 注：括号匹配（跨行 / 嵌套 / 语言感知，正确处理字符串与注释里的括号）交给 VSCode 内置命令
// editor.action.selectToBracket 处理；本扩展只负责判定「双击是否紧挨括号」并把光标定位到括号内侧。

// 引号字符：开闭同形（双引号 / 单引号 / 反引号），VSCode 无对应的 selectToBracket，需自行扫描配对。
const QUOTES: ReadonlySet<string> = new Set(['"', "'", '`']);

// === 双击 / 拖拽的区分（见 registerBracketPairSelectionOnDoubleClick 的注释）===
// 背景：VSCode 在渲染进程用原生 mousedown 的 e.detail 算出 mouseDownCount，再配合 inSelectionMode
// 分流到 _wordSelect（双击选词）/ _wordSelectDrag（双击后拖）/ MoveToSelect（单击后拖）；
// 但跨进程传给扩展时只剩一个写死的 source='mouse'（viewController._usualArgs），
// mouseDownCount / inSelectionMode / CursorChangeReason 全部丢失，扩展看不到点击次数。
//
// 主判据是下面的「选词指纹」（wordFingerprint，确定性、始终生效）；两个时间参数只是额外保险：
// · dragGuard：从「按下产生的空选区」到「第一个非空鼠标选区」的间隔下限（毫秒）。
//   拖拽起步（按下→移动出第一个字符）几乎总 < 50ms；而双击的两击间隔通常 80~250ms
//   （VSCode 内部还强制 < 400ms，见 MouseDownState.CLEAR_MOUSE_DOWN_COUNT_TIME）。
//   注意「光标本就在双击点」的场景第一击不产生事件，此时间隔是「上次定位到现在」的时长
//   （远大于阈值），因此不会被误挡，原有能力完整保留。
const CONFIG_DRAG_GUARD = 'doubleClickSelectsBracketPairDragGuard';
const DEFAULT_DRAG_GUARD_MS = 60;
// · confirmDelay：命中后的确认窗口（毫秒）。用于兜住「选词指纹恰好碰撞」的窄情况（见 expectedWordSelectionRange）。
//   窗口内一旦再来鼠标选区事件（= 鼠标仍在移动）即判为拖拽并永久放手，全程未改过选区。
//   注意：单靠时间参数是【挡不住慢速拖拽】的——慢速拖拽跨一个字符就要几百毫秒，
//   于是「间隔够久」（穿透 dragGuard）+「窗口内没有新事件」（穿透 confirmDelay）同时成立。
//   这正是必须有选词指纹这道确定性判据的原因。
const CONFIG_CONFIRM_DELAY = 'doubleClickSelectsBracketPairConfirmDelay';
const DEFAULT_CONFIRM_DELAY_MS = 90;

// === 配置缓存 ===
// onDidChangeTextEditorSelection 是热路径：拖拽时每跨一个字符就来一次，
// 加上其它逻辑的程序化光标移动，实测短时间内可达数千次。
// vscode.workspace.getConfiguration() 虽然不跨进程（扩展宿主本地有配置模型副本），
// 但每次调用都要新建 section 视图对象、按 resource/language 解析 override，
// 在这种频率下没必要反复做。故这里把用到的值全部缓存。
//
// 【立即生效】由 onDidChangeConfiguration 保证：任一相关键变化即整体失效，下一次读取重新取值，
// 因此改设置、点 {si}、按快捷键、切工作区配置都无需重载窗口。
// 注意 wordSeparators 支持按语言覆盖（可在 "[typescript]" 作用域里改），故按 languageId 分别缓存；
// 语言覆盖的变更同样会命中 affectsConfiguration('editor.wordSeparators') —— VSCode 会把
// override 里的键本身也放进 affectedKeys（见 configurationModels.ts 的 ConfigurationChangeEvent 构造）。
interface PairSelectSettings {
    enabled: boolean;
    dragGuardMs: number;
    confirmDelayMs: number;
}

// 会影响上述缓存的配置键，用于精确判断是否需要失效（避免同节内无关项（如 fontSize）也触发重算）
const PAIR_SELECT_CONFIG_KEYS = [
    `${CONFIG_SECTION}.${CONFIG_SELECT_BRACKET_PAIR}`,
    `${CONFIG_SECTION}.${CONFIG_DRAG_GUARD}`,
    `${CONFIG_SECTION}.${CONFIG_CONFIRM_DELAY}`,
    'editor.wordSeparators'
];

let cachedSettings: PairSelectSettings | undefined;
const cachedSeparators = new Map<string, string>();

function pairSelectSettings(): PairSelectSettings {
    if (!cachedSettings) {
        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        // 不传 get() 的 fallback：package.json 已声明各项 default，
        // 在此重复一遍只会在改默认值时留下不一致的隐患。
        cachedSettings = {
            enabled: cfg.get<boolean>(CONFIG_SELECT_BRACKET_PAIR) !== false,
            dragGuardMs: Math.max(0, cfg.get<number>(CONFIG_DRAG_GUARD) ?? DEFAULT_DRAG_GUARD_MS),
            confirmDelayMs: Math.max(0, cfg.get<number>(CONFIG_CONFIRM_DELAY) ?? DEFAULT_CONFIRM_DELAY_MS)
        };
    }
    return cachedSettings;
}

function wordSeparatorsFor(doc: vscode.TextDocument): string {
    const key = doc.languageId;
    let sep = cachedSeparators.get(key);
    if (sep === undefined) {
        sep = vscode.workspace
            .getConfiguration('editor', { uri: doc.uri, languageId: key })
            .get<string>('wordSeparators') ?? USUAL_WORD_SEPARATORS;
        cachedSeparators.set(key, sep);
    }
    return sep;
}

function invalidatePairSelectCache(): void {
    cachedSettings = undefined;
    cachedSeparators.clear();
}

// === 「是不是双击选词」的判据：选区是否与词边界对齐 ===
// 背景：双击必然先经过内核选词（dispatchMouse 里 mouseDownCount===2 && !inSelectionMode →
// _wordSelect → WordOperations.word），而单击拖拽走 MoveToSelect、逐字符扩展。
// 扩展拿不到点击计数，只能从选区形状反推，这是唯一不依赖时间、能挡住慢速拖拽的判据。
//
// 【为什么不逐字复刻选词算法】曾经这么做过，但它跨版本不稳：
// VSCode 在 commit 6055fcf8d8b（2025-10-26,「Fix double-click on punctuation selecting adjacent
// space instead of character」#273321）改过 word() 的行为——
//   · 该修复之后：`= (async` 处紧贴 ( 双击 → 选中 `(` 本身；
//   · 该修复之前：同一处双击 → 选中 ( 左边那个【空格】。
// 于是「精确等于新版预期」的判据在较老的 VSCode / 其衍生版（如 Cursor）上必然对不上，
// 表现为「括号左边是空白时双击完全失效」。
//
// 【改用的判据】选词结果的共同特征与具体版本无关：它总是【一整段同类字符】——
// WordOperations 的所有分支（touching prev/next word、以及夹在空白中的 else 分支）
// 给出的区间，边界都落在「字符类别切换处」（Regular / WordSeparator / Whitespace 三类之间）。
// 故只要求：选区在单行内，且恰好是一段【极大】同类字符（两端要么到行首/行尾，要么邻接不同类）。
// 这样新旧两种行为都能通过，而拖拽 N 个字符除非恰好停在类别边界，否则一律被拒。
//
// 【残余误判】拖拽恰好停在极大同类段的边界上时仍会被当成双击，典型是
// `            });` 处紧贴 } 慢速拖到行尾——选区 `});` 与双击结果完全相同，
// 任何静态判据都区分不了。这类由 dragGuard / confirmDelay 减少概率，
// 并最终由「自愈 B」（继续拖动即撤销括号选定、恢复拖动选定）兜住。
//
// 说明：不处理 Intl.Segmenter 分词（editor.wordSegmenterLocales，默认空、仅 CJK 需要）。
// 那种情况下选区是极大段的子集 → 判为不对齐 → 不触发本功能、回退成默认选词，属于安全的失败方向。
const enum CharClass { Regular = 0, Whitespace = 1, WordSeparator = 2 }

// editor.wordSeparators 的默认值（USUAL_WORD_SEPARATORS，见 core/wordHelper.ts）。注意其中不含空格。
const USUAL_WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

// 与 WordCharacterClassifier 构造顺序一致：先按 wordSeparators 标记，再把空格/Tab 覆盖为 Whitespace，
// 故即便用户把空格写进 editor.wordSeparators，它仍归类为 Whitespace。
function classifyChar(ch: string, separators: string): CharClass {
    if (ch === ' ' || ch === '\t') { return CharClass.Whitespace; }
    return separators.indexOf(ch) >= 0 ? CharClass.WordSeparator : CharClass.Regular;
}

/**
 * [start, end) 是否恰好是 lineText 里一段【极大】同类字符（即一个完整的「词单元」）。
 * 三个条件：区间非空、内部字符同类、两端邻接的字符不同类（或已到行首/行尾）。
 */
function isMaximalCharClassRun(lineText: string, start: number, end: number, separators: string): boolean {
    if (end <= start || start < 0 || end > lineText.length) { return false; }
    const cls = classifyChar(lineText.charAt(start), separators);
    for (let i = start + 1; i < end; i++) {
        if (classifyChar(lineText.charAt(i), separators) !== cls) { return false; }
    }
    // 左侧不能还是同类（否则说明选区从段中间开始，是拖拽的中间态）
    if (start > 0 && classifyChar(lineText.charAt(start - 1), separators) === cls) { return false; }
    // 右侧同理
    if (end < lineText.length && classifyChar(lineText.charAt(end), separators) === cls) { return false; }
    return true;
}

// 判断 text[i] 是否被反斜杠转义（前导连续反斜杠为奇数个 → 被转义，如 \" 不是字符串边界）。
function isEscapedAt(text: string, i: number): boolean {
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && text.charAt(j) === '\\'; j--) { backslashes++; }
    return backslashes % 2 === 1;
}

// 在同一行内为 quoteCol 处的引号 q 找配对引号，返回 [开引号列, 闭引号列]（含两端），找不到返回 undefined。
// 开/闭判定：统计该引号之前（同行）未转义的同种引号个数——偶数 ⇒ 此为开引号（向右找闭），奇数 ⇒ 此为闭引号（向左找开）。
// 仅在同一行内匹配：普通字符串通常不跨行；跨行模板字符串等找不到配对时放弃，回退到 VSCode 默认选词。
function findMatchingQuoteOnLine(lineText: string, quoteCol: number, q: string): [number, number] | undefined {
    let count = 0;
    for (let i = 0; i < quoteCol; i++) {
        if (lineText.charAt(i) === q && !isEscapedAt(lineText, i)) { count++; }
    }
    if (count % 2 === 0) {
        // 开引号：向右找下一个未转义的同种引号作为闭引号
        for (let i = quoteCol + 1; i < lineText.length; i++) {
            if (lineText.charAt(i) === q && !isEscapedAt(lineText, i)) { return [quoteCol, i]; }
        }
    } else {
        // 闭引号：向左回溯上一个未转义的同种引号作为开引号
        for (let i = quoteCol - 1; i >= 0; i--) {
            if (lineText.charAt(i) === q && !isEscapedAt(lineText, i)) { return [i, quoteCol]; }
        }
    }
    return undefined;
}

// 判断 col 处字符是否位于同一行的某个字符串字面量（一对未转义引号）内部。
// 命中则返回该字符串的「内容区间」[start, end]（不含两端引号，闭区间）；不在字符串内返回 undefined。
// 用途：字符串内的方括号/圆括号只是普通文本，VSCode 语言感知的 selectToBracket 会忽略它们、
// 误匹配到字符串外层的语法括号（如 log('[x]') 双击 [ 却选中整个 (...)），故字符串内需改用纯文本配对。
function stringContentRangeAt(lineText: string, col: number): { start: number; end: number } | undefined {
    let quote = '';
    let quoteStart = -1;
    for (let i = 0; i < lineText.length; i++) {
        const c = lineText.charAt(i);
        if (!QUOTES.has(c) || isEscapedAt(lineText, i)) { continue; }
        if (quote === '') {
            quote = c; quoteStart = i;
        } else if (c === quote) {
            // 完整字符串 [quoteStart, i]：col 落在两引号之间的内容区即命中
            if (quoteStart < col && col < i) { return { start: quoteStart + 1, end: i - 1 }; }
            quote = ''; quoteStart = -1;
        }
    }
    return undefined;
}

// 在同一行、限定区间 [lo, hi] 内，为 col 处的括号 ch 做纯文本配对（支持同类嵌套），
// 返回 [开括号列, 闭括号列]；找不到返回 undefined。用于字符串内部的括号选定（不走语言感知的 selectToBracket）。
function findMatchingBracketOnLine(lineText: string, col: number, ch: string, lo: number, hi: number): [number, number] | undefined {
    if (BRACKET_PAIRS[ch]) {
        // 开括号：向右找配对闭括号
        const close = BRACKET_PAIRS[ch];
        let depth = 0;
        for (let i = col; i <= hi; i++) {
            const c = lineText.charAt(i);
            if (c === ch) { depth++; }
            else if (c === close) { depth--; if (depth === 0) { return [col, i]; } }
        }
    } else {
        // 闭括号：向左找配对开括号
        const open = CLOSE_TO_OPEN[ch];
        let depth = 0;
        for (let i = col; i >= lo; i--) {
            const c = lineText.charAt(i);
            if (c === ch) { depth++; }
            else if (c === open) { depth--; if (depth === 0) { return [i, col]; } }
        }
    }
    return undefined;
}

// 「紧挨括号」允许的列容差：从双击落点向右查找括号的最大字符距离。
// 0 = 落点右邻必须就是括号（严格紧挨）；放大可容忍落点与括号之间夹少量空白。
const NEAR_BRACKET_TOLERANCE = 0;

/**
 * 扩展编辑器双击行为：仅当「双击落点紧挨括号（开括号右侧 / 闭括号左侧）」时，选中整对匹配括号（含括号）——
 * 即 foo(...) 中点在紧贴 ( 或紧贴 ) 处双击，选中 (...)；而点在 foo 靠左处双击，仍是 VSCode 默认选词。
 *
 * 为什么要「跟踪光标当前位置」而不是「记录上一次单击」：
 * 双击选词无论点在词的哪个字符，选区都是整个词，单凭选区无法区分「点在词靠左」还是「点在紧贴括号处」，
 * 必须知道真实点击点。理想信号是双击第一击产生的「空选区光标定位」事件，但它有个致命缺口：
 * 若光标本来就在双击点上（如先单击过该处），第一击不移动光标 → 不产生任何 selection 事件 → 拿不到落点。
 * 因此改为【持续跟踪光标当前所在的单点位置】（任何来源的空选区都更新它）：这样无论第一击是否产生事件，
 * 双击选词发生时，光标位置（lastCaret）都已经等于真实点击点，彻底消除「光标未移动则双击失效」的问题。
 *
 * 为什么不是「拦截鼠标双击」：
 * VSCode 扩展 API 既拿不到原始鼠标事件、也无法阻止默认选词（编辑器在渲染进程、扩展在扩展宿主进程，隔离）。
 * 唯一的鼠标信号是 onDidChangeTextEditorSelection 的 kind===Mouse，且在选词「之后」触发。命中时我们
 * 【同步、一次性】改选区（不 await 内置命令），让中间那次选词几乎无感；不命中则完全不动。
 * 程序化改选区 kind 不是 Mouse，只会更新光标跟踪、不会进入双击判定，天然防循环。
 *
 * 如何区分「双击」与「从括号左侧按下不松往右拖拽」：
 * 主判据是【词边界对齐】——双击必然先经过内核选词（dispatchMouse: mouseDownCount===2 &&
 * !inSelectionMode → _wordSelect），其结果总是一整段同类字符；单击拖拽走 MoveToSelect 逐字符扩展，
 * 除非恰好停在类别边界否则对不齐。判据本身见 isMaximalCharClassRun 上方的说明——那里也解释了
 * 为什么不去逐字复刻选词算法（VSCode 6055fcf8d8b 改过 word() 行为，复刻会在 Cursor 等衍生版上失效）。
 * 它是确定性的、零延迟的，也是唯一挡得住【慢速拖拽】的判据：慢速拖拽跨一个字符要几百毫秒，
 * 任何基于「事件间隔」的闸门都会被同时穿透（间隔够久 + 窗口内无新事件），这一点务必留意。
 *
 * 【原理上无法消除的一类误判】：拖拽恰好停在极大同类段的边界上时，选区与双击结果完全相同。
 * 本仓库 contextView.ts 的 `            });` 行就是典型：落点紧贴 } 时慢速拖到行尾，
 * 得到的 `});` 与双击选词一模一样。对此唯一正确的应对是【事后补救】而非事前拦截 —— 见自愈 B：
 * 一旦之后还收到鼠标选区事件（= 用户仍按着在拖），立即撤销括号选定并恢复成原生拖动选定。
 *
 * 因此整体是「三道闸门 + 两处自愈」：
 *   · 闸门 1 词边界对齐（确定性，零延迟，主判据）；
 *   · 闸门 2 dragGuard（默认 60ms，零延迟）：挡掉「按下即快速拖」的起步帧；
 *   · 闸门 3 confirmDelay（默认 90ms）：命中后先不落选区、等窗口静默再落，判定期完全不触碰选区；
 *   · 自愈 A：selectToBracket 的 await 期间若发现鼠标仍在移动，落地后立刻复位；
 *   · 自愈 B：落地之后只要再来鼠标选区事件，撤销括号选定、把选区复位成原生拖动选定。
 *
 * 为什么自愈必须【显式复位 anchor】：落地动作里 selectToBracket 要先把光标移到括号处，这次程序化
 * setSelection 会把 VSCode 内部的 selectionStart（= 拖拽锚点）从 mousedown 落点劫持走，selectToBracket
 * 再把它推到匹配的开括号上。若只是「放手不管」，后续 MoveToSelect 会以被劫持的锚点继续，选区从那个开
 * 括号一路选到鼠标处（`});` 上表现为跨多行的错乱选区）。只有把 anchor 写回 mousedown 落点，
 * 拖动才会重新变成「按下点 → 鼠标位置」。
 *
 * 另外每次手势只有一次判定机会：首个非空鼠标选区事件之后一律转拖拽态，绝不把选区改回括号，
 * 因此没有「括号 ↔ 拖拽」的来回切换/闪烁。
 *
 * 【务必注意的时序陷阱】onDidChangeTextEditorSelection 是跨进程异步事件，所以「我们自己写入的选区」
 * 引发的回声事件可能在同步标志（busy）复位之后才到达，靠标志过滤不住。必须按内容识别回声，
 * 见 rememberEcho —— 否则中间态空选区会被当成「用户新按下鼠标」，把 gesture.applied 清掉，
 * 自愈 B 失效，大面积括号选定就留在编辑器里出不来。所有写选区都要走 setSelection。
 *
 * 物理限制：扩展只能在 VSCode 渲染选区【之后】收到事件、无法拦在其前。若想在鼠标移动【过程中】持续
 * 显示括号选定，就必须逐帧盖掉 VSCode 的拖拽选区 → 必然来回切换，故不做。
 */
function registerBracketPairSelectionOnDoubleClick(context: vscode.ExtensionContext) {
    // 持续跟踪「光标当前所在的单点位置」，作为紧接而来的双击选词的真实点击点。
    // 关键：即便双击时光标未移动（第一击不产生事件），这里也已是该位置。
    // at = 该位置产生的时刻，供 dragGuard 做「按下→首个非空选区」的间隔判定。
    let lastCaret: { uri: string; position: vscode.Position; at: number } | undefined;
    // 落地（await selectToBracket）期间观察到的鼠标非空选区事件 —— 说明用户其实在拖拽。
    let sawMouseWhileApplying: vscode.Position | undefined;
    // 落地流程是否仍在进行（同步标志，仅用于给 sawMouseWhileApplying 划一个记录窗口）。
    // 【不能】用它来过滤「我们自己改选区引发的事件」——见 rememberEcho 的说明。
    let busy = false;

    // === 识别「我们自己写入的选区」：必须按内容匹配，不能靠 busy 标志 ===
    // onDidChangeTextEditorSelection 是【跨进程异步事件】（渲染进程 → 扩展宿主 IPC），
    // 而 busy 是同步布尔。实际时序是：
    //   ① editor.selection = 单点        → 事件 E1 排入 IPC 队列
    //   ② await selectToBracket          → 事件 E2 排队
    //   ③ finally { busy = false }
    //   ④ E1、E2 这时才到达 —— busy 早已是 false
    // 于是 E1（空选区）会被当成「用户新按下一次鼠标」：覆盖 lastCaret、重置 gesture，
    // 把 gesture.applied 一并清掉 → 自愈 B 再也不会执行 → 大面积括号选定与被劫持的拖拽锚点
    // 就永久留在编辑器里（reload 窗口后首次 IPC 未预热、延迟最大，故那一次必然复现）。
    // 因此改用与 enclosingSymbol.ts 相同的做法：记下自己写入的选区，事件到达时按内容比对并跳过。
    let pendingEchoes: vscode.Selection[] = [];

    const rememberEcho = (sel: vscode.Selection) => {
        pendingEchoes.push(sel);
        // 一次落地最多产生 3 个回声（中间态单点 + selectToBracket 结果 + 自愈复位）；
        // 留点余量并限长，避免异常情况下无限增长或旧回声误吞用户的真实事件。
        if (pendingEchoes.length > 4) { pendingEchoes.shift(); }
    };

    const isEcho = (sel: vscode.Selection): boolean => {
        const i = pendingEchoes.findIndex(e => e.anchor.isEqual(sel.anchor) && e.active.isEqual(sel.active));
        if (i < 0) { return false; }
        pendingEchoes.splice(i, 1); // 消费掉，防止同一回声挡住后续同位置的真实操作
        return true;
    };

    // 写选区的唯一入口：写完立刻登记回声，保证登记发生在事件到达之前
    //（命令/赋值是同步的，IPC 事件必然更晚）。
    const setSelection = (editor: vscode.TextEditor, sel: vscode.Selection) => {
        editor.selection = sel;
        rememberEcho(sel);
    };
    // 本手势（自上次空选区起）的状态：
    //   seq     = 手势序号，让确认窗口的延时回调识别自己是否已过期；
    //   judged  = 本手势的判定机会已用掉（首个非空鼠标选区事件已处理，无论是否命中）；
    //   isDrag  = 已判定拖拽，进入后永久放行、不再干预；
    //   timer   = 确认窗口尚未落定的定时器；
    //   applied = 已落地过括号选定，值为该手势的 mousedown 落点（= 复位拖拽锚点用的位置）。
    //             只要之后还收到鼠标选区事件（说明用户仍按着在拖），就据它撤销括号选定、恢复拖动选定。
    let gestureSeq = 0;
    let gesture: {
        seq: number;
        judged: boolean;
        isDrag: boolean;
        timer?: ReturnType<typeof setTimeout>;
        applied?: vscode.Position;
    } = { seq: 0, judged: false, isDrag: false };

    const cancelPendingSelect = () => {
        if (gesture.timer) {
            clearTimeout(gesture.timer);
            gesture.timer = undefined;
        }
    };
    // 插件卸载时清掉悬空定时器
    context.subscriptions.push({ dispose: cancelPendingSelect });

    // 配置变更即让缓存失效，保证「改了立刻生效」（见 pairSelectSettings 处的说明）。
    // 不传 scope，这样按语言/按工作区文件夹的覆盖变更也能命中。
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (PAIR_SELECT_CONFIG_KEYS.some(key => e.affectsConfiguration(key))) {
                invalidatePairSelectCache();
            }
        })
    );

    /**
     * 真正落选区。仅在确认窗口静默（已确认不是拖拽）后调用。
     * 所有写选区都走 setSelection（登记回声），否则自己引发的异步事件会被误当成用户操作。
     * 引号 / 字符串内括号两条分支是同步的；唯有 selectToBracket 需要「先移光标再执行命令」，
     * 故它带自愈：await 期间若发现鼠标仍在移动，把选区恢复成以 mousedown 落点为锚的原生拖拽选区，
     * 修掉被 selectToBracket 劫持的拖拽锚点。
     */
    const applyPairSelection = async (
        editor: vscode.TextEditor,
        anchor: vscode.Position,
        clickLine: number,
        lineText: string,
        hitCol: number,
        hitChar: string
    ) => {
        busy = true;
        sawMouseWhileApplying = undefined;
        try {
            if (QUOTES.has(hitChar)) {
                // 命中「双击紧挨引号」：同行扫描配对引号，选中整对引号内容（含两端引号，与括号行为一致）。
                // selectToBracket 不认引号，故这里自行计算区间；同步一次性改选区，无需 await。
                const pair = findMatchingQuoteOnLine(lineText, hitCol, hitChar);
                if (pair) {
                    setSelection(editor, new vscode.Selection(
                        new vscode.Position(clickLine, pair[0]),
                        new vscode.Position(clickLine, pair[1] + 1)
                    ));
                }
                return;
            }

            // 命中「双击紧挨括号」。先判断该括号是否在字符串字面量内部：
            const strRange = stringContentRangeAt(lineText, hitCol);
            if (strRange) {
                // 字符串内：括号只是普通文本，selectToBracket（语言感知）会忽略它、误选外层语法括号
                // （如 log('[x]') 双击 [ 会选中整个 (...)）。改为在该字符串范围内做纯文本配对，选中 [...] 本身。
                const pair = findMatchingBracketOnLine(lineText, hitCol, hitChar, strRange.start, strRange.end);
                if (pair) {
                    setSelection(editor, new vscode.Selection(
                        new vscode.Position(clickLine, pair[0]),
                        new vscode.Position(clickLine, pair[1] + 1)
                    ));
                }
                return;
            }

            // 非字符串内：把光标定位到括号所在列（其左边界，右邻即目标括号），交给 VSCode 内置命令
            // selectToBracket 选中整对括号（selectBrackets:true = 连同括号一起选），跨行/嵌套/语言感知都由它处理。
            // 关键：光标放 hitCol 而非 hitCol+1——对连续括号（如 map(( ）+1 会落到第二个 ( 上，
            // 导致 selectToBracket 选中第二个括号对；放在括号左边界则右邻明确是本括号，选中的就是它这一对。
            const insidePos = new vscode.Position(clickLine, hitCol);
            setSelection(editor, new vscode.Selection(insidePos, insidePos));
            await vscode.commands.executeCommand('editor.action.selectToBracket', { selectBrackets: true });
            // 命令改出来的选区同样是「我们引发的」，登记为回声。
            // 此处读取是同步的，而它的事件要经 IPC 才到达，故登记一定早于事件 —— 顺序是安全的。
            rememberEcho(editor.selection);

            // 自愈 A：await 期间来了鼠标非空选区事件 → 用户其实在拖拽。
            // 此时 selectionStart 已被劫持到匹配的开括号上，必须显式把 anchor 复位到 mousedown 落点，
            // 否则后续 MoveToSelect 会从那个开括号一路选到鼠标处（`});` 上表现为跨多行的错乱选区）。
            const dragActive = sawMouseWhileApplying;
            if (dragActive) {
                gesture.isDrag = true;
                gesture.applied = undefined;
                setSelection(editor, new vscode.Selection(anchor, dragActive));
            }
        } catch (err) {
            console.error('[context-window] bracket/quote selection failed:', err);
        } finally {
            sawMouseWhileApplying = undefined;
            busy = false;
        }
    };

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async (e) => {
            const editor = e.textEditor;
            if (!editor || e.selections.length !== 1) { return; }

            const doc = editor.document;
            const uri = doc.uri.toString();
            const sel = e.selections[0];
            const isMouse = e.kind === vscode.TextEditorSelectionChangeKind.Mouse;

            // 第一件事：跳过「我们自己写入的选区」。必须放在最前面、且按内容比对——
            // 这些事件经 IPC 异步到达，很可能落在 busy 复位之后（reload 窗口后的首次尤其如此），
            // 若不在此拦掉，那个中间态空选区就会被当成「用户新按下鼠标」，覆盖 lastCaret 并重置
            // gesture（连 gesture.applied 一起清掉），自愈 B 便再也不会执行。详见 rememberEcho。
            if (isEcho(sel)) { return; }

            if (busy) {
                // 落地期间的鼠标非空选区事件 = 用户仍在拖拽，记下最新位置供 applyPairSelection 自愈。
                if (!sel.isEmpty && isMouse) {
                    sawMouseWhileApplying = sel.active;
                }
                return;
            }

            // 跟踪单点光标位置：任何来源（鼠标单击 / 键盘移动 / 程序化定位）的空选区都视为「光标现在在这」。
            // 这是解决「光标未移动则双击第一击无事件」的核心——点击点始终有值。
            // 空选区 = 新一轮手势的起点（如 mousedown 落点）：重置手势状态并丢弃上一手势未落定的确认窗口。
            // 注意这条分支是最热的（其它逻辑的程序化光标移动都会走到这），所以只做赋值、不读配置。
            if (sel.isEmpty) {
                lastCaret = { uri, position: sel.active, at: Date.now() };
                cancelPendingSelect();
                gesture = { seq: ++gestureSeq, judged: false, isDrag: false };
                return;
            }

            // 非空选区：只有鼠标触发才可能是「双击选词」；键盘/程序化选择一律忽略（也天然防循环）。
            if (!isMouse) { return; }

            // 行号栏单击/双击会产生整行选区，落点不在括号旁；放行走行号双击选符号，避免误用过期 lastCaret 命中括号。
            if (isSingleFullLineSelection(doc, sel)) { return; }

            // 本手势已判定为拖拽 → 全部放行，让 VSCode 原生拖拽选择生效，不再干预。
            // 拖拽中的绝大多数事件在此返回，故这之前不做任何配置读取。
            if (gesture.isDrag) { return; }

            // 判定机会已用掉（已落地，或确认窗口仍在等），又来新的鼠标选区事件 → 鼠标仍在移动
            //（真双击此后不会再有事件）。单向切换为拖拽态并【永久】放手。
            // 这也保证了「按住不松一路拖过括号」的中途帧不会被误命中。
            if (gesture.judged || gesture.timer) {
                cancelPendingSelect();
                gesture.isDrag = true;

                // 自愈 B（关键）：本手势已经落地过括号选定，而用户仍按着在拖 → 撤销它、回到原生拖动选定。
                // 有一类误判在原理上无法消除：当双击落点恰好是选词区间的起点时（如 `});` 行紧贴 } 处，
                // 落点 == separator 段 `});` 的词首），「双击选 `});`」与「从落点拖到行尾」的选区完全等价，
                // 选词指纹、时间闸门都区分不了。此时唯一正确的补救就是这里——一旦发现还在拖就恢复。
                // 必须显式复位 anchor：落地时 selectToBracket 已把 VSCode 内部的 selectionStart（拖拽锚点）
                // 劫持到匹配的开括号上，只有把它写回 mousedown 落点，后续 MoveToSelect 才会重新以
                // 「按下点 → 鼠标位置」拖选；否则选区会从那个开括号一路选到鼠标处。
                const appliedAnchor = gesture.applied;
                gesture.applied = undefined;
                if (appliedAnchor) {
                    try {
                        // 走 setSelection 登记回声：这次复位同样会异步回一个事件，
                        // 不登记的话它会被当成用户操作，把 lastCaret / gesture 再污染一遍。
                        setSelection(editor, new vscode.Selection(appliedAnchor, sel.active));
                    } catch (err) {
                        console.error('[context-window] restoring drag selection failed:', err);
                    }
                }
                return;
            }

            // 走到这里才读配置：每次手势最多一次（上面各分支已把高频事件全部拦掉），且值来自缓存。
            const settings = pairSelectSettings();
            if (!settings.enabled) { return; }

            // 双击点 = 双击前光标位置（lastCaret）。注意此处【不清除】lastCaret，
            // 以支持「在同一位置重复双击」——重复时第一击可能不产生事件，仍需复用该落点。
            const caret = lastCaret;
            if (!caret || caret.uri !== uri) { return; }
            const clickLine = caret.position.line;
            if (clickLine >= doc.lineCount) { return; }
            const lineText = doc.lineAt(clickLine).text;

            // 判定机会就此用掉：无论下面是否命中，本手势后续的鼠标选区事件都走上面的拖拽分支
            //（并在已落地时执行自愈 B）。放在这里而不是命中之后，是为了严格「一次手势一次判定」。
            gesture.judged = true;

            // 先探括号：落点旁没有括号/引号 → 与本功能无关，直接退出，省掉下面的选词计算。
            // 关键：以「双击落点」为基准，向右在容差内查找紧挨的括号（容差 0 = 落点右邻必须就是括号）。
            // 落点右邻既可以是开括号（向右找闭括号），也可以是闭括号（向左回溯开括号）——两种都触发。
            // 不再要求「落点处是单词」——因此括号左边是空格 / 符号 / 另一个括号（没有单词）时也能触发，例如：
            //   foo( 双击紧贴 ( 处、` (` 括号左侧是空格、`)(` 内层括号左侧是 )、以及「紧贴 ) 左侧」双击等。
            let hitCol = -1;
            let hitChar = '';
            for (let d = 0; d <= NEAR_BRACKET_TOLERANCE; d++) {
                const c = lineText.charAt(caret.position.character + d);
                // 括号（成对异形）或引号（成对同形）都视为可触发的「紧挨字符」
                if (BRACKET_PAIRS[c] || CLOSE_TO_OPEN[c] || QUOTES.has(c)) { hitCol = caret.position.character + d; hitChar = c; break; }
                // 容差内若遇到非空白的实义字符则停止（避免把落点误判为远处括号/引号的紧挨）
                if (c !== '' && c !== ' ' && c !== '\t') { break; }
            }
            if (hitCol < 0) { return; }

            // 闸门 1（词边界对齐，确定性、始终生效、零延迟）：双击必然先经过内核选词，
            // 其结果总是一整段同类字符；而单击拖拽逐字符扩展，除非恰好停在类别边界否则对不齐。
            // 用「对齐」而不是「精确等于复刻出的选词区间」，是为了兼容不同 VSCode 版本 / 衍生版
            // （Cursor 等）之间 word() 行为的差异，详见 isMaximalCharClassRun 上方的说明。
            if (sel.start.line !== clickLine
                || sel.end.line !== clickLine
                || !isMaximalCharClassRun(lineText, sel.start.character, sel.end.character, wordSeparatorsFor(doc))) {
                gesture.isDrag = true;
                return;
            }

            // 闸门 2（时间，零延迟）：距「按下产生的空选区」太近 → 是「按下即拖」的起步帧，不是双击。
            // 双击的两击间隔远大于此阈值；而「光标本就在双击点」时 caret.at 是更早的时刻，间隔同样很大，
            // 故该过滤只挡拖拽，不影响任何双击场景。判定为拖拽后进入永久放行态。
            if (settings.dragGuardMs > 0 && Date.now() - caret.at < settings.dragGuardMs) {
                gesture.isDrag = true;
                return;
            }

            const anchor = caret.position;

            // 闸门 3（确认窗口）：先不落选区，等窗口静默再落——判定期不触碰选区，漏判也就不会留下
            // 被劫持的拖拽锚点。窗口内若再来鼠标选区事件，上面的拖拽分支会撤销并锁定拖拽态。
            // 有了选词指纹后它只用于兜住「指纹碰撞」的窄情形，可按手感调小甚至关闭。
            if (settings.confirmDelayMs > 0) {
                const seq = gesture.seq;
                const scheduledSel = sel;
                gesture.timer = setTimeout(() => {
                    // 手势已翻篇（新一轮空选区）→ 丢弃，且不得触碰新手势的 timer 引用
                    if (gesture.seq !== seq) { return; }
                    gesture.timer = undefined;
                    if (gesture.isDrag) { return; }
                    // 选区在等待期间被别的来源改过（如程序化跳转）→ 丢弃，避免把选区拽回旧位置
                    if (editor.document.uri.toString() !== uri
                        || editor.selections.length !== 1
                        || !editor.selection.isEqual(scheduledSel)) {
                        return;
                    }
                    // 记下落点：万一这是慢速拖拽（窗口静默期恰好没有新事件），后续一旦再来鼠标事件，
                    // 自愈 B 会据此撤销括号选定并把拖拽锚点复位回落点。
                    gesture.applied = anchor;
                    void applyPairSelection(editor, anchor, clickLine, lineText, hitCol, hitChar);
                }, settings.confirmDelayMs);
                return;
            }

            // confirmDelay = 0：即时落地。漏判由自愈 A / B 兜底（拖动一旦继续即恢复原生拖动选定）。
            gesture.applied = anchor;
            await applyPairSelection(editor, anchor, clickLine, lineText, hitCol, hitChar);
        })
    );
}

// 从 editor.tokenColorCustomizations 读取 #include 指令的前景色
function readIncludeColor(): string {
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

/**
 * 注册 #include / #pragma / #region / #endregion 等预处理指令的装饰器高亮。
 * 仅当 contextView.contextWindow.fixToken 开启时生效，并随字体/颜色配置变更自动刷新。
 */
function registerDirectiveDecorations(context: vscode.ExtensionContext) {
    const contextWindowConfig = vscode.workspace.getConfiguration('contextView.contextWindow');
    if (!contextWindowConfig.get('fixToken', false)) {
        return;
    }

    let includeColor = readIncludeColor();
    const fontWeight = String(vscode.workspace.getConfiguration('editor').get('fontWeight') || 'normal');

    let decorationTypeInclude = vscode.window.createTextEditorDecorationType({
        color: includeColor,
        fontStyle: fontWeight === 'bold' ? 'oblique' : 'normal',
        fontWeight: fontWeight,
    });

    function updateDecorations() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !['c', 'cc', 'cpp', 'h', 'hpp', 'csharp'].includes(editor.document.languageId)) {
            return;
        }

        const text = editor.document.getText();
        const includeDecorations: vscode.DecorationOptions[] = [];

        const regex = /(?:^|\n)[ \t]*#[ \t]*(include|pragma|region|endregion)\b/g;
        let match;
        while ((match = regex.exec(text))) {
            const startPos = editor.document.positionAt(match.index);
            const endPos = editor.document.positionAt(match.index + match[0].length);
            // include / pragma / region / endregion 都使用同一种装饰
            includeDecorations.push({ range: new vscode.Range(startPos, endPos) });
        }

        editor.setDecorations(decorationTypeInclude, includeDecorations);
    }

    vscode.window.onDidChangeActiveTextEditor(updateDecorations, null, context.subscriptions);
    vscode.workspace.onDidChangeTextDocument(event => {
        if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
            updateDecorations();
        }
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('editor.fontWeight') ||
            e.affectsConfiguration('editor.fontSize') ||
            e.affectsConfiguration('editor.tokenColorCustomizations')) {

            includeColor = readIncludeColor();
            const newFontWeight = String(vscode.workspace.getConfiguration('editor').get('fontWeight') || 'normal');

            // 重建装饰器
            decorationTypeInclude.dispose();
            decorationTypeInclude = vscode.window.createTextEditorDecorationType({
                color: includeColor,
                fontStyle: newFontWeight === 'bold' ? 'oblique' : 'normal',
                fontWeight: newFontWeight,
            });
            updateDecorations();
        }
    }, null, context.subscriptions);

    updateDecorations();
}
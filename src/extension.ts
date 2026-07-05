import * as vscode from 'vscode';
import { ContextWindowProvider } from './contextView';

export function activate(context: vscode.ExtensionContext) {

    const provider = new ContextWindowProvider(context.extensionUri);
    context.subscriptions.push(provider);

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
        vscode.commands.registerCommand('vscode-context-window.navigateUri', async (uri?: string, range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
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
                    await provider.navigateCommand(uriInput, inputRange);
                    vscode.window.showInformationMessage(`Navigated to ${uriInput}:${inputRange.start.line}:${inputRange.start.character}-${inputRange.end.line}:${inputRange.end.character}`);
                    
                } catch (error) {
                    vscode.window.showErrorMessage(`Navigation failed: ${error}`);
                }
            } else {
                // 如果提供了参数，直接执行导航
                await provider.navigateCommand(uri, range);
            }
        }));
    
    registerDirectiveDecorations(context);
    registerBracketPairSelectionOnDoubleClick(context);
}

// 开括号 → 对应闭括号（含尖括号 <>，用于模板/泛型 如 vector<int>）
const BRACKET_PAIRS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '<': '>' };
// 闭括号 → 对应开括号（用于「双击紧贴闭括号左侧」时向左回溯匹配的开括号）
const CLOSE_TO_OPEN: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{', '>': '<' };
// 注：括号匹配（跨行 / 嵌套 / 语言感知，正确处理字符串与注释里的括号）交给 VSCode 内置命令
// editor.action.selectToBracket 处理；本扩展只负责判定「双击是否紧挨括号」并把光标定位到括号内侧。

// 引号字符：开闭同形（双引号 / 单引号 / 反引号），VSCode 无对应的 selectToBracket，需自行扫描配对。
const QUOTES: ReadonlySet<string> = new Set(['"', "'", '`']);

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
 * 如何区分「双击」与「从括号左侧按下不松往右拖拽」（二者事件形态一致，无法就单个事件区分）：
 * 采用「即时命中 + 滞后释放」——首个事件立即选中括号对（手感与纯双击版完全一致，零延迟）；
 * 之后真双击不再产生鼠标选区事件、括号选区自然保持；而拖拽会持续产生新事件，我们在「锁定窗口」内
 * 稳定重申括号选区以抵抗轻微抖动/误触，一旦持续移动超过窗口（BRACKET_LOCK_MS）即判定为拖拽，
 * 放手交还 VSCode 原生拖拽选择，并在本手势剩余时间不再干预。
 */
function registerBracketPairSelectionOnDoubleClick(context: vscode.ExtensionContext) {
    // 括号选定「锁定窗口」(ms)：即时选中括号对后，此窗口内若鼠标继续移动，则保持括号选定（抵抗抖动/误触）；
    // 超过此窗口仍在持续移动 → 判定为拖拽，交还原生拖拽选择。调大 = 更“黏”、更不易被误拖散；
    // 调小 = 从括号处发起拖拽时更快脱离括号选定。按手感调整即可。
    const BRACKET_LOCK_MS = 200;

    // 持续跟踪「光标当前所在的单点位置」+ 记录时间，作为紧接而来的双击选词的真实点击点。
    // 关键：即便双击时光标未移动（第一击不产生事件），这里也已是该位置。
    let lastCaret: { uri: string; position: vscode.Position; time: number } | undefined;
    // 程序化操作（定位光标 + selectToBracket）期间置真：忽略由此引发的事件，避免污染 lastCaret / 重入判定
    let busy = false;
    // 本手势（自上次空选区起）的状态：是否已即时触发过括号选定、触发时刻、已触发的选区、以及是否已判定为拖拽。
    let gesture: { fired: boolean; firedTime: number; range?: vscode.Selection; isDrag: boolean }
        = { fired: false, firedTime: 0, isDrag: false };

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async (e) => {
            if (busy) { return; }
            const editor = e.textEditor;
            if (!editor || e.selections.length !== 1) { return; }

            const doc = editor.document;
            const uri = doc.uri.toString();
            const sel = e.selections[0];

            // 跟踪单点光标位置：任何来源（鼠标单击 / 键盘移动 / 程序化定位）的空选区都视为「光标现在在这」。
            // 这是解决「光标未移动则双击第一击无事件」的核心——点击点始终有值。
            // 空选区 = 新一轮手势的起点（如 mousedown 落点）：重置手势状态并记录时间。
            if (sel.isEmpty) {
                lastCaret = { uri, position: sel.active, time: Date.now() };
                gesture = { fired: false, firedTime: 0, isDrag: false };
                return;
            }

            // 非空选区：只有鼠标触发才可能是「双击选词」；键盘/程序化选择一律忽略（也天然防循环）。
            if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) { return; }

            // 本手势已判定为拖拽 → 全部放行，让 VSCode 原生拖拽选择生效，不再干预。
            if (gesture.isDrag) { return; }

            const enabled = vscode.workspace
                .getConfiguration('contextView.contextWindow')
                .get<boolean>('selectBracketPairOnDoubleClick', true);
            if (!enabled) { return; }

            // 双击点 = 双击前光标位置（lastCaret）。注意此处【不清除】lastCaret，
            // 以支持「在同一位置重复双击」——重复时第一击可能不产生事件，仍需复用该落点。
            const caret = lastCaret;
            if (!caret || caret.uri !== uri) { return; }

            // 已即时触发过括号选定，却又来了新的鼠标选区事件 → 鼠标仍在移动（真双击不会再有事件）。
            if (gesture.fired) {
                if (Date.now() - gesture.firedTime > BRACKET_LOCK_MS) {
                    // 超过锁定窗口仍在移动 → 判定为拖拽：放手，让本次(拖拽)选区保留，且本手势剩余时间不再干预。
                    gesture.isDrag = true;
                    return;
                }
                // 仍在锁定窗口内 → 稳定重申已选中的括号/引号对，抵抗轻微抖动/误触（同步直接设选区，不重跑命令）。
                if (gesture.range) {
                    busy = true;
                    try { editor.selection = gesture.range; } finally { busy = false; }
                }
                return;
            }

            // 关键：以「双击落点」为基准，向右在容差内查找紧挨的括号（容差 0 = 落点右邻必须就是括号）。
            // 落点右邻既可以是开括号（向右找闭括号），也可以是闭括号（向左回溯开括号）——两种都触发。
            // 不再要求「落点处是单词」——因此括号左边是空格 / 符号 / 另一个括号（没有单词）时也能触发，例如：
            //   foo( 双击紧贴 ( 处、` (` 括号左侧是空格、`)(` 内层括号左侧是 )、以及「紧贴 ) 左侧」双击等。
            const clickLine = caret.position.line;
            const lineText = doc.lineAt(clickLine).text;
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

            busy = true;
            try {
                if (QUOTES.has(hitChar)) {
                    // 命中「双击紧挨引号」：同行扫描配对引号，选中整对引号内容（含两端引号，与括号行为一致）。
                    // selectToBracket 不认引号，故这里自行计算区间；同步一次性改选区，无需 await。
                    const pair = findMatchingQuoteOnLine(lineText, hitCol, hitChar);
                    if (pair) {
                        editor.selection = new vscode.Selection(
                            new vscode.Position(clickLine, pair[0]),
                            new vscode.Position(clickLine, pair[1] + 1)
                        );
                    }
                } else {
                    // 命中「双击紧挨括号」：把光标定位到括号所在列（其左边界，右邻即目标括号），交给 VSCode 内置命令
                    // selectToBracket 选中整对括号（selectBrackets:true = 连同括号一起选）。VSCode 匹配是语言感知的。
                    // 关键：光标放 hitCol 而非 hitCol+1——对连续括号（如 map(( ）+1 会落到第二个 ( 上，
                    // 导致 selectToBracket 选中第二个括号对；放在括号左边界则右邻明确是本括号，选中的就是它这一对。
                    const insidePos = new vscode.Position(clickLine, hitCol);
                    editor.selection = new vscode.Selection(insidePos, insidePos);
                    await vscode.commands.executeCommand('editor.action.selectToBracket', { selectBrackets: true });
                }
                // 记录「本手势已即时触发括号选定」+ 触发时刻 + 结果选区（供锁定窗口内稳定重申）。
                gesture.fired = true;
                gesture.firedTime = Date.now();
                gesture.range = editor.selection;
            } catch (err) {
                console.error('[context-window] bracket/quote selection failed:', err);
            } finally {
                busy = false;
            }
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
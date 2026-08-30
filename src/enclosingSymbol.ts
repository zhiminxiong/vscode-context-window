import * as vscode from 'vscode';

const CONFIG_SECTION = 'contextView.contextWindow';
const CONFIG_VSCODE = 'doubleClickSelectsSymbol';

/** 行号栏双击：两次整行选区的最大间隔（略宽于常见系统双击阈值）。 */
const GUTTER_DOUBLE_CLICK_MS = 700;

/**
 * 行号双击要扩选的「容器」符号。
 * 方法体内 → 该函数；类成员属性 → 外层 class；namespace 级声明 → namespace。
 * 始终取包含当前行的最小（嵌套最深）容器。
 */
const CALLABLE_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor,
]);

const CONTAINER_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
    ...CALLABLE_KINDS,
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Struct,
    vscode.SymbolKind.Interface,
    vscode.SymbolKind.Enum,
    vscode.SymbolKind.Namespace,
    vscode.SymbolKind.Module,
    vscode.SymbolKind.Package,
]);

export interface EnclosingCallable {
    name: string;
    kind: vscode.SymbolKind;
    range: vscode.Range;
    selectionRange: vscode.Range;
    detail: string;
}

function rangeContainsLine(range: vscode.Range, line: number): boolean {
    return range.start.line <= line && line <= range.end.line;
}

/** a 是否比 b 更小（更内层）。行跨度优先，同等时起点更靠后 / 终点更靠前。 */
function isSmallerRange(a: vscode.Range, b: vscode.Range): boolean {
    const aLines = a.end.line - a.start.line;
    const bLines = b.end.line - b.start.line;
    if (aLines !== bLines) {
        return aLines < bLines;
    }
    if (a.start.line !== b.start.line) {
        return a.start.line > b.start.line;
    }
    if (a.end.line !== b.end.line) {
        return a.end.line < b.end.line;
    }
    if (a.start.character !== b.start.character) {
        return a.start.character > b.start.character;
    }
    return a.end.character < b.end.character;
}

function asRange(value: unknown): vscode.Range | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    if (value instanceof vscode.Range) {
        return value;
    }
    const r = value as { start?: vscode.Position; end?: vscode.Position };
    if (r.start && r.end && typeof r.start.line === 'number' && typeof r.end.line === 'number') {
        return new vscode.Range(r.start, r.end);
    }
    return undefined;
}

function collectContainers(symbols: readonly unknown[] | undefined, out: vscode.Range[]): void {
    if (!symbols) {
        return;
    }
    for (const raw of symbols) {
        const s = raw as vscode.DocumentSymbol & vscode.SymbolInformation;
        const range = asRange(s.range) ?? asRange(s.location?.range);
        if (CONTAINER_KINDS.has(s.kind) && range) {
            out.push(range);
        }
        if (Array.isArray(s.children) && s.children.length) {
            collectContainers(s.children, out);
        }
    }
}

function collectCallables(symbols: readonly unknown[] | undefined, out: EnclosingCallable[]): void {
    if (!symbols) {
        return;
    }
    for (const raw of symbols) {
        const s = raw as vscode.DocumentSymbol & vscode.SymbolInformation;
        const range = asRange(s.range) ?? asRange(s.location?.range);
        const selectionRange = asRange(s.selectionRange) ?? range;
        if (CALLABLE_KINDS.has(s.kind) && range && selectionRange) {
            out.push({
                name: s.name,
                kind: s.kind,
                range,
                selectionRange,
                detail: (s.detail || '').trim()
            });
        }
        if (Array.isArray(s.children) && s.children.length) {
            collectCallables(s.children, out);
        }
    }
}

/**
 * 当前行所属的最小函数 / 方法 / 构造函数（不含 class / namespace）。
 * @param line 0-based
 */
export async function enclosingCallable(uri: vscode.Uri, line: number): Promise<EnclosingCallable | undefined> {
    let symbols: unknown;
    try {
        symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
    } catch {
        return undefined;
    }
    const list = Array.isArray(symbols) ? symbols : undefined;
    const found: EnclosingCallable[] = [];
    collectCallables(list, found);
    let best: EnclosingCallable | undefined;
    for (const item of found) {
        if (!rangeContainsLine(item.range, line)) {
            continue;
        }
        if (!best || isSmallerRange(item.range, best.range)) {
            best = item;
        }
    }
    return best;
}

/**
 * 当前行所属的最小函数 / 方法 / 类 / 命名空间等容器的整段 range。
 * 先走 document symbol；没有结果再退到折叠区间（覆盖 LSP 尚未就绪的情况）。
 * @param line 0-based
 */
export async function enclosingSymbolRange(uri: vscode.Uri, line: number): Promise<vscode.Range | undefined> {
    const fromSymbols = await rangeFromDocumentSymbols(uri, line);
    if (fromSymbols) {
        return fromSymbols;
    }
    return rangeFromFolding(uri, line);
}

async function rangeFromDocumentSymbols(uri: vscode.Uri, line: number): Promise<vscode.Range | undefined> {
    let symbols: unknown;
    try {
        symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
    } catch {
        return undefined;
    }
    const list = Array.isArray(symbols) ? symbols : undefined;
    const containers: vscode.Range[] = [];
    collectContainers(list, containers);
    let best: vscode.Range | undefined;
    for (const range of containers) {
        if (!rangeContainsLine(range, line)) {
            continue;
        }
        if (!best || isSmallerRange(range, best)) {
            best = range;
        }
    }
    return best;
}

async function rangeFromFolding(uri: vscode.Uri, line: number): Promise<vscode.Range | undefined> {
    let folds: vscode.FoldingRange[] | undefined;
    try {
        folds = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
            'vscode.executeFoldingRangeProvider',
            uri
        );
    } catch {
        return undefined;
    }
    if (!folds?.length) {
        return undefined;
    }
    let best: vscode.FoldingRange | undefined;
    for (const fold of folds) {
        if (fold.start > line || line > fold.end) {
            continue;
        }
        const span = fold.end - fold.start;
        const bestSpan = best ? best.end - best.start : Number.POSITIVE_INFINITY;
        if (!best || span < bestSpan || (span === bestSpan && fold.start > best.start)) {
            best = fold;
        }
    }
    if (!best) {
        return undefined;
    }
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const endLine = Math.min(best.end, doc.lineCount - 1);
        return new vscode.Range(best.start, 0, endLine, doc.lineAt(endLine).text.length);
    } catch {
        return new vscode.Range(best.start, 0, best.end, 0);
    }
}

/**
 * 是否为「点行号」产生的单行整行选区：
 * (line, 0) → (line+1, 0)（含换行）或 (line, 0) → 行尾。
 * 多行选区（行号栏拖拽）返回 false。
 */
export function isSingleFullLineSelection(doc: vscode.TextDocument, sel: vscode.Selection): boolean {
    if (sel.isEmpty || sel.start.character !== 0) {
        return false;
    }
    const line = sel.start.line;
    if (sel.end.line === line + 1 && sel.end.character === 0) {
        return true;
    }
    if (sel.end.line === line) {
        return sel.end.character >= doc.lineAt(line).text.length;
    }
    return false;
}

function isMouseLike(kind: vscode.TextEditorSelectionChangeKind | undefined): boolean {
    return kind === vscode.TextEditorSelectionChangeKind.Mouse || kind === undefined;
}

/**
 * VSCode 主编辑器：行号栏双击选中当前行所属的最小容器符号。
 *
 * 扩展 API 拿不到鼠标落点。行号单击会选出整行；双击往往再次写出同一选区，
 * 第二次可能不触发 onDidChangeTextEditorSelection。做法：
 * 第一次整行选区后，立刻把选区方向反转（视觉仍是整行），使第二击必然产生变化。
 * 配置 doubleClickSelectsSymbol 默认关闭。
 */
export function registerLineNumberSymbolSelection(context: vscode.ExtensionContext): void {
    let lastGutter: { uri: string; line: number; time: number } | undefined;
    let busy = false;
    let ignoreUntil = 0;

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async (e) => {
            if (busy) {
                return;
            }
            // 反转选区的回声可能是 Command / undefined，短窗口内丢掉；真鼠标第二击不能丢。
            if (Date.now() < ignoreUntil && e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
                return;
            }
            const editor = e.textEditor;
            if (!editor || e.selections.length !== 1) {
                return;
            }

            const doc = editor.document;
            const uri = doc.uri.toString();
            const sel = e.selections[0];

            if (sel.isEmpty) {
                lastGutter = undefined;
                return;
            }

            if (e.kind === vscode.TextEditorSelectionChangeKind.Keyboard
                || e.kind === vscode.TextEditorSelectionChangeKind.Command) {
                return;
            }
            if (!isMouseLike(e.kind)) {
                return;
            }

            const enabled = vscode.workspace
                .getConfiguration(CONFIG_SECTION)
                .get<boolean>(CONFIG_VSCODE, false);
            if (!enabled) {
                lastGutter = undefined;
                return;
            }

            const now = Date.now();
            const fullLine = isSingleFullLineSelection(doc, sel);
            const line = sel.start.line;

            if (!fullLine) {
                if (sel.start.line !== sel.end.line) {
                    lastGutter = undefined;
                    return;
                }
                if (
                    lastGutter
                    && lastGutter.uri === uri
                    && lastGutter.line === line
                    && now - lastGutter.time < GUTTER_DOUBLE_CLICK_MS
                ) {
                    lastGutter = undefined;
                    await applyEnclosingSelection(editor, line);
                }
                return;
            }

            if (
                lastGutter
                && lastGutter.uri === uri
                && lastGutter.line === line
                && now - lastGutter.time < GUTTER_DOUBLE_CLICK_MS
            ) {
                lastGutter = undefined;
                await applyEnclosingSelection(editor, line);
                return;
            }

            lastGutter = { uri, line, time: now };
            reverseLineSelection(editor, sel);
        })
    );

    /**
     * 反转整行选区的锚点/活动端。视觉不变，但 Selection 不相等，
     * 下一击行号写出默认方向时一定能再收到 selection 事件。
     * 若编辑器把方向折回，再改「是否含换行」作为兜底。
     */
    function reverseLineSelection(editor: vscode.TextEditor, sel: vscode.Selection): void {
        busy = true;
        ignoreUntil = Date.now() + 80;
        try {
            const reversed = new vscode.Selection(sel.active, sel.anchor);
            editor.selection = reversed;
            const after = editor.selection;
            if (!after.anchor.isEqual(sel.anchor) || !after.active.isEqual(sel.active)) {
                return;
            }
            const line = sel.start.line;
            const lineLen = editor.document.lineAt(line).text.length;
            if (lineLen <= 0) {
                return;
            }
            const withNl = sel.end.line === line + 1 && sel.end.character === 0;
            editor.selection = withNl
                ? new vscode.Selection(line, 0, line, lineLen)
                : (line + 1 < editor.document.lineCount
                    ? new vscode.Selection(line, 0, line + 1, 0)
                    : reversed);
        } finally {
            busy = false;
        }
    }

    async function applyEnclosingSelection(editor: vscode.TextEditor, line: number): Promise<void> {
        busy = true;
        try {
            const range = await enclosingSymbolRange(editor.document.uri, line);
            if (!range) {
                return;
            }
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } catch (err) {
            console.error('[context-window] line-number symbol selection failed:', err);
        } finally {
            busy = false;
        }
    }
}

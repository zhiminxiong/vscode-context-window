import * as vscode from 'vscode';

const CONFIG_SECTION = 'contextView.contextWindow';
const CONFIG_VSCODE = 'doubleClickSelectsSymbol';

/** 行号栏双击：两次整行选区的最大间隔（略宽于常见系统双击阈值）。 */
const GUTTER_DOUBLE_CLICK_MS = 700;
/** 与第一击至少相隔这么久才算第二击，滤掉按下瞬间的轻微拖动。 */
const GUTTER_MIN_SECOND_CLICK_MS = 100;
/**
 * 候选第二击先等这么久再扩选：期间若又来鼠标选区事件，说明是在拖行号，放弃。
 * 「按住不放拖动」的第一次同行移动与真正的第二击写出的选区完全相同，只能靠后续有没有
 * 继续变化来区分——拖动会一直来事件，双击不会。
 */
const GUTTER_CONFIRM_MS = 120;

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

/** Getters/setters and arrow fields are Property/Field in document symbols. */
const ENCLOSING_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
    ...CALLABLE_KINDS,
    vscode.SymbolKind.Property,
    vscode.SymbolKind.Field,
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
    uri?: vscode.Uri;
}

const VALUE_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
    vscode.SymbolKind.Variable,
    vscode.SymbolKind.Field,
    vscode.SymbolKind.Property,
    vscode.SymbolKind.Constant,
    vscode.SymbolKind.EnumMember
]);

const TYPE_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
    vscode.SymbolKind.Interface,
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Struct,
    vscode.SymbolKind.Enum,
    vscode.SymbolKind.TypeParameter
]);

export function isValueRelationKind(kind: vscode.SymbolKind): boolean {
    return VALUE_KINDS.has(kind);
}

export function isReferenceRelationKind(kind: vscode.SymbolKind): boolean {
    return VALUE_KINDS.has(kind) || TYPE_KINDS.has(kind);
}

/** Call signatures in .d.ts are often named "()". */
export function isAnonymousSymbolName(name: string): boolean {
    const n = (name || '').trim();
    return !n || n === '()' || /^<?anonymous>?$/i.test(n);
}

function rangeContainsPosition(range: vscode.Range, position: vscode.Position): boolean {
    if (position.line < range.start.line || position.line > range.end.line) {
        return false;
    }
    if (position.line === range.start.line && position.character < range.start.character) {
        return false;
    }
    if (position.line === range.end.line && position.character > range.end.character) {
        return false;
    }
    return true;
}

function collectNamedSymbols(symbols: readonly unknown[] | undefined, out: EnclosingCallable[]): void {
    if (!symbols) {
        return;
    }
    for (const raw of symbols) {
        const s = raw as vscode.DocumentSymbol & vscode.SymbolInformation;
        const range = asRange(s.range) ?? asRange(s.location?.range);
        const named = asRange(s.selectionRange);
        const selectionRange = named ?? range;
        if (range && selectionRange && s.name) {
            out.push({
                name: s.name,
                kind: s.kind,
                range,
                selectionRange,
                detail: (s.detail || '').trim()
            });
        }
        if (Array.isArray(s.children) && s.children.length) {
            collectNamedSymbols(s.children, out);
        }
    }
}

async function documentSymbols(uri: vscode.Uri): Promise<EnclosingCallable[]> {
    let symbols: unknown;
    try {
        symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
    } catch {
        return [];
    }
    const found: EnclosingCallable[] = [];
    collectNamedSymbols(Array.isArray(symbols) ? symbols : undefined, found);
    return found;
}

function identFromName(name: string): string {
    const stripped = (name || '').replace(/^\((?:get|set)\)\s+/i, '').replace(/^(?:get|set)\s+/i, '').trim();
    const callback = /^(.*?)\(\)\s+callback$/i.exec(stripped);
    const base = (callback?.[1] || stripped || '').trim();
    return base.replace(/\(.*\)$/, '').split(/::|\./).pop() || base;
}

async function wordAt(uri: vscode.Uri, position: vscode.Position): Promise<string> {
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const range = doc.getWordRangeAtPosition(position);
        return range ? identFromName(doc.getText(range)) : '';
    } catch {
        return '';
    }
}

function pickNamedAt(found: EnclosingCallable[], position: vscode.Position): EnclosingCallable | undefined {
    let best: EnclosingCallable | undefined;
    for (const item of found) {
        if (!rangeContainsPosition(item.selectionRange, position)) {
            continue;
        }
        if (!best || isSmallerRange(item.selectionRange, best.selectionRange)) {
            best = item;
        }
    }
    return best;
}

function pickNamedOverlapping(found: EnclosingCallable[], range: vscode.Range): EnclosingCallable | undefined {
    const mid = new vscode.Position(
        range.start.line,
        Math.floor((range.start.character + range.end.character) / 2)
    );
    return pickNamedAt(found, range.start) || pickNamedAt(found, mid);
}

/**
 * Symbol for the identifier under the cursor. Prefer Go to Definition so a
 * field use inside a constructor is not classified as the constructor itself.
 * Event / callable-type defs often land on a call signature named "()"; keep
 * the word under the cursor as a property instead.
 */
export async function symbolAtPosition(
    uri: vscode.Uri,
    position: vscode.Position
): Promise<EnclosingCallable | undefined> {
    const word = await wordAt(uri, position);
    const fromDef = await resolveViaDefinition(uri, position, word);
    if (fromDef && !isAnonymousSymbolName(fromDef.name)
        && (!word || identFromName(fromDef.name) === word)) {
        return fromDef;
    }
    const local = pickNamedAt(await documentSymbols(uri), position);
    if (local && word && identFromName(local.name) === word) {
        return { ...local, uri };
    }
    if (word && fromDef && (isAnonymousSymbolName(fromDef.name) || identFromName(fromDef.name) !== word)) {
        const wr = await wordRangeAt(uri, position);
        if (wr) {
            return {
                name: word,
                kind: vscode.SymbolKind.Property,
                range: wr,
                selectionRange: wr,
                detail: '',
                uri
            };
        }
    }
    return fromDef && !isAnonymousSymbolName(fromDef.name)
        ? fromDef
        : undefined;
}

async function wordRangeAt(
    uri: vscode.Uri,
    position: vscode.Position
): Promise<vscode.Range | undefined> {
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        return doc.getWordRangeAtPosition(position);
    } catch {
        return undefined;
    }
}

function symbolFromDefLink(
    found: EnclosingCallable[],
    raw: unknown,
    word: string
): EnclosingCallable | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const link = raw as vscode.Location & vscode.LocationLink;
    const defUri = link.targetUri ?? link.uri;
    const defRange = asRange(link.targetSelectionRange)
        ?? asRange(link.targetRange)
        ?? asRange(link.range);
    if (!defUri || !defRange) {
        return undefined;
    }
    const atDef = pickNamedOverlapping(found, defRange);
    if (!atDef || isAnonymousSymbolName(atDef.name)) {
        return undefined;
    }
    if (word && identFromName(atDef.name) !== word) {
        return undefined;
    }
    return { ...atDef, uri: defUri };
}

async function resolveViaDefinition(
    uri: vscode.Uri,
    position: vscode.Position,
    word: string
): Promise<EnclosingCallable | undefined> {
    let defs: unknown;
    try {
        defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);
    } catch {
        return undefined;
    }
    const list = Array.isArray(defs) ? defs : [];
    const byUri = new Map<string, EnclosingCallable[]>();
    let fallback: EnclosingCallable | undefined;
    let anonymous: EnclosingCallable | undefined;
    for (const raw of list) {
        if (!raw || typeof raw !== 'object') {
            continue;
        }
        const link = raw as vscode.Location & vscode.LocationLink;
        const defUri = link.targetUri ?? link.uri;
        if (!defUri) {
            continue;
        }
        const key = defUri.toString();
        let found = byUri.get(key);
        if (!found) {
            found = await documentSymbols(defUri);
            byUri.set(key, found);
        }
        const matched = symbolFromDefLink(found, raw, word);
        if (matched) {
            return matched;
        }
        const defRange = asRange(link.targetSelectionRange)
            ?? asRange(link.targetRange)
            ?? asRange(link.range);
        if (!defRange) {
            continue;
        }
        const atDef = pickNamedOverlapping(found, defRange);
        if (!atDef) {
            continue;
        }
        if (isAnonymousSymbolName(atDef.name)) {
            anonymous = anonymous || { ...atDef, uri: defUri };
            continue;
        }
        if (!fallback) {
            fallback = { ...atDef, uri: defUri };
        }
    }
    return fallback || anonymous;
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
        if (ENCLOSING_KINDS.has(s.kind) && range && selectionRange) {
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
 * 当前行所属的最小函数 / 方法 / 构造函数 / getter / setter（不含 class / namespace）。
 * @param line 0-based
 * @param skipIdent skip innermost symbols whose name is this ident (e.g. do not
 *   group a reference to onDidChangeTextEditorSelection under
 *   "onDidChangeTextEditorSelection() callback")
 */
export async function enclosingCallable(
    uri: vscode.Uri,
    line: number,
    skipIdent?: string
): Promise<EnclosingCallable | undefined> {
    let symbols: unknown;
    try {
        symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
    } catch {
        return undefined;
    }
    const list = Array.isArray(symbols) ? symbols : undefined;
    const found: EnclosingCallable[] = [];
    collectCallables(list, found);
    const skip = (skipIdent || '').trim().toLowerCase();
    let best: EnclosingCallable | undefined;
    for (const item of found) {
        if (!rangeContainsLine(item.range, line)) {
            continue;
        }
        if (skip && identFromName(item.name).toLowerCase() === skip) {
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
 * 扩展 API 既没有行号栏鼠标事件也没有点击计数，只能从 onDidChangeTextEditorSelection
 * 判断「同一行的整行选区在双击间隔内出现两次」。难点是第二击写出的选区与第一击完全相同，
 * VSCode 认为光标状态没变、不再发事件，所以第一击之后必须先把状态改成别的样子。
 *
 * 改法只能用 cursorMove，不能写 editor.selection：
 * 点行号时光标的 selectionStart 是一条整行 Range（L 行 1 列 → L+1 行 1 列）、kind 为 Line，
 * 向下拖用它的起点、向上拖用它的终点，所以两个方向都能包住起始行。写 editor.selection 会把
 * selectionStart 塌缩成一个点、kind 降为 Simple，于是向上拖丢起始行、按住再拖丢首行、
 * 在同一行内微动还会算出空选区。cursorMove 的 select:true 只移动 position、保留 selectionStart，
 * 拖选仍由 VSCode 原生计算。
 *
 * 这里把 position 移到行首：选区范围不变（只是变成反向），视觉上仍是整行，
 * 但与第二击写出的状态不同，第二击必定发事件。
 *
 * 最后一道：按住不放后在同一行内的第一次移动，写出的选区与第二击一模一样，无法当场区分，
 * 因此候选第二击要等 GUTTER_CONFIRM_MS，期间再来事件就当拖动放弃。
 * 配置 doubleClickSelectsSymbol 默认关闭。
 */
export function registerLineNumberSymbolSelection(context: vscode.ExtensionContext): void {
    let lastGutter: { uri: string; line: number; time: number } | undefined;
    let busy = false;
    let echo: vscode.Selection | undefined;
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;

    /** 丢掉我们自己改出来的那次选区变化。 */
    const isEcho = (sel: vscode.Selection): boolean => {
        if (echo && echo.anchor.isEqual(sel.anchor) && echo.active.isEqual(sel.active)) {
            echo = undefined;
            return true;
        }
        return false;
    };

    /** 返回是否确实取消了一次待确认的扩选。 */
    const cancelConfirm = (): boolean => {
        if (confirmTimer === undefined) {
            return false;
        }
        clearTimeout(confirmTimer);
        confirmTimer = undefined;
        return true;
    };

    context.subscriptions.push(
        { dispose: cancelConfirm },
        vscode.window.onDidChangeTextEditorSelection(async (e) => {
            if (busy) {
                return;
            }
            const editor = e.textEditor;
            if (!editor || e.selections.length !== 1) {
                return;
            }

            const doc = editor.document;
            const uri = doc.uri.toString();
            const sel = e.selections[0];

            if (isEcho(sel)) {
                return;
            }
            // 还在等待确认时又有新变化 = 手还按着在拖，不是双击。
            if (cancelConfirm()) {
                lastGutter = undefined;
            }
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

            // 多行或非整行：行号拖选、选词等，交给 VSCode，本次判定作废。
            if (!isSingleFullLineSelection(doc, sel)) {
                lastGutter = undefined;
                return;
            }

            const now = Date.now();
            const line = sel.start.line;

            if (
                lastGutter
                && lastGutter.uri === uri
                && lastGutter.line === line
                && now - lastGutter.time >= GUTTER_MIN_SECOND_CLICK_MS
                && now - lastGutter.time < GUTTER_DOUBLE_CLICK_MS
            ) {
                lastGutter = undefined;
                confirmTimer = setTimeout(() => {
                    confirmTimer = undefined;
                    void applyEnclosingSelection(editor, line);
                }, GUTTER_CONFIRM_MS);
                return;
            }

            lastGutter = { uri, line, time: now };
            await primeSecondClick(editor, sel, line);
        })
    );

    /** 把光标移到该行行首，让第二击必定产生 selection 事件。理由见上方函数注释。 */
    async function primeSecondClick(
        editor: vscode.TextEditor,
        sel: vscode.Selection,
        line: number
    ): Promise<void> {
        if (vscode.window.activeTextEditor !== editor) {
            return;
        }
        const active = sel.active;
        if (active.line === line && active.character === 0) {
            return;
        }
        // 非末行的整行选区停在下一行行首，上移一个模型行即到本行行首；
        // 末行没有下一行、选到行尾，改为左移回行首。
        const args = active.line === line + 1
            ? { to: 'up', by: 'line', value: 1, select: true }
            : active.character > 0
                ? { to: 'left', by: 'character', value: active.character, select: true }
                : undefined;
        if (!args) {
            return;
        }
        busy = true;
        try {
            await vscode.commands.executeCommand('cursorMove', args);
            echo = editor.selection;
        } catch (err) {
            console.error('[context-window] gutter double-click prime failed:', err);
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
            echo = editor.selection;
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } catch (err) {
            console.error('[context-window] line-number symbol selection failed:', err);
        } finally {
            busy = false;
        }
    }
}

import * as vscode from 'vscode';
import { CallRelationModel } from './callRelation';

/**
 * Reuse Show Relation's incoming walk (callers of a function, or reference
 * sites of a variable / field / type), then put every site into the built-in
 * REFERENCES sidebar (not the peek widget).
 */
export async function findRelation(loc?: { uri?: vscode.Uri; position?: vscode.Position }): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const uri = loc?.uri ?? editor?.document.uri;
    const position = loc?.position ?? editor?.selection.active;
    if (!uri || !position) {
        void vscode.window.showInformationMessage('Open a file and put the cursor on a symbol to find its relations.');
        return;
    }

    await showInReferencesView(uri, position);
}

export type CollectedCallers = {
    locations: vscode.Location[];
    title: string;
    mode?: 'call' | 'reference';
    truncated?: boolean;
    empty?: string;
};

let findGen = 0;
let findCts: vscode.CancellationTokenSource | undefined;

function beginFindGeneration(): { gen: number; token: vscode.CancellationToken } {
    findCts?.cancel();
    findCts?.dispose();
    findCts = new vscode.CancellationTokenSource();
    return { gen: ++findGen, token: findCts.token };
}

function findStillCurrent(gen: number, ...tokens: (vscode.CancellationToken | undefined)[]): boolean {
    if (gen !== findGen) {
        return false;
    }
    return tokens.every(t => !t || !t.isCancellationRequested);
}

export async function collectCallerLocationsAt(
    uri: vscode.Uri,
    position: vscode.Position,
    options?: { silent?: boolean; token?: vscode.CancellationToken }
): Promise<CollectedCallers | undefined> {
    const silent = !!options?.silent;
    const token = options?.token;
    const session = beginFindGeneration();
    const model = new CallRelationModel();
    const run = async (
        progress: { report(value: { message?: string }): void },
        progressToken: vscode.CancellationToken
    ) => {
        const cancel = () => model.reset();
        const sub = progressToken.onCancellationRequested(cancel);
        const extra = token?.onCancellationRequested(cancel);
        const sessionSub = session.token.onCancellationRequested(cancel);
        try {
            progress.report({ message: 'Loading relation…' });
            const load = await model.loadIncomingRoot(uri, position);
            if (!findStillCurrent(session.gen, progressToken, token, session.token)) {
                return undefined;
            }
            if (!load || load.graph.empty) {
                if (!silent) {
                    void vscode.window.showInformationMessage(
                        load?.graph.empty || 'No relation at this position.'
                    );
                }
                return {
                    locations: [],
                    title: load?.graph.title || '',
                    mode: load?.graph.mode,
                    empty: load?.graph.empty
                };
            }
            const what = load.graph.mode === 'reference' ? 'references' : 'callers';
            progress.report({ message: `Collecting ${what} of ${load.graph.title}…` });
            const result = await model.collectCallerLocations((fetched, n) => {
                progress.report({
                    message: `Collecting ${what} of ${load.graph.title}… ${n} sites (${fetched} symbols)`
                });
            });
            if (!findStillCurrent(session.gen, progressToken, token, session.token) || result.empty === 'Cancelled.') {
                return undefined;
            }
            return result;
        } finally {
            sub.dispose();
            extra?.dispose();
            sessionSub.dispose();
            model.reset();
        }
    };
    try {
        if (silent) {
            return await run({ report() { /* jump 跟踪时不弹通知 */ } }, token ?? { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) });
        }
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Find Relation',
            cancellable: true
        }, run);
    } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (!silent) {
            void vscode.window.showErrorMessage(`Find Relation failed: ${text}`);
        }
        return undefined;
    }
}

async function showInReferencesView(
    uri: vscode.Uri,
    position: vscode.Position
): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const word = doc.getWordRangeAtPosition(position) || doc.getWordRangeAtPosition(position, /[^\s]+/);
    const anchor = new vscode.Location(uri, word?.start ?? position);

    const ext = vscode.extensions.getExtension('vscode.references-view')
        || vscode.extensions.getExtension('ms-vscode.references-view');
    const api = ext ? await ext.activate() as { setInput?(input: FindRelationTreeInput): void | Thenable<void> } : undefined;
    const setInput = api?.setInput
        ? (input: FindRelationTreeInput) => api.setInput!(input)
        : undefined;
    if (typeof setInput !== 'function') {
        const collected = await collectCallerLocationsAt(uri, position, { silent: true });
        if (!collected?.locations.length) {
            void vscode.window.showInformationMessage(collected?.empty || 'No relations at this position.');
            return;
        }
        await vscode.commands.executeCommand('editor.action.showReferences', uri, position, collected.locations);
        return;
    }
    try {
        await vscode.commands.executeCommand('references-view.clear');
    } catch {
        // 面板里还没有结果时，这条命令可能不可用。
    }
    // resolve() 立刻交出空树，旧列表先消失；收集完再刷新。
    await Promise.resolve(setInput(new FindRelationTreeInput(anchor)));
}

class FindRelationTreeInput {
    readonly contextValue = 'vscode.executeReferenceProvider';
    readonly title = 'References';

    constructor(readonly location: vscode.Location) { }

    async resolve(): Promise<CallerTreeModel | undefined> {
        const model = new CallerTreeModel([], 'Loading relation…');
        void vscode.window.withProgress(
            { location: { viewId: 'references-view.tree' } },
            async () => {
                const collected = await collectCallerLocationsAt(
                    this.location.uri,
                    this.location.range.start,
                    { silent: true }
                );
                if (!collected) {
                    return;
                }
                if (!collected.locations.length) {
                    model.replace([], collected.empty || `No relations of “${collected.title}”.`);
                    return;
                }
                model.replace(collected.locations);
            }
        );
        return model;
    }

    with(location: vscode.Location): FindRelationTreeInput {
        return new FindRelationTreeInput(location);
    }
}

let treeGen = 0;

class FileRow {
    constructor(
        readonly uri: vscode.Uri,
        readonly refs: RefRow[],
        readonly gen: number
    ) { }
}

class RefRow {
    constructor(
        readonly location: vscode.Location,
        readonly file: FileRow
    ) { }
}

type TreeRow = FileRow | RefRow;

class CallerTreeModel {
    readonly provider: CallerTreeDataProvider;
    message: string | undefined;
    readonly navigation = this;
    readonly highlights = this;
    readonly dnd = this;
    readonly items: FileRow[] = [];

    constructor(locations: vscode.Location[], message?: string) {
        this.provider = new CallerTreeDataProvider(this);
        this.replace(locations, message);
    }

    replace(locations: vscode.Location[], message?: string): void {
        this.items.length = 0;
        const gen = ++treeGen;
        let last: FileRow | undefined;
        const sorted = [...locations].sort(compareLocations);
        for (const loc of sorted) {
            if (!last || last.uri.toString() !== loc.uri.toString()) {
                last = new FileRow(loc.uri, [], gen);
                this.items.push(last);
            }
            last.refs.push(new RefRow(loc, last));
        }
        const total = locations.length;
        const files = this.items.length;
        this.message = message ?? (files === 1
            ? `${total} result${total === 1 ? '' : 's'} in 1 file`
            : `${total} results in ${files} files`);
        this.provider.refresh();
    }

    dispose(): void {
        this.provider.dispose();
    }

    location(item: TreeRow): vscode.Location {
        return item instanceof RefRow
            ? item.location
            : new vscode.Location(item.uri, item.refs[0]?.location.range ?? new vscode.Position(0, 0));
    }

    nearest(uri: vscode.Uri, position: vscode.Position): TreeRow | undefined {
        const file = this.items.find(f => f.uri.toString() === uri.toString());
        if (file) {
            return file.refs.find(r => r.location.range.contains(position)) || file.refs[0];
        }
        return this.items[0]?.refs[0];
    }

    next(from: TreeRow): TreeRow {
        return this.move(from, 1) ?? from;
    }

    previous(from: TreeRow): TreeRow {
        return this.move(from, -1) ?? from;
    }

    getEditorHighlights(_item: TreeRow, uri: vscode.Uri): vscode.Range[] | undefined {
        return this.items.find(f => f.uri.toString() === uri.toString())?.refs.map(r => r.location.range);
    }

    getDragUri(item: TreeRow): vscode.Uri | undefined {
        return item instanceof FileRow ? item.uri : item.location.uri;
    }

    private move(item: TreeRow, delta: number): RefRow | undefined {
        const flat = this.items.flatMap(f => f.refs);
        if (!flat.length) {
            return undefined;
        }
        const current = item instanceof RefRow ? item : (delta > 0 ? item.refs[0] : item.refs[item.refs.length - 1]);
        const idx = flat.indexOf(current);
        if (idx < 0) {
            return flat[0];
        }
        return flat[(idx + delta + flat.length) % flat.length];
    }
}

class CallerTreeDataProvider implements vscode.TreeDataProvider<TreeRow> {
    private readonly emitter = new vscode.EventEmitter<TreeRow | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly model: CallerTreeModel) { }

    refresh(): void {
        this.emitter.fire(undefined);
    }

    dispose(): void {
        this.emitter.dispose();
    }

    getTreeItem(element: TreeRow): vscode.TreeItem | Thenable<vscode.TreeItem> {
        if (element instanceof FileRow) {
            const item = new vscode.TreeItem(element.uri);
            item.id = `cw-rel:${element.gen}:file:${element.uri.toString()}`;
            item.contextValue = 'file-item';
            item.description = true;
            item.iconPath = vscode.ThemeIcon.File;
            item.collapsibleState = this.model.items.length <= 3
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed;
            return item;
        }
        return this.refItem(element);
    }

    getChildren(element?: TreeRow): TreeRow[] | undefined {
        if (!element) {
            return this.model.items;
        }
        return element instanceof FileRow ? element.refs : undefined;
    }

    getParent(element: TreeRow): FileRow | undefined {
        return element instanceof RefRow ? element.file : undefined;
    }

    private async refItem(element: RefRow): Promise<vscode.TreeItem> {
        const { range } = element.location;
        let before = '';
        let inside = '';
        let after = '';
        try {
            const doc = await vscode.workspace.openTextDocument(element.location.uri);
            const chunks = previewChunks(doc, range);
            before = chunks.before;
            inside = chunks.inside;
            after = chunks.after;
        } catch {
            inside = `${range.start.line + 1}:${range.start.character + 1}`;
        }
        const item = new vscode.TreeItem({
            label: before + inside + after,
            highlights: [[before.length, before.length + inside.length]]
        });
        item.id = `cw-rel:${element.file.gen}:ref:${element.location.uri.toString()}:${range.start.line}:${range.start.character}`;
        item.contextValue = 'reference-item';
        item.command = {
            command: 'vscode.open',
            title: 'Open Reference',
            arguments: [
                element.location.uri,
                { selection: range.with({ end: range.start }) } satisfies vscode.TextDocumentShowOptions
            ]
        };
        return item;
    }
}

function compareLocations(a: vscode.Location, b: vscode.Location): number {
    const ua = a.uri.toString();
    const ub = b.uri.toString();
    if (ua < ub) {
        return -1;
    }
    if (ua > ub) {
        return 1;
    }
    if (a.range.start.isBefore(b.range.start)) {
        return -1;
    }
    if (a.range.start.isAfter(b.range.start)) {
        return 1;
    }
    return 0;
}

function previewChunks(doc: vscode.TextDocument, range: vscode.Range): { before: string; inside: string; after: string } {
    const previewStart = range.start.with({ character: Math.max(0, range.start.character - 8) });
    const wordRange = doc.getWordRangeAtPosition(previewStart);
    let before = doc.getText(new vscode.Range(wordRange ? wordRange.start : previewStart, range.start));
    let inside = doc.getText(range);
    if (!inside) {
        const word = doc.getWordRangeAtPosition(range.start);
        inside = word ? doc.getText(word) : '';
    }
    const previewEnd = range.end.translate(0, 331);
    let after = doc.getText(new vscode.Range(range.end, previewEnd));
    before = before.replace(/^\s*/g, '');
    after = after.replace(/\s*$/g, '');
    return { before, inside, after };
}

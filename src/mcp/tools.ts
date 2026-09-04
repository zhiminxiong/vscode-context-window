import * as path from 'path';
import * as vscode from 'vscode';
import { CALL_MAX_HOP, CallRelationModel, RelationGraph, RelationNode, RelationOpenTarget } from '../callRelation';
import { enclosingCallable, enclosingSymbolRange } from '../enclosingSymbol';

/**
 * Editor-agnostic answers about code structure, for an AI to consume.
 *
 * Everything here is a plain function over the `vscode` API and the existing
 * Relation model — no webview, no panel, no MCP. The transport layer is meant
 * to be a thin shell on top, so the same tool can be reached from an MCP
 * server, a language-model tool, or a command used to eyeball the output.
 *
 * Line and character numbers on this boundary are **1-based**, because that is
 * what an AI has already seen in grep output and in the editor UI. They are
 * converted to the API's 0-based positions on the way in.
 */

/** `no_results` means the language server answered and had nothing. */
export type ToolStatus = 'ok' | 'lsp_not_ready' | 'no_results' | 'not_found';

export interface ToolResult {
    status: ToolStatus;
    /** Ready to hand to a model. Empty only when the status is not `ok`. */
    text: string;
    /** Why the status is what it is, or what was trimmed away. */
    detail?: string;
}

export type RelationDirection = 'callers' | 'callees' | 'both';

export interface RelationQuery {
    /** Absolute path, `file://` URI, or a path relative to a workspace folder. */
    uri: string;
    /** 1-based. */
    line: number;
    /** 1-based. Omit to aim at the symbol declared or named on that line. */
    character?: number;
    /** Identifier on that line to aim at, when `character` is unknown. */
    symbol?: string;
    /** Hops away from the center. 1 = immediate neighbours only. */
    depth?: number;
    direction?: RelationDirection;
}

export interface EnclosingSymbolQuery {
    uri: string;
    /** 1-based. */
    line: number;
    /** Include the symbol's source, not just its range. */
    includeText?: boolean;
}

const DEFAULT_DEPTH = 2;
const DEFAULT_NODE_CAP = 150;
/** Past this the answer costs more tokens than the question is worth. */
const MAX_SITES_PER_EDGE = 3;
const MAX_SNIPPET_CHARS = 160;
const MAX_SYMBOL_TEXT_LINES = 400;
/** One retry is enough to cover "the window just opened". */
const LSP_RETRY_DELAY_MS = 700;

const SYMBOL_KIND_LABELS: readonly string[] = [
    'file', 'module', 'namespace', 'package', 'class', 'method', 'property',
    'field', 'constructor', 'enum', 'interface', 'function', 'variable',
    'constant', 'string', 'number', 'boolean', 'array', 'object', 'key',
    'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'
];

function kindLabel(kind: vscode.SymbolKind): string {
    return SYMBOL_KIND_LABELS[kind] ?? 'symbol';
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The Relation model is a single mutable object with its own generation
 * counter, so two overlapping queries would cancel each other. Keep them in a
 * line rather than handing back half-built graphs.
 */
let pending: Promise<unknown> = Promise.resolve();

function runExclusive<T>(job: () => Promise<T>): Promise<T> {
    const next = pending.then(job, job);
    pending = next.then(() => undefined, () => undefined);
    return next;
}

/** Separate from the panel's model, so an AI query never moves the user's graph. */
let headless: CallRelationModel | undefined;

function headlessModel(): CallRelationModel {
    headless ??= new CallRelationModel();
    return headless;
}

export function disposeToolState(): void {
    headless?.reset();
    headless = undefined;
}

async function resolveUri(raw: string): Promise<vscode.Uri | undefined> {
    const text = (raw || '').trim().replace(/^['"]|['"]$/g, '');
    if (!text) {
        return undefined;
    }
    try {
        const parsed = vscode.Uri.parse(text);
        if (parsed.scheme === 'file') {
            return parsed;
        }
    } catch {
        // Not a URI; fall through to the path forms.
    }
    if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('\\\\')) {
        return vscode.Uri.file(text);
    }
    const relative = text.replace(/^[\\/]+/, '');
    for (const folder of vscode.workspace.workspaceFolders || []) {
        const candidate = vscode.Uri.file(path.join(folder.uri.fsPath, relative));
        try {
            await vscode.workspace.fs.stat(candidate);
            return candidate;
        } catch {
            // Try the next folder.
        }
    }
    return undefined;
}

/** Workspace-relative where possible: absolute paths are mostly wasted tokens. */
function shortPath(target: vscode.Uri | string): string {
    const uri = typeof target === 'string'
        ? (() => {
            try {
                return vscode.Uri.parse(target);
            } catch {
                return vscode.Uri.file(target);
            }
        })()
        : target;
    const relative = vscode.workspace.asRelativePath(uri, false);
    return relative.replace(/\\/g, '/');
}

function identRangesOnLine(text: string): { start: number; name: string }[] {
    const out: { start: number; name: string }[] = [];
    const re = /[A-Za-z_$][\w$]*/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
        out.push({ start: match.index, name: match[0] });
    }
    return out;
}

/**
 * Call hierarchy needs a position on the identifier itself. An AI usually
 * knows the line but not the column, so aim for the symbol declared on that
 * line, then for a named identifier, then for the first one.
 */
async function resolvePosition(
    doc: vscode.TextDocument,
    query: RelationQuery,
    line0: number
): Promise<vscode.Position | undefined> {
    if (line0 < 0 || line0 >= doc.lineCount) {
        return undefined;
    }
    const text = doc.lineAt(line0).text;
    if (typeof query.character === 'number' && query.character > 0) {
        return new vscode.Position(line0, Math.min(query.character - 1, Math.max(0, text.length - 1)));
    }
    const idents = identRangesOnLine(text);
    const wanted = (query.symbol || '').trim();
    if (wanted) {
        const hit = idents.find(i => i.name === wanted);
        if (hit) {
            return new vscode.Position(line0, hit.start);
        }
    }
    const declared = await enclosingCallable(doc.uri, line0);
    if (declared?.selectionRange && declared.selectionRange.start.line === line0) {
        return declared.selectionRange.start;
    }
    return idents.length ? new vscode.Position(line0, idents[0].start) : undefined;
}

/**
 * Tells "the server has not indexed this yet" apart from "there is genuinely
 * nothing here". Document symbols are the cheapest probe that every real
 * source file answers, so an empty result there means the server is not ready.
 * Reporting the two as one would let an AI conclude a function has no callers.
 */
async function documentSymbolsAnswer(uri: vscode.Uri): Promise<boolean> {
    try {
        const symbols = await vscode.commands.executeCommand<unknown[]>(
            'vscode.executeDocumentSymbolProvider',
            uri
        );
        return Array.isArray(symbols) && symbols.length > 0;
    } catch {
        return false;
    }
}

function symbolNodes(graph: RelationGraph, sign: -1 | 1): RelationNode[] {
    return graph.nodes.filter(n => n.kind === 'symbol' && Math.sign(n.hop) === sign);
}

function wantsSide(direction: RelationDirection, sign: -1 | 1): boolean {
    if (direction === 'both') {
        return true;
    }
    return direction === 'callers' ? sign === -1 : sign === 1;
}

async function expandToDepth(
    model: CallRelationModel,
    initial: RelationGraph,
    depth: number,
    direction: RelationDirection,
    nodeCap: number
): Promise<{ graph: RelationGraph; capped: boolean }> {
    let graph = initial;
    let capped = false;
    // expandHop leaves a node unmarked when it cannot grow it (no cached item,
    // or already at the model's hop ceiling), so without this the same node
    // would come back every round.
    const attempted = new Set<string>();
    for (let round = 0; round < depth * 2 + 2; round++) {
        if (graph.nodes.length >= nodeCap) {
            capped = true;
            break;
        }
        const todo = graph.nodes.filter(n => (
            n.kind === 'symbol'
            && n.expandable
            && !n.expanded
            && !n.cyclic
            && n.id !== graph.rootId
            && Math.abs(n.hop) < depth
            && wantsSide(direction, Math.sign(n.hop) as -1 | 1)
            && !attempted.has(n.id)
        ));
        if (!todo.length) {
            break;
        }
        for (const node of todo) {
            if (graph.nodes.length >= nodeCap) {
                capped = true;
                break;
            }
            attempted.add(node.id);
            // Node ids are derived from the item + hop + parent, so one that
            // survived the last expansion still resolves in the newest graph.
            const load = await model.expandHop(node.id, graph.nodes);
            if (load) {
                graph = load.graph;
            }
        }
        if (capped) {
            break;
        }
    }
    return { graph, capped };
}

function renderSites(sites: readonly RelationOpenTarget[] | undefined, indent: string, out: string[]): void {
    if (!sites?.length) {
        return;
    }
    for (const site of sites.slice(0, MAX_SITES_PER_EDGE)) {
        const where = `${shortPath(site.uri)}:${site.line + 1}`;
        let snippet = (site.snippet || '').trim();
        if (snippet.length > MAX_SNIPPET_CHARS) {
            snippet = `${snippet.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
        }
        out.push(snippet ? `${indent}@ ${where}  ${snippet}` : `${indent}@ ${where}`);
    }
    const hidden = sites.length - MAX_SITES_PER_EDGE;
    if (hidden > 0) {
        out.push(`${indent}@ (+${hidden} more call site${hidden === 1 ? '' : 's'})`);
    }
}

function graphHasSites(graph: RelationGraph): boolean {
    return graph.edges.some(edge => edge.sites?.length);
}

function renderNode(
    graph: RelationGraph,
    node: RelationNode,
    parent: RelationNode,
    level: number,
    sign: -1 | 1,
    out: string[]
): void {
    const indent = '  '.repeat(level);
    if (node.kind === 'more') {
        out.push(`${indent}... +${node.moreCount ?? 0} more at this level (not fetched)`);
        return;
    }
    if (node.kind === 'group') {
        out.push(`${indent}${node.name}  (${node.moreCount ?? 0} library symbols, not expanded)`);
        return;
    }
    const where = node.path ? `  ${shortPath(vscode.Uri.file(node.path))}:${node.line}` : '';
    const detail = node.detail ? `  ${node.detail}` : '';
    const cycle = node.cyclic ? '  [cycle]' : '';
    out.push(`${indent}${node.name}${where}${detail}${cycle}`);

    const edge = sign < 0
        ? graph.edges.find(e => e.from === node.id && e.to === parent.id)
        : graph.edges.find(e => e.from === parent.id && e.to === node.id);
    renderSites(edge?.sites, '  '.repeat(level + 1), out);

    for (const child of graph.nodes.filter(n => n.parentId === node.id)) {
        renderNode(graph, child, node, level + 1, sign, out);
    }
}

function renderSide(graph: RelationGraph, root: RelationNode, sign: -1 | 1, heading: string, out: string[]): void {
    const direct = graph.nodes.filter(n => n.parentId === root.id && Math.sign(n.hop) === sign);
    const total = symbolNodes(graph, sign).length;
    if (!direct.length) {
        out.push(`${heading}: none`);
        out.push('');
        return;
    }
    out.push(`${heading} (${total} node${total === 1 ? '' : 's'}):`);
    for (const child of direct) {
        renderNode(graph, child, root, 1, sign, out);
    }
    out.push('');
}

/**
 * Graph to text. Kept separate from fetching so the wording and the token cost
 * can be changed without touching any language-server call, and so a transport
 * that already holds a graph can render it directly.
 */
export function serializeGraph(graph: RelationGraph, direction: RelationDirection, depth: number): string {
    const root = graph.nodes.find(n => n.id === graph.rootId);
    if (!root) {
        return '';
    }
    const reference = graph.mode === 'reference';
    const out: string[] = [];
    const rootWhere = root.path ? `  ${shortPath(vscode.Uri.file(root.path))}:${root.line}` : '';
    out.push(`center: ${root.name}${rootWhere}${root.detail ? `  ${root.detail}` : ''}`);
    out.push(`mode: ${reference ? 'reference' : 'call'}  depth: ${depth}`);
    if (graphHasSites(graph)) {
        // Indentation alone would leave a call site looking like a sibling node.
        out.push('lines starting with @ are call sites: file:line then that source line');
    }
    if (graph.notice) {
        out.push(`note: ${graph.notice}`);
    }
    out.push('');
    if (reference) {
        // References mode only ever fills the incoming side, grouped by the
        // enclosing function of each use.
        renderSide(graph, root, -1, 'REFERENCES, grouped by enclosing function', out);
        return out.join('\n').trimEnd();
    }
    if (wantsSide(direction, -1)) {
        renderSide(graph, root, -1, 'CALLERS', out);
    }
    if (wantsSide(direction, 1)) {
        renderSide(graph, root, 1, 'CALLEES', out);
    }
    return out.join('\n').trimEnd();
}

/**
 * Callers and callees for a function; references grouped by enclosing function
 * for a variable, field, or type. Which one you get is decided by the language
 * server from the symbol at the position, exactly as the Relation panel does,
 * and is reported back as `mode`.
 */
export async function queryRelations(query: RelationQuery): Promise<ToolResult> {
    const uri = await resolveUri(query.uri);
    if (!uri) {
        return { status: 'not_found', text: '', detail: `Cannot resolve a file from "${query.uri}".` };
    }
    const depth = Math.min(Math.max(Math.trunc(query.depth ?? DEFAULT_DEPTH) || DEFAULT_DEPTH, 1), CALL_MAX_HOP);
    const direction: RelationDirection = query.direction ?? 'both';
    const line0 = Math.trunc(query.line) - 1;

    return runExclusive(async () => {
        let doc: vscode.TextDocument;
        try {
            doc = await vscode.workspace.openTextDocument(uri);
        } catch {
            return { status: 'not_found', text: '', detail: `Cannot open ${shortPath(uri)}.` };
        }
        if (line0 < 0 || line0 >= doc.lineCount) {
            return {
                status: 'not_found',
                text: '',
                detail: `${shortPath(uri)} has ${doc.lineCount} lines; line ${query.line} is out of range.`
            };
        }
        const position = await resolvePosition(doc, query, line0);
        if (!position) {
            return {
                status: 'not_found',
                text: '',
                detail: `No identifier on ${shortPath(uri)}:${query.line} to take relations from.`
            };
        }

        const model = headlessModel();
        model.reset();
        let load = await model.loadRoot(uri, position);
        if (!load || load.graph.empty) {
            // Either the server has not indexed yet or there is nothing here.
            await delay(LSP_RETRY_DELAY_MS);
            model.reset();
            load = await model.loadRoot(uri, position);
        }
        if (!load || load.graph.empty) {
            const ready = await documentSymbolsAnswer(uri);
            const at = `${shortPath(uri)}:${query.line}:${position.character + 1}`;
            return ready
                ? {
                    status: 'no_results',
                    text: '',
                    detail: `${load?.graph.empty || 'No relations at this position.'} The language server is answering for ${shortPath(uri)}, so this is a real answer, not a warm-up problem. Checked ${at}.`
                }
                : {
                    status: 'lsp_not_ready',
                    text: '',
                    detail: `The language server returned no document symbols for ${shortPath(uri)}, so it has not finished indexing. Do not read this as "no callers" — retry shortly. Checked ${at}.`
                };
        }

        const { graph, capped } = await expandToDepth(model, load.graph, depth, direction, DEFAULT_NODE_CAP);
        const text = serializeGraph(graph, direction, depth);
        if (!text) {
            return { status: 'no_results', text: '', detail: 'The graph came back without a center.' };
        }
        return {
            status: 'ok',
            text,
            detail: capped
                ? `Stopped at ${DEFAULT_NODE_CAP} nodes; branches marked "more" or left unexpanded were not fetched.`
                : undefined
        };
    });
}

/**
 * The smallest function, method, class, or namespace containing a line, with
 * its real extent. Saves an AI from guessing where a symbol begins and ends;
 * falls back to folding ranges when document symbols are not available yet.
 */
export async function queryEnclosingSymbol(query: EnclosingSymbolQuery): Promise<ToolResult> {
    const uri = await resolveUri(query.uri);
    if (!uri) {
        return { status: 'not_found', text: '', detail: `Cannot resolve a file from "${query.uri}".` };
    }
    const line0 = Math.trunc(query.line) - 1;
    let doc: vscode.TextDocument;
    try {
        doc = await vscode.workspace.openTextDocument(uri);
    } catch {
        return { status: 'not_found', text: '', detail: `Cannot open ${shortPath(uri)}.` };
    }
    if (line0 < 0 || line0 >= doc.lineCount) {
        return {
            status: 'not_found',
            text: '',
            detail: `${shortPath(uri)} has ${doc.lineCount} lines; line ${query.line} is out of range.`
        };
    }

    const [callable, range] = await Promise.all([
        enclosingCallable(uri, line0),
        enclosingSymbolRange(uri, line0)
    ]);
    if (!callable && !range) {
        const ready = await documentSymbolsAnswer(uri);
        return ready
            ? {
                status: 'no_results',
                text: '',
                detail: `Line ${query.line} of ${shortPath(uri)} is not inside a named symbol (top-level code, an import, or a comment).`
            }
            : {
                status: 'lsp_not_ready',
                text: '',
                detail: `No document symbols or folding ranges for ${shortPath(uri)} yet. Retry shortly.`
            };
    }

    const extent = range ?? callable?.range;
    const out: string[] = [];
    const name = callable?.name || '(unnamed)';
    const kind = callable ? kindLabel(callable.kind) : 'block';
    out.push(`symbol: ${name}  (${kind})`);
    out.push(`file: ${shortPath(uri)}`);
    if (extent) {
        out.push(`lines: ${extent.start.line + 1}-${extent.end.line + 1}`);
    }
    if (callable?.detail) {
        out.push(`detail: ${callable.detail}`);
    }
    if (!range && callable) {
        out.push('note: extent came from the symbol range; folding ranges were unavailable.');
    }

    let detail: string | undefined;
    if (query.includeText !== false && extent) {
        const lines = extent.end.line - extent.start.line + 1;
        if (lines > MAX_SYMBOL_TEXT_LINES) {
            detail = `The symbol spans ${lines} lines; source omitted. Read ${shortPath(uri)} lines ${extent.start.line + 1}-${extent.end.line + 1} directly.`;
        } else {
            out.push('');
            out.push(doc.getText(new vscode.Range(extent.start.line, 0, extent.end.line, Number.MAX_SAFE_INTEGER)));
        }
    }
    return { status: 'ok', text: out.join('\n').trimEnd(), detail };
}

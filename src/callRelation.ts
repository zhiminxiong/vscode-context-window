import * as path from 'path';
import * as vscode from 'vscode';
import { enclosingCallable, isAnonymousSymbolName, isReferenceRelationKind, isUsableEnclosingName, symbolAtPosition } from './enclosingSymbol';

export type ChildSort = 'name' | 'order';

export const CALL_PAGE = 12;
export const CALL_MAX_HOP = 8;
/** Each Expand All adds at most this many nodes; run again to continue. */
const CALL_EXPAND_ALL_NODES = 120;
/** Stop remaining prefetch jobs after an incoming peek this large. */
const CALL_HOT_PREFETCH = 200;

export type RelationLoad = { graph: RelationGraph; seq: number };

export type RelationNodeKind = 'symbol' | 'more' | 'group';

export interface RelationNode {
    id: string;
    itemKey: string;
    name: string;
    detail: string;
    file: string;
    path: string;
    line: number;
    hop: number;
    parentId?: string;
    kind: RelationNodeKind;
    moreCount?: number;
    expandable?: boolean;
    expanded?: boolean;
    expandKey?: string;
    compact?: boolean;
    prevCenter?: boolean;
    cyclic?: boolean;
    typeName?: string;
}

export interface RelationEdge {
    from: string;
    to: string;
    sites?: RelationOpenTarget[];
    style?: 'anchor';
}

export interface RelationCenter {
    itemKey: string;
    name: string;
    file: string;
    line: number;
}

export interface RelationGraph {
    rootId: string;
    title: string;
    nodes: RelationNode[];
    edges: RelationEdge[];
    empty?: string;
    notice?: string;
    mode?: 'call' | 'reference';
    centerTrail?: RelationCenter[];
    centerIndex?: number;
}

export interface RelationOpenTarget {
    uri: string;
    line: number;
    character: number;
    name: string;
    file?: string;
    snippet?: string;
}

function isArrowLikeName(name: string): boolean {
    return isAnonymousSymbolName(name) || /\bcallback$/i.test((name || '').trim());
}

/** TS names accessors "(get) foo" / "(set) foo"; anonymous fns "setTimeout() callback". */
function identFromToken(name: string): string {
    const stripped = (name || '').replace(/^\((?:get|set)\)\s+/i, '').replace(/^(?:get|set)\s+/i, '').trim();
    const callback = /^(.*?)\(\)\s+callback$/i.exec(stripped);
    const base = (callback?.[1] || stripped || '').trim();
    return base.replace(/\(.*\)$/, '').split(/::|\./).pop() || base;
}

async function tokenAt(uri: vscode.Uri, position: vscode.Position): Promise<string> {
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const range = doc.getWordRangeAtPosition(position);
        return range ? identFromToken(doc.getText(range)) : '';
    } catch {
        return '';
    }
}

function hoverPlain(hovers: unknown): string {
    const parts: string[] = [];
    if (!Array.isArray(hovers)) {
        return '';
    }
    for (const raw of hovers) {
        const contents = raw && typeof raw === 'object' && 'contents' in raw
            ? (raw as vscode.Hover).contents
            : [];
        for (const c of contents || []) {
            if (typeof c === 'string') {
                parts.push(c);
            } else if (c && typeof c === 'object' && 'value' in c) {
                parts.push(String((c as { value: string }).value));
            }
        }
    }
    return parts.join('\n');
}

function typeFromHoverText(text: string, ident: string): string {
    const stripped = (text || '').replace(/```(?:\w+)?\n?/g, '');
    const named = new RegExp(`\\b${escapeRegExp(ident)}\\s*:\\s*(\\S.*)$`, 'm');
    for (const line of stripped.split(/\r?\n/)) {
        const m = named.exec(line.trim());
        if (m) {
            return m[1].replace(/\s+/g, ' ').trim();
        }
    }
    return '';
}

async function resolveValueType(
    uri: vscode.Uri,
    position: vscode.Position,
    ident: string
): Promise<string> {
    if (!ident) {
        return '';
    }
    try {
        const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
        return typeFromHoverText(hoverPlain(hovers), ident);
    } catch {
        return '';
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split call-hierarchy fromRanges into super/base sites vs other uses of ident. */
async function splitSuperCallRanges(
    uri: vscode.Uri,
    ranges: vscode.Range[] | undefined,
    ident: string
): Promise<{
    superHit?: vscode.Position;
    superRanges: vscode.Range[];
    otherRanges: vscode.Range[];
}> {
    if (!ident || !ranges?.length) {
        return { superRanges: [], otherRanges: ranges ? [...ranges] : [] };
    }
    let doc: vscode.TextDocument;
    try {
        doc = await vscode.workspace.openTextDocument(uri);
    } catch {
        return { superRanges: [], otherRanges: [...ranges] };
    }
    const superRe = new RegExp(`\\b(?:super|base)\\s*\\.\\s*${escapeRegExp(ident)}\\b`);
    const identRe = new RegExp(`\\b${escapeRegExp(ident)}\\b`, 'g');
    const superRanges: vscode.Range[] = [];
    const otherRanges: vscode.Range[] = [];
    let superHit: vscode.Position | undefined;
    for (const range of ranges) {
        const start = Math.min(Math.max(0, range.start.line), doc.lineCount - 1);
        const end = Math.min(Math.max(start, range.end.line), doc.lineCount - 1);
        let hasSuper = false;
        let hasOther = false;
        for (let line = start; line <= end; line++) {
            const text = doc.lineAt(line).text;
            const superMatch = superRe.exec(text);
            if (superMatch) {
                hasSuper = true;
                if (!superHit) {
                    const nameAt = superMatch.index + superMatch[0].length - ident.length;
                    superHit = new vscode.Position(line, nameAt);
                }
            }
            if (/\b(?:override|function)\b/.test(text)
                || /^\s*(?:public|private|protected|internal|export|async|static|readonly|virtual)\b/.test(text)) {
                continue;
            }
            identRe.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = identRe.exec(text))) {
                const before = text.slice(0, match.index);
                if (!/(?:super|base)\s*\.\s*$/.test(before)) {
                    hasOther = true;
                    break;
                }
            }
        }
        if (hasSuper) {
            superRanges.push(range);
        }
        if (hasOther || !hasSuper) {
            otherRanges.push(range);
        }
    }
    return { superHit, superRanges, otherRanges };
}

const TYPE_CONTAINER_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Struct,
    vscode.SymbolKind.Interface
]);

const CALL_ITEM_KINDS: ReadonlySet<vscode.SymbolKind> = new Set([
    vscode.SymbolKind.Method,
    vscode.SymbolKind.Function,
    vscode.SymbolKind.Constructor
]);

const TYPE_SEMANTIC_TYPES = new Set(['class', 'struct', 'interface', 'enum', 'type']);
const MAX_HERITAGE_TYPES = 16;

interface FlatSymbol {
    name: string;
    kind: vscode.SymbolKind;
    range: vscode.Range;
    selectionRange: vscode.Range;
}

interface TypeRef {
    uri: vscode.Uri;
    symbol: FlatSymbol;
    depth: number;
}

interface TypeHierarchyLike {
    name: string;
    kind: vscode.SymbolKind;
    uri: vscode.Uri;
    range: vscode.Range;
    selectionRange: vscode.Range;
}

function typeRefKey(uri: vscode.Uri, symbol: FlatSymbol): string {
    const sel = symbol.selectionRange?.start ?? symbol.range.start;
    return `${uri.toString()}\0${symbol.name}\0${sel.line}\0${sel.character}`;
}

function flattenSymbols(raw: unknown, out: FlatSymbol[]): void {
    if (!Array.isArray(raw)) {
        return;
    }
    for (const node of raw) {
        if (!node || typeof node !== 'object') {
            continue;
        }
        const s = node as vscode.DocumentSymbol & vscode.SymbolInformation;
        const range = s.range ?? s.location?.range;
        const selectionRange = s.selectionRange ?? range;
        if (s.name && range && s.kind !== undefined) {
            out.push({
                name: s.name,
                kind: s.kind,
                range,
                selectionRange
            });
        }
        if (Array.isArray(s.children) && s.children.length) {
            flattenSymbols(s.children, out);
        }
    }
}

function pickContainingType(flat: FlatSymbol[], position: vscode.Position): FlatSymbol | undefined {
    let best: FlatSymbol | undefined;
    for (const sym of flat) {
        if (!TYPE_CONTAINER_KINDS.has(sym.kind) || !rangeContains(sym.range, position)) {
            continue;
        }
        if (!best || rangeContains(best.range, sym.range.start)) {
            best = sym;
        }
    }
    return best;
}

function methodInTypeSymbols(flat: FlatSymbol[], owner: FlatSymbol, ident: string): FlatSymbol | undefined {
    const matches = flat.filter(sym => (
        CALL_ITEM_KINDS.has(sym.kind)
        && identFromToken(sym.name) === ident
        && !isArrowLikeName(sym.name)
        && rangeContains(owner.range, sym.selectionRange.start)
    ));
    return matches.find(sym =>
        sym.kind === vscode.SymbolKind.Method || sym.kind === vscode.SymbolKind.Constructor
    ) || matches[0];
}

function isSuperDispatchLine(text: string, ident: string): boolean {
    return new RegExp(`\\b(?:super|base)\\s*\\.\\s*${escapeRegExp(ident)}\\b`).test(text)
        || new RegExp(`::\\s*${escapeRegExp(ident)}\\s*\\(`).test(text);
}

function isThisDispatchLine(text: string, ident: string): boolean {
    if (isSuperDispatchLine(text, ident) || isIdentDeclLine(text, ident)) {
        return false;
    }
    if (new RegExp(`\\bthis\\s*(?:\\.|->)\\s*${escapeRegExp(ident)}\\b`).test(text)) {
        return true;
    }
    if (new RegExp(`(?:\\.|->|::)\\s*${escapeRegExp(ident)}\\b`).test(text)) {
        return false;
    }
    return new RegExp(`\\b${escapeRegExp(ident)}\\s*\\(`).test(text);
}

function isIdentDeclLine(text: string, ident: string): boolean {
    if (/\b(?:override|function)\b/.test(text)
        && new RegExp(`\\b${escapeRegExp(ident)}\\s*\\(`).test(text)) {
        return true;
    }
    return /^\s*(?:public|private|protected|internal|export|async|static|readonly|virtual)\b/.test(text)
        && new RegExp(`\\b${escapeRegExp(ident)}\\s*\\(`).test(text);
}

/** LSP incoming often includes super/base/:: parent calls and the method header as sites. */
function isParentOrDeclIncomingLine(text: string, ident: string): boolean {
    return isIdentDeclLine(text, ident) || isSuperDispatchLine(text, ident);
}

async function keepNonParentIncomingRanges(
    uri: vscode.Uri,
    ranges: vscode.Range[] | undefined,
    ident: string
): Promise<vscode.Range[]> {
    if (!ranges?.length) {
        return [];
    }
    if (!ident) {
        return [...ranges];
    }
    let doc: vscode.TextDocument;
    try {
        doc = await vscode.workspace.openTextDocument(uri);
    } catch {
        return [...ranges];
    }
    return ranges.filter(range => {
        const line = Math.min(Math.max(0, range.start.line), doc.lineCount - 1);
        return !isParentOrDeclIncomingLine(doc.lineAt(line).text, ident);
    });
}

function decodeSemanticTokens(
    data: ArrayLike<number>,
    legendTypes: string[]
): { line: number; character: number; length: number; type: string }[] {
    const out: { line: number; character: number; length: number; type: string }[] = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
        const deltaLine = data[i];
        const deltaStart = data[i + 1];
        const length = data[i + 2];
        const typeIdx = data[i + 3];
        line += deltaLine;
        character = deltaLine === 0 ? character + deltaStart : deltaStart;
        const type = legendTypes[typeIdx] || '';
        out.push({ line, character, length, type });
    }
    return out;
}

function unwrapTokenData(raw: unknown): ArrayLike<number> | undefined {
    if (!raw) {
        return undefined;
    }
    if (Array.isArray(raw)) {
        return raw;
    }
    if (raw instanceof Uint32Array) {
        return raw;
    }
    if (typeof raw === 'object' && raw && 'data' in raw) {
        const data = (raw as { data: unknown }).data;
        if (Array.isArray(data) || data instanceof Uint32Array) {
            return data;
        }
    }
    return undefined;
}

/** LSP fromRanges often start at the whole call expression, not the callee name. */
export async function callSiteIdentRange(site: RelationOpenTarget): Promise<{
    start: { line: number; character: number };
    end: { line: number; character: number };
}> {
    const ident = identFromToken(site.name);
    const fallback = {
        start: { line: site.line + 1, character: Math.max(1, site.character + 1) },
        end: { line: site.line + 1, character: Math.max(1, site.character + 1) }
    };
    if (!ident) {
        return fallback;
    }
    let lineText = '';
    try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(site.uri));
        const line = Math.min(Math.max(0, site.line), doc.lineCount - 1);
        lineText = doc.lineAt(line).text;
    } catch {
        return fallback;
    }
    const re = new RegExp(`\\b${escapeRegExp(ident)}\\b`, 'g');
    let match: RegExpExecArray | null;
    let chosen: number | undefined;
    while ((match = re.exec(lineText))) {
        if (match.index >= site.character) {
            chosen = match.index;
            break;
        }
        chosen = match.index;
    }
    if (chosen == null) {
        return fallback;
    }
    return {
        start: { line: site.line + 1, character: chosen + 1 },
        end: { line: site.line + 1, character: chosen + ident.length + 1 }
    };
}

function rangeContains(range: vscode.Range | undefined, position: vscode.Position): boolean {
    if (!range?.start || !range?.end) {
        return false;
    }
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

function itemKey(item: vscode.CallHierarchyItem): string {
    const sel = item.selectionRange?.start ?? item.range.start;
    return `${item.uri.toString()}\0${sel.line}\0${sel.character}\0${item.name}`;
}

/** Display sort key: last identifier, case-insensitive (AAAA.bbbb → bbbb). */
function sortName(item: vscode.CallHierarchyItem): string {
    const ident = (item.name || '').replace(/\(.*\)$/, '').trim();
    const last = ident.split(/::|\./).filter(Boolean).pop();
    return last || ident || item.name || '';
}

function compareItems(a: vscode.CallHierarchyItem, b: vscode.CallHierarchyItem): number {
    const byName = sortName(a).localeCompare(sortName(b), undefined, { sensitivity: 'base' });
    if (byName !== 0) {
        return byName;
    }
    return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
}

function visualId(key: string, hop: number, parentId: string): string {
    return `${key}@${hop}@${parentId}`;
}

function ancestorHasItemKey(nodes: RelationNode[], parentId: string | undefined, key: string): boolean {
    if (!parentId || !key) {
        return false;
    }
    const byId = new Map(nodes.map(n => [n.id, n]));
    let cur = byId.get(parentId);
    while (cur) {
        if (cur.itemKey === key) {
            return true;
        }
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return false;
}

function branchKeepKey(parentKey: string, dir: -1 | 1, childKey: string): string {
    return `b:${dir}:${parentKey}\x1e${childKey}`;
}

function keepExpandItemKey(key: string): string {
    if (key.startsWith('self\0')) {
        return key.slice(5);
    }
    const sep = key.lastIndexOf('\x1e');
    return sep >= 0 ? key.slice(sep + 1) : key;
}

/** Outward hop for a keepExpand branch key. `self` has no side. */
function keepExpandDir(key: string): -1 | 1 | undefined {
    if (key.startsWith('b:-1:')) {
        return -1;
    }
    if (key.startsWith('b:1:')) {
        return 1;
    }
    return undefined;
}

function fileLabel(uri: vscode.Uri): string {
    return path.basename(uri.fsPath);
}

function itemLabel(item: vscode.CallHierarchyItem): string {
    const sel = item.selectionRange?.start ?? item.range.start;
    return `${item.name} ${fileLabel(item.uri)}:${sel.line + 1}`;
}

function resultCount(value: unknown): number {
    if (Array.isArray(value)) {
        return value.length;
    }
    return value == null ? 0 : 1;
}

const RELATION_COST = false;
function costLog(layer: string, ms: number, detail = ''): void {
    if (!RELATION_COST) {
        return;
    }
    console.log(`[relation cost] ${layer} ${ms}ms${detail ? ` ${detail}` : ''}`);
}

function isLibPath(fsPath: string): boolean {
    const p = fsPath.replace(/\\/g, '/').toLowerCase();
    return p.endsWith('.d.ts') || p.includes('/node_modules/');
}

export const SLIM_KIND_OPTIONS: readonly { id: string; kind: vscode.SymbolKind; label: string }[] = [
    { id: 'function', kind: vscode.SymbolKind.Function, label: 'Function' },
    { id: 'method', kind: vscode.SymbolKind.Method, label: 'Method' },
    { id: 'constructor', kind: vscode.SymbolKind.Constructor, label: 'Constructor' },
    { id: 'class', kind: vscode.SymbolKind.Class, label: 'Class' },
    { id: 'struct', kind: vscode.SymbolKind.Struct, label: 'Struct' },
    { id: 'variable', kind: vscode.SymbolKind.Variable, label: 'Variable' },
    { id: 'constant', kind: vscode.SymbolKind.Constant, label: 'Constant' },
    { id: 'property', kind: vscode.SymbolKind.Property, label: 'Property' },
    { id: 'file', kind: vscode.SymbolKind.File, label: 'File' },
    { id: 'module', kind: vscode.SymbolKind.Module, label: 'Module' },
    { id: 'namespace', kind: vscode.SymbolKind.Namespace, label: 'Namespace' },
    { id: 'package', kind: vscode.SymbolKind.Package, label: 'Package' },
    { id: 'field', kind: vscode.SymbolKind.Field, label: 'Field' },
    { id: 'enum', kind: vscode.SymbolKind.Enum, label: 'Enum' },
    { id: 'interface', kind: vscode.SymbolKind.Interface, label: 'Interface' },
    { id: 'string', kind: vscode.SymbolKind.String, label: 'String' },
    { id: 'number', kind: vscode.SymbolKind.Number, label: 'Number' },
    { id: 'boolean', kind: vscode.SymbolKind.Boolean, label: 'Boolean' },
    { id: 'array', kind: vscode.SymbolKind.Array, label: 'Array' },
    { id: 'object', kind: vscode.SymbolKind.Object, label: 'Object' },
    { id: 'key', kind: vscode.SymbolKind.Key, label: 'Key' },
    { id: 'null', kind: vscode.SymbolKind.Null, label: 'Null' },
    { id: 'enumMember', kind: vscode.SymbolKind.EnumMember, label: 'EnumMember' },
    { id: 'event', kind: vscode.SymbolKind.Event, label: 'Event' },
    { id: 'operator', kind: vscode.SymbolKind.Operator, label: 'Operator' },
    { id: 'typeParameter', kind: vscode.SymbolKind.TypeParameter, label: 'TypeParameter' }
];

export const DEFAULT_SLIM_KIND_IDS: readonly string[] = [
    'function',
    'method',
    'constructor',
    'class',
    'struct',
    'variable',
    'constant',
    'property'
];

const SLIM_KIND_BY_ID = new Map(SLIM_KIND_OPTIONS.map(item => [item.id, item.kind]));

export function parseSlimKindIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [...DEFAULT_SLIM_KIND_IDS];
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (typeof entry !== 'string' || !SLIM_KIND_BY_ID.has(entry) || seen.has(entry)) {
            continue;
        }
        seen.add(entry);
        ids.push(entry);
    }
    return ids;
}

function kindsFromIds(ids: readonly string[]): Set<vscode.SymbolKind> {
    const kinds = new Set<vscode.SymbolKind>();
    for (const id of ids) {
        const kind = SLIM_KIND_BY_ID.get(id);
        if (kind !== undefined) {
            kinds.add(kind);
        }
    }
    return kinds;
}

function toSymbolNode(
    item: vscode.CallHierarchyItem,
    hop: number,
    parentId: string | undefined,
    expandable: boolean
): RelationNode {
    const key = itemKey(item);
    const sel = item.selectionRange?.start ?? item.range.start;
    return {
        id: parentId ? visualId(key, hop, parentId) : `${key}@0`,
        itemKey: key,
        name: identFromToken(item.name) || item.name,
        detail: (item.detail || '').trim(),
        file: fileLabel(item.uri),
        path: item.uri.fsPath,
        line: sel.line + 1,
        hop,
        parentId,
        kind: 'symbol',
        expandable
    };
}

export class CallRelationModel {
    private readonly items = new Map<string, vscode.CallHierarchyItem>();
    private readonly incoming = new Map<string, vscode.CallHierarchyItem[]>();
    private readonly outgoing = new Map<string, vscode.CallHierarchyItem[]>();
    private readonly callSites = new Map<string, RelationOpenTarget[]>();
    /** super/base calls rewritten to the base method (LSP often points at the override). */
    private readonly superOutgoing = new Map<string, vscode.CallHierarchyItem[]>();
    private readonly shown = new Map<string, number>();
    private readonly expanded = new Set<string>();
    private readonly keepExpand = new Set<string>();
    private readonly keepGroups = new Set<string>();
    /** Node ids the user collapsed; in-flight expandHop must not reopen them. */
    private readonly collapseLock = new Set<string>();
    private root: vscode.CallHierarchyItem | undefined;
    private prevRoot: vscode.CallHierarchyItem | undefined;
    private centerTrail: vscode.CallHierarchyItem[] = [];
    private centerIndex = -1;
    /** Shown on the left until root incoming lands (focus from a callee). */
    private incomingHint: vscode.CallHierarchyItem | undefined;
    /** Variables use Find All References on the left; functions use call hierarchy. */
    private relationMode: 'call' | 'reference' = 'call';
    /** Type shown on the References center tip. */
    private rootTypeName = '';
    /** When true, keep only compactKinds from incoming and outgoing. */
    private compactFilter = false;
    private compactKinds = kindsFromIds(DEFAULT_SLIM_KIND_IDS);
    /** name = A–Z; order = first call (callees) / file then call line (callers). */
    private childSort: ChildSort = 'name';
    private seq = 0;
    private cacheEpoch = 0;
    private readonly fileGen = new Map<string, number>();
    private cts = new vscode.CancellationTokenSource();
    private readonly inflightIn = new Map<string, Promise<void>>();
    private readonly inflightOut = new Map<string, Promise<void>>();
    private graphListener: ((graph: RelationGraph, seq: number) => void) | undefined;

    setGraphListener(listener: ((graph: RelationGraph, seq: number) => void) | undefined): void {
        this.graphListener = listener;
    }

    get generation(): number {
        return this.seq;
    }

    isCurrent(seq: number): boolean {
        return seq === this.seq && !this.cts.token.isCancellationRequested;
    }

    /** Drop in-flight work. Does not clear cached graph data. */
    cancel(): void {
        this.cts.cancel();
        this.cts.dispose();
        this.cts = new vscode.CancellationTokenSource();
        this.seq++;
    }

    reset(): void {
        this.cancel();
        this.clearGraphState();
    }

    private clearGraphState(): void {
        this.items.clear();
        this.incoming.clear();
        this.outgoing.clear();
        this.callSites.clear();
        this.superOutgoing.clear();
        this.shown.clear();
        this.expanded.clear();
        this.keepExpand.clear();
        this.keepGroups.clear();
        this.collapseLock.clear();
        this.root = undefined;
        this.prevRoot = undefined;
        this.centerTrail = [];
        this.centerIndex = -1;
        this.incomingHint = undefined;
        this.relationMode = 'call';
        this.rootTypeName = '';
        this.cacheEpoch++;
        this.fileGen.clear();
        this.inflightIn.clear();
        this.inflightOut.clear();
    }

    rootUri(): string | undefined {
        return this.root?.uri.toString();
    }

    centerLocation(): { uri: vscode.Uri; position: vscode.Position } | undefined {
        const item = (this.centerIndex >= 0 ? this.centerTrail[this.centerIndex] : undefined) || this.root;
        if (!item) {
            return undefined;
        }
        const pos = item.selectionRange?.start ?? item.range.start;
        return { uri: item.uri, position: pos };
    }

    setCompactFilter(on: boolean): void {
        this.compactFilter = on;
    }

    setCompactKinds(ids: readonly string[]): void {
        this.compactKinds = kindsFromIds(ids);
    }

    setChildSort(sort: ChildSort): void {
        this.childSort = sort === 'order' ? 'order' : 'name';
    }

    private firstCallLine(parentKey: string, dir: -1 | 1, child: vscode.CallHierarchyItem): number {
        const sites = this.callSites.get(`${parentKey}\0${dir}\0${itemKey(child)}`);
        if (sites?.length) {
            let min = sites[0].line;
            for (let i = 1; i < sites.length; i++) {
                if (sites[i].line < min) {
                    min = sites[i].line;
                }
            }
            return min;
        }
        const start = child.selectionRange?.start ?? child.range.start;
        return start?.line ?? Number.MAX_SAFE_INTEGER;
    }

    private filePathKey(item: vscode.CallHierarchyItem): string {
        return (item.uri.fsPath || item.uri.toString()).replace(/\\/g, '/').toLowerCase();
    }

    private compareIncomingOrder(
        parentKey: string,
        a: vscode.CallHierarchyItem,
        b: vscode.CallHierarchyItem
    ): number {
        const pathA = this.filePathKey(a);
        const pathB = this.filePathKey(b);
        if (pathA !== pathB) {
            const byFile = fileLabel(a.uri).localeCompare(fileLabel(b.uri), undefined, { sensitivity: 'base' });
            if (byFile !== 0) {
                return byFile;
            }
            return pathA.localeCompare(pathB);
        }
        const byLine = this.firstCallLine(parentKey, -1, a) - this.firstCallLine(parentKey, -1, b);
        if (byLine !== 0) {
            return byLine;
        }
        return compareItems(a, b);
    }

    private compareChildren(
        parentKey: string,
        dir: -1 | 1,
        a: vscode.CallHierarchyItem,
        b: vscode.CallHierarchyItem
    ): number {
        if (this.childSort === 'order') {
            if (dir < 0) {
                return this.compareIncomingOrder(parentKey, a, b);
            }
            const byLine = this.firstCallLine(parentKey, dir, a) - this.firstCallLine(parentKey, dir, b);
            if (byLine !== 0) {
                return byLine;
            }
        }
        return compareItems(a, b);
    }

    private keepCallItem(item: vscode.CallHierarchyItem): boolean {
        return !this.compactFilter || this.compactKinds.has(item.kind);
    }

    private sideList(item: vscode.CallHierarchyItem, dir: -1 | 1): vscode.CallHierarchyItem[] | undefined {
        const key = itemKey(item);
        const raw = dir < 0 ? this.incoming.get(key) : this.outgoing.get(key);
        const extra = dir > 0 ? this.superOutgoing.get(key) : undefined;
        if (!raw && !extra?.length) {
            return undefined;
        }
        const list = (raw || []).filter(child => this.keepCallItem(child));
        if (dir > 0) {
            for (const child of extra || []) {
                if (this.keepCallItem(child) && !list.some(x => itemKey(x) === itemKey(child))) {
                    list.push(child);
                }
            }
        }
        return list;
    }

    invalidateUri(uri: vscode.Uri): void {
        const u = uri.toString();
        this.fileGen.set(u, (this.fileGen.get(u) ?? 0) + 1);
        for (const [key, item] of [...this.items]) {
            if (item.uri.toString() !== u) {
                continue;
            }
            this.items.delete(key);
            this.incoming.delete(key);
            this.outgoing.delete(key);
        }
        for (const [key, list] of [...this.incoming]) {
            this.incoming.set(key, list.filter(item => item.uri.toString() !== u));
        }
        for (const [key, list] of [...this.outgoing]) {
            this.outgoing.set(key, list.filter(item => item.uri.toString() !== u));
        }
        for (const [key, list] of [...this.superOutgoing]) {
            this.superOutgoing.set(key, list.filter(item => item.uri.toString() !== u));
        }
        for (const key of [...this.callSites.keys()]) {
            if (key.includes(u)) {
                this.callSites.delete(key);
            }
        }
    }

    remember(item: vscode.CallHierarchyItem): string {
        const key = itemKey(item);
        if (!this.items.has(key)) {
            this.items.set(key, item);
        }
        return key;
    }

    /** Drop cached sides so a class References visit cannot starve constructor Call. */
    private forgetSides(item: vscode.CallHierarchyItem): void {
        const key = itemKey(item);
        this.incoming.delete(key);
        this.outgoing.delete(key);
        this.inflightIn.delete(key);
        this.inflightOut.delete(key);
        const prefix = `${key}\0`;
        for (const siteKey of [...this.callSites.keys()]) {
            if (siteKey.startsWith(prefix)) {
                this.callSites.delete(siteKey);
            }
        }
    }

    private resetCenter(item: vscode.CallHierarchyItem): void {
        this.centerTrail = [item];
        this.centerIndex = 0;
    }

    private recordCenter(item: vscode.CallHierarchyItem): void {
        const key = itemKey(item);
        const cur = this.centerIndex >= 0 ? this.centerTrail[this.centerIndex] : undefined;
        if (cur && itemKey(cur) === key) {
            return;
        }
        const found = this.centerTrail.findIndex(it => itemKey(it) === key);
        if (found >= 0) {
            this.centerIndex = found;
            return;
        }
        this.centerTrail = this.centerTrail.slice(0, this.centerIndex + 1);
        this.centerTrail.push(item);
        this.centerIndex = this.centerTrail.length - 1;
        if (this.centerTrail.length > 24) {
            const drop = this.centerTrail.length - 24;
            this.centerTrail = this.centerTrail.slice(drop);
            this.centerIndex -= drop;
        }
    }

    private centerSnapshot(): RelationCenter[] {
        return this.centerTrail.map(item => {
            const sel = item.selectionRange?.start ?? item.range.start;
            return {
                itemKey: itemKey(item),
                name: identFromToken(item.name) || item.name,
                file: fileLabel(item.uri),
                line: sel.line + 1
            };
        });
    }

    private attachCenterTrail(graph: RelationGraph): RelationGraph {
        graph.centerTrail = this.centerSnapshot();
        graph.centerIndex = Math.max(0, this.centerIndex);
        graph.mode = this.relationMode;
        return graph;
    }

    /** 旧中心是调用链左边那一截，出现在图左侧 callers；右边是之后才走进去的中心。 */
    private syncPrevFromTrail(): void {
        this.prevRoot = this.centerIndex > 0 ? this.centerTrail[this.centerIndex - 1] : undefined;
    }

    private openedFromCallSite(uri: vscode.Uri, position: vscode.Position, item: vscode.CallHierarchyItem): boolean {
        return item.uri.toString() !== uri.toString() || !rangeContains(item.range, position);
    }

    private sideEmpty(item: vscode.CallHierarchyItem, dir: -1 | 1): boolean {
        const list = dir < 0 ? this.incoming.get(itemKey(item)) : this.outgoing.get(itemKey(item));
        return !!list && list.length === 0;
    }

    private sideHas(item: vscode.CallHierarchyItem, dir: -1 | 1): boolean {
        const list = dir < 0 ? this.incoming.get(itemKey(item)) : this.outgoing.get(itemKey(item));
        return (list?.length ?? 0) > 0;
    }

    private lspEmptyGraph(seq: number): { graph: RelationGraph; seq: number } {
        return {
            graph: this.emptyGraph('The language server returned no call hierarchy.'),
            seq
        };
    }

    private asLocation(raw: unknown): vscode.Location | undefined {
        if (!raw || typeof raw !== 'object') {
            return undefined;
        }
        const loc = raw as vscode.Location & vscode.LocationLink;
        if (loc.uri && loc.range) {
            return loc;
        }
        const uri = loc.targetUri;
        const range = loc.targetSelectionRange ?? loc.targetRange;
        if (uri && range) {
            return new vscode.Location(uri, range);
        }
        return undefined;
    }

    private isDeclSite(root: vscode.CallHierarchyItem, loc: vscode.Location): boolean {
        if (loc.uri.toString() !== root.uri.toString()) {
            return false;
        }
        const decl = root.selectionRange ?? root.range;
        return !!decl.intersection(loc.range);
    }

    private async referenceRootItem(
        uri: vscode.Uri,
        position: vscode.Position,
        name: string
    ): Promise<vscode.CallHierarchyItem> {
        const found = await symbolAtPosition(uri, position);
        if (found) {
            return new vscode.CallHierarchyItem(
                found.kind,
                found.name,
                found.detail,
                found.uri ?? uri,
                found.range,
                found.selectionRange
            );
        }
        const word = name || 'symbol';
        const range = new vscode.Range(position, position);
        return new vscode.CallHierarchyItem(vscode.SymbolKind.Variable, word, '', uri, range, range);
    }

    private async loadReferenceRoot(
        uri: vscode.Uri,
        position: vscode.Position,
        seq: number,
        t0: number
    ): Promise<{ graph: RelationGraph; seq: number } | undefined> {
        const name = await tokenAt(uri, position);
        const refs = await this.execLsp<vscode.Location[]>(
            seq,
            'vscode.executeReferenceProvider',
            uri,
            position
        );
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        const root = await this.referenceRootItem(uri, position, name);
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        if (this.root && this.relationMode === 'reference' && itemKey(this.root) === itemKey(root)) {
            this.prevRoot = undefined;
            this.incomingHint = undefined;
            return { graph: this.buildGraph(), seq };
        }
        this.shown.clear();
        this.expanded.clear();
        this.keepExpand.clear();
        this.keepGroups.clear();
        this.collapseLock.clear();
        this.prevRoot = undefined;
        this.incomingHint = undefined;
        this.relationMode = 'reference';
        this.root = root;
        this.remember(this.root);
        this.resetCenter(this.root);
        const rootKey = itemKey(this.root);
        this.outgoing.set(rootKey, []);
        const sel = this.root.selectionRange?.start ?? this.root.range.start;
        this.rootTypeName = await resolveValueType(
            this.root.uri,
            sel,
            identFromToken(this.root.name) || name
        );
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        this.paintNow(seq);
        const locations = (refs || [])
            .map(loc => this.asLocation(loc))
            .filter((loc): loc is vscode.Location => !!loc && !this.isDeclSite(root, loc));
        const groups = new Map<string, { item: vscode.CallHierarchyItem; sites: vscode.Range[] }>();
        const chunk = 12;
        for (let i = 0; i < locations.length; i += chunk) {
            if (!this.isCurrent(seq)) {
                return undefined;
            }
            await Promise.all(locations.slice(i, i + chunk).map(async loc => {
                if (isLibPath(loc.uri.fsPath)) {
                    return;
                }
                const enc = await enclosingCallable(loc.uri, loc.range.start.line, root.name);
                const caller = enc
                    ? new vscode.CallHierarchyItem(
                        enc.kind,
                        enc.name,
                        enc.detail,
                        loc.uri,
                        enc.range,
                        enc.selectionRange
                    )
                    : new vscode.CallHierarchyItem(
                        vscode.SymbolKind.File,
                        fileLabel(loc.uri),
                        '',
                        loc.uri,
                        new vscode.Range(0, 0, 0, 0),
                        new vscode.Range(0, 0, 0, 0)
                    );
                const key = itemKey(caller);
                const group = groups.get(key);
                if (group) {
                    group.sites.push(loc.range);
                    return;
                }
                groups.set(key, { item: caller, sites: [loc.range] });
            }));
        }
        const callers: vscode.CallHierarchyItem[] = [];
        for (const group of groups.values()) {
            const key = this.remember(group.item);
            callers.push(this.items.get(key)!);
            this.rememberCallSite(rootKey, -1, group.item, group.item.uri, group.sites, root.name);
        }
        this.incoming.set(rootKey, callers);
        const graph = await this.buildVisible(seq, true);
        if (!graph || !this.isCurrent(seq)) {
            return undefined;
        }
        if (!callers.length) {
            graph.notice = name
                ? `No references for “${name}” outside its declaration.`
                : 'No references at this position.';
        }
        costLog('reference root', Date.now() - t0, `${itemLabel(root)} n=${callers.length}`);
        return { graph, seq };
    }

    private async adoptPreparedRoot(
        next: vscode.CallHierarchyItem,
        seq: number,
        t0: number
    ): Promise<RelationGraph | undefined> {
        this.shown.clear();
        this.expanded.clear();
        this.keepExpand.clear();
        this.keepGroups.clear();
        this.collapseLock.clear();
        this.prevRoot = undefined;
        this.incomingHint = undefined;
        this.relationMode = 'call';
        this.root = next;
        this.remember(this.root);
        this.resetCenter(this.root);
        this.paintNow(seq);
        const rootName = itemLabel(this.root);
        const tRoot = Date.now();
        await this.ensureOutgoing(this.root, seq);
        costLog('root outgoing', Date.now() - tRoot, rootName);
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        const tVisible = Date.now();
        const graph = await this.completeRootSides(seq, t0, rootName);
        costLog('buildVisible', Date.now() - tVisible, rootName);
        return graph;
    }

    /**
     * Call-site open whose own incoming is empty: load the enclosing caller as
     * center, find the opened name among its outgoing children, then switch
     * center to that child (same as a manual focus). Different .d.ts copies of
     * the same name can have different incoming.
     */
    private async recenterViaCallerOutgoing(
        uri: vscode.Uri,
        position: vscode.Position,
        seq: number,
        t0: number,
        opened: vscode.CallHierarchyItem | undefined,
        openedName: string
    ): Promise<{ graph: RelationGraph; seq: number } | undefined> {
        const enclosing = await enclosingCallable(uri, position.line);
        if (!enclosing || !this.isCurrent(seq)) {
            return this.isCurrent(seq) ? this.lspEmptyGraph(seq) : undefined;
        }
        const prepared = await this.execLsp<vscode.CallHierarchyItem[]>(
            seq,
            'vscode.prepareCallHierarchy',
            uri,
            enclosing.selectionRange.start
        );
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        if (!prepared?.length) {
            costLog('caller prepare empty', Date.now() - t0, enclosing.name);
            return this.lspEmptyGraph(seq);
        }
        const caller = prepared.find(item => rangeContains(item.range, enclosing.selectionRange.start))
            || prepared[0];
        if (opened && itemKey(caller) === itemKey(opened)) {
            return this.lspEmptyGraph(seq);
        }
        const callerGraph = await this.adoptPreparedRoot(caller, seq, t0);
        if (!callerGraph || !this.isCurrent(seq)) {
            return undefined;
        }
        if (!this.sideHas(caller, 1) && !this.sideHas(caller, -1)) {
            costLog('caller hierarchy empty', Date.now() - t0, itemLabel(caller));
            return this.lspEmptyGraph(seq);
        }
        const want = identFromToken(openedName || opened?.name || '');
        const kids = want
            ? (this.outgoing.get(itemKey(caller)) || []).filter(item => identFromToken(item.name) === want)
            : [];
        if (!kids.length) {
            costLog('callee not in caller outgoing', Date.now() - t0, openedName || opened?.name || '');
            callerGraph.notice = want
                ? `No call hierarchy for “${want}”. It was not found among the callees of ${caller.name}.`
                : 'No call hierarchy at this position.';
            return { graph: callerGraph, seq };
        }
        let best = kids[0];
        let bestN = -1;
        for (const kid of kids) {
            await this.ensureIncoming(kid, seq);
            if (!this.isCurrent(seq)) {
                return undefined;
            }
            const n = this.incoming.get(itemKey(kid))?.length ?? 0;
            if (n > bestN) {
                best = kid;
                bestN = n;
            }
        }
        const graph = await this.recenterToOutgoingCallee(caller, best, seq, t0);
        if (!graph || !this.isCurrent(seq)) {
            return undefined;
        }
        costLog('center callee via caller', Date.now() - t0, `${itemLabel(best)} via ${itemLabel(caller)}`);
        return { graph, seq };
    }

    /** Same as focusing an outgoing child after the caller was the center. */
    private async recenterToOutgoingCallee(
        caller: vscode.CallHierarchyItem,
        callee: vscode.CallHierarchyItem,
        seq: number,
        t0: number
    ): Promise<RelationGraph | undefined> {
        this.shown.clear();
        this.expanded.clear();
        this.keepExpand.clear();
        this.keepGroups.clear();
        this.collapseLock.clear();
        this.keepExpand.add(`self\0${itemKey(caller)}`);
        this.root = callee;
        this.remember(callee);
        this.remember(caller);
        this.centerTrail = [caller, callee];
        this.centerIndex = 1;
        this.syncPrevFromTrail();
        this.incomingHint = caller;
        await this.ensureOutgoing(callee, seq);
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        const graph = await this.completeRootSides(seq, t0, itemLabel(callee));
        if (!graph || !this.isCurrent(seq) || !this.root) {
            return undefined;
        }
        if (this.sideEmpty(this.root, -1)) {
            this.incoming.set(itemKey(this.root), [caller]);
            this.incomingHint = undefined;
            return this.buildVisible(seq, true);
        }
        return graph;
    }

    getOpenTarget(nodeId: string, nodes: RelationNode[]): RelationOpenTarget | undefined {
        const node = nodes.find(n => n.id === nodeId && n.kind === 'symbol');
        if (!node) {
            return undefined;
        }
        const item = this.items.get(node.itemKey);
        if (!item) {
            return undefined;
        }
        const sel = item.selectionRange?.start ?? item.range.start;
        const name = item.name || node.name;
        return {
            uri: item.uri.toString(),
            line: sel.line,
            character: sel.character,
            name: identFromToken(name) || name
        };
    }

    async loadRoot(uri: vscode.Uri, position: vscode.Position): Promise<{ graph: RelationGraph; seq: number } | undefined> {
        const t0 = Date.now();
        const loc = `${fileLabel(uri)}:${position.line + 1}:${position.character + 1}`;
        const maybeSame = !!(this.root
            && this.root.uri.toString() === uri.toString()
            && rangeContains(this.root.range, position));
        if (!maybeSame) {
            this.cancel();
        }
        const seqPrepare = this.seq;
        costLog('loadRoot begin', 0, loc);

        const valueSym = await symbolAtPosition(uri, position);
        if (!this.isCurrent(seqPrepare)) {
            return undefined;
        }
        if (valueSym && isReferenceRelationKind(valueSym.kind)) {
            return this.loadReferenceRoot(uri, position, seqPrepare, t0);
        }

        const prepared = await this.execLsp<vscode.CallHierarchyItem[]>(
            seqPrepare,
            'vscode.prepareCallHierarchy',
            uri,
            position
        );
        if (!this.isCurrent(seqPrepare)) {
            costLog('loadRoot cancelled', Date.now() - t0, `${loc} after prepare`);
            return undefined;
        }
        if (!prepared?.length) {
            costLog('loadRoot empty', Date.now() - t0, loc);
            const name = await tokenAt(uri, position);
            if (!this.isCurrent(seqPrepare)) {
                return undefined;
            }
            if (!name) {
                return this.lspEmptyGraph(seqPrepare);
            }
            return this.recenterViaCallerOutgoing(uri, position, seqPrepare, t0, undefined, name);
        }

        const next = prepared.find(item => rangeContains(item.range, position)) || prepared[0];
        if (isAnonymousSymbolName(next.name)) {
            const name = await tokenAt(uri, position);
            if (!this.isCurrent(seqPrepare)) {
                return undefined;
            }
            if (name) {
                return this.loadReferenceRoot(uri, position, seqPrepare, t0);
            }
        }
        if (this.root && itemKey(this.root) === itemKey(next) && this.relationMode === 'call') {
            this.prevRoot = undefined;
            this.incomingHint = undefined;
            if (this.openedFromCallSite(uri, position, next) && this.sideEmpty(next, -1)) {
                return this.recenterViaCallerOutgoing(uri, position, seqPrepare, t0, next, next.name);
            }
            costLog('loadRoot same', Date.now() - t0, itemLabel(next));
            return { graph: this.buildGraph(), seq: seqPrepare };
        }
        if (this.root && itemKey(this.root) === itemKey(next) && this.relationMode === 'reference') {
            this.forgetSides(next);
        }

        let seq = seqPrepare;
        if (maybeSame) {
            this.cancel();
            seq = this.seq;
        }
        if (this.openedFromCallSite(uri, position, next)) {
            this.remember(next);
            await this.ensureIncoming(next, seq);
            if (!this.isCurrent(seq)) {
                return undefined;
            }
            if (this.sideEmpty(next, -1)) {
                return this.recenterViaCallerOutgoing(uri, position, seq, t0, next, next.name);
            }
        }
        const graph = await this.adoptPreparedRoot(next, seq, t0);
        if (!graph || !this.isCurrent(seq)) {
            costLog('loadRoot cancelled', Date.now() - t0, `${itemLabel(next)} after buildVisible`);
            return undefined;
        }
        costLog('loadRoot done', Date.now() - t0, itemLabel(next));
        return { graph, seq };
    }

    async expandMore(nodeId: string): Promise<RelationLoad | undefined> {
        const seq = this.seq;
        const current = this.shown.get(nodeId) ?? CALL_PAGE;
        this.shown.set(nodeId, current + CALL_PAGE);
        const graph = await this.buildVisible(seq, true);
        return graph ? { graph, seq } : undefined;
    }

    collapseHop(nodeId: string, nodes: RelationNode[]): RelationGraph {
        const drop = new Set<string>([nodeId]);
        let grew = true;
        while (grew) {
            grew = false;
            for (const n of nodes) {
                if (n.parentId && drop.has(n.parentId) && !drop.has(n.id)) {
                    drop.add(n.id);
                    grew = true;
                }
            }
        }
        for (const id of drop) {
            this.expanded.delete(id);
            this.collapseLock.add(id);
            const n = nodes.find(x => x.id === id);
            const parent = n?.parentId ? nodes.find(x => x.id === n.parentId) : undefined;
            if (n?.itemKey) {
                this.keepExpand.delete(`self\0${n.itemKey}`);
                if (parent?.itemKey) {
                    this.keepExpand.delete(branchKeepKey(parent.itemKey, n.hop < 0 ? -1 : 1, n.itemKey));
                }
            }
        }
        return this.buildGraph();
    }

    async expandHop(nodeId: string, nodes: RelationNode[]): Promise<RelationLoad | undefined> {
        const seq = this.seq;
        const t0 = Date.now();
        const node = nodes.find(n => n.id === nodeId && n.kind === 'symbol');
        if (!node || !this.root) {
            return { graph: this.buildGraph(), seq };
        }
        if (Math.abs(node.hop) >= CALL_MAX_HOP) {
            return { graph: this.buildGraph(), seq };
        }
        const item = this.items.get(node.itemKey);
        if (!item) {
            return { graph: this.buildGraph(), seq };
        }
        this.collapseLock.delete(nodeId);
        if (node.hop < 0) {
            await this.ensureIncoming(item, seq);
        } else if (node.hop > 0) {
            await this.ensureOutgoing(item, seq);
        } else {
            await Promise.all([this.ensureIncoming(item, seq), this.ensureOutgoing(item, seq)]);
        }
        if (!this.isCurrent(seq)) {
            costLog('expandHop cancelled', Date.now() - t0, `${node.name} hop=${node.hop}`);
            return undefined;
        }
        if (this.collapseLock.has(nodeId)) {
            costLog('expandHop collapsed', Date.now() - t0, `${node.name} hop=${node.hop}`);
            return { graph: this.buildGraph(), seq };
        }
        this.expanded.add(nodeId);
        const graph = await this.buildVisible(seq, true);
        costLog('expandHop', Date.now() - t0, `${node.name} hop=${node.hop}`);
        return graph ? { graph, seq } : undefined;
    }

    collapseAll(): RelationGraph {
        this.cancel();
        this.expanded.clear();
        this.keepExpand.clear();
        this.keepGroups.clear();
        this.collapseLock.clear();
        this.shown.clear();
        return this.buildGraph();
    }

    /**
     * Show Relation's incoming side, without paging: callers of a function, or
     * reference sites of a variable / field / type. Does not walk
     * callers-of-callers — that would list e.g. `new Foo()` when the only
     * caller is a method on Foo.
     */
    async collectCallerLocations(
        onProgress?: (fetched: number, locations: number) => void
    ): Promise<{
        locations: vscode.Location[];
        title: string;
        mode: 'call' | 'reference';
        truncated?: boolean;
        empty?: string;
    }> {
        const title = this.root ? itemLabel(this.root) : '';
        const mode = this.relationMode;
        if (!this.root) {
            return { locations: [], title, mode, empty: 'No relation at this position.' };
        }
        const seq = this.seq;
        const maxLocations = 2000;
        const locations: vscode.Location[] = [];
        const seenLoc = new Set<string>();
        let truncated = false;

        const addPos = (uri: vscode.Uri, start: vscode.Position, end?: vscode.Position) => {
            const key = `${uri.toString()}:${start.line}:${start.character}`;
            if (seenLoc.has(key)) {
                return;
            }
            seenLoc.add(key);
            const stop = end && (end.isAfter(start)) ? end : start.translate(0, 1);
            locations.push(new vscode.Location(uri, new vscode.Range(start, stop)));
        };

        if (!this.isCurrent(seq)) {
            return { locations: [], title, mode, empty: 'Cancelled.' };
        }
        if (mode === 'call') {
            await this.ensureIncoming(this.root, seq);
            if (!this.isCurrent(seq)) {
                return { locations: [], title, mode, empty: 'Cancelled.' };
            }
        }
        const parentKey = itemKey(this.root);
        const callers = this.incoming.get(parentKey) || [];
        onProgress?.(1, 0);
        for (const caller of callers) {
            const sites = this.callSites.get(`${parentKey}\0-1\0${itemKey(caller)}`);
            if (sites?.length) {
                for (const s of sites) {
                    if (locations.length >= maxLocations) {
                        truncated = true;
                        break;
                    }
                    const start = new vscode.Position(s.line, s.character);
                    const width = Math.max(1, identFromToken(s.name || caller.name).length);
                    addPos(vscode.Uri.parse(s.uri), start, start.translate(0, width));
                }
            } else if (locations.length < maxLocations) {
                const sel = caller.selectionRange ?? caller.range;
                addPos(caller.uri, sel.start, sel.end);
            } else {
                truncated = true;
            }
            if (truncated) {
                break;
            }
        }
        onProgress?.(1, locations.length);
        if (!locations.length) {
            return {
                locations,
                title,
                mode,
                empty: mode === 'reference'
                    ? `No references of “${title}” outside its declaration.`
                    : `No callers of “${title}”.`
            };
        }
        return { locations, title, mode, truncated };
    }

    async expandAll(): Promise<RelationLoad | undefined> {
        const seq = this.seq;
        const t0 = Date.now();
        const limit = 6;
        const stopAt = this.buildGraph().nodes.length + CALL_EXPAND_ALL_NODES;
        for (let round = 0; round < CALL_MAX_HOP * 2; round++) {
            if (!this.isCurrent(seq)) {
                return undefined;
            }
            const graph = this.buildGraph();
            if (graph.nodes.length >= stopAt) {
                break;
            }
            const todo = graph.nodes.filter(n => (
                n.kind === 'symbol'
                && n.expandable
                && !n.expanded
                && !n.cyclic
                && n.id !== graph.rootId
                && Math.abs(n.hop) < CALL_MAX_HOP
            ));
            if (!todo.length) {
                break;
            }
            let full = false;
            for (let i = 0; i < todo.length; i += limit) {
                if (!this.isCurrent(seq)) {
                    return undefined;
                }
                if (this.buildGraph().nodes.length >= stopAt) {
                    full = true;
                    break;
                }
                await Promise.all(todo.slice(i, i + limit).map(async n => {
                    const item = this.items.get(n.itemKey);
                    if (!item) {
                        return;
                    }
                    this.collapseLock.delete(n.id);
                    if (n.hop < 0) {
                        await this.ensureIncoming(item, seq);
                    } else if (n.hop > 0) {
                        await this.ensureOutgoing(item, seq);
                    }
                    this.expanded.add(n.id);
                }));
            }
            if (full) {
                break;
            }
        }
        const graph = await this.buildVisible(seq, true);
        costLog('expandAll', Date.now() - t0, '');
        return graph ? { graph, seq } : undefined;
    }

    async focusNode(nodeId: string, nodes: RelationNode[]): Promise<RelationLoad | undefined> {
        if (this.relationMode === 'reference') {
            return { graph: this.buildGraph(), seq: this.seq };
        }
        this.cancel();
        const seq = this.seq;
        const t0 = Date.now();
        const focus = nodes.find(n => n.id === nodeId && n.kind === 'symbol');
        if (!focus) {
            return { graph: this.buildGraph(), seq };
        }
        const item = this.items.get(focus.itemKey);
        if (!item) {
            return { graph: this.buildGraph(), seq };
        }
        if (this.root && itemKey(this.root) === focus.itemKey && focus.hop === 0) {
            return { graph: this.buildGraph(), seq };
        }

        const drop = new Set<string>();
        if (focus.parentId) {
            for (const n of nodes) {
                if (n.id === focus.id || n.parentId !== focus.parentId || n.hop === 0) {
                    continue;
                }
                const sameSide = focus.hop < 0 ? n.hop < 0 : n.hop > 0;
                if (sameSide) {
                    drop.add(n.id);
                }
            }
            let grew = true;
            while (grew) {
                grew = false;
                for (const n of nodes) {
                    if (n.parentId && drop.has(n.parentId) && !drop.has(n.id)) {
                        drop.add(n.id);
                        grew = true;
                    }
                }
            }
        }

        this.keepExpand.clear();
        this.keepGroups.clear();
        this.expanded.clear();
        this.collapseLock.clear();
        for (const n of nodes) {
            if (drop.has(n.id) || n.id === focus.id) {
                continue;
            }
            if (n.kind === 'symbol' && n.expanded && n.itemKey && n.parentId) {
                const parent = nodes.find(p => p.id === n.parentId);
                if (parent?.itemKey) {
                    this.keepExpand.add(branchKeepKey(parent.itemKey, n.hop < 0 ? -1 : 1, n.itemKey));
                }
            }
            if (n.kind === 'symbol' && n.hop === 0 && n.itemKey) {
                this.keepExpand.add(`self\0${n.itemKey}`);
            }
            if (n.kind === 'group' && n.expanded && n.parentId) {
                const parent = nodes.find(p => p.id === n.parentId);
                if (parent?.itemKey) {
                    this.keepGroups.add(`${parent.itemKey}:${n.hop > 0 ? 1 : -1}:${n.file}`);
                }
            }
        }

        let ancestor = focus.parentId ? nodes.find(n => n.id === focus.parentId) : undefined;
        while (ancestor) {
            if (ancestor.itemKey) {
                this.keepExpand.add(`self\0${ancestor.itemKey}`);
            }
            ancestor = ancestor.parentId ? nodes.find(n => n.id === ancestor?.parentId) : undefined;
        }

        this.relationMode = 'call';
        const sel = item.selectionRange?.start ?? item.range.start;
        const prepared = await this.execLsp<vscode.CallHierarchyItem[]>(
            seq,
            'vscode.prepareCallHierarchy',
            item.uri,
            sel
        );
        const resolved = prepared?.length
            ? (prepared.find(it => rangeContains(it.range, sel)) || prepared[0])
            : item;
        this.root = resolved;
        this.remember(resolved);
        this.recordCenter(resolved);
        this.syncPrevFromTrail();
        this.shown.clear();
        this.incomingHint = focus.hop > 0 ? this.prevRoot : undefined;
        const tWarm = Date.now();
        await this.ensureOutgoing(resolved, seq);
        costLog('focusNode warm', Date.now() - tWarm, itemLabel(resolved));
        if (!this.isCurrent(seq)) {
            costLog('focusNode cancelled', Date.now() - t0, itemLabel(resolved));
            return undefined;
        }
        const graph = await this.completeRootSides(seq, t0, itemLabel(resolved));
        costLog('focusNode', Date.now() - t0, itemLabel(resolved));
        return graph ? { graph, seq } : undefined;
    }

    async focusTrail(index: number, nodes: RelationNode[]): Promise<RelationLoad | undefined> {
        if (this.relationMode === 'reference') {
            return { graph: this.buildGraph(), seq: this.seq };
        }
        if (index < 0 || index >= this.centerTrail.length) {
            return { graph: this.buildGraph(), seq: this.seq };
        }
        const item = this.centerTrail[index];
        const key = itemKey(item);
        if (this.root && itemKey(this.root) === key) {
            this.centerIndex = index;
            this.syncPrevFromTrail();
            return { graph: this.buildGraph(), seq: this.seq };
        }
        const node = nodes.find(n => n.kind === 'symbol' && n.itemKey === key);
        if (node) {
            return this.focusNode(node.id, nodes);
        }
        this.cancel();
        const seq = this.seq;
        const t0 = Date.now();
        this.centerIndex = index;
        this.syncPrevFromTrail();
        this.relationMode = 'call';
        this.root = item;
        this.remember(item);
        this.shown.clear();
        this.expanded.clear();
        this.keepExpand.clear();
        this.keepGroups.clear();
        this.collapseLock.clear();
        this.keepExpand.add(`self\0${key}`);
        this.incomingHint = this.prevRoot;
        await this.ensureOutgoing(item, seq);
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        const graph = await this.completeRootSides(seq, t0, itemLabel(item));
        return graph ? { graph, seq } : undefined;
    }

    async toggleGroup(nodeId: string, nodes: RelationNode[]): Promise<RelationLoad | undefined> {
        const seq = this.seq;
        const group = nodes.find(n => n.id === nodeId);
        const parent = group?.parentId ? nodes.find(n => n.id === group.parentId) : undefined;
        const keepKey = group && parent?.itemKey
            ? `${parent.itemKey}:${group.hop > 0 ? 1 : -1}:${group.file}`
            : '';
        if (this.expanded.has(nodeId)) {
            this.expanded.delete(nodeId);
            if (keepKey) {
                this.keepGroups.delete(keepKey);
            }
            return this.isCurrent(seq) ? { graph: this.buildGraph(), seq } : undefined;
        }
        this.expanded.add(nodeId);
        if (keepKey) {
            this.keepGroups.add(keepKey);
        }
        const graph = await this.buildVisible(seq, true);
        return graph ? { graph, seq } : undefined;
    }

    private paintNow(seq: number): void {
        if (!this.isCurrent(seq) || !this.root) {
            return;
        }
        this.graphListener?.(this.buildGraph(), seq);
    }

    private async completeRootSides(seq: number, t0: number, label: string): Promise<RelationGraph | undefined> {
        if (!this.root) {
            return undefined;
        }
        const rootKey = itemKey(this.root);
        if (!this.incoming.has(rootKey)) {
            const early = await this.buildVisible(seq, false);
            if (early && this.isCurrent(seq)) {
                this.graphListener?.(early, seq);
            }
            costLog('incoming deferred', Date.now() - t0, label);
            await this.ensureIncoming(this.root, seq);
            this.incomingHint = undefined;
            if (!this.isCurrent(seq) || !this.root || itemKey(this.root) !== rootKey) {
                return undefined;
            }
            costLog('incoming ready', Date.now() - t0, label);
        }
        return this.buildVisible(seq, true);
    }

    private async buildVisible(seq: number, waitPrefetch = false): Promise<RelationGraph | undefined> {
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        const graph = this.buildGraph();
        await this.fillVisibleSnippets(seq, graph);
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        const latest = this.buildGraph();
        await this.fillVisibleSnippets(seq, latest);
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        if (waitPrefetch) {
            await this.prefetchNextHop(seq, latest.nodes);
            if (!this.isCurrent(seq)) {
                return undefined;
            }
            return this.buildGraph();
        }
        void this.prefetchInBackground(seq, latest.nodes);
        return latest;
    }

    private async prefetchInBackground(seq: number, nodes: RelationNode[]): Promise<void> {
        await this.prefetchNextHop(seq, nodes);
        if (!this.isCurrent(seq)) {
            return;
        }
        this.graphListener?.(this.buildGraph(), seq);
    }

    private async prefetchNextHop(seq: number, nodes: RelationNode[]): Promise<void> {
        const pending: { item: vscode.CallHierarchyItem; dir: -1 | 1 }[] = [];
        const seen = new Set<string>();
        for (const node of nodes) {
            if (node.kind !== 'symbol' || node.hop === 0 || Math.abs(node.hop) >= CALL_MAX_HOP) {
                continue;
            }
            if (node.expanded) {
                continue;
            }
            const item = this.items.get(node.itemKey);
            if (!item || isLibPath(item.uri.fsPath)) {
                continue;
            }
            const dir: -1 | 1 = node.hop < 0 ? -1 : 1;
            const mark = `${node.itemKey}:${dir}`;
            if (seen.has(mark)) {
                continue;
            }
            const peeked = dir < 0 ? this.incoming.has(node.itemKey) : this.outgoing.has(node.itemKey);
            if (peeked) {
                continue;
            }
            seen.add(mark);
            pending.push({ item, dir });
        }
        if (!pending.length) {
            return;
        }
        const limit = 6;
        const t0 = Date.now();
        const batches = Math.ceil(pending.length / limit);
        costLog('prefetch start', 0, `jobs=${pending.length} batches=${batches}`);
        for (let i = 0; i < pending.length; i += limit) {
            if (!this.isCurrent(seq)) {
                costLog('prefetch cancelled', Date.now() - t0, `done=${i}/${pending.length}`);
                return;
            }
            const batch = Math.floor(i / limit) + 1;
            const tBatch = Date.now();
            await Promise.all(pending.slice(i, i + limit).map(job => (
                job.dir < 0 ? this.ensureIncoming(job.item, seq) : this.ensureOutgoing(job.item, seq)
            )));
            costLog('prefetch batch', Date.now() - tBatch, `${batch}/${batches} size=${Math.min(limit, pending.length - i)}`);
            const hot = pending.slice(i, i + limit).some(job => (
                job.dir < 0 && (this.incoming.get(itemKey(job.item))?.length ?? 0) >= CALL_HOT_PREFETCH
            ));
            if (hot) {
                costLog('prefetch stop hot', Date.now() - t0, `done=${Math.min(i + limit, pending.length)}/${pending.length}`);
                return;
            }
        }
        costLog('prefetch total', Date.now() - t0, `jobs=${pending.length}`);
    }

    buildGraph(): RelationGraph {
        if (!this.root) {
            return this.emptyGraph('No call hierarchy at this position.');
        }
        const rootNode = toSymbolNode(this.root, 0, undefined, false);
        if (this.rootTypeName) {
            rootNode.typeName = this.rootTypeName;
        }
        const nodes: RelationNode[] = [rootNode];
        const edges: RelationEdge[] = [];
        this.addSide(nodes, edges, rootNode, -1);
        if (this.relationMode !== 'reference') {
            this.addSide(nodes, edges, rootNode, 1);
        }
        const prevKey = this.prevRoot ? itemKey(this.prevRoot) : '';
        if (prevKey) {
            const prevNode = nodes.find(n => n.kind === 'symbol' && n.itemKey === prevKey);
            if (prevNode) {
                prevNode.prevCenter = true;
            }
        }
        this.syncToggleState(nodes);
        return this.attachCenterTrail({
            rootId: rootNode.id,
            title: this.root.name,
            nodes,
            edges
        });
    }

    private syncToggleState(nodes: RelationNode[]): void {
        const hasChild = new Set<string>();
        for (const n of nodes) {
            if (n.parentId) {
                hasChild.add(n.parentId);
            }
        }
        for (const node of nodes) {
            if (node.kind !== 'symbol' || node.hop === 0) {
                continue;
            }
            const opened = hasChild.has(node.id);
            node.expanded = opened;
            if (opened) {
                node.expandable = Math.abs(node.hop) < CALL_MAX_HOP;
            }
        }
    }

    private emptyGraph(empty: string): RelationGraph {
        return this.attachCenterTrail({ rootId: '', title: '', nodes: [], edges: [], empty });
    }

    private isPinnedChild(parentKey: string, dir: -1 | 1, childKey: string): boolean {
        if (this.prevRoot && itemKey(this.prevRoot) === childKey) {
            return true;
        }
        return this.keepExpand.has(`self\0${childKey}`)
            || this.keepExpand.has(branchKeepKey(parentKey, dir, childKey));
    }

    private addSide(nodes: RelationNode[], edges: RelationEdge[], parent: RelationNode, dir: -1 | 1): void {
        const hop = parent.hop + dir;
        if (Math.abs(hop) > CALL_MAX_HOP) {
            return;
        }
        const item = this.items.get(parent.itemKey);
        if (!item) {
            return;
        }
        const kidsStored = this.sideList(item, dir);
        const hint = dir < 0 && parent.hop === 0 && this.incomingHint && this.keepCallItem(this.incomingHint)
            ? [this.incomingHint]
            : undefined;
        const kids = kidsStored || hint;
        if (!kids) {
            return;
        }
        const shownKey = `${parent.id}:${dir}`;
        const limit = this.shown.get(shownKey) ?? CALL_PAGE;
        const seen = new Set<string>();
        const unique: vscode.CallHierarchyItem[] = [];
        for (const child of kids) {
            const k = itemKey(child);
            if (seen.has(k)) {
                continue;
            }
            seen.add(k);
            unique.push(child);
        }
        unique.sort((a, b) => this.compareChildren(parent.itemKey, dir, a, b));
        const pageKeys = new Set(unique.slice(0, limit).map(child => itemKey(child)));
        const visibleKeys = new Set(pageKeys);
        for (const child of unique) {
            const k = itemKey(child);
            if (pageKeys.has(k) || !this.isPinnedChild(parent.itemKey, dir, k)) {
                continue;
            }
            visibleKeys.add(k);
        }
        const visible = unique.filter(child => visibleKeys.has(itemKey(child)));
        const hidden = unique.length - visible.length;
        const compact = kids.length >= 6;
        const libByFile = new Map<string, vscode.CallHierarchyItem[]>();
        for (const child of visible) {
            if (!isLibPath(child.uri.fsPath)) {
                continue;
            }
            const file = fileLabel(child.uri);
            const list = libByFile.get(file) || [];
            list.push(child);
            libByFile.set(file, list);
        }
        const groupedFiles = new Set(
            [...libByFile.entries()].filter(([, list]) => list.length >= 2).map(([file]) => file)
        );
        const seenGroup = new Set<string>();
        const pendingExpand: RelationNode[] = [];
        const link = (fromId: string, toId: string, childKey: string) => {
            if (edges.some(e => e.from === fromId && e.to === toId)) {
                return;
            }
            edges.push({
                from: fromId,
                to: toId,
                sites: this.callSites.get(`${parent.itemKey}\0${dir}\0${childKey}`)
            });
        };
        const emitChild = (child: vscode.CallHierarchyItem) => {
            const childKey = itemKey(child);
            const cyclic = ancestorHasItemKey(nodes, parent.id, childKey);
            const childNode = toSymbolNode(child, hop, parent.id, false);
            if (nodes.some(n => n.id === childNode.id)) {
                return;
            }
            const opened = !cyclic
                && !this.collapseLock.has(childNode.id)
                && (this.expanded.has(childNode.id)
                    || this.keepExpand.has(branchKeepKey(parent.itemKey, dir, childKey))
                    || this.keepExpand.has(`self\0${childKey}`));
            childNode.cyclic = cyclic;
            childNode.expanded = opened;
            childNode.expandable = !cyclic && Math.abs(hop) < CALL_MAX_HOP && this.canExpand(child, dir);
            childNode.compact = compact;
            nodes.push(childNode);
            if (dir < 0) {
                link(childNode.id, parent.id, childKey);
            } else {
                link(parent.id, childNode.id, childKey);
            }
            if (opened) {
                this.expanded.add(childNode.id);
                pendingExpand.push(childNode);
            }
        };
        type EmitSlot = {
            sort: string;
            fileName: string;
            filePath: string;
            line: number;
            child?: vscode.CallHierarchyItem;
            file?: string;
        };
        const slots: EmitSlot[] = [];
        for (const child of visible) {
            const file = fileLabel(child.uri);
            if (isLibPath(child.uri.fsPath) && groupedFiles.has(file)) {
                if (seenGroup.has(file)) {
                    continue;
                }
                seenGroup.add(file);
                const bunch = libByFile.get(file) || [];
                const line = bunch.reduce(
                    (min, item) => Math.min(min, this.firstCallLine(parent.itemKey, dir, item)),
                    Number.MAX_SAFE_INTEGER
                );
                slots.push({
                    sort: file,
                    fileName: file,
                    filePath: this.filePathKey(bunch[0] || child),
                    line,
                    file
                });
                continue;
            }
            slots.push({
                sort: sortName(child),
                fileName: file,
                filePath: this.filePathKey(child),
                line: this.firstCallLine(parent.itemKey, dir, child),
                child
            });
        }
        slots.sort((a, b) => {
            if (this.childSort === 'order') {
                if (dir < 0) {
                    if (a.filePath !== b.filePath) {
                        const byFile = a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' });
                        if (byFile !== 0) {
                            return byFile;
                        }
                        return a.filePath.localeCompare(b.filePath);
                    }
                }
                const byLine = a.line - b.line;
                if (byLine !== 0) {
                    return byLine;
                }
            }
            return a.sort.localeCompare(b.sort, undefined, { sensitivity: 'base' });
        });
        for (const slot of slots) {
            if (!slot.file) {
                if (slot.child) {
                    emitChild(slot.child);
                }
                continue;
            }
            const file = slot.file;
            const bunch = (libByFile.get(file) || []).slice()
                .sort((a, b) => this.compareChildren(parent.itemKey, dir, a, b));
            if (bunch.length < 2) {
                for (const item of bunch) {
                    emitChild(item);
                }
                continue;
            }
            const groupId = `${parent.id}:lib:${dir}:${file}`;
            const opened = this.expanded.has(groupId)
                || this.keepGroups.has(`${parent.itemKey}:${dir}:${file}`);
            nodes.push({
                id: groupId,
                itemKey: '',
                name: file,
                detail: `${bunch.length} library symbols`,
                file,
                path: '',
                line: 0,
                hop,
                parentId: parent.id,
                kind: 'group',
                moreCount: bunch.length,
                expandable: true,
                expanded: opened,
                compact,
                expandKey: groupId
            });
            if (!opened) {
                if (dir < 0) {
                    edges.push({ from: groupId, to: parent.id });
                } else {
                    edges.push({ from: parent.id, to: groupId });
                }
            }
            if (opened) {
                this.expanded.add(groupId);
                for (const item of bunch) {
                    emitChild(item);
                }
            }
        }
        for (const childNode of pendingExpand) {
            this.addSide(nodes, edges, childNode, dir);
        }
        if (hidden > 0) {
            const moreId = `${parent.id}:more:${dir}`;
            nodes.push({
                id: moreId,
                itemKey: '',
                name: `+${hidden} more`,
                detail: 'Show more at this level',
                file: '',
                path: '',
                line: 0,
                hop,
                parentId: parent.id,
                kind: 'more',
                moreCount: hidden,
                expandKey: shownKey,
                compact
            });
            if (dir < 0) {
                edges.push({ from: moreId, to: parent.id });
            } else {
                edges.push({ from: parent.id, to: moreId });
            }
        }
    }

    private async ensureIncoming(item: vscode.CallHierarchyItem, seq: number): Promise<void> {
        return this.ensureCached(this.incoming, this.inflightIn, item, seq, (key, fetchSeq) => (
            this.fetchIncoming(item, key, fetchSeq)
        ));
    }

    private async ensureOutgoing(item: vscode.CallHierarchyItem, seq: number): Promise<void> {
        return this.ensureCached(this.outgoing, this.inflightOut, item, seq, (key, fetchSeq) => (
            this.fetchOutgoing(item, key, fetchSeq)
        ));
    }

    private async ensureCached(
        cache: Map<string, vscode.CallHierarchyItem[]>,
        inflight: Map<string, Promise<void>>,
        item: vscode.CallHierarchyItem,
        seq: number,
        fetch: (key: string, fetchSeq: number) => Promise<void>
    ): Promise<void> {
        if (!this.isCurrent(seq)) {
            return;
        }
        const key = this.remember(item);
        if (cache.has(key)) {
            return;
        }
        let pending = inflight.get(key);
        if (!pending) {
            pending = fetch(key, seq).finally(() => {
                if (inflight.get(key) === pending) {
                    inflight.delete(key);
                }
            });
            inflight.set(key, pending);
        }
        let sub: vscode.Disposable | undefined;
        const cancelled = new Promise<void>(resolve => {
            if (!this.isCurrent(seq)) {
                resolve();
                return;
            }
            sub = this.cts.token.onCancellationRequested(() => resolve());
        });
        try {
            await Promise.race([pending, cancelled]);
        } finally {
            sub?.dispose();
        }
        if (cache.has(key) || !this.isCurrent(seq)) {
            return;
        }
        return this.ensureCached(cache, inflight, item, seq, fetch);
    }

    private fileRev(uri: vscode.Uri): number {
        return this.fileGen.get(uri.toString()) ?? 0;
    }

    private addSuperOutgoing(
        parentKey: string,
        callee: vscode.CallHierarchyItem,
        siteUri: vscode.Uri,
        ranges: vscode.Range[] | undefined
    ): void {
        const k = this.remember(callee);
        const child = this.items.get(k)!;
        const list = this.superOutgoing.get(parentKey) || [];
        if (!list.some(x => itemKey(x) === k)) {
            list.push(child);
            this.superOutgoing.set(parentKey, list);
        }
        this.rememberCallSite(parentKey, 1, child, siteUri, ranges, child.name);
    }

    private async resolveSuperCallee(
        siteUri: vscode.Uri,
        position: vscode.Position,
        self: vscode.CallHierarchyItem
    ): Promise<vscode.CallHierarchyItem | undefined> {
        let defs: unknown;
        try {
            defs = await vscode.commands.executeCommand(
                'vscode.executeDefinitionProvider',
                siteUri,
                position
            );
        } catch {
            return undefined;
        }
        const selfKey = itemKey(self);
        const list = Array.isArray(defs) ? defs : [];
        for (const raw of list) {
            const loc = this.asLocation(raw);
            if (!loc) {
                continue;
            }
            const prepared = await this.execLspHeld<vscode.CallHierarchyItem[]>(
                'vscode.prepareCallHierarchy',
                loc.uri,
                loc.range.start
            );
            const other = (prepared || []).find(p => itemKey(p) !== selfKey) || prepared?.[0];
            if (!other || itemKey(other) === selfKey) {
                continue;
            }
            return other;
        }
        return undefined;
    }

    private async rewriteSelfSuper(
        siteUri: vscode.Uri,
        ranges: vscode.Range[] | undefined,
        ident: string,
        self: vscode.CallHierarchyItem,
        selfKey: string
    ): Promise<vscode.Range[]> {
        const split = await splitSuperCallRanges(siteUri, ranges, ident);
        if (split.superHit) {
            const superTo = await this.resolveSuperCallee(siteUri, split.superHit, self);
            if (superTo) {
                this.addSuperOutgoing(selfKey, superTo, siteUri, split.superRanges);
                return split.otherRanges;
            }
        }
        return ranges || [];
    }

    /**
     * Override incoming is empty for virtual dispatch. Search every same-named
     * class/interface slot on this type's ancestor chain. A call site is
     * classified by its enclosing type: on this chain (keep nearest), shares
     * heritage but not on this chain (sibling, drop), otherwise external (keep).
     */
    private async mergeOverrideIncoming(
        item: vscode.CallHierarchyItem,
        key: string,
        items: vscode.CallHierarchyItem[],
        seen: Set<string>,
        ident: string
    ): Promise<void> {
        if (!ident || /^constructor$/i.test(ident) || item.kind === vscode.SymbolKind.Constructor) {
            return;
        }
        const family = await this.selfAndAncestorTypes(item);
        const ancestors = family.filter(type => type.depth > 0);
        if (!ancestors.length) {
            return;
        }
        const slots = await this.collectVirtualSlots(ancestors, ident);
        if (!slots.length) {
            return;
        }
        const locSeen = new Set<string>();
        const locations: vscode.Location[] = [];
        for (const slot of slots) {
            const refs = await this.execLspHeld<unknown[]>(
                'vscode.executeReferenceProvider',
                slot.uri,
                slot.method.selectionRange.start
            );
            for (const raw of refs || []) {
                const loc = this.asLocation(raw);
                if (!loc) {
                    continue;
                }
                const k = `${loc.uri.toString()}\0${loc.range.start.line}\0${loc.range.start.character}`;
                if (locSeen.has(k)) {
                    continue;
                }
                locSeen.add(k);
                locations.push(loc);
            }
        }
        if (!locations.length) {
            return;
        }
        const familyKeys = new Map(family.map(a => [typeRefKey(a.uri, a.symbol), a.depth]));
        const heritageShare = new Map<string, boolean>();
        const groups = new Map<string, {
            item: vscode.CallHierarchyItem;
            sites: vscode.Range[];
            depth: number;
            external: boolean;
        }>();
        const chunk = 12;
        for (let i = 0; i < locations.length; i += chunk) {
            await Promise.all(locations.slice(i, i + chunk).map(async loc => {
                if (isLibPath(loc.uri.fsPath) || this.isDeclSite(item, loc)) {
                    return;
                }
                if (slots.some(slot => this.isDeclSite(
                    new vscode.CallHierarchyItem(
                        slot.method.kind,
                        slot.method.name,
                        '',
                        slot.uri,
                        slot.method.range,
                        slot.method.selectionRange
                    ),
                    loc
                ))) {
                    return;
                }
                if (items.some(existing => (
                    existing.uri.toString() === loc.uri.toString()
                    && rangeContains(existing.range, loc.range.start)
                ))) {
                    return;
                }
                let lineText = '';
                try {
                    const doc = await vscode.workspace.openTextDocument(loc.uri);
                    lineText = doc.lineAt(Math.min(loc.range.start.line, doc.lineCount - 1)).text;
                } catch {
                    return;
                }
                if (isParentOrDeclIncomingLine(lineText, ident)
                    || !new RegExp(`\\b${escapeRegExp(ident)}\\s*\\(`).test(lineText)) {
                    return;
                }
                const enc = await enclosingCallable(loc.uri, loc.range.start.line, ident);
                if (!enc) {
                    return;
                }
                const kind = await this.classifyOverrideCaller(
                    enc,
                    loc.uri,
                    familyKeys,
                    heritageShare
                );
                if (kind === 'sibling') {
                    return;
                }
                const caller = await this.prepareFromEnclosing(enc, loc.uri);
                if (!caller) {
                    return;
                }
                const fromKey = itemKey(caller);
                if (fromKey === key || identFromToken(caller.name) === ident) {
                    return;
                }
                const group = groups.get(fromKey);
                if (group) {
                    group.sites.push(loc.range);
                    return;
                }
                groups.set(fromKey, {
                    item: caller,
                    sites: [loc.range],
                    depth: kind.depth,
                    external: kind.kind === 'external'
                });
            }));
        }
        if (!groups.size) {
            return;
        }
        let nearest = Number.POSITIVE_INFINITY;
        for (const group of groups.values()) {
            if (!group.external && group.depth < nearest) {
                nearest = group.depth;
            }
        }
        for (const group of groups.values()) {
            if (!group.external && group.depth !== nearest) {
                continue;
            }
            const fromKey = itemKey(group.item);
            if (seen.has(fromKey)) {
                continue;
            }
            seen.add(fromKey);
            const k = this.remember(group.item);
            items.push(this.items.get(k)!);
            this.rememberCallSite(key, -1, group.item, group.item.uri, group.sites, item.name);
        }
    }

    private async classifyOverrideCaller(
        enc: { uri?: vscode.Uri; selectionRange: vscode.Range },
        locUri: vscode.Uri,
        familyKeys: Map<string, number>,
        heritageShare: Map<string, boolean>
    ): Promise<'sibling' | { kind: 'chain' | 'external'; depth: number }> {
        const owner = await this.containingTypeAt(enc.uri ?? locUri, enc.selectionRange.start);
        if (!owner) {
            return { kind: 'external', depth: 0 };
        }
        const ownerKey = typeRefKey(owner.uri, owner.symbol);
        const onChain = familyKeys.get(ownerKey);
        if (onChain !== undefined) {
            return { kind: 'chain', depth: onChain };
        }
        let shares = heritageShare.get(ownerKey);
        if (shares === undefined) {
            const bases = await this.collectAncestorTypesFrom({
                uri: owner.uri,
                symbol: owner.symbol,
                depth: 0
            });
            shares = bases.some(base => familyKeys.has(typeRefKey(base.uri, base.symbol)));
            heritageShare.set(ownerKey, shares);
        }
        return shares ? 'sibling' : { kind: 'external', depth: 0 };
    }

    private async collectAncestorTypesFrom(start: TypeRef): Promise<TypeRef[]> {
        const out: TypeRef[] = [];
        const seen = new Set<string>([typeRefKey(start.uri, start.symbol)]);
        const queue: TypeRef[] = [{ uri: start.uri, symbol: start.symbol, depth: 0 }];
        while (queue.length && out.length < MAX_HERITAGE_TYPES) {
            const cur = queue.shift()!;
            const bases = await this.directBaseTypes(cur);
            for (const base of bases) {
                const k = typeRefKey(base.uri, base.symbol);
                if (seen.has(k)) {
                    continue;
                }
                seen.add(k);
                const next = { uri: base.uri, symbol: base.symbol, depth: cur.depth + 1 };
                out.push(next);
                queue.push(next);
            }
        }
        return out;
    }

    private async collectAncestorTypes(item: vscode.CallHierarchyItem): Promise<TypeRef[]> {
        const owner = await this.containingTypeAt(
            item.uri,
            item.selectionRange?.start ?? item.range.start
        );
        if (!owner) {
            return [];
        }
        return this.collectAncestorTypesFrom({ uri: owner.uri, symbol: owner.symbol, depth: 0 });
    }

    private async selfAndAncestorTypes(item: vscode.CallHierarchyItem): Promise<TypeRef[]> {
        const owner = await this.containingTypeAt(
            item.uri,
            item.selectionRange?.start ?? item.range.start
        );
        if (!owner) {
            return [];
        }
        return [
            { uri: owner.uri, symbol: owner.symbol, depth: 0 },
            ...await this.collectAncestorTypes(item)
        ];
    }

    private async methodDeclHasOverride(uri: vscode.Uri, method: FlatSymbol): Promise<boolean> {
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const start = Math.max(0, method.selectionRange.start.line - 1);
            const end = Math.min(doc.lineCount - 1, method.selectionRange.start.line + 2);
            for (let line = start; line <= end; line++) {
                if (/\boverride\b/.test(doc.lineAt(line).text)) {
                    return true;
                }
            }
        } catch {
            return false;
        }
        return false;
    }

    private async mostDerivedOverrideOnChain(
        chain: TypeRef[],
        ident: string
    ): Promise<vscode.CallHierarchyItem | undefined> {
        if (!ident || /^constructor$/i.test(ident)) {
            return undefined;
        }
        const impls: { uri: vscode.Uri; method: FlatSymbol; depth: number; hasOverride: boolean }[] = [];
        const ordered = [...chain].sort((a, b) => a.depth - b.depth);
        for (const type of ordered) {
            let symbols: unknown;
            try {
                symbols = await vscode.commands.executeCommand(
                    'vscode.executeDocumentSymbolProvider',
                    type.uri
                );
            } catch {
                continue;
            }
            const flat: FlatSymbol[] = [];
            flattenSymbols(symbols, flat);
            const method = methodInTypeSymbols(flat, type.symbol, ident);
            if (!method) {
                continue;
            }
            impls.push({
                uri: type.uri,
                method,
                depth: type.depth,
                hasOverride: await this.methodDeclHasOverride(type.uri, method)
            });
        }
        if (!impls.some(impl => impl.hasOverride)) {
            return undefined;
        }
        const pick = impls[0];
        const prepared = await this.execLspHeld<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            pick.uri,
            pick.method.selectionRange.start
        );
        return prepared?.[0];
    }

    private async outgoingSitesAreThisDispatch(
        uri: vscode.Uri,
        ranges: vscode.Range[] | undefined,
        ident: string
    ): Promise<boolean> {
        if (!ident || !ranges?.length) {
            return false;
        }
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            for (const range of ranges) {
                const start = Math.min(Math.max(0, range.start.line), doc.lineCount - 1);
                const end = Math.min(Math.max(start, range.end.line), doc.lineCount - 1);
                for (let line = start; line <= end; line++) {
                    if (isThisDispatchLine(doc.lineAt(line).text, ident)) {
                        return true;
                    }
                }
            }
        } catch {
            return false;
        }
        return false;
    }

    private async directBaseTypes(type: TypeRef): Promise<{ uri: vscode.Uri; symbol: FlatSymbol }[]> {
        const fromHierarchy = await this.basesFromTypeHierarchy(type);
        if (fromHierarchy.length) {
            return fromHierarchy;
        }
        return this.basesFromSemanticTokens(type);
    }

    private async basesFromTypeHierarchy(
        type: TypeRef
    ): Promise<{ uri: vscode.Uri; symbol: FlatSymbol }[]> {
        const prepared = await this.execLspHeld<TypeHierarchyLike[]>(
            'vscode.prepareTypeHierarchy',
            type.uri,
            type.symbol.selectionRange.start
        );
        const root = (prepared || []).find(t => t && TYPE_CONTAINER_KINDS.has(t.kind)) || prepared?.[0];
        if (!root) {
            return [];
        }
        const supers = await this.execLspHeld<TypeHierarchyLike[]>(
            'vscode.provideSupertypes',
            root
        );
        const out: { uri: vscode.Uri; symbol: FlatSymbol }[] = [];
        const seen = new Set<string>();
        for (const next of supers || []) {
            if (!next?.uri) {
                continue;
            }
            const resolved = await this.resolveTypeAt(next.uri, next.selectionRange?.start ?? next.range.start);
            if (!resolved) {
                continue;
            }
            const k = typeRefKey(resolved.uri, resolved.symbol);
            if (seen.has(k)) {
                continue;
            }
            seen.add(k);
            out.push(resolved);
        }
        return out;
    }

    private async basesFromSemanticTokens(
        type: TypeRef
    ): Promise<{ uri: vscode.Uri; symbol: FlatSymbol }[]> {
        let doc: vscode.TextDocument;
        try {
            doc = await vscode.workspace.openTextDocument(type.uri);
        } catch {
            return [];
        }
        const header = this.classHeaderRange(doc, type.symbol);
        const legend = await this.semanticLegend(type.uri);
        const data = await this.semanticTokenData(type.uri, header);
        if (!legend?.length || !data) {
            return [];
        }
        const own = identFromToken(type.symbol.name);
        const hits = decodeSemanticTokens(data, legend).filter(tok => {
            if (!TYPE_SEMANTIC_TYPES.has(tok.type)) {
                return false;
            }
            if (!rangeContains(header, new vscode.Position(tok.line, tok.character))) {
                return false;
            }
            const text = doc.getText(new vscode.Range(
                tok.line,
                tok.character,
                tok.line,
                tok.character + tok.length
            ));
            return identFromToken(text) !== own;
        });
        const out: { uri: vscode.Uri; symbol: FlatSymbol }[] = [];
        const seen = new Set<string>();
        for (const tok of hits) {
            const resolved = await this.resolveTypeAt(
                type.uri,
                new vscode.Position(tok.line, tok.character)
            );
            if (!resolved || resolved.uri.toString() === type.uri.toString()
                && typeRefKey(resolved.uri, resolved.symbol) === typeRefKey(type.uri, type.symbol)) {
                continue;
            }
            const k = typeRefKey(resolved.uri, resolved.symbol);
            if (seen.has(k)) {
                continue;
            }
            seen.add(k);
            out.push(resolved);
        }
        return out;
    }

    private classHeaderRange(doc: vscode.TextDocument, symbol: FlatSymbol): vscode.Range {
        const start = symbol.range.start;
        const afterName = symbol.selectionRange.end;
        const rest = doc.getText(new vscode.Range(afterName, symbol.range.end));
        const brace = rest.indexOf('{');
        const end = brace >= 0
            ? doc.positionAt(doc.offsetAt(afterName) + brace)
            : symbol.range.end;
        return new vscode.Range(start, end);
    }

    private async semanticLegend(uri: vscode.Uri): Promise<string[] | undefined> {
        for (const command of [
            'vscode.provideDocumentSemanticTokensLegend',
            'vscode.executeDocumentSemanticTokensLegend'
        ]) {
            const raw = await this.execLspHeld<{ tokenTypes?: string[] }>(command, uri);
            if (raw && Array.isArray(raw.tokenTypes) && raw.tokenTypes.length) {
                return raw.tokenTypes;
            }
        }
        return undefined;
    }

    private async semanticTokenData(
        uri: vscode.Uri,
        range: vscode.Range
    ): Promise<ArrayLike<number> | undefined> {
        const ranged = unwrapTokenData(await this.execLspHeld(
            'vscode.provideDocumentRangeSemanticTokens',
            uri,
            range
        ));
        if (ranged) {
            return ranged;
        }
        return unwrapTokenData(await this.execLspHeld(
            'vscode.provideDocumentSemanticTokens',
            uri
        )) || unwrapTokenData(await this.execLspHeld(
            'vscode.executeDocumentSemanticTokensProvider',
            uri
        ));
    }

    private async resolveTypeAt(
        uri: vscode.Uri,
        position: vscode.Position
    ): Promise<{ uri: vscode.Uri; symbol: FlatSymbol } | undefined> {
        let defs: unknown;
        try {
            defs = await vscode.commands.executeCommand(
                'vscode.executeDefinitionProvider',
                uri,
                position
            );
        } catch {
            return undefined;
        }
        for (const raw of Array.isArray(defs) ? defs : []) {
            const loc = this.asLocation(raw);
            if (!loc || isLibPath(loc.uri.fsPath)) {
                continue;
            }
            const hit = await this.containingTypeAt(loc.uri, loc.range.start);
            if (hit) {
                return hit;
            }
        }
        return undefined;
    }

    private async containingTypeAt(
        uri: vscode.Uri,
        position: vscode.Position
    ): Promise<{ uri: vscode.Uri; symbol: FlatSymbol } | undefined> {
        let symbols: unknown;
        try {
            symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
        } catch {
            return undefined;
        }
        const flat: FlatSymbol[] = [];
        flattenSymbols(symbols, flat);
        const symbol = pickContainingType(flat, position);
        return symbol ? { uri, symbol } : undefined;
    }

    private async collectVirtualSlots(
        ancestors: TypeRef[],
        ident: string
    ): Promise<{ uri: vscode.Uri; method: FlatSymbol }[]> {
        const out: { uri: vscode.Uri; method: FlatSymbol }[] = [];
        const seen = new Set<string>();
        const ordered = [...ancestors].sort((a, b) => a.depth - b.depth);
        for (const ancestor of ordered) {
            let symbols: unknown;
            try {
                symbols = await vscode.commands.executeCommand(
                    'vscode.executeDocumentSymbolProvider',
                    ancestor.uri
                );
            } catch {
                continue;
            }
            const flat: FlatSymbol[] = [];
            flattenSymbols(symbols, flat);
            const method = methodInTypeSymbols(flat, ancestor.symbol, ident);
            if (!method) {
                continue;
            }
            const k = `${ancestor.uri.toString()}\0${method.selectionRange.start.line}\0${method.selectionRange.start.character}`;
            if (seen.has(k)) {
                continue;
            }
            seen.add(k);
            out.push({ uri: ancestor.uri, method });
        }
        return out;
    }

    private async prepareFromEnclosing(
        enc: { name: string; kind: vscode.SymbolKind; detail: string; range: vscode.Range; selectionRange: vscode.Range; uri?: vscode.Uri },
        fallbackUri: vscode.Uri
    ): Promise<vscode.CallHierarchyItem | undefined> {
        if (!isUsableEnclosingName(enc.name) || isArrowLikeName(enc.name)) {
            return undefined;
        }
        const uri = enc.uri ?? fallbackUri;
        const prepared = await this.execLspHeld<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            uri,
            enc.selectionRange.start
        );
        const caller = prepared?.[0];
        if (!caller || isArrowLikeName(caller.name)) {
            return undefined;
        }
        return caller;
    }

    private async liftArrowToEnclosing(
        from: vscode.CallHierarchyItem,
        sites: vscode.Range[] | undefined
    ): Promise<vscode.CallHierarchyItem | undefined> {
        if (!isArrowLikeName(from.name)) {
            return undefined;
        }
        const line = sites?.[0]?.start.line
            ?? from.selectionRange?.start.line
            ?? from.range.start.line;
        const enc = await enclosingCallable(from.uri, line);
        if (!enc) {
            return undefined;
        }
        return this.prepareFromEnclosing(enc, from.uri);
    }

    private async fetchIncoming(item: vscode.CallHierarchyItem, key: string, _seq: number): Promise<void> {
        const t0 = Date.now();
        const epoch = this.cacheEpoch;
        const rev = this.fileRev(item.uri);
        const calls = await this.execLspHeld<vscode.CallHierarchyIncomingCall[]>(
            'vscode.provideIncomingCalls',
            item
        );
        if (this.cacheEpoch !== epoch || this.fileRev(item.uri) !== rev) {
            costLog('incoming dropped', Date.now() - t0, itemLabel(item));
            return;
        }
        const items: vscode.CallHierarchyItem[] = [];
        const seen = new Set<string>();
        const ident = identFromToken(item.name);
        for (const call of calls || []) {
            if (!call?.from) {
                continue;
            }
            let from = call.from;
            let sites = call.fromRanges;
            if (itemKey(from) === key) {
                // 自己调自己：super 改写到基类 outgoing，剩下的站点再滤声明行。
                sites = await this.rewriteSelfSuper(from.uri, call.fromRanges, ident, item, key);
            }
            sites = await keepNonParentIncomingRanges(from.uri, sites, ident);
            if (!sites.length) {
                continue;
            }
            const lifted = await this.liftArrowToEnclosing(from, sites);
            if (lifted) {
                from = lifted;
            }
            const k = this.remember(from);
            if (seen.has(k)) {
                continue;
            }
            seen.add(k);
            items.push(this.items.get(k)!);
            this.rememberCallSite(key, -1, from, from.uri, sites, item.name);
        }
        await this.mergeOverrideIncoming(item, key, items, seen, ident);
        if (!this.incoming.has(key)) {
            this.incoming.set(key, items);
        }
        costLog('incoming total', Date.now() - t0, `${itemLabel(item)} n=${items.length}`);
    }

    private async fetchOutgoing(item: vscode.CallHierarchyItem, key: string, _seq: number): Promise<void> {
        const t0 = Date.now();
        const epoch = this.cacheEpoch;
        const rev = this.fileRev(item.uri);
        const calls = await this.execLspHeld<vscode.CallHierarchyOutgoingCall[]>(
            'vscode.provideOutgoingCalls',
            item
        );
        if (this.cacheEpoch !== epoch || this.fileRev(item.uri) !== rev) {
            costLog('outgoing dropped', Date.now() - t0, itemLabel(item));
            return;
        }
        const items: vscode.CallHierarchyItem[] = [];
        const seen = new Set<string>();
        const ident = identFromToken(item.name);
        const chain = await this.selfAndAncestorTypes(item);
        const derivedByIdent = new Map<string, vscode.CallHierarchyItem | undefined>();
        for (const call of calls || []) {
            if (!call?.to) {
                continue;
            }
            let target = call.to;
            let sites = call.fromRanges;
            if (itemKey(call.to) === key) {
                sites = await this.rewriteSelfSuper(item.uri, call.fromRanges, ident, item, key);
                if (!sites.length) {
                    continue;
                }
            }
            const calleeIdent = identFromToken(target.name);
            if (calleeIdent && await this.outgoingSitesAreThisDispatch(item.uri, sites, calleeIdent)) {
                if (!derivedByIdent.has(calleeIdent)) {
                    derivedByIdent.set(
                        calleeIdent,
                        await this.mostDerivedOverrideOnChain(chain, calleeIdent)
                    );
                }
                const derived = derivedByIdent.get(calleeIdent);
                if (derived) {
                    target = derived;
                }
            }
            const k = this.remember(target);
            if (seen.has(k)) {
                continue;
            }
            seen.add(k);
            items.push(this.items.get(k)!);
            this.rememberCallSite(key, 1, target, item.uri, sites, target.name);
        }
        if (!this.outgoing.has(key)) {
            this.outgoing.set(key, items);
        }
        costLog('outgoing total', Date.now() - t0, `${itemLabel(item)} n=${items.length}`);
    }

    private sideCount(item: vscode.CallHierarchyItem, dir: -1 | 1): number {
        return this.sideList(item, dir)?.length ?? 0;
    }

    private canExpand(item: vscode.CallHierarchyItem, dir: -1 | 1): boolean {
        if (this.relationMode === 'reference' && this.root && itemKey(item) === itemKey(this.root) && dir > 0) {
            return false;
        }
        const key = itemKey(item);
        const peeked = dir < 0 ? this.incoming.has(key) : this.outgoing.has(key);
        if (!peeked) {
            return true;
        }
        return this.sideCount(item, dir) > 0;
    }

    private rememberCallSite(
        parentKey: string,
        dir: -1 | 1,
        child: vscode.CallHierarchyItem,
        uri: vscode.Uri,
        ranges: vscode.Range[] | undefined,
        token: string
    ): void {
        const sites: RelationOpenTarget[] = [];
        const seen = new Set<string>();
        const file = fileLabel(uri);
        for (const range of ranges || []) {
            const start = range?.start;
            if (!start) {
                continue;
            }
            const dedupe = `${start.line}:${start.character}`;
            if (seen.has(dedupe)) {
                continue;
            }
            seen.add(dedupe);
            sites.push({
                uri: uri.toString(),
                line: start.line,
                character: start.character,
                name: token,
                file
            });
        }
        if (sites.length) {
            this.callSites.set(`${parentKey}\0${dir}\0${itemKey(child)}`, sites);
        }
    }

    /** Open documents only for currently drawn edges. */
    private async fillVisibleSnippets(seq: number, graph: RelationGraph): Promise<void> {
        const t0 = Date.now();
        const uris: string[] = [];
        const seenUri = new Set<string>();
        for (const edge of graph.edges) {
            for (const site of edge.sites || []) {
                if (site.snippet || !site.uri || seenUri.has(site.uri)) {
                    continue;
                }
                seenUri.add(site.uri);
                uris.push(site.uri);
            }
        }
        const docs = new Map<string, vscode.TextDocument | null>();
        await Promise.all(uris.map(async uri => {
            try {
                docs.set(uri, await vscode.workspace.openTextDocument(vscode.Uri.parse(uri)));
            } catch {
                docs.set(uri, null);
            }
        }));
        if (!this.isCurrent(seq)) {
            return;
        }
        let filled = 0;
        for (const edge of graph.edges) {
            for (const site of edge.sites || []) {
                if (site.snippet || !site.uri) {
                    continue;
                }
                const doc = docs.get(site.uri);
                if (doc && site.line >= 0 && site.line < doc.lineCount) {
                    site.snippet = doc.lineAt(site.line).text.replace(/\s+/g, ' ').trim();
                    filled++;
                }
            }
        }
        costLog('snippets visible', Date.now() - t0, `n=${filled} files=${docs.size}`);
    }

    /**
     * Wait for an LSP command, but stop waiting when this generation is cancelled.
     * VS Code's prepareCallHierarchy / provide*Calls do not take a CancellationToken,
     * so the language server may still finish the in-flight request.
     */
    private execLsp<T>(seq: number, command: string, ...args: unknown[]): Promise<T | undefined> {
        if (!this.isCurrent(seq)) {
            return Promise.resolve(undefined);
        }
        const t0 = Date.now();
        const short = command.replace(/^vscode\./, '');
        const target = lspTarget(command, args);
        return new Promise(resolve => {
            let done = false;
            const finish = (value: T | undefined, failed = false) => {
                if (done) {
                    return;
                }
                done = true;
                sub.dispose();
                const current = this.isCurrent(seq);
                const status = failed ? 'error' : (current ? `n=${resultCount(value)}` : 'cancelled');
                costLog(`lsp ${short}`, Date.now() - t0, `${target} ${status}`);
                resolve(current ? value : undefined);
            };
            const sub = this.cts.token.onCancellationRequested(() => finish(undefined));
            vscode.commands.executeCommand<T>(command, ...args).then(
                value => finish(value),
                () => finish(undefined, true)
            );
        });
    }

    /** Wait for LSP even after this generation is cancelled, so results can still be cached. */
    private execLspHeld<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
        const t0 = Date.now();
        const short = command.replace(/^vscode\./, '');
        const target = lspTarget(command, args);
        return Promise.resolve(vscode.commands.executeCommand<T>(command, ...args)).then(
            value => {
                costLog(`lsp ${short}`, Date.now() - t0, `${target} n=${resultCount(value)}`);
                return value;
            },
            () => {
                costLog(`lsp ${short}`, Date.now() - t0, `${target} error`);
                return undefined;
            }
        );
    }
}

function lspTarget(command: string, args: unknown[]): string {
    if (command === 'vscode.prepareCallHierarchy') {
        const uri = args[0] as vscode.Uri | undefined;
        const pos = args[1] as vscode.Position | undefined;
        if (uri && pos) {
            return `${fileLabel(uri)}:${pos.line + 1}:${pos.character + 1}`;
        }
    }
    const item = args[0] as vscode.CallHierarchyItem | undefined;
    return item?.name ? itemLabel(item) : '?';
}

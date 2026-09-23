import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type * as TS from 'typescript';
import * as vscode from 'vscode';
import { enclosingCallable, isAnonymousSymbolName, isCallablePropertyKind, isReferenceRelationKind, isUsableEnclosingName, symbolAtPosition } from './enclosingSymbol';
import { onlySameNamedEnclosing, parseLocalSource } from './localSyntax';
import { relationIndex } from './relationIndex';

export type ChildSort = 'name' | 'order';

export const CALL_PAGE = 12;
/** Center incoming scan paints what it has once this elapses. */
const INCOMING_BUDGET_MS = 30_000;
export const CALL_MAX_HOP = 32;
/** Each Expand All adds at most this many nodes; run again to continue. */
const CALL_EXPAND_ALL_NODES = 40;
/** Stop remaining prefetch jobs after an incoming peek this large. */
const CALL_HOT_PREFETCH = 200;
/** Mixed prefetch wave size (outgoing can fill this). */
const PREFETCH_BATCH = 6;
/** Incoming `provideIncomingCalls` in one wave; outgoing may still fill PREFETCH_BATCH. */
const PREFETCH_IN_PARALLEL = 2;

export type RelationLoad = { graph: RelationGraph; seq: number };

/** Local +/− update: one hop of children, or those descendants only. */
export interface RelationPatch {
    op: 'expand' | 'collapse';
    parentId: string;
    nodes?: RelationNode[];
    edges?: RelationEdge[];
    dropIds?: string[];
}

export type RelationHopResult = {
    seq: number;
    patch?: RelationPatch;
};

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
    /** Scan stopped early; more button is "?" and a click continues it. */
    moreUnknown?: boolean;
    expandable?: boolean;
    /** |hop| reached CALL_MAX_HOP; webview shows a red × instead of +/-. */
    hopCapped?: boolean;
    /** Neighbor side is being peeked; show a spinner instead of +/-. */
    prefetching?: boolean;
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

interface CenterSnapshot {
    graph: RelationGraph;
    shown: Map<string, number>;
    expanded: Set<string>;
    keepExpand: Set<string>;
    keepGroups: Set<string>;
    collapseLock: Set<string>;
    relationMode: 'call' | 'reference';
    incomingHint: vscode.CallHierarchyItem | undefined;
    root: vscode.CallHierarchyItem;
    rootTypeName: string;
    centerFamily: Map<string, number>;
    centerFamilyRootKey: string;
}

function cloneRelationGraph(graph: RelationGraph): RelationGraph {
    return {
        ...graph,
        nodes: graph.nodes.map(n => ({ ...n })),
        edges: graph.edges.map(e => ({
            ...e,
            sites: e.sites?.map(s => ({ ...s }))
        })),
        centerTrail: graph.centerTrail?.map(c => ({ ...c }))
    };
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

/** Merge a one-hop +/− patch into an existing graph. Does not rebuild. */
export function applyRelationPatch(graph: RelationGraph, patch: RelationPatch): RelationGraph {
    if (patch.op === 'expand') {
        const have = new Set(graph.nodes.map(n => n.id));
        const nodes = graph.nodes.slice();
        for (const n of patch.nodes || []) {
            if (!have.has(n.id)) {
                nodes.push(n);
                have.add(n.id);
            }
        }
        const seen = new Set(graph.edges.map(e => `${e.from}\0${e.to}`));
        const edges = graph.edges.slice();
        for (const e of patch.edges || []) {
            const k = `${e.from}\0${e.to}`;
            if (!seen.has(k)) {
                edges.push(e);
                seen.add(k);
            }
        }
        const parent = nodes.find(n => n.id === patch.parentId);
        if (parent) {
            const grew = (patch.nodes || []).length > 0;
            parent.expanded = grew;
            parent.prefetching = false;
            if (!grew) {
                parent.expandable = false;
            }
        }
        return { ...graph, nodes, edges };
    }
    const drop = new Set(patch.dropIds || []);
    const nodes = graph.nodes.filter(n => !drop.has(n.id));
    const edges = graph.edges.filter(e => !drop.has(e.from) && !drop.has(e.to));
    const parent = nodes.find(n => n.id === patch.parentId);
    if (parent) {
        parent.expanded = false;
    }
    return { ...graph, nodes, edges };
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

function sortLocations(locations: vscode.Location[]): void {
    locations.sort((a, b) => {
        const ua = a.uri.toString();
        const ub = b.uri.toString();
        if (ua !== ub) {
            return ua < ub ? -1 : 1;
        }
        return a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
    });
}

/** Split call-hierarchy fromRanges into super/base sites vs other uses of ident. */
function splitSuperCallRanges(
    lines: string[] | undefined,
    ranges: vscode.Range[] | undefined,
    ident: string
): {
    superHit?: vscode.Position;
    superRanges: vscode.Range[];
    otherRanges: vscode.Range[];
} {
    if (!ident || !ranges?.length) {
        return { superRanges: [], otherRanges: ranges ? [...ranges] : [] };
    }
    if (!lines?.length) {
        return { superRanges: [], otherRanges: [...ranges] };
    }
    const last = lines.length - 1;
    const superRe = new RegExp(`\\b(?:super|base)\\s*\\.\\s*${escapeRegExp(ident)}\\b`);
    const identRe = new RegExp(`\\b${escapeRegExp(ident)}\\b`, 'g');
    const superRanges: vscode.Range[] = [];
    const otherRanges: vscode.Range[] = [];
    let superHit: vscode.Position | undefined;
    for (const range of ranges) {
        const start = Math.min(Math.max(0, range.start.line), last);
        const end = Math.min(Math.max(start, range.end.line), last);
        let hasSuper = false;
        let hasOther = false;
        for (let line = start; line <= end; line++) {
            const text = lines[line] || '';
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
/** Outline-less params/locals: LSP semantic types that should use Find All References. */
const VALUE_SEMANTIC_TYPES = new Set(['parameter', 'variable', 'property', 'enumMember']);
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

interface SemanticLegendInfo {
    tokenTypes: string[];
    tokenModifiers: string[];
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

/**
 * Classify the ident nearest `column`. A line can hold both `this.foo()` and
 * `recv.foo()`; the whole line must not decide for every range on it.
 * Bare `foo(` stays a this-dispatch, matching the previous line heuristic.
 */
function incomingUseAt(text: string, ident: string, column: number): 'drop' | 'this' | 'external' | 'super' {
    if (!ident) {
        return 'drop';
    }
    const re = new RegExp(`\\b${escapeRegExp(ident)}\\b`, 'g');
    let match: RegExpExecArray | null;
    let at: number | undefined;
    while ((match = re.exec(text))) {
        const start = match.index;
        const end = start + match[0].length;
        if (column >= start && column <= end) {
            at = start;
            break;
        }
        if (at === undefined || Math.abs(start - column) < Math.abs(at - column)) {
            at = start;
        }
    }
    if (at === undefined) {
        if (isParentOrDeclIncomingLine(text, ident) || !new RegExp(`\\b${escapeRegExp(ident)}\\s*\\(`).test(text)) {
            return 'drop';
        }
        return isThisDispatchLine(text, ident) ? 'this' : 'external';
    }
    const before = text.slice(0, at);
    if (/(?:\bsuper|\bbase)\s*\.\s*$/.test(before) || /::\s*$/.test(before)) {
        return 'super';
    }
    if (/\bthis\s*(?:\.|->)\s*$/.test(before)) {
        return 'this';
    }
    if (/(?:\.|->)\s*$/.test(before)) {
        return 'external';
    }
    if (isIdentDeclLine(text, ident)) {
        const first = new RegExp(`\\b${escapeRegExp(ident)}\\b`).exec(text);
        if (first && first.index === at) {
            return 'drop';
        }
    }
    return 'this';
}

/** `Foo.prototype.dispose()` / `_super.prototype.dispose.call(this)` — a super call, not a virtual receiver. */
function isPrototypeSuperCall(text: string, ident: string, column: number): boolean {
    if (!ident) {
        return false;
    }
    const re = new RegExp(`\\b${escapeRegExp(ident)}\\b`, 'g');
    let match: RegExpExecArray | null;
    let at: number | undefined;
    while ((match = re.exec(text))) {
        const start = match.index;
        const end = start + match[0].length;
        if (column >= start && column <= end) {
            at = start;
            break;
        }
        if (at === undefined || Math.abs(start - column) < Math.abs(at - column)) {
            at = start;
        }
    }
    if (at === undefined) {
        return false;
    }
    if (!/\bprototype\s*\.\s*$/.test(text.slice(0, at))) {
        return false;
    }
    const after = text.slice(at + ident.length);
    return /^\s*(?:\(\s*\)|\.\s*(?:call|apply)\b)/.test(after);
}

/** Text and query columns of `recv` in `recv.ident(`. A numeric index stays on that digit. */
function readReceiver(
    text: string,
    identStart: number
): { expr: string; column: number; queries: number[]; index?: number } | undefined {
    let i = identStart - 1;
    while (i >= 0 && /\s/.test(text[i])) {
        i--;
    }
    if (i >= 1 && text[i] === '>' && text[i - 1] === '-') {
        i -= 2;
    } else if (i >= 0 && text[i] === '.') {
        i -= text[i - 1] === '?' ? 2 : 1;
    } else {
        return undefined;
    }
    while (i >= 0 && /\s/.test(text[i])) {
        i--;
    }
    if (i < 0) {
        return undefined;
    }
    const end = i;
    const queried = receiverQueryColumns(text, end);
    let depth = 0;
    let start = i;
    while (start >= 0) {
        const ch = text[start];
        if (ch === ')' || ch === ']' || ch === '}') {
            depth++;
            start--;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') {
            if (depth === 0) {
                break;
            }
            depth--;
            start--;
            continue;
        }
        if (depth > 0) {
            start--;
            continue;
        }
        if (/[\w$]/.test(ch) || ch === '.' || ch === '?') {
            start--;
            continue;
        }
        if (ch === '>' && start >= 1 && text[start - 1] === '-') {
            start -= 2;
            continue;
        }
        break;
    }
    const expr = text.slice(start + 1, end + 1).trim();
    if (!expr) {
        return undefined;
    }
    return { expr, column: queried.columns[0] ?? end, queries: queried.columns, index: queried.index };
}

const TYPE_NAME_NOISE = new Set([
    'readonly', 'typeof', 'keyof', 'unique', 'import', 'null', 'undefined', 'void',
    'any', 'unknown', 'never', 'object', 'string', 'number', 'boolean', 'bigint',
    'symbol', 'Array', 'ReadonlyArray', 'Set', 'ReadonlySet', 'Promise', 'Map'
]);

/** Type names written after the last `:` in a hover, one per union member. */
function declaredTypeNames(hover: string, index?: number): string[] {
    const stripped = (hover || '').replace(/```(?:\w+)?/g, '');
    const line = stripped.split(/\r?\n/).map(part => part.trim()).find(part => /:\s*[A-Za-z_$\[]/.test(part));
    if (!line) {
        return [];
    }
    const expr = line.slice(line.lastIndexOf(':') + 1).replace(/[=;].*$/, '').trim();
    if (index !== undefined) {
        const element = tupleElementAt(expr, index);
        if (element !== undefined) {
            return typeNamesFromExpr(element);
        }
    }
    return typeNamesFromExpr(expr);
}

function typeNamesFromExpr(expr: string): string[] {
    const names: string[] = [];
    for (const part of expr.split('|')) {
        const idents = part.match(/[A-Za-z_$][\w$]*/g) || [];
        const kept = idents.filter(name => !TYPE_NAME_NOISE.has(name));
        const name = kept[kept.length - 1];
        if (name && !names.includes(name)) {
            names.push(name);
        }
    }
    return names;
}

/** `expr[N]` element, or undefined when `expr` is not a tuple. */
function tupleElementAt(expr: string, index: number): string | undefined {
    const body = expr.trim().replace(/^readonly\s+/, '');
    if (!body.startsWith('[') || !body.endsWith(']')) {
        return undefined;
    }
    const parts = splitTypeList(body.slice(1, -1));
    if (index < 0 || index >= parts.length) {
        return '';
    }
    return parts[index].trim();
}

function splitTypeList(expr: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (ch === '<' || ch === '[' || ch === '(') {
            depth++;
        } else if (ch === '>' || ch === ']' || ch === ')') {
            depth = Math.max(0, depth - 1);
        } else if (ch === ',' && depth === 0) {
            parts.push(expr.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(expr.slice(start));
    return parts;
}

/**
 * Positions to ask for the receiver type.
 * `list[i]` asks about `list`. `item[1]` asks about the digit, then `item`.
 */
function receiverQueryColumns(text: string, end: number): { columns: number[]; index?: number } {
    let cursor = end;
    while (cursor >= 0 && /\s/.test(text[cursor])) {
        cursor--;
    }
    if (cursor >= 0 && text[cursor] === ']') {
        let depth = 0;
        for (let j = cursor; j >= 0; j--) {
            if (text[j] === ']') {
                depth++;
            } else if (text[j] === '[') {
                depth--;
                if (depth === 0) {
                    const inside = text.slice(j + 1, cursor);
                    const num = inside.match(/^\s*(\d+)\s*$/);
                    if (!num) {
                        return receiverQueryColumns(text, j - 1);
                    }
                    const base = receiverQueryColumns(text, j - 1);
                    const digitAt = j + 1 + inside.indexOf(num[1]);
                    return {
                        columns: [digitAt, ...base.columns],
                        index: Number(num[1])
                    };
                }
            }
        }
    }
    let i = cursor;
    while (i >= 0 && !/[\w$]/.test(text[i])) {
        i--;
    }
    if (i < 0) {
        return { columns: [Math.max(0, end)] };
    }
    const last = identStartEndingAt(text, i);
    const cols = [last];
    let j = last - 1;
    while (j >= 0 && /\s/.test(text[j])) {
        j--;
    }
    if (j >= 0 && text[j] === '.') {
        j -= j >= 1 && text[j - 1] === '?' ? 2 : 1;
        while (j >= 0 && /\s/.test(text[j])) {
            j--;
        }
        if (j >= 0 && /[\w$]/.test(text[j])) {
            const qual = identStartEndingAt(text, j);
            const name = text.slice(qual, j + 1);
            if (/^[A-Z]/.test(name) && name !== 'Instance') {
                cols.push(qual);
            }
        }
    }
    return { columns: cols };
}

function identStartEndingAt(text: string, end: number): number {
    let i = end;
    while (i >= 0 && /[\w$]/.test(text[i])) {
        i--;
    }
    return i + 1;
}

/** Type definition landed on the type's name, not on a member inside that type. */
function definitionNamesType(loc: vscode.Location, symbol: FlatSymbol): boolean {
    const sel = symbol.selectionRange ?? symbol.range;
    if (rangeContains(sel, loc.range.start)) {
        return true;
    }
    const span = loc.range.end.line - loc.range.start.line;
    return span <= 2 && rangeContains(loc.range, sel.start);
}

function keepNonParentIncomingRanges(
    lines: string[] | undefined,
    ranges: vscode.Range[] | undefined,
    ident: string
): vscode.Range[] {
    if (!ranges?.length) {
        return [];
    }
    if (!ident || !lines?.length) {
        return [...ranges];
    }
    return ranges.filter(range => {
        const line = Math.min(Math.max(0, range.start.line), lines.length - 1);
        return !isParentOrDeclIncomingLine(lines[line] || '', ident);
    });
}

function decodeSemanticModifiers(modBits: number, legendModifiers: string[]): string[] {
    const out: string[] = [];
    for (let bit = 0; bit < legendModifiers.length; bit++) {
        if (modBits & (1 << bit)) {
            const name = legendModifiers[bit];
            if (name) {
                out.push(name);
            }
        }
    }
    return out;
}

function decodeSemanticTokens(
    data: ArrayLike<number>,
    legendTypes: string[],
    legendModifiers: string[] = []
): { line: number; character: number; length: number; type: string; modifiers: string[] }[] {
    const out: { line: number; character: number; length: number; type: string; modifiers: string[] }[] = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
        const deltaLine = data[i];
        const deltaStart = data[i + 1];
        const length = data[i + 2];
        const typeIdx = data[i + 3];
        const modBits = data[i + 4];
        line += deltaLine;
        character = deltaLine === 0 ? character + deltaStart : deltaStart;
        const type = legendTypes[typeIdx] || '';
        out.push({
            line,
            character,
            length,
            type,
            modifiers: decodeSemanticModifiers(modBits, legendModifiers)
        });
    }
    return out;
}

function tokenOverlapsRange(
    tok: { line: number; character: number; length: number },
    range: vscode.Range
): boolean {
    const tokRange = new vscode.Range(tok.line, tok.character, tok.line, tok.character + tok.length);
    if (tokRange.intersection(range)) {
        return true;
    }
    return range.isEmpty
        && tok.line === range.start.line
        && tok.character <= range.start.character
        && range.start.character < tok.character + tok.length;
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

/** Files read while resolving a type or receiver. Nested lookups merge into the outer set. */
const indexDeps = new AsyncLocalStorage<Set<string>>();

function noteIndexDep(uri: vscode.Uri | string | undefined): void {
    if (!uri) {
        return;
    }
    indexDeps.getStore()?.add(typeof uri === 'string' ? uri : uri.toString());
}

function familyStamp(familyKeys: Map<string, number>): string {
    const parts: string[] = [];
    for (const [key, depth] of familyKeys) {
        parts.push(`${depth}\0${key}`);
    }
    parts.sort();
    return parts.join('\n');
}

type SerRange = [number, number, number, number];

interface SerItem {
    kind: number;
    name: string;
    detail: string;
    uri: string;
    range: SerRange;
    sel: SerRange;
}

interface SerSide {
    callers: SerItem[];
    sites: Record<string, RelationOpenTarget[]>;
    superCallers?: SerItem[];
    /** itemKey → containing type. Present only after that pass has been stored with the side. */
    owners?: Record<string, SerOwner>;
}

/** Incomplete incoming page. The caller list is not final; `locIndex` is where to resume. */
interface SerPartial {
    side: SerSide;
    phase: 'calls' | 'merge-setup' | 'merge' | 'refs';
    locIndex: number;
    callIndex: number;
}

/** Containing type plus ancestor keys, so prefetch can skip document-symbol queries. */
interface SerOwner {
    key: string;
    uri: string;
    name: string;
    ancestorKeys: string[];
    /** Outline covers this position and no class/struct/interface contains it. */
    none?: boolean;
}

interface OwnerFill {
    hit: number;
    fresh: number;
    stored: number;
    empty: number;
}

interface SerRefPointer {
    root: SerItem;
    ref: string;
}

interface SerType {
    uri: string;
    name: string;
    kind: number;
    range: SerRange;
    sel: SerRange;
    depth: number;
}

interface SerLoc {
    uri: string;
    sl: number;
    sc: number;
    el: number;
    ec: number;
}

interface ReachBody {
    v: 'yes' | 'no';
    uris: string[];
}

interface SerMergeHit {
    c: SerItem;
    r: SerRange;
    d: number;
    x: boolean;
}

/** One file's merge verdicts for one slot family. `0` = the location is not a kept caller. */
interface MergeFileBody {
    hits: Record<string, SerMergeHit | 0>;
    uris: string[];
}

function serRange(range: vscode.Range | undefined, fallback?: vscode.Range): SerRange {
    const source = range ?? fallback;
    if (!source) {
        return [0, 0, 0, 0];
    }
    return [source.start.line, source.start.character, source.end.line, source.end.character];
}

function deRange(raw: SerRange | undefined): vscode.Range {
    const tuple = raw && raw.length === 4 ? raw : [0, 0, 0, 0];
    return new vscode.Range(tuple[0], tuple[1], tuple[2], tuple[3]);
}

function serItem(item: vscode.CallHierarchyItem): SerItem {
    return {
        kind: item.kind,
        name: item.name,
        detail: item.detail || '',
        uri: item.uri.toString(),
        range: serRange(item.range, item.selectionRange),
        sel: serRange(item.selectionRange, item.range)
    };
}

function serSymbol(uri: vscode.Uri, symbol: FlatSymbol, depth: number): SerType {
    return {
        uri: uri.toString(),
        name: symbol.name,
        kind: symbol.kind,
        range: serRange(symbol.range, symbol.selectionRange),
        sel: serRange(symbol.selectionRange, symbol.range),
        depth
    };
}

function symbolFromSer(raw: SerType): FlatSymbol {
    return {
        name: raw.name,
        kind: raw.kind,
        range: deRange(raw.range),
        selectionRange: deRange(raw.sel)
    };
}

function serLoc(loc: vscode.Location): SerLoc {
    return {
        uri: loc.uri.toString(),
        sl: loc.range.start.line,
        sc: loc.range.start.character,
        el: loc.range.end.line,
        ec: loc.range.end.character
    };
}

function locFromSer(raw: SerLoc): vscode.Location {
    return new vscode.Location(
        vscode.Uri.parse(raw.uri),
        new vscode.Range(raw.sl, raw.sc, raw.el, raw.ec)
    );
}

function referenceIndexId(uri: vscode.Uri, position: vscode.Position, name: string): string {
    return `refroot\0${uri.toString()}\0${position.line}\0${position.character}\0${name}`;
}

function ownerIndexId(uri: vscode.Uri, position: vscode.Position): string {
    return `owner\0${uri.toString()}\0${position.line}\0${position.character}`;
}

function ownerDepUris(owner: SerOwner): string[] {
    const uris: string[] = [];
    if (owner.uri) {
        uris.push(owner.uri);
    }
    for (const key of owner.ancestorKeys) {
        const uri = key.split('\0')[0];
        if (uri) {
            uris.push(uri);
        }
    }
    return uris;
}

function isSerSide(raw: unknown): raw is SerSide {
    return !!raw && typeof raw === 'object' && Array.isArray((raw as SerSide).callers);
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

/** One document-symbol query per file while several callers resolve together. */
const documentSymbolInflight = new Map<string, Promise<FlatSymbol[] | undefined>>();

const RELATION_COST = true;
/** Peek vs focus cache log. Output: Context View Relation. */
const RELATION_PEEK = true;
let relationCost = RELATION_COST;
let relationPeek = RELATION_PEEK;
let relationCostChannel: vscode.OutputChannel | undefined;

function costLog(layer: string, ms: number, detail = ''): void {
    if (!relationCost) {
        return;
    }
    const line = `[relation cost] ${layer} ${ms}ms${detail ? ` ${detail}` : ''}`;
    console.log(line);
    relationCostChannel ??= vscode.window.createOutputChannel('Context View Relation');
    relationCostChannel.appendLine(line);
    relationCostChannel.show(true);
}

function peekLog(layer: string, detail: string): void {
    if (!relationPeek) {
        return;
    }
    const line = `[relation peek] ${layer} ${detail}`;
    console.log(line);
    relationCostChannel ??= vscode.window.createOutputChannel('Context View Relation');
    relationCostChannel.appendLine(line);
    relationCostChannel.show(true);
}

function isLibPath(fsPath: string): boolean {
    const p = fsPath.replace(/\\/g, '/').toLowerCase();
    return p.endsWith('.d.ts') || p.includes('/node_modules/');
}

/** TS/JS LS has no Type Hierarchy; calling prepareTypeHierarchy only queues empty round-trips. */
function skipsTypeHierarchy(uri: vscode.Uri): boolean {
    const ext = path.extname(uri.fsPath).toLowerCase();
    if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx'
        || ext === '.mts' || ext === '.cts' || ext === '.mjs' || ext === '.cjs') {
        return true;
    }
    const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
    const lang = open?.languageId;
    return lang === 'typescript' || lang === 'javascript'
        || lang === 'typescriptreact' || lang === 'javascriptreact';
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
        expandable,
        hopCapped: Math.abs(hop) >= CALL_MAX_HOP
    };
}

interface IncomingBudget {
    seq: number;
    deadline: number;
    goal: number;
    baseline: number;
}

interface MergeGroup {
    item: vscode.CallHierarchyItem;
    sites: vscode.Range[];
    depth: number;
    external: boolean;
}

type CenterIncomingScan = {
    key: string;
    resolvedKey: string;
    gen: number;
    epoch: number;
    rev: number;
    /** Index wave captured when this scan started. An edit bumps it and the page is not stored. */
    wave: number;
    ident: string;
    subject: vscode.CallHierarchyItem;
    items: vscode.CallHierarchyItem[];
    seen: Set<string>;
    lineCache: Map<string, Promise<string[] | undefined>>;
    phase: 'calls' | 'merge-setup' | 'merge' | 'refs';
    calls?: vscode.CallHierarchyIncomingCall[];
    callIndex: number;
    locations: vscode.Location[];
    locIndex: number;
    groups: Map<string, MergeGroup>;
    refGroups: Map<string, { item: vscode.CallHierarchyItem; sites: vscode.Range[] }>;
    slots: { uri: vscode.Uri; method: FlatSymbol }[];
    familyKeys: Map<string, number>;
    heritageShare: Map<string, 'subtype' | 'sibling' | 'unrelated'>;
    /** file+line+receiver expression → whether that static type can call this slot. */
    receiverReach: Map<string, Promise<'yes' | 'no' | 'unknown'>>;
    /** typeRefKey, or `name\0TypeName`, → same verdict. */
    typeReach: Map<string, Promise<'yes' | 'no' | 'unknown'>>;
    rootName: string;
};

type MergeHit = {
    caller: vscode.CallHierarchyItem;
    range: vscode.Range;
    depth: number;
    external: boolean;
};

type MergeStats = {
    files: number;
    cached: number;
    lineHits: number;
    thisHits: number;
    extFast: number;
    extDrop: number;
    /** Summed file-read time; batches run in parallel, so this can exceed wall time. */
    readMs: number;
    /** `super.ident()` inside the same-named override, settled by a local parse. */
    superLocal: number;
};

export class CallRelationModel {
    private readonly items = new Map<string, vscode.CallHierarchyItem>();
    /** Keys whose CallHierarchyItem came from prepareCallHierarchy (has LSP data). */
    private readonly preparedKeys = new Set<string>();
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
    /** Built graphs keyed by center itemKey; trail / double-click restore these. */
    private readonly centerSnaps = new Map<string, CenterSnapshot>();
    /** Shown on the left until root incoming lands (focus from a callee). */
    private incomingHint: vscode.CallHierarchyItem | undefined;
    /** Variables use Find All References on the left; functions use call hierarchy. */
    private relationMode: 'call' | 'reference' = 'call';
    /** Type shown on the References center tip. */
    private rootTypeName = '';
    /** Center type + ancestors: typeRefKey / uri+name → depth (0 = center type). */
    private readonly centerFamily = new Map<string, number>();
    private centerFamilyRootKey = '';
    /** itemKey → containing type, for incoming filter without touching the side cache. */
    private readonly ownerKeyByItem = new Map<string, SerOwner>();
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
    /** workspaceGen captured when an inflight side fetch started. */
    private readonly inflightInGen = new Map<string, number>();
    private readonly inflightOutGen = new Map<string, number>();
    /** Bumped on any file edit. Side caches stay visible but are stale until this matches. */
    private workspaceGen = 0;
    private readonly incomingAt = new Map<string, number>();
    private readonly outgoingAt = new Map<string, number>();
    /** Center incoming that stopped before the scan finished. */
    private readonly incomingScan = new Map<string, CenterIncomingScan>();
    /** Keys whose incoming more-button must stay "?" until the scan finishes. */
    private readonly incomingOpen = new Set<string>();
    /** Resume cursor for an indexed partial page whose scan object is not in this session. */
    private readonly partialMeta = new Map<string, { phase: SerPartial['phase']; locIndex: number; callIndex: number }>();
    /** Frozen caller order for a scan that already painted a page. */
    private readonly incomingOrder = new Map<string, string[]>();
    /** Root keys whose "?" click is already continuing the scan. */
    private readonly incomingResume = new Set<string>();
    /** Find Relation lists every kept caller. The graph pages the center instead. */
    private incomingListAll = false;
    /** Neighbor prefetch is async; the extension host is still one thread. */
    private prefetchBusy = false;
    /** Direct bases by type identity; dropped on any file change. */
    private readonly baseTypesCache = new Map<string, Promise<{ uri: vscode.Uri; symbol: FlatSymbol }[]>>();
    /** Ancestor walk from a type; dropped on any file change. */
    private readonly ancestorCache = new Map<string, Promise<TypeRef[]>>();
    /** Same-file heritage walks run one at a time so the second hits ancestorCache. */
    private readonly heritageFileTail = new Map<string, Promise<void>>();
    /** Semantic token legend by document uri. */
    private readonly semanticLegendCache = new Map<string, Promise<SemanticLegendInfo | undefined>>();
    private prefetchQueued = false;
    /** True while a neighbor peek sweep is in flight; drives spinner buttons. */
    private prefetchActive = false;
    /** In-flight expandHop node ids; a second click on the same + is ignored. */
    private readonly hopBusy = new Set<string>();
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

    /** True when +/− must wait on LSP / an in-flight peek. */
    hopNeedsFetch(node: RelationNode): boolean {
        const item = this.items.get(node.itemKey);
        if (!item) {
            return false;
        }
        const key = itemKey(item);
        if (node.hop < 0) {
            return !this.incoming.has(key);
        }
        if (node.hop > 0) {
            return !this.outgoing.has(key);
        }
        return !this.incoming.has(key) || !this.outgoing.has(key);
    }

    /** Drop in-flight work. Does not clear cached graph data. */
    cancel(): void {
        this.cts.cancel();
        this.cts.dispose();
        this.cts = new vscode.CancellationTokenSource();
        this.seq++;
        this.prefetchQueued = false;
        this.prefetchActive = false;
        this.hopBusy.clear();
    }

    reset(): void {
        this.cancel();
        this.clearGraphState();
    }

    private clearGraphState(): void {
        this.items.clear();
        this.preparedKeys.clear();
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
        this.centerSnaps.clear();
        this.incomingHint = undefined;
        this.relationMode = 'call';
        this.rootTypeName = '';
        this.centerFamily.clear();
        this.centerFamilyRootKey = '';
        this.ownerKeyByItem.clear();
        this.cacheEpoch++;
        this.fileGen.clear();
        this.inflightIn.clear();
        this.inflightOut.clear();
        this.inflightInGen.clear();
        this.inflightOutGen.clear();
        this.incomingAt.clear();
        this.outgoingAt.clear();
        this.incomingScan.clear();
        this.incomingOpen.clear();
        this.partialMeta.clear();
        this.incomingOrder.clear();
        this.incomingResume.clear();
        this.workspaceGen++;
        this.baseTypesCache.clear();
        this.ancestorCache.clear();
        this.heritageFileTail.clear();
        this.semanticLegendCache.clear();
        this.prefetchQueued = false;
        this.prefetchActive = false;
        this.hopBusy.clear();
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
        this.centerSnaps.clear();
    }

    setCompactKinds(ids: readonly string[]): void {
        this.compactKinds = kindsFromIds(ids);
        this.centerSnaps.clear();
    }

    setChildSort(sort: ChildSort): void {
        this.childSort = sort === 'order' ? 'order' : 'name';
        this.centerSnaps.clear();
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
        const keys = this.cacheKeysFor(item);
        const cache = dir < 0 ? this.incoming : this.outgoing;
        const stamps = dir < 0 ? this.incomingAt : this.outgoingAt;
        const gen = this.workspaceGen;
        let raw: vscode.CallHierarchyItem[] | undefined;
        let rawFresh = false;
        for (const key of keys) {
            const list = cache.get(key);
            if (!list) {
                continue;
            }
            const isFresh = stamps.get(key) === gen;
            if (rawFresh && !isFresh) {
                continue;
            }
            if ((isFresh && !rawFresh) || !raw || list.length > raw.length) {
                raw = list;
                rawFresh = isFresh;
            }
        }
        let extra: vscode.CallHierarchyItem[] | undefined;
        if (dir > 0) {
            for (const key of keys) {
                const list = this.superOutgoing.get(key);
                if (list?.length) {
                    extra = extra ? extra.concat(list) : list.slice();
                }
            }
        }
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
            return list;
        }
        return this.constrainIncomingToCenter(item, list);
    }

    /**
     * Incoming cache stays "who calls this method". Only same-named override
     * slots are collapsed: when a shared helper fans in several Prepares from
     * this type family, keep the nearest on the center chain. Different names
     * and same-named non-overrides (ActionManager.Prepare) are left alone.
     */
    private constrainIncomingToCenter(
        parent: vscode.CallHierarchyItem,
        kids: vscode.CallHierarchyItem[]
    ): vscode.CallHierarchyItem[] {
        if (this.relationMode !== 'call' || !this.root || !this.centerFamily.size || !kids.length) {
            return kids;
        }
        const parentOwner = this.ownerKeyByItem.get(itemKey(parent));
        const parentDepth = parentOwner ? this.chainDepth(parentOwner) : undefined;
        if (parentDepth === undefined || parentDepth <= 0) {
            return kids;
        }
        const byIdent = new Map<string, vscode.CallHierarchyItem[]>();
        const kept: vscode.CallHierarchyItem[] = [];
        for (const child of kids) {
            const ident = identFromToken(child.name);
            if (!ident) {
                kept.push(child);
                continue;
            }
            const group = byIdent.get(ident);
            if (group) {
                group.push(child);
            } else {
                byIdent.set(ident, [child]);
            }
        }
        for (const group of byIdent.values()) {
            if (group.length < 2) {
                kept.push(group[0]);
                continue;
            }
            const overrides: { child: vscode.CallHierarchyItem; depth: number }[] = [];
            const rest: vscode.CallHierarchyItem[] = [];
            for (const child of group) {
                const owner = this.ownerKeyByItem.get(itemKey(child));
                const kind = owner ? this.overrideKind(owner) : 'external';
                if (kind === 'chain' && owner) {
                    overrides.push({ child, depth: this.chainDepth(owner) ?? 0 });
                } else if (kind === 'sibling') {
                    overrides.push({ child, depth: Number.POSITIVE_INFINITY });
                } else {
                    rest.push(child);
                }
            }
            if (overrides.length < 2) {
                kept.push(...group);
                continue;
            }
            let nearest: vscode.CallHierarchyItem | undefined;
            let nearestDepth = Number.POSITIVE_INFINITY;
            for (const row of overrides) {
                if (row.depth < nearestDepth) {
                    nearestDepth = row.depth;
                    nearest = row.child;
                }
            }
            if (nearest) {
                kept.push(nearest);
            } else {
                kept.push(...overrides.map(row => row.child));
            }
            kept.push(...rest);
        }
        return kept;
    }

    private chainDepth(owner: { key: string; uri: string; name: string }): number | undefined {
        return this.centerFamily.get(owner.key) ?? this.centerFamily.get(`${owner.uri}\0${owner.name}`);
    }

    /** Same virtual slot on the center type family; not a coincidental same name. */
    private overrideKind(owner: {
        key: string;
        uri: string;
        name: string;
        ancestorKeys: string[];
    }): 'chain' | 'sibling' | 'external' {
        if (this.chainDepth(owner) !== undefined) {
            return 'chain';
        }
        for (const key of owner.ancestorKeys) {
            if (this.centerFamily.has(key)) {
                return 'sibling';
            }
        }
        return 'external';
    }

    private adoptRoot(item: vscode.CallHierarchyItem): void {
        const key = itemKey(item);
        if (!this.root || itemKey(this.root) !== key) {
            this.centerFamily.clear();
            this.centerFamilyRootKey = '';
        }
        this.root = item;
        this.remember(item);
    }

    private async refreshCenterFamily(): Promise<void> {
        if (this.relationMode !== 'call' || !this.root) {
            this.centerFamily.clear();
            this.centerFamilyRootKey = '';
            return;
        }
        const key = itemKey(this.root);
        if (key === this.centerFamilyRootKey && this.centerFamily.size) {
            await this.rememberOwner(this.root);
            return;
        }
        this.centerFamily.clear();
        const family = await this.selfAndAncestorTypes(this.root);
        for (const type of family) {
            const typeKey = typeRefKey(type.uri, type.symbol);
            const loose = `${type.uri.toString()}\0${type.symbol.name}`;
            const prev = this.centerFamily.get(loose);
            this.centerFamily.set(typeKey, type.depth);
            if (prev === undefined || type.depth < prev) {
                this.centerFamily.set(loose, type.depth);
            }
        }
        this.centerFamilyRootKey = key;
        await this.rememberOwner(this.root);
    }

    private async rememberOwner(item: vscode.CallHierarchyItem, stat?: OwnerFill): Promise<void> {
        const key = itemKey(item);
        const cur = this.ownerKeyByItem.get(key);
        if (cur?.ancestorKeys) {
            if (stat) {
                stat.hit++;
            }
            return;
        }
        const position = item.selectionRange?.start ?? item.range.start;
        const id = ownerIndexId(item.uri, position);
        const index = relationIndex();
        const hit = await index.take<SerOwner>(id);
        if (hit?.none || (hit && Array.isArray(hit.ancestorKeys) && hit.key && hit.uri && hit.name)) {
            this.ownerKeyByItem.set(key, hit);
            if (stat) {
                stat.hit++;
            }
            return;
        }
        const uriStr = item.uri.toString();
        const flat = await this.documentSymbols(item.uri);
        if (stat) {
            stat.fresh++;
        }
        const symbol = flat ? pickContainingType(flat, position) : undefined;
        if (!symbol) {
            if (flat && !flat.length && stat) {
                stat.empty++;
            }
            const none: SerOwner = { key: '', uri: '', name: '', ancestorKeys: [], none: true };
            this.ownerKeyByItem.set(key, none);
            if (await index.putLive(id, none, [uriStr])) {
                if (stat) {
                    stat.stored++;
                }
            }
            return;
        }
        const bases = await this.collectAncestorTypesFrom({
            uri: item.uri,
            symbol,
            depth: 0
        });
        const ancestorKeys: string[] = [];
        for (const type of bases) {
            ancestorKeys.push(typeRefKey(type.uri, type.symbol));
            ancestorKeys.push(`${type.uri.toString()}\0${type.symbol.name}`);
        }
        const record: SerOwner = {
            key: typeRefKey(item.uri, symbol),
            uri: uriStr,
            name: symbol.name,
            ancestorKeys
        };
        this.ownerKeyByItem.set(key, record);
        if (await index.putLive(id, record, [uriStr, ...bases.map(type => type.uri.toString())])) {
            if (stat) {
                stat.stored++;
            }
        }
    }

    private async rememberOwners(items: vscode.CallHierarchyItem[]): Promise<void> {
        const t0 = Date.now();
        const stat: OwnerFill = { hit: 0, fresh: 0, stored: 0, empty: 0 };
        const chunk = 12;
        for (let i = 0; i < items.length; i += chunk) {
            await Promise.all(items.slice(i, i + chunk).map(item => this.rememberOwner(item, stat)));
        }
        costLog(
            'owners',
            Date.now() - t0,
            `n=${items.length} hit=${stat.hit} fresh=${stat.fresh} stored=${stat.stored} empty=${stat.empty} ${relationIndex().status()}`
        );
    }

    invalidateUri(uri: vscode.Uri): void {
        const u = uri.toString();
        relationIndex().invalidateUri(u);
        this.fileGen.set(u, (this.fileGen.get(u) ?? 0) + 1);
        // Any edit can add or remove a caller. Keep the lists on screen, but
        // stamp them stale so the next show / focus / + refetches instead of
        // filtering callers out and then treating the short list as final.
        this.workspaceGen++;
        for (const [key, item] of this.items) {
            if (item.uri.toString() !== u) {
                continue;
            }
            this.preparedKeys.delete(key);
            this.ownerKeyByItem.delete(key);
        }
        this.baseTypesCache.clear();
        this.ancestorCache.clear();
        this.semanticLegendCache.delete(u);
        this.centerSnaps.clear();
        this.incomingScan.clear();
        this.incomingOpen.clear();
        this.partialMeta.clear();
        this.incomingOrder.clear();
    }

    remember(item: vscode.CallHierarchyItem): string {
        const key = itemKey(item);
        if (!this.items.has(key)) {
            this.items.set(key, item);
        }
        return key;
    }

    private markPrepared(item: vscode.CallHierarchyItem): string {
        const key = itemKey(item);
        this.items.set(key, item);
        this.preparedKeys.add(key);
        return key;
    }

    /**
     * Same pick as focusNode: containing sel, else [0], else the original item.
     * Remap the graph key onto the prepared item so + and recenter share one cache.
     */
    private bindPrepared(
        item: vscode.CallHierarchyItem,
        prepared: vscode.CallHierarchyItem[] | undefined
    ): vscode.CallHierarchyItem {
        const sel = item.selectionRange?.start ?? item.range.start;
        const resolved = prepared?.length
            ? (prepared.find(it => rangeContains(it.range, sel)) || prepared[0])
            : item;
        if (prepared?.length) {
            this.markPrepared(resolved);
            const orig = itemKey(item);
            if (itemKey(resolved) !== orig) {
                this.items.set(orig, resolved);
                this.preparedKeys.add(orig);
            }
        }
        return resolved;
    }

    /**
     * One side of a neighbor. A cached side restores callers and owners without
     * prepareCallHierarchy; a miss prepares inside the fetch.
     */
    private async peekNeighborSide(
        item: vscode.CallHierarchyItem,
        dir: -1 | 1,
        graphKey: string,
        seq: number
    ): Promise<void> {
        if (dir < 0) {
            await this.ensureIncoming(item, seq);
        } else {
            await this.ensureOutgoing(item, seq);
        }
        const cache = dir < 0 ? this.incoming : this.outgoing;
        const subject = this.items.get(itemKey(item)) || item;
        const subjectKey = itemKey(subject);
        this.shareSide(cache, subjectKey, itemKey(item));
        this.shareSide(cache, subjectKey, graphKey);
        const n = this.sideCount(item, dir);
        const plus = this.canExpand(item, dir);
        peekLog(
            'leaf',
            `dir=${dir < 0 ? 'left/in' : 'right/out'} item=${itemLabel(item)} subject=${itemLabel(subject)}`
            + ` graphKey=${graphKey === itemKey(item) ? 'same' : 'DIFF'} subjectKey=${subjectKey === itemKey(item) ? 'same' : 'DIFF'}`
            + ` n=${n} plus=${plus} in=${this.sideCount(item, -1)} out=${this.sideCount(item, 1)}`
            + ` inHas=${this.cacheKeysFor(item).some(k => this.incoming.has(k))}`
            + ` outHas=${this.cacheKeysFor(item).some(k => this.outgoing.has(k))}`
        );
    }

    private shareSide(
        cache: Map<string, vscode.CallHierarchyItem[]>,
        fromKey: string,
        toKey: string
    ): void {
        if (!toKey || fromKey === toKey) {
            return;
        }
        const src = cache.get(fromKey);
        if (src === undefined) {
            return;
        }
        const dst = cache.get(toKey);
        if (!dst || dst.length < src.length) {
            cache.set(toKey, src);
            const stamps = cache === this.incoming ? this.incomingAt : this.outgoingAt;
            const stamp = stamps.get(fromKey);
            if (stamp !== undefined) {
                stamps.set(toKey, stamp);
            }
        }
        this.aliasCallSites(fromKey, toKey);
    }

    /**
     * provideIncomingCalls / provideOutgoingCalls 要的是 prepareCallHierarchy 返回的节点
     *（语言服务常在 item 上挂内部 data）。References 图左侧是 enclosing 拼出来的，
     * 直接预取会空；先 prepare 再拉，并让合成 key 与 prepare key 共用缓存。
     * 声明的 selection 可能落在 `public` 上，构造函数要改问 `constructor` 这个词。
     */
    private async nameTokenPosition(
        uri: vscode.Uri,
        range: vscode.Range,
        selection: vscode.Range | undefined,
        name: string
    ): Promise<vscode.Position> {
        const ident = identFromToken(name);
        const fallback = selection?.start ?? range.start;
        if (!ident) {
            return fallback;
        }
        let doc: vscode.TextDocument;
        try {
            doc = await vscode.workspace.openTextDocument(uri);
        } catch {
            return fallback;
        }
        const word = doc.getWordRangeAtPosition(fallback);
        if (word && identFromToken(doc.getText(word)) === ident) {
            return word.start;
        }
        const re = new RegExp(`\\b${escapeRegExp(ident)}\\b`);
        const last = Math.min(doc.lineCount - 1, Math.max(range.end.line, fallback.line));
        for (let line = Math.max(0, range.start.line); line <= last; line++) {
            const text = doc.lineAt(line).text;
            const brace = text.indexOf('{');
            const slice = brace >= 0 ? text.slice(0, brace) : text;
            const from = line === range.start.line ? range.start.character : 0;
            const match = re.exec(from > 0 ? slice.slice(from) : slice);
            if (match) {
                return new vscode.Position(line, from + match.index);
            }
            if (brace >= 0) {
                break;
            }
        }
        return fallback;
    }

    private async resolveForHierarchy(item: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyItem | undefined> {
        const key = itemKey(item);
        if (this.preparedKeys.has(key)) {
            return this.items.get(key) || item;
        }
        const sel = await this.nameTokenPosition(item.uri, item.range, item.selectionRange, item.name);
        const prepared = await this.execLspHeld<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            item.uri,
            sel
        );
        if (!prepared?.length) {
            return item;
        }
        return this.bindPrepared(item, prepared);
    }

    private cacheKeysFor(item: vscode.CallHierarchyItem): string[] {
        const primary = itemKey(item);
        const mapped = this.items.get(primary);
        const mappedKey = mapped ? itemKey(mapped) : primary;
        const keys = new Set<string>([primary, mappedKey]);
        for (const [k, v] of this.items) {
            const vk = itemKey(v);
            if (vk === primary || vk === mappedKey) {
                keys.add(k);
            }
        }
        return [...keys];
    }

    /** Authoritative side write. A newer generation is left in place. */
    private commitSides(
        cache: Map<string, vscode.CallHierarchyItem[]>,
        stamps: Map<string, number>,
        keys: readonly string[],
        items: vscode.CallHierarchyItem[],
        stamp: number
    ): void {
        for (const k of keys) {
            const cur = stamps.get(k);
            if (cur !== undefined && cur > stamp && cache.has(k)) {
                continue;
            }
            cache.set(k, items);
            stamps.set(k, stamp);
        }
    }

    private sideFresh(item: vscode.CallHierarchyItem, dir: -1 | 1): boolean {
        const cache = dir < 0 ? this.incoming : this.outgoing;
        const stamps = dir < 0 ? this.incomingAt : this.outgoingAt;
        const gen = this.workspaceGen;
        return this.cacheKeysFor(item).some(key => cache.has(key) && stamps.get(key) === gen);
    }

    private aliasCallSites(fromKey: string, toKey: string): void {
        if (!toKey || fromKey === toKey) {
            return;
        }
        const prefix = `${fromKey}\0`;
        for (const [siteKey, sites] of this.callSites) {
            if (!siteKey.startsWith(prefix)) {
                continue;
            }
            const alias = toKey + siteKey.slice(fromKey.length);
            if (!this.callSites.has(alias)) {
                this.callSites.set(alias, sites);
            }
        }
    }

    private itemFromSer(raw: SerItem): vscode.CallHierarchyItem {
        const made = new vscode.CallHierarchyItem(
            raw.kind,
            raw.name,
            raw.detail || '',
            vscode.Uri.parse(raw.uri),
            deRange(raw.range),
            deRange(raw.sel)
        );
        const key = itemKey(made);
        const existing = this.items.get(key);
        if (existing) {
            return existing;
        }
        this.items.set(key, made);
        return made;
    }

    private applySide(keys: readonly string[], dir: -1 | 1, body: SerSide, gen: number): void {
        const items = (body.callers || []).map(raw => this.itemFromSer(raw));
        const cache = dir < 0 ? this.incoming : this.outgoing;
        const stamps = dir < 0 ? this.incomingAt : this.outgoingAt;
        this.commitSides(cache, stamps, keys, items, gen);
        for (const parentKey of keys) {
            if (!parentKey) {
                continue;
            }
            for (const [childKey, sites] of Object.entries(body.sites || {})) {
                this.callSites.set(`${parentKey}\0${dir}\0${childKey}`, sites);
            }
            if (dir > 0 && body.superCallers?.length) {
                this.superOutgoing.set(parentKey, body.superCallers.map(raw => this.itemFromSer(raw)));
            }
        }
        if (dir < 0 && body.owners) {
            for (const [ownerKey, owner] of Object.entries(body.owners)) {
                if (owner && Array.isArray(owner.ancestorKeys)) {
                    this.ownerKeyByItem.set(ownerKey, owner);
                }
            }
        }
    }

    private captureSide(
        dir: -1 | 1,
        parentKeys: readonly string[],
        parent: vscode.CallHierarchyItem,
        items: vscode.CallHierarchyItem[]
    ): { body: SerSide; deps: string[] } {
        const sites: Record<string, RelationOpenTarget[]> = {};
        const consider = items.slice();
        let superCallers: SerItem[] | undefined;
        if (dir > 0) {
            for (const parentKey of parentKeys) {
                const list = this.superOutgoing.get(parentKey);
                if (!list?.length) {
                    continue;
                }
                superCallers = list.map(serItem);
                for (const extra of list) {
                    if (!consider.some(child => itemKey(child) === itemKey(extra))) {
                        consider.push(extra);
                    }
                }
                break;
            }
        }
        for (const child of consider) {
            const childKey = itemKey(child);
            for (const parentKey of parentKeys) {
                const stored = this.callSites.get(`${parentKey}\0${dir}\0${childKey}`);
                if (stored?.length) {
                    sites[childKey] = stored;
                    break;
                }
            }
        }
        const deps = new Set<string>();
        deps.add(parent.uri.toString());
        for (const child of consider) {
            deps.add(child.uri.toString());
        }
        for (const list of Object.values(sites)) {
            for (const site of list) {
                if (site.uri) {
                    deps.add(site.uri);
                }
            }
        }
        const body: SerSide = {
            callers: items.map(serItem),
            sites
        };
        if (superCallers?.length) {
            body.superCallers = superCallers;
        }
        if (dir < 0) {
            const owners: Record<string, SerOwner> = {};
            for (const it of [parent, ...consider]) {
                const owner = this.ownerKeyByItem.get(itemKey(it));
                if (!owner) {
                    continue;
                }
                owners[itemKey(it)] = owner;
                for (const uri of ownerDepUris(owner)) {
                    deps.add(uri);
                }
            }
            if (Object.keys(owners).length) {
                body.owners = owners;
            }
        }
        return { body, deps: [...deps] };
    }

    private async storeSide(
        dir: -1 | 1,
        parentKeys: readonly string[],
        parent: vscode.CallHierarchyItem,
        items: vscode.CallHierarchyItem[],
        extraDeps: readonly string[],
        wave: number,
        live = false
    ): Promise<void> {
        const index = relationIndex();
        if (!live && index.waveNow() !== wave) {
            return;
        }
        const captured = this.captureSide(dir, parentKeys, parent, items);
        const deps = new Set<string>(captured.deps);
        for (const uri of extraDeps) {
            if (uri) {
                deps.add(uri);
            }
        }
        const keys = [...new Set(parentKeys.filter((key): key is string => !!key))];
        if (!keys.length) {
            return;
        }
        if (live) {
            for (const key of keys) {
                for (const uri of index.depUris(`side\0${dir}\0${key}`)) {
                    deps.add(uri);
                }
            }
        }
        const canonical = `side\0${dir}\0${keys[0]}`;
        const depList = [...deps];
        const write = (id: string, payload: unknown) => (
            live
                ? index.putLive(id, payload, depList)
                : index.put(id, payload, depList, wave)
        );
        for (const key of keys.slice(1)) {
            await write(`side\0${dir}\0${key}`, { ref: canonical });
        }
        await write(canonical, captured.body);
        if (dir < 0 && (live || index.waveNow() === wave)) {
            for (const key of keys) {
                index.forget(`part\0-1\0${key}`);
            }
        }
        costLog('index store', 0, `${dir < 0 ? 'in' : 'out'} ${itemLabel(parent)} n=${items.length} ${index.status()}`);
    }

    private async loadSide(keys: readonly string[], dir: -1 | 1): Promise<SerSide | undefined> {
        const index = relationIndex();
        for (const key of keys) {
            if (!key) {
                continue;
            }
            const id = `side\0${dir}\0${key}`;
            const raw = await index.take<SerSide | { ref: string }>(id);
            if (!raw) {
                continue;
            }
            if (isSerSide(raw)) {
                return raw;
            }
            const ref = raw.ref;
            if (!ref) {
                continue;
            }
            const body = await index.take<SerSide>(ref);
            if (isSerSide(body)) {
                return body;
            }
            index.forget(id);
        }
        return undefined;
    }

    private async restoreSide(
        keys: readonly string[],
        dir: -1 | 1,
        gen: number,
        epoch: number
    ): Promise<boolean> {
        const body = await this.loadSide(keys, dir);
        if (!body || this.cacheEpoch !== epoch || this.workspaceGen !== gen) {
            return false;
        }
        if (dir < 0) {
            this.finishCompleteIncoming([...keys]);
        }
        this.applySide(keys, dir, body, gen);
        return true;
    }

    private async storePartialIncoming(scan: CenterIncomingScan, keys: readonly string[], items: vscode.CallHierarchyItem[]): Promise<void> {
        const index = relationIndex();
        if (index.waveNow() !== scan.wave || !keys.length) {
            return;
        }
        const captured = this.captureSide(-1, keys, scan.subject, items);
        const deps = new Set<string>(captured.deps);
        for (const uri of this.scanDepUris(scan)) {
            deps.add(uri);
        }
        const body: SerPartial = {
            side: captured.body,
            phase: scan.phase,
            locIndex: scan.locIndex,
            callIndex: scan.callIndex
        };
        const depList = [...deps];
        for (const key of keys) {
            if (key) {
                await index.put(`part\0-1\0${key}`, body, depList, scan.wave);
            }
        }
        costLog('index partial', 0, `${itemLabel(scan.subject)} n=${items.length} phase=${scan.phase} at=${scan.locIndex} ${index.status()}`);
    }

    private async restorePartialIncoming(keys: readonly string[], gen: number, epoch: number): Promise<boolean> {
        const index = relationIndex();
        let body: SerPartial | undefined;
        for (const key of keys) {
            if (!key) {
                continue;
            }
            const hit = await index.take<SerPartial>(`part\0-1\0${key}`);
            if (hit?.side && Array.isArray(hit.side.callers)) {
                body = hit;
                break;
            }
        }
        if (!body || this.cacheEpoch !== epoch || this.workspaceGen !== gen) {
            return false;
        }
        this.applySide(keys, -1, body.side, gen);
        const stored = this.incoming.get(keys[0]) || this.incoming.get(keys[1] || '') || [];
        const order = stored.map(item => itemKey(item));
        for (const key of keys) {
            if (!key) {
                continue;
            }
            this.incomingOpen.add(key);
            this.incomingOrder.set(key, order);
            this.partialMeta.set(key, {
                phase: body.phase,
                locIndex: body.locIndex,
                callIndex: body.callIndex
            });
        }
        return true;
    }

    private scanDepUris(scan: CenterIncomingScan): string[] {
        const deps = new Set<string>();
        deps.add(scan.subject.uri.toString());
        for (const loc of scan.locations) {
            deps.add(loc.uri.toString());
        }
        for (const slot of scan.slots) {
            deps.add(slot.uri.toString());
        }
        for (const key of scan.familyKeys.keys()) {
            const uri = key.split('\0')[0];
            if (uri) {
                deps.add(uri);
            }
        }
        return [...deps];
    }

    private forgetEmptySides(item: vscode.CallHierarchyItem): void {
        const key = itemKey(item);
        if (this.incoming.has(key) && (this.incoming.get(key)?.length ?? 0) === 0) {
            this.forgetSides(item);
        }
    }

    /** Drop cached sides so a class References visit cannot starve constructor Call. */
    private forgetSides(item: vscode.CallHierarchyItem): void {
        for (const key of this.cacheKeysFor(item)) {
            this.incoming.delete(key);
            this.outgoing.delete(key);
            this.incomingAt.delete(key);
            this.outgoingAt.delete(key);
            this.inflightIn.delete(key);
            this.inflightOut.delete(key);
            this.inflightInGen.delete(key);
            this.inflightOutGen.delete(key);
            this.preparedKeys.delete(key);
            this.incomingScan.delete(key);
            this.incomingOpen.delete(key);
            this.incomingOrder.delete(key);
            const prefix = `${key}\0`;
            for (const siteKey of [...this.callSites.keys()]) {
                if (siteKey.startsWith(prefix)) {
                    this.callSites.delete(siteKey);
                }
            }
        }
    }

    private resetCenter(item: vscode.CallHierarchyItem): void {
        this.centerSnaps.clear();
        this.centerTrail = [item];
        this.centerIndex = 0;
    }

    private stashCenter(graph: RelationGraph): void {
        if (!this.root || !graph.nodes.length) {
            return;
        }
        const key = itemKey(this.root);
        this.centerSnaps.delete(key);
        this.centerSnaps.set(key, {
            graph: cloneRelationGraph(graph),
            shown: new Map(this.shown),
            expanded: new Set(this.expanded),
            keepExpand: new Set(this.keepExpand),
            keepGroups: new Set(this.keepGroups),
            collapseLock: new Set(this.collapseLock),
            relationMode: this.relationMode,
            incomingHint: this.incomingHint,
            root: this.root,
            rootTypeName: this.rootTypeName,
            centerFamily: new Map(this.centerFamily),
            centerFamilyRootKey: this.centerFamilyRootKey
        });
        const keep = new Set(this.centerTrail.map(item => itemKey(item)));
        keep.add(key);
        for (const snapKey of [...this.centerSnaps.keys()]) {
            if (this.centerSnaps.size <= 24) {
                break;
            }
            if (!keep.has(snapKey)) {
                this.centerSnaps.delete(snapKey);
            }
        }
        while (this.centerSnaps.size > 24) {
            const first = this.centerSnaps.keys().next().value;
            if (first === undefined) {
                break;
            }
            this.centerSnaps.delete(first);
        }
    }

    private restoreCenter(key: string): RelationGraph | undefined {
        const snap = this.centerSnaps.get(key);
        if (!snap) {
            return undefined;
        }
        this.shown.clear();
        for (const [k, n] of snap.shown) {
            this.shown.set(k, n);
        }
        this.expanded.clear();
        for (const id of snap.expanded) {
            this.expanded.add(id);
        }
        this.keepExpand.clear();
        for (const id of snap.keepExpand) {
            this.keepExpand.add(id);
        }
        this.keepGroups.clear();
        for (const id of snap.keepGroups) {
            this.keepGroups.add(id);
        }
        this.collapseLock.clear();
        for (const id of snap.collapseLock) {
            this.collapseLock.add(id);
        }
        this.relationMode = snap.relationMode;
        this.root = snap.root;
        this.remember(snap.root);
        this.incomingHint = snap.incomingHint;
        this.rootTypeName = snap.rootTypeName;
        this.centerFamily.clear();
        for (const [k, depth] of snap.centerFamily) {
            this.centerFamily.set(k, depth);
        }
        this.centerFamilyRootKey = snap.centerFamilyRootKey;
        return cloneRelationGraph(snap.graph);
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

    private async presentCachedReference(
        rootRaw: SerItem,
        side: SerSide,
        seq: number,
        t0: number,
        opts: { lean?: boolean } | undefined,
        name: string
    ): Promise<{ graph: RelationGraph; seq: number } | undefined> {
        const root = this.itemFromSer(rootRaw);
        const rootKey = itemKey(root);
        this.finishCompleteIncoming([rootKey]);
        this.applySide([rootKey], -1, side, this.workspaceGen);
        costLog('reference index', Date.now() - t0, `${itemLabel(root)} n=${side.callers.length}`);
        return this.presentReferenceRoot(root, seq, t0, opts, name);
    }

    /** Incoming for `root` is already committed. Paint the reference center and return the graph. */
    private async presentReferenceRoot(
        root: vscode.CallHierarchyItem,
        seq: number,
        t0: number,
        opts: { lean?: boolean } | undefined,
        name: string
    ): Promise<{ graph: RelationGraph; seq: number } | undefined> {
        this.shown.clear();
        this.expanded.clear();
        this.keepExpand.clear();
        this.keepGroups.clear();
        this.collapseLock.clear();
        this.prevRoot = undefined;
        this.incomingHint = undefined;
        this.relationMode = 'reference';
        this.adoptRoot(root);
        this.resetCenter(root);
        const rootKey = itemKey(root);
        this.outgoing.set(rootKey, []);
        if (!opts?.lean) {
            this.paintNow(seq);
            const sel = root.selectionRange?.start ?? root.range.start;
            this.rootTypeName = await resolveValueType(
                root.uri,
                sel,
                identFromToken(root.name) || name
            );
            if (!this.isCurrent(seq)) {
                return undefined;
            }
            this.paintNow(seq);
        }
        const callers = this.incoming.get(rootKey) || [];
        const graph = opts?.lean
            ? this.buildGraph()
            : await this.buildVisible(seq);
        if (!graph || !this.isCurrent(seq)) {
            return undefined;
        }
        if (!callers.length) {
            graph.notice = name
                ? `No references for “${name}” outside its declaration.`
                : 'No references at this position.';
        }
        costLog('reference root', Date.now() - t0, `${itemLabel(root)} n=${callers.length}${opts?.lean ? ' lean' : ''}`);
        return { graph, seq };
    }

    private async loadReferenceRoot(
        uri: vscode.Uri,
        position: vscode.Position,
        seq: number,
        t0: number,
        opts?: { lean?: boolean }
    ): Promise<{ graph: RelationGraph; seq: number } | undefined> {
        const name = await tokenAt(uri, position);
        if (!opts?.lean) {
            const early = await this.itemFromCursor(uri, position);
            if (!this.isCurrent(seq)) {
                return undefined;
            }
            this.paintCenterNow(early || this.stubCenterItem(uri, position, name), seq, 'reference');
        }
        const cursorId = referenceIndexId(uri, position, name);
        const pointer = await relationIndex().take<SerRefPointer>(cursorId);
        if (pointer && this.isCurrent(seq)) {
            const side = await relationIndex().take<SerSide>(pointer.ref);
            if (side && this.isCurrent(seq)) {
                return this.presentCachedReference(pointer.root, side, seq, t0, opts, name);
            }
            if (!side) {
                relationIndex().forget(cursorId);
            }
        }
        const refGen = this.workspaceGen;
        const refWave = relationIndex().waveNow();
        const root = await this.referenceRootItem(uri, position, name);
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        if (this.root && this.relationMode === 'reference' && itemKey(this.root) === itemKey(root)
            && this.incomingAt.get(itemKey(root)) === this.workspaceGen) {
            this.prevRoot = undefined;
            this.incomingHint = undefined;
            return { graph: this.buildGraph(), seq };
        }
        const rootKeyEarly = itemKey(root);
        if (await this.restoreSide([rootKeyEarly], -1, refGen, this.cacheEpoch)) {
            return this.presentReferenceRoot(root, seq, t0, opts, name);
        }
        const refs = await this.execLsp<vscode.Location[]>(
            seq,
            'vscode.executeReferenceProvider',
            uri,
            position
        );
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        this.shown.clear();
        this.expanded.clear();
        this.keepExpand.clear();
        this.keepGroups.clear();
        this.collapseLock.clear();
        this.prevRoot = undefined;
        this.incomingHint = undefined;
        this.relationMode = 'reference';
        this.adoptRoot(root);
        this.resetCenter(root);
        const rootKey = itemKey(root);
        this.outgoing.set(rootKey, []);
        if (!opts?.lean) {
            this.paintNow(seq);
            const sel = root.selectionRange?.start ?? root.range.start;
            this.rootTypeName = await resolveValueType(
                root.uri,
                sel,
                identFromToken(root.name) || name
            );
            if (!this.isCurrent(seq)) {
                return undefined;
            }
            this.paintNow(seq);
        }
        const locations = (refs || [])
            .map(loc => this.asLocation(loc))
            .filter((loc): loc is vscode.Location => !!loc && !this.isDeclSite(root, loc));
        const epoch = this.cacheEpoch;
        const rev = this.fileRev(root.uri);
        const scan = this.blankIncomingScan(
            root,
            rootKey,
            rootKey,
            identFromToken(root.name) || name,
            refGen,
            epoch,
            rev,
            refWave
        );
        scan.phase = 'refs';
        scan.locations = locations;
        scan.rootName = name;
        const budget: IncomingBudget | undefined = opts?.lean
            ? undefined
            : {
                seq,
                deadline: t0 + INCOMING_BUDGET_MS,
                goal: CALL_PAGE,
                baseline: 0
            };
        const paused = await this.consumeReferenceLocations(scan, budget);
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        if (!paused) {
            if (!this.sideGenerationLive(epoch, refGen, rev, root.uri)) {
                return undefined;
            }
            this.finishCompleteIncoming([rootKey]);
            this.commitSides(this.incoming, this.incomingAt, [rootKey], scan.items, refGen);
            const locUris = locations.map(loc => loc.uri.toString());
            await relationIndex().put(
                cursorId,
                { root: serItem(root), ref: `side\0-1\0${rootKey}` } satisfies SerRefPointer,
                [uri.toString(), root.uri.toString(), ...locUris],
                refWave
            );
            await this.storeSide(-1, [rootKey], root, scan.items, [uri.toString(), ...locUris], refWave);
        }
        const callers = this.incoming.get(rootKey) || scan.items;
        const graph = opts?.lean
            ? this.buildGraph()
            : await this.buildVisible(seq);
        if (!graph || !this.isCurrent(seq)) {
            return undefined;
        }
        if (!callers.length) {
            graph.notice = name
                ? `No references for “${name}” outside its declaration.`
                : 'No references at this position.';
        }
        costLog('reference root', Date.now() - t0, `${itemLabel(root)} n=${callers.length}${opts?.lean ? ' lean' : ''}`);
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
        if (this.relationMode === 'reference') {
            this.forgetEmptySides(next);
        }
        this.relationMode = 'call';
        this.adoptRoot(next);
        this.resetCenter(next);
        this.paintNow(seq);
        const rootName = itemLabel(next);
        const tRoot = Date.now();
        await this.ensureOutgoing(next, seq);
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
        this.markPrepared(caller);
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
        this.adoptRoot(callee);
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
            return this.buildVisible(seq);
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
        if (!maybeSame) {
            await this.paintLocalCenter(uri, position, seqPrepare);
        }

        const valueSym = await symbolAtPosition(uri, position);
        if (!this.isCurrent(seqPrepare)) {
            return undefined;
        }
        if (valueSym && isReferenceRelationKind(valueSym.kind) && !isCallablePropertyKind(valueSym.kind)) {
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
            if (valueSym && isReferenceRelationKind(valueSym.kind)) {
                return this.loadReferenceRoot(uri, position, seqPrepare, t0);
            }
            if (await this.semanticIsReferenceValue(uri, position)) {
                if (!this.isCurrent(seqPrepare)) {
                    return undefined;
                }
                return this.loadReferenceRoot(uri, position, seqPrepare, t0);
            }
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
        this.markPrepared(next);
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
            if (this.openedFromCallSite(uri, position, next) && this.sideFresh(next, -1) && this.sideEmpty(next, -1)) {
                return this.recenterViaCallerOutgoing(uri, position, seqPrepare, t0, next, next.name);
            }
            if (this.sideFresh(next, -1) && this.sideFresh(next, 1)) {
                costLog('loadRoot same', Date.now() - t0, itemLabel(next));
                return { graph: this.buildGraph(), seq: seqPrepare };
            }
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
            if (this.relationMode === 'reference') {
                this.forgetEmptySides(next);
            }
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

    /**
     * Find Relation: same root as loadRoot, but only first-level incoming.
     * No outgoing, no neighbor prefetch, no call-site recenter via the
     * enclosing caller's outgoing. Incoming runs to completion with the
     * same caller filter as the graph, without the center page budget.
     */
    async loadIncomingRoot(
        uri: vscode.Uri,
        position: vscode.Position
    ): Promise<{ graph: RelationGraph; seq: number } | undefined> {
        const t0 = Date.now();
        const loc = `${fileLabel(uri)}:${position.line + 1}:${position.character + 1}`;
        this.cancel();
        const seq = this.seq;
        this.incomingListAll = true;
        costLog('loadIncomingRoot begin', 0, loc);

        const valueSym = await symbolAtPosition(uri, position);
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        if (valueSym && isReferenceRelationKind(valueSym.kind) && !isCallablePropertyKind(valueSym.kind)) {
            return this.loadReferenceRoot(uri, position, seq, t0, { lean: true });
        }

        const prepared = await this.execLsp<vscode.CallHierarchyItem[]>(
            seq,
            'vscode.prepareCallHierarchy',
            uri,
            position
        );
        if (!this.isCurrent(seq)) {
            costLog('loadIncomingRoot cancelled', Date.now() - t0, `${loc} after prepare`);
            return undefined;
        }
        if (!prepared?.length) {
            costLog('loadIncomingRoot empty', Date.now() - t0, loc);
            if (valueSym && isReferenceRelationKind(valueSym.kind)) {
                return this.loadReferenceRoot(uri, position, seq, t0, { lean: true });
            }
            if (await this.semanticIsReferenceValue(uri, position)) {
                if (!this.isCurrent(seq)) {
                    return undefined;
                }
                return this.loadReferenceRoot(uri, position, seq, t0, { lean: true });
            }
            return this.lspEmptyGraph(seq);
        }

        const next = prepared.find(item => rangeContains(item.range, position)) || prepared[0];
        this.markPrepared(next);
        if (isAnonymousSymbolName(next.name)) {
            const name = await tokenAt(uri, position);
            if (!this.isCurrent(seq)) {
                return undefined;
            }
            if (name) {
                return this.loadReferenceRoot(uri, position, seq, t0, { lean: true });
            }
            return this.lspEmptyGraph(seq);
        }
        return this.adoptIncomingOnly(next, seq, t0);
    }

    private async adoptIncomingOnly(
        next: vscode.CallHierarchyItem,
        seq: number,
        t0: number
    ): Promise<{ graph: RelationGraph; seq: number } | undefined> {
        this.shown.clear();
        this.expanded.clear();
        this.keepExpand.clear();
        this.keepGroups.clear();
        this.collapseLock.clear();
        this.prevRoot = undefined;
        this.incomingHint = undefined;
        this.relationMode = 'call';
        this.adoptRoot(next);
        this.resetCenter(next);
        await this.refreshCenterFamily();
        if (!this.isCurrent(seq) || !this.root) {
            return undefined;
        }
        await this.ensureIncoming(this.root, seq);
        if (!this.isCurrent(seq) || !this.root) {
            costLog('loadIncomingRoot cancelled', Date.now() - t0, itemLabel(next));
            return undefined;
        }
        const graph = this.buildGraph();
        costLog('loadIncomingRoot done', Date.now() - t0, `${itemLabel(this.root)} n=${this.incoming.get(itemKey(this.root))?.length ?? 0}`);
        return { graph, seq };
    }

    async expandMore(nodeId: string): Promise<RelationLoad | undefined> {
        const seq = this.seq;
        const root = this.root;
        const rootKey = root ? itemKey(root) : '';
        let scan = rootKey ? this.incomingScan.get(rootKey) : undefined;
        const rootMore = !!root && nodeId === `${itemKey(root)}@0:-1`;
        if (rootMore && !scan && root && this.incomingOpen.has(rootKey)) {
            scan = await this.rehydrateIncomingScan(root);
        }
        if (rootMore && scan) {
            if (this.incomingResume.has(rootKey)) {
                return undefined;
            }
            this.incomingResume.add(rootKey);
            try {
                const have = this.incoming.get(rootKey)?.length ?? scan.items.length;
                const displayed = this.shown.get(nodeId) ?? CALL_PAGE;
                const goal = displayed + CALL_PAGE;
                if (have < goal) {
                    await this.resumeIncomingScan(scan, seq, goal, have);
                }
                if (!this.isCurrent(seq)) {
                    return undefined;
                }
                const after = this.incoming.get(rootKey)?.length ?? have;
                this.shown.set(nodeId, Math.min(after, goal));
            } finally {
                this.incomingResume.delete(rootKey);
            }
        } else {
            const current = this.shown.get(nodeId) ?? CALL_PAGE;
            this.shown.set(nodeId, current + CALL_PAGE);
        }
        const graph = await this.buildVisible(seq);
        return graph ? { graph, seq } : undefined;
    }

    collapseHop(nodeId: string, nodes: RelationNode[]): RelationPatch {
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
        drop.delete(nodeId);
        return { op: 'collapse', parentId: nodeId, dropIds: [...drop] };
    }

    async expandHop(nodeId: string, nodes: RelationNode[]): Promise<RelationHopResult | undefined> {
        const seq = this.seq;
        const t0 = Date.now();
        const node = nodes.find(n => n.id === nodeId && n.kind === 'symbol');
        if (!node || !this.root || Math.abs(node.hop) >= CALL_MAX_HOP) {
            return undefined;
        }
        const item = this.items.get(node.itemKey);
        if (!item) {
            return undefined;
        }
        if (this.hopBusy.has(nodeId)) {
            costLog('expandHop skipped inflight', Date.now() - t0, `${node.name} hop=${node.hop}`);
            return undefined;
        }
        this.hopBusy.add(nodeId);
        this.collapseLock.delete(nodeId);
        try {
            const dir: -1 | 1 | 0 = node.hop < 0 ? -1 : node.hop > 0 ? 1 : 0;
            await this.awaitPeekedSide(item, node.itemKey, dir, seq);
            if (!this.isCurrent(seq)) {
                costLog('expandHop cancelled', Date.now() - t0, `${node.name} hop=${node.hop}`);
                return undefined;
            }
            if (this.collapseLock.has(nodeId)) {
                costLog('expandHop collapsed', Date.now() - t0, `${node.name} hop=${node.hop}`);
                return undefined;
            }
            if (dir <= 0 && !this.sideFresh(item, -1)) {
                await this.ensureIncoming(item, seq);
            }
            if (dir >= 0 && !this.sideFresh(item, 1)) {
                await this.ensureOutgoing(item, seq);
            }
            if (!this.isCurrent(seq) || this.collapseLock.has(nodeId)) {
                costLog('expandHop cancelled', Date.now() - t0, `${node.name} hop=${node.hop}`);
                return undefined;
            }
            this.expanded.add(nodeId);
            const preview = this.buildGraph();
            this.prefetchActive = this.collectPrefetchJobs(preview.nodes).length > 0;
            const { nodes: kids, edges } = this.collectDirectSide(node, nodes);
            if (kids.length) {
                await this.fillVisibleSnippets(seq, { rootId: '', title: '', nodes: kids, edges });
            }
            if (!this.isCurrent(seq) || this.collapseLock.has(nodeId)) {
                costLog('expandHop cancelled', Date.now() - t0, `${node.name} hop=${node.hop}`);
                return undefined;
            }
            if (this.prefetchActive) {
                this.prefetchInBackground(seq);
            }
            costLog('expandHop', Date.now() - t0, `${node.name} hop=${node.hop} kids=${kids.length}`);
            return { seq, patch: { op: 'expand', parentId: nodeId, nodes: kids, edges } };
        } finally {
            this.hopBusy.delete(nodeId);
        }
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
     * First-level incoming only: callers of a function, or reference sites of
     * a variable / field / type. Does not walk callers-of-callers — that would
     * list e.g. `new Foo()` when the only caller is a method on Foo.
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
        const limit = 6;
        const startNodes = this.buildGraph().nodes.length;
        const stopAt = startNodes + CALL_EXPAND_ALL_NODES;
        for (let round = 0; round < CALL_MAX_HOP * 2; round++) {
            if (!this.isCurrent(seq)) {
                return undefined;
            }
            const graph = this.buildGraph();
            if (graph.nodes.length >= stopAt) {
                break;
            }
            const todo = graph.nodes.filter(n => {
                if (
                    n.kind !== 'symbol'
                    || !this.nodeCanGrow(n)
                    || n.expanded
                    || n.cyclic
                    || n.id === graph.rootId
                    || Math.abs(n.hop) >= CALL_MAX_HOP
                ) {
                    return false;
                }
                const item = this.items.get(n.itemKey);
                return !!item && !isLibPath(item.uri.fsPath);
            });
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
                const chunk = todo.slice(i, i + limit);
                await Promise.all(chunk.map(async n => {
                    const item = this.items.get(n.itemKey);
                    if (!item) {
                        return;
                    }
                    const dir: -1 | 1 = n.hop < 0 ? -1 : 1;
                    this.collapseLock.delete(n.id);
                    if (dir < 0) {
                        await this.ensureIncoming(item, seq);
                    } else {
                        await this.ensureOutgoing(item, seq);
                    }
                    this.expanded.add(n.id);
                }));
            }
            if (full) {
                break;
            }
        }
        const graph = await this.buildVisible(seq);
        return graph ? { graph, seq } : undefined;
    }

    async focusNode(nodeId: string, graph: RelationGraph): Promise<RelationLoad | undefined> {
        const nodes = graph.nodes;
        const fromReference = this.relationMode === 'reference';
        this.cancel();
        const seq = this.seq;
        const t0 = Date.now();
        const focus = nodes.find(n => n.id === nodeId && n.kind === 'symbol');
        if (!focus) {
            return { graph: this.attachCenterTrail(graph), seq };
        }
        const item = this.items.get(focus.itemKey);
        if (!item) {
            return { graph: this.attachCenterTrail(graph), seq };
        }
        const peekInHas = this.cacheKeysFor(item).some(k => this.incoming.has(k));
        const peekOutHas = this.cacheKeysFor(item).some(k => this.outgoing.has(k));
        const peekIn = this.sideCount(item, -1);
        const peekOut = this.sideCount(item, 1);
        peekLog(
            'focus before',
            `hop=${focus.hop} ${focus.hop < 0 ? 'left' : focus.hop > 0 ? 'right' : 'center'} item=${itemLabel(item)}`
            + ` peekIn=${peekInHas ? peekIn : 'miss'} peekOut=${peekOutHas ? peekOut : 'miss'}`
        );
        if (this.root && itemKey(this.root) === focus.itemKey && focus.hop === 0) {
            return { graph: this.attachCenterTrail(graph), seq };
        }
        this.stashCenter(graph);
        const cached = this.restoreCenter(focus.itemKey);
        if (cached && this.root) {
            this.recordCenter(this.root);
            this.syncPrevFromTrail();
            costLog('focusNode cache', Date.now() - t0, itemLabel(this.root));
            peekLog('focus cache', `hop=${focus.hop} ${itemLabel(this.root)} restored snapshot (no refetch)`);
            return { graph: this.attachCenterTrail(cached), seq };
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
        const sel = await this.nameTokenPosition(item.uri, item.range, item.selectionRange, item.name);
        const prepared = await this.execLsp<vscode.CallHierarchyItem[]>(
            seq,
            'vscode.prepareCallHierarchy',
            item.uri,
            sel
        );
        const resolved = this.bindPrepared(item, prepared);
        if (fromReference) {
            this.forgetEmptySides(item);
            this.forgetEmptySides(resolved);
        }
        this.adoptRoot(resolved);
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
        const built = await this.completeRootSides(seq, t0, itemLabel(resolved));
        costLog('focusNode', Date.now() - t0, itemLabel(resolved));
        const afterIn = this.sideCount(resolved, -1);
        const afterOut = this.sideCount(resolved, 1);
        peekLog(
            'focus after',
            `hop=${focus.hop} item=${itemLabel(item)} resolved=${itemLabel(resolved)}`
            + ` key=${itemKey(item) === itemKey(resolved) ? 'same' : 'DIFF'} afterIn=${afterIn} afterOut=${afterOut}`
            + ` peekIn=${peekInHas ? peekIn : 'miss'} peekOut=${peekOutHas ? peekOut : 'miss'}`
        );
        if (focus.hop > 0 && afterIn > 0 && !peekInHas) {
            peekLog(
                'MISMATCH',
                `${itemLabel(item)} was a right-side leaf (peek outgoing only); focus incoming n=${afterIn} was never peeked`
            );
        }
        if (focus.hop < 0 && afterIn > (peekInHas ? peekIn : 0)) {
            peekLog(
                'MISMATCH',
                `${itemLabel(item)} left-side peek incoming ${peekInHas ? peekIn : 'miss'} vs focus incoming ${afterIn}`
            );
        }
        return built ? { graph: built, seq } : undefined;
    }

    async focusTrail(index: number, graph: RelationGraph): Promise<RelationLoad | undefined> {
        const seq = this.seq;
        if (index < 0 || index >= this.centerTrail.length) {
            return { graph: this.attachCenterTrail(graph), seq };
        }
        const item = this.centerTrail[index];
        const key = itemKey(item);
        if (this.root && itemKey(this.root) === key) {
            this.centerIndex = index;
            this.syncPrevFromTrail();
            return { graph: this.attachCenterTrail(graph), seq };
        }
        this.stashCenter(graph);
        const cached = this.restoreCenter(key);
        if (cached) {
            this.centerIndex = index;
            this.syncPrevFromTrail();
            costLog('focusTrail cache', 0, itemLabel(item));
            return { graph: this.attachCenterTrail(cached), seq };
        }
        const node = graph.nodes.find(n => n.kind === 'symbol' && n.itemKey === key);
        if (node) {
            return this.focusNode(node.id, graph);
        }
        this.cancel();
        const nextSeq = this.seq;
        const t0 = Date.now();
        this.centerIndex = index;
        this.syncPrevFromTrail();
        this.relationMode = 'call';
        this.adoptRoot(item);
        this.shown.clear();
        this.expanded.clear();
        this.keepExpand.clear();
        this.keepGroups.clear();
        this.collapseLock.clear();
        this.keepExpand.add(`self\0${key}`);
        this.incomingHint = this.prevRoot;
        await this.ensureOutgoing(item, nextSeq);
        if (!this.isCurrent(nextSeq)) {
            return undefined;
        }
        const built = await this.completeRootSides(nextSeq, t0, itemLabel(item));
        return built ? { graph: built, seq: nextSeq } : undefined;
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
        const graph = await this.buildVisible(seq);
        return graph ? { graph, seq } : undefined;
    }

    private paintNow(seq: number): void {
        if (!this.isCurrent(seq) || !this.root) {
            return;
        }
        this.graphListener?.(this.buildGraph(), seq);
    }

    /** Show the cursor symbol before prepare / references return. */
    private async paintLocalCenter(
        uri: vscode.Uri,
        position: vscode.Position,
        seq: number
    ): Promise<void> {
        const item = await this.itemFromCursor(uri, position);
        if (!item || !this.isCurrent(seq)) {
            return;
        }
        const mode = isReferenceRelationKind(item.kind) && !isCallablePropertyKind(item.kind)
            ? 'reference'
            : 'call';
        this.paintCenterNow(item, seq, mode);
    }

    private paintCenterNow(
        item: vscode.CallHierarchyItem,
        seq: number,
        mode: 'call' | 'reference'
    ): void {
        if (!this.isCurrent(seq)) {
            return;
        }
        const key = itemKey(item);
        const same = !!(this.root && itemKey(this.root) === key && this.relationMode === mode);
        if (!same) {
            this.shown.clear();
            this.expanded.clear();
            this.keepExpand.clear();
            this.keepGroups.clear();
            this.collapseLock.clear();
            this.prevRoot = undefined;
            this.incomingHint = undefined;
            this.rootTypeName = '';
            this.relationMode = mode;
            this.adoptRoot(item);
            this.resetCenter(item);
            if (mode === 'reference' && !this.outgoing.has(key)) {
                this.outgoing.set(key, []);
            }
        }
        this.paintNow(seq);
    }

    private async itemFromCursor(
        uri: vscode.Uri,
        position: vscode.Position
    ): Promise<vscode.CallHierarchyItem | undefined> {
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const wr = doc.getWordRangeAtPosition(position);
            const name = wr ? identFromToken(doc.getText(wr)) : '';
            if (name && wr) {
                return new vscode.CallHierarchyItem(
                    vscode.SymbolKind.Method,
                    name,
                    '',
                    uri,
                    wr,
                    wr
                );
            }
        } catch {
            // Fall through to the enclosing callable.
        }
        const enc = await enclosingCallable(uri, position.line);
        if (!enc) {
            return undefined;
        }
        return new vscode.CallHierarchyItem(
            enc.kind,
            enc.name,
            enc.detail,
            uri,
            enc.range,
            enc.selectionRange
        );
    }

    private stubCenterItem(
        uri: vscode.Uri,
        position: vscode.Position,
        name: string
    ): vscode.CallHierarchyItem {
        const range = new vscode.Range(position, position);
        return new vscode.CallHierarchyItem(
            vscode.SymbolKind.Variable,
            name || 'symbol',
            '',
            uri,
            range,
            range
        );
    }

    private async completeRootSides(seq: number, t0: number, label: string): Promise<RelationGraph | undefined> {
        if (!this.root) {
            return undefined;
        }
        await this.refreshCenterFamily();
        if (!this.isCurrent(seq) || !this.root) {
            return undefined;
        }
        const rootKey = itemKey(this.root);
        if (!this.incoming.has(rootKey)) {
            const early = await this.buildVisible(seq);
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
        return this.buildVisible(seq);
    }

    private async buildVisible(seq: number): Promise<RelationGraph | undefined> {
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
        this.prefetchActive = this.collectPrefetchJobs(latest.nodes).length > 0;
        this.prefetchInBackground(seq);
        return this.prefetchActive ? this.buildGraph() : latest;
    }

    /**
     * Peek neighbor sides without blocking the graph. LSP runs in the language
     * server process; this only avoids awaiting it on the paint path.
     * A jump bumps `seq` so this sweep stops painting; in-flight LSP may still
     * write the side cache if `cacheEpoch` is unchanged.
     */
    private prefetchInBackground(seq: number): void {
        if (!this.isCurrent(seq)) {
            return;
        }
        if (this.prefetchBusy) {
            this.prefetchQueued = true;
            return;
        }
        this.prefetchBusy = true;
        this.prefetchQueued = false;
        void this.prefetchNextHop(seq, this.buildGraph().nodes).finally(() => {
            this.prefetchBusy = false;
            if (this.prefetchQueued) {
                this.prefetchQueued = false;
                this.prefetchInBackground(this.seq);
                return;
            }
            if (!this.isCurrent(seq)) {
                return;
            }
            this.prefetchActive = false;
            this.graphListener?.(this.buildGraph(), seq);
        });
    }

    private collectPrefetchJobs(nodes: RelationNode[]): { item: vscode.CallHierarchyItem; dir: -1 | 1; graphKey: string }[] {
        const pending: { item: vscode.CallHierarchyItem; dir: -1 | 1; graphKey: string }[] = [];
        const seen = new Set<string>();
        for (const node of nodes) {
            if (node.kind !== 'symbol' || node.hop === 0 || Math.abs(node.hop) >= CALL_MAX_HOP) {
                continue;
            }
            if (node.expanded || node.cyclic) {
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
            const cache = dir < 0 ? this.incoming : this.outgoing;
            if (cache.has(node.itemKey) || cache.has(itemKey(item))) {
                continue;
            }
            seen.add(mark);
            pending.push({ item, dir, graphKey: node.itemKey });
        }
        return pending;
    }

    private takePrefetchWave(
        remaining: { item: vscode.CallHierarchyItem; dir: -1 | 1; graphKey: string }[]
    ): {
        wave: { item: vscode.CallHierarchyItem; dir: -1 | 1; graphKey: string }[];
        rest: { item: vscode.CallHierarchyItem; dir: -1 | 1; graphKey: string }[];
    } {
        const wave: { item: vscode.CallHierarchyItem; dir: -1 | 1; graphKey: string }[] = [];
        const rest: { item: vscode.CallHierarchyItem; dir: -1 | 1; graphKey: string }[] = [];
        let incoming = 0;
        const outgoingFiles = new Set<string>();
        for (const job of remaining) {
            if (wave.length >= PREFETCH_BATCH) {
                rest.push(job);
                continue;
            }
            if (job.dir < 0) {
                if (incoming >= PREFETCH_IN_PARALLEL) {
                    rest.push(job);
                    continue;
                }
                incoming++;
                wave.push(job);
                continue;
            }
            const file = job.item.uri.toString();
            if (outgoingFiles.has(file)) {
                rest.push(job);
                continue;
            }
            outgoingFiles.add(file);
            wave.push(job);
        }
        return { wave, rest };
    }

    private async prefetchNextHop(seq: number, nodes: RelationNode[]): Promise<void> {
        const pending = this.collectPrefetchJobs(nodes);
        if (!pending.length) {
            return;
        }
        const t0 = Date.now();
        const inJobs = pending.filter(job => job.dir < 0).length;
        costLog(
            'prefetch start',
            0,
            `jobs=${pending.length} in=${inJobs} out=${pending.length - inJobs} inParallel=${PREFETCH_IN_PARALLEL}`
        );
        let remaining: { item: vscode.CallHierarchyItem; dir: -1 | 1; graphKey: string }[] = pending;
        let done = 0;
        let batch = 0;
        while (remaining.length) {
            if (!this.isCurrent(seq)) {
                costLog('prefetch cancelled', Date.now() - t0, `done=${done}/${pending.length}`);
                return;
            }
            const next = this.takePrefetchWave(remaining);
            remaining = next.rest;
            const chunk = next.wave;
            batch++;
            const tBatch = Date.now();
            await Promise.all(chunk.map(async job => {
                const tJob = Date.now();
                const side = job.dir < 0 ? 'incoming' : 'outgoing';
                const cache = job.dir < 0 ? this.incoming : this.outgoing;
                const hit = cache.has(job.graphKey) || cache.has(itemKey(job.item));
                await this.peekNeighborSide(job.item, job.dir, job.graphKey, seq);
                costLog(
                    `prefetch ${side}`,
                    Date.now() - tJob,
                    `${itemLabel(job.item)} ${hit ? 'cache' : 'fetch'} n=${this.sideCount(job.item, job.dir)}`
                );
            }));
            done += chunk.length;
            const inChunk = chunk.filter(job => job.dir < 0).length;
            costLog(
                'prefetch batch',
                Date.now() - tBatch,
                `${batch} size=${chunk.length} in=${inChunk} out=${chunk.length - inChunk}`
            );
            if (this.isCurrent(seq)) {
                this.graphListener?.(this.buildGraph(), seq);
            }
            const hot = chunk.some(job => (
                job.dir < 0 && (this.incoming.get(itemKey(job.item))?.length ?? 0) >= CALL_HOT_PREFETCH
            ));
            if (hot) {
                costLog('prefetch stop hot', Date.now() - t0, `done=${done}/${pending.length}`);
                return;
            }
        }
        costLog('prefetch total', Date.now() - t0, `jobs=${pending.length} in=${inJobs} out=${pending.length - inJobs}`);
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
                node.prefetching = false;
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

    /** One column of children for incremental +/−. Does not walk keepExpand. */
    private collectDirectSide(parent: RelationNode, existing: RelationNode[]): {
        nodes: RelationNode[];
        edges: RelationEdge[];
    } {
        const nodes = existing.slice();
        const edges: RelationEdge[] = [];
        const before = new Set(existing.map(n => n.id));
        if (parent.hop === 0) {
            this.addSide(nodes, edges, parent, -1, true);
            this.addSide(nodes, edges, parent, 1, true);
        } else {
            this.addSide(nodes, edges, parent, parent.hop < 0 ? -1 : 1, true);
        }
        return {
            nodes: nodes.filter(n => !before.has(n.id)),
            edges
        };
    }

    private addSide(
        nodes: RelationNode[],
        edges: RelationEdge[],
        parent: RelationNode,
        dir: -1 | 1,
        directOnly = false
    ): void {
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
        const frozen = dir < 0 ? this.incomingOrder.get(parent.itemKey) : undefined;
        if (frozen) {
            const rank = new Map(frozen.map((k, i) => [k, i]));
            unique.sort((a, b) => (rank.get(itemKey(a)) ?? frozen.length) - (rank.get(itemKey(b)) ?? frozen.length));
        } else {
            unique.sort((a, b) => this.compareChildren(parent.itemKey, dir, a, b));
        }
        const limit = this.shown.get(shownKey) ?? CALL_PAGE;
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
            const opened = !directOnly
                && !cyclic
                && !this.collapseLock.has(childNode.id)
                && (this.expanded.has(childNode.id)
                    || this.keepExpand.has(branchKeepKey(parent.itemKey, dir, childKey))
                    || this.keepExpand.has(`self\0${childKey}`));
            childNode.cyclic = cyclic;
            childNode.expanded = opened;
            childNode.hopCapped = Math.abs(hop) >= CALL_MAX_HOP;
            const sideCache = dir < 0 ? this.incoming : this.outgoing;
            const sideCached = this.cacheKeysFor(child).some(k => sideCache.has(k));
            childNode.expandable = !cyclic && !childNode.hopCapped && this.canExpand(child, dir);
            childNode.prefetching = !opened
                && !cyclic
                && !childNode.hopCapped
                && this.prefetchActive
                && !sideCached
                && !isLibPath(child.uri.fsPath);
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
        if (!directOnly) {
            for (const childNode of pendingExpand) {
                this.addSide(nodes, edges, childNode, dir);
            }
        }
        const scanOpen = dir < 0 && this.incomingOpen.has(parent.itemKey);
        if (hidden > 0 || scanOpen) {
            const moreId = `${parent.id}:more:${dir}`;
            nodes.push({
                id: moreId,
                itemKey: '',
                name: scanOpen ? '+? more' : `+${hidden} more`,
                detail: scanOpen ? 'Continue loading callers' : 'Show more at this level',
                file: '',
                path: '',
                line: 0,
                hop,
                parentId: parent.id,
                kind: 'more',
                moreCount: scanOpen ? undefined : hidden,
                moreUnknown: scanOpen || undefined,
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

    /** + waits for an in-flight peek, then fetches when that side is missing or stale. */
    private async awaitPeekedSide(
        item: vscode.CallHierarchyItem,
        graphKey: string,
        dir: -1 | 1 | 0,
        seq: number
    ): Promise<void> {
        const wait = async (cache: Map<string, vscode.CallHierarchyItem[]>, inflight: Map<string, Promise<void>>) => {
            if (cache.has(graphKey) || cache.has(itemKey(item))) {
                return;
            }
            const pending = inflight.get(graphKey) || inflight.get(itemKey(item));
            if (!pending) {
                return;
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
        };
        if (dir <= 0) {
            await wait(this.incoming, this.inflightIn);
        }
        if (dir >= 0) {
            await wait(this.outgoing, this.inflightOut);
        }
    }

    private async ensureIncoming(item: vscode.CallHierarchyItem, seq: number): Promise<void> {
        await this.ensureCached(
            this.incoming,
            this.inflightIn,
            this.inflightInGen,
            item,
            seq,
            (key, fetchSeq) => this.fetchIncoming(item, key, fetchSeq),
            key => this.incomingAt.get(key) === this.workspaceGen
        );
        if (!this.isCurrent(seq)) {
            return;
        }
        let raw: vscode.CallHierarchyItem[] | undefined;
        for (const cacheKey of this.cacheKeysFor(item)) {
            const list = this.incoming.get(cacheKey);
            if (list && (!raw || list.length > raw.length)) {
                raw = list;
            }
        }
        if (!raw) {
            return;
        }
        const group = [item, ...raw];
        if (group.every(it => this.ownerKeyByItem.has(itemKey(it)))) {
            return;
        }
        await this.rememberOwner(item);
        await this.rememberOwners(raw);
        if (!this.isCurrent(seq)) {
            return;
        }
        if (this.cacheKeysFor(item).some(key => this.incomingOpen.has(key))) {
            return;
        }
        await this.storeSide(-1, this.cacheKeysFor(item), item, raw, [], this.workspaceGen, true);
    }

    private async ensureOutgoing(item: vscode.CallHierarchyItem, seq: number): Promise<void> {
        return this.ensureCached(
            this.outgoing,
            this.inflightOut,
            this.inflightOutGen,
            item,
            seq,
            (key, fetchSeq) => this.fetchOutgoing(item, key, fetchSeq),
            key => this.outgoingAt.get(key) === this.workspaceGen
        );
    }

    private async ensureCached(
        cache: Map<string, vscode.CallHierarchyItem[]>,
        inflight: Map<string, Promise<void>>,
        inflightGen: Map<string, number>,
        item: vscode.CallHierarchyItem,
        seq: number,
        fetch: (key: string, fetchSeq: number) => Promise<void>,
        fresh: (key: string) => boolean,
        attempt = 0
    ): Promise<void> {
        if (!this.isCurrent(seq)) {
            return;
        }
        const key = this.remember(item);
        if (cache.has(key) && fresh(key)) {
            return;
        }
        const gen = this.workspaceGen;
        let pending = inflight.get(key);
        if (!pending || inflightGen.get(key) !== gen) {
            pending = fetch(key, seq).finally(() => {
                if (inflight.get(key) === pending) {
                    inflight.delete(key);
                    inflightGen.delete(key);
                }
            });
            inflight.set(key, pending);
            inflightGen.set(key, gen);
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
        if (!this.isCurrent(seq) || (cache.has(key) && fresh(key))) {
            return;
        }
        if (!cache.has(key) && attempt < 1 && this.workspaceGen === gen) {
            return this.ensureCached(cache, inflight, inflightGen, item, seq, fetch, fresh, attempt + 1);
        }
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
        selfKey: string,
        lines?: string[]
    ): Promise<vscode.Range[]> {
        const split = splitSuperCallRanges(lines ?? await this.fileLines(siteUri), ranges, ident);
        if (split.superHit) {
            const superTo = await this.resolveSuperCallee(siteUri, split.superHit, self);
            if (superTo) {
                this.addSuperOutgoing(selfKey, superTo, siteUri, split.superRanges);
                return split.otherRanges;
            }
        }
        return ranges || [];
    }

    private async referencesForSlot(slot: { uri: vscode.Uri; method: FlatSymbol }): Promise<vscode.Location[]> {
        const sel = slot.method.selectionRange?.start ?? slot.method.range.start;
        const id = `refs\0${slot.uri.toString()}\0${sel.line}\0${sel.character}\0${slot.method.name}`;
        const index = relationIndex();
        const hit = await index.take<SerLoc[]>(id);
        if (hit) {
            costLog('refs index', 0, `${slot.method.name} n=${hit.length}`);
            return hit.map(locFromSer);
        }
        const wave = index.waveNow();
        const refs = await this.execLspHeld<unknown[]>(
            'vscode.executeReferenceProvider',
            slot.uri,
            sel
        );
        const locs: vscode.Location[] = [];
        const ser: SerLoc[] = [];
        const deps = new Set<string>([slot.uri.toString()]);
        if (refs) {
            for (const raw of refs) {
                const loc = this.asLocation(raw);
                if (!loc) {
                    continue;
                }
                locs.push(loc);
                ser.push(serLoc(loc));
                deps.add(loc.uri.toString());
            }
            await index.put(id, ser, [...deps], wave);
        }
        return locs;
    }

    /**
     * Override incoming is empty for virtual dispatch. Search same-named slots
     * on this type's ancestor chain. A `this`/`self` call stays when its class
     * is on that chain (nearest depth) or is a subtype of the center. `super`
     * stays when the enclosing class is on that chain or is a subtype of the center.
     * `recv.ident()` stays when the receiver's static type is on the chain
     * (including an interface the chain implements) or is a subtype of the
     * center. A resolved type on another chain is dropped. An unresolved type
     * stays. Sibling `this` calls are dropped.
     * Center scans stop once the first page is full or INCOMING_BUDGET_MS elapses.
     */
    private async mergeOverrideIncoming(
        item: vscode.CallHierarchyItem,
        key: string,
        resolvedKey: string,
        items: vscode.CallHierarchyItem[],
        seen: Set<string>,
        ident: string,
        budget: IncomingBudget | undefined,
        epoch: number,
        gen: number,
        rev: number,
        touch?: Set<string>,
        wave?: number
    ): Promise<boolean> {
        if (!ident || /^constructor$/i.test(ident) || item.kind === vscode.SymbolKind.Constructor) {
            return false;
        }
        const t0 = Date.now();
        if (await this.methodDeclHasStaticKeyword(item)) {
            costLog('incoming merge skip', Date.now() - t0, `${itemLabel(item)} static`);
            return false;
        }
        if (await this.nameTokenIsStatic(item)) {
            costLog('incoming merge skip', Date.now() - t0, `${itemLabel(item)} static semantic`);
            return false;
        }
        const family = await this.selfAndAncestorTypes(item);
        if (touch) {
            touch.add(item.uri.toString());
            for (const type of family) {
                touch.add(type.uri.toString());
            }
        }
        const ancestors = family.filter(type => type.depth > 0);
        if (!ancestors.length) {
            costLog('incoming merge skip', Date.now() - t0, `${itemLabel(item)} no ancestors`);
            return false;
        }
        costLog('incoming merge family', Date.now() - t0, `${itemLabel(item)} types=${family.length} ancestors=${ancestors.length}`);
        const tSlots = Date.now();
        const slots = (await this.collectVirtualSlots(ancestors, ident))
            .filter(slot => !isLibPath(slot.uri.fsPath));
        if (!slots.length) {
            costLog('incoming merge skip', Date.now() - t0, `${itemLabel(item)} no slots`);
            return false;
        }
        costLog('incoming merge slots', Date.now() - tSlots, `${itemLabel(item)} n=${slots.length}`);
        if (touch) {
            for (const slot of slots) {
                touch.add(slot.uri.toString());
            }
        }
        const locations = await this.familyCallLocations(item, slots, touch);
        if (!this.sideGenerationLive(epoch, gen, rev, item.uri)) {
            return false;
        }
        if (!locations.length) {
            costLog('incoming merge skip', Date.now() - t0, `${itemLabel(item)} no refs`);
            return false;
        }
        const familyKeys = new Map(family.map(a => [typeRefKey(a.uri, a.symbol), a.depth]));
        const heritageShare = new Map<string, 'subtype' | 'sibling' | 'unrelated'>();
        const groups = new Map<string, MergeGroup>();
        const lineCache = new Map<string, Promise<string[] | undefined>>();
        const tClassify = Date.now();
        const scan = this.mergeScan(
            item, key, resolvedKey, ident, items, seen, gen, epoch, rev, lineCache,
            locations, 0, groups, slots, familyKeys, heritageShare
        );
        scan.wave = wave ?? relationIndex().waveNow();
        const paused = await this.continueMergeWindow(scan, budget, tClassify, t0);
        return paused;
    }

    private async continueMergeWindow(
        scan: CenterIncomingScan,
        budget: IncomingBudget | undefined,
        tClassify: number,
        t0: number
    ): Promise<boolean> {
        const fileBatch = 32;
        const item = scan.subject;
        const key = scan.key;
        const locations = scan.locations;
        const groups = scan.groups;
        const items = scan.items;
        const seen = scan.seen;
        const stamp = this.mergeFamilyStamp(scan);
        const stats: MergeStats = {
            files: 0,
            cached: 0,
            lineHits: 0,
            thisHits: 0,
            extFast: 0,
            extDrop: 0,
            readMs: 0,
            superLocal: 0
        };
        const statLine = () => `files=${stats.files} cached=${stats.cached} lineHits=${stats.lineHits} this=${stats.thisHits}`
            + ` extFast=${stats.extFast} extDrop=${stats.extDrop} superLocal=${stats.superLocal} readMs=${stats.readMs}`;
        let lastProgress = Date.now();
        for (let i = scan.locIndex; i < locations.length;) {
            if (Date.now() - lastProgress >= 5_000) {
                lastProgress = Date.now();
                costLog(
                    'incoming merge progress',
                    Date.now() - tClassify,
                    `${itemLabel(item)} at=${i}/${locations.length} groups=${groups.size} ${statLine()}`
                );
            }
            if (!budget && !this.sideGenerationLive(scan.epoch, scan.gen, scan.rev, item.uri)) {
                return false;
            }
            if (budget && !this.isCurrent(budget.seq)) {
                if (this.sideGenerationLive(scan.epoch, scan.gen, scan.rev, item.uri) && (items.length > 0 || groups.size > 0)) {
                    this.flushMergeGroups(groups, seen, items, key, item);
                    if (items.length > 0) {
                        scan.locIndex = i;
                        scan.phase = 'merge';
                        await this.publishPartialIncoming(scan);
                    }
                }
                return true;
            }
            const batch: { uri: vscode.Uri; locs: vscode.Location[] }[] = [];
            let next = i;
            while (next < locations.length && batch.length < fileBatch) {
                const uk = locations[next].uri.toString();
                const locs: vscode.Location[] = [];
                while (next < locations.length && locations[next].uri.toString() === uk) {
                    locs.push(locations[next]);
                    next++;
                }
                batch.push({ uri: locs[0].uri, locs });
            }
            const perFile = await Promise.all(batch.map(file => this.classifyMergeFile(scan, stamp, file.uri, file.locs, stats)));
            const hits = perFile.flat();
            for (const hit of hits) {
                const fromKey = itemKey(hit.caller);
                if (fromKey === key) {
                    continue;
                }
                const group = groups.get(fromKey);
                if (group) {
                    group.sites.push(hit.range);
                    if (!hit.external) {
                        group.external = false;
                        if (hit.depth < group.depth) {
                            group.depth = hit.depth;
                        }
                    }
                    continue;
                }
                groups.set(fromKey, {
                    item: hit.caller,
                    sites: [hit.range],
                    depth: hit.depth,
                    external: hit.external
                });
            }
            i = next;
            const more = next < locations.length;
            const have = items.length + this.acceptableMergeAdds(groups, seen);
            const stop = !!budget && (!this.isCurrent(budget.seq) || this.incomingShouldPause(have, budget, more));
            if (stop) {
                if ((have > 0 || items.length > 0) && this.sideGenerationLive(scan.epoch, scan.gen, scan.rev, item.uri)) {
                    this.flushMergeGroups(groups, seen, items, key, item);
                    scan.locIndex = Math.min(locations.length, next);
                    scan.phase = 'merge';
                    await this.publishPartialIncoming(scan);
                }
                return true;
            }
        }
        if (!this.sideGenerationLive(scan.epoch, scan.gen, scan.rev, item.uri)) {
            costLog(
                'incoming merge classify',
                Date.now() - tClassify,
                `${itemLabel(item)} groups=${groups.size} dropped locs=${locations.length} ${statLine()}`
            );
            return false;
        }
        this.flushMergeGroups(groups, seen, items, key, item);
        costLog(
            'incoming merge classify',
            Date.now() - tClassify,
            `${itemLabel(item)} groups=${groups.size} locs=${locations.length} ${statLine()}`
        );
        costLog('incoming merge total', Date.now() - t0, `${itemLabel(item)} added=${items.length} groups=${groups.size}`);
        return false;
    }

    /** Same verdicts need the same slots, family, and location source. */
    private mergeFamilyStamp(scan: CenterIncomingScan): string {
        const slots = scan.slots
            .map(slot => {
                const sel = slot.method.selectionRange?.start ?? slot.method.range.start;
                return `${slot.uri.toString()}\0${sel.line}\0${sel.character}`;
            })
            .sort();
        const raw = [scan.ident, ...slots, familyStamp(scan.familyKeys)].join('\n');
        return createHash('sha1').update(raw).digest('hex').slice(0, 20);
    }

    /**
     * Verdicts are stored per file. A file edit re-judges that file only; other
     * files keep their stored callers. Filters that depend on the current
     * subject or its call-hierarchy callers run outside the stored verdicts.
     */
    private async classifyMergeFile(
        scan: CenterIncomingScan,
        stamp: string,
        uri: vscode.Uri,
        locs: vscode.Location[],
        stats: MergeStats
    ): Promise<MergeHit[]> {
        const item = scan.subject;
        const slotItems = scan.slots.map(slot => new vscode.CallHierarchyItem(
            slot.method.kind,
            slot.method.name,
            '',
            slot.uri,
            slot.method.range,
            slot.method.selectionRange
        ));
        const uk = uri.toString();
        const todo = locs.filter(loc => (
            !isLibPath(loc.uri.fsPath)
            && !this.isDeclSite(item, loc)
            && !slotItems.some(slot => this.isDeclSite(slot, loc))
            && !scan.items.some(existing => (
                existing.uri.toString() === uk
                && rangeContains(existing.range, loc.range.start)
            ))
        ));
        if (!todo.length) {
            return [];
        }
        stats.files++;
        const locKey = (loc: vscode.Location) => `${loc.range.start.line}:${loc.range.start.character}`;
        const index = relationIndex();
        const id = `mfile\0${stamp}\0${uk}`;
        const stored = await index.take<MergeFileBody>(id);
        const table: Record<string, SerMergeHit | 0> = stored?.hits ? { ...stored.hits } : {};
        const missing = todo.filter(loc => !(locKey(loc) in table));
        if (!missing.length) {
            stats.cached++;
        } else {
            const deps = new Set<string>([uk, ...(stored?.uris ?? [])]);
            const wave = index.waveNow();
            const identCall = new RegExp(`\\b${escapeRegExp(scan.ident)}\\s*\\(`);
            const judged = await indexDeps.run(deps, async () => {
                const tRead = Date.now();
                const lines = await this.fileLines(uri);
                stats.readMs += Date.now() - tRead;
                if (!lines?.length) {
                    return false;
                }
                let parsed: TS.SourceFile | undefined | null = null;
                const local = (): TS.SourceFile | undefined => {
                    if (parsed === null) {
                        try {
                            parsed = parseLocalSource(uri.fsPath, lines);
                        } catch {
                            parsed = undefined;
                        }
                    }
                    return parsed;
                };
                for (const loc of missing) {
                    const hit = await this.classifyMergeLoc(scan, loc, lines, identCall, stats, local);
                    table[locKey(loc)] = hit
                        ? { c: serItem(hit.caller), r: serRange(hit.range), d: hit.depth, x: hit.external }
                        : 0;
                }
                return true;
            });
            if (!judged) {
                return [];
            }
            const uris = [...deps];
            await index.put(id, { hits: table, uris } satisfies MergeFileBody, uris, wave);
        }
        const out: MergeHit[] = [];
        for (const loc of todo) {
            const raw = table[locKey(loc)];
            if (!raw) {
                continue;
            }
            out.push({ caller: this.itemFromSer(raw.c), range: deRange(raw.r), depth: raw.d, external: raw.x });
        }
        return out;
    }

    private async classifyMergeLoc(
        scan: CenterIncomingScan,
        loc: vscode.Location,
        lines: string[],
        identCall: RegExp,
        stats: MergeStats,
        local: () => TS.SourceFile | undefined
    ): Promise<MergeHit | undefined> {
        const ident = scan.ident;
        const familyKeys = scan.familyKeys;
        const lineText = lines[Math.min(loc.range.start.line, lines.length - 1)] || '';
        if (!identCall.test(lineText)) {
            return undefined;
        }
        const use = incomingUseAt(lineText, ident, loc.range.start.character);
        if (use === 'drop') {
            return undefined;
        }
        const superCall = use === 'super' || isPrototypeSuperCall(lineText, ident, loc.range.start.character);
        if (superCall) {
            // Each override's `super.ident()` would otherwise cost one serialized document-symbol request.
            const sf = local();
            if (sf && onlySameNamedEnclosing(sf, loc.range.start.line, ident)) {
                stats.superLocal++;
                return undefined;
            }
            const enc = await enclosingCallable(loc.uri, loc.range.start.line, ident);
            if (!enc) {
                return undefined;
            }
            const owner = await this.containingTypeAt(enc.uri ?? loc.uri, enc.selectionRange.start);
            if (!owner) {
                stats.extDrop++;
                return undefined;
            }
            const reach = await this.typeReachesFamily(owner, familyKeys, scan.typeReach);
            if (reach !== 'yes') {
                stats.extDrop++;
                return undefined;
            }
            stats.lineHits++;
            const caller = await this.prepareFromEnclosing(enc, loc.uri);
            if (!caller || identFromToken(caller.name) === ident) {
                return undefined;
            }
            return { caller, range: loc.range, depth: 0, external: true };
        }
        if (use === 'external') {
            const reach = await this.receiverReachesFamily(
                scan,
                loc.uri,
                loc.range.start.line,
                lineText,
                loc.range.start.character,
                familyKeys
            );
            if (reach === 'no') {
                stats.extDrop++;
                return undefined;
            }
        }
        stats.lineHits++;
        const enc = await enclosingCallable(loc.uri, loc.range.start.line, ident);
        if (!enc) {
            return undefined;
        }
        const thisDispatch = use === 'this';
        const kind = thisDispatch
            ? await this.classifyOverrideCaller(enc, loc.uri, familyKeys, scan.heritageShare)
            : { kind: 'external' as const, depth: 0 };
        if (thisDispatch) {
            stats.thisHits++;
        } else {
            stats.extFast++;
        }
        if (kind === 'sibling' || kind === 'unrelated') {
            stats.extDrop++;
            return undefined;
        }
        const caller = await this.prepareFromEnclosing(enc, loc.uri);
        if (!caller || identFromToken(caller.name) === ident) {
            return undefined;
        }
        return {
            caller,
            range: loc.range,
            depth: kind.depth,
            external: kind.kind === 'external' || kind.kind === 'subtype'
        };
    }

    /** References of each slot, deduplicated and grouped by file so verdicts can be stored per file. */
    private async familyCallLocations(
        item: vscode.CallHierarchyItem,
        slots: { uri: vscode.Uri; method: FlatSymbol }[],
        touch?: Set<string>
    ): Promise<vscode.Location[]> {
        const t0 = Date.now();
        const locSeen = new Set<string>();
        const locations: vscode.Location[] = [];
        for (const slot of slots) {
            for (const loc of await this.referencesForSlot(slot)) {
                touch?.add(loc.uri.toString());
                const mark = `${loc.uri.toString()}\0${loc.range.start.line}\0${loc.range.start.character}`;
                if (locSeen.has(mark)) {
                    continue;
                }
                locSeen.add(mark);
                locations.push(loc);
            }
        }
        sortLocations(locations);
        costLog('incoming merge refs', Date.now() - t0, `${itemLabel(item)} locs=${locations.length} slots=${slots.length}`);
        return locations;
    }

    private sideGenerationLive(epoch: number, gen: number, rev: number, uri?: vscode.Uri): boolean {
        if (this.cacheEpoch !== epoch || this.workspaceGen !== gen) {
            return false;
        }
        return !uri || this.fileRev(uri) === rev;
    }

    private incomingShouldPause(have: number, budget: IncomingBudget, more: boolean): boolean {
        if (!more) {
            return false;
        }
        if (have >= budget.goal) {
            return true;
        }
        return Date.now() >= budget.deadline && have > budget.baseline;
    }

    private isCenterItem(item: vscode.CallHierarchyItem): boolean {
        return !!this.root && itemKey(this.root) === itemKey(item);
    }

    private acceptableMergeAdds(groups: Map<string, MergeGroup>, seen: Set<string>): number {
        let nearest = Number.POSITIVE_INFINITY;
        for (const group of groups.values()) {
            if (!group.external && group.depth < nearest) {
                nearest = group.depth;
            }
        }
        let count = 0;
        for (const group of groups.values()) {
            if (!group.external && group.depth !== nearest) {
                continue;
            }
            if (seen.has(itemKey(group.item))) {
                continue;
            }
            count++;
        }
        return count;
    }

    private flushMergeGroups(
        groups: Map<string, MergeGroup>,
        seen: Set<string>,
        items: vscode.CallHierarchyItem[],
        key: string,
        tokenItem: vscode.CallHierarchyItem
    ): void {
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
            const kept = this.remember(group.item);
            items.push(this.items.get(kept)!);
            this.rememberCallSite(key, -1, group.item, group.item.uri, group.sites, tokenItem.name);
        }
    }

    private freezeIncomingOrder(parentKey: string, items: vscode.CallHierarchyItem[]): vscode.CallHierarchyItem[] {
        const prev = this.incomingOrder.get(parentKey);
        let ordered: vscode.CallHierarchyItem[];
        if (!prev) {
            ordered = items.slice().sort((a, b) => this.compareChildren(parentKey, -1, a, b));
        } else {
            const rank = new Map(prev.map((k, i) => [k, i]));
            const known: vscode.CallHierarchyItem[] = [];
            const fresh: vscode.CallHierarchyItem[] = [];
            for (const item of items) {
                if (rank.has(itemKey(item))) {
                    known.push(item);
                } else {
                    fresh.push(item);
                }
            }
            known.sort((a, b) => (rank.get(itemKey(a)) ?? 0) - (rank.get(itemKey(b)) ?? 0));
            ordered = known.concat(fresh);
        }
        const order = ordered.map(item => itemKey(item));
        this.incomingOrder.set(parentKey, order);
        return ordered;
    }

    private mergeScan(
        item: vscode.CallHierarchyItem,
        key: string,
        resolvedKey: string,
        ident: string,
        items: vscode.CallHierarchyItem[],
        seen: Set<string>,
        gen: number,
        epoch: number,
        rev: number,
        lineCache: Map<string, Promise<string[] | undefined>>,
        locations: vscode.Location[],
        locIndex: number,
        groups: Map<string, MergeGroup>,
        slots: { uri: vscode.Uri; method: FlatSymbol }[],
        familyKeys: Map<string, number>,
        heritageShare: Map<string, 'subtype' | 'sibling' | 'unrelated'>
    ): CenterIncomingScan {
        return {
            key,
            resolvedKey,
            gen,
            epoch,
            rev,
            wave: 0,
            ident,
            subject: item,
            items,
            seen,
            lineCache,
            phase: 'merge',
            callIndex: 0,
            locations,
            locIndex,
            groups,
            refGroups: new Map(),
            slots,
            familyKeys,
            heritageShare,
            receiverReach: new Map(),
            typeReach: new Map(),
            rootName: ''
        };
    }

    private async publishPartialIncoming(scan: CenterIncomingScan): Promise<void> {
        const ordered = this.freezeIncomingOrder(scan.key, scan.items);
        scan.items = ordered;
        await this.rememberOwner(scan.subject);
        await this.rememberOwners(ordered);
        if (!this.sideGenerationLive(scan.epoch, scan.gen, scan.rev, scan.subject.uri)) {
            return;
        }
        const keys = scan.resolvedKey && scan.resolvedKey !== scan.key
            ? [scan.key, scan.resolvedKey]
            : [scan.key];
        this.commitSides(this.incoming, this.incomingAt, keys, ordered, scan.gen);
        this.aliasCallSites(scan.key, scan.resolvedKey);
        const order = ordered.map(item => itemKey(item));
        for (const key of keys) {
            this.incomingOpen.add(key);
            this.incomingScan.set(key, scan);
            this.incomingOrder.set(key, order);
        }
        costLog('incoming partial', 0, `${itemLabel(scan.subject)} n=${ordered.length} phase=${scan.phase}`);
        await this.storePartialIncoming(scan, keys, ordered);
    }

    private closeIncomingScan(keys: string[]): void {
        for (const key of keys) {
            this.incomingOpen.delete(key);
            this.incomingScan.delete(key);
        }
    }

    private blankIncomingScan(
        subject: vscode.CallHierarchyItem,
        key: string,
        resolvedKey: string,
        ident: string,
        gen: number,
        epoch: number,
        rev: number,
        wave = relationIndex().waveNow()
    ): CenterIncomingScan {
        return {
            key,
            resolvedKey,
            gen,
            epoch,
            rev,
            wave,
            ident,
            subject,
            items: [],
            seen: new Set<string>(),
            lineCache: new Map(),
            phase: 'calls',
            callIndex: 0,
            locations: [],
            locIndex: 0,
            groups: new Map(),
            refGroups: new Map(),
            slots: [],
            familyKeys: new Map(),
            heritageShare: new Map(),
            receiverReach: new Map(),
            typeReach: new Map(),
            rootName: ''
        };
    }

    private finishCompleteIncoming(keys: string[]): void {
        this.closeIncomingScan(keys);
        for (const key of keys) {
            this.incomingOrder.delete(key);
        }
    }

    private async commitFinishedScan(scan: CenterIncomingScan): Promise<void> {
        if (!this.sideGenerationLive(scan.epoch, scan.gen, scan.rev, scan.subject.uri)) {
            return;
        }
        const wave = relationIndex().waveNow();
        const ordered = this.incomingOrder.has(scan.key)
            ? this.freezeIncomingOrder(scan.key, scan.items)
            : scan.items;
        await this.rememberOwner(scan.subject);
        await this.rememberOwners(ordered);
        const keys = scan.resolvedKey && scan.resolvedKey !== scan.key
            ? [scan.key, scan.resolvedKey]
            : [scan.key];
        this.commitSides(this.incoming, this.incomingAt, keys, ordered, scan.gen);
        this.aliasCallSites(scan.key, scan.resolvedKey);
        this.closeIncomingScan(keys);
        if (!this.sideGenerationLive(scan.epoch, scan.gen, scan.rev, scan.subject.uri)) {
            return;
        }
        await this.storeSide(-1, keys, scan.subject, ordered, this.scanDepUris(scan), wave);
    }

    private async pumpIncomingCalls(scan: CenterIncomingScan, budget: IncomingBudget | undefined): Promise<boolean> {
        const calls = scan.calls || [];
        const key = scan.key;
        const resolvedKey = scan.resolvedKey;
        const subject = scan.subject;
        const ident = scan.ident;
        const linesOf = (uri: vscode.Uri) => {
            const uk = uri.toString();
            let pending = scan.lineCache.get(uk);
            if (!pending) {
                pending = this.fileLines(uri);
                scan.lineCache.set(uk, pending);
            }
            return pending;
        };
        for (let callIndex = scan.callIndex; callIndex < calls.length; callIndex++) {
            if (!budget && !this.sideGenerationLive(scan.epoch, scan.gen, scan.rev, subject.uri)) {
                return false;
            }
            if (budget && !this.isCurrent(budget.seq)) {
                if (scan.items.length > 0 && this.sideGenerationLive(scan.epoch, scan.gen, scan.rev, subject.uri)) {
                    scan.callIndex = callIndex;
                    scan.phase = callIndex < calls.length ? 'calls' : 'merge-setup';
                    await this.publishPartialIncoming(scan);
                }
                return true;
            }
            const call = calls[callIndex];
            if (call?.from) {
                let from = call.from;
                let sites = call.fromRanges;
                const lines = await linesOf(from.uri);
                if (itemKey(from) === key || itemKey(from) === resolvedKey) {
                    sites = await this.rewriteSelfSuper(from.uri, call.fromRanges, ident, subject, resolvedKey, lines);
                }
                sites = keepNonParentIncomingRanges(lines, sites, ident);
                if (sites.length) {
                    const lifted = await this.liftArrowToEnclosing(from, sites);
                    if (lifted) {
                        from = lifted;
                    }
                    const kept = this.remember(from);
                    if (!scan.seen.has(kept)) {
                        scan.seen.add(kept);
                        scan.items.push(this.items.get(kept)!);
                        this.rememberCallSite(key, -1, from, from.uri, sites, subject.name);
                    }
                }
            }
            if (budget && (!this.isCurrent(budget.seq) || this.incomingShouldPause(scan.items.length, budget, true))) {
                if (scan.items.length > 0 && this.sideGenerationLive(scan.epoch, scan.gen, scan.rev, subject.uri)) {
                    scan.callIndex = callIndex + 1;
                    scan.phase = callIndex + 1 < calls.length ? 'calls' : 'merge-setup';
                    await this.publishPartialIncoming(scan);
                }
                return true;
            }
        }
        scan.callIndex = calls.length;
        scan.phase = 'merge-setup';
        return false;
    }

    private async pumpMergeScan(scan: CenterIncomingScan, budget: IncomingBudget): Promise<void> {
        if (scan.phase === 'merge-setup') {
            const paused = await this.mergeOverrideIncoming(
                scan.subject,
                scan.key,
                scan.resolvedKey,
                scan.items,
                scan.seen,
                scan.ident,
                budget,
                scan.epoch,
                scan.gen,
                scan.rev,
                undefined,
                scan.wave
            );
            if (!paused) {
                await this.commitFinishedScan(scan);
            }
            return;
        }
        const paused = await this.continueMergeWindow(scan, budget, Date.now(), Date.now());
        if (!paused) {
            await this.commitFinishedScan(scan);
        }
    }

    private materializeRefGroups(scan: CenterIncomingScan): void {
        for (const group of scan.refGroups.values()) {
            const groupKey = itemKey(group.item);
            this.rememberCallSite(scan.key, -1, group.item, group.item.uri, group.sites, scan.subject.name);
            if (scan.seen.has(groupKey)) {
                continue;
            }
            scan.seen.add(groupKey);
            const kept = this.remember(group.item);
            scan.items.push(this.items.get(kept)!);
        }
    }

    private async consumeReferenceLocations(
        scan: CenterIncomingScan,
        budget: IncomingBudget | undefined
    ): Promise<boolean> {
        const chunk = 12;
        const locations = scan.locations;
        const groups = scan.refGroups;
        const root = scan.subject;
        for (let i = scan.locIndex; i < locations.length; i += chunk) {
            if (!this.sideGenerationLive(scan.epoch, scan.gen, scan.rev, root.uri)) {
                return false;
            }
            if (budget && !this.isCurrent(budget.seq)) {
                this.materializeRefGroups(scan);
                if (scan.items.length > 0) {
                    scan.locIndex = i;
                    scan.phase = 'refs';
                    await this.publishPartialIncoming(scan);
                }
                return true;
            }
            const found: { item: vscode.CallHierarchyItem; range: vscode.Range }[] = [];
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
                found.push({ item: caller, range: loc.range });
            }));
            for (const row of found) {
                const rowKey = itemKey(row.item);
                const group = groups.get(rowKey);
                if (group) {
                    group.sites.push(row.range);
                    continue;
                }
                groups.set(rowKey, { item: row.item, sites: [row.range] });
            }
            this.materializeRefGroups(scan);
            const next = i + chunk;
            const more = next < locations.length;
            const stop = !!budget && (!this.isCurrent(budget.seq) || this.incomingShouldPause(scan.items.length, budget, more));
            if (stop) {
                if (scan.items.length > 0 && this.sideGenerationLive(scan.epoch, scan.gen, scan.rev, root.uri)) {
                    scan.locIndex = Math.min(locations.length, next);
                    scan.phase = 'refs';
                    await this.publishPartialIncoming(scan);
                }
                return true;
            }
        }
        this.materializeRefGroups(scan);
        return false;
    }

    private async pumpRefScan(scan: CenterIncomingScan, budget: IncomingBudget): Promise<void> {
        const paused = await this.consumeReferenceLocations(scan, budget);
        if (!paused) {
            await this.commitFinishedScan(scan);
        }
    }

    private async rehydrateIncomingScan(item: vscode.CallHierarchyItem): Promise<CenterIncomingScan | undefined> {
        const keys = this.cacheKeysFor(item);
        let meta = keys.map(key => this.partialMeta.get(key)).find((row): row is NonNullable<typeof row> => !!row);
        if (!meta) {
            for (const key of keys) {
                const hit = await relationIndex().take<SerPartial>(`part\0-1\0${key}`);
                if (!hit?.side) {
                    continue;
                }
                meta = { phase: hit.phase, locIndex: hit.locIndex, callIndex: hit.callIndex };
                break;
            }
        }
        if (!meta || meta.phase === 'refs') {
            return undefined;
        }
        const subject = await this.resolveForHierarchy(item);
        if (!subject) {
            return undefined;
        }
        const key = itemKey(item);
        const resolvedKey = itemKey(subject);
        const ident = identFromToken(subject.name);
        const scan = this.blankIncomingScan(
            subject,
            key,
            resolvedKey,
            ident,
            this.workspaceGen,
            this.cacheEpoch,
            this.fileRev(subject.uri)
        );
        scan.phase = meta.phase;
        scan.locIndex = meta.locIndex;
        scan.callIndex = meta.callIndex;
        const items = this.incoming.get(resolvedKey) || this.incoming.get(key) || [];
        scan.items = items.slice();
        scan.seen = new Set(items.map(child => itemKey(child)));
        if (meta.phase === 'calls' || meta.phase === 'merge-setup') {
            const calls = await this.execLspHeld<vscode.CallHierarchyIncomingCall[]>(
                'vscode.provideIncomingCalls',
                subject
            );
            scan.calls = calls || [];
        }
        if (meta.phase === 'merge' || meta.phase === 'merge-setup') {
            const family = await this.selfAndAncestorTypes(subject);
            scan.familyKeys = new Map(family.map(type => [typeRefKey(type.uri, type.symbol), type.depth]));
            const ancestors = family.filter(type => type.depth > 0);
            scan.slots = (await this.collectVirtualSlots(ancestors, ident))
                .filter(slot => !isLibPath(slot.uri.fsPath));
            scan.locations = await this.familyCallLocations(subject, scan.slots);
            if (meta.phase === 'merge-setup') {
                scan.phase = 'merge';
                scan.locIndex = 0;
            }
        }
        this.incomingScan.set(key, scan);
        if (resolvedKey !== key) {
            this.incomingScan.set(resolvedKey, scan);
        }
        this.incomingOpen.add(key);
        this.incomingOpen.add(resolvedKey);
        return scan;
    }

    private async resumeIncomingScan(
        scan: CenterIncomingScan,
        seq: number,
        goal: number,
        baseline: number
    ): Promise<void> {
        const budget: IncomingBudget = {
            seq,
            deadline: Date.now() + INCOMING_BUDGET_MS,
            goal,
            baseline
        };
        if (scan.phase === 'calls') {
            const paused = await this.pumpIncomingCalls(scan, budget);
            if (paused || !this.isCurrent(seq)) {
                return;
            }
            if (scan.items.length >= budget.goal) {
                scan.phase = 'merge-setup';
                await this.publishPartialIncoming(scan);
                return;
            }
            await this.pumpMergeScan(scan, budget);
            return;
        }
        if (scan.phase === 'merge-setup' || scan.phase === 'merge') {
            await this.pumpMergeScan(scan, budget);
            return;
        }
        await this.pumpRefScan(scan, budget);
    }

    private async methodDeclHasStaticKeyword(item: vscode.CallHierarchyItem): Promise<boolean> {
        const lines = await this.fileLines(item.uri);
        if (!lines?.length) {
            return false;
        }
        const line = item.selectionRange?.start.line ?? item.range.start.line;
        const idx = Math.min(Math.max(0, line), lines.length - 1);
        if (/\bstatic\b/.test(lines[idx] || '')) {
            return true;
        }
        if (idx <= 0) {
            return false;
        }
        const prev = lines[idx - 1] || '';
        return /\bstatic\b/.test(prev) && !/[;{}]\s*(?:\/\/.*)?$/.test(prev);
    }

    private async nameTokenIsStatic(item: vscode.CallHierarchyItem): Promise<boolean> {
        const sel = item.selectionRange ?? item.range;
        const legend = await this.semanticLegend(item.uri);
        if (!legend?.tokenModifiers.includes('static')) {
            return false;
        }
        const data = await this.semanticTokenData(item.uri, sel);
        if (!data) {
            return false;
        }
        return decodeSemanticTokens(data, legend.tokenTypes, legend.tokenModifiers)
            .some(tok => tok.modifiers.includes('static') && tokenOverlapsRange(tok, sel));
    }

    private async fileLines(uri: vscode.Uri): Promise<string[] | undefined> {
        const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
        if (open) {
            const lines: string[] = [];
            for (let i = 0; i < open.lineCount; i++) {
                lines.push(open.lineAt(i).text);
            }
            return lines;
        }
        // workspace.fs round-trips through the editor process; thousands of reference files make that the whole cost.
        if (uri.scheme === 'file') {
            try {
                return (await fs.promises.readFile(uri.fsPath, 'utf8')).split(/\r\n|\n|\r/);
            } catch {
                // fall through to workspace.fs
            }
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            return new TextDecoder('utf8').decode(bytes).split(/\r\n|\n|\r/);
        } catch {
            return undefined;
        }
    }

    /**
     * `recv.ident()` stays only when a resolved static type can dispatch to this
     * slot: the type is the center type, an ancestor, an implemented interface
     * already on that chain, or a subtype of the center type. A resolved type
     * on another chain is dropped. No type, `any`, or a union we cannot split
     * stays.
     */
    private receiverReachesFamily(
        scan: CenterIncomingScan,
        uri: vscode.Uri,
        line: number,
        text: string,
        identColumn: number,
        familyKeys: Map<string, number>
    ): Promise<'yes' | 'no' | 'unknown'> {
        const receiver = readReceiver(text, identColumn);
        if (!receiver) {
            return Promise.resolve('unknown');
        }
        const cacheKey = `${uri.toString()}\0${line}\0${receiver.expr}`;
        let pending = scan.receiverReach.get(cacheKey);
        if (!pending) {
            pending = this.cachedReceiverReach(
                uri,
                line,
                receiver.queries,
                receiver.index,
                familyKeys,
                scan.typeReach,
                cacheKey
            );
            scan.receiverReach.set(cacheKey, pending);
        }
        return pending;
    }

    private async cachedReceiverReach(
        uri: vscode.Uri,
        line: number,
        columns: number[],
        index: number | undefined,
        familyKeys: Map<string, number>,
        typeReach: Map<string, Promise<'yes' | 'no' | 'unknown'>>,
        cacheKey: string
    ): Promise<'yes' | 'no' | 'unknown'> {
        const id = `recv\0${cacheKey}\0${familyStamp(familyKeys)}`;
        const outer = indexDeps.getStore();
        const hit = await relationIndex().take<ReachBody>(id);
        if (hit?.v === 'yes' || hit?.v === 'no') {
            if (outer) {
                for (const dep of hit.uris || []) {
                    outer.add(dep);
                }
            }
            return hit.v;
        }
        const deps = new Set<string>([uri.toString()]);
        const wave = relationIndex().waveNow();
        const verdict = await indexDeps.run(deps, () => this.resolveReceiverReach(
            uri,
            line,
            columns,
            index,
            familyKeys,
            typeReach
        ));
        if (outer) {
            for (const dep of deps) {
                outer.add(dep);
            }
        }
        if (verdict === 'yes' || verdict === 'no') {
            const uris = [...deps];
            await relationIndex().put(id, { v: verdict, uris } satisfies ReachBody, uris, wave);
        }
        return verdict;
    }

    private async resolveReceiverReach(
        uri: vscode.Uri,
        line: number,
        columns: number[],
        index: number | undefined,
        familyKeys: Map<string, number>,
        typeReach: Map<string, Promise<'yes' | 'no' | 'unknown'>>
    ): Promise<'yes' | 'no' | 'unknown'> {
        if (index !== undefined) {
            const fromIndex = await this.judgeHoverColumns(uri, line, columns, index, familyKeys, typeReach);
            if (fromIndex !== 'unknown') {
                return fromIndex;
            }
        }
        let types: { uri: vscode.Uri; symbol: FlatSymbol }[] = [];
        for (const column of columns) {
            try {
                types = await this.typeDefinitionsAt(uri, new vscode.Position(line, column));
            } catch {
                continue;
            }
            if (types.length) {
                break;
            }
        }
        const fromDefs = await this.judgeReceiverTypes(types, familyKeys, typeReach);
        if (fromDefs !== 'unknown') {
            return fromDefs;
        }
        return this.judgeHoverColumns(uri, line, columns, index, familyKeys, typeReach);
    }

    private async judgeHoverColumns(
        uri: vscode.Uri,
        line: number,
        columns: number[],
        index: number | undefined,
        familyKeys: Map<string, number>,
        typeReach: Map<string, Promise<'yes' | 'no' | 'unknown'>>
    ): Promise<'yes' | 'no' | 'unknown'> {
        let names: string[] = [];
        for (const column of columns) {
            names = await this.hoverTypeNames(uri, new vscode.Position(line, column), index);
            if (names.length) {
                break;
            }
        }
        if (!names.length) {
            return 'unknown';
        }
        let unresolved = false;
        for (const name of names) {
            const verdict = await this.typeNameReachesFamily(name, uri, familyKeys, typeReach);
            if (verdict === 'yes') {
                return 'yes';
            }
            if (verdict === 'unknown') {
                unresolved = true;
            }
        }
        return unresolved ? 'unknown' : 'no';
    }

    private async judgeReceiverTypes(
        types: { uri: vscode.Uri; symbol: FlatSymbol }[],
        familyKeys: Map<string, number>,
        typeReach: Map<string, Promise<'yes' | 'no' | 'unknown'>>
    ): Promise<'yes' | 'no' | 'unknown'> {
        if (!types.length) {
            return 'unknown';
        }
        let anyUnknown = false;
        for (const type of types) {
            noteIndexDep(type.uri);
            if (type.symbol.name === 'any' || type.symbol.name === 'unknown') {
                anyUnknown = true;
                continue;
            }
            const verdict = await this.typeReachesFamily(type, familyKeys, typeReach);
            if (verdict === 'yes') {
                return 'yes';
            }
            if (verdict === 'unknown') {
                anyUnknown = true;
            }
        }
        return anyUnknown ? 'unknown' : 'no';
    }

    private async hoverTypeNames(
        uri: vscode.Uri,
        position: vscode.Position,
        index?: number
    ): Promise<string[]> {
        try {
            const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, position);
            return declaredTypeNames(hoverPlain(hovers), index);
        } catch {
            return [];
        }
    }

    /** A declared type name: on the chain by name, otherwise the symbol's own bases. */
    private typeNameReachesFamily(
        name: string,
        uri: vscode.Uri,
        familyKeys: Map<string, number>,
        typeReach: Map<string, Promise<'yes' | 'no' | 'unknown'>>
    ): Promise<'yes' | 'no' | 'unknown'> {
        if (this.familyDepthByName(familyKeys, name) !== undefined) {
            return Promise.resolve('yes');
        }
        const cacheKey = `name\0${uri.toString()}\0${name}`;
        let pending = typeReach.get(cacheKey);
        if (!pending) {
            pending = this.resolveTypeNameReach(name, uri, familyKeys, typeReach);
            typeReach.set(cacheKey, pending);
        }
        return pending;
    }

    private async resolveTypeNameReach(
        name: string,
        uri: vscode.Uri,
        familyKeys: Map<string, number>,
        typeReach: Map<string, Promise<'yes' | 'no' | 'unknown'>>
    ): Promise<'yes' | 'no' | 'unknown'> {
        let symbols: vscode.SymbolInformation[] | undefined;
        try {
            symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                name
            );
        } catch {
            symbols = undefined;
        }
        const hits = (symbols || []).filter(sym => (
            sym.name === name
            && !!sym.location
            && TYPE_CONTAINER_KINDS.has(sym.kind)
            && !isLibPath(sym.location.uri.fsPath)
        )).slice(0, 8);
        if (!hits.length) {
            const local = await this.documentTypeByName(uri, name);
            if (!local) {
                return 'unknown';
            }
            return this.typeReachesFamily(local, familyKeys, typeReach);
        }
        let unresolved = false;
        for (const sym of hits) {
            const hit = await this.containingTypeAt(sym.location.uri, sym.location.range.start);
            if (!hit) {
                unresolved = true;
                continue;
            }
            const verdict = await this.typeReachesFamily(hit, familyKeys, typeReach);
            if (verdict === 'yes') {
                return 'yes';
            }
            if (verdict === 'unknown') {
                unresolved = true;
            }
        }
        return unresolved ? 'unknown' : 'no';
    }

    /** Class or interface declared in this file, including ones without export. */
    private async documentTypeByName(
        uri: vscode.Uri,
        name: string
    ): Promise<{ uri: vscode.Uri; symbol: FlatSymbol } | undefined> {
        let symbols: unknown;
        try {
            symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
        } catch {
            return undefined;
        }
        const flat: FlatSymbol[] = [];
        flattenSymbols(symbols, flat);
        const symbol = flat.find(item => item.name === name && TYPE_CONTAINER_KINDS.has(item.kind));
        return symbol ? { uri, symbol } : undefined;
    }

    private typeReachesFamily(
        type: { uri: vscode.Uri; symbol: FlatSymbol },
        familyKeys: Map<string, number>,
        typeReach: Map<string, Promise<'yes' | 'no' | 'unknown'>>
    ): Promise<'yes' | 'no' | 'unknown'> {
        const key = typeRefKey(type.uri, type.symbol);
        let pending = typeReach.get(key);
        if (!pending) {
            pending = this.cachedTypeReach(type, key, familyKeys);
            typeReach.set(key, pending);
        }
        return pending;
    }

    private async cachedTypeReach(
        type: { uri: vscode.Uri; symbol: FlatSymbol },
        key: string,
        familyKeys: Map<string, number>
    ): Promise<'yes' | 'no' | 'unknown'> {
        const outer = indexDeps.getStore();
        const id = `reach\0${key}\0${familyStamp(familyKeys)}`;
        const hit = await relationIndex().take<ReachBody>(id);
        if (hit?.v === 'yes' || hit?.v === 'no') {
            if (outer) {
                for (const uri of hit.uris || []) {
                    outer.add(uri);
                }
            }
            return hit.v;
        }
        const deps = new Set<string>([type.uri.toString()]);
        const wave = relationIndex().waveNow();
        const verdict = await indexDeps.run(deps, () => this.resolveTypeReach(type, familyKeys));
        if (outer) {
            for (const uri of deps) {
                outer.add(uri);
            }
        }
        if (verdict === 'yes' || verdict === 'no') {
            const uris = [...deps];
            await relationIndex().put(id, { v: verdict, uris } satisfies ReachBody, uris, wave);
        }
        return verdict;
    }

    private async resolveTypeReach(
        type: { uri: vscode.Uri; symbol: FlatSymbol },
        familyKeys: Map<string, number>
    ): Promise<'yes' | 'no' | 'unknown'> {
        if (this.familyDepth(familyKeys, type.uri, type.symbol) !== undefined) {
            return 'yes';
        }
        const hasCenter = [...familyKeys.values()].some(depth => depth === 0);
        if (!hasCenter) {
            return 'unknown';
        }
        try {
            const bases = await this.collectAncestorTypesFrom({
                uri: type.uri,
                symbol: type.symbol,
                depth: 0
            });
            return bases.some(base => this.familyDepth(familyKeys, base.uri, base.symbol) === 0) ? 'yes' : 'no';
        } catch {
            return 'unknown';
        }
    }

    /** Exact symbol, or the same file and type name when the selection position differs. */
    private familyDepth(
        familyKeys: Map<string, number>,
        uri: vscode.Uri,
        symbol: FlatSymbol
    ): number | undefined {
        const exact = familyKeys.get(typeRefKey(uri, symbol));
        if (exact !== undefined) {
            return exact;
        }
        const wantName = symbol.name;
        const wantPath = uri.fsPath.replace(/\\/g, '/').toLowerCase();
        for (const [key, depth] of familyKeys) {
            const split = key.indexOf('\0');
            const nameAt = split < 0 ? -1 : key.indexOf('\0', split + 1);
            if (nameAt < 0) {
                continue;
            }
            if (key.slice(split + 1, nameAt) !== wantName) {
                continue;
            }
            let keyPath = key.slice(0, split);
            try {
                keyPath = vscode.Uri.parse(keyPath).fsPath.replace(/\\/g, '/').toLowerCase();
            } catch {
                // keep the raw key text
            }
            if (keyPath === wantPath) {
                return depth;
            }
        }
        return undefined;
    }

    private familyDepthByName(familyKeys: Map<string, number>, name: string): number | undefined {
        for (const [key, depth] of familyKeys) {
            const split = key.indexOf('\0');
            const nameAt = split < 0 ? -1 : key.indexOf('\0', split + 1);
            if (nameAt >= 0 && key.slice(split + 1, nameAt) === name) {
                return depth;
            }
        }
        return undefined;
    }

    private async typeDefinitionsAt(
        uri: vscode.Uri,
        position: vscode.Position
    ): Promise<{ uri: vscode.Uri; symbol: FlatSymbol }[]> {
        let defs: unknown;
        try {
            defs = await vscode.commands.executeCommand(
                'vscode.executeTypeDefinitionProvider',
                uri,
                position
            );
        } catch {
            return [];
        }
        const out: { uri: vscode.Uri; symbol: FlatSymbol }[] = [];
        const seen = new Set<string>();
        for (const raw of Array.isArray(defs) ? defs : []) {
            const loc = this.asLocation(raw);
            if (!loc) {
                continue;
            }
            const hit = await this.containingTypeAt(loc.uri, loc.range.start);
            if (!hit || !definitionNamesType(loc, hit.symbol)) {
                continue;
            }
            const key = typeRefKey(hit.uri, hit.symbol);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            out.push(hit);
        }
        return out;
    }

    private async classifyOverrideCaller(
        enc: { uri?: vscode.Uri; selectionRange: vscode.Range },
        locUri: vscode.Uri,
        familyKeys: Map<string, number>,
        heritageShare: Map<string, 'subtype' | 'sibling' | 'unrelated'>
    ): Promise<'sibling' | 'unrelated' | { kind: 'chain' | 'external' | 'subtype'; depth: number }> {
        const owner = await this.containingTypeAt(enc.uri ?? locUri, enc.selectionRange.start);
        if (!owner) {
            return { kind: 'external', depth: 0 };
        }
        const ownerKey = typeRefKey(owner.uri, owner.symbol);
        const onChain = this.familyDepth(familyKeys, owner.uri, owner.symbol);
        if (onChain !== undefined) {
            return { kind: 'chain', depth: onChain };
        }
        let verdict = heritageShare.get(ownerKey);
        if (!verdict) {
            const bases = await this.collectAncestorTypesFrom({
                uri: owner.uri,
                symbol: owner.symbol,
                depth: 0
            });
            let subtype = false;
            let shares = false;
            for (const base of bases) {
                const depth = this.familyDepth(familyKeys, base.uri, base.symbol);
                if (depth === 0) {
                    subtype = true;
                }
                if (depth !== undefined) {
                    shares = true;
                }
            }
            verdict = subtype ? 'subtype' : shares ? 'sibling' : 'unrelated';
            heritageShare.set(ownerKey, verdict);
        }
        if (verdict === 'subtype') {
            return { kind: 'subtype', depth: 0 };
        }
        return verdict;
    }

    private async collectAncestorTypesFrom(start: TypeRef): Promise<TypeRef[]> {
        const key = typeRefKey(start.uri, start.symbol);
        let pending = this.ancestorCache.get(key);
        if (!pending) {
            pending = this.cachedAncestors(start, key).catch(err => {
                this.ancestorCache.delete(key);
                throw err;
            });
            this.ancestorCache.set(key, pending);
        }
        const bases = await pending;
        for (const type of bases) {
            noteIndexDep(type.uri);
        }
        noteIndexDep(start.uri);
        if (!start.depth) {
            return bases;
        }
        return bases.map(type => ({ uri: type.uri, symbol: type.symbol, depth: type.depth + start.depth }));
    }

    private async cachedAncestors(start: TypeRef, key: string): Promise<TypeRef[]> {
        const index = relationIndex();
        const id = `anc\0${key}`;
        const hit = await index.take<SerType[]>(id);
        if (hit) {
            return hit.map(raw => ({
                uri: vscode.Uri.parse(raw.uri),
                symbol: symbolFromSer(raw),
                depth: raw.depth || 0
            }));
        }
        const wave = index.waveNow();
        const walked = await this.walkAncestorTypesFrom({ uri: start.uri, symbol: start.symbol, depth: 0 });
        await index.put(
            id,
            walked.map(type => serSymbol(type.uri, type.symbol, type.depth)),
            [start.uri.toString(), ...walked.map(type => type.uri.toString())],
            wave
        );
        return walked;
    }

    private async walkAncestorTypesFrom(start: TypeRef): Promise<TypeRef[]> {
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
        return this.runHeritageForFile(item.uri, async () => {
            const owner = await this.containingTypeAt(
                item.uri,
                item.selectionRange?.start ?? item.range.start
            );
            if (!owner) {
                return [];
            }
            return this.collectAncestorTypesFrom({ uri: owner.uri, symbol: owner.symbol, depth: 0 });
        });
    }

    private async selfAndAncestorTypes(item: vscode.CallHierarchyItem): Promise<TypeRef[]> {
        return this.runHeritageForFile(item.uri, async () => {
            const owner = await this.containingTypeAt(
                item.uri,
                item.selectionRange?.start ?? item.range.start
            );
            if (!owner) {
                return [];
            }
            return [
                { uri: owner.uri, symbol: owner.symbol, depth: 0 },
                ...await this.collectAncestorTypesFrom({ uri: owner.uri, symbol: owner.symbol, depth: 0 })
            ];
        });
    }

    private runHeritageForFile<T>(uri: vscode.Uri, work: () => Promise<T>): Promise<T> {
        const key = uri.toString();
        const prev = this.heritageFileTail.get(key) ?? Promise.resolve();
        const current = prev.then(work, work);
        this.heritageFileTail.set(key, current.then(() => undefined, () => undefined));
        return current;
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
                    const column = line === range.start.line ? range.start.character : 0;
                    if (incomingUseAt(doc.lineAt(line).text, ident, column) === 'this') {
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
        const key = typeRefKey(type.uri, type.symbol);
        let pending = this.baseTypesCache.get(key);
        if (!pending) {
            pending = this.cachedDirectBases(type, key).catch(err => {
                this.baseTypesCache.delete(key);
                throw err;
            });
            this.baseTypesCache.set(key, pending);
        }
        return pending;
    }

    private async cachedDirectBases(
        type: TypeRef,
        key: string
    ): Promise<{ uri: vscode.Uri; symbol: FlatSymbol }[]> {
        const index = relationIndex();
        const id = `base\0${key}`;
        const hit = await index.take<SerType[]>(id);
        if (hit) {
            return hit.map(raw => ({ uri: vscode.Uri.parse(raw.uri), symbol: symbolFromSer(raw) }));
        }
        const wave = index.waveNow();
        const found = await this.lookupDirectBaseTypes(type);
        await index.put(
            id,
            found.map(base => serSymbol(base.uri, base.symbol, 0)),
            [type.uri.toString(), ...found.map(base => base.uri.toString())],
            wave
        );
        return found;
    }

    private async lookupDirectBaseTypes(type: TypeRef): Promise<{ uri: vscode.Uri; symbol: FlatSymbol }[]> {
        if (!skipsTypeHierarchy(type.uri)) {
            const fromHierarchy = await this.basesFromTypeHierarchy(type);
            if (fromHierarchy.length) {
                return fromHierarchy;
            }
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
        if (!legend?.tokenTypes.length || !data) {
            return [];
        }
        const own = identFromToken(type.symbol.name);
        const hits = decodeSemanticTokens(data, legend.tokenTypes, legend.tokenModifiers).filter(tok => {
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

    /** True when the token at `position` is a param/variable/property (no outline kind). */
    private async semanticIsReferenceValue(uri: vscode.Uri, position: vscode.Position): Promise<boolean> {
        let range = new vscode.Range(position, position);
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            range = doc.getWordRangeAtPosition(position) ?? range;
        } catch {
            /* empty range still matches a token that covers the caret */
        }
        const legend = await this.semanticLegend(uri);
        if (!legend?.tokenTypes.length) {
            return false;
        }
        const data = await this.semanticTokenData(uri, range);
        if (!data) {
            return false;
        }
        return decodeSemanticTokens(data, legend.tokenTypes, legend.tokenModifiers)
            .some(tok => VALUE_SEMANTIC_TYPES.has(tok.type) && tokenOverlapsRange(tok, range));
    }

    private async semanticLegend(uri: vscode.Uri): Promise<SemanticLegendInfo | undefined> {
        const key = uri.toString();
        let pending = this.semanticLegendCache.get(key);
        if (!pending) {
            pending = this.lookupSemanticLegend(uri).then(legend => {
                if (!legend) {
                    this.semanticLegendCache.delete(key);
                }
                return legend;
            }, err => {
                this.semanticLegendCache.delete(key);
                throw err;
            });
            this.semanticLegendCache.set(key, pending);
        }
        return pending;
    }

    private async lookupSemanticLegend(uri: vscode.Uri): Promise<SemanticLegendInfo | undefined> {
        for (const command of [
            'vscode.provideDocumentSemanticTokensLegend',
            'vscode.executeDocumentSemanticTokensLegend'
        ]) {
            const raw = await this.execLspHeld<{ tokenTypes?: string[]; tokenModifiers?: string[] }>(command, uri);
            if (raw && Array.isArray(raw.tokenTypes) && raw.tokenTypes.length) {
                return {
                    tokenTypes: raw.tokenTypes,
                    tokenModifiers: Array.isArray(raw.tokenModifiers) ? raw.tokenModifiers : []
                };
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

    private documentSymbols(uri: vscode.Uri): Promise<FlatSymbol[] | undefined> {
        const key = uri.toString();
        const pending = documentSymbolInflight.get(key);
        if (pending) {
            return pending;
        }
        const job = this.queryDocumentSymbols(uri).finally(() => {
            if (documentSymbolInflight.get(key) === job) {
                documentSymbolInflight.delete(key);
            }
        });
        documentSymbolInflight.set(key, job);
        return job;
    }

    private async queryDocumentSymbols(uri: vscode.Uri): Promise<FlatSymbol[] | undefined> {
        let symbols: unknown;
        try {
            symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
        } catch {
            return undefined;
        }
        if (!Array.isArray(symbols)) {
            return undefined;
        }
        const flat: FlatSymbol[] = [];
        flattenSymbols(symbols, flat);
        return flat;
    }

    private async containingTypeAt(
        uri: vscode.Uri,
        position: vscode.Position
    ): Promise<{ uri: vscode.Uri; symbol: FlatSymbol } | undefined> {
        noteIndexDep(uri);
        const flat = await this.documentSymbols(uri);
        if (!flat) {
            return undefined;
        }
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
        const at = await this.nameTokenPosition(uri, enc.range, enc.selectionRange, enc.name);
        const prepared = await this.execLspHeld<vscode.CallHierarchyItem[]>(
            'vscode.prepareCallHierarchy',
            uri,
            at
        );
        const caller = (prepared || []).find(it => rangeContains(it.range, at)) || prepared?.[0];
        if (caller && !isArrowLikeName(caller.name)) {
            this.markPrepared(caller);
            return caller;
        }
        const ident = identFromToken(enc.name);
        const selection = new vscode.Range(at, at.translate(0, Math.max(1, ident.length)));
        return new vscode.CallHierarchyItem(
            enc.kind,
            enc.name,
            enc.detail || '',
            uri,
            enc.range,
            selection
        );
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
        const gen = this.workspaceGen;
        const wave = relationIndex().waveNow();
        if (await this.restoreSide([key], -1, gen, epoch)) {
            const n = this.incoming.get(key)?.length ?? 0;
            costLog('incoming index', Date.now() - t0, `${itemLabel(item)} n=${n} ${relationIndex().status()}`);
            return;
        }
        const pagingEarly = !this.incomingListAll && this.isCenterItem(item);
        if (pagingEarly && await this.restorePartialIncoming([key], gen, epoch)) {
            const n = this.incoming.get(key)?.length ?? 0;
            costLog('incoming partial index', Date.now() - t0, `${itemLabel(item)} n=${n} ${relationIndex().status()}`);
            return;
        }
        const rev = this.fileRev(item.uri);
        const tResolve = Date.now();
        const subject = await this.resolveForHierarchy(item);
        costLog('incoming resolve', Date.now() - tResolve, itemLabel(item));
        if (!subject) {
            costLog('incoming skip unprepared', Date.now() - t0, itemLabel(item));
            return;
        }
        const resolvedKey = itemKey(subject);
        if (await this.restoreSide([key, resolvedKey], -1, gen, epoch)) {
            const n = this.incoming.get(resolvedKey)?.length ?? this.incoming.get(key)?.length ?? 0;
            costLog('incoming index', Date.now() - t0, `${itemLabel(subject)} n=${n} ${relationIndex().status()}`);
            return;
        }
        const paging = !this.incomingListAll && (this.isCenterItem(subject) || this.isCenterItem(item));
        if (paging && await this.restorePartialIncoming([key, resolvedKey], gen, epoch)) {
            const n = this.incoming.get(resolvedKey)?.length ?? this.incoming.get(key)?.length ?? 0;
            costLog('incoming partial index', Date.now() - t0, `${itemLabel(subject)} n=${n} ${relationIndex().status()}`);
            return;
        }
        const tLsp = Date.now();
        const calls = await this.execLspHeld<vscode.CallHierarchyIncomingCall[]>(
            'vscode.provideIncomingCalls',
            subject
        );
        costLog('incoming lsp', Date.now() - tLsp, `${itemLabel(item)} n=${calls?.length ?? 0}`);
        if (this.cacheEpoch !== epoch || this.fileRev(item.uri) !== rev || this.workspaceGen !== gen) {
            costLog('incoming dropped', Date.now() - t0, itemLabel(item));
            return;
        }
        const items: vscode.CallHierarchyItem[] = [];
        const seen = new Set<string>();
        const ident = identFromToken(subject.name);
        const centerBudget: IncomingBudget | undefined = !this.incomingListAll
            && (this.isCenterItem(subject) || this.isCenterItem(item))
            ? { seq: _seq, deadline: t0 + INCOMING_BUDGET_MS, goal: CALL_PAGE, baseline: 0 }
            : undefined;
        const callScan = this.blankIncomingScan(subject, key, resolvedKey, ident, gen, epoch, rev, wave);
        callScan.items = items;
        callScan.seen = seen;
        callScan.calls = calls || [];
        callScan.callIndex = 0;
        callScan.phase = 'calls';
        const callsPaused = await this.pumpIncomingCalls(callScan, centerBudget);
        if (callsPaused) {
            return;
        }
        if (!this.sideGenerationLive(epoch, gen, rev, subject.uri)) {
            return;
        }
        if (centerBudget && items.length >= centerBudget.goal) {
            callScan.phase = 'merge-setup';
            if (this.sideGenerationLive(epoch, gen, rev, subject.uri)) {
                await this.publishPartialIncoming(callScan);
            }
            return;
        }
        const touch = new Set<string>([subject.uri.toString()]);
        const mergePaused = await this.mergeOverrideIncoming(
            subject, key, resolvedKey, items, seen, ident, centerBudget, epoch, gen, rev, touch, wave
        );
        if (mergePaused) {
            return;
        }
        if (this.cacheEpoch !== epoch || this.fileRev(item.uri) !== rev || this.workspaceGen !== gen) {
            costLog('incoming dropped', Date.now() - t0, `${itemLabel(item)} after merge`);
            return;
        }
        await this.rememberOwner(subject);
        await this.rememberOwners(items);
        if (this.cacheEpoch !== epoch || this.fileRev(item.uri) !== rev || this.workspaceGen !== gen) {
            costLog('incoming dropped', Date.now() - t0, `${itemLabel(item)} after owners`);
            return;
        }
        this.finishCompleteIncoming([key, resolvedKey]);
        this.commitSides(this.incoming, this.incomingAt, [key, resolvedKey], items, gen);
        this.aliasCallSites(key, resolvedKey);
        await this.storeSide(-1, [key, resolvedKey], subject, items, [...touch], wave);
        costLog('incoming total', Date.now() - t0, `${itemLabel(item)} n=${items.length}`);
    }

    private async fetchOutgoing(item: vscode.CallHierarchyItem, key: string, _seq: number): Promise<void> {
        const t0 = Date.now();
        const epoch = this.cacheEpoch;
        const gen = this.workspaceGen;
        const wave = relationIndex().waveNow();
        if (await this.restoreSide([key], 1, gen, epoch)) {
            const n = this.outgoing.get(key)?.length ?? 0;
            costLog('outgoing index', Date.now() - t0, `${itemLabel(item)} n=${n} ${relationIndex().status()}`);
            return;
        }
        const rev = this.fileRev(item.uri);
        const tResolve = Date.now();
        const subject = await this.resolveForHierarchy(item);
        costLog('outgoing resolve', Date.now() - tResolve, itemLabel(item));
        if (!subject) {
            costLog('outgoing skip unprepared', Date.now() - t0, itemLabel(item));
            return;
        }
        const resolvedKey = itemKey(subject);
        if (await this.restoreSide([key, resolvedKey], 1, gen, epoch)) {
            const n = this.outgoing.get(resolvedKey)?.length ?? this.outgoing.get(key)?.length ?? 0;
            costLog('outgoing index', Date.now() - t0, `${itemLabel(subject)} n=${n} ${relationIndex().status()}`);
            return;
        }
        const tLsp = Date.now();
        const calls = await this.execLspHeld<vscode.CallHierarchyOutgoingCall[]>(
            'vscode.provideOutgoingCalls',
            subject
        );
        costLog('outgoing lsp', Date.now() - tLsp, `${itemLabel(item)} n=${calls?.length ?? 0}`);
        if (this.cacheEpoch !== epoch || this.fileRev(item.uri) !== rev || this.workspaceGen !== gen) {
            costLog('outgoing dropped', Date.now() - t0, itemLabel(item));
            return;
        }
        if (!calls?.length) {
            this.commitSides(this.outgoing, this.outgoingAt, [key, resolvedKey], [], gen);
            this.aliasCallSites(key, resolvedKey);
            await this.storeSide(1, [key, resolvedKey], subject, [], [subject.uri.toString()], wave);
            costLog('outgoing total', Date.now() - t0, `${itemLabel(item)} n=0`);
            return;
        }
        const items: vscode.CallHierarchyItem[] = [];
        const seen = new Set<string>();
        const ident = identFromToken(subject.name);
        const tChain = Date.now();
        const chain = await this.selfAndAncestorTypes(subject);
        costLog('outgoing chain', Date.now() - tChain, `${itemLabel(item)} types=${chain.length}`);
        const tSites = Date.now();
        const derivedByIdent = new Map<string, vscode.CallHierarchyItem | undefined>();
        for (const call of calls || []) {
            if (!call?.to) {
                continue;
            }
            let target = call.to;
            let sites = call.fromRanges;
            if (itemKey(call.to) === key || itemKey(call.to) === resolvedKey) {
                sites = await this.rewriteSelfSuper(subject.uri, call.fromRanges, ident, subject, resolvedKey);
                if (!sites.length) {
                    continue;
                }
            }
            const calleeIdent = identFromToken(target.name);
            if (calleeIdent && await this.outgoingSitesAreThisDispatch(subject.uri, sites, calleeIdent)) {
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
            this.rememberCallSite(key, 1, target, subject.uri, sites, target.name);
        }
        costLog('outgoing sites', Date.now() - tSites, `${itemLabel(item)} n=${items.length} derived=${derivedByIdent.size}`);
        if (this.cacheEpoch !== epoch || this.fileRev(item.uri) !== rev || this.workspaceGen !== gen) {
            costLog('outgoing dropped', Date.now() - t0, `${itemLabel(item)} after rewrite`);
            return;
        }
        this.commitSides(this.outgoing, this.outgoingAt, [key, resolvedKey], items, gen);
        this.aliasCallSites(key, resolvedKey);
        await this.storeSide(
            1,
            [key, resolvedKey],
            subject,
            items,
            chain.map(type => type.uri.toString()),
            wave
        );
        costLog('outgoing total', Date.now() - t0, `${itemLabel(item)} n=${items.length}`);
    }

    private sideCount(item: vscode.CallHierarchyItem, dir: -1 | 1): number {
        return this.sideList(item, dir)?.length ?? 0;
    }

    /** Missing or stale cache still shows +, so a click can fetch. A fresh empty side does not. */
    private canExpand(item: vscode.CallHierarchyItem, dir: -1 | 1): boolean {
        if (this.relationMode === 'reference' && this.root && itemKey(item) === itemKey(this.root) && dir > 0) {
            return false;
        }
        if (isLibPath(item.uri.fsPath)) {
            return false;
        }
        const cache = dir < 0 ? this.incoming : this.outgoing;
        if (!this.cacheKeysFor(item).some(k => cache.has(k)) || !this.sideFresh(item, dir)) {
            return true;
        }
        return this.sideCount(item, dir) > 0;
    }

    /** Expand All / MCP can still grow a node whose next hop has not been peeked. */
    nodeCanGrow(node: RelationNode): boolean {
        if (node.kind !== 'symbol' || node.cyclic || node.hop === 0 || Math.abs(node.hop) >= CALL_MAX_HOP) {
            return false;
        }
        const item = this.items.get(node.itemKey);
        if (!item) {
            return false;
        }
        const dir: -1 | 1 = node.hop < 0 ? -1 : 1;
        return this.canExpand(item, dir) || (
            dir < 0 ? !this.incoming.has(node.itemKey) : !this.outgoing.has(node.itemKey)
        );
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

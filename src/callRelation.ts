import * as path from 'path';
import * as vscode from 'vscode';

export const CALL_PAGE = 12;
export const CALL_MAX_HOP = 8;

export type RelationNodeKind = 'symbol' | 'more';

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
}

export interface RelationEdge {
    from: string;
    to: string;
    sites?: RelationOpenTarget[];
}

export interface RelationGraph {
    rootId: string;
    title: string;
    nodes: RelationNode[];
    edges: RelationEdge[];
    empty?: string;
}

export interface RelationOpenTarget {
    uri: string;
    line: number;
    character: number;
    name: string;
    file?: string;
    snippet?: string;
}

function identFromToken(name: string): string {
    return (name || '').replace(/\(.*\)$/, '').split(/::|\./).pop() || name;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function visualId(key: string, hop: number, parentId: string): string {
    return `${key}@${hop}@${parentId}`;
}

function fileLabel(uri: vscode.Uri): string {
    return path.basename(uri.fsPath);
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
        name: item.name,
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
    private readonly shown = new Map<string, number>();
    private readonly expanded = new Set<string>();
    private root: vscode.CallHierarchyItem | undefined;
    private seq = 0;

    reset(): void {
        this.items.clear();
        this.incoming.clear();
        this.outgoing.clear();
        this.callSites.clear();
        this.shown.clear();
        this.expanded.clear();
        this.root = undefined;
        this.seq++;
    }

    remember(item: vscode.CallHierarchyItem): string {
        const key = itemKey(item);
        if (!this.items.has(key)) {
            this.items.set(key, item);
        }
        return key;
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
        return {
            uri: item.uri.toString(),
            line: sel.line,
            character: sel.character,
            name: item.name || node.name
        };
    }

    async loadRoot(uri: vscode.Uri, position: vscode.Position): Promise<RelationGraph> {
        const seq = ++this.seq;
        this.items.clear();
        this.incoming.clear();
        this.outgoing.clear();
        this.callSites.clear();
        this.shown.clear();
        this.expanded.clear();
        this.root = undefined;

        let prepared: vscode.CallHierarchyItem[] | undefined;
        try {
            prepared = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
                'vscode.prepareCallHierarchy',
                uri,
                position
            );
        } catch {
            prepared = undefined;
        }
        if (seq !== this.seq) {
            return this.emptyGraph('Cancelled');
        }
        if (!prepared?.length) {
            return this.emptyGraph('No call hierarchy at this position. The language server may not support it.');
        }

        const containing = prepared.find(item => rangeContains(item.range, position));
        this.root = containing || prepared[0];
        this.remember(this.root);
        await Promise.all([
            this.ensureIncoming(this.root),
            this.ensureOutgoing(this.root)
        ]);
        if (seq !== this.seq) {
            return this.emptyGraph('Cancelled');
        }
        return this.buildVisible(seq);
    }

    async expandMore(nodeId: string): Promise<RelationGraph> {
        const current = this.shown.get(nodeId) ?? CALL_PAGE;
        this.shown.set(nodeId, current + CALL_PAGE);
        return this.buildVisible();
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
        }
        return this.buildGraph();
    }

    async expandHop(nodeId: string, nodes: RelationNode[]): Promise<RelationGraph> {
        const node = nodes.find(n => n.id === nodeId && n.kind === 'symbol');
        if (!node || !this.root) {
            return this.buildGraph();
        }
        if (Math.abs(node.hop) >= CALL_MAX_HOP) {
            return this.buildGraph();
        }
        const item = this.items.get(node.itemKey);
        if (!item) {
            return this.buildGraph();
        }
        if (node.hop < 0) {
            await this.ensureIncoming(item);
        } else if (node.hop > 0) {
            await this.ensureOutgoing(item);
        }
        this.expanded.add(nodeId);
        return this.buildVisible();
    }

    private async buildVisible(seq?: number): Promise<RelationGraph> {
        const graph = this.buildGraph();
        await this.prefetchNextHop(graph.nodes);
        if (seq !== undefined && seq !== this.seq) {
            return this.emptyGraph('Cancelled');
        }
        return this.buildGraph();
    }

    private async prefetchNextHop(nodes: RelationNode[]): Promise<void> {
        const pending: { item: vscode.CallHierarchyItem; dir: -1 | 1 }[] = [];
        for (const node of nodes) {
            if (node.kind !== 'symbol' || node.hop === 0 || Math.abs(node.hop) >= CALL_MAX_HOP) {
                continue;
            }
            const item = this.items.get(node.itemKey);
            if (!item) {
                continue;
            }
            const dir = node.hop < 0 ? -1 : 1;
            const peeked = dir < 0 ? this.incoming.has(node.itemKey) : this.outgoing.has(node.itemKey);
            if (!peeked) {
                pending.push({ item, dir });
            }
        }
        const limit = 6;
        for (let i = 0; i < pending.length; i += limit) {
            await Promise.all(pending.slice(i, i + limit).map(job => (
                job.dir < 0 ? this.ensureIncoming(job.item) : this.ensureOutgoing(job.item)
            )));
        }
    }

    buildGraph(): RelationGraph {
        if (!this.root) {
            return this.emptyGraph('No call hierarchy at this position.');
        }
        const rootNode = toSymbolNode(this.root, 0, undefined, false);
        const nodes: RelationNode[] = [rootNode];
        const edges: RelationEdge[] = [];
        this.addSide(nodes, edges, rootNode, -1);
        this.addSide(nodes, edges, rootNode, 1);
        return {
            rootId: rootNode.id,
            title: this.root.name,
            nodes,
            edges
        };
    }

    private emptyGraph(empty: string): RelationGraph {
        return { rootId: '', title: '', nodes: [], edges: [], empty };
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
        const kids = dir < 0 ? this.incoming.get(parent.itemKey) : this.outgoing.get(parent.itemKey);
        if (!kids) {
            return;
        }
        const shownKey = `${parent.id}:${dir}`;
        const limit = this.shown.get(shownKey) ?? CALL_PAGE;
        const visible = kids.slice(0, limit);
        for (const child of visible) {
            const childNode = toSymbolNode(child, hop, parent.id, false);
            const opened = this.expanded.has(childNode.id);
            childNode.expanded = opened;
            childNode.expandable = Math.abs(hop) < CALL_MAX_HOP && this.canExpand(child, dir);
            nodes.push(childNode);
            const sites = this.callSites.get(`${parent.itemKey}\0${dir}\0${childNode.itemKey}`);
            if (dir < 0) {
                edges.push({ from: childNode.id, to: parent.id, sites });
            } else {
                edges.push({ from: parent.id, to: childNode.id, sites });
            }
            if (this.expanded.has(childNode.id)) {
                this.addSide(nodes, edges, childNode, dir);
            }
        }
        const hidden = kids.length - visible.length;
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
                expandKey: shownKey
            });
            if (dir < 0) {
                edges.push({ from: moreId, to: parent.id });
            } else {
                edges.push({ from: parent.id, to: moreId });
            }
        }
    }

    private async ensureIncoming(item: vscode.CallHierarchyItem): Promise<void> {
        const key = this.remember(item);
        if (this.incoming.has(key)) {
            return;
        }
        let calls: vscode.CallHierarchyIncomingCall[] | undefined;
        try {
            calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
                'vscode.provideIncomingCalls',
                item
            );
        } catch {
            calls = undefined;
        }
        const items: vscode.CallHierarchyItem[] = [];
        const seen = new Set<string>();
        for (const call of calls || []) {
            if (!call?.from) {
                continue;
            }
            const k = this.remember(call.from);
            if (seen.has(k)) {
                continue;
            }
            seen.add(k);
            items.push(this.items.get(k)!);
            await this.rememberCallSite(key, -1, call.from, call.from.uri, call.fromRanges, item.name);
        }
        this.incoming.set(key, items);
    }

    private async ensureOutgoing(item: vscode.CallHierarchyItem): Promise<void> {
        const key = this.remember(item);
        if (this.outgoing.has(key)) {
            return;
        }
        let calls: vscode.CallHierarchyOutgoingCall[] | undefined;
        try {
            calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
                'vscode.provideOutgoingCalls',
                item
            );
        } catch {
            calls = undefined;
        }
        const items: vscode.CallHierarchyItem[] = [];
        const seen = new Set<string>();
        for (const call of calls || []) {
            if (!call?.to) {
                continue;
            }
            const k = this.remember(call.to);
            if (seen.has(k)) {
                continue;
            }
            seen.add(k);
            items.push(this.items.get(k)!);
            await this.rememberCallSite(key, 1, call.to, item.uri, call.fromRanges, call.to.name);
        }
        this.outgoing.set(key, items);
    }

    private sideCount(item: vscode.CallHierarchyItem, dir: -1 | 1): number {
        const key = itemKey(item);
        const list = dir < 0 ? this.incoming.get(key) : this.outgoing.get(key);
        return list?.length ?? 0;
    }

    private canExpand(item: vscode.CallHierarchyItem, dir: -1 | 1): boolean {
        const key = itemKey(item);
        const peeked = dir < 0 ? this.incoming.has(key) : this.outgoing.has(key);
        if (!peeked) {
            return true;
        }
        return this.sideCount(item, dir) > 0;
    }

    private async rememberCallSite(
        parentKey: string,
        dir: -1 | 1,
        child: vscode.CallHierarchyItem,
        uri: vscode.Uri,
        ranges: vscode.Range[] | undefined,
        token: string
    ): Promise<void> {
        const sites: RelationOpenTarget[] = [];
        const seen = new Set<string>();
        let doc: vscode.TextDocument | undefined;
        try {
            doc = await vscode.workspace.openTextDocument(uri);
        } catch {
            doc = undefined;
        }
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
            let snippet = '';
            if (doc && start.line >= 0 && start.line < doc.lineCount) {
                snippet = doc.lineAt(start.line).text.replace(/\s+/g, ' ').trim();
            }
            sites.push({
                uri: uri.toString(),
                line: start.line,
                character: start.character,
                name: token,
                file,
                snippet
            });
        }
        if (sites.length) {
            this.callSites.set(`${parentKey}\0${dir}\0${itemKey(child)}`, sites);
        }
    }
}

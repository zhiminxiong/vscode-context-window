import * as path from 'path';
import * as vscode from 'vscode';

export const CALL_PAGE = 12;
export const CALL_MAX_HOP = 8;

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
}

export interface RelationEdge {
    from: string;
    to: string;
    sites?: RelationOpenTarget[];
    style?: 'anchor';
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

function costLog(layer: string, ms: number, detail = ''): void {
    console.log(`[relation cost] ${layer} ${ms}ms${detail ? ` ${detail}` : ''}`);
}

function isLibPath(fsPath: string): boolean {
    const p = fsPath.replace(/\\/g, '/').toLowerCase();
    return p.endsWith('.d.ts') || p.includes('/node_modules/');
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
    private readonly keepExpand = new Set<string>();
    private readonly keepGroups = new Set<string>();
    private root: vscode.CallHierarchyItem | undefined;
    private prevRoot: vscode.CallHierarchyItem | undefined;
    private seq = 0;
    private cts = new vscode.CancellationTokenSource();

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
        this.shown.clear();
        this.expanded.clear();
        this.keepExpand.clear();
        this.keepGroups.clear();
        this.root = undefined;
        this.prevRoot = undefined;
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

    async loadRoot(uri: vscode.Uri, position: vscode.Position): Promise<{ graph: RelationGraph; seq: number } | undefined> {
        this.cancel();
        const seq = this.seq;
        this.clearGraphState();
        const t0 = Date.now();
        const loc = `${fileLabel(uri)}:${position.line + 1}:${position.character + 1}`;
        costLog('loadRoot begin', 0, loc);

        const prepared = await this.execLsp<vscode.CallHierarchyItem[]>(
            seq,
            'vscode.prepareCallHierarchy',
            uri,
            position
        );
        if (!this.isCurrent(seq)) {
            costLog('loadRoot cancelled', Date.now() - t0, `${loc} after prepare`);
            return undefined;
        }
        if (!prepared?.length) {
            costLog('loadRoot empty', Date.now() - t0, loc);
            return { graph: this.emptyGraph('No call hierarchy at this position. The language server may not support it.'), seq };
        }

        const containing = prepared.find(item => rangeContains(item.range, position));
        this.root = containing || prepared[0];
        this.remember(this.root);
        const rootName = itemLabel(this.root);
        const tRoot = Date.now();
        await Promise.all([
            this.ensureIncoming(this.root, seq),
            this.ensureOutgoing(this.root, seq)
        ]);
        costLog('root in+out', Date.now() - tRoot, rootName);
        if (!this.isCurrent(seq)) {
            costLog('loadRoot cancelled', Date.now() - t0, `${rootName} after root in+out`);
            return undefined;
        }
        const tVisible = Date.now();
        const graph = await this.buildVisible(seq);
        costLog('buildVisible', Date.now() - tVisible, rootName);
        if (!graph || !this.isCurrent(seq)) {
            costLog('loadRoot cancelled', Date.now() - t0, `${rootName} after buildVisible`);
            return undefined;
        }
        costLog('loadRoot done', Date.now() - t0, rootName);
        return { graph, seq };
    }

    async expandMore(nodeId: string): Promise<RelationGraph | undefined> {
        const seq = this.seq;
        const current = this.shown.get(nodeId) ?? CALL_PAGE;
        this.shown.set(nodeId, current + CALL_PAGE);
        return this.buildVisible(seq);
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
            const n = nodes.find(x => x.id === id);
            const parent = n?.parentId ? nodes.find(x => x.id === n.parentId) : undefined;
            if (n?.itemKey && parent?.itemKey) {
                this.keepExpand.delete(branchKeepKey(parent.itemKey, n.hop < 0 ? -1 : 1, n.itemKey));
            }
        }
        return this.buildGraph();
    }

    async expandHop(nodeId: string, nodes: RelationNode[]): Promise<RelationGraph | undefined> {
        const seq = this.seq;
        const t0 = Date.now();
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
        this.expanded.add(nodeId);
        const parent = node.parentId ? nodes.find(n => n.id === node.parentId) : undefined;
        if (parent?.itemKey && node.itemKey) {
            this.keepExpand.add(branchKeepKey(parent.itemKey, node.hop < 0 ? -1 : 1, node.itemKey));
        }
        const graph = await this.buildVisible(seq);
        costLog('expandHop', Date.now() - t0, `${node.name} hop=${node.hop}`);
        return graph;
    }

    async focusNode(nodeId: string, nodes: RelationNode[]): Promise<RelationGraph | undefined> {
        const seq = this.seq;
        const t0 = Date.now();
        const focus = nodes.find(n => n.id === nodeId && n.kind === 'symbol');
        if (!focus) {
            return this.buildGraph();
        }
        const item = this.items.get(focus.itemKey);
        if (!item) {
            return this.buildGraph();
        }
        if (this.root && itemKey(this.root) === focus.itemKey && focus.hop === 0) {
            return this.buildGraph();
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
                for (const c of nodes) {
                    if (c.parentId === n.id && c.kind === 'symbol' && c.itemKey) {
                        this.keepExpand.add(branchKeepKey(n.itemKey, c.hop > 0 ? 1 : -1, c.itemKey));
                    }
                }
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

        const oldRoot = this.root;
        this.prevRoot = oldRoot && itemKey(oldRoot) !== focus.itemKey ? oldRoot : undefined;
        this.root = item;
        this.remember(item);
        this.shown.clear();
        const warm: Promise<void>[] = [
            this.ensureIncoming(item, seq),
            this.ensureOutgoing(item, seq)
        ];
        for (const key of this.keepExpand) {
            const next = this.items.get(keepExpandItemKey(key));
            if (!next) {
                continue;
            }
            const dir = keepExpandDir(key);
            if (dir === undefined) {
                continue;
            }
            warm.push(dir < 0 ? this.ensureIncoming(next, seq) : this.ensureOutgoing(next, seq));
        }
        await Promise.all(warm);
        costLog('focusNode warm', Date.now() - t0, itemLabel(item));
        if (!this.isCurrent(seq)) {
            costLog('focusNode cancelled', Date.now() - t0, itemLabel(item));
            return undefined;
        }
        const graph = await this.buildVisible(seq);
        costLog('focusNode', Date.now() - t0, itemLabel(item));
        return graph;
    }

    async toggleGroup(nodeId: string, nodes: RelationNode[]): Promise<RelationGraph | undefined> {
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
            return this.isCurrent(seq) ? this.buildGraph() : undefined;
        }
        this.expanded.add(nodeId);
        if (keepKey) {
            this.keepGroups.add(keepKey);
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
        await this.prefetchNextHop(seq, graph.nodes);
        if (!this.isCurrent(seq)) {
            return undefined;
        }
        return this.buildGraph();
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
            if (!item) {
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
        }
        costLog('prefetch total', Date.now() - t0, `jobs=${pending.length}`);
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
        const prevKey = this.prevRoot ? itemKey(this.prevRoot) : '';
        if (prevKey) {
            const prevNode = nodes.find(n => n.kind === 'symbol' && n.itemKey === prevKey);
            if (prevNode) {
                prevNode.prevCenter = true;
            }
        }
        this.syncToggleState(nodes);
        return {
            rootId: rootNode.id,
            title: this.root.name,
            nodes,
            edges
        };
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
        return { rootId: '', title: '', nodes: [], edges: [], empty };
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
        const kids = dir < 0 ? this.incoming.get(parent.itemKey) : this.outgoing.get(parent.itemKey);
        if (!kids) {
            return;
        }
        const shownKey = `${parent.id}:${dir}`;
        const limit = this.shown.get(shownKey) ?? CALL_PAGE;
        const pinned: vscode.CallHierarchyItem[] = [];
        const rest: vscode.CallHierarchyItem[] = [];
        const seenPin = new Set<string>();
        for (const child of kids) {
            const k = itemKey(child);
            if (this.isPinnedChild(parent.itemKey, dir, k)) {
                if (!seenPin.has(k)) {
                    seenPin.add(k);
                    pinned.push(child);
                }
                continue;
            }
            rest.push(child);
        }
        const page = rest.slice(0, limit);
        const compact = kids.length >= 6;
        const libByFile = new Map<string, vscode.CallHierarchyItem[]>();
        for (const child of page) {
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
        const rootKey = this.root ? itemKey(this.root) : '';
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
            if (childKey === rootKey) {
                return;
            }
            const childNode = toSymbolNode(child, hop, parent.id, false);
            if (nodes.some(n => n.id === childNode.id)) {
                return;
            }
            const opened = this.expanded.has(childNode.id)
                || this.keepExpand.has(branchKeepKey(parent.itemKey, dir, childKey))
                || this.keepExpand.has(`self\0${childKey}`);
            childNode.expanded = opened;
            childNode.expandable = Math.abs(hop) < CALL_MAX_HOP && this.canExpand(child, dir);
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
        for (const child of pinned) {
            emitChild(child);
        }
        for (const child of page) {
            const file = fileLabel(child.uri);
            if (isLibPath(child.uri.fsPath) && groupedFiles.has(file)) {
                if (seenGroup.has(file)) {
                    continue;
                }
                seenGroup.add(file);
                const bunch = (libByFile.get(file) || []).filter(item => {
                    const k = itemKey(item);
                    return k !== rootKey;
                });
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
                continue;
            }
            emitChild(child);
        }
        for (const childNode of pendingExpand) {
            this.addSide(nodes, edges, childNode, dir);
        }
        const hidden = rest.length - page.length;
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
        if (!this.isCurrent(seq)) {
            return;
        }
        const key = this.remember(item);
        if (this.incoming.has(key)) {
            return;
        }
        const t0 = Date.now();
        const calls = await this.execLsp<vscode.CallHierarchyIncomingCall[]>(
            seq,
            'vscode.provideIncomingCalls',
            item
        );
        if (!this.isCurrent(seq)) {
            costLog('incoming cancelled', Date.now() - t0, itemLabel(item));
            return;
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
            this.rememberCallSite(key, -1, call.from, call.from.uri, call.fromRanges, item.name);
        }
        this.incoming.set(key, items);
        costLog('incoming total', Date.now() - t0, `${itemLabel(item)} n=${items.length}`);
    }

    private async ensureOutgoing(item: vscode.CallHierarchyItem, seq: number): Promise<void> {
        if (!this.isCurrent(seq)) {
            return;
        }
        const key = this.remember(item);
        if (this.outgoing.has(key)) {
            return;
        }
        const t0 = Date.now();
        const calls = await this.execLsp<vscode.CallHierarchyOutgoingCall[]>(
            seq,
            'vscode.provideOutgoingCalls',
            item
        );
        if (!this.isCurrent(seq)) {
            costLog('outgoing cancelled', Date.now() - t0, itemLabel(item));
            return;
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
            this.rememberCallSite(key, 1, call.to, item.uri, call.fromRanges, call.to.name);
        }
        this.outgoing.set(key, items);
        costLog('outgoing total', Date.now() - t0, `${itemLabel(item)} n=${items.length}`);
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
            return false;
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
        const docs = new Map<string, vscode.TextDocument | null>();
        let filled = 0;
        for (const edge of graph.edges) {
            if (!this.isCurrent(seq)) {
                return;
            }
            if (!edge.sites?.length) {
                continue;
            }
            for (const site of edge.sites) {
                if (site.snippet || !site.uri) {
                    continue;
                }
                let doc = docs.get(site.uri);
                if (doc === undefined) {
                    try {
                        doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(site.uri));
                    } catch {
                        doc = null;
                    }
                    if (!this.isCurrent(seq)) {
                        return;
                    }
                    docs.set(site.uri, doc);
                }
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

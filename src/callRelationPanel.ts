import * as vscode from 'vscode';
import { showPanelInNewWindow } from './auxiliaryWindow';
import {
    callSiteIdentRange,
    CallRelationModel,
    DEFAULT_SLIM_KIND_IDS,
    parseSlimKindIds,
    RelationGraph
} from './callRelation';

export const CALL_RELATION_VIEW_TYPE = 'contextView.callRelation';

function nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}

export class CallRelationPanel {
    private panel: vscode.WebviewPanel | undefined;
    private readonly model = new CallRelationModel();
    private graph: RelationGraph = { rootId: '', title: '', nodes: [], edges: [] };
    private pinned = false;
    private edgeStyle: 'elbow' | 'direct' | 'arc' = 'arc';
    private updateMode: 'live' | 'sticky' = 'live';
    private compactFilter = false;
    private compactKinds: string[] = [...DEFAULT_SLIM_KIND_IDS];
    private followTimer: ReturnType<typeof setTimeout> | undefined;
    private progressDepth = 0;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly extensionUri: vscode.Uri) {
        this.edgeStyle = this.readEdgeStyle();
        this.updateMode = this.readUpdateMode();
        this.compactFilter = this.readCompactFilter();
        this.compactKinds = this.readCompactKinds();
        this.model.setCompactFilter(this.compactFilter);
        this.model.setCompactKinds(this.compactKinds);
        this.model.setGraphListener((graph, seq) => this.applyGraph(graph, seq));
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('contextView.callRelation.edgeStyle')) {
                    this.edgeStyle = this.readEdgeStyle();
                    this.postState();
                }
                if (e.affectsConfiguration('contextView.callRelation.updateMode')) {
                    this.updateMode = this.readUpdateMode();
                    this.postState();
                }
                if (e.affectsConfiguration('contextView.callRelation.compactFilter')) {
                    this.applyCompactFilter(this.readCompactFilter());
                }
                if (e.affectsConfiguration('contextView.callRelation.compactKinds')) {
                    this.applyCompactKinds(this.readCompactKinds());
                }
                if (e.affectsConfiguration('workbench.hover.delay')) {
                    this.postState();
                }
            }),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.scheme !== 'file' || !e.contentChanges.length) {
                    return;
                }
                const rootUri = this.model.rootUri();
                this.model.invalidateUri(e.document.uri);
                if (this.pinned || !this.panel) {
                    return;
                }
                if (rootUri === e.document.uri.toString()) {
                    void this.reloadFromEditor(vscode.window.activeTextEditor);
                }
            }),
            vscode.window.onDidChangeTextEditorSelection(e => {
                if (this.pinned || !this.panel || e.selections.length === 0) {
                    return;
                }
                if (e.textEditor.document.uri.scheme !== 'file') {
                    return;
                }
                if (this.followTimer) {
                    clearTimeout(this.followTimer);
                }
                this.followTimer = setTimeout(() => {
                    void this.reloadFromEditor(e.textEditor);
                }, 450);
            })
        );
    }

    dispose(): void {
        if (this.followTimer) {
            clearTimeout(this.followTimer);
        }
        this.panel?.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    show(): void {
        this.ensurePanel(vscode.ViewColumn.Beside);
        void this.afterOpen(vscode.window.activeTextEditor);
    }

    async showInNewWindow(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        await showPanelInNewWindow(this.panel, column => this.ensurePanel(column));
        await this.reloadFromEditor(editor);
    }

    isActive(): boolean {
        return !!this.panel?.active;
    }

    find(action: 'open' | 'next' | 'prev' | 'close'): void {
        if (!this.panel) {
            return;
        }
        this.panel.webview.postMessage({ type: 'find', action });
    }

    private ensurePanel(column: vscode.ViewColumn = vscode.ViewColumn.Beside): vscode.WebviewPanel {
        if (this.panel) {
            return this.panel;
        }
        this.panel = vscode.window.createWebviewPanel(
            CALL_RELATION_VIEW_TYPE,
            'Call Relation',
            column,
            {
                enableScripts: true,
                enableFindWidget: false,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
            }
        );
        const iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
        this.panel.iconPath = { light: iconPath, dark: iconPath };
        this.panel.webview.html = this.html(this.panel.webview);
        void vscode.commands.executeCommand('setContext', 'contextView.callRelation.active', true);
        this.panel.onDidChangeViewState(() => {
            void vscode.commands.executeCommand(
                'setContext',
                'contextView.callRelation.active',
                !!this.panel?.active
            );
        });
        this.panel.onDidDispose(() => {
            if (this.followTimer) {
                clearTimeout(this.followTimer);
                this.followTimer = undefined;
            }
            this.panel = undefined;
            this.model.reset();
            void vscode.commands.executeCommand('setContext', 'contextView.callRelation.active', false);
            void vscode.commands.executeCommand('setContext', 'contextView.callRelation.findOpen', false);
        });
        this.panel.webview.onDidReceiveMessage(message => {
            void this.onMessage(message);
        });
        return this.panel;
    }

    private async afterOpen(editor: vscode.TextEditor | undefined): Promise<void> {
        await this.lockPanelGroup();
        await this.reloadFromEditor(editor);
    }

    private async lockPanelGroup(): Promise<void> {
        if (!this.panel) {
            return;
        }
        this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
        if (!this.panel.active) {
            return;
        }
        const groups = (vscode.window as unknown as {
            tabGroups?: { all: { viewColumn?: vscode.ViewColumn; isLocked: boolean }[] };
        }).tabGroups;
        const column = this.panel.viewColumn;
        const group = groups?.all.find(g => g.viewColumn === column);
        if (group?.isLocked) {
            return;
        }
        try {
            await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
        } catch {
            // Older VS Code builds may not have editor-group lock.
        }
    }

    private async onMessage(message: any): Promise<void> {
        if (!this.panel) {
            return;
        }
        switch (message?.type) {
            case 'findState':
                void vscode.commands.executeCommand(
                    'setContext',
                    'contextView.callRelation.findOpen',
                    !!message.open
                );
                break;
            case 'copyToClipboard':
                if (typeof message.text === 'string' && message.text.length > 0) {
                    await vscode.env.clipboard.writeText(message.text);
                    if (typeof message.notify === 'string' && message.notify) {
                        vscode.window.setStatusBarMessage(message.notify, 2000);
                    }
                }
                break;
            case 'ready':
                this.postState();
                if (this.progressDepth > 0) {
                    this.panel.webview.postMessage({ type: 'beginProgress' });
                }
                if (this.graph.rootId || this.graph.empty) {
                    this.postGraph();
                }
                break;
            case 'setPinned':
                this.pinned = !!message.value;
                this.postState();
                break;
            case 'setUpdateMode': {
                this.updateMode = message.value === 'sticky' ? 'sticky' : 'live';
                await vscode.workspace.getConfiguration('contextView.callRelation').update(
                    'updateMode',
                    this.updateMode,
                    true
                );
                this.postState();
                break;
            }
            case 'setEdgeStyle': {
                this.edgeStyle = this.normalizeEdgeStyle(message.value);
                await vscode.workspace.getConfiguration('contextView.callRelation').update(
                    'edgeStyle',
                    this.edgeStyle,
                    true
                );
                this.postState();
                break;
            }
            case 'setCompactFilter': {
                await vscode.workspace.getConfiguration('contextView.callRelation').update(
                    'compactFilter',
                    !!message.value,
                    true
                );
                this.applyCompactFilter(!!message.value);
                break;
            }
            case 'setCompactKinds': {
                const ids = parseSlimKindIds(message.value);
                await vscode.workspace.getConfiguration('contextView.callRelation').update(
                    'compactKinds',
                    ids,
                    true
                );
                this.applyCompactKinds(ids);
                break;
            }
            case 'openNode': {
                const nodeId = String(message.nodeId || '');
                const target = this.model.getOpenTarget(nodeId, this.graph.nodes);
                if (target) {
                    const line = target.line + 1;
                    const character = Math.max(1, target.character + 1);
                    await vscode.commands.executeCommand(
                        'vscode-context-window.navigateUri',
                        target.uri,
                        {
                            start: { line, character },
                            end: { line, character }
                        },
                        target.name,
                        false
                    );
                }
                break;
            }
            case 'focusNode': {
                const nodeId = String(message.nodeId || '');
                const current = this.graph.nodes.find(n => n.id === nodeId);
                if (current && current.kind === 'symbol' && current.id !== this.graph.rootId) {
                    const nodes = this.graph.nodes;
                    await this.withProgress(async () => {
                        const loaded = await this.model.focusNode(nodeId, nodes);
                        this.applyGraph(loaded?.graph, loaded?.seq ?? -1);
                    });
                }
                break;
            }
            case 'focusTrail': {
                const index = Number(message.index);
                if (!Number.isInteger(index)) {
                    break;
                }
                const nodes = this.graph.nodes;
                await this.withProgress(async () => {
                    const loaded = await this.model.focusTrail(index, nodes);
                    this.applyGraph(loaded?.graph, loaded?.seq ?? -1);
                });
                break;
            }
            case 'expandMore': {
                await this.withProgress(async () => {
                    const loaded = await this.model.expandMore(String(message.nodeId || ''));
                    this.applyGraph(loaded?.graph, loaded?.seq ?? -1);
                });
                break;
            }
            case 'expandHop': {
                const nodes = this.graph.nodes;
                await this.withProgress(async () => {
                    const loaded = await this.model.expandHop(String(message.nodeId || ''), nodes);
                    this.applyGraph(loaded?.graph, loaded?.seq ?? -1);
                });
                break;
            }
            case 'collapseHop':
                this.graph = this.model.collapseHop(String(message.nodeId || ''), this.graph.nodes);
                this.postGraph();
                break;
            case 'expandAll':
                await this.withProgress(async () => {
                    const loaded = await this.model.expandAll();
                    this.applyGraph(loaded?.graph, loaded?.seq ?? -1);
                });
                break;
            case 'collapseAll':
                this.graph = this.model.collapseAll();
                this.postGraph();
                break;
            case 'toggleGroup': {
                const nodes = this.graph.nodes;
                await this.withProgress(async () => {
                    const loaded = await this.model.toggleGroup(String(message.nodeId || ''), nodes);
                    this.applyGraph(loaded?.graph, loaded?.seq ?? -1);
                });
                break;
            }
            case 'openCallSite': {
                const fromId = String(message.fromId || '');
                const toId = String(message.toId || '');
                const index = message.index | 0;
                const edge = this.graph.edges.find(e => e.from === fromId && e.to === toId);
                const site = edge?.sites?.[Math.max(0, Math.min(index, (edge.sites?.length || 1) - 1))];
                if (site) {
                    const range = await callSiteIdentRange(site);
                    await vscode.commands.executeCommand(
                        'vscode-context-window.navigateUri',
                        site.uri,
                        range,
                        site.name,
                        false
                    );
                }
                break;
            }
            default:
                break;
        }
    }

    private async withProgress<T>(operation: () => Promise<T>): Promise<T> {
        if (this.progressDepth === 0) {
            this.panel?.webview.postMessage({ type: 'beginProgress' });
        }
        this.progressDepth++;
        try {
            return await operation();
        } finally {
            this.progressDepth--;
            if (this.progressDepth === 0) {
                this.panel?.webview.postMessage({ type: 'endProgress' });
            }
        }
    }

    private async reloadFromEditor(editor: vscode.TextEditor | undefined): Promise<void> {
        if (!this.panel) {
            return;
        }
        if (!editor || editor.document.uri.scheme !== 'file') {
            if (this.updateMode === 'sticky' && this.graph.rootId) {
                return;
            }
            this.graph = {
                rootId: '',
                title: '',
                nodes: [],
                edges: [],
                empty: 'Open a source file and place the cursor on a function.'
            };
            this.postGraph();
            return;
        }
        await this.withProgress(async () => {
            const loaded = await this.model.loadRoot(editor.document.uri, editor.selection.active);
            this.applyGraph(loaded?.graph, loaded?.seq ?? -1);
        });
    }

    private applyGraph(graph: RelationGraph | undefined, seq: number): void {
        if (!this.panel || graph === undefined || !this.model.isCurrent(seq)) {
            return;
        }
        if (this.updateMode === 'sticky' && !graph.rootId && this.graph.rootId) {
            return;
        }
        this.graph = graph;
        this.panel.title = graph.title ? `Call Relation — ${graph.title}` : 'Call Relation';
        this.postGraph();
    }

    private postGraph(): void {
        this.panel?.webview.postMessage({ type: 'graph', graph: this.graph });
        this.postState();
    }

    private normalizeEdgeStyle(value: unknown): 'elbow' | 'direct' | 'arc' {
        return value === 'direct' || value === 'elbow' ? value : 'arc';
    }

    private readEdgeStyle(): 'elbow' | 'direct' | 'arc' {
        return this.normalizeEdgeStyle(
            vscode.workspace.getConfiguration('contextView.callRelation').get<string>('edgeStyle')
        );
    }

    private readUpdateMode(): 'live' | 'sticky' {
        return vscode.workspace.getConfiguration('contextView.callRelation').get<string>('updateMode') === 'sticky'
            ? 'sticky'
            : 'live';
    }

    private readCompactFilter(): boolean {
        return vscode.workspace.getConfiguration('contextView.callRelation').get<boolean>('compactFilter') === true;
    }

    private applyCompactFilter(on: boolean): void {
        this.compactFilter = on;
        this.model.setCompactFilter(on);
        this.refreshCompactGraph();
    }

    private readCompactKinds(): string[] {
        return parseSlimKindIds(
            vscode.workspace.getConfiguration('contextView.callRelation').get('compactKinds')
        );
    }

    private applyCompactKinds(ids: string[]): void {
        this.compactKinds = ids;
        this.model.setCompactKinds(ids);
        this.refreshCompactGraph();
    }

    private refreshCompactGraph(): void {
        if (this.graph.rootId) {
            this.graph = this.model.buildGraph();
            this.postGraph();
            return;
        }
        this.postState();
    }

    private readHoverDelay(): number {
        const n = vscode.workspace.getConfiguration('workbench').get<number>('hover.delay');
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
            return n;
        }
        return process.platform === 'darwin' ? 1500 : 500;
    }

    private postState(): void {
        this.panel?.webview.postMessage({
            type: 'state',
            pinned: this.pinned,
            edgeStyle: this.edgeStyle,
            updateMode: this.updateMode,
            compactFilter: this.compactFilter,
            compactKinds: this.compactKinds,
            hoverDelay: this.readHoverDelay()
        });
    }

    private html(webview: vscode.Webview): string {
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'callRelation.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'callRelation.css'));
        const n = nonce();
        const icon = (d: string) =>
            `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
        const iconCase = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path fill-rule="evenodd" d="M4.02602 3.34176C4.16218 2.93404 4.83818 2.93398 4.97426 3.34176L6.97426 9.34274C6.97526 9.34674 6.97817 9.35544 6.97817 9.35544L7.97426 12.3427C8.06126 12.6047 7.91984 12.8875 7.65786 12.9756C7.60486 12.9926 7.55165 13.0009 7.49965 13.0009C7.29082 13.0008 7.09602 12.868 7.02602 12.6591L6.14028 10.0009H2.86L1.97426 12.6591C1.88728 12.919 1.60634 13.0634 1.34243 12.9746C1.08043 12.8866 0.93902 12.6038 1.02602 12.3418L2.02211 9.35544C2.02311 9.35144 2.02602 9.34274 2.02602 9.34274L4.02602 3.34176ZM3.19399 8.99997H5.80629L4.49965 5.08102L3.19399 8.99997Z"/><path fill-rule="evenodd" d="M11.8581 6.66794C13.165 6.73296 13.9427 7.48427 13.9967 8.69626L13.9997 8.83297V12.5078C13.9957 12.7568 13.809 12.9621 13.568 12.9951L13.4997 13C13.2469 12.9998 13.0376 12.8121 13.0045 12.5683L12.9997 12.5V12.4297C12.3407 12.8066 11.7316 13 11.1666 13C9.94081 12.9998 8.99965 12.1369 8.99965 10.833C8.99967 9.68299 9.79211 8.82889 11.1061 8.66989C11.7279 8.59493 12.3589 8.64164 12.9987 8.80954C12.9915 8.07194 12.6279 7.70704 11.8082 7.66598C11.1672 7.63398 10.7158 7.72415 10.4518 7.90915C10.2258 8.06799 9.91347 8.01301 9.75551 7.78708C9.59671 7.56115 9.65178 7.24878 9.87758 7.09079C10.3165 6.78283 10.9138 6.64715 11.6666 6.6611L11.8581 6.66794ZM12.7965 9.8154C12.2587 9.66749 11.7361 9.62551 11.2262 9.68747C10.4042 9.78747 9.99868 10.2244 9.99868 10.8574C9.99884 11.5881 10.474 12.0242 11.1657 12.0244C11.6196 12.0244 12.1777 11.8137 12.8336 11.3818L12.9987 11.2695V9.87594L12.7965 9.8154Z"/></svg>`;
        const iconWord = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M15.5 12.5C15.776 12.5 16 12.724 16 13V13.5C16 14.327 15.327 15 14.5 15H1.5C0.673 15 0 14.327 0 13.5V13C0 12.724 0.224 12.5 0.5 12.5C0.776 12.5 1 12.724 1 13V13.5C1 13.775 1.224 14 1.5 14H14.5C14.776 14 15 13.775 15 13.5V13C15 12.724 15.224 12.5 15.5 12.5Z"/><path fill-rule="evenodd" d="M4.8584 5.6709C6.16516 5.73603 6.94308 6.48734 6.99707 7.69922L7 7.83594V11.5107C6.996 11.7596 6.80919 11.9649 6.56836 11.998L6.5 12.0029C6.24709 12.0029 6.038 11.8152 6.00488 11.5713L6 11.5029V11.4326C5.341 11.8096 4.73199 12.0029 4.16699 12.0029C2.941 12.0029 2 11.1399 2 9.83594C2.00003 8.68597 2.79247 7.83185 4.10645 7.67285C4.7283 7.59793 5.35918 7.64552 5.99902 7.81348C5.99202 7.07548 5.62762 6.70995 4.80762 6.66895C4.16686 6.637 3.7161 6.72717 3.45215 6.91211C3.22615 7.07111 2.91386 7.01604 2.75586 6.79004C2.5969 6.56404 2.65194 6.25174 2.87793 6.09375C3.31692 5.78579 3.91404 5.65006 4.66699 5.66406L4.8584 5.6709ZM5.79688 8.81836C5.25888 8.67037 4.73558 8.62843 4.22559 8.69043C3.40389 8.79054 2.99902 9.22747 2.99902 9.86035C2.99917 10.5911 3.47413 11.0273 4.16602 11.0273C4.62001 11.0273 5.17799 10.8168 5.83398 10.3848L5.99902 10.2725V8.87891L5.79688 8.81836Z"/><path fill-rule="evenodd" d="M9.55078 2.00586C9.78578 2.02986 9.97307 2.21715 9.99707 2.45215C10 2.46907 10 2.48601 10 2.50293V6.60254C10.418 6.22566 10.9371 6.00293 11.5 6.00293C12.881 6.00293 14 7.34596 14 9.00293C14 10.6599 12.881 12.0029 11.5 12.0029C10.9371 12.0029 10.418 11.7802 10 11.4033V11.5029C10 11.7619 9.80278 11.974 9.55078 12C9.53385 12.003 9.51693 12.0029 9.5 12.0029C9.224 12.0029 9 11.7789 9 11.5029V2.50293C9 2.486 9.00095 2.46907 9.00293 2.45215C9.02793 2.20015 9.241 2.00293 9.5 2.00293C9.51692 2.00293 9.53386 2.00388 9.55078 2.00586ZM11.4355 7.00391C11.0307 7.03208 10.5769 7.31545 10.29 7.82227C10.1232 8.12611 10.018 8.49479 10.002 8.89453C9.99995 8.92952 10 8.96597 10 9.00195C10 9.03795 10.001 9.07438 10.002 9.10938C10.018 9.50814 10.1222 9.87582 10.2891 10.1797C10.576 10.6875 11.0307 10.9728 11.4355 11C11.4565 11.002 11.478 11.002 11.5 11.002C11.522 11.002 11.5435 11.001 11.5645 11C11.9693 10.9728 12.424 10.6875 12.7109 10.1797C12.8778 9.87582 12.982 9.50814 12.998 9.10938C13 9.07438 13 9.03795 13 9.00195C13 8.96597 12.999 8.92952 12.998 8.89453C12.982 8.49479 12.8768 8.12611 12.71 7.82227C12.4231 7.31545 11.9693 7.03109 11.5645 7.00391C11.5435 7.00191 11.522 7.00195 11.5 7.00195C11.478 7.00195 11.4565 7.00291 11.4355 7.00391Z"/></svg>`;
        const iconUp = icon('M13.854 7.146 8.854 2.146c-.195-.195-.512-.195-.707 0L3.146 7.146c-.195.195-.195.512 0 .707.195.195.512.195.707 0L8 3.707V13.5c0 .276.224.5.5.5s.5-.224.5-.5V3.707l4.146 4.146c.098.098.226.146.354.146s.256-.049.353-.146c.195-.195.195-.512 0-.707z');
        const iconDown = icon('M13.854 8.146c-.195-.195-.512-.195-.707 0L9 12.292V2.5c0-.276-.224-.5-.5-.5s-.5.224-.5.5v9.793L3.855 8.147c-.195-.195-.512-.195-.707 0s-.195.512 0 .707l5 5c.098.098.226.146.354.146s.256-.049.354-.146l5-5c.195-.195.195-.512 0-.707z');
        const iconClose = icon('M13.85 13.15c.2.2.2.51 0 .71-.1.1-.23.15-.35.15s-.26-.05-.35-.15L8 8.71l-5.15 5.15c-.1.1-.23.15-.35.15s-.26-.05-.35-.15c-.2-.2-.2-.51 0-.71L7.3 8 2.15 2.85c-.2-.2-.2-.51 0-.71.2-.2.51-.2.71 0L8 7.29l5.15-5.15c.2-.2.51-.2.71 0 .2.2.2.51 0 .71L8.71 8l5.14 5.15z');
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; img-src data: ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>Call Relation</title>
</head>
<body>
  <header class="cr-bar">
    <div class="cr-title" id="cr-title">Call Relation</div>
    <div class="cr-actions">
      <div class="cr-style-wrap" id="cr-style-wrap">
        <button type="button" id="cr-style" class="cr-btn" title="Connector style">Arc</button>
      </div>
      <div class="cr-zoom-chip" id="cr-zoom-chip">
        <button type="button" id="cr-zoom-out" class="cr-btn" title="Zoom out (Ctrl+scroll)">−</button>
        <button type="button" id="cr-zoom-label" class="cr-btn cr-zoom-label" title="Reset zoom to 100%">100%</button>
        <button type="button" id="cr-zoom-in" class="cr-btn" title="Zoom in (Ctrl+scroll)">+</button>
      </div>
      <div class="cr-modes">
        <button type="button" id="cr-update" class="cr-btn" title="Update mode: Live — empty graph when no call hierarchy">Live</button>
        <div class="cr-slim-wrap" id="cr-slim-wrap">
          <button type="button" id="cr-slim" class="cr-btn" title="Slim filter off — show every symbol the language server returns" aria-pressed="false">Slim</button>
          <button type="button" id="cr-slim-kinds" class="cr-btn cr-slim-caret" title="Kinds kept when Slim is on" aria-haspopup="true" aria-expanded="false"></button>
        </div>
        <button type="button" id="cr-pin" class="cr-btn" title="Pin the current graph so cursor moves do not refresh it">Pin</button>
        <button type="button" id="cr-help" class="cr-btn cr-icon-btn" title="Show help" aria-expanded="false" aria-label="Show help"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0m-6 3.5a1 1 0 1 1-2 0a1 1 0 0 1 2 0M7.293 5.293a1 1 0 1 1 .99 1.667c-.459.134-1.033.566-1.033 1.29v.25a.75.75 0 1 0 1.5 0v-.115a2.5 2.5 0 1 0-2.518-4.153a.75.75 0 1 0 1.061 1.06"/></svg></button>
      </div>
    </div>
  </header>
  <div class="cr-centers" id="cr-centers" hidden></div>
  <div class="cr-hint" id="cr-hint" hidden>
    <p>Click a node to select it and open its definition. Double-click to make it the center. Alt+click a non-center node to pin the path from the center to that node (and its direct children); Alt+click again or Alt+click empty space to unpin. The top trail is the center stack — click any hop to return. Right-click the canvas to expand or collapse all nodes; right-click the trail to copy the call chain.</p>
    <p>Keys: arrows move focus (↑↓ siblings, ←→ parent/child; outward expands if needed), Enter opens, Shift+Enter expands/collapses, Backspace steps back on the center trail.</p>
    <p>Esc: with Find open closes Find only; otherwise dismisses menu, pin, then selection. Find uses the editor Find shortcut.</p>
    <p>Filled = current center, thick link border = previous center, ring = selected, orange pin badge = pinned path, purple ↻ = same symbol again on this path, teal ×N = the same function on other call paths (click to jump). Hover a node to highlight its other copies; the highlight clears when the pointer leaves. Dashed nodes are library groups. Click a link for that call site; a number on the arrow is how many sites. + / − expand or collapse. Slim keeps the kinds checked in the list beside Slim. Pick Elbow / Direct / Arc from the style list. Drag empty space to pan. − / + or Ctrl+scroll to zoom.</p>
  </div>
  <div class="cr-main">
    <div class="cr-find" id="cr-find">
      <div class="cr-find-field">
        <input type="text" id="cr-find-input" placeholder="Find" spellcheck="false" autocomplete="off" aria-label="Find">
        <button type="button" class="cr-find-opt" id="cr-find-case" title="Match Case (Alt+C)" aria-pressed="false">${iconCase}</button>
        <button type="button" class="cr-find-opt" id="cr-find-word" title="Match Whole Word (Alt+W)" aria-pressed="false">${iconWord}</button>
      </div>
      <span class="cr-find-count" id="cr-find-count"></span>
      <button type="button" class="cr-find-action" id="cr-find-prev" title="Previous Match (Shift+Enter)">${iconUp}</button>
      <button type="button" class="cr-find-action" id="cr-find-next" title="Next Match (Enter)">${iconDown}</button>
      <button type="button" class="cr-find-action" id="cr-find-close" title="Close (Escape)">${iconClose}</button>
    </div>
    <div class="cr-stage" id="cr-stage">
      <div class="cr-empty" id="cr-empty">Place the cursor on a function, then open Call Relation.</div>
    </div>
  </div>
  <div class="progress-container">
    <div class="progress-bar"></div>
  </div>
  <script nonce="${n}" src="${script}"></script>
</body>
</html>`;
    }
}

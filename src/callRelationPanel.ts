import * as vscode from 'vscode';
import { callSiteIdentRange, CallRelationModel, RelationGraph } from './callRelation';

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
    private followTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly extensionUri: vscode.Uri) {
        this.edgeStyle = this.readEdgeStyle();
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (!e.affectsConfiguration('contextView.callRelation.edgeStyle')) {
                    return;
                }
                this.edgeStyle = this.readEdgeStyle();
                this.postState();
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
        if (!this.panel && this.isVisualStudioCode()) {
            try {
                await vscode.commands.executeCommand('workbench.action.newEmptyEditorWindow');
                this.ensurePanel(vscode.ViewColumn.Active);
                await this.lockIfPanelActive();
                await this.reloadFromEditor(editor);
                return;
            } catch {
                // Fall through to the move-out path.
            }
        }
        const panel = this.ensurePanel(vscode.ViewColumn.Beside);
        panel.reveal(undefined, false);
        try {
            await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
        } catch {
            // Older VS Code / Cursor builds may not have auxiliary windows.
        }
        await this.lockIfPanelActive();
        await this.reloadFromEditor(editor);
    }

    private isVisualStudioCode(): boolean {
        return /^visual studio code/i.test(vscode.env.appName || '');
    }

    private async lockIfPanelActive(): Promise<void> {
        if (!this.panel) {
            return;
        }
        this.panel.reveal(undefined, false);
        if (!this.panel.active) {
            await new Promise<void>(resolve => {
                if (!this.panel) {
                    resolve();
                    return;
                }
                const sub = this.panel.onDidChangeViewState(() => {
                    if (this.panel?.active) {
                        sub.dispose();
                        resolve();
                    }
                });
                setTimeout(() => {
                    sub.dispose();
                    resolve();
                }, 400);
            });
        }
        if (!this.panel?.active) {
            return;
        }
        try {
            await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
        } catch {
            // Older builds may not have editor-group lock.
        }
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
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
            }
        );
        const iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
        this.panel.iconPath = { light: iconPath, dark: iconPath };
        this.panel.webview.html = this.html(this.panel.webview);
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.model.reset();
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
            case 'ready':
                this.postGraph();
                break;
            case 'setPinned':
                this.pinned = !!message.value;
                this.postState();
                break;
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
                    this.graph = await this.model.focusNode(nodeId, this.graph.nodes);
                    this.postGraph();
                }
                break;
            }
            case 'expandMore':
                this.graph = await this.model.expandMore(String(message.nodeId || ''));
                this.postGraph();
                break;
            case 'expandHop':
                this.graph = await this.model.expandHop(String(message.nodeId || ''), this.graph.nodes);
                this.postGraph();
                break;
            case 'collapseHop':
                this.graph = this.model.collapseHop(String(message.nodeId || ''), this.graph.nodes);
                this.postGraph();
                break;
            case 'toggleGroup':
                this.graph = await this.model.toggleGroup(String(message.nodeId || ''), this.graph.nodes);
                this.postGraph();
                break;
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

    private async reloadFromEditor(editor: vscode.TextEditor | undefined): Promise<void> {
        if (!this.panel) {
            return;
        }
        if (!editor || editor.document.uri.scheme !== 'file') {
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
        this.panel.webview.postMessage({ type: 'loading', value: true });
        this.graph = await this.model.loadRoot(editor.document.uri, editor.selection.active);
        if (this.graph.title) {
            this.panel.title = `Call Relation — ${this.graph.title}`;
        } else {
            this.panel.title = 'Call Relation';
        }
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

    private postState(): void {
        this.panel?.webview.postMessage({
            type: 'state',
            pinned: this.pinned,
            edgeStyle: this.edgeStyle
        });
    }

    private html(webview: vscode.Webview): string {
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'callRelation.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'callRelation.css'));
        const n = nonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>Call Relation</title>
</head>
<body>
  <header class="cr-bar">
    <div class="cr-title" id="cr-title">Call Relation</div>
    <div class="cr-actions">
      <div class="cr-style-wrap" id="cr-style-wrap">
        <button type="button" id="cr-style" class="cr-btn is-on" title="Connector style">Arc</button>
      </div>
      <button type="button" id="cr-zoom-out" class="cr-btn" title="Zoom out (Ctrl+scroll)">−</button>
      <button type="button" id="cr-zoom-label" class="cr-btn cr-zoom-label" title="Reset zoom to 100%">100%</button>
      <button type="button" id="cr-zoom-in" class="cr-btn" title="Zoom in (Ctrl+scroll)">+</button>
      <button type="button" id="cr-pin" class="cr-btn" title="Pin the current graph so cursor moves do not refresh it">Pin</button>
    </div>
  </header>
  <div class="cr-hint">Click a node to select it and open its definition. Double-click to make it the center. Filled = current center, thick link border = previous center, ring = selected. Dashed nodes are library groups. Click a link for that call site. + / − expand or collapse. Pick Elbow / Direct / Arc from the style list. Drag empty space to pan. − / + or Ctrl+scroll to zoom.</div>
  <div class="cr-stage" id="cr-stage">
    <div class="cr-empty" id="cr-empty">Place the cursor on a function, then open Call Relation.</div>
  </div>
  <script nonce="${n}" src="${script}"></script>
</body>
</html>`;
    }
}

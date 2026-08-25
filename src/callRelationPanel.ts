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
    private followTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly extensionUri: vscode.Uri) {
        this.disposables.push(
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
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside);
            void this.reloadFromEditor(vscode.window.activeTextEditor);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            CALL_RELATION_VIEW_TYPE,
            'Call Relation',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
            }
        );
        this.panel.webview.html = this.html(this.panel.webview);
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.model.reset();
        });
        this.panel.webview.onDidReceiveMessage(message => {
            void this.onMessage(message);
        });
        void this.reloadFromEditor(vscode.window.activeTextEditor);
    }

    private async onMessage(message: any): Promise<void> {
        if (!this.panel) {
            return;
        }
        switch (message?.type) {
            case 'ready':
                this.postGraph();
                break;
            case 'refresh':
                await this.reloadFromEditor(vscode.window.activeTextEditor);
                break;
            case 'setPinned':
                this.pinned = !!message.value;
                this.postState();
                break;
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
                empty: 'Open a source file and place the cursor on a function, then refresh.'
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

    private postState(): void {
        this.panel?.webview.postMessage({ type: 'state', pinned: this.pinned });
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
      <button type="button" id="cr-pin" class="cr-btn" title="Pin the current graph so cursor moves do not refresh it">Pin</button>
      <button type="button" id="cr-refresh" class="cr-btn" title="Reload from the current editor cursor">Refresh</button>
    </div>
  </header>
  <div class="cr-hint">Click a node to select it and open its definition. Double-click to make it the center. Filled = current center, dashed = previous center, ring = selected. Click a link for that call site. + / − expand or collapse. Drag empty space to pan.</div>
  <div class="cr-stage" id="cr-stage">
    <div class="cr-empty" id="cr-empty">Place the cursor on a function, then open Call Relation.</div>
  </div>
  <script nonce="${n}" src="${script}"></script>
</body>
</html>`;
    }
}

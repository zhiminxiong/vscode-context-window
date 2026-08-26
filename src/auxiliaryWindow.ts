import * as vscode from 'vscode';

export function isVisualStudioCode(): boolean {
    return /^visual studio code/i.test(vscode.env.appName || '');
}

export async function lockIfPanelActive(panel: vscode.WebviewPanel | undefined): Promise<void> {
    if (!panel) {
        return;
    }
    panel.reveal(undefined, false);
    if (!panel.active) {
        await new Promise<void>(resolve => {
            const sub = panel.onDidChangeViewState(() => {
                if (panel.active) {
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
    if (!panel.active) {
        return;
    }
    try {
        await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
    } catch {
        // Older builds may not have editor-group lock.
    }
}

/**
 * createWebviewPanel cannot target an auxiliary window.
 * VS Code: open an empty floating window, then create in the active column.
 * Cursor / other forks: create beside, then move the tab out.
 */
export async function showPanelInNewWindow(
    panel: vscode.WebviewPanel | undefined,
    create: (column: vscode.ViewColumn) => vscode.WebviewPanel
): Promise<vscode.WebviewPanel> {
    if (!panel && isVisualStudioCode()) {
        try {
            await vscode.commands.executeCommand('workbench.action.newEmptyEditorWindow');
            const created = create(vscode.ViewColumn.Active);
            await lockIfPanelActive(created);
            return created;
        } catch {
            // Fall through to the move-out path.
        }
    }
    const existing = panel ?? create(vscode.ViewColumn.Beside);
    existing.reveal(undefined, false);
    try {
        await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    } catch {
        // Older VS Code / Cursor builds may not have auxiliary windows.
    }
    await lockIfPanelActive(existing);
    return existing;
}

import * as vscode from 'vscode';

/** Cursor is the only host known to need the move-out path. */
export function isCursor(): boolean {
    return /cursor/i.test(vscode.env.appName || '') || vscode.env.uriScheme === 'cursor';
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForPanelActive(panel: vscode.WebviewPanel, timeoutMs: number): Promise<boolean> {
    if (panel.active) {
        return Promise.resolve(true);
    }
    return new Promise(resolve => {
        const done = (ok: boolean) => {
            sub.dispose();
            clearTimeout(timer);
            resolve(ok);
        };
        const sub = panel.onDidChangeViewState(() => {
            if (panel.active) {
                done(true);
            }
        });
        const timer = setTimeout(() => done(panel.active), timeoutMs);
    });
}

function isActiveGroupLocked(): boolean {
    const groups = (vscode.window as unknown as {
        tabGroups?: { activeTabGroup?: { isLocked: boolean } };
    }).tabGroups;
    return !!groups?.activeTabGroup?.isLocked;
}

async function lockActiveGroupIfUnlocked(): Promise<void> {
    if (isActiveGroupLocked()) {
        return;
    }
    try {
        await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
    } catch {
        // Older builds may not have editor-group lock.
    }
}

async function enableWindowAlwaysOnTop(): Promise<void> {
    if (!vscode.workspace.getConfiguration('contextView').get<boolean>('independentWindowAlwaysOnTop', false)) {
        return;
    }
    try {
        await vscode.commands.executeCommand('workbench.action.enableWindowAlwaysOnTop');
    } catch {
        // Older builds or not an auxiliary window.
    }
}

export async function lockIfPanelActive(panel: vscode.WebviewPanel | undefined): Promise<void> {
    if (!panel) {
        return;
    }
    // reveal() after a move can steal focus back to the main window on Cursor.
    if (!panel.active) {
        panel.reveal(undefined, false);
        await waitForPanelActive(panel, isCursor() ? 1000 : 400);
    }
    if (!panel.active) {
        return;
    }
    await lockActiveGroupIfUnlocked();
}

const detachedPanels = new WeakSet<vscode.WebviewPanel>();

async function focusDetachedPanel(panel: vscode.WebviewPanel): Promise<vscode.WebviewPanel> {
    panel.reveal(undefined, false);
    await waitForPanelActive(panel, isCursor() ? 1000 : 400);
    await lockIfPanelActive(panel);
    await enableWindowAlwaysOnTop();
    return panel;
}

/**
 * createWebviewPanel cannot target an auxiliary window.
 * Cursor: create beside, then move the tab out.
 * Everything else: open an empty floating window, then create in the active column.
 * If the panel is already in an auxiliary window, only bring it to front.
 */
export async function showPanelInNewWindow(
    panel: vscode.WebviewPanel | undefined,
    create: (column: vscode.ViewColumn) => vscode.WebviewPanel
): Promise<vscode.WebviewPanel> {
    if (panel && detachedPanels.has(panel)) {
        return focusDetachedPanel(panel);
    }
    if (!panel && !isCursor()) {
        try {
            await vscode.commands.executeCommand('workbench.action.newEmptyEditorWindow');
            const created = create(vscode.ViewColumn.Active);
            detachedPanels.add(created);
            await lockIfPanelActive(created);
            await enableWindowAlwaysOnTop();
            return created;
        } catch {
            // Fall through to the move-out path.
        }
    }
    const existing = panel ?? create(vscode.ViewColumn.Beside);
    existing.reveal(undefined, false);
    const columnBefore = existing.viewColumn;
    try {
        await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    } catch {
        // Older VS Code / Cursor builds may not have auxiliary windows.
    }
    detachedPanels.add(existing);
    if (isCursor()) {
        if (existing.viewColumn === columnBefore) {
            await delay(300);
        }
        // Lock the new window while it still has focus. Calling reveal() first
        // can send focus back to the main window on Cursor.
        if (existing.active) {
            await lockActiveGroupIfUnlocked();
            await enableWindowAlwaysOnTop();
            return existing;
        }
        existing.reveal(undefined, false);
        await waitForPanelActive(existing, 1000);
        if (existing.active) {
            await lockActiveGroupIfUnlocked();
            await enableWindowAlwaysOnTop();
            return existing;
        }
    }
    await lockIfPanelActive(existing);
    await enableWindowAlwaysOnTop();
    return existing;
}

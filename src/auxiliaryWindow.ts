import * as vscode from 'vscode';

const NEW_EMPTY_EDITOR_WINDOW = 'workbench.action.newEmptyEditorWindow';
const MOVE_EDITOR_TO_NEW_WINDOW = 'workbench.action.moveEditorToNewWindow';
const LOCK_EDITOR_GROUP = 'workbench.action.lockEditorGroup';
const ENABLE_ALWAYS_ON_TOP = 'workbench.action.enableWindowAlwaysOnTop';

const NEW_GROUP_TIMEOUT_MS = 1000;
const PANEL_ACTIVE_TIMEOUT_MS = 1000;

function tabGroups(): typeof vscode.window.tabGroups | undefined {
    return (vscode.window as Partial<typeof vscode.window>).tabGroups;
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

/** Tab inputs report the host-prefixed view type (mainThreadWebview-<viewType>). */
function tabHoldsPanel(tab: vscode.Tab, viewType: string): boolean {
    const input = tab.input as { viewType?: unknown } | undefined;
    return typeof input?.viewType === 'string' && input.viewType.includes(viewType);
}

function groupOf(panel: vscode.WebviewPanel): vscode.TabGroup | undefined {
    return tabGroups()?.all.find(g => g.tabs.some(tab => tabHoldsPanel(tab, panel.viewType)));
}

function freshEmptyGroup(before: ReadonlySet<vscode.ViewColumn>): vscode.TabGroup | undefined {
    return tabGroups()?.all.find(g => g.tabs.length === 0 && !before.has(g.viewColumn));
}

function waitForFreshEmptyGroup(
    before: ReadonlySet<vscode.ViewColumn>,
    timeoutMs: number
): Promise<vscode.TabGroup | undefined> {
    const groups = tabGroups();
    if (!groups) {
        return Promise.resolve(undefined);
    }
    return new Promise(resolve => {
        const done = (group: vscode.TabGroup | undefined) => {
            sub.dispose();
            clearTimeout(timer);
            resolve(group);
        };
        const sub = groups.onDidChangeTabGroups(() => {
            const found = freshEmptyGroup(before);
            if (found) {
                done(found);
            }
        });
        const timer = setTimeout(() => done(freshEmptyGroup(before)), timeoutMs);
    });
}

/**
 * Opens an empty auxiliary window and returns its column.
 *
 * Auxiliary editor parts are appended after the main part, so a real new window
 * shows up as an extra column holding no tabs, and the columns already in use
 * keep their numbers. Returning undefined means the host did not open anything,
 * so there is never a blank window left behind.
 */
async function openEmptyWindowColumn(): Promise<vscode.ViewColumn | undefined> {
    const groups = tabGroups();
    if (!groups) {
        return undefined;
    }
    const before = new Set(groups.all.map(g => g.viewColumn));
    try {
        await vscode.commands.executeCommand(NEW_EMPTY_EDITOR_WINDOW);
    } catch {
        return undefined;
    }
    const found = freshEmptyGroup(before) ?? await waitForFreshEmptyGroup(before, NEW_GROUP_TIMEOUT_MS);
    return found?.viewColumn;
}

async function lockActiveGroup(): Promise<void> {
    try {
        await vscode.commands.executeCommand(LOCK_EDITOR_GROUP);
    } catch {
        // Older builds may not have editor-group lock.
    }
}

async function enableAlwaysOnTop(): Promise<void> {
    if (!vscode.workspace.getConfiguration('contextView').get<boolean>('independentWindowAlwaysOnTop', false)) {
        return;
    }
    try {
        await vscode.commands.executeCommand(ENABLE_ALWAYS_ON_TOP);
    } catch {
        // Older builds or not an auxiliary window.
    }
}

/**
 * Locks the editor group holding the panel.
 *
 * Both the lock and the always-on-top commands act on the focused group/window,
 * so they must never run while the panel is somewhere else — that would lock the
 * main editor or pin the main window instead.
 */
export async function lockPanelGroupIfFocused(panel: vscode.WebviewPanel | undefined): Promise<void> {
    if (!panel) {
        return;
    }
    if (!panel.active) {
        panel.reveal(groupOf(panel)?.viewColumn, false);
        await waitForPanelActive(panel, PANEL_ACTIVE_TIMEOUT_MS);
    }
    if (!panel.active) {
        return;
    }
    await lockActiveGroup();
}

/** Panels we saw land in a window of their own. */
const floatingPanels = new WeakSet<vscode.WebviewPanel>();

async function settleFloating(panel: vscode.WebviewPanel): Promise<vscode.WebviewPanel> {
    floatingPanels.add(panel);
    await waitForPanelActive(panel, PANEL_ACTIVE_TIMEOUT_MS);
    if (!panel.active) {
        return panel;
    }
    await lockActiveGroup();
    await enableAlwaysOnTop();
    return panel;
}

/**
 * Shows the panel in a window of its own.
 *
 * createWebviewPanel cannot name an auxiliary window, but floating windows are
 * plain editor groups whose columns continue past the main window. So: open the
 * empty window first, then create (or reveal) into that exact column. Passing a
 * column instead of ViewColumn.Active removes the focus race, and the panel
 * never appears in the main tab group on its way out.
 *
 * Only when no window was opened at all do we fall back to detaching the tab,
 * which does flash in the main group first.
 */
export async function showPanelInNewWindow(
    panel: vscode.WebviewPanel | undefined,
    create: (column: vscode.ViewColumn) => vscode.WebviewPanel
): Promise<vscode.WebviewPanel> {
    if (panel && floatingPanels.has(panel)) {
        panel.reveal(groupOf(panel)?.viewColumn, false);
        await waitForPanelActive(panel, PANEL_ACTIVE_TIMEOUT_MS);
        if (panel.active) {
            await enableAlwaysOnTop();
        }
        return panel;
    }

    const column = await openEmptyWindowColumn();
    if (column !== undefined) {
        if (!panel) {
            return settleFloating(create(column));
        }
        // reveal() moves a webview into the target column.
        panel.reveal(column, false);
        return settleFloating(panel);
    }

    const existing = panel ?? create(vscode.ViewColumn.Beside);
    existing.reveal(undefined, false);
    await waitForPanelActive(existing, PANEL_ACTIVE_TIMEOUT_MS);
    if (!existing.active) {
        // Moving now would detach whatever editor does have focus.
        return existing;
    }
    try {
        await vscode.commands.executeCommand(MOVE_EDITOR_TO_NEW_WINDOW);
    } catch {
        return existing;
    }
    return settleFloating(existing);
}

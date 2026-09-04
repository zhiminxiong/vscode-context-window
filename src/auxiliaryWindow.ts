import * as vscode from 'vscode';

const NEW_EMPTY_EDITOR_WINDOW = 'workbench.action.newEmptyEditorWindow';
const MOVE_EDITOR_TO_NEW_WINDOW = 'workbench.action.moveEditorToNewWindow';
const LOCK_EDITOR_GROUP = 'workbench.action.lockEditorGroup';
const ENABLE_ALWAYS_ON_TOP = 'workbench.action.enableWindowAlwaysOnTop';

/** Webview editors are registered under this prefix plus the panel's view type. */
const WEBVIEW_EDITOR_ID_PREFIX = 'mainThreadWebview-';

/** Indexed by column, these focus a group by its position across all windows. */
const FOCUS_GROUP_COMMANDS = [
    'workbench.action.focusFirstEditorGroup',
    'workbench.action.focusSecondEditorGroup',
    'workbench.action.focusThirdEditorGroup',
    'workbench.action.focusFourthEditorGroup',
    'workbench.action.focusFifthEditorGroup',
    'workbench.action.focusSixthEditorGroup',
    'workbench.action.focusSeventhEditorGroup',
    'workbench.action.focusEighthEditorGroup'
];

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

/**
 * Focuses the group in the given column, in whichever window holds it.
 *
 * Group lock and Always on Top both act on whatever is focused, and a panel's
 * `active` flag is a value pushed to the extension host, so it can already be
 * stale — Cursor hands focus back to the main window right after a floating
 * window opens. Focusing by column right before those commands run leaves no
 * gap for focus to drift.
 */
async function focusGroup(column: vscode.ViewColumn | undefined): Promise<boolean> {
    const command = typeof column === 'number' ? FOCUS_GROUP_COMMANDS[column - 1] : undefined;
    if (!command) {
        return false;
    }
    try {
        await vscode.commands.executeCommand(command);
        return true;
    } catch {
        return false;
    }
}

async function lockActiveGroup(): Promise<void> {
    try {
        await vscode.commands.executeCommand(LOCK_EDITOR_GROUP);
    } catch {
        // Older builds may not have editor-group lock.
    }
}

/**
 * Lists the panel in `workbench.editor.autoLockGroups`, so the editor locks its
 * own group the moment it opens as the first editor there.
 *
 * The lock command works on the focused group, and on Cursor a floating window
 * never becomes the focused group as far as the workbench is concerned, so the
 * main tab group got locked instead. Auto locking happens inside the group that
 * opens the editor and never consults focus.
 */
async function ensureAutoLock(viewType: string): Promise<boolean> {
    const editorId = WEBVIEW_EDITOR_ID_PREFIX + viewType;
    const config = vscode.workspace.getConfiguration('workbench.editor');
    const current = config.inspect<Record<string, boolean>>('autoLockGroups')?.globalValue;
    if (current?.[editorId] === true) {
        return true;
    }
    try {
        await config.update(
            'autoLockGroups',
            { ...(current ?? {}), [editorId]: true },
            vscode.ConfigurationTarget.Global
        );
        return true;
    } catch {
        // Settings may be read-only; fall back to the lock command.
        return false;
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

/** Locks the editor group holding the panel, wherever that group lives. */
export async function lockPanelGroup(panel: vscode.WebviewPanel | undefined): Promise<void> {
    if (!panel) {
        return;
    }
    const column = groupOf(panel)?.viewColumn;
    if (await focusGroup(column)) {
        await lockActiveGroup();
        return;
    }
    // No column to aim at (very old host, or past the eighth group): the panel
    // holding focus is the only remaining evidence that the lock lands right.
    if (!panel.active) {
        panel.reveal(column, false);
        await waitForPanelActive(panel, PANEL_ACTIVE_TIMEOUT_MS);
    }
    if (panel.active) {
        await lockActiveGroup();
    }
}

/** Panels we saw land in a window of their own. */
const floatingPanels = new WeakSet<vscode.WebviewPanel>();

async function settleFloating(
    panel: vscode.WebviewPanel,
    autoLocked: boolean,
    column?: vscode.ViewColumn
): Promise<vscode.WebviewPanel> {
    floatingPanels.add(panel);
    await waitForPanelActive(panel, PANEL_ACTIVE_TIMEOUT_MS);
    const focused = await focusGroup(groupOf(panel)?.viewColumn ?? column);
    if (!focused && !panel.active) {
        return panel;
    }
    // The group locked itself as it opened. Running the command now would lock
    // whichever group the host believes is focused, which is the bug it fixes.
    if (!autoLocked) {
        await lockActiveGroup();
    }
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
    viewType: string,
    panel: vscode.WebviewPanel | undefined,
    create: (column: vscode.ViewColumn) => vscode.WebviewPanel
): Promise<vscode.WebviewPanel> {
    if (panel && floatingPanels.has(panel)) {
        const home = groupOf(panel)?.viewColumn;
        panel.reveal(home, false);
        await waitForPanelActive(panel, PANEL_ACTIVE_TIMEOUT_MS);
        const focused = await focusGroup(home);
        if (focused || panel.active) {
            await enableAlwaysOnTop();
        }
        return panel;
    }

    // Must be in place before the editor opens in the new group.
    const autoLocked = await ensureAutoLock(viewType);

    const column = await openEmptyWindowColumn();
    if (column !== undefined) {
        if (!panel) {
            return settleFloating(create(column), autoLocked, column);
        }
        // reveal() moves a webview into the target column.
        panel.reveal(column, false);
        return settleFloating(panel, autoLocked, column);
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
    return settleFloating(existing, autoLocked);
}

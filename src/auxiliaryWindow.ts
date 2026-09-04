import * as vscode from 'vscode';

const NEW_EMPTY_EDITOR_WINDOW = 'workbench.action.newEmptyEditorWindow';
const MOVE_EDITOR_TO_NEW_WINDOW = 'workbench.action.moveEditorToNewWindow';
const LOCK_EDITOR_GROUP = 'workbench.action.lockEditorGroup';
const ENABLE_ALWAYS_ON_TOP = 'workbench.action.enableWindowAlwaysOnTop';

/** Webview editors are registered under this prefix plus the panel's view type. */
const WEBVIEW_EDITOR_ID_PREFIX = 'mainThreadWebview-';

const NEW_GROUP_TIMEOUT_MS = 1000;
const PANEL_TARGET_TIMEOUT_MS = 1000;

function tabGroups(): typeof vscode.window.tabGroups | undefined {
    return (vscode.window as Partial<typeof vscode.window>).tabGroups;
}

/** Tab inputs report the host-prefixed view type (mainThreadWebview-<viewType>). */
function tabHoldsPanel(tab: vscode.Tab, viewType: string): boolean {
    const input = tab.input as { viewType?: unknown } | undefined;
    return typeof input?.viewType === 'string' && input.viewType.includes(viewType);
}

/**
 * Whether an editor command would act on this panel.
 *
 * Group lock and Always on Top both work on whatever the workbench considers
 * focused, so this is their precondition. It has to be observed rather than
 * arranged: focusing a group by column runs `focusNthEditorGroup`, which
 * reports success as soon as the command dispatches, and on Cursor focus does
 * not actually leave the main window, so the lock landed on the main tab group.
 * That command also splits off a brand new group when the column is past the
 * end, which is where stray empty groups came from.
 *
 * `panel.active` alone is not enough either, because it is a value pushed to
 * the extension host and Cursor leaves it stale. The tab model is pushed
 * separately, so checking both means only one of them has to have caught up.
 */
function panelIsCommandTarget(panel: vscode.WebviewPanel): boolean {
    if (panel.active) {
        return true;
    }
    const activeTab = tabGroups()?.all.find(group => group.isActive)?.activeTab;
    return !!activeTab && tabHoldsPanel(activeTab, panel.viewType);
}

function waitForCommandTarget(panel: vscode.WebviewPanel, timeoutMs: number): Promise<boolean> {
    if (panelIsCommandTarget(panel)) {
        return Promise.resolve(true);
    }
    return new Promise(resolve => {
        const subscriptions: vscode.Disposable[] = [];
        const done = (ok: boolean) => {
            clearTimeout(timer);
            for (const subscription of subscriptions) {
                subscription.dispose();
            }
            resolve(ok);
        };
        const check = () => {
            if (panelIsCommandTarget(panel)) {
                done(true);
            }
        };
        subscriptions.push(panel.onDidChangeViewState(check));
        const groups = tabGroups();
        if (groups) {
            subscriptions.push(groups.onDidChangeTabGroups(check));
            subscriptions.push(groups.onDidChangeTabs(check));
        }
        const timer = setTimeout(() => done(panelIsCommandTarget(panel)), timeoutMs);
    });
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

/** Keeps other editors from opening in the group that holds the panel. */
export async function lockPanelGroup(panel: vscode.WebviewPanel | undefined): Promise<void> {
    if (!panel) {
        return;
    }
    if (await ensureAutoLock(panel.viewType)) {
        return; // The group locks itself as the panel opens in it.
    }
    // Only reachable when the setting could not be written. Locking blind would
    // hit the main tab group, so skip it unless the panel is the target.
    if (await waitForCommandTarget(panel, PANEL_TARGET_TIMEOUT_MS)) {
        await lockActiveGroup();
    }
}

/** Panels we saw land in a window of their own. */
const floatingPanels = new WeakSet<vscode.WebviewPanel>();

async function settleFloating(
    panel: vscode.WebviewPanel,
    autoLocked: boolean
): Promise<vscode.WebviewPanel> {
    floatingPanels.add(panel);
    if (!await waitForCommandTarget(panel, PANEL_TARGET_TIMEOUT_MS)) {
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
        // Webviews are singleton editors, so revealing without a column brings
        // the window it already lives in forward instead of moving it.
        panel.reveal(undefined, false);
        if (await waitForCommandTarget(panel, PANEL_TARGET_TIMEOUT_MS)) {
            await enableAlwaysOnTop();
        }
        return panel;
    }

    // Must be in place before the editor opens in the new group.
    const autoLocked = await ensureAutoLock(viewType);

    const column = await openEmptyWindowColumn();
    if (column !== undefined) {
        if (!panel) {
            return settleFloating(create(column), autoLocked);
        }
        // reveal() moves a webview into the target column.
        panel.reveal(column, false);
        return settleFloating(panel, autoLocked);
    }

    const existing = panel ?? create(vscode.ViewColumn.Beside);
    existing.reveal(undefined, false);
    if (!await waitForCommandTarget(existing, PANEL_TARGET_TIMEOUT_MS)) {
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

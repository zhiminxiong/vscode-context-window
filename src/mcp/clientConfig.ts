import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_KEY, mergeServerEntry } from './configMerge';
import { DISCOVERY_DIR } from './endpointFile';
import { mcpLog } from './log';
import { MCP_SERVER_NAME } from './registry';

/**
 * Sets up any MCP client that is configured from a file rather than by asking
 * the extension.
 *
 * Such a file is written once and read at startup, so it cannot hold the
 * endpoint: the port and token are new every time the window starts. It points
 * at `mcpBridge.js` instead, which looks the endpoint up when it is launched.
 *
 * Nothing here is specific to one editor. The entry is an ordinary stdio
 * server entry, and the only thing that varies between clients is which file
 * it goes in and what the surrounding key is called.
 */

/**
 * The bridge is copied out of the extension because the install directory
 * carries the version number and moves on every update, which would leave the
 * config pointing at a directory that no longer exists.
 */
const INSTALLED_BRIDGE = path.join(DISCOVERY_DIR, 'mcpBridge.js');
const BRIDGE_ASSET = ['media', 'mcpBridge.js'];

/**
 * Stage and rename rather than truncate in place. Another editor may be
 * spawning the bridge at this very moment, and a half-written script fails in
 * a way nobody could reasonably diagnose.
 */
function writeAtomically(target: string, contents: string): void {
    const staged = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(staged, contents, 'utf8');
    try {
        fs.renameSync(staged, target);
    } catch {
        // Windows can refuse the rename while the target is briefly open for
        // reading. Falling back is still better than leaving it stale.
        fs.writeFileSync(target, contents, 'utf8');
        try {
            fs.unlinkSync(staged);
        } catch {
            // Nothing depends on the staged copy being gone.
        }
    }
}

/** Copies the bridge to its stable path, refreshing it after an update. */
export function installBridge(context: vscode.ExtensionContext): boolean {
    const source = path.join(context.extensionPath, ...BRIDGE_ASSET);
    try {
        const wanted = fs.readFileSync(source, 'utf8');
        let existing: string | undefined;
        try {
            existing = fs.readFileSync(INSTALLED_BRIDGE, 'utf8');
        } catch {
            existing = undefined;
        }
        if (existing !== wanted) {
            fs.mkdirSync(DISCOVERY_DIR, { recursive: true });
            writeAtomically(INSTALLED_BRIDGE, wanted);
            mcpLog(`installed the bridge at ${INSTALLED_BRIDGE}`);
        }
        return true;
    } catch (err) {
        mcpLog(`could not install the bridge: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

export interface BridgeEntry {
    type: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
}

/** The bridge's syntax will not even parse below this. */
const MIN_NODE_MAJOR = 14;
const NODE_PROBE_TIMEOUT_MS = 3000;

/**
 * Whether a plain `node` can be launched, which is what decides if the entry
 * can be written the ordinary way.
 *
 * Probed rather than assumed, because an editor started from the desktop does
 * not always inherit the PATH a terminal would. The extension host is spawned
 * by the editor and so sees the same environment the MCP server will.
 */
function usableNodeOnPath(): Promise<boolean> {
    return new Promise(resolve => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn('node', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
            resolve(false);
            return;
        }
        let settled = false;
        const finish = (value: boolean) => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };
        const timer = setTimeout(() => {
            child.kill();
            finish(false);
        }, NODE_PROBE_TIMEOUT_MS);
        let reported = '';
        if (child.stdout) {
            child.stdout.on('data', chunk => {
                reported += String(chunk);
            });
        }
        child.on('error', () => {
            clearTimeout(timer);
            finish(false);
        });
        child.on('exit', code => {
            clearTimeout(timer);
            const major = Number((/^v(\d+)/.exec(reported.trim()) || [])[1]);
            finish(code === 0 && Number.isFinite(major) && major >= MIN_NODE_MAJOR);
        });
    });
}

/**
 * `node` is preferred so the entry is the ordinary kind every MCP client
 * understands, rather than one tied to the editor that happened to write it.
 *
 * Where no usable `node` is on PATH, the editor's own binary stands in: it is
 * an Electron build, which runs as Node when asked. That always exists, but it
 * pins the entry to one editor, so it is the fallback rather than the default.
 *
 * The workspace is `${workspaceFolder}` rather than the path this window
 * happens to have open, so one entry serves every checkout and survives the
 * current one being moved. In a home-directory config there may be no such
 * variable to expand; the bridge recognises what it is handed and falls back.
 */
export async function bridgeEntry(): Promise<BridgeEntry> {
    const args = [INSTALLED_BRIDGE, '${workspaceFolder}'];
    if (await usableNodeOnPath()) {
        return { type: 'stdio', command: 'node', args };
    }
    mcpLog('no usable node on PATH; falling back to this editor\'s binary as the Node runtime');
    return {
        type: 'stdio',
        command: process.execPath,
        args,
        env: { ELECTRON_RUN_AS_NODE: '1' }
    };
}

/**
 * Where an entry can go. Clients agree on the entry itself and differ only in
 * which file holds it, and each keeps one copy per project and one in the home
 * directory that applies to all of them.
 *
 * VS Code is deliberately absent: it is handed the server directly through its
 * own API, and a file would register the same tools a second time.
 */
interface ConfigTarget {
    label: string;
    detail: string;
    /** Absent for the clipboard, which is how every other client is served. */
    file?: vscode.Uri;
    /** Ask for the path when chosen, rather than naming one up front. */
    prompt?: boolean;
}

function workspaceRoot(): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.length ? folders[0].uri : undefined;
}

/** Accepts `~`, absolute, and workspace-relative alike. */
function resolveConfigPath(given: string, root: vscode.Uri): vscode.Uri {
    const text = given.trim();
    const expanded = /^~($|[/\\])/.test(text)
        ? path.join(os.homedir(), text.slice(1))
        : text;
    return vscode.Uri.file(path.resolve(root.fsPath, expanded));
}

/**
 * Shown instead of the full path, which is long and mostly noise. Separators
 * are forward slashes so the list reads the same on every platform and matches
 * how the clients' own documentation writes these paths.
 */
function shortLabel(file: vscode.Uri, root: vscode.Uri): string {
    const full = file.fsPath;
    for (const [base, prefix] of [[root.fsPath, ''], [os.homedir(), '~/']] as const) {
        const rel = path.relative(base, full);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            return prefix + rel.split(path.sep).join('/');
        }
    }
    return full;
}

const CLIENTS = [
    { name: 'Cursor', dir: '.cursor' },
    { name: 'CodeBuddy', dir: '.codebuddy' }
];

function knownTargets(root: vscode.Uri): ConfigTarget[] {
    const app = vscode.env.appName.toLowerCase();
    const forClient = ({ name, dir }: { name: string; dir: string }): ConfigTarget[] => [
        {
            label: `${dir}/mcp.json`,
            detail: `${name} — this project only, and shared with anyone who checks it out`,
            file: vscode.Uri.joinPath(root, dir, 'mcp.json')
        },
        {
            label: `~/${dir}/mcp.json`,
            detail: `${name} — every project you open`,
            file: vscode.Uri.file(path.join(os.homedir(), dir, 'mcp.json'))
        }
    ];
    // The running editor's own files first, since those are nearly always meant.
    const clients = [...CLIENTS].sort((a, b) =>
        Number(app.includes(b.dir.slice(1))) - Number(app.includes(a.dir.slice(1))));

    const custom = vscode.workspace.getConfiguration('contextView').get<string[]>('mcp.configFiles', [])
        .filter(entry => typeof entry === 'string' && entry.trim())
        .map(entry => {
            const file = resolveConfigPath(entry, root);
            return { label: shortLabel(file, root), detail: 'from contextView.mcp.configFiles', file };
        });

    return [
        ...clients.flatMap(forClient),
        ...custom,
        { label: 'Another file…', detail: 'name any client\'s config file', prompt: true },
        { label: 'Copy the entry', detail: 'paste it into a client that has no file here' }
    ];
}

async function readIfPresent(uri: vscode.Uri): Promise<string | undefined> {
    try {
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
        return undefined;
    }
}

async function pickTarget(root: vscode.Uri, nativeProvider: boolean): Promise<ConfigTarget | undefined> {
    const targets = knownTargets(root);
    const present = await Promise.all(
        targets.map(target => target.file ? readIfPresent(target.file) : Promise.resolve(undefined))
    );
    const picked = await vscode.window.showQuickPick(
        targets.map((target, index) => ({
            label: target.label,
            description: present[index] === undefined
                ? undefined
                : present[index]!.includes(`"${MCP_SERVER_NAME}"`) ? 'already configured' : 'exists',
            detail: target.detail,
            target
        })),
        {
            title: 'Where should the MCP server entry go?',
            placeHolder: nativeProvider
                ? `${vscode.env.appName} already has these tools built in; this is for other clients`
                : `${vscode.env.appName} is running, so its own files are listed first`
        }
    );
    if (picked?.target.prompt) {
        return promptForFile(picked.target, root);
    }
    return picked?.target;
}

async function promptForFile(target: ConfigTarget, root: vscode.Uri): Promise<ConfigTarget | undefined> {
    const given = await vscode.window.showInputBox({
        title: 'Which config file?',
        prompt: 'Absolute, ~ for your home directory, or relative to the workspace',
        placeHolder: path.join('~', '.some-client', 'mcp.json'),
        validateInput: value => {
            const text = value.trim();
            if (!text) {
                return 'Give a path to a .json file.';
            }
            return text.toLowerCase().endsWith('.json')
                ? undefined
                : 'Name the file itself, ending in .json.';
        }
    });
    if (!given) {
        return undefined;
    }
    const file = resolveConfigPath(given, root);
    return { label: shortLabel(file, root), detail: target.detail, file };
}

/**
 * Adds our entry and changes nothing else. The file is the user's, and holds
 * other servers — sometimes with credentials in them — so a file we cannot
 * read is left exactly as it is rather than replaced with a working one.
 */
async function writeEntry(target: ConfigTarget, entry: BridgeEntry): Promise<boolean> {
    const file = target.file;
    if (!file) {
        return false;
    }
    const merged = mergeServerEntry(await readIfPresent(file), MCP_SERVER_NAME, entry);
    if ('unreadable' in merged) {
        mcpLog(`left ${file.fsPath} alone: ${merged.unreadable}`);
        const show = 'Open it';
        const copy = 'Copy the entry instead';
        const picked = await vscode.window.showWarningMessage(
            `${target.label} could not be read (${merged.unreadable}), so nothing was changed. Whatever is configured in it is still there.`,
            { modal: true },
            show,
            copy
        );
        if (picked === show) {
            await vscode.window.showTextDocument(file);
        } else if (picked === copy) {
            await copyEntry(entry);
        }
        return false;
    }

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file.fsPath)));
    await vscode.workspace.fs.writeFile(file, Buffer.from(merged.text, 'utf8'));
    mcpLog(`wrote ${file.fsPath}`);
    return true;
}

async function copyEntry(entry: BridgeEntry): Promise<void> {
    await vscode.env.clipboard.writeText(JSON.stringify(
        { [DEFAULT_KEY]: { [MCP_SERVER_NAME]: entry } },
        undefined,
        2
    ));
    vscode.window.showInformationMessage(
        `Copied. A few clients nest servers under "servers" rather than "${DEFAULT_KEY}".`
    );
}

async function configureClient(nativeProvider: boolean): Promise<void> {
    const root = workspaceRoot();
    if (!root) {
        vscode.window.showWarningMessage('Open a folder first: the MCP endpoint answers for a workspace.');
        return;
    }
    const target = await pickTarget(root, nativeProvider);
    if (!target) {
        return;
    }
    const entry = await bridgeEntry();

    if (!target.file) {
        await copyEntry(entry);
        return;
    }

    if (!await writeEntry(target, entry)) {
        return;
    }
    const open = 'Open it';
    const picked = await vscode.window.showInformationMessage(
        `Added "${MCP_SERVER_NAME}" to ${target.label}. Reload the MCP servers in your client to pick it up.`,
        open
    );
    if (picked === open) {
        await vscode.window.showTextDocument(target.file);
    }
}

export function registerClientConfig(context: vscode.ExtensionContext, nativeProvider: boolean): void {
    installBridge(context);
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'contextView.mcp.configureClient',
            () => void configureClient(nativeProvider)
        )
    );
}

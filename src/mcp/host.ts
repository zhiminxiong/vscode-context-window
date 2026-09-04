import * as vscode from 'vscode';
import { registerClientConfig } from './clientConfig';
import { clearEndpointFile, writeEndpointFile } from './endpointFile';
import { disposeMcpChannel, mcpChannel, mcpLog } from './log';
import { MCP_INSTRUCTIONS, MCP_SERVER_NAME, MCP_TOOLS } from './registry';
import { McpEndpoint, startMcpServer } from './server';
import { disposeToolState } from './tools';
import { registerVsCodeMcpProvider } from './vscodeProvider';

/**
 * Owns the MCP endpoint's lifetime for this window.
 *
 * The port is ephemeral and the token is new on every start, so nothing here
 * is safe to write into a config file by hand. There are two ways out of that:
 * VS Code asks the extension for the address every time, and everyone else
 * reads it from the file this module keeps up to date.
 */

const CONFIG_SECTION = 'contextView.mcp';
const CONFIG_ENABLED = 'enabled';

let endpoint: McpEndpoint | undefined;
let starting: Promise<McpEndpoint | undefined> | undefined;
/** Set when the editor drives the endpoint itself and needs no config file. */
let nativeProvider = false;
/** Bumped whenever the endpoint is replaced, so consumers can re-read it. */
const changed = new vscode.EventEmitter<void>();

function isEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(CONFIG_ENABLED, true);
}

function extensionVersion(): string {
    const own = vscode.extensions.getExtension('zhiminxiong.context-window');
    const version = own?.packageJSON?.version;
    return typeof version === 'string' ? version : '0.0.0';
}

async function start(): Promise<McpEndpoint | undefined> {
    if (endpoint) {
        return endpoint;
    }
    if (starting) {
        return starting;
    }
    starting = (async () => {
        try {
            const started = await startMcpServer({
                tools: MCP_TOOLS,
                info: {
                    name: MCP_SERVER_NAME,
                    version: extensionVersion(),
                    instructions: MCP_INSTRUCTIONS
                },
                log: mcpLog
            });
            endpoint = started;
            mcpLog(`tools: ${MCP_TOOLS.map(t => t.name).join(', ')}`);
            publishEndpoint(started);
            changed.fire();
            return started;
        } catch (err) {
            mcpLog(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        } finally {
            starting = undefined;
        }
    })();
    return starting;
}

function workspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.length ? folders[0].uri.fsPath : undefined;
}

/**
 * Records the address for readers outside the process. Written even when the
 * editor asks us directly, because the same checkout is often open in the
 * other editor too, and the file is what that one goes by.
 */
function publishEndpoint(live: McpEndpoint): void {
    const root = workspaceRoot();
    if (!root) {
        return;
    }
    try {
        writeEndpointFile(root, {
            url: live.url,
            token: live.token,
            pid: process.pid,
            workspaceRoot: root,
            version: extensionVersion(),
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        mcpLog(`could not record the endpoint: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function unpublishEndpoint(): void {
    const root = workspaceRoot();
    if (root) {
        clearEndpointFile(root);
    }
}

function stop(): void {
    unpublishEndpoint();
    if (!endpoint) {
        return;
    }
    mcpLog('stopping');
    endpoint.dispose();
    endpoint = undefined;
    disposeToolState();
    changed.fire();
}

async function applyConfig(): Promise<void> {
    if (isEnabled()) {
        await start();
    } else {
        stop();
    }
}

async function showEndpoint(): Promise<void> {
    if (!isEnabled()) {
        vscode.window.showInformationMessage(
            `The MCP endpoint is off. Turn on ${CONFIG_SECTION}.${CONFIG_ENABLED} to start it.`
        );
        return;
    }
    const live = endpoint ?? await start();
    if (!live) {
        vscode.window.showErrorMessage('The MCP endpoint could not start. See the Context View MCP output.');
        return;
    }
    const channel = mcpChannel();
    channel.appendLine('');
    channel.appendLine(`endpoint: ${live.url}`);
    channel.appendLine(`token:    ${live.token}`);
    channel.appendLine('Both change every time this window starts. Nothing needs to be copied by hand:');
    channel.appendLine(nativeProvider
        ? `${vscode.env.appName} reads the address from this extension directly.`
        : 'run "Context View: Configure MCP Server Entry" to point a client at the bridge.');
    channel.show(true);

    if (nativeProvider) {
        vscode.window.showInformationMessage(
            `MCP endpoint listening on port ${live.port}, registered with ${vscode.env.appName}.`
        );
        return;
    }
    const configure = 'Write the entry';
    const picked = await vscode.window.showInformationMessage(
        `MCP endpoint listening on port ${live.port}. ${vscode.env.appName} needs a config file to find it.`,
        configure
    );
    if (picked === configure) {
        await vscode.commands.executeCommand('contextView.mcp.configureClient');
    }
}

export function registerMcpHost(context: vscode.ExtensionContext): void {
    // Registered before the endpoint starts: VS Code wants providers in place
    // by the time activation resolves, and whether it took the provider
    // decides if the address has to be written to disk at all.
    nativeProvider = registerVsCodeMcpProvider(context, {
        ensureEndpoint: async () => (isEnabled() ? start() : undefined),
        onDidChangeEndpoint: changed.event,
        extensionVersion: extensionVersion()
    });
    // Registered either way: the command must not be a dead entry in the
    // palette, and a checkout open in one editor may still need an entry
    // written for a different client to use later.
    registerClientConfig(context, nativeProvider);

    context.subscriptions.push(
        vscode.commands.registerCommand('contextView.mcp.showEndpoint', () => void showEndpoint()),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_ENABLED}`)) {
                void applyConfig();
            }
        }),
        changed,
        {
            dispose: () => {
                stop();
                // Also reached when the endpoint was never on: the preview
                // commands share this state.
                disposeToolState();
                disposeMcpChannel();
            }
        }
    );
    void applyConfig();
}

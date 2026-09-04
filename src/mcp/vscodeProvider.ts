import * as vscode from 'vscode';
import { mcpLog } from './log';
import { MCP_SERVER_NAME } from './registry';
import { McpEndpoint } from './server';

/**
 * Hands the endpoint to VS Code's own MCP client.
 *
 * On this path nothing has to be configured: VS Code asks the extension where
 * the server is, so the port and token never leave the process.
 *
 * The API landed in 1.101 while this extension still supports 1.50, so it is
 * both typed locally and probed at runtime. `@types/vscode` is pinned to the
 * engine floor and therefore does not describe any of it.
 *
 * The types below are deliberately *not* declared as an augmentation of the
 * `vscode` module: when `@types/vscode` is eventually raised past 1.101, an
 * augmentation would collide with the real declarations, whereas these are
 * simply unused.
 */

/** Mirrors `vscode.McpHttpServerDefinition`; positional, as in vscode.d.ts. */
type McpHttpServerDefinitionCtor = new (
    label: string,
    uri: vscode.Uri,
    headers?: Record<string, string>,
    version?: string
) => object;

interface McpServerDefinitionProviderLike {
    readonly onDidChangeMcpServerDefinitions?: vscode.Event<void>;
    provideMcpServerDefinitions(token: vscode.CancellationToken): Thenable<object[]>;
}

interface LanguageModelApi {
    registerMcpServerDefinitionProvider?(
        id: string,
        provider: McpServerDefinitionProviderLike
    ): vscode.Disposable;
}

/** Must match `contributes.mcpServerDefinitionProviders[].id` in package.json. */
export const MCP_PROVIDER_ID = 'contextViewMcpProvider';

interface HostBridge {
    /**
     * Starts the endpoint if it is enabled and not yet running. VS Code asks
     * for definitions while activation is still in flight, so returning
     * nothing and waiting for the change event would leave the server missing
     * on the first query.
     */
    ensureEndpoint(): Promise<McpEndpoint | undefined>;
    onDidChangeEndpoint: vscode.Event<void>;
    extensionVersion: string;
}

/**
 * Registers the provider, or reports why it could not be.
 *
 * @returns whether VS Code will be driving the endpoint itself.
 */
export function registerVsCodeMcpProvider(
    context: vscode.ExtensionContext,
    host: HostBridge
): boolean {
    const lm = (vscode as unknown as { lm?: LanguageModelApi }).lm;
    const register = lm?.registerMcpServerDefinitionProvider;
    const HttpDefinition = (vscode as unknown as { McpHttpServerDefinition?: McpHttpServerDefinitionCtor })
        .McpHttpServerDefinition;

    if (typeof register !== 'function' || typeof HttpDefinition !== 'function') {
        mcpLog(`${vscode.env.appName} has no MCP provider API; use "Context View: Configure MCP Server Entry" instead.`);
        return false;
    }

    const changed = new vscode.EventEmitter<void>();
    // Re-ask VS Code to pick up the address whenever the endpoint is replaced.
    const forward = host.onDidChangeEndpoint(() => changed.fire());

    let registration: vscode.Disposable;
    try {
        registration = register.call(lm, MCP_PROVIDER_ID, {
            onDidChangeMcpServerDefinitions: changed.event,
            provideMcpServerDefinitions: async () => {
                const endpoint = await host.ensureEndpoint();
                if (!endpoint) {
                    return [];
                }
                return [
                    new HttpDefinition(
                        MCP_SERVER_NAME,
                        vscode.Uri.parse(endpoint.url),
                        { Authorization: `Bearer ${endpoint.token}` },
                        // The extension version, not anything per-start: VS Code
                        // treats a change here as "the tools changed" and asks
                        // the user to refresh them.
                        host.extensionVersion
                    )
                ];
            }
        });
    } catch (err) {
        mcpLog(`could not register the MCP provider: ${err instanceof Error ? err.message : String(err)}`);
        forward.dispose();
        changed.dispose();
        return false;
    }

    mcpLog(`registered with ${vscode.env.appName} as "${MCP_PROVIDER_ID}"`);
    context.subscriptions.push(registration, forward, changed);
    return true;
}

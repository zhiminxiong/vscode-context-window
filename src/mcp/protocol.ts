/**
 * MCP over JSON-RPC, with no transport and no editor in sight.
 *
 * Only what a tools-only server needs: initialize, the tool list, tool calls,
 * and ping. There are no resources, no prompts, and nothing the server sends
 * on its own, which is what lets the HTTP layer answer every POST with a plain
 * JSON body and decline the SSE stream outright.
 *
 * Hand-written rather than taken from `@modelcontextprotocol/sdk`: the SDK
 * pulls hono, zod, and ajv, which measured at 850 KB on top of a 175 KB
 * extension bundle. This surface is small and stable enough not to pay that.
 */

export const LATEST_PROTOCOL_VERSION = '2025-06-18';
const KNOWN_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const JSON_RPC_VERSION = '2.0';

export const enum JsonRpcErrorCode {
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603
}

export interface McpToolOutcome {
    text: string;
    /** Set for a failure the model should react to, not for an empty answer. */
    isError?: boolean;
}

export interface McpToolDefinition {
    name: string;
    title?: string;
    description: string;
    /** JSON Schema for the arguments object. */
    inputSchema: Record<string, unknown>;
    invoke(args: Record<string, unknown>): Promise<McpToolOutcome>;
}

export interface McpServerInfo {
    name: string;
    version: string;
    /** Shown to the model once, when the connection opens. */
    instructions?: string;
}

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** JSON-RPC treats a missing id as a notification; null is a real id. */
function hasId(message: JsonRpcMessage): boolean {
    return Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== undefined;
}

function resultFor(id: JsonRpcId, result: unknown): Record<string, unknown> {
    return { jsonrpc: JSON_RPC_VERSION, id, result };
}

export function errorFor(id: JsonRpcId, code: JsonRpcErrorCode, message: string): Record<string, unknown> {
    return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

function negotiateVersion(params: unknown): string {
    const wanted = isRecord(params) ? params.protocolVersion : undefined;
    if (typeof wanted === 'string' && KNOWN_PROTOCOL_VERSIONS.includes(wanted)) {
        return wanted;
    }
    return LATEST_PROTOCOL_VERSION;
}

function describeTool(tool: McpToolDefinition): Record<string, unknown> {
    const described: Record<string, unknown> = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
    };
    if (tool.title) {
        described.title = tool.title;
    }
    return described;
}

async function callTool(
    tools: readonly McpToolDefinition[],
    params: unknown
): Promise<{ result?: unknown; error?: { code: JsonRpcErrorCode; message: string } }> {
    const name = isRecord(params) ? params.name : undefined;
    if (typeof name !== 'string' || !name) {
        return { error: { code: JsonRpcErrorCode.InvalidParams, message: 'tools/call needs a tool name.' } };
    }
    const tool = tools.find(t => t.name === name);
    if (!tool) {
        return { error: { code: JsonRpcErrorCode.InvalidParams, message: `Unknown tool "${name}".` } };
    }
    const rawArgs = isRecord(params) ? params.arguments : undefined;
    const args = isRecord(rawArgs) ? rawArgs : {};
    try {
        const outcome = await tool.invoke(args);
        return {
            result: {
                content: [{ type: 'text', text: outcome.text }],
                isError: !!outcome.isError
            }
        };
    } catch (err) {
        // A throw is a bug on our side; report it as a tool failure rather than
        // a protocol error so the model sees it and can move on.
        const message = err instanceof Error ? err.message : String(err);
        return {
            result: {
                content: [{ type: 'text', text: `Tool "${name}" failed: ${message}` }],
                isError: true
            }
        };
    }
}

/**
 * Handles one JSON-RPC message. Resolves to the reply, or to `undefined` for a
 * notification, which the caller should answer with an empty 202.
 */
export async function handleMessage(
    message: unknown,
    tools: readonly McpToolDefinition[],
    info: McpServerInfo
): Promise<Record<string, unknown> | undefined> {
    if (!isRecord(message)) {
        return errorFor(null, JsonRpcErrorCode.InvalidRequest, 'Expected a JSON-RPC object.');
    }
    const rpc = message as JsonRpcMessage;
    const method = typeof rpc.method === 'string' ? rpc.method : '';
    const id = (hasId(rpc) ? rpc.id : null) as JsonRpcId;
    const isNotification = !hasId(rpc);

    if (!method) {
        // A response to something we never asked for; nothing to do either way.
        return isNotification ? undefined : errorFor(id, JsonRpcErrorCode.InvalidRequest, 'Missing method.');
    }
    if (isNotification) {
        return undefined;
    }

    switch (method) {
        case 'initialize':
            return resultFor(id, {
                protocolVersion: negotiateVersion(rpc.params),
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: info.name, version: info.version },
                ...(info.instructions ? { instructions: info.instructions } : {})
            });
        case 'ping':
            return resultFor(id, {});
        case 'tools/list':
            return resultFor(id, { tools: tools.map(describeTool) });
        case 'tools/call': {
            const outcome = await callTool(tools, rpc.params);
            if (outcome.error) {
                return errorFor(id, outcome.error.code, outcome.error.message);
            }
            return resultFor(id, outcome.result);
        }
        default:
            return errorFor(id, JsonRpcErrorCode.MethodNotFound, `Unsupported method "${method}".`);
    }
}

/**
 * A POST body is normally one message. Arrays were legal JSON-RPC batching in
 * the 2025-03-26 revision and were dropped later; accepting them anyway costs
 * nothing and keeps older clients working.
 */
export async function handleBody(
    body: unknown,
    tools: readonly McpToolDefinition[],
    info: McpServerInfo
): Promise<Record<string, unknown> | Record<string, unknown>[] | undefined> {
    if (Array.isArray(body)) {
        if (!body.length) {
            return errorFor(null, JsonRpcErrorCode.InvalidRequest, 'Empty batch.');
        }
        const replies: Record<string, unknown>[] = [];
        for (const entry of body) {
            const reply = await handleMessage(entry, tools, info);
            if (reply) {
                replies.push(reply);
            }
        }
        return replies.length ? replies : undefined;
    }
    return handleMessage(body, tools, info);
}

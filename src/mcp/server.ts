import { randomBytes, timingSafeEqual } from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import { JsonRpcErrorCode, McpServerInfo, McpToolDefinition, errorFor, handleBody } from './protocol';

/**
 * The MCP endpoint, hosted inside the extension host.
 *
 * It has to live here rather than in its own process: every answer comes from
 * the language server and the workspace of *this* window, which no external
 * process can reach.
 *
 * Deliberately stateless. The transport lets a server hand out an
 * `Mcp-Session-Id` and require it afterwards, but clients that lose it then
 * fail every call, so this server never issues one and never asks for one.
 * Nothing is sent unprompted either, so the SSE stream is declined with the
 * 405 the transport reserves for exactly that case.
 *
 * Access control is a bearer token generated per start, on top of binding to
 * loopback only. The token is what stops any other local process from reading
 * the workspace through this port.
 */

export const MCP_ENDPOINT_PATH = '/mcp';
/** Answers are text; a request that big is not one of ours. */
const MAX_BODY_BYTES = 1024 * 1024;
/** Past here the sender is not going to be told anything useful. */
const ABANDON_BODY_BYTES = MAX_BODY_BYTES * 16;
const REQUEST_TIMEOUT_MS = 120_000;

export interface McpEndpoint {
    url: string;
    token: string;
    port: number;
    dispose(): void;
}

export interface McpServerOptions {
    tools: readonly McpToolDefinition[];
    info: McpServerInfo;
    /** Reported to the user; the extension has no output channel of its own here. */
    log?(message: string): void;
}

function tokenMatches(expected: string, provided: string): boolean {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    // timingSafeEqual throws on a length mismatch, which is itself a leak-free
    // answer: different lengths cannot be the same token.
    return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(header: string | string[] | undefined): string {
    const raw = Array.isArray(header) ? header[0] : header;
    const match = /^Bearer\s+(.+)$/i.exec((raw || '').trim());
    return match ? match[1].trim() : '';
}

/**
 * A browser reaching a loopback server is the DNS-rebinding case the transport
 * security notes call out. Requests from a real MCP client carry no Origin.
 */
function originAllowed(origin: string | string[] | undefined): boolean {
    const raw = Array.isArray(origin) ? origin[0] : origin;
    if (!raw) {
        return true;
    }
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(raw.trim())
        || raw.trim().toLowerCase() === 'null'
        || raw.trim().startsWith('vscode-');
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function sendEmpty(res: http.ServerResponse, status: number, headers?: http.OutgoingHttpHeaders): void {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
    res.end();
}

type BodyRead = { text: string } | { tooLarge: true } | { aborted: true };

/**
 * Over the cap we stop buffering but keep draining, so the sender still gets a
 * 413 instead of a reset connection. Only a body large enough to look hostile
 * is cut off mid-flight.
 */
function readBody(req: http.IncomingMessage): Promise<BodyRead> {
    return new Promise(resolve => {
        let chunks: Buffer[] = [];
        let size = 0;
        let over = false;
        let settled = false;
        const finish = (value: BodyRead) => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };
        req.on('data', chunk => {
            const buf = chunk as Buffer;
            size += buf.byteLength;
            if (size > ABANDON_BODY_BYTES) {
                finish({ aborted: true });
                req.destroy();
                return;
            }
            if (size > MAX_BODY_BYTES) {
                over = true;
                chunks = [];
                return;
            }
            chunks.push(buf);
        });
        req.on('end', () => finish(over ? { tooLarge: true } : { text: Buffer.concat(chunks).toString('utf8') }));
        req.on('error', () => finish({ aborted: true }));
    });
}

export function startMcpServer(options: McpServerOptions): Promise<McpEndpoint> {
    const token = randomBytes(32).toString('hex');
    const log = options.log ?? (() => undefined);

    const server = http.createServer((req, res) => {
        void handleRequest(req, res).catch(err => {
            log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
            if (!res.headersSent) {
                sendJson(res, 500, errorFor(null, JsonRpcErrorCode.InternalError, 'Internal error.'));
            } else {
                res.end();
            }
        });
    });

    async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const path = (req.url || '').split('?')[0];
        if (path !== MCP_ENDPOINT_PATH) {
            sendEmpty(res, 404);
            return;
        }
        if (!originAllowed(req.headers.origin)) {
            sendEmpty(res, 403);
            return;
        }
        if (!tokenMatches(token, bearerToken(req.headers.authorization))) {
            sendEmpty(res, 401, { 'WWW-Authenticate': 'Bearer' });
            return;
        }
        switch (req.method) {
            case 'POST':
                await handlePost(req, res);
                return;
            case 'GET':
                // Nothing is ever sent unprompted, so there is no stream to open.
                sendEmpty(res, 405, { Allow: 'POST' });
                return;
            case 'DELETE':
                // No session was handed out, so there is nothing to tear down.
                // Answering 204 keeps a client's shutdown quiet.
                sendEmpty(res, 204);
                return;
            case 'OPTIONS':
                sendEmpty(res, 204, { Allow: 'POST, DELETE, OPTIONS' });
                return;
            default:
                sendEmpty(res, 405, { Allow: 'POST' });
                return;
        }
    }

    async function handlePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const body = await readBody(req);
        if ('aborted' in body) {
            return;
        }
        if ('tooLarge' in body) {
            const payload = Buffer.from(
                JSON.stringify(errorFor(null, JsonRpcErrorCode.InvalidRequest, 'Request too large.')),
                'utf8'
            );
            // The rest of the body was thrown away, so this socket is done.
            res.writeHead(413, {
                'Content-Type': 'application/json',
                'Content-Length': String(payload.byteLength),
                'Cache-Control': 'no-store',
                Connection: 'close'
            });
            res.end(payload);
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(body.text);
        } catch {
            sendJson(res, 400, errorFor(null, JsonRpcErrorCode.ParseError, 'Body is not JSON.'));
            return;
        }
        const reply = await handleBody(parsed, options.tools, options.info);
        if (reply === undefined) {
            // A notification. Accepted, nothing to say.
            sendEmpty(res, 202);
            return;
        }
        sendJson(res, 200, reply);
    }

    server.setTimeout(REQUEST_TIMEOUT_MS);
    server.on('clientError', (_err, socket) => {
        socket.destroy();
    });

    return new Promise<McpEndpoint>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            server.on('error', err => log(`server error: ${err.message}`));
            const address = server.address() as AddressInfo | null;
            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('The MCP server did not report a port.'));
                return;
            }
            const url = `http://127.0.0.1:${address.port}${MCP_ENDPOINT_PATH}`;
            log(`listening on ${url}`);
            resolve({
                url,
                token,
                port: address.port,
                dispose: () => {
                    server.closeAllConnections?.();
                    server.close();
                }
            });
        });
    });
}

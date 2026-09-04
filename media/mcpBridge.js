// @ts-check
'use strict';

/*
 * Lets an editor that only reads a static MCP config talk to this extension.
 *
 * Cursor configures MCP servers from `.cursor/mcp.json`, which is written once
 * and read on startup. The extension's endpoint cannot be written there: its
 * port and token are new every time the window starts. So this script is what
 * the config points at. The editor spawns it and speaks stdio to it; it looks
 * up the live endpoint and forwards each message over HTTP.
 *
 * Runs standalone with no dependencies, because it is launched by the editor
 * rather than loaded by the extension. Nothing but JSON-RPC may ever reach
 * stdout, so all diagnostics go to stderr.
 *
 * The path layout below is duplicated from src/mcp/endpointFile.ts. Keep both
 * in step.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ENDPOINT_DIR = path.join(os.homedir(), '.context-view', 'endpoints');
/** Cursor may launch us before the extension host has finished activating. */
const STARTUP_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

function log(message) {
    process.stderr.write(`[context-view bridge] ${message}\n`);
}

/**
 * The config passes `${workspaceFolder}`. An editor that does not expand it
 * hands the literal through, which would otherwise hash to a key nothing ever
 * writes and look exactly like "the window is closed".
 */
function resolveWorkspaceRoot() {
    const given = process.argv[2];
    if (!given) {
        return process.cwd();
    }
    if (given.includes('${')) {
        log(`the editor did not expand ${given} in mcp.json; falling back to ${process.cwd()}`);
        return process.cwd();
    }
    return given;
}

const workspaceRoot = resolveWorkspaceRoot();

function endpointFileFor(root) {
    const resolved = path.resolve(root);
    const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const key = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    return path.join(ENDPOINT_DIR, `${key}.json`);
}

/**
 * A config in the home directory has no project to point at, and Cursor
 * documents `${workspaceFolder}` as the folder holding the config — which
 * there is the home directory, not the workspace. So the given root may be
 * nothing anyone serves. Clients start a stdio server in the workspace, so the
 * working directory is the better guess when that happens.
 */
function candidateRoots() {
    const roots = [workspaceRoot];
    const cwd = process.cwd();
    if (path.resolve(cwd) !== path.resolve(workspaceRoot)) {
        roots.push(cwd);
    }
    return roots;
}

function readEndpoint() {
    for (const root of candidateRoots()) {
        let record;
        try {
            record = JSON.parse(fs.readFileSync(endpointFileFor(root), 'utf8'));
        } catch {
            continue;
        }
        if (record && record.url && record.token) {
            if (root !== workspaceRoot) {
                log(`no record for ${workspaceRoot}; matched the working directory ${root} instead`);
            }
            return record;
        }
    }
    return undefined;
}

/** Every workspace an open window is currently answering for. */
function servedRecords() {
    try {
        return fs.readdirSync(ENDPOINT_DIR)
            .filter(name => name.endsWith('.json'))
            .map(name => {
                try {
                    return JSON.parse(fs.readFileSync(path.join(ENDPOINT_DIR, name), 'utf8'));
                } catch {
                    return undefined;
                }
            })
            .filter(record => record && record.url && record.token);
    } catch {
        return [];
    }
}

/**
 * Says which workspaces *are* being served. A mismatch between the configured
 * root and the one the window has open is otherwise indistinguishable from no
 * window at all.
 */
function describeMismatch() {
    const roots = servedRecords().map(record => record.workspaceRoot).filter(Boolean);
    log(`looked under ${candidateRoots().join(' and ')}`);
    log(roots.length
        ? `currently served workspaces: ${roots.join(', ')}`
        : 'no workspace is currently served by an open window');
}

/**
 * Last resort, for when neither the given root nor the working directory is
 * served. With exactly one window up there is no ambiguity about which was
 * meant, so answer from it rather than fail. With several we refuse rather than
 * guess, and describeMismatch() lists them.
 */
function soleRecord() {
    const records = servedRecords();
    if (records.length !== 1) {
        return undefined;
    }
    log(`no record for ${workspaceRoot}; using the only served workspace, ${records[0].workspaceRoot}`);
    return records[0];
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let cached;

/** Waits for the window to come up on the first message only. */
async function resolveEndpoint(allowWait) {
    if (cached) {
        return cached;
    }
    const deadline = Date.now() + (allowWait ? STARTUP_WAIT_MS : 0);
    for (;;) {
        const found = readEndpoint() || soleRecord();
        if (found) {
            cached = found;
            log(`using ${found.url}`);
            return found;
        }
        if (Date.now() >= deadline) {
            return undefined;
        }
        await sleep(POLL_INTERVAL_MS);
    }
}

function post(endpoint, payload) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(endpoint.url);
        } catch (err) {
            reject(err);
            return;
        }
        const body = Buffer.from(payload, 'utf8');
        const req = http.request(
            {
                hostname: target.hostname,
                port: target.port,
                path: target.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.byteLength,
                    Accept: 'application/json, text/event-stream',
                    Authorization: `Bearer ${endpoint.token}`
                }
            },
            res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve({
                    status: res.statusCode || 0,
                    text: Buffer.concat(chunks).toString('utf8')
                }));
            }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(id, message) {
    if (id === undefined) {
        // A notification we could not deliver. There is nobody to tell.
        log(`dropped a notification: ${message}`);
        return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
}

const UNREACHABLE = [
    'The Context View window is not reachable.',
    'Open the workspace in the editor, and make sure contextView.mcp.enabled is on.'
].join(' ');

let first = true;

async function forward(line) {
    let id;
    try {
        const parsed = JSON.parse(line);
        id = Array.isArray(parsed) ? undefined : parsed.id;
    } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Bridge received invalid JSON.' } });
        return;
    }

    const allowWait = first;
    first = false;
    let endpoint = await resolveEndpoint(allowWait);
    if (!endpoint) {
        describeMismatch();
        sendError(id, UNREACHABLE);
        return;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await post(endpoint, line);
            // A restarted window means a new port and token; the record on disk
            // has already moved on, so re-read it and try the new one.
            if (res.status === 401 || res.status === 404) {
                if (attempt === 0) {
                    cached = undefined;
                    const refreshed = await resolveEndpoint(false);
                    if (refreshed && refreshed.url !== endpoint.url) {
                        endpoint = refreshed;
                        continue;
                    }
                }
                sendError(id, `The endpoint rejected the request (HTTP ${res.status}).`);
                return;
            }
            if (res.status === 202 || !res.text) {
                // A notification was accepted. Nothing to hand back.
                return;
            }
            // Already JSON-RPC; pass it through untouched rather than
            // re-encoding and risking a change in shape.
            process.stdout.write(`${res.text.trim()}\n`);
            return;
        } catch (err) {
            if (attempt === 0) {
                cached = undefined;
                const refreshed = await resolveEndpoint(false);
                if (refreshed) {
                    endpoint = refreshed;
                    continue;
                }
            }
            sendError(id, `${UNREACHABLE} (${err && err.message ? err.message : String(err)})`);
            return;
        }
    }
}

// One at a time: responses are matched by id, so ordering is not required, but
// serialising keeps stdout writes from interleaving and matches the extension,
// which answers one query at a time anyway.
let queue = Promise.resolve();
function enqueue(line) {
    queue = queue.then(() => forward(line)).catch(err => log(`failed: ${err && err.message}`));
}

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    buffered += chunk;
    for (;;) {
        const brk = buffered.indexOf('\n');
        if (brk < 0) {
            break;
        }
        const line = buffered.slice(0, brk).trim();
        buffered = buffered.slice(brk + 1);
        if (line) {
            enqueue(line);
        }
    }
});
process.stdin.on('end', () => {
    queue.then(() => process.exit(0));
});
process.on('uncaughtException', err => {
    log(`crashed: ${err && err.stack ? err.stack : String(err)}`);
    process.exit(1);
});

log(`started for ${workspaceRoot}`);

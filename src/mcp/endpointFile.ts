import { createHash } from 'crypto';
import * as fs from 'fs';
import { homedir } from 'os';
import * as path from 'path';

/**
 * How a process outside the editor finds this window's MCP endpoint.
 *
 * The port and token are new on every start, so they cannot be written into a
 * config file by hand. The editor's own MCP provider is handed them directly;
 * everyone else reads them from here.
 *
 * Keyed by workspace root so that several open windows do not answer for each
 * other. Kept under the home directory rather than in extension storage
 * because the reader is a bare script that has no way to locate an editor's
 * storage path.
 *
 * `media/mcpBridge.js` recomputes these paths independently. Keep the two in
 * step; the layout is deliberately trivial for that reason.
 */

export const DISCOVERY_DIR = path.join(homedir(), '.context-view');
export const ENDPOINT_DIR = path.join(DISCOVERY_DIR, 'endpoints');

export interface EndpointRecord {
    url: string;
    token: string;
    pid: number;
    workspaceRoot: string;
    version: string;
    updatedAt: string;
}

/**
 * Windows paths differ only by case, so they must fold to one key; elsewhere
 * two roots differing by case are genuinely different workspaces.
 */
export function workspaceKey(root: string): string {
    const resolved = path.resolve(root);
    const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export function endpointFilePath(root: string): string {
    return path.join(ENDPOINT_DIR, `${workspaceKey(root)}.json`);
}

export function writeEndpointFile(root: string, record: EndpointRecord): string {
    fs.mkdirSync(ENDPOINT_DIR, { recursive: true });
    const file = endpointFilePath(root);
    // The token is a credential, so keep it off other accounts on this machine.
    fs.writeFileSync(file, JSON.stringify(record, undefined, 2), { encoding: 'utf8', mode: 0o600 });
    return file;
}

/**
 * Only clears the record if this process wrote it. Two windows on one
 * workspace share a key, and the one shutting down must not cut off the other.
 */
export function clearEndpointFile(root: string): void {
    const file = endpointFilePath(root);
    try {
        const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<EndpointRecord>;
        if (existing.pid !== undefined && existing.pid !== process.pid) {
            return;
        }
        fs.unlinkSync(file);
    } catch {
        // Never written, already gone, or unreadable: nothing worth reporting.
    }
}

import * as vscode from 'vscode';

const SETTING = 'contextView.callRelation.indexMemoryMB';
const DEFAULT_MB = 100;
/** Clean buffers match the file on disk, whether or not an editor has them open. */
const DISK_REV_MS = 2_000;

interface Slot {
    bytes: number;
    deps: string[];
    revs: string[];
    body: unknown;
}

interface DiskRev {
    rev: string;
    at: number;
}

const diskRevCache = new Map<string, DiskRev>();

function uniqueUris(uris: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const uri of uris) {
        if (!uri || seen.has(uri)) {
            continue;
        }
        seen.add(uri);
        out.push(uri);
    }
    return out;
}

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let cursor = 0;
    const workers = Math.min(limit, items.length);
    async function worker(): Promise<void> {
        while (cursor < items.length) {
            const index = cursor++;
            out[index] = await fn(items[index]);
        }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return out;
}

export async function contentRev(uri: string): Promise<string> {
    let parsed: vscode.Uri;
    try {
        parsed = vscode.Uri.parse(uri);
    } catch {
        return 'bad';
    }
    const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri);
    if (open?.isDirty) {
        return `dirty:${open.version}`;
    }
    const now = Date.now();
    const cached = diskRevCache.get(uri);
    if (cached && now - cached.at < DISK_REV_MS) {
        return cached.rev;
    }
    try {
        const stat = await vscode.workspace.fs.stat(parsed);
        const rev = `fs:${stat.mtime}:${stat.size}`;
        diskRevCache.set(uri, { rev, at: now });
        return rev;
    } catch {
        return 'missing';
    }
}

/**
 * Process-lifetime index of relation results. Shared by the panel, Find Relation,
 * and the MCP model. Closing the panel clears the view, not this.
 * `wave` increments on any file edit; a put whose wave is older than the current
 * one is dropped so an in-flight scan cannot overwrite a newer file with stale data.
 */
class RelationIndex {
    private readonly slots = new Map<string, Slot>();
    private used = 0;
    private wave = 0;
    private listening = false;

    waveNow(): number {
        this.ensureListener();
        return this.wave;
    }

    status(): string {
        const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
        return `entries=${this.slots.size} used=${mb(this.used)}MB limit=${mb(this.limitBytes())}MB`;
    }

    invalidateUri(uri: string): void {
        this.ensureListener();
        this.wave++;
        diskRevCache.delete(uri);
        for (const [id, slot] of this.slots) {
            if (slot.deps.includes(uri)) {
                this.forget(id);
            }
        }
    }

    forget(id: string): void {
        const slot = this.slots.get(id);
        if (!slot) {
            return;
        }
        this.slots.delete(id);
        this.used -= slot.bytes;
        if (this.used < 0) {
            this.used = 0;
        }
    }

    depUris(id: string): readonly string[] {
        return this.slots.get(id)?.deps ?? [];
    }

    /** Slot is present. Does not re-check revisions or move the LRU entry. */
    has(id: string): boolean {
        return this.slots.has(id);
    }

    async take<T>(id: string): Promise<T | undefined> {
        this.ensureListener();
        const slot = this.slots.get(id);
        if (!slot) {
            return undefined;
        }
        const now = await mapPool(slot.deps, 32, contentRev);
        if (now.length !== slot.revs.length || now.some((rev, i) => rev !== slot.revs[i])) {
            this.forget(id);
            return undefined;
        }
        const current = this.slots.get(id);
        if (!current) {
            return undefined;
        }
        this.slots.delete(id);
        this.slots.set(id, current);
        return current.body as T;
    }

    async put(id: string, body: unknown, depUris: readonly string[], wave: number): Promise<void> {
        this.ensureListener();
        if (wave !== this.wave) {
            return;
        }
        const deps = uniqueUris(depUris);
        const revs = await mapPool(deps, 32, contentRev);
        if (wave !== this.wave) {
            return;
        }
        this.store(id, body, deps, revs);
    }

    /**
     * Snapshot each dep's rev now and store. A global edit wave does not drop this;
     * a later change to one of these deps still invalidates the slot.
     */
    async putLive(id: string, body: unknown, depUris: readonly string[]): Promise<boolean> {
        this.ensureListener();
        const deps = uniqueUris(depUris);
        const revs = await mapPool(deps, 32, contentRev);
        return this.store(id, body, deps, revs);
    }

    private store(id: string, body: unknown, deps: string[], revs: string[]): boolean {
        let payload = 0;
        try {
            payload = Buffer.byteLength(JSON.stringify(body), 'utf8');
        } catch {
            return false;
        }
        // JSON length undercounts the live objects. Times two stays near the configured cap.
        const bytes = payload * 2 + id.length + 128;
        this.forget(id);
        this.slots.set(id, { bytes, deps, revs, body });
        this.used += bytes;
        this.trim();
        return this.slots.has(id);
    }

    trim(): void {
        const limit = this.limitBytes();
        while (this.used > limit && this.slots.size > 0) {
            const oldest = this.slots.keys().next().value;
            if (typeof oldest !== 'string') {
                break;
            }
            this.forget(oldest);
        }
    }

    private limitBytes(): number {
        const raw = vscode.workspace.getConfiguration('contextView').get('callRelation.indexMemoryMB');
        const mb = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_MB;
        return Math.max(1, mb) * 1024 * 1024;
    }

    private ensureListener(): void {
        if (this.listening) {
            return;
        }
        this.listening = true;
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(SETTING)) {
                this.trim();
            }
        });
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.scheme !== 'file' || !event.contentChanges.length) {
                return;
            }
            this.invalidateUri(event.document.uri.toString());
        });
    }
}

let index: RelationIndex | undefined;

export function relationIndex(): RelationIndex {
    index ??= new RelationIndex();
    return index;
}

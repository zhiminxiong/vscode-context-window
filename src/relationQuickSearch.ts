import * as path from 'path';
import * as vscode from 'vscode';

const FIRST_PAGE = 10;
const MORE_PAGE = 15;
const MAX_MATCHES = 400;
const DEBOUNCE_MS = 220;

interface Hit {
    uri: vscode.Uri;
    line: number;
    character: number;
    preview: string;
}

interface FileGroup {
    key: string;
    uri: vscode.Uri;
    name: string;
    dir: string;
    hits: Hit[];
    shown: number;
}

type PickKind = 'hit' | 'more';

interface SearchItem extends vscode.QuickPickItem {
    pickKind?: PickKind;
    groupKey?: string;
    hit?: Hit;
}

function firstRange(result: any): vscode.Range | undefined {
    const ranges = result?.ranges ?? result?.range;
    if (!ranges) {
        return undefined;
    }
    if (Array.isArray(ranges)) {
        const head = ranges[0];
        if (!head) {
            return undefined;
        }
        return head.sourceRange || head;
    }
    return ranges.sourceRange || ranges;
}

function previewLine(text: string | undefined, fallback: string): string {
    const raw = (text || fallback).replace(/\s+/g, ' ').trim();
    return raw.length > 120 ? raw.slice(0, 119) + '…' : raw;
}

function hitKey(hit: Hit): string {
    return `${hit.uri.toString()}:${hit.line}`;
}

function addHit(hits: Hit[], seen: Set<string>, hit: Hit): void {
    const key = hitKey(hit);
    if (seen.has(key)) {
        const existing = hits.find(h => hitKey(h) === key);
        if (existing && hit.preview.length > existing.preview.length) {
            existing.preview = hit.preview;
            existing.character = hit.character;
        }
        return;
    }
    seen.add(key);
    hits.push(hit);
}

function collectTextResult(result: any, hits: Hit[], seen: Set<string>): void {
    if (!result?.uri) {
        return;
    }
    const range = firstRange(result);
    const line = range?.start?.line ?? 0;
    const character = range?.start?.character ?? 0;
    addHit(hits, seen, {
        uri: result.uri,
        line,
        character,
        preview: previewLine(result.preview?.text, '')
    });
}

async function searchTextApi(query: string, token: vscode.CancellationToken, hits: Hit[], seen: Set<string>): Promise<void> {
    const ws = vscode.workspace as any;
    const options = {
        maxResults: MAX_MATCHES,
        previewOptions: { matchLines: 1, charsPerLine: 200 }
    };
    const q = { pattern: query, isRegExp: false, isCaseSensitive: false, isWordMatch: false };

    if (typeof ws.findTextInFiles2 === 'function') {
        try {
            const ret = ws.findTextInFiles2(q, options, token);
            if (ret?.results && typeof ret.results[Symbol.asyncIterator] === 'function') {
                for await (const item of ret.results) {
                    if (token.isCancellationRequested) {
                        return;
                    }
                    collectTextResult(item, hits, seen);
                }
                if (ret.complete) {
                    await ret.complete;
                }
                return;
            }
        } catch {
            // 走旧 API
        }
    }

    if (typeof ws.findTextInFiles !== 'function') {
        return;
    }
    try {
        await ws.findTextInFiles(q, options, (result: any) => {
            if (!token.isCancellationRequested) {
                collectTextResult(result, hits, seen);
            }
        }, token);
    } catch {
        try {
            await ws.findTextInFiles(q, (result: any) => {
                if (!token.isCancellationRequested) {
                    collectTextResult(result, hits, seen);
                }
            }, token);
        } catch {
            // 留给符号 / 已打开文档兜底
        }
    }
}

async function searchSymbols(query: string, hits: Hit[], seen: Set<string>): Promise<void> {
    try {
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            query
        );
        for (const sym of symbols || []) {
            const loc = sym.location;
            if (!loc?.uri) {
                continue;
            }
            addHit(hits, seen, {
                uri: loc.uri,
                line: loc.range.start.line,
                character: loc.range.start.character,
                preview: previewLine(sym.name, '')
            });
        }
    } catch {
        // 语言服务器未就绪时忽略
    }
}

function searchOpenDocuments(query: string, hits: Hit[], seen: Set<string>): void {
    const needle = query.toLowerCase();
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') {
            continue;
        }
        const lineCount = Math.min(doc.lineCount, 4000);
        for (let i = 0; i < lineCount; i++) {
            const text = doc.lineAt(i).text;
            const col = text.toLowerCase().indexOf(needle);
            if (col < 0) {
                continue;
            }
            addHit(hits, seen, {
                uri: doc.uri,
                line: i,
                character: col,
                preview: previewLine(text, '')
            });
            if (seen.size >= MAX_MATCHES) {
                return;
            }
        }
    }
}

async function searchWorkspace(query: string, token: vscode.CancellationToken): Promise<Hit[]> {
    const hits: Hit[] = [];
    const seen = new Set<string>();
    searchOpenDocuments(query, hits, seen);
    if (token.isCancellationRequested) {
        return hits;
    }
    await Promise.all([
        searchTextApi(query, token, hits, seen),
        searchSymbols(query, hits, seen)
    ]);
    return hits;
}

function groupFiles(hits: Hit[]): FileGroup[] {
    const order: string[] = [];
    const map = new Map<string, FileGroup>();
    for (const hit of hits) {
        const key = hit.uri.toString();
        let group = map.get(key);
        if (!group) {
            group = {
                key,
                uri: hit.uri,
                name: path.basename(hit.uri.fsPath) || hit.uri.path,
                dir: path.basename(path.dirname(hit.uri.fsPath || hit.uri.path)),
                hits: [],
                shown: FIRST_PAGE
            };
            map.set(key, group);
            order.push(key);
        }
        group.hits.push(hit);
    }
    const groups = order.map(k => map.get(k)!);
    for (const group of groups) {
        group.hits.sort((a, b) => a.line - b.line || a.character - b.character);
    }
    // 命中多的文件排前面，避免已打开的小文件（1～2 条）永远顶在列表最上头。
    groups.sort((a, b) => b.hits.length - a.hits.length || a.name.localeCompare(b.name));
    return groups;
}

function buildItems(groups: FileGroup[]): SearchItem[] {
    const items: SearchItem[] = [];
    const sep = (vscode.QuickPickItemKind as unknown as { Separator?: number }).Separator;
    for (const group of groups) {
        const slice = group.hits.slice(0, group.shown);
        if (sep !== undefined) {
            items.push({
                label: group.name,
                description: group.dir,
                kind: sep,
                alwaysShow: true
            });
        } else {
            items.push({
                label: `${group.name}  ${group.dir}`,
                alwaysShow: true
            });
        }
        for (const hit of slice) {
            items.push({
                label: hit.preview || '(empty line)',
                description: `${group.name}:${hit.line + 1}`,
                alwaysShow: true,
                pickKind: 'hit',
                hit
            });
        }
        if (group.shown < group.hits.length) {
            items.push({
                label: '... More',
                description: `${group.hits.length - group.shown} more in ${group.name}`,
                alwaysShow: true,
                pickKind: 'more',
                groupKey: group.key
            });
        }
    }
    return items;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function openHit(
    hit: Hit,
    query: string,
    open: (loc: { uri: vscode.Uri; position: vscode.Position }) => void
): Promise<void> {
    let character = hit.character;
    const needle = query.trim();
    try {
        const doc = await vscode.workspace.openTextDocument(hit.uri);
        if (hit.line >= 0 && hit.line < doc.lineCount) {
            const line = doc.lineAt(hit.line).text;
            const at = new vscode.Position(hit.line, Math.min(Math.max(0, character), line.length));
            const wordRange = doc.getWordRangeAtPosition(at);
            const word = wordRange ? doc.getText(wordRange) : '';
            if (!needle || !word || word.toLowerCase() !== needle.toLowerCase()) {
                const m = needle ? new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i').exec(line) : null;
                if (m) {
                    character = m.index;
                }
            } else if (wordRange) {
                character = wordRange.start.character;
            }
        }
    } catch {
        // 读文件失败就用搜索命中的列
    }
    open({
        uri: hit.uri,
        position: new vscode.Position(hit.line, Math.max(0, character))
    });
}

function currentWord(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return '';
    }
    const range = editor.document.getWordRangeAtPosition(editor.selection.active);
    return range ? editor.document.getText(range).trim() : '';
}

export function registerRelationQuickSearch(
    _context: vscode.ExtensionContext,
    open: (loc: { uri: vscode.Uri; position: vscode.Position }) => void
): vscode.Disposable {
    return vscode.commands.registerCommand('contextView.callRelation.quickOpen', () => {
        const pick = vscode.window.createQuickPick<SearchItem>();
        pick.placeholder = 'Search the workspace, then open Relation on the selected line';
        pick.matchOnDescription = true;
        pick.ignoreFocusOut = true;
        // 默认会按 label 排序，More 追加的行会被抽到别的位置。
        (pick as vscode.QuickPick<SearchItem> & { sortByLabel?: boolean }).sortByLabel = false;

        let groups: FileGroup[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cts: vscode.CancellationTokenSource | undefined;
        let seq = 0;

        const status = (label: string) => {
            pick.items = [{ label, alwaysShow: true }];
        };

        const render = (focusMore?: string) => {
            const items = buildItems(groups);
            pick.items = items.length ? items : [{ label: 'No matches', alwaysShow: true }];
            if (focusMore) {
                const next = pick.items.find(it => it.pickKind === 'more' && it.groupKey === focusMore);
                if (next) {
                    pick.activeItems = [next];
                }
            }
        };

        const runSearch = (value: string) => {
            cts?.cancel();
            const q = value.trim();
            if (q.length < 2) {
                groups = [];
                pick.busy = false;
                status('Type at least 2 characters');
                return;
            }
            const my = ++seq;
            cts = new vscode.CancellationTokenSource();
            pick.busy = true;
            status('Searching…');
            void searchWorkspace(q, cts.token).then(hits => {
                if (my !== seq) {
                    return;
                }
                groups = groupFiles(hits);
                pick.busy = false;
                render();
            }, err => {
                if (my === seq) {
                    pick.busy = false;
                    status(err && err.message ? String(err.message) : 'Search failed');
                }
            });
        };

        pick.onDidChangeValue(value => {
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => runSearch(value), DEBOUNCE_MS);
        });

        pick.onDidAccept(() => {
            // 高亮行在 activeItems；selectedItems 经常是列表第一项，
            // 点 this.update 却打开 updatedConfig 就是这个原因。
            const item = pick.activeItems[0] || pick.selectedItems[0];
            if (!item) {
                return;
            }
            if (item.pickKind === 'more' && item.groupKey) {
                const group = groups.find(g => g.key === item.groupKey);
                if (group && group.shown < group.hits.length) {
                    group.shown = Math.min(group.hits.length, group.shown + MORE_PAGE);
                    render(group.shown < group.hits.length ? group.key : undefined);
                }
                return;
            }
            if (item.pickKind === 'hit' && item.hit) {
                const hit = item.hit;
                pick.hide();
                void openHit(hit, pick.value, open);
            }
        });

        pick.onDidHide(() => {
            if (timer) {
                clearTimeout(timer);
            }
            cts?.cancel();
            pick.dispose();
        });

        pick.show();
        const seed = currentWord();
        if (seed.length >= 2) {
            pick.value = seed;
            runSearch(seed);
        } else {
            status('Type at least 2 characters');
        }
    });
}

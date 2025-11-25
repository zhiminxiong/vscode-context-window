import * as vscode from 'vscode';

export interface FileContentInfo {
    content: string;
    line: number;
    column: number;
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    jmpUri: string;
    languageId: string; // 添加语言ID用于Monaco Editor
    documentVersion: number;
    lineCount: number;
}

interface FileCacheEntry {
    content: string;
    languageId: string;
    documentVersion: number;  // 添加：文档版本号
    lastAccessTime: number;  // 最后访问时间，用于LRU淘汰
}

export class Renderer {
    private readonly _disposables: vscode.Disposable[] = [];
        
    // 创建一个事件发射器用于通知需要重新渲染
    private readonly _onNeedsRender = new vscode.EventEmitter<void>();
    public readonly needsRender: vscode.Event<void>;

    // 文件内容缓存（最多10个）
    private readonly _fileCache = new Map<string, FileCacheEntry>();
    private readonly MAX_CACHE_SIZE = 10;
    // 大文件阈值（超过这个行数视为大文件，需要缓存）
    private readonly LARGE_FILE_THRESHOLD = 5000;

    constructor() {
        // 使用自己的事件发射器
        this.needsRender = this._onNeedsRender.event;
    }

    dispose() {
        let item: vscode.Disposable | undefined;
        while ((item = this._disposables.pop())) {
            item.dispose();
        }
        this._onNeedsRender.dispose();

        this._fileCache.clear();
    }

    public async renderDefinition(document: vscode.TextDocument, def: vscode.Location | vscode.LocationLink, 
                                selectedText: string | undefined): Promise<FileContentInfo> {
        if (def instanceof vscode.Location) {
            return await this.getFileContents(def.uri, def.range, document.languageId, selectedText || '');
        } else {
            if (def.targetSelectionRange)
                return await this.getFileContents(def.targetUri, def.targetSelectionRange, document.languageId, selectedText || '');
            else
                return await this.getFileContents(def.targetUri, def.targetRange, document.languageId, selectedText || '');
        }
    }

    private async getFileContents(uri: vscode.Uri, range: vscode.Range, languageId: string, selectedText: string): Promise<FileContentInfo> {
        const cacheKey = uri.toString();
        const firstLine = range.start.line;

        // 先打开文档获取版本号（无论如何都需要打开文档）
        //let beginTime = Date.now();
        const doc = await vscode.workspace.openTextDocument(uri);
        //let costtime = Date.now() - beginTime;
        //console.log(`[definition] 打开文档 ${uri.toString()} 花费时间: ${costtime} ms`);
        const currentVersion = doc.version;

        // 1. 先检查缓存
        const cached = this._fileCache.get(cacheKey);
        if (cached && cached.documentVersion === currentVersion) {
            //console.log(`[definition] getFileContents Cache hit for ${cacheKey}`);
            // 更新访问时间（LRU）
            cached.lastAccessTime = Date.now();
            return {
                content: cached.content,
                line: firstLine,
                column: range.start.character,
                range: {
                    start: { line: range.start.line, character: range.start.character },
                    end: { line: range.end.line, character: range.end.character }
                },
                jmpUri: uri.toString(),
                languageId: cached.languageId,
                documentVersion: currentVersion,
                lineCount: doc.lineCount
            };
        }

        const fileExtension = uri.fsPath.toLowerCase().split('.').pop();
        const finalLanguageId = fileExtension === 'inc' ? 'cpp' : (doc.languageId || languageId);

        const isLargeFile = doc.lineCount > this.LARGE_FILE_THRESHOLD;

        let content = this.readFullFileContent(doc);

        if (isLargeFile) {
            //console.log(`[definition] getFileContents Caching large file content for ${cacheKey} (lines: ${doc.lineCount})`);
            this.addToCache(cacheKey, {
                content,
                languageId: finalLanguageId,
                documentVersion: currentVersion,
                lastAccessTime: Date.now()
            });
        }

        return {
            content,
            line: firstLine,
            column: range.start.character,
            range: {
                start: { line: range.start.line, character: range.start.character },
                end: { line: range.end.line, character: range.end.character }
            },
            jmpUri: uri.toString(),
            languageId: finalLanguageId,
            documentVersion: currentVersion,
            lineCount: doc.lineCount
        };
    }

    // 读取完整文件内容
    private readFullFileContent(doc: vscode.TextDocument): string {
        const rangeText = new vscode.Range(0, 0, doc.lineCount, 0);
        return doc.getText(rangeText);
    }

    // 添加到缓存（LRU淘汰）
    private addToCache(key: string, entry: FileCacheEntry): void {
        // 如果已存在，直接更新
        if (this._fileCache.has(key)) {
            this._fileCache.set(key, entry);
            return;
        }
        
        // 如果缓存已满，淘汰最久未访问的
        if (this._fileCache.size >= this.MAX_CACHE_SIZE) {
            this.evictLRU();
        }
        
        // 添加新条目
        this._fileCache.set(key, entry);
    }

    // LRU淘汰：移除最久未访问的条目
    private evictLRU(): void {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        
        for (const [key, entry] of this._fileCache.entries()) {
            if (entry.lastAccessTime < oldestTime) {
                oldestTime = entry.lastAccessTime;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            this._fileCache.delete(oldestKey);
        }
    }
}

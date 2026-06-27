import * as vscode from 'vscode';

export interface FileContentInfo {
    content: string;
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

    // 大文件内容缓存
    private readonly _fileCache = new Map<string, FileCacheEntry>();
    // 后端大文件缓存容量（可配）：最多缓存多少个大文件
    private maxCacheSize = 20;
    // 大文件 size 阈值（字节，可配）：文件内容超过该大小视为大文件，需要后端缓存
    private largeFileSizeThreshold = 100 * 1024;

    constructor() {
        // 使用自己的事件发射器
        this.needsRender = this._onNeedsRender.event;

        // 读取缓存配置，并监听配置变更
        this.refreshConfig();
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('contextView.contextWindow.backendCacheSize') ||
                    e.affectsConfiguration('contextView.contextWindow.backendLargeFileSize')) {
                    this.refreshConfig();
                }
            })
        );
    }

    // 从 VS Code 配置读取后端缓存参数
    private refreshConfig(): void {
        const cfg = vscode.workspace.getConfiguration('contextView.contextWindow');
        this.maxCacheSize = cfg.get('backendCacheSize', 20);
        // 配置以 KB 为单位，转换为字节
        this.largeFileSizeThreshold = cfg.get('backendLargeFileSize', 100) * 1024;
        // 新容量可能比当前缓存小，主动裁剪到位
        while (this._fileCache.size > this.maxCacheSize) {
            this.evictLRU();
        }
    }

    dispose() {
        let item: vscode.Disposable | undefined;
        while ((item = this._disposables.pop())) {
            item.dispose();
        }
        this._onNeedsRender.dispose();

        this._fileCache.clear();
    }

    public async renderDefinition(languageId: string, def: vscode.Location | vscode.LocationLink): Promise<FileContentInfo> {
        if (def instanceof vscode.Location) {
            return await this.getFileContents(def.uri, def.range, languageId);
        } else {
            if (def.targetSelectionRange)
                return await this.getFileContents(def.targetUri, def.targetSelectionRange, languageId);
            else
                return await this.getFileContents(def.targetUri, def.targetRange, languageId);
        }
    }

    private async getFileContents(uri: vscode.Uri, range: vscode.Range, languageId: string): Promise<FileContentInfo> {
        const cacheKey = uri.toString();

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

        let content = this.readFullFileContent(doc);

        // 按内容字节大小判定是否为大文件（content 已无条件读取，零额外开销）
        const isLargeFile = content.length > this.largeFileSizeThreshold;

        if (isLargeFile) {
            //console.log(`[definition] getFileContents Caching large file content for ${cacheKey} (size: ${content.length})`);
            this.addToCache(cacheKey, {
                content,
                languageId: finalLanguageId,
                documentVersion: currentVersion,
                lastAccessTime: Date.now()
            });
        }

        return {
            content,
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

    /**
     * 按 URI 现取文件完整内容（与跳转 range 无关）。
     * 用于前端回源：单槽快照未命中时直接按 uri 重新取内容，
     * 大文件自动命中 _fileCache，小文件重新读取也很便宜。
     * 由调用方负责把定位信息（range/curLine）补上，本方法只管内容。
     */
    public async getContentByUri(uri: vscode.Uri): Promise<{
        content: string;
        languageId: string;
        documentVersion: number;
        lineCount: number;
    }> {
        const cacheKey = uri.toString();
        const doc = await vscode.workspace.openTextDocument(uri);
        const currentVersion = doc.version;

        // 命中后端大文件缓存且版本一致：直接返回
        const cached = this._fileCache.get(cacheKey);
        if (cached && cached.documentVersion === currentVersion) {
            cached.lastAccessTime = Date.now();
            return {
                content: cached.content,
                languageId: cached.languageId,
                documentVersion: currentVersion,
                lineCount: doc.lineCount
            };
        }

        const fileExtension = uri.fsPath.toLowerCase().split('.').pop();
        const finalLanguageId = fileExtension === 'inc' ? 'cpp' : doc.languageId;
        const content = this.readFullFileContent(doc);

        // 大文件入缓存，与 getFileContents 行为保持一致
        if (content.length > this.largeFileSizeThreshold) {
            this.addToCache(cacheKey, {
                content,
                languageId: finalLanguageId,
                documentVersion: currentVersion,
                lastAccessTime: Date.now()
            });
        }

        return {
            content,
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
        while (this._fileCache.size >= this.maxCacheSize) {
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

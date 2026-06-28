import * as vscode from 'vscode';

// 后端透传给前端的语义 token 负载。
// legend：tokenTypes / tokenModifiers 索引表（由语言服务器提供，按语言而定）。
// data：LSP 标准 5 元组 delta 编码 [ΔLine, ΔStartChar, length, tokenTypeIdx, tokenModifiers]，
//       Uint32Array 转成 number[] 以便跨 webview 序列化。
export interface SemanticPayload {
    legend: { tokenTypes: string[]; tokenModifiers: string[] };
    data: number[];
}

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
    semantic?: SemanticPayload | null; // VSCode 语义 token（按需，可能为空）
}

interface FileCacheEntry {
    content: string;
    languageId: string;
    documentVersion: number;  // 添加：文档版本号
    semantic?: SemanticPayload | null; // 与内容同版本缓存的语义 token
}

// loadContent 的返回结构：仅包含与 range 无关的内容与元数据
interface LoadedContent {
    content: string;
    languageId: string;
    documentVersion: number;
    lineCount: number;
    semantic?: SemanticPayload | null;
}

export class Renderer {
    private readonly _disposables: vscode.Disposable[] = [];
        
    // 创建一个事件发射器用于通知需要重新渲染
    private readonly _onNeedsRender = new vscode.EventEmitter<void>();
    public readonly needsRender: vscode.Event<void>;

    // 大文件内容缓存。
    // 利用 JS Map 保持插入顺序的特性实现 O(1) LRU：
    //   命中时 delete + set 把条目移到末尾（最近使用）；
    //   淘汰时直接取 keys().next().value（最旧条目）。
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
        this.maxCacheSize = Math.max(1, cfg.get('backendCacheSize', 20));
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

    /**
     * 跳转渲染：读取文件内容并补上定位 range。
     */
    private async getFileContents(uri: vscode.Uri, range: vscode.Range, languageId: string): Promise<FileContentInfo> {
        const loaded = await this.loadContent(uri, languageId);
        return {
            content: loaded.content,
            range: {
                start: { line: range.start.line, character: range.start.character },
                end: { line: range.end.line, character: range.end.character }
            },
            jmpUri: uri.toString(),
            languageId: loaded.languageId,
            documentVersion: loaded.documentVersion,
            lineCount: loaded.lineCount,
            semantic: loaded.semantic
        };
    }

    /**
     * 按 URI 现取文件完整内容（与跳转 range 无关）。
     * 用于前端回源：单槽快照未命中时直接按 uri 重新取内容，
     * 大文件自动命中 _fileCache，小文件重新读取也很便宜。
     * 由调用方负责把定位信息（range/curLine）补上，本方法只管内容。
     */
    public async getContentByUri(uri: vscode.Uri): Promise<LoadedContent> {
        return this.loadContent(uri);
    }

    /**
     * 统一的内容加载逻辑：打开文档 → 查缓存 → 判定大文件 → 入缓存。
     * 是 getFileContents 与 getContentByUri 的公共底座，避免两处流程重复、行为漂移。
     * @param fallbackLanguageId 当文档自身无 languageId 时的回退语言（跳转场景传入当前编辑器语言）
     */
    private async loadContent(uri: vscode.Uri, fallbackLanguageId?: string): Promise<LoadedContent> {
        const cacheKey = uri.toString();
        const doc = await vscode.workspace.openTextDocument(uri);
        const currentVersion = doc.version;
        // 仅在"非默认 tokenizer"（即语义着色模式）下才向语言服务器索取语义 token，
        // 默认模式走 Monaco 内置 tokenizer，无需多一次较贵的语义请求。
        const needSemantic = !vscode.workspace
            .getConfiguration('contextView.contextWindow')
            .get<boolean>('useDefaultTokenizer', true);

        // 命中后端大文件缓存且版本一致：直接返回，并把条目移到末尾（O(1) LRU）
        const cached = this._fileCache.get(cacheKey);
        if (cached && cached.documentVersion === currentVersion) {
            this._fileCache.delete(cacheKey);
            this._fileCache.set(cacheKey, cached);
            // 缓存项可能在"默认模式"时写入而未带语义 token，按需补取并回填
            let semantic = cached.semantic;
            if (needSemantic && semantic === undefined) {
                semantic = await this.getSemanticTokens(uri);
                cached.semantic = semantic;
            }
            return {
                content: cached.content,
                languageId: cached.languageId,
                documentVersion: currentVersion,
                lineCount: doc.lineCount,
                semantic: needSemantic ? semantic : null
            };
        }

        const fileExtension = uri.fsPath.toLowerCase().split('.').pop();
        const finalLanguageId = fileExtension === 'inc' ? 'cpp' : (doc.languageId || fallbackLanguageId || 'plaintext');
        const content = this.readFullFileContent(doc);
        const semantic = needSemantic ? await this.getSemanticTokens(uri) : null;

        // 按内容字节大小判定是否为大文件（content 已无条件读取，零额外开销）
        if (content.length > this.largeFileSizeThreshold) {
            this.addToCache(cacheKey, {
                content,
                languageId: finalLanguageId,
                documentVersion: currentVersion,
                semantic
            });
        }

        return {
            content,
            languageId: finalLanguageId,
            documentVersion: currentVersion,
            lineCount: doc.lineCount,
            semantic
        };
    }

    /**
     * 取整文档的 VSCode 语义 token：调用与编辑器同源的内置命令，
     * 拿到的就是当前语言服务器（cpptools/gopls/TS 等）产出的语义分类。
     * 与编辑器显示的是整文档坐标，前端 Monaco 显示也是整文档，坐标天然一一对应。
     * 任意失败（未装语言扩展 / 不支持语义 token / 文档未纳入分析）均返回 null，前端回退到基础着色。
     */
    private async getSemanticTokens(uri: vscode.Uri): Promise<SemanticPayload | null> {
        try {
            const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
                'vscode.provideDocumentSemanticTokensLegend', uri);
            if (!legend || !legend.tokenTypes) {
                return null;
            }
            const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
                'vscode.provideDocumentSemanticTokens', uri);
            if (!tokens || !tokens.data || tokens.data.length === 0) {
                return null;
            }
            return {
                legend: {
                    tokenTypes: Array.from(legend.tokenTypes),
                    tokenModifiers: Array.from(legend.tokenModifiers || [])
                },
                data: Array.from(tokens.data)
            };
        } catch {
            return null;
        }
    }

    // 读取完整文件内容
    private readFullFileContent(doc: vscode.TextDocument): string {
        const rangeText = new vscode.Range(0, 0, doc.lineCount, 0);
        return doc.getText(rangeText);
    }

    // 添加到缓存（O(1) LRU）
    private addToCache(key: string, entry: FileCacheEntry): void {
        // 如果已存在，先删除再插入，使其移到末尾（最近使用）
        if (this._fileCache.has(key)) {
            this._fileCache.delete(key);
            this._fileCache.set(key, entry);
            return;
        }

        // 如果缓存已满，淘汰最久未访问的（Map 头部）
        while (this._fileCache.size >= this.maxCacheSize) {
            this.evictLRU();
        }

        // 添加新条目（位于末尾）
        this._fileCache.set(key, entry);
    }

    // LRU 淘汰：移除最久未访问的条目（Map 头部，O(1)）
    private evictLRU(): void {
        const oldestKey = this._fileCache.keys().next().value;
        if (oldestKey !== undefined) {
            this._fileCache.delete(oldestKey);
        }
    }
}

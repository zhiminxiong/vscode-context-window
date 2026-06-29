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
        // 仅在非默认 tokenizer 模式（useDefaultTokenizer 关闭）下才向语言服务器索取语义 token：
        // 此时基础语法层由真实 TextMate 接管、语义层叠加其上。默认模式纯用 Monaco 内置 tokenizer，无需多一次较贵的语义请求。
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
            // 1) 先试整文档（< 10 万字符的文件 TS 等语言服务直接给）
            const full = await vscode.commands.executeCommand<vscode.SemanticTokens>(
                'vscode.provideDocumentSemanticTokens', uri);
            let data: number[] | null =
                (full && full.data && full.data.length) ? Array.from(full.data) : null;

            // 2) 整文档为空（大文件被 TS 的 100000 字符上限拒绝）→ 按行分段用 range provider 拼接
            if (!data) {
                data = await this.collectRangeTokensByChunks(uri);
            }
            if (!data || data.length === 0) {
                return null;
            }

            return {
                legend: {
                    tokenTypes: Array.from(legend.tokenTypes),
                    tokenModifiers: Array.from(legend.tokenModifiers || [])
                },
                data
            };
        } catch {
            return null;
        }
    }

    /**
     * 大文件分段取语义 token：VSCode 内置 TS 扩展对 > 100000 字符的文档会直接跳过整文档语义 token，
     * 但 range provider 只校验「单次请求范围」的长度。语义 token 不跨行（LSP 规定每个 token 在单行内），
     * 故按行边界切成多段（每段 < 上限）逐段取 range 语义 token，解码为文档绝对坐标后合并，
     * 再重新编码为一份完整的、从文档 (0,0) 起的 delta 序列。前端解码逻辑无需改动。
     */
    private async collectRangeTokensByChunks(uri: vscode.Uri): Promise<number[] | null> {
        const LIMIT = 90000; // 留余量，低于 TS 硬编码的 100000
        const doc = await vscode.workspace.openTextDocument(uri);

        // 按行切分（token 不跨行，行边界切不截断、段间不重叠）
        const ranges: vscode.Range[] = [];
        let segStart = 0;
        let segChars = 0;
        for (let line = 0; line < doc.lineCount; line++) {
            const lineLen = doc.lineAt(line).text.length + 1; // +1 估算换行符
            if (segChars > 0 && segChars + lineLen > LIMIT) {
                ranges.push(new vscode.Range(segStart, 0, line, 0)); // [segStart, line)
                segStart = line;
                segChars = 0;
            }
            segChars += lineLen;
        }
        ranges.push(new vscode.Range(segStart, 0, doc.lineCount, 0));

        // 逐段取（并行发起，减少往返等待）
        const segs = await Promise.all(ranges.map(r =>
            vscode.commands.executeCommand<vscode.SemanticTokens>(
                'vscode.provideDocumentRangeSemanticTokens', uri, r)
        ));

        // 解码为文档绝对坐标 token
        const abs: Array<{ line: number; char: number; len: number; type: number; mod: number }> = [];
        for (const seg of segs) {
            if (!seg || !seg.data || seg.data.length === 0) { continue; }
            const d = seg.data;
            let line = 0, char = 0;
            for (let i = 0; i + 4 < d.length; i += 5) {
                if (d[i] === 0) { char += d[i + 1]; }
                else { line += d[i]; char = d[i + 1]; }
                abs.push({ line, char, len: d[i + 2], type: d[i + 3], mod: d[i + 4] });
            }
        }
        if (abs.length === 0) { return null; }

        // 段按行递增、段内递增，整体已有序；排序做边界保险
        abs.sort((a, b) => a.line - b.line || a.char - b.char);

        // 重新编码为文档绝对坐标的 delta 5 元组
        const out: number[] = [];
        let pl = 0, pc = 0;
        for (const t of abs) {
            const dLine = t.line - pl;
            const dChar = dLine === 0 ? t.char - pc : t.char;
            out.push(dLine, dChar, t.len, t.type, t.mod);
            pl = t.line; pc = t.char;
        }
        return out;
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

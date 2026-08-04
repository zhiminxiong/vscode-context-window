import * as vscode from 'vscode';

// 后端透传给前端的语义 token 负载。
// legend：tokenTypes / tokenModifiers 索引表（由语言服务器提供，按语言而定）。
// token 本身不再随内容一次性下发，而是由前端 Monaco 的 DocumentRangeSemanticTokensProvider
// 只对可见视口向后端回源（见 getRangeSemanticTokens），与 VSCode 自身的 viewport 语义着色一致。
export interface SemanticPayload {
    legend: { tokenTypes: string[]; tokenModifiers: string[] };
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
    // 与内容同版本缓存的语义 token，三态语义（不要退化成只用 null）：
    //   undefined = 从未索取过（命中缓存时按需补取并回填）
    //   null      = 索取过且确认为空（不必重复请求语言服务器）
    //   Payload   = 索取过且有数据
    semantic?: SemanticPayload | null;
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

    // 整文档 token 兜底缓存：少数语言只注册了整文档 semantic provider（range 请求恒返回空），
    // 这类文件退回取一次整文档 token，并按 uri+version 缓存，避免每次滚动都重复请求语言服务器。
    private readonly _fullTokenFallback = new Map<string, { version: number; data: number[] }>();
    private static readonly FULL_FALLBACK_CAPACITY = 8;

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
        this._fullTokenFallback.clear();
    }

    // 判断某文档对应语言是否启用了语义高亮（对齐 VSCode：读取 editor.semanticHighlighting.enabled，
    // 并按文档语言解析 "[languageId]": {...} 这类按语言覆盖）。
    // 取值规则与 VSCode 一致：仅当显式为 false 时禁用；true / "configuredByTheme" / 未设置 均视为启用。
    private isSemanticHighlightingEnabled(doc: vscode.TextDocument): boolean {
        const val = vscode.workspace
            .getConfiguration('editor', doc)
            .get<boolean | string>('semanticHighlighting.enabled');
        return val !== false;
    }

    // 是否允许向语言服务器索取语义 token：非默认 tokenizer 模式 + 该语言未关闭语义高亮。
    // loadContent（取 legend）与 getRangeSemanticTokens（按视口取 token）共用同一判定，避免两处漂移。
    private isSemanticRequestAllowed(doc: vscode.TextDocument): boolean {
        return !vscode.workspace
            .getConfiguration('contextView.contextWindow')
            .get<boolean>('useDefaultTokenizer', true)
            && this.isSemanticHighlightingEnabled(doc);
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

    // 取文档对象：优先复用 VSCode 中已存在且未关闭的 TextDocument，只在确实没有时才 openTextDocument。
    // 为什么不能无脑 openTextDocument：主线程 BoundModelReferenceCollection 对扩展打开的文档是
    // 「每次调用 push 一条新引用 + 各自 3 分钟 TTL」，并在引用数达 60 时批量 dispose 最老的 10 条。
    // 每 dispose 一条就会触发 onDidCloseTextDocument，而 TS 扩展的 closeResource 里
    // `if (wasBufferOpen) this.requestAllDiagnostics()` 会让所有已打开文件重跑诊断。
    // 于是「context 里跳几次→ 引用堆积 → 批量关闭 → 连环全量诊断」把单线程语言服务器占满，
    // 而vscode.executeDefinitionProvider 内部硬编码 CancellationToken.None、无法取消也无法插队，
    // 只能干等前面的活干完 —— 这正是"跳一圈回来再点原token 要 2.4s"的根因。
    // 复用已有文档可避免同一文件反复累积引用，是减少这类风暴最直接的一招。
    private async acquireDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
        const key = uri.toString();
        const existing = vscode.workspace.textDocuments.find(d => !d.isClosed && d.uri.toString() === key);
        // console.log(`acquireDocument: ${key}, existing: ${existing}`);
        return existing ?? await vscode.workspace.openTextDocument(uri);
    }

    /**
     * 统一的内容加载逻辑：打开文档 → 查缓存 → 判定大文件 → 入缓存。
     * 是 getFileContents 与 getContentByUri 的公共底座，避免两处流程重复、行为漂移。
     * @param fallbackLanguageId 当文档自身无 languageId 时的回退语言（跳转场景传入当前编辑器语言）
     */
    private async loadContent(uri: vscode.Uri, fallbackLanguageId?: string): Promise<LoadedContent> {
        const cacheKey = uri.toString();
        const doc = await this.acquireDocument(uri);
        const currentVersion = doc.version;
        // 仅在非默认 tokenizer 模式（useDefaultTokenizer 关闭）下才向语言服务器索取语义 token：
        // 此时基础语法层由真实 TextMate 接管、语义层叠加其上。默认模式纯用 Monaco 内置 tokenizer，无需多一次较贵的语义请求。
        // 同时尊重 VSCode 的 editor.semanticHighlighting.enabled（含按语言覆盖，如 "[csharp]": {...}）：
        // 某语言显式关闭语义高亮时，与主编辑器一致——完全不取、不下发语义 token，纯靠 TextMate 着色。
        const needSemantic = this.isSemanticRequestAllowed(doc);

        // 命中后端大文件缓存且版本一致：直接返回，并把条目移到末尾（O(1) LRU）
        const cached = this._fileCache.get(cacheKey);
        if (cached && cached.documentVersion === currentVersion) {
            this._fileCache.delete(cacheKey);
            this._fileCache.set(cacheKey, cached);
            // 缓存项可能在"默认模式"时写入而未带语义 token，按需补取并回填
            let semantic = cached.semantic;
            if (needSemantic && semantic === undefined) {
                semantic = await this.getSemanticPayload(doc);
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
        // 语义 token 三态：
        //   undefined —— 本次未向语言服务器索取（默认 tokenizer 模式 / 该语言关闭语义高亮），
        //                后续若切到语义模式，命中缓存时可按需补取（见上方回填分支）；
        //   null      —— 索取过但确认为空（未装语言扩展 / 不支持语义 token / 无 token），不必重取；
        //   Payload   —— 索取到数据。
        const semantic = needSemantic ? await this.getSemanticPayload(doc) : undefined;

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
     * 取语义着色所需的 legend（tokenTypes / tokenModifiers 索引表），不含 token 本身。
     *
     * 对齐 VSCode 的 viewport 语义着色：token 不再随内容一次性下发，而是由前端 Monaco 的
     * DocumentRangeSemanticTokensProvider 只对可见视口向后端回源（见 getRangeSemanticTokens），
     * 滚动时增量补齐。这样任意时刻只让语言服务器分析一屏，不会因为大文件而瞬时压上覆盖全文的
     * 语义分析请求（TS 对 > 100000 字符的文档直接跳过整文档语义 token，正是出于同样的成本考虑）。
     *
     * 整文档 legend 命令取不到时（某些语言只注册了 range provider），退回 range legend 命令。
     * 任意失败（未装语言扩展 / 不支持语义 token / 文档未纳入分析）均返回 null，前端回退到基础着色。
     */
    private async getSemanticPayload(doc: vscode.TextDocument): Promise<SemanticPayload | null> {
        const uri = doc.uri;
        const exec = async (cmd: string): Promise<vscode.SemanticTokensLegend | undefined> => {
            try {
                return await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(cmd, uri);
            } catch {
                return undefined;
            }
        };
        let legend = await exec('vscode.provideDocumentSemanticTokensLegend');
        if (!legend || !legend.tokenTypes) {
            legend = await exec('vscode.provideDocumentRangeSemanticTokensLegend');
        }
        if (!legend || !legend.tokenTypes) {
            return null;
        }
        return {
            legend: {
                tokenTypes: Array.from(legend.tokenTypes),
                tokenModifiers: Array.from(legend.tokenModifiers || [])
            }
        };
    }

    /**
     * 视口回源：只对前端上报的可见行区间 [startLine, endLine) 取语义 token。
     * 前端 Monaco 的 range provider 会带上「可见区 + 上下各一屏」，滚动时增量再问，
     * 因此单次请求的范围恒为一屏量级，天然低于 TS 的 100000 字符上限，无需分段绕行。
     *
     * 坐标约定：VSCode 的 provideDocumentRangeSemanticTokens 与 Monaco 的
     * DocumentRangeSemanticTokensProvider 都使用「整文档绝对坐标的 delta 编码」
     * （首个 token 的 ΔLine 相对文档第 0 行），两边语义一致，故原样透传、不做任何重编码。
     *
     * full=true 表示返回的是整文档兜底数据（该语言只注册了整文档 provider），
     * 前端收到后会存为全量 data，后续视口直接本地供给、不再回源。
     *
     * documentVersion：本次结果所对应的文档版本（发命令前快照）。若取token 期间文档被编辑
     * （version 变化），则本次结果已过期，返回 null 让前端丢弃——对齐 VSCode 的 getVersionId 校验。
     */
    public async getRangeSemanticTokens(
        uri: vscode.Uri,
        startLine: number,
        endLine: number
    ): Promise<{ data: number[]; full: boolean; documentVersion: number } | null> {
        try {
            const doc = await this.acquireDocument(uri);
            if (!this.isSemanticRequestAllowed(doc)) {
                return null;
            }
            // 发命令前快照版本，回来后比对：期间被编辑则本次结果过期，丢弃（对齐 VSCode getVersionId 校验）
            const requestVersion = doc.version;
            // 夹取到合法行区间（前端上报的视口可能因内容版本差异越界）
            const maxLine = doc.lineCount;
            const s = Math.max(0, Math.min(startLine | 0, maxLine));
            const e = Math.max(s, Math.min(endLine | 0, maxLine));
            const seg = await vscode.commands.executeCommand<vscode.SemanticTokens>(
                'vscode.provideDocumentRangeSemanticTokens', uri, new vscode.Range(s, 0, e, 0));
            // 期间文档被编辑：结果对不上新内容，丢弃
            if (doc.version !== requestVersion) {
                return null;
            }
            if (seg && seg.data && seg.data.length) {
                console.log(`getRangeSemanticTokens: ${uri.toString()}, ${s}-${e}, ${seg.data.length}`);
                return { data: Array.from(seg.data), full: false, documentVersion: requestVersion };
            }

            // range provider 没给数据：可能该语言只注册了整文档 provider，也可能该区间确实无 token。
            // 退回取一次整文档（结果按 uri+version 缓存，空结果也缓存，故最多一次真实请求）。
            const fullData = await this.getFullTokensCached(doc);
            // 整文档兜底期间文档被编辑：同样丢弃
            if (doc.version !== requestVersion) {
                return null;
            }
            return fullData
                ? { data: fullData, full: true, documentVersion: requestVersion }
                : { data: [], full: false, documentVersion: requestVersion };
        } catch {
            return null;
        }
    }

    // 整文档 token 兜底缓存（按 uri+version）：空结果同样缓存，避免反复向语言服务器索取注定为空的数据。
    // 缓存 key 只用 uri，但存储项带 version：命中时校验version，文档一旦被修改（version 变化）即视为失效，
    // 删除旧项并按新版本重新取、重新缓存。
    private async getFullTokensCached(doc: vscode.TextDocument): Promise<number[] | null> {
        const key = doc.uri.toString();
        const hit = this._fullTokenFallback.get(key);
        if (hit && hit.version === doc.version) {
            return hit.data.length ? hit.data : null;
        }
        // 版本不一致（文档被修改）或从未缓存：先删旧项，避免旧版本数据被误用。
        this._fullTokenFallback.delete(key);

        const full = await vscode.commands.executeCommand<vscode.SemanticTokens>(
            'vscode.provideDocumentSemanticTokens', doc.uri);
        let data = (full && full.data && full.data.length) ? Array.from(full.data) : [];

        // 整文档命令返回空，且文档确实很大：极可能是 VSCode 内置 TS扩展对 > 100000 字符的文档
        // 直接跳过整文档语义 token。此时改走分段 range 兜底，逐段取 range token 拼出全文。
        if (data.length === 0 && doc.getText().length > 90000) {
            const chunked = await this.collectRangeTokensByChunks(doc);
            if (chunked && chunked.length) {
                data = chunked;
            }
        }

        this._fullTokenFallback.set(key, { version: doc.version, data });
        while (this._fullTokenFallback.size > Renderer.FULL_FALLBACK_CAPACITY) {
            const oldest = this._fullTokenFallback.keys().next().value;
            if (oldest === undefined) { break; }
            this._fullTokenFallback.delete(oldest);
        }
        return data.length ? data : null;
    }

    /**
     * 大文件分段取语义 token：VSCode 内置 TS 扩展对 > 100000 字符的文档会直接跳过整文档语义 token，
     * 但 range provider 只校验「单次请求范围」的长度。语义 token 不跨行（LSP 规定每个 token 在单行内），
     * 故按行边界切成多段（每段 < 上限）逐段取 range 语义 token，解码为文档绝对坐标后合并，
     * 再重新编码为一份完整的、从文档 (0,0) 起的 delta 序列。前端解码逻辑无需改动。
     */
    private async collectRangeTokensByChunks(doc: vscode.TextDocument): Promise<number[] | null> {
        const LIMIT = 90000; // 留余量，低于 TS 硬编码的 100000
        // 文档由上层（loadContent → acquireDocument）传入复用，此处不再 openTextDocument，
        // 避免同一文件在一次渲染里被重复 push 到主线程的 model 引用集合。
        const uri = doc.uri;

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

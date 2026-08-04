//@ts-check

// 视口语义着色客户端：为 Monaco 提供 DocumentRangeSemanticTokensProvider。
// Monaco 只会对「当前可见区 + 上下各一屏」调用它，滚动时增量再问，
// 因此任意时刻只让后端语言服务器分析一屏——这与 VSCode 自身的 viewport 语义着色完全一致，
// 不会因为大文件而一次性压上覆盖全文的语义分析请求（TS 对 > 100000 字符文档直接跳过整文档
// 语义 token，也正是出于同样的成本考虑）。
//
// 坐标约定：后端 vscode.provideDocumentRangeSemanticTokens 与 Monaco 的 range provider
// 都使用「整文档绝对坐标的 delta 编码」（首个 token 的 ΔLine 相对文档第 0 行），
// 因此后端原样透传、这里在池内解成绝对坐标、供给 Monaco 时再重新 delta 编码，全链路坐标一致。
//
// —— 按行覆盖拼接（自研增强，超出 VSCode 原生策略）——
// VSCode 原生 ViewportSemanticTokensContribution 只做「节流 + 完整token门控」，
// 每个滚动停顿点仍会对整个可见区重发请求（靠 100~500ms 节流压稀而非避免）。
// 本模块在此基础上进一步做「按行覆盖拼接」：
//   ① coveredRanges 记录「已成功取得token 的行区间」（0-based 半开、有序、无重叠、相邻合并）；
//   ② tokenPool 是「全文档 token 池」，以绝对坐标 { line, char, len, type, mod } 存储、按 (line,char) 升序；
//   ③ provide 时先算当前视口相对 coveredRanges 的未覆盖子区间（gap）：
//        无 gap —— 直接从池里裁出视口 token 编码返回，完全不回源；
//        有 gap —— 先返回已覆盖部分的 token（无闪烁），只对 gap 区间回源；
//   ④ 回包token 合并进池、gap 区间 union 进 coveredRanges，滚过的区域永久命中。
// 选择在池内存「绝对坐标」而非 delta：delta 下任意插入/裁剪都要重算相邻 delta 极易错，
// 绝对坐标下插入、按行裁剪、去重都是纯比较，供给 Monaco 时再一次性编码成 delta。
//
// 沿用 VSCode 的两点调度策略：
//   ① 节流合并：滚动过程中未命中的 gap 请求不立即回源，用短 timer 合并，停顿点只发最后一次；
//      请求完成后 fire onDidChange 让 Monaco 重新索取从而命中池。
//   ② 版本快照校验：发请求时快照 semanticState.version，回包版本不一致即丢弃，避免旧 token 画到新内容上。
//
// ctx:
//   vscode        —— webview 与扩展的通信对象
//   semanticState —— 与 main.js 共享的语义会话状态 { legend, data, tokenPool, version }：
//                    legend 随 updateContent 下发；data 仅在整文档兜底时临时保留兼容；
//                    tokenPool 是本模块维护的绝对坐标 token 池，同时供右键取色查表（见 tokenize.js）；
//                    version 是当前展示文档的版本号，用于回包的版本快照校验。
//   getUri        —— 取当前展示文件的 uri（回源请求要带上，避免切文件后错配）
//   onDidChange   —— 语义数据变更事件（复用 main.js 的 semanticTokensEmitter）
//   fireDidChange —— 触发上面的 onDidChange（回源完成后调用，促使 Monaco 重新索取以命中池）
export function createRangeSemanticClient(ctx) {
    const { vscode, semanticState, getUri, onDidChange, fireDidChange } = ctx;

    // 单次回源超时：超时按「本次拿不到」处理且不写池，后续滚动/内容变更还会重试
    const REQUEST_TIMEOUT_MS = 8000;
    // 节流合并窗口：滚动过程中未覆盖的 gap 请求不立即回源，而是等这段安静期后只发最新一批。
    // 取值对齐 VSCode 的 RunOnceScheduler 下限（100ms 量级），兼顾响应与合并效果。
    const REQUEST_DEBOUNCE_MS = 120;

    // 已成功取得 token 的行覆盖区间（0-based 半开、有序、无重叠、相邻自动合并），例：[[0,120],[200,464]]
    let coveredRanges = [];
    // 全文档 token 池：绝对坐标数组，每项 { line, char, len, type, mod }，按 (line,char) 升序
    let tokenPool = [];

    // 在途请求：reqId → { resolve, gapStart, gapEnd, uri, version }
    const pending = new Map();
    // 同一 gap 区间的并发去重：key = "start:end" → Promise
    const inflight = new Map();
    let reqSeq = 0;

    // 节流状态：合并滚动过程中累积的待取 gap，安静期后一次性发出
    let debounceTimer = null;
    let pendingGaps = new Map(); // key = "start:end" → { uri, start, end }

    // 共享给 main.js：右键取色改从绝对坐标 token 池查
    semanticState.tokenPool = tokenPool;

    // 内容/语义换版时清空：切换文件、命中前端缓存重放、legend 变化都会调用。
    // 在途请求一律以空结果兑现，避免 Promise 泄漏；Monaco 随后会因 onDidChange 重新索取。
    function reset() {
        coveredRanges = [];
        tokenPool.length = 0; // 保持 semanticState.tokenPool 引用不变
        inflight.clear();
        for (const p of pending.values()) {
            try { p.resolve([]); } catch (_) { /* noop */ }
        }
        pending.clear();
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        pendingGaps = new Map();
    }

    // 当前文档版本（用于回包的版本快照校验；未设置时视为不校验）
    function currentVersion() {
        return semanticState.version;
    }

    // === 覆盖区间工具 ===

    // 计算视口 [s,e) 相对 coveredRanges 的未覆盖子区间数组
    function computeGaps(s, e) {
        const gaps = [];
        let cur = s;
        for (const [rs, re] of coveredRanges) {
            if (re <= cur) { continue; }      // 已覆盖区间完全在游标左侧
            if (rs >= e) { break; }           // 已覆盖区间起点越过右界，后续更靠右
            if (rs > cur) {
                gaps.push([cur, Math.min(rs, e)]);
            }
            cur = Math.max(cur, re);
            if (cur >= e) { break; }
        }
        if (cur < e) {
            gaps.push([cur, e]);
        }
        return gaps;
    }

    // 把 [s,e) 并入 coveredRanges，合并相邻/重叠区间
    function unionRange(s, e) {
        const merged = [];
        let inserted = false;
        let ns = s, ne = e;
        for (const [rs, re] of coveredRanges) {
            if (re < ns) {
                merged.push([rs, re]);
            } else if (rs > ne) {
                if (!inserted) { merged.push([ns, ne]); inserted = true; }
                merged.push([rs, re]);
            } else {
                // 重叠或相邻，扩展待插入区间
                ns = Math.min(ns, rs);
                ne = Math.max(ne, re);
            }
        }
        if (!inserted) { merged.push([ns, ne]); }
        coveredRanges = merged;
    }

    // === token 池工具（绝对坐标）===

    // 把一份 delta 编码序列解成绝对坐标 token 并合并进池（覆盖 [gapStart,gapEnd) 行内旧 token）。
    // data 为整文档绝对坐标的 5元组 delta：[ΔLine, ΔStartChar, length, typeIdx, modBits]。
    function mergeIntoPool(data, gapStart, gapEnd) {
        // 1) 解码为绝对坐标
        const incoming = [];
        let line = 0, char = 0;
        for (let i = 0; i + 4 < data.length; i += 5) {
            const dLine = data[i];
            const dStart = data[i + 1];
            if (dLine === 0) {
                char += dStart;
            } else {
                line += dLine;
                char = dStart;
            }
            // 只接受落在本次 gap 行区间内的 token，避免后端多返回的越界 token 污染池
            if (line >= gapStart && line < gapEnd) {
                incoming.push({ line, char, len: data[i + 2], type: data[i + 3], mod: data[i + 4] });
            }
        }
        // 2) 删除池中落在 gap 行区间内的旧 token（防止重复），再插入新token 后整体排序
        const kept = tokenPool.filter(t => t.line < gapStart || t.line >= gapEnd);
        kept.push(...incoming);
        kept.sort((a, b) => (a.line - b.line) || (a.char - b.char));
        // 原地替换内容，保持 semanticState.tokenPool 引用不变
        tokenPool.length = 0;
        tokenPool.push(...kept);
    }

    // 从池里裁出 [s,e) 行的 token，编码成 Monaco 要的整文档绝对坐标 delta Uint32Array
    function sliceToDelta(s, e) {
        const out = [];
        let prevLine = 0, prevChar = 0;
        for (const t of tokenPool) {
            if (t.line < s) { continue; }
            if (t.line >= e) { break; }
            const dLine = t.line - prevLine;
            const dChar = dLine === 0 ? t.char - prevChar : t.char;
            out.push(dLine, dChar, t.len, t.type, t.mod);
            prevLine = t.line;
            prevChar = t.char;
        }
        return new Uint32Array(out);
    }

    // 后端回包：兑现对应的在途请求，把 token 合并进池、gap 并入覆盖区间
    function handleRangeSemantic(message) {
        const reqId = message && message.reqId;
        const p = pending.get(reqId);
        if (!p) {
            return;
        }
        pending.delete(reqId);
        inflight.delete(p.gapStart + ':' + p.gapEnd);

        // 回包晚于文件切换：丢弃，避免把上一个文件的 token 画到当前文件上
        if (message.uri && p.uri && message.uri !== p.uri) {
            p.resolve([]);
            return;
        }

        // 版本快照校验（对齐 VSCode 的 getVersionId 校验）：
        // 若回包携带的文档版本与「发请求时快照的版本」或「当前文档版本」不一致，
        // 说明期间文档已被编辑/切换，旧 token 不能画到新内容上，直接丢弃不写池。
        const respVersion = message.documentVersion;
        if (typeof respVersion === 'number') {
            const cur = currentVersion();
            const snapshotStale = typeof p.version === 'number' && p.version !== respVersion;
            const currentStale = typeof cur === 'number' && cur !== respVersion;
            if (snapshotStale || currentStale) {
                p.resolve([]);
                return;
            }
        }

        const data = Array.isArray(message.data) ? message.data : [];
        if (message.full) {
            // 该语言只注册了整文档 provider，后端退回整文档 token：
            // 整篇解码进池并标记全覆盖，之后一律走池、不再回源（统一供给路径）。
            const lineCount = typeof message.lineCount === 'number' && message.lineCount > 0
                ? message.lineCount
                : Number.MAX_SAFE_INTEGER;
            mergeIntoPool(data, 0, lineCount);
            unionRange(0, lineCount);
        } else {
            // gap 区间即便返回空，也标记为已覆盖：这段行确实「没有语义 token」，
            // 记为已覆盖可避免对空区域反复回源。
            mergeIntoPool(data, p.gapStart, p.gapEnd);
            unionRange(p.gapStart, p.gapEnd);
        }
        p.resolve(data);
    }

    // 真正把一个 gap 请求发到后端（不含节流；节流由 flushGaps 负责）
    function requestGap(uri, gapStart, gapEnd) {
        const key = gapStart + ':' + gapEnd;
        const shared = inflight.get(key);
        if (shared) {
            return shared;
        }

        const promise = new Promise(resolve => {
            const reqId = ++reqSeq;
            let settled = false;
            const done = (data) => {
                if (settled) { return; }
                settled = true;
                resolve(data);
            };
            // 发请求时快照当前文档版本，回包时比对（对齐 VSCode 的 requestVersionId 快照）
            pending.set(reqId, { resolve: done, gapStart, gapEnd, uri, version: currentVersion() });

            vscode.postMessage({
                type: 'requestRangeSemantic',
                reqId,
                uri,
                range: { startLine: gapStart, endLine: gapEnd }
            });

            // 兜底超时，避免 provider 永久挂起
            setTimeout(() => {
                if (pending.has(reqId)) {
                    pending.delete(reqId);
                    inflight.delete(key);
                }
                done([]);
            }, REQUEST_TIMEOUT_MS);
        });

        inflight.set(key, promise);
        // 回源完成后通知 Monaco 重新索取：拿到数据则这次重新索取命中池同步返回
        promise.then(() => {
            if (typeof fireDidChange === 'function') {
                try { fireDidChange(); } catch (_) { /* noop */ }
            }
        });
        return promise;
    }

    // 节流合并：累积待取 gap，安静期后一次性发出各 gap 的请求。
    // 滚动过程中 Monaco 高频调用 provider，这里持续累积并重置计时，
    // 只有停顿超过 REQUEST_DEBOUNCE_MS 才真正回源——等价于 VSCode 的 RunOnceScheduler 合并。
    function scheduleGaps(uri, gaps) {
        for (const [s, e] of gaps) {
            pendingGaps.set(s + ':' + e, { uri, start: s, end: e });
        }
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            const batch = pendingGaps;
            pendingGaps = new Map();
            const curUri = getUri();
            for (const g of batch.values()) {
                // 计时期间可能已换文件：与当前 uri 不一致则放弃
                if (g.uri !== curUri) { continue; }
                // 期间可能已被其它路径覆盖：重算残余 gap，全覆盖则跳过
                const stillGaps = computeGaps(g.start, g.end);
                for (const [s, e] of stillGaps) {
                    requestGap(g.uri, s, e);
                }
            }
        }, REQUEST_DEBOUNCE_MS);
    }

    const provider = {
        onDidChange,
        getLegend() {
            return semanticState.legend || { tokenTypes: [], tokenModifiers: [] };
        },
        provideDocumentRangeSemanticTokens(model, range, token) {
            if (!semanticState.legend) {
                return null;
            }

            const uri = getUri();
            if (!uri) {
                return null;
            }

            // Monaco 是 1-based 闭区间，后端/池是 0-based 半开区间
            const startLine = Math.max(0, range.startLineNumber - 1);
            const endLine = Math.max(startLine + 1, range.endLineNumber);

            const gaps = computeGaps(startLine, endLine);

            if (gaps.length === 0) {
                // 视口完全覆盖：从池里裁出返回，不回源
                return { data: sliceToDelta(startLine, endLine) };
            }

            // 有未覆盖区间：对 gap 节流回源；本次先返回已覆盖部分的 token（无闪烁），
            // 回源完成后 fire onDidChange，Monaco 重新索取时视口已全覆盖、完整命中。
            scheduleGaps(uri, gaps);
            return { data: sliceToDelta(startLine, endLine) };
        }
    };

    return { provider, handleRangeSemantic, reset };
}

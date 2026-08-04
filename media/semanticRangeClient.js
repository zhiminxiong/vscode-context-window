//@ts-check

// 视口语义着色客户端：为 Monaco 提供 DocumentRangeSemanticTokensProvider。
// Monaco 只会对「当前可见区 + 上下各一屏」调用它，滚动时增量再问，
// 因此任意时刻只让后端语言服务器分析一屏——这与 VSCode 自身的 viewport 语义着色完全一致，
// 不会因为大文件而一次性压上覆盖全文的语义分析请求（TS 对 > 100000 字符文档直接跳过整文档
// 语义 token，也正是出于同样的成本考虑）。
//
// 坐标约定：后端 vscode.provideDocumentRangeSemanticTokens 与 Monaco 的 range provider
// 都使用「整文档绝对坐标的 delta 编码」（首个 token 的 ΔLine 相对文档第 0 行），
// 因此后端原样透传、这里原样交给 Monaco，全链路零坐标换算。
//
// 对齐 VSCode 的 ViewportSemanticTokensContribution 的两点调度策略（源码印证）：
//   ① 节流合并：VSCode 用 RunOnceScheduler(100ms) + 自适应 debounce(100~500ms) 合并滚动
//      过程中的高频视口变化，只在滚动停顿点真正回源。Monaco 是回调式驱动 range provider，
//      我们无法在它之前插调度器，但可在自己的回源侧做等价合并：缓存未命中时不立即回源，
//      而是记下「最新待取视口」，用一个短 timer 合并，停顿点只发最后一次，请求完成后 fire
//      onDidChange 让 Monaco 重新索取从而命中缓存。这样滚动中间帧不再逐个打到语言服务器。
//   ③ 版本快照校验：VSCode 发请求时快照 model.getVersionId()，回包时若版本已变（期间被编辑）
//      则丢弃。我们在 semanticState.version 维护当前文档版本，回包携带 documentVersion，
//      不一致即丢弃，避免把旧 token 画到新内容上。
//
// ctx:
//   vscode        —— webview 与扩展的通信对象
//   semanticState —— 与 main.js 共享的语义会话状态 { legend, data, segments, version }：
//                legend 随 updateContent 下发；data 仅在整文档兜底时被填满；
//                    segments 是本模块维护的视口稀疏缓存，同时供右键取色查表（见 tokenize.js）；
//                    version 是当前展示文档的版本号，用于回包的版本快照校验。
//   getUri—— 取当前展示文件的 uri（回源请求要带上，避免切文件后错配）
//   onDidChange   —— 语义数据变更事件（复用 main.js 的 semanticTokensEmitter）：
//                    Monaco 收到后会取消在途请求并按当前视口重新索取。
//   fireDidChange —— 触发上面的 onDidChange（回源完成后调用，促使 Monaco 重新索取以命中缓存）
export function createRangeSemanticClient(ctx) {
    const { vscode, semanticState, getUri, onDidChange, fireDidChange } = ctx;

    // 单次回源超时：超时按「本次拿不到」处理且不写缓存，后续滚动/内容变更还会重试
    const REQUEST_TIMEOUT_MS = 8000;
    // 空结果的缓存有效期：语言服务器刚启动时可能暂时返回空，
    // 空结果只短暂缓存（抑制滚动期间的重复请求），过期后允许重试。
    const EMPTY_TTL_MS = 3000;
    // 节流合并窗口：滚动过程中缓存未命中的视口请求不立即回源，而是等这段安静期后只发最新一个。
    // 取值对齐 VSCode 的 RunOnceScheduler 下限（100ms 量级），兼顾响应与合并效果。
    const REQUEST_DEBOUNCE_MS = 120;

    // 视口稀疏缓存：key = "startLine:endLine"（0-based 半开区间）→ { data, ts }
    const segments = new Map();
    // 在途请求：reqId → { resolve, key, uri, version }；同 key 的并发请求共享同一 Promise（见 inflight）
    const pending = new Map();
    const inflight = new Map();
    let reqSeq = 0;

    // 节流状态：记录「最新一个待回源视口」，安静期后只对它发一次请求
    let debounceTimer = null;
    let latestPending = null; // { uri, startLine, endLine, key }

    // 共享给 main.js：右键取色在没有全量 data 时改从视口稀疏缓存里查 token
    semanticState.segments = segments;

    // 内容/语义换版时清空：切换文件、命中前端缓存重放、legend 变化都会调用。
    // 在途请求一律以空结果兑现，避免 Promise 泄漏；Monaco 随后会因 onDidChange 重新索取。
    function reset() {
        segments.clear();
        inflight.clear();
        for (const p of pending.values()) {
            try { p.resolve([]); } catch (_) { /* noop */ }
        }
        pending.clear();
        // 节流侧的待发请求同样作废，避免换文件后仍对旧视口回源
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        latestPending = null;
    }

    // 当前文档版本（用于回包的版本快照校验；未设置时视为不校验）
    function currentVersion() {
        return semanticState.version;
    }

    // 后端回包：兑现对应的在途请求
    function handleRangeSemantic(message) {
        const reqId = message && message.reqId;
        const p = pending.get(reqId);
        if (!p) {
            return;
        }
        pending.delete(reqId);
        inflight.delete(p.key);

        // 回包晚于文件切换：丢弃，避免把上一个文件的 token 画到当前文件上
        if (message.uri && p.uri && message.uri !== p.uri) {
            p.resolve([]);
            return;
        }

        // 版本快照校验（对齐 VSCode 的 getVersionId 校验）：
        // 若回包携带的文档版本与「发请求时快照的版本」或「当前文档版本」不一致，
        // 说明期间文档已被编辑/切换，旧 token 不能画到新内容上，直接丢弃不写缓存。
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
        if (message.full && data.length) {
            // 该语言只注册了整文档 provider，后端退回整文档 token：
            // 存为全量 data，之后所有视口直接本地供给，不再回源。
            semanticState.data = data;
        } else {
            segments.set(p.key, { data, ts: Date.now() });
        }
        p.resolve(data);
    }

    // 真正把一个视口请求发到后端（不含节流；节流由scheduleRange 负责）
    function requestRange(uri, startLine, endLine, key) {
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
            pending.set(reqId, { resolve: done, key, uri, version: currentVersion() });

            vscode.postMessage({
                type: 'requestRangeSemantic',
                reqId,
                uri,
                range: { startLine, endLine }
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
        // 回源完成（无论有无数据）后，通知 Monaco 重新索取当前视口：
        // 若拿到了数据，这次重新索取会命中segments 同步返回；避免 Monaco 一直等这个 Promise。
        promise.then(() => {
            if (typeof fireDidChange === 'function') {
                try { fireDidChange(); } catch (_) { /* noop */ }
            }
        });
        return promise;
    }

    // 节流合并：记下最新待取视口，安静期后只对它发一次请求。
    // 滚动过程中 Monaco 高频调用 provider，这里持续刷新 latestPending 并重置计时，
    // 只有停顿超过 REQUEST_DEBOUNCE_MS 才真正回源——等价于 VSCode 的 RunOnceScheduler 合并。
    function scheduleRange(uri, startLine, endLine, key) {
        latestPending = { uri, startLine, endLine, key };
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            const req = latestPending;
            latestPending = null;
            if (!req) { return; }
            // 计时期间可能已换文件：与当前 uri 不一致则放弃
            if (req.uri !== getUri()) { return; }
            // 期间可能已被其它路径填入缓存：命中则无需再发
            const hit = segments.get(req.key);
            if (hit && hit.data.length) {
                if (typeof fireDidChange === 'function') {
                    try { fireDidChange(); } catch (_) { /* noop */ }
                }
                return;
            }
            requestRange(req.uri, req.startLine, req.endLine, req.key);
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
            // 已有全量 data（整文档兜底）：直接本地供给，Monaco 自行裁剪到视口
            if (semanticState.data && semanticState.data.length) {
                return { data: new Uint32Array(semanticState.data) };
            }

            const uri = getUri();
            if (!uri) {
                return null;
            }

            // Monaco 是 1-based闭区间，后端是 0-based 半开区间
            const startLine = Math.max(0, range.startLineNumber - 1);
            const endLine = Math.max(startLine + 1, range.endLineNumber);
            const key = startLine + ':' + endLine;

            const hit = segments.get(key);
            if (hit) {
                if (hit.data.length) {
                    return { data: new Uint32Array(hit.data) };
                }
                // 空结果在 TTL 内直接复用，过期后重试（语言服务器可能刚就绪）
                if (Date.now() - hit.ts < EMPTY_TTL_MS) {
                    return null;
                }
                segments.delete(key);
            }

            // 缓存未命中：不立即回源，交给节流合并（滚动停顿点才真正请求一次）。
            // 本次先返回 null（本视口暂无token），请求完成后会fire onDidChange，
            // Monaco 重新索取时即可命中 segments 拿到数据。
            scheduleRange(uri, startLine, endLine, key);
            return null;
        }
    };

    return { provider, handleRangeSemantic, reset };
}

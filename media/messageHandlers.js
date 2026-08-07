//@ts-check

// 来自扩展的消息处理逻辑：updateMetadata / updateContent / updateSemantic / noContent 的处理。
// 以工厂函数形式创建，通过 ctx 共享 editor 引用、可变会话状态（state）、前端缓存、
// vscode 通信对象，以及内容更新、定义列表清理等回调。
// monaco / document / window 直接使用全局对象（与其它模块一致）。
//
// 对齐 VSCode ModelSemanticColoring 的异步着色时序：
//   1) 内容先到（updateContent/命中缓存）：随内容带上 legend，先写入前端 legend 再渲染，
//      使 Monaco 首帧就用完整 legend 建 styling；此刻 data 尚未到达，暂按 TextMate 着色。
//   2) data 后到（updateSemantic）：做过期校验后写入 data并 fire，Monaco 用已正确的 styling 上色。

export function createMessageHandlers(ctx) {
    const {
        editor,
        state,
        fileContentCache,
        vscode,
        updateEditorContent,
        clearDefinitionList,
        applySemanticTokens,
        setSemanticLegend
    } = ctx;

    // 安全调用语义 data 写入回调（默认模式下未提供该回调时静默跳过）
    function setSemantic(semantic) {
        if (typeof applySemanticTokens === 'function') {
            applySemanticTokens(semantic);
        }
    }

    // 安全调用「仅 legend」写入回调（内容阶段先行写入，供首帧建 styling）
    function setLegend(legend) {
        if (typeof setSemanticLegend === 'function') {
            setSemanticLegend(legend);
        }
    }

    // 收到元数据：保存定位信息，命中前端缓存则直接渲染，否则向后端请求完整内容
    function handleUpdateMetadata(message) {
        state.uri = message.uri;
        // 保存本次跳转的定位信息，供回源（updateContent）复用
        state.range = message.range;
        state.curLine = message.curLine;
        state.curColumn = message.curColumn;
        const requestVersion = message.documentVersion;

        // 检查前端缓存
        const cached = fileContentCache.get(state.uri);
        if (cached && cached.version === requestVersion) {
            // 缓存命中且版本匹配：刷新访问时间，使淘汰策略成为真正的 LRU
            // （淘汰时按 timestamp 升序踢最旧项，命中不刷新会退化为 FIFO，热点文件会被误淘汰）
            cached.timestamp = Date.now();
            // 记录当前渲染版本，供异步到达的 updateSemantic 做过期校验
            state.contentVersion = requestVersion;
            // 命中缓存：先恢复该版本的 legend（供首帧建 styling），再渲染。
            // legend 优先取缓存里单独存的 legend，否则退回 semantic.legend（若已缓存 data）。
            const cachedLegend = cached.legend || (cached.semantic && cached.semantic.legend) || null;
            setLegend(cachedLegend);
            // 若已缓存到data，恢复完整 semantic（含 data）；否则保持仅 legend、稍后异步补 data
            if (cached.semantic && Array.isArray(cached.semantic.data)) {
                setSemantic(cached.semantic);
            }
            // 直接使用缓存内容
            updateEditorContent(cached.content, {
                newUri: message.uri,
                languageId: message.languageId,
                range: message.range,
                scrollToLine: message.scrollToLine,
                curLine: message.curLine,
                curColumn: message.curColumn
            });
            // 对齐 VSCode：内容先出，data 异步补。缓存里尚无 data（从未取过/取过为空）时，
            // 主动向后端要一次（后端带 debounce + 版本校验，取到再以 updateSemantic覆盖）。
            if (!cached.semantic || !Array.isArray(cached.semantic.data)) {
                vscode.postMessage({
                    type: 'requestSemantic',
                    uri: state.uri,
                    documentVersion: requestVersion
                });
            }
        } else {
            // 缓存未命中或版本不匹配，请求完整内容
            // 如果版本不匹配，先清除旧缓存
            if (cached && cached.version !== requestVersion) {
                fileContentCache.delete(state.uri);
            }

            const contentHash = `${state.uri}:${requestVersion}`;

            vscode.postMessage({
                type: 'requestContent',
                contentHash: contentHash,
                // 直接带 uri，后端按 uri 现取（不拆 contentHash，uri 含冒号拆不可靠）
                uri: state.uri
            });
        }
    }

    // 收到完整内容：写入前端缓存并按成本感知策略淘汰，最后渲染编辑器
    function handleUpdateContent(message) {
        // 收到完整内容，缓存（使用 URI 作为键，自动覆盖旧版本）
        const cacheUri = message.uri;
        const body = message.body || '';
        // 记录当前渲染版本，供异步到达的 updateSemantic 做过期校验
        state.contentVersion = message.documentVersion;
        // 大文件无条件入缓存：每个跳转过的定义文件都缓存，命中即秒开
        fileContentCache.set(cacheUri, {
            version: message.documentVersion,
            content: body,
            lines: message.lineCount,  // 添加行数信息
            size: body.length,         // 添加内容大小（字符数，近似字节），用于淘汰评分
            timestamp: Date.now(),     // 添加时间戳
            // 对齐 VSCode：内容阶段不带 data（后端恒下发 null），data 由随后异步到达的
            // updateSemantic 补入并回填此条目；此处先缓存内容阶段带来的 legend。
            semantic: message.semantic || null,
            legend: message.legend || null,
            metadata: {
                languageId: message.languageId
            }
        });

        // 从配置中获取缓存条数上限（仅按条数限制，不限制内存）
        const cacheConfig = window.vsCodeEditorConfiguration?.contextEditorCfg || {};
        const cacheSizeLimit = cacheConfig.cacheSizeLimit || 30;

        // 成本感知淘汰：保留价值 = sizeWeight / age，淘汰价值最低者。
        // 大文件 miss 重新加载最贵（IPC 传输 MB 级字符串 + Monaco setValue），
        // 故 size 越大保留价值越高（用对数压缩，避免大文件碾压小文件）；
        // age 随时间单调增长，命中刷新 timestamp，确保再大的文件也不会永生。
        if (fileContentCache.size > cacheSizeLimit) {
            const SIZE_BASE = 50 * 1024; // 50KB 归一基准
            const now = Date.now();
            const valueOf = (entry) => {
                const age = Math.max(now - entry.timestamp, 1);
                const sizeWeight = 1 + Math.log2(1 + (entry.size || 0) / SIZE_BASE);
                return sizeWeight / age;
            };
            while (fileContentCache.size > cacheSizeLimit) {
                let victimKey = null;
                let minValue = Infinity;
                for (const [key, entry] of fileContentCache) {
                    if (key === cacheUri) continue; // 不淘汰刚写入的项
                    const v = valueOf(entry);
                    if (v < minValue) {
                        minValue = v;
                        victimKey = key;
                    }
                }
                if (!victimKey) break;
                fileContentCache.delete(victimKey);
            }
        }

        // 渲染前先写入本次 legend（对齐 VSCode：setValue 触发首帧着色时 getLegend() 需已是完整 legend）。
        // data尚未到达，此刻仅legend 就位，画面先按 TextMate 着色；data 到达后由 updateSemantic 覆盖。
        setLegend(message.legend);

        // 单槽命中(if 分支)时后端会回传 range；curLine/curColumn 两条分支都不回传，
        // 一律回退到 metadata 阶段保存的定位信息。
        updateEditorContent(message.body, {
            newUri: message.uri,
            languageId: message.languageId,
            range: message.range != null ? message.range : state.range,
            curLine: message.curLine != null ? message.curLine : state.curLine,
            curColumn: message.curColumn != null ? message.curColumn : state.curColumn
        });
    }

    // 无内容：清空定义列表，并在编辑器中显示 "No symbol found." 提示
    function handleNoContent(message) {
        // 隐藏左侧定义列表
        clearDefinitionList();

        // 检查编辑器是否已创建
        if (typeof editor !== 'undefined' && editor) {
            // 使用Monaco编辑器显示"No symbol found."并高亮"No symbol"
            document.getElementById('container').style.display = 'block';
            document.getElementById('main').style.display = 'none';

            // 设置编辑器内容
            const model = editor.getModel();
            if (model) {
                model.setValue('No symbol found.');
                editor.updateOptions({ lineNumbersMinChars: 1 });
                // 高亮"No symbol"（前9个字符），保存装饰ID，以便后续清除
                state.symboleDecorations = editor.deltaDecorations(state.symboleDecorations, [{
                    range: new monaco.Range(1, 1, 1, 1 + 9),
                    options: {
                        className: 'highlighted-symbol-range',
                        inlineClassName: 'highlighted-symbol-inline'
                    }
                }]);

                // 将光标移到超大列值，使其不可见
                editor.setSelection({
                    startLineNumber: 1,
                    startColumn: 999999,
                    endLineNumber: 1,
                    endColumn: 999999
                });

                // 强制编辑器重新布局以占满整个空间
                setTimeout(() => {
                    editor.layout();
                }, 100);
            }
        } else {
            // 编辑器未创建，使用原始HTML显示
            document.getElementById('container').style.display = 'none';
            document.getElementById('main').style.display = 'block';
            document.getElementById('main').innerHTML = message.body;
        }
    }

    // 收到异步补取的语义 token data（对齐 VSCode：内容先渲染、data 稍后覆盖）。
    // 做两道过期校验后写入并触发 Monaco 重新着色，同时回填前端缓存，保证命中缓存再渲染时着色一致。
    function handleUpdateSemantic(message) {
        // 校验 1：uri 必须仍是当前渲染的文件（跳转到别的文件后，旧文件的 semantic 直接丢弃）
        if (message.uri !== state.uri) {
            return;
        }
        // 校验 2：版本必须与当前渲染内容一致（内容在等待期间被编辑/切换则丢弃，对齐 getVersionId）
        if (typeof message.documentVersion === 'number'
            && state.contentVersion !== -1
            && message.documentVersion !== state.contentVersion) {
            return;
        }

        // 写入 data并触发 Monaco 向provider 重新索取 → 整篇覆盖着色
        // （legend 已在内容阶段就位，styling 正确，此处仅补 data）
        setSemantic(message.semantic);

        // 回填前端缓存：命中缓存再渲染时可直接恢复该版本的 semantic，避免再次往返
        const cached = fileContentCache.get(message.uri);
        if (cached && cached.version === message.documentVersion) {
            cached.semantic = message.semantic || null;
            if (message.semantic && message.semantic.legend) {
                cached.legend = message.semantic.legend;
            }
        }
    }

    return { handleUpdateMetadata, handleUpdateContent, handleNoContent, handleUpdateSemantic };
}

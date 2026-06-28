//@ts-check

// 来自扩展的消息处理逻辑：updateMetadata / updateContent / noContent 三类消息的处理。
// 以工厂函数形式创建，通过 ctx 共享 editor 引用、可变会话状态（state）、前端缓存、
// vscode 通信对象，以及内容更新、定义列表清理等回调。
// monaco / document / window 直接使用全局对象（与其它模块一致）。

export function createMessageHandlers(ctx) {
    const {
        editor,
        state,
        fileContentCache,
        vscode,
        updateEditorContent,
        clearDefinitionList,
        applySemanticTokens
    } = ctx;

    // 安全调用语义 token 写入回调（默认模式下未提供该回调时静默跳过）
    function setSemantic(semantic) {
        if (typeof applySemanticTokens === 'function') {
            applySemanticTokens(semantic);
        }
    }

    // 收到元数据：保存定位信息，命中前端缓存则直接渲染，否则向后端请求完整内容
    function handleUpdateMetadata(message) {
        state.uri = message.uri;
        // 保存本次跳转的定位信息，供回源（updateContent）复用
        state.range = message.range;
        state.curLine = message.curLine;
        const requestVersion = message.documentVersion;

        // 检查前端缓存
        const cached = fileContentCache.get(state.uri);
        if (cached && cached.version === requestVersion) {
            // 缓存命中且版本匹配：刷新访问时间，使淘汰策略成为真正的 LRU
            // （淘汰时按 timestamp 升序踢最旧项，命中不刷新会退化为 FIFO，热点文件会被误淘汰）
            cached.timestamp = Date.now();
            // 命中缓存：先恢复该版本的语义 token，再渲染，保证着色与内容一致
            setSemantic(cached.semantic);
            // 直接使用缓存内容
            updateEditorContent(cached.content, {
                newUri: message.uri,
                languageId: message.languageId,
                range: message.range,
                scrollToLine: message.scrollToLine,
                curLine: message.curLine
            });
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
        // 大文件无条件入缓存：每个跳转过的定义文件都缓存，命中即秒开
        fileContentCache.set(cacheUri, {
            version: message.documentVersion,
            content: body,
            lines: message.lineCount,  // 添加行数信息
            size: body.length,         // 添加内容大小（字符数，近似字节），用于淘汰评分
            timestamp: Date.now(),     // 添加时间戳
            semantic: message.semantic || null, // 与内容同版本缓存的语义 token
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

        // 渲染前先写入本次语义 token（setValue 触发重新着色时 provider 已能拿到数据）
        setSemantic(message.semantic);

        // 单槽命中(if 分支)时后端会回传 range/curLine；
        // 按 uri 现取(else 分支)时不回传，回退到 metadata 阶段保存的定位信息。
        updateEditorContent(message.body, {
            newUri: message.uri,
            languageId: message.languageId,
            range: message.range != null ? message.range : state.range,
            curLine: message.curLine != null ? message.curLine : state.curLine
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

    return { handleUpdateMetadata, handleUpdateContent, handleNoContent };
}

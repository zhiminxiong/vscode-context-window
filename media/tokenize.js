//@ts-check

// 解析后端透传的语义 token，找出指定位置（Monaco 1-based pos）所在的语义 token。
// 语义 token 按视口按需拉取并合并进「绝对坐标 token 池」（见 semanticRangeClient.js），
// 池内每项为 { line, char, len, type, mod }，按 (line, char) 升序，坐标为整文档 0-based 绝对坐标。
// 取色直接在 semanticState.tokenPool 上查命中目标位置的 token。
// 返回 { token: 语义类型名, modifiers: [...], startColumn, endColumn }，未命中返回 null。
export function semanticTokenAtPosition(pos, semanticState) {
    if (!semanticState || !semanticState.legend) {
        return null;
    }
    const types = semanticState.legend.tokenTypes || [];
    const mods = semanticState.legend.tokenModifiers || [];
    const targetLine = pos.lineNumber - 1; // 转 0-based
    const targetChar = pos.column - 1;

    const pool = semanticState.tokenPool;
    if (!Array.isArray(pool) || !pool.length) {
        return null;
    }
    for (const t of pool) {
        // 池按 (line, char) 升序，越过目标行即可提前结束
        if (t.line > targetLine) {
            break;
        }
        if (t.line === targetLine && targetChar >= t.char && targetChar < t.char + t.len) {
            const modifiers = [];
            for (let b = 0; b < mods.length; b++) {
                if (t.mod & (1 << b)) {
                    modifiers.push(mods[b]);
                }
            }
            return {
                token: types[t.type] || '',
                modifiers,
                startColumn: t.char + 1,
                endColumn: t.char + t.len + 1
            };
        }
    }
    return null;
}

// 获取指定位置所在的 token（携带跨行上下文重新分词，保证状态正确）

export function tokenAtPosition(model, editor, pos) {
    const lang = model.getLanguageId();
    // 必须从文档第 1 行开始分词，与渲染（Monaco 从文档顶部逐行维护分词状态）保持一致的上下文。
    // 若只取目标行附近的窗口，起点可能落在多行构造（块注释 / 模板字符串等）中间，导致分词状态错误、
    // 同一位置取到与渲染不同的 token。取色为低频操作，全量逐行（到目标行）可接受。
    const startLine = 1;
    const lines = [];
    for (let ln = startLine; ln <= pos.lineNumber; ln++) {
        lines.push(model.getLineContent(ln));
    }
    const allRows = monaco.editor.tokenize(lines.join('\n'), lang);
    const targetRow = allRows[pos.lineNumber - startLine] || [];
    const line = lines[lines.length - 1];
    const col0 = pos.column - 1;
    for (let i = 0; i < targetRow.length; i++) {
        const start = targetRow[i].offset;
        const end = (i + 1 < targetRow.length ? targetRow[i + 1].offset : line.length);
        if (col0 >= start && col0 < end) {
            return {
                startColumn: start + 1,
                endColumn: end + 1,
                text: line.slice(start, end),
                token: targetRow[i].type || ''
            };
        }
    }
    return null;
}

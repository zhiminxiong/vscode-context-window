//@ts-check

// 解析后端透传的语义 token，找出指定位置（Monaco 1-based pos）所在的语义 token。
// data 为 LSP 标准 5 元组 delta 编码 [ΔLine, ΔStartChar, length, tokenTypeIdx, tokenModifiers]，
// 坐标是整文档绝对坐标（首个 token 的 ΔLine 相对文档第 0 行）。
// 语义 token 按视口按需拉取（见 semanticRangeClient.js），因此依次在两处查找：
//   1) semanticState.data     —— 整文档兜底数据（该语言只有整文档 provider 时才有）
//   2) semanticState.segments —— 视口稀疏缓存，每段各自是一份完整的绝对坐标 delta 序列
// 返回 { token: 语义类型名, modifiers: [...], startColumn, endColumn }，未命中返回 null。
export function semanticTokenAtPosition(pos, semanticState) {
    if (!semanticState || !semanticState.legend) {
        return null;
    }
    const types = semanticState.legend.tokenTypes || [];
    const mods = semanticState.legend.tokenModifiers || [];
    const targetLine = pos.lineNumber - 1; // 转 0-based
    const targetChar = pos.column - 1;

    if (semanticState.data && semanticState.data.length) {
        const hit = findTokenInData(semanticState.data, types, mods, targetLine, targetChar);
        if (hit) {
            return hit;
        }
    }
    if (semanticState.segments) {
        for (const seg of semanticState.segments.values()) {
            if (!seg || !seg.data || !seg.data.length) {
                continue;
            }
            const hit = findTokenInData(seg.data, types, mods, targetLine, targetChar);
            if (hit) {
                return hit;
            }
        }
    }
    return null;
}

// 在一份 delta 编码的 token 序列里查找命中目标位置的 token
function findTokenInData(data, types, mods, targetLine, targetChar) {
    let line = 0;
    let char = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
        const dLine = data[i];
        const dStart = data[i + 1];
        const len = data[i + 2];
        const typeIdx = data[i + 3];
        const modBits = data[i + 4];

        if (dLine === 0) {
            char += dStart;
        } else {
            line += dLine;
            char = dStart;
        }

        if (line === targetLine && targetChar >= char && targetChar < char + len) {
            const modifiers = [];
            for (let b = 0; b < mods.length; b++) {
                if (modBits & (1 << b)) {
                    modifiers.push(mods[b]);
                }
            }
            return {
                token: types[typeIdx] || '',
                modifiers,
                startColumn: char + 1,
                endColumn: char + len + 1
            };
        }
        // 语义 token 按 (line, char) 升序排列，越过目标行即可提前结束
        if (line > targetLine) {
            break;
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

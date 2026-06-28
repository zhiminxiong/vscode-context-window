//@ts-check

// 解析后端透传的整文档语义 token，找出指定位置（Monaco 1-based pos）所在的语义 token。
// data 为 LSP 标准 5 元组 delta 编码 [ΔLine, ΔStartChar, length, tokenTypeIdx, tokenModifiers]。
// 返回 { token: 语义类型名, modifiers: [...], startColumn, endColumn }，未命中返回 null。
export function semanticTokenAtPosition(pos, semanticState) {
    if (!semanticState || !semanticState.data || !semanticState.legend) {
        return null;
    }
    const data = semanticState.data;
    const types = semanticState.legend.tokenTypes || [];
    const mods = semanticState.legend.tokenModifiers || [];
    const targetLine = pos.lineNumber - 1; // 转 0-based
    const targetChar = pos.column - 1;

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
    // Tokenize from line 1 up to the target line together, so cross-line
    // state (open parens, template strings, etc.) is correctly maintained.
    const CONTEXT_LINES = 100;
    const startLine = Math.max(1, pos.lineNumber - CONTEXT_LINES);
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

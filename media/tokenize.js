//@ts-check

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

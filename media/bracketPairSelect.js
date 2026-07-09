//@ts-check

// 「选中整对括号/引号（含定界符）」——webview 编辑器移植版。
// 对应扩展主编辑器 registerBracketPairSelectionOnDoubleClick（src/extension.ts）里的选定算法，
// 逻辑保持一致；差异仅在触发方式：VSCode 主编辑器是「左键双击」，此处由调用方约束为「严格右键双击」，
// 且仅在「非 pick token」且「开关 doubleClickSelectsBracketPair 开启」时启用、不干扰右键单击选词。
//
// 坐标：Monaco 的 lineNumber / column 都是 1 基；内部沿用扩展的 0 基 char 计算，映射 char = column - 1，
// 选区回写时再 +1 转回 Monaco 列。

// 开括号 → 对应闭括号（含尖括号 <>，用于模板/泛型 如 vector<int>）
const BRACKET_PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>' };
// 闭括号 → 对应开括号（用于「紧贴闭括号左侧」时向左回溯匹配的开括号）
const CLOSE_TO_OPEN = { ')': '(', ']': '[', '}': '{', '>': '<' };
// 引号字符：开闭同形（双引号 / 单引号 / 反引号），无对应 selectToBracket，需自行扫描配对。
const QUOTES = new Set(['"', "'", '`']);
// 「紧挨括号」允许的列容差：0 = 落点右邻必须就是括号（严格紧挨）。
const NEAR_BRACKET_TOLERANCE = 0;

// 判断 text[i] 是否被反斜杠转义（前导连续反斜杠为奇数个 → 被转义，如 \" 不是字符串边界）。
function isEscapedAt(text, i) {
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && text.charAt(j) === '\\'; j--) { backslashes++; }
    return backslashes % 2 === 1;
}

// 在同一行内为 quoteCol 处的引号 q 找配对引号，返回 [开引号列, 闭引号列]（含两端），找不到返回 undefined。
function findMatchingQuoteOnLine(lineText, quoteCol, q) {
    let count = 0;
    for (let i = 0; i < quoteCol; i++) {
        if (lineText.charAt(i) === q && !isEscapedAt(lineText, i)) { count++; }
    }
    if (count % 2 === 0) {
        // 开引号：向右找下一个未转义的同种引号作为闭引号
        for (let i = quoteCol + 1; i < lineText.length; i++) {
            if (lineText.charAt(i) === q && !isEscapedAt(lineText, i)) { return [quoteCol, i]; }
        }
    } else {
        // 闭引号：向左回溯上一个未转义的同种引号作为开引号
        for (let i = quoteCol - 1; i >= 0; i--) {
            if (lineText.charAt(i) === q && !isEscapedAt(lineText, i)) { return [i, quoteCol]; }
        }
    }
    return undefined;
}

// 判断 col 处字符是否位于同一行的某个字符串字面量（一对未转义引号）内部。
// 命中则返回其「内容区间」[start, end]（不含两端引号，闭区间）；否则 undefined。
function stringContentRangeAt(lineText, col) {
    let quote = '';
    let quoteStart = -1;
    for (let i = 0; i < lineText.length; i++) {
        const c = lineText.charAt(i);
        if (!QUOTES.has(c) || isEscapedAt(lineText, i)) { continue; }
        if (quote === '') {
            quote = c; quoteStart = i;
        } else if (c === quote) {
            if (quoteStart < col && col < i) { return { start: quoteStart + 1, end: i - 1 }; }
            quote = ''; quoteStart = -1;
        }
    }
    return undefined;
}

// 在同一行、限定区间 [lo, hi] 内，为 col 处的括号 ch 做纯文本配对（支持同类嵌套），
// 返回 [开括号列, 闭括号列]；找不到返回 undefined。用于字符串内部的括号选定。
function findMatchingBracketOnLine(lineText, col, ch, lo, hi) {
    if (BRACKET_PAIRS[ch]) {
        const close = BRACKET_PAIRS[ch];
        let depth = 0;
        for (let i = col; i <= hi; i++) {
            const c = lineText.charAt(i);
            if (c === ch) { depth++; }
            else if (c === close) { depth--; if (depth === 0) { return [col, i]; } }
        }
    } else {
        const open = CLOSE_TO_OPEN[ch];
        let depth = 0;
        for (let i = col; i >= lo; i--) {
            const c = lineText.charAt(i);
            if (c === ch) { depth++; }
            else if (c === open) { depth--; if (depth === 0) { return [i, col]; } }
        }
    }
    return undefined;
}

// 把 0 基的行内区间 [startChar, endChar]（闭区间，含两端字符）写为 Monaco 选区。
function selectCharRange(editor, line, startChar, endChar) {
    editor.setSelection({
        startLineNumber: line,
        startColumn: startChar + 1,
        endLineNumber: line,
        endColumn: endChar + 2 // 闭区间右端 +1 转独占，再 +1 转 1 基
    });
}

/**
 * 尝试在 position 处「紧挨括号/引号」时选中整对（含定界符）。命中并完成选中返回 true，否则 false（调用方回退默认行为）。
 * @param {any} editor  Monaco editor 实例
 * @param {{lineNumber:number, column:number}} position  点击位置（Monaco 1 基）
 */
export async function trySelectBracketPairAt(editor, position) {
    const model = editor.getModel();
    if (!model || !position) { return false; }
    const line = position.lineNumber;
    const lineText = model.getLineContent(line);
    const clickChar = position.column - 1; // 转 0 基

    // 以落点为基准，向右在容差内查找紧挨的括号/引号（落点右邻即目标）。
    let hitCol = -1;
    let hitChar = '';
    for (let d = 0; d <= NEAR_BRACKET_TOLERANCE; d++) {
        const c = lineText.charAt(clickChar + d);
        if (BRACKET_PAIRS[c] || CLOSE_TO_OPEN[c] || QUOTES.has(c)) { hitCol = clickChar + d; hitChar = c; break; }
        // 容差内遇到非空白实义字符则停止（避免误判为远处括号的紧挨）
        if (c !== '' && c !== ' ' && c !== '\t') { break; }
    }
    if (hitCol < 0) { return false; }

    // 命中引号：同行扫描配对引号，选中整对（含两端引号）。
    if (QUOTES.has(hitChar)) {
        const pair = findMatchingQuoteOnLine(lineText, hitCol, hitChar);
        if (pair) { selectCharRange(editor, line, pair[0], pair[1]); return true; }
        return false;
    }

    // 命中括号：先判断是否在字符串字面量内部。
    const strRange = stringContentRangeAt(lineText, hitCol);
    if (strRange) {
        // 字符串内：括号只是普通文本，selectToBracket（语言感知）会忽略它、误选外层语法括号。
        // 改为在该字符串范围内做纯文本配对，选中 [...] 本身。
        const pair = findMatchingBracketOnLine(lineText, hitCol, hitChar, strRange.start, strRange.end);
        if (pair) { selectCharRange(editor, line, pair[0], pair[1]); return true; }
        return false;
    }

    // 非字符串内：把光标定位到括号左边界（右邻即目标括号），交给 Monaco 内置命令
    // selectToBracket 选中整对（默认连同括号一起选），跨行/嵌套/语言感知都由它处理。
    editor.setPosition({ lineNumber: line, column: hitCol + 1 });
    const action = editor.getAction && editor.getAction('editor.action.selectToBracket');
    if (action) {
        await action.run();
        return true;
    }
    // 兜底：Monaco 无该 action 时，行内纯文本配对（仅同行有效）。
    const pair = findMatchingBracketOnLine(lineText, hitCol, hitChar, 0, lineText.length - 1);
    if (pair) { selectCharRange(editor, line, pair[0], pair[1]); return true; }
    return false;
}

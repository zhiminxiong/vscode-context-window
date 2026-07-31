//@ts-check

// 基于花括号配对的 Folding Range Provider（TS/JS），用于修复 sticky scroll 对
// 「{ 独占一行」（Allman / GNU 风格）支持不佳的问题。
//
// 背景：TS/JS 的 sticky scroll 走 indentationModel —— 其 outlineModel 依赖 Monaco 内置
// ts.worker 的 documentSymbol，而 worker 在 webview 中永不 resolve（与 hover 卡 Loading 同源）。
// 纯缩进模型只能把「后面出现更深缩进」的那一行当作标题行，Allman 风格里那一行恰好是孤立的 '{'：
//
//     export class JSFrameCounter        ← 缩进 0
//     {                                 ← 缩进 0，缩进模型认为这才是标题行
//         private static instance;       ← 缩进 4
//         public static Instance()      ← 缩进 4
//         {                             ← 缩进 4，与上一行同缩进
//             ...                       ← 缩进 8
//
// 于是粘附行显示无意义的 '{}'，而且 `Instance()` 与它后面的 '{' 缩进相同，缩进模型
// 根本不会为方法生成折叠区间 —— 方法这一层级整体丢失。
//
// 修复：自己提供 folding range。sticky 的 foldingProviderModel 优先于 indentationModel，
// 且 folding range 的起始行就是粘附行显示的那一行，因此只要把「孤立 '{'」的块起始行
// 上提到它前面那行真正的声明行，粘附行就与 VSCode 一致。
//
// 安全性：完全同步、不依赖 worker；解析不出任何区间时返回 null（**不能返回 []**，
// 空数组会被 Monaco 当成「有效的空结果」而不再回退），此时 sticky 与折叠都自动回退到缩进模型。

// 判断某个 '/' 处能否开始一个正则字面量（区分正则与除法的经典启发式）：
// 只看它前面紧邻的那个非空白字符 —— 若是标识符、数字、')' 、']' 则是除法，
// 若是运算符/分隔符或行首、或前面是 return/typeof 等关键字，则可以是正则。
const REGEX_ALLOWED_PREV_CHARS = '(,=:[!&|?{};+-*%<>~^';
const REGEX_ALLOWED_PREV_KEYWORD =
    /(?:^|[^$\w])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

function canStartRegex(emittedSoFar) {
    const trimmed = emittedSoFar.replace(/\s+$/, '');
    if (!trimmed) { return true; } // 行首
    const last = trimmed[trimmed.length - 1];
    if (REGEX_ALLOWED_PREV_CHARS.includes(last)) { return true; }
    return REGEX_ALLOWED_PREV_KEYWORD.test(trimmed);
}

// 从 '/' 开始找正则字面量的结束位置（返回结束 '/' 的下标；本行内找不到返回 -1）。
// 正则不能跨行，所以找不到结束就说明这其实是除法，调用方据此放弃掩码，避免误吃掉真实代码。
function findRegexEnd(line, slashIndex) {
    let inCharClass = false;
    for (let i = slashIndex + 1; i < line.length; i++) {
        const ch = line[i];
        if (ch === '\\') { i++; continue; }
        if (ch === '[') { inCharClass = true; continue; }
        if (ch === ']') { inCharClass = false; continue; }
        if (ch === '/' && !inCharClass) { return i; }
    }
    return -1;
}

// 把注释、字符串与正则字面量整体替换成等长空白，避免其中的花括号干扰配对。
// 保持长度不变是为了让「该行是否只有一个 '{'」「缩进宽度」等判断仍然成立。
// 块注释与模板字符串可以跨行，故状态在行间延续。
//
// 正则必须一并掩码：像 /^\s*namespace\s+(?:\{|$)/ 这样的正则里带着 '\{'，
// 不处理就会凭空多出一个未闭合的左花括号，之后所有区间的嵌套关系全部错位。
function maskCommentsAndStrings(lines) {
    const masked = [];
    let inBlockComment = false;
    let inTemplate = false;

    for (const line of lines) {
        let out = '';
        let i = 0;
        while (i < line.length) {
            const ch = line[i];
            const next = line[i + 1];

            if (inBlockComment) {
                if (ch === '*' && next === '/') { inBlockComment = false; out += '  '; i += 2; }
                else { out += ' '; i++; }
                continue;
            }
            if (inTemplate) {
                // 模板字符串内部一律视作字符串（含 ${} 里的内容）：两侧花括号同时被忽略，配对仍然平衡
                if (ch === '\\') { out += '  '; i += 2; continue; }
                if (ch === '`') { inTemplate = false; out += ' '; i++; continue; }
                out += ' '; i++;
                continue;
            }
            if (ch === '/' && next === '/') { break; } // 行注释：本行剩余部分直接丢弃
            if (ch === '/' && next === '*') { inBlockComment = true; out += '  '; i += 2; continue; }
            if (ch === '/' && canStartRegex(out)) {
                const end = findRegexEnd(line, i);
                if (end !== -1) {
                    out += ' '.repeat(end - i + 1);
                    i = end + 1;
                    continue;
                }
                // 本行没有闭合的 '/'，说明是除法而非正则：按普通字符处理
            }
            if (ch === '`') { inTemplate = true; out += ' '; i++; continue; }
            if (ch === '"' || ch === '\'') {
                const quote = ch;
                out += ' '; i++;
                while (i < line.length) {
                    if (line[i] === '\\') { out += '  '; i += 2; continue; }
                    if (line[i] === quote) { out += ' '; i++; break; }
                    out += ' '; i++;
                }
                continue;
            }
            out += ch;
            i++;
        }
        masked.push(out);
    }
    return masked;
}

// 缩进宽度（tab 按 tabSize 展开），用于识别「多行签名的续行」
function indentWidth(line, tabSize) {
    let width = 0;
    for (const ch of line) {
        if (ch === ' ') { width++; }
        else if (ch === '\t') { width += tabSize - (width % tabSize); }
        else { break; }
    }
    return width;
}

// 为「孤立 '{'」找到真正的声明行（返回 0 基行号；找不到返回 -1 表示不做上提）。
//
// 规则：从 '{' 往上找第一个有内容的行（注释已被掩码成空白，天然跳过）；
//   · 若它以 '}' 开头、或以 ';' '}' '{' 结尾，说明 '{' 前面是一条已结束的语句或另一个块，
//     这个 '{' 是裸块（bare block），不属于任何声明 —— 不上提；
//   · 若它的缩进比 '{' 更深，说明是多行签名的续行（如参数列表换行），继续往上找签名首行。
function findDeclarationLine(masked, braceIndex, tabSize) {
    const braceIndent = indentWidth(masked[braceIndex], tabSize);
    for (let i = braceIndex - 1; i >= 0; i--) {
        const text = masked[i].trim();
        if (!text) { continue; }
        if (text.startsWith('}') || text.endsWith(';') || text.endsWith('}') || text.endsWith('{')) {
            return -1;
        }
        if (indentWidth(masked[i], tabSize) > braceIndent) { continue; }
        return i;
    }
    return -1;
}

export function createBraceFoldingRangeProvider(monaco) {
    return {
        provideFoldingRanges: (model) => {
            let lines;
            let tabSize = 4;
            try {
                lines = model.getValue().split('\n');
                tabSize = model.getOptions().tabSize || 4;
            } catch (_) {
                return null;
            }
            if (!lines.length) { return null; }

            const masked = maskCommentsAndStrings(lines);
            const ranges = [];
            /** @type {number[]} 未闭合花括号的块起始行（1 基） */
            const openStack = [];

            for (let i = 0; i < masked.length; i++) {
                const text = masked[i];
                const isLoneBrace = text.trim() === '{';
                let isFirstBraceOnLine = true;

                for (let j = 0; j < text.length; j++) {
                    const ch = text[j];
                    if (ch === '{') {
                        let startLine = i + 1;
                        if (isFirstBraceOnLine && isLoneBrace) {
                            const declIndex = findDeclarationLine(masked, i, tabSize);
                            if (declIndex !== -1) { startLine = declIndex + 1; }
                        }
                        openStack.push(startLine);
                        isFirstBraceOnLine = false;
                    } else if (ch === '}') {
                        const startLine = openStack.pop();
                        if (startLine === undefined) { continue; } // 多余的 '}'（掩码漏判/语法不完整），忽略
                        // 与折叠语义一致：折叠后保留 '}' 所在行可见，故区间末行取它的上一行。
                        // sticky 侧会按 [start, end + 1] 判定包含关系，覆盖范围与缩进模型等价。
                        const endLine = i;
                        if (endLine > startLine) { ranges.push({ start: startLine, end: endLine }); }
                    }
                }
            }

            // 一个区间都没有：返回 null 让 Monaco 回退到缩进模型（返回 [] 会被当成有效空结果）
            return ranges.length ? ranges : null;
        }
    };
}

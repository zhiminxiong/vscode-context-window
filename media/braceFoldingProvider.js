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

// 统计一段（已掩码的）文本里「未配对的右括号数量」：')'/']' 记 +1，'('/'[' 记 -1。
// 用于识别多行签名——例如 constructor 参数列表换行后，'{' 所在行前面只剩一个 ')'。
function netClosers(str) {
    let n = 0;
    for (const ch of str) {
        if (ch === ')' || ch === ']') { n++; }
        else if (ch === '(' || ch === '[') { n--; }
    }
    return n;
}

// 前一行是否是「已结束的语句 / 另一个块」的边界，用于识别裸块（bare block）。
function isBareBlockBoundary(trimmed) {
    return trimmed.startsWith('}') || trimmed.endsWith(';') || trimmed.endsWith('}') || trimmed.endsWith('{');
}

// 为「块起始 '{'」找到真正的声明行（返回 0 基行号；找不到返回 -1 表示不做上提）。
// braceCol 是 '{' 在该行中的列下标，用于处理换行签名（如 K&R 风格的 ') {'）。
//
// 规则：从 '{' 往上找第一个有内容的行（注释已被掩码成空白，天然跳过）；
//   · 若正处在未闭合的 ()/[] 括号组内（多行签名的续行，如参数列表换行），
//     继续上溯到开启该括号组的那一行（即 constructor(...) 的首行）；
//   · 否则沿用原有规则：以 '}' 开头、或以 ';' '}' '{' 结尾 → 裸块，不上提；
//     缩进更深 → 续行，继续往上。
function findDeclarationLine(masked, braceIndex, braceCol, tabSize) {
    const braceIndent = indentWidth(masked[braceIndex], tabSize);
    // '{' 左侧若残留未闭合的 ')'/']'（如 ') {'），先按其数量给 depth 播种。
    let depth = netClosers(masked[braceIndex].slice(0, braceCol));

    for (let i = braceIndex - 1; i >= 0; i--) {
        const text = masked[i];
        const trimmed = text.trim();
        if (!trimmed) { continue; }

        if (depth > 0) {
            // 仍在多行签名的括号组内：继续上溯，直到找到开括号所在行。
            depth += netClosers(text);
            if (depth <= 0) {
                return isBareBlockBoundary(trimmed) ? -1 : i;
            }
            continue;
        }

        // 该行本身是「签名尾」（只有右括号，如独占一行的 ')'）：进入括号组继续上溯。
        const nc = netClosers(text);
        if (nc > 0) { depth = nc; continue; }

        if (isBareBlockBoundary(trimmed)) { return -1; }
        if (indentWidth(text, tabSize) > braceIndent) { continue; }
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
                let isFirstBraceOnLine = true;

                for (let j = 0; j < text.length; j++) {
                    const ch = text[j];
                    if (ch === '{') {
                        let startLine = i + 1;
                        // 是否尝试把块起始行上提到真正的声明行，取决于 '{' 左侧内容（已掩码）：
                        //   · netClosers > 0：左侧净剩右括号（如换行签名的 ') {'、'if (...\n) {'），
                        //     说明签名在上面的行开启 —— 上提，回溯到签名首行（保证 sticky 完整、折叠与 VSCode 一致）。
                        //   · netClosers == 0 且左侧全为空白：孤立 '{'（Allman/GNU 风格）—— 上提到声明行。
                        //   · 其余（如 'foo() {' 本行自闭合、'=> {'、'= {' 行内起块）：保持本行，不上提。
                        const head = text.slice(0, j);
                        const nc = netClosers(head);
                        const shouldLift = isFirstBraceOnLine && (nc > 0 || (nc === 0 && head.trim() === ''));
                        if (shouldLift) {
                            const declIndex = findDeclarationLine(masked, i, j, tabSize);
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

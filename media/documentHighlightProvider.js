//@ts-check

// 「光标处同词高亮」（occurrencesHighlight）的注释/字符串感知 Provider。
//
// 关键：本项目用 TextMate 语法（setTokensProvider）着色，monaco.editor.tokenize
// 走的是 Monarch 内置分词、拿不到 TextMate scope，故判断注释必须走 textmateClient
// 的 getScopeAtPosition（真实 scope 栈，含 comment./string.）。Monarch 仅作回退。
//
// 本 provider 的 score 高于内置文本兜底，会被 WordHighlighter 优先采用：
//   - 光标落在注释 / 字符串内 → 返回空数组 []（有效的「无高亮」结果，
//     且能阻止回退到文本兜底），对齐 VSCode 主编辑器；
//   - 其余位置 → 用 findMatches 做同词匹配，恒定「全词 + 区分大小写」，与 VSCode 原生
//     文本兜底 provider（TextualDocumentHighlightProvider）完全一致，不读查找框开关。

import { tokenAtPosition } from './tokenize.js';
import { getScopeAtPosition, isTextmateEnabled } from './textmateClient.js';

// 全局仅注册一次的护栏（registerDocumentHighlightProvider 是按 languageId 全局注册，
// 每次建 editor 都注册会叠加多个 provider）。
let registered = false;

// 判断某位置是否落在注释/字符串里。优先用 TextMate scope，回退到 Monarch token type。
function isCommentOrString(model, editor, position) {
    // 1) 首选：TextMate 真实 scope 栈
    try {
        if (isTextmateEnabled()) {
            const info = getScopeAtPosition(model, position);
            if (info && Array.isArray(info.scopes)) {
                const hit = info.scopes.some((s) => {
                    const x = String(s).toLowerCase();
                    return x.startsWith('comment') || x.startsWith('string')
                        || x.includes('.comment') || x.includes('.string');
                });
                if (hit) {
                    return true;
                }
            }
        }
    } catch (_) { /* 忽略，走回退 */ }

    // 2) 回退：Monarch 内置分词的 token type
    try {
        const t = tokenAtPosition(model, editor, position);
        const type = (t && t.token ? t.token : '').toLowerCase();
        if (type.includes('comment') || type.includes('string')) {
            return true;
        }
    } catch (_) { /* 忽略 */ }

    return false;
}

// VSCode 原生文本兜底 provider 使用的固定单词分隔符常量（来自 monaco-editor 的
// TextualDocumentHighlightProvider）。占据 findMatches 第 5 个参数 =恒定「全词匹配」。
const USUAL_WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

export function registerCommentAwareHighlight(monaco, editor) {
    if (registered) {
        return;
    }
    registered = true;

    monaco.languages.registerDocumentHighlightProvider('*', {
        provideDocumentHighlights(model, position) {
            const word = model.getWordAtPosition(position);
            if (!word) {
                // 返回 [] 是有效结果，可阻止回退到内置文本兜底 provider。
                return [];
            }

            // 注释/字符串里的词不参与同词高亮，对齐 VSCode 主编辑器。
            if (isCommentOrString(model, editor, position)) {
                return [];
            }

            // 匹配当前词的所有出现处。恒定「全词 + 区分大小写」，与 VSCode 原生
            // TextualDocumentHighlightProvider 一致，不读查找框的 Match Whole Word 开关。
            const matches = model.findMatches(
                word.word,
                true,                // searchScope=整个模型
                false,                  // isRegex
                true,                   // matchCase（区分大小写）
                USUAL_WORD_SEPARATORS,  // wordSeparators=恒定全词匹配
                false                   // captureMatches
            );
            return matches.map((m) => ({ range: m.range }));
        }
    });
}

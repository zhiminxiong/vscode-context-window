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
//   - 其余位置 → 用 findMatches 做同词匹配。匹配是否「全词」跟随查找框(find widget)的
//     「Match Whole Word (Alt+W)」开关：开=全词匹配，关=子串匹配。

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

// 读取查找框(find widget)的「Match Whole Word」开关状态。默认 true（与 VSCode 原生
// occurrencesHighlight 兜底一致：全词匹配）。读不到 find controller 时同样回退到 true。
function isWholeWordEnabled(editor) {
    try {
        const finder = editor.getContribution && editor.getContribution('editor.contrib.findController');
        const state = finder && finder.getState && finder.getState();
        if (state && typeof state.wholeWord === 'boolean') {
            return state.wholeWord;
        }
    } catch (_) { /* 忽略，回退默认 */ }
    return true;
}

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

            // 匹配当前词的所有出现处。是否「全词」跟随查找框的 Match Whole Word 开关：
            //   开 → 传 wordSeparators，findMatches 只匹配完整单词（VSCode 原生行为）；
            //   关 → 传 null，退化为子串匹配。
            const wholeWord = isWholeWordEnabled(editor);
            const wordSeparators = wholeWord
                ? ((model.getOptions && model.getOptions().wordSeparators) || null)
                : null;
            const matches = model.findMatches(
                word.word,
                true,   // searchScope=整个模型
                false,  // isRegex
                true,   // matchCase（区分大小写，与 VSCode 原生一致）
                wordSeparators,
                false   // captureMatches
            );
            return matches.map((m) => ({ range: m.range }));
        }
    });
}

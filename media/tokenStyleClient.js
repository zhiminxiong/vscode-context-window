//@ts-check

// 获取某 token 当前「实际生效」的样式，用于取色面板取初值。
//
// 直接复用 editorTheme 的 getEffectiveTokenStyle —— 它用与 Monaco 完全相同的合并规则集
// （默认 themeSemanticRules + 用户自定义）做最长前缀匹配，保证面板显示的颜色/粗体
// 与编辑器实际渲染一致；不再走扩展端往返，避免「后端只查用户规则」与「前端默认规则」
// 两套逻辑不一致（例如用户宽泛 keyword 规则遮蔽默认精确 keyword.control.loop）。

import { getEffectiveTokenStyle, isLightTheme } from './editorTheme.js';

export async function requestTokenStyle(token) {
    try {
        return getEffectiveTokenStyle(token, isLightTheme());
    } catch (e) {
        return { found: false };
    }
}

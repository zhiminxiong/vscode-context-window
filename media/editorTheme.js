//@ts-check

// Monaco 主题相关：根据 VS Code 颜色变量与上下文配置生成自定义主题

import { getCssVars } from './colorUtils.js';

// 语义 token 类型 → 默认着色（仿 VSCode Dark+/Light+）。
// standalone Monaco 用主题 rules 的 token 字段当作 scope 匹配语义类型名，
// 因此这里以「语义类型名」为 token 给出默认色，保证未自定义时也有合理着色，
// 与后端透传的语义分类保持一致。用户在 lightThemeRules/darkThemeRules 中的同名规则会覆盖默认。
const DEFAULT_SEMANTIC_RULES_DARK = [
    { token: 'namespace', foreground: '4EC9B0' },
    { token: 'type', foreground: '4EC9B0' },
    { token: 'class', foreground: '4EC9B0' },
    { token: 'struct', foreground: '4EC9B0' },
    { token: 'interface', foreground: '4EC9B0' },
    { token: 'enum', foreground: '4EC9B0' },
    { token: 'typeParameter', foreground: '4EC9B0' },
    { token: 'function', foreground: 'DCDCAA' },
    { token: 'method', foreground: 'DCDCAA' },
    { token: 'macro', foreground: 'DCDCAA' },
    { token: 'decorator', foreground: 'DCDCAA' },
    { token: 'variable', foreground: '9CDCFE' },
    { token: 'parameter', foreground: '9CDCFE' },
    { token: 'property', foreground: '9CDCFE' },
    { token: 'field', foreground: '9CDCFE' },
    { token: 'enumMember', foreground: '4FC1FF' },
    { token: 'event', foreground: '4FC1FF' },
    { token: 'keyword', foreground: '569CD6' },
    { token: 'comment', foreground: '6A9955' },
    { token: 'string', foreground: 'CE9178' },
    { token: 'number', foreground: 'B5CEA8' },
    { token: 'regexp', foreground: 'D16969' },
    { token: 'operator', foreground: 'D4D4D4' }
];

const DEFAULT_SEMANTIC_RULES_LIGHT = [
    { token: 'namespace', foreground: '267F99' },
    { token: 'type', foreground: '267F99' },
    { token: 'class', foreground: '267F99' },
    { token: 'struct', foreground: '267F99' },
    { token: 'interface', foreground: '267F99' },
    { token: 'enum', foreground: '267F99' },
    { token: 'typeParameter', foreground: '267F99' },
    { token: 'function', foreground: '795E26' },
    { token: 'method', foreground: '795E26' },
    { token: 'macro', foreground: '795E26' },
    { token: 'decorator', foreground: '795E26' },
    { token: 'variable', foreground: '001080' },
    { token: 'parameter', foreground: '001080' },
    { token: 'property', foreground: '001080' },
    { token: 'field', foreground: '001080' },
    { token: 'enumMember', foreground: '0070C1' },
    { token: 'event', foreground: '0070C1' },
    { token: 'keyword', foreground: '0000FF' },
    { token: 'comment', foreground: '008000' },
    { token: 'string', foreground: 'A31515' },
    { token: 'number', foreground: '098658' },
    { token: 'regexp', foreground: '811F3F' },
    { token: 'operator', foreground: '000000' }
];

// declaration 修饰符：standalone Monaco 的主题 trie 只支持「左起前缀匹配」，
// 无法表达 VSCode 的 "*.declaration"（左侧通配）。因此为每个语义类型逐一生成
// "type.declaration" 规则——沿用基础类型色并加粗，以区分「声明处」标识符，
// 效果对齐 VSCode 对 declaration 修饰符的强调。颜色随基础规则自动同步。
function withDeclarationRules(baseRules) {
    const declRules = baseRules.map(r => ({
        token: `${r.token}.declaration`,
        foreground: r.foreground,
        fontStyle: 'bold'
    }));
    return [...baseRules, ...declRules];
}

// 默认语义规则来源：优先用扩展端从「当前 VSCode 主题」解析出的真实配色（themeSemanticRules），
// 它已包含各类型及 *.declaration 变体；解析失败（undefined/空）时回退到硬编码的 Dark+/Light+ 兜底色。
// 这样未自定义时也能贴合用户实际主题，而不是写死一套颜色。
function getBaseSemanticRules(light) {
    const themeRules = window.vsCodeEditorConfiguration?.themeSemanticRules;
    if (Array.isArray(themeRules) && themeRules.length) {
        return themeRules;
    }
    return withDeclarationRules(light ? DEFAULT_SEMANTIC_RULES_LIGHT : DEFAULT_SEMANTIC_RULES_DARK);
}

// 扩展端下发的「全部 textmate scope → 颜色」规则（仅在非默认模式 / useDefaultTokenizer 关闭、TextMate 接管基础层时下发）。
// 用于真实 TextMate 分词后，让 Monaco 主题 trie 能为任意 scope（keyword.control.flow.cpp、
// string.quoted.double.cpp 等）着色。未启用时返回空数组，完全不影响原有行为。
function getBaseTextmateRules() {
    const r = window.vsCodeEditorConfiguration?.themeTextmateRules;
    return Array.isArray(r) ? r : [];
}

// 合并规则。顺序：textmate 基础层规则 → 语义类型默认 → 用户自定义。
// 这样既保证：
//   - 语义 token（单段类型名如 variable/keyword）由「语义默认/用户」覆盖 textmate 同名根 scope（语义层优先）；
//   - 基础语法层的多段 scope（keyword.control.flow.cpp 等）由 textmate 规则按最长前缀命中（基础层精确）。
// Monaco 取最后匹配，故用户规则始终最高优先级。
function mergeThemeRules(userRules, light) {
    const textmate = getBaseTextmateRules();
    const defaults = getBaseSemanticRules(light);
    const user = Array.isArray(userRules) ? userRules : [];
    return [...textmate, ...defaults, ...user];
}

// 规整主题规则的 foreground 为 Monaco 接受的格式：去掉前导 '#'，并把带 alpha 的 8 位 hex 截断为 6 位
// （Monaco 的 token 规则颜色为不含 '#' 的 hex，且不支持 alpha）。非 hex 字符串保持原样。
// 必须规整的原因：右键取色弹窗的 <input type=color> 返回 "#rrggbb"（带 '#'），若直接喂给
// monaco.editor.defineTheme，Monaco 会判其非法而丢弃该 foreground、仅保留 fontStyle，使该 token 颜色
// 回退继承父 scope（表现为"加粗对、颜色错"，如 if 渲染成蓝色加粗而非自定义红色）。
function sanitizeRuleColors(rules) {
    return rules.map(r => {
        if (!r || typeof r.foreground !== 'string') { return r; }
        let fg = r.foreground.trim();
        if (fg.startsWith('#')) { fg = fg.slice(1); }
        if (/^[0-9a-fA-F]{8}$/.test(fg)) { fg = fg.slice(0, 6); }
        return fg === r.foreground ? r : { ...r, foreground: fg };
    });
}

// 按 Monaco 主题 trie 的「最长前缀匹配」规则，查询某个 token（如 "enum.declaration"）
// 命中的默认语义样式。先精确匹配，未命中则逐段去掉尾部再试（enum.declaration → enum）。
// 用于取色面板取「当前生效色」初值：后端只存用户自定义规则，查不到时回退到这里的默认规则，
// 使面板显示的颜色/粗体与编辑器实际渲染一致。
export function getDefaultSemanticStyle(token, light) {
    const rules = getBaseSemanticRules(light);
    let t = String(token || '');
    while (t) {
        const r = rules.find(x => x.token === t);
        if (r) return { foreground: r.foreground, fontStyle: r.fontStyle || '' };
        const i = t.lastIndexOf('.');
        if (i <= 0) break;
        t = t.slice(0, i);
    }
    return null;
}

// 语义 token 的「选择器匹配」（对齐 VSCode 语义着色，而非 TextMate 前缀匹配）。
// VSCode 的语义规则形如 "class.constructorOrDestructor"：只要 token 的类型相同、且规则里的修饰符是
// token 修饰符的子集即命中（与修饰符出现顺序、是否还有其它修饰符无关），最具体者（修饰符更多）优先，
// 同特异性时后注册（数组更靠后）覆盖。
//
// 必须这样做的原因：Monaco standalone 把语义 token 拼成「类型 + 全部修饰符(legend 顺序)」再做 TextMate
// 最长前缀匹配，如 class.declaration.definition.constructorOrDestructor.classScope，此时
// "class.constructorOrDestructor" 不是它的前缀（中间隔着 declaration/definition），永远命中不到。
// 返回最匹配的那条规则（或 null）；取色弹窗与渲染补丁共用，保证两者一致。
export function selectSemanticRule(token, light) {
    const rules = mergeThemeRules(window.vsCodeEditorConfiguration?.customThemeRules, light);
    const parts = String(token || '').split('.');
    const type = parts[0];
    const mods = parts.slice(1);
    let best = null, bestScore = -1, bestIdx = -1;
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (!r || typeof r.token !== 'string') { continue; }
        const rp = r.token.split('.');
        if (rp[0] !== type) { continue; }
        const rMods = rp.slice(1);
        let subset = true;
        for (const m of rMods) { if (mods.indexOf(m) < 0) { subset = false; break; } }
        if (!subset) { continue; }
        const score = rMods.length;
        // 特异性更高，或同特异性但更靠后（后端已保证「类型专属」组合排在「通配」组合之后）
        if (score > bestScore || (score === bestScore && i >= bestIdx)) {
            best = r; bestScore = score; bestIdx = i;
        }
    }
    return best;
}

// 计算某 token 在编辑器里「实际生效」的样式：用与 Monaco 完全相同的合并规则集
// （默认 themeSemanticRules + 用户自定义，用户在后覆盖）。
// - 语义 token（isSemantic=true）：走 VSCode 选择器匹配（见 selectSemanticRule）。
// - 基础语法层 token（Monarch/TextMate scope，如 keyword.control.flow.cpp）：走最长前缀匹配，
//   同一前缀层级取最后命中（与 Monaco trie 的「后注册覆盖」一致）。
// 取色面板用它取初值，保证面板显示 === 编辑器实际渲染。
export function getEffectiveTokenStyle(token, light, isSemantic) {
    if (isSemantic) {
        const r = selectSemanticRule(token, light);
        if (r) { return { found: true, foreground: r.foreground, fontStyle: r.fontStyle || '' }; }
        return { found: false };
    }
    const rules = mergeThemeRules(window.vsCodeEditorConfiguration?.customThemeRules, light);
    let t = String(token || '');
    while (t) {
        let found = null;
        for (let i = rules.length - 1; i >= 0; i--) {
            if (rules[i] && rules[i].token === t) { found = rules[i]; break; }
        }
        if (found) { return { found: true, foreground: found.foreground, fontStyle: found.fontStyle || '' }; }
        const i = t.lastIndexOf('.');
        if (i <= 0) break;
        t = t.slice(0, i);
    }
    return { found: false };
}

export function applyMonacoTheme(vsCodeEditorConfiguration, contextEditorCfg, light) {
    // 性能优化：一次性读取所有需要的 CSS 变量，避免每个颜色键各自触发一次 getComputedStyle
    const v = getCssVars([
        '--vscode-editor-background',
        '--vscode-editor-foreground',
        '--vscode-editor-selectionBackground',
        '--vscode-editor-inactiveSelectionBackground',
        '--vscode-editor-selectionHighlightBackground',
        '--vscode-editor-findMatchHighlightBackground',
        '--vscode-editorGutter-background',
        '--vscode-editorGutter-addedBackground',
        '--vscode-editorGutter-modifiedBackground',
        '--vscode-editorGutter-deletedBackground',
        '--vscode-editorLineNumber-foreground',
        '--vscode-editorLineNumber-activeForeground',
        '--vscode-editorLineNumber-dimmedForeground',
        '--vscode-foreground',
        '--vscode-editorIndentGuide-background',
        '--vscode-editorIndentGuide-activeBackground',
        '--vscode-editor-lineHighlightBackground',
        '--vscode-editor-lineHighlightBorder',
    ]);

    // 先收集候选颜色，然后清理 undefined
    const candidateColors = {
        'editor.background': v['--vscode-editor-background'],
        'editor.foreground': v['--vscode-editor-foreground'],
        "editor.selectionBackground": contextEditorCfg.selectionBackground || v['--vscode-editor-selectionBackground'] || "#07c2db71",
        //"editor.selectionForeground": "#ffffffff",
        "editor.inactiveSelectionBackground": contextEditorCfg.inactiveSelectionBackground || v['--vscode-editor-inactiveSelectionBackground'] || "#07c2db71",
        "editor.selectionHighlightBackground": contextEditorCfg.selectionHighlightBackground || v['--vscode-editor-selectionHighlightBackground'] || "#5bdb0771",
        "editor.selectionHighlightBorder": contextEditorCfg.selectionHighlightBorder || "#5bdb0791",
        "editor.findMatchBackground": v['--vscode-editor-findMatchHighlightBackground'] || "#F4D03F",
        'editorGutter.background': v['--vscode-editorGutter-background'] || v['--vscode-editor-background'],
        'editorGutter.addedBackground': v['--vscode-editorGutter-addedBackground'],
        'editorGutter.modifiedBackground': v['--vscode-editorGutter-modifiedBackground'],
        'editorGutter.deletedBackground': v['--vscode-editorGutter-deletedBackground'],
        'editorLineNumber.foreground': v['--vscode-editorLineNumber-foreground'] || v['--vscode-foreground'],
        'editorLineNumber.activeForeground': v['--vscode-editorLineNumber-activeForeground'] || v['--vscode-foreground'],
        'editorLineNumber.dimmedForeground': v['--vscode-editorLineNumber-dimmedForeground'] || v['--vscode-editorLineNumber-foreground'],
        'editorIndentGuide.background': v['--vscode-editorIndentGuide-background'],
        'editorIndentGuide.activeBackground': v['--vscode-editorIndentGuide-activeBackground'],
        'editor.lineHighlightBackground': v['--vscode-editor-lineHighlightBackground'],
        'editor.lineHighlightBorder': v['--vscode-editor-lineHighlightBorder'],
    };

    const colors = {};
    for (const [k, val] of Object.entries(candidateColors)) {
        if (typeof val === 'string') colors[k] = val; // 仅保留有效字符串
    }

    const finalThemeRules = sanitizeRuleColors(mergeThemeRules(vsCodeEditorConfiguration.customThemeRules, light));

    monaco.editor.defineTheme('custom-vs', {
        base: light ? 'vs' : 'vs-dark',
        inherit: true,
        // 语义 token 类型默认色 + 用户自定义规则（用户覆盖默认）；
        // sanitizeRuleColors 规整颜色为 Monaco 接受的无 '#' hex，避免右键取色保存的 "#rrggbb" 被丢弃。
        rules: finalThemeRules,
        colors
    });
}

// 让「语义着色渲染」也走 VSCode 选择器匹配（Monaco standalone 默认是 TextMate 前缀匹配，
// 命中不到 class.constructorOrDestructor 这类「类型+特定修饰符」组合规则）。
//
// 做法：补丁当前主题实例原型上的 getTokenStyleMetadata —— 它是语义 token 取样式的渲染入口，
// 原实现为 this.tokenTheme._match([type, ...modifiers].join('.'))。我们先用 selectSemanticRule 选出最
// 匹配的规则（如 class.constructorOrDestructor），再把该规则的修饰符回灌给原始方法，让 Monaco 用自己
// 已编译的颜色表解析出正确的颜色索引与字体样式——零位运算、零硬编码，且与取色弹窗共用同一匹配函数，
// 保证「弹窗显示 === 编辑器渲染」。
// 注意：依赖 standalone 内部成员（editor._standaloneThemeService / theme.getTokenStyleMetadata /
// theme.tokenTheme._match），升级 monaco-editor 版本后需重新验证。
export function installSemanticRenderMatch(editor) {
    try {
        const svc = editor && editor._standaloneThemeService;
        if (!svc || typeof svc.getColorTheme !== 'function') { return; }
        const theme = svc.getColorTheme();
        if (!theme) { return; }
        const proto = Object.getPrototypeOf(theme);
        if (!proto || proto.__ctxSemanticMatchPatched) { return; }
        const original = proto.getTokenStyleMetadata;
        if (typeof original !== 'function') { return; }
        proto.getTokenStyleMetadata = function (type, modifiers, modelLanguage) {
            try {
                const token = [type].concat(modifiers || []).join('.');
                const best = selectSemanticRule(token, isLightTheme());
                if (best && typeof best.token === 'string') {
                    const bestMods = best.token.split('.').slice(1);
                    // 用匹配规则的修饰符回灌：原始内部会拼成 best.token 再走 trie，
                    // 取到该规则编译后的颜色索引/字体样式。
                    return original.call(this, type, bestMods, modelLanguage);
                }
                // 没有任何匹配的语义配色规则（如 modifier/label 等我们未映射的语义类型）：
                // 返回 undefined → Monaco 标记 NO_STYLING → 该语义 token 不发出，
                // 从而让底层 TextMate 着色透出（对齐 VSCode：override 由 storage.modifier 上色，而非被语义层盖成默认色）。
                // 注意：原始实现对未命中类型会返回「默认前景色」从而强行覆盖底色，导致显示为黑色——这正是要修正的点。
                return undefined;
            } catch (_) {
                // 异常兜底：维持原始行为，避免取色完全失效
                return original.call(this, type, modifiers, modelLanguage);
            }
        };
        try { Object.defineProperty(proto, '__ctxSemanticMatchPatched', { value: true, enumerable: false }); }
        catch (_) { proto.__ctxSemanticMatchPatched = true; }
    } catch (e) {
        console.warn('[context-window] install semantic render match failed:', e);
    }
}

export function isLightTheme() {
    return window.vsCodeEditorConfiguration?.theme === 'vs';
    // const contextEditorCfg = window.vsCodeEditorConfiguration.contextEditorCfg || {};
    // if (!contextEditorCfg.useDefaultTokenizer)
    //     light = true; // 如果不使用默认主题，则强制使用自定义浅色主题
    // return light;
}

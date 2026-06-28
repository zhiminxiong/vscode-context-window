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

// 合并默认语义规则与用户自定义规则：默认在前、用户在后，
// Monaco 取最后匹配，使用户的同名规则覆盖默认。
function mergeThemeRules(userRules, light) {
    const defaults = getBaseSemanticRules(light);
    const user = Array.isArray(userRules) ? userRules : [];
    return [...defaults, ...user];
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

// 计算某 token 在编辑器里「实际生效」的样式：用与 Monaco 完全相同的合并规则集
// （默认 themeSemanticRules + 用户自定义，用户在后覆盖）做最长前缀匹配，
// 且同一前缀层级取最后命中的规则（与 Monaco trie 的「后注册覆盖」一致）。
// 取色面板用它取初值，保证面板显示 === 编辑器实际渲染（避免「用户宽泛 keyword 规则
// 遮蔽默认精确 keyword.control.loop」之类的不一致）。
export function getEffectiveTokenStyle(token, light) {
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

    monaco.editor.defineTheme('custom-vs', {
        base: light ? 'vs' : 'vs-dark',
        inherit: true,
        // 语义 token 类型默认色 + 用户自定义规则（用户覆盖默认）
        rules: mergeThemeRules(vsCodeEditorConfiguration.customThemeRules, light),
        colors
    });
}

export function isLightTheme() {
    return window.vsCodeEditorConfiguration?.theme === 'vs';
    // const contextEditorCfg = window.vsCodeEditorConfiguration.contextEditorCfg || {};
    // if (!contextEditorCfg.useDefaultTokenizer)
    //     light = true; // 如果不使用默认主题，则强制使用自定义浅色主题
    // return light;
}

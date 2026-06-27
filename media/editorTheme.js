//@ts-check

// Monaco 主题相关：根据 VS Code 颜色变量与上下文配置生成自定义主题

import { getCssVars } from './colorUtils.js';

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
        rules: vsCodeEditorConfiguration.customThemeRules,
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

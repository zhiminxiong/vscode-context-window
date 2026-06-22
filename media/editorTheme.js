//@ts-check

// Monaco 主题相关：根据 VS Code 颜色变量与上下文配置生成自定义主题

import { getCssVar } from './colorUtils.js';

export function applyMonacoTheme(vsCodeEditorConfiguration, contextEditorCfg, light) {
    // 先收集候选颜色，然后清理 undefined
    const candidateColors = {
        'editor.background': getCssVar('--vscode-editor-background'),
        'editor.foreground': getCssVar('--vscode-editor-foreground'),
        "editor.selectionBackground": contextEditorCfg.selectionBackground || getCssVar('--vscode-editor-selectionBackground') || "#07c2db71",
        //"editor.selectionForeground": "#ffffffff",
        "editor.inactiveSelectionBackground": contextEditorCfg.inactiveSelectionBackground || getCssVar('--vscode-editor-inactiveSelectionBackground') || "#07c2db71",
        "editor.selectionHighlightBackground": contextEditorCfg.selectionHighlightBackground || getCssVar('--vscode-editor-selectionHighlightBackground') || "#5bdb0771",
        "editor.selectionHighlightBorder": contextEditorCfg.selectionHighlightBorder || "#5bdb0791",
        "editor.findMatchBackground": getCssVar('--vscode-editor-findMatchHighlightBackground') || "#F4D03F",
        'editorGutter.background': getCssVar('--vscode-editorGutter-background') || getCssVar('--vscode-editor-background'),
        'editorGutter.addedBackground': getCssVar('--vscode-editorGutter-addedBackground'),
        'editorGutter.modifiedBackground': getCssVar('--vscode-editorGutter-modifiedBackground'),
        'editorGutter.deletedBackground': getCssVar('--vscode-editorGutter-deletedBackground'),
        'editorLineNumber.foreground': getCssVar('--vscode-editorLineNumber-foreground') || getCssVar('--vscode-foreground'),
        'editorLineNumber.activeForeground': getCssVar('--vscode-editorLineNumber-activeForeground') || getCssVar('--vscode-foreground'),
        'editorLineNumber.dimmedForeground': getCssVar('--vscode-editorLineNumber-dimmedForeground') || getCssVar('--vscode-editorLineNumber-foreground'),
        'editorIndentGuide.background': getCssVar('--vscode-editorIndentGuide-background'),
        'editorIndentGuide.activeBackground': getCssVar('--vscode-editorIndentGuide-activeBackground'),
        'editor.lineHighlightBackground': getCssVar('--vscode-editor-lineHighlightBackground'),
        'editor.lineHighlightBorder': getCssVar('--vscode-editor-lineHighlightBorder'),
    };

    const colors = {};
    for (const [k, v] of Object.entries(candidateColors)) {
        if (typeof v === 'string') colors[k] = v; // 仅保留有效字符串
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

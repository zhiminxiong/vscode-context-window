//@ts-check

// WebView 内注入的编辑器相关样式（高亮、光标显隐、Ctrl 悬停链接等）

export const editorStyles = `
            .highlighted-line {
                background-color: rgba(173, 214, 255, 0.25);
            }
            .highlighted-glyph {
                background-color: #0078d4;
                width: 5px !important;
                margin-left: 3px;
            }
            .highlighted-symbol {
                background-color: #198844!important;
                color: #ffffff!important;
                font-weight: bold!important;
                border: 1px solid #5bdb0791 !important;
                border-radius: 2px;
                padding: 0 2px;
                text-shadow: 0 0 1px rgba(0, 0, 0, 0.5);
            }
            /* 使用className应用到整个范围 */
            .highlighted-symbol-range {
                background-color: #198844!important;
            }
            /* 使用inlineClassName应用到每个字符 */
            .highlighted-symbol-inline {
                color: #ffffff!important;
                font-weight: bold!important;
                text-shadow: 0 0 1px rgba(0, 0, 0, 0.5);
            }
            /* 为sticky scroll区域特别添加样式支持 */
            .monaco-editor .editor-sticky-scroll .highlighted-symbol-inline,
            .monaco-editor .sticky-line-content .highlighted-symbol-inline {
                background-color: #198844!important;
                color: #ffffff!important;
                font-weight: bold!important;
                text-shadow: 0 0 1px rgba(0, 0, 0, 0.5);
            }

            /* 默认隐藏Monaco Editor的光标 */
            .monaco-editor .cursor {
                display: none !important;
                opacity: 0 !important;
                visibility: hidden !important;
            }
            .monaco-editor .cursors-layer {
                display: none !important;
            }
            
            /* 当编辑器处于活动状态时显示光标 */
            .monaco-editor.cursor-active .cursor {
                display: block !important;
                opacity: 1 !important;
                visibility: visible !important;
            }
            .monaco-editor.cursor-active .cursors-layer {
                display: block !important;
            }

            .ctrl-hover-link {
                position: relative;
                text-decoration: underline !important;
                text-decoration-color: #0066cc !important;
                text-decoration-thickness: 2px !important;
                text-underline-offset: 4px !important;
                font-weight: bold !important;
                z-index: 1000 !important;
            }
            
            .ctrl-hover-link-dark {
                position: relative;
                text-decoration: underline !important;
                text-decoration-color: #4fc3f7 !important;
                text-decoration-thickness: 2px !important;
                text-underline-offset: 4px !important;
                font-weight: bold !important;
                z-index: 1000 !important;
            }

            .monaco-editor {
                cursor: pointer !important;
                user-select: none !important;
                -webkit-user-select: none !important;
                -moz-user-select: none !important;
                -ms-user-select: none !important;
            }
            #main {
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                padding: 20px;
            }
            body {
                user-select: none;
                -webkit-user-select: none;
                -moz-user-select: none;
                -ms-user-select: none;
            }
        `;

// 将样式注入到文档 head
export function injectEditorStyles() {
    const styleElement = document.createElement('style');
    styleElement.textContent = editorStyles;
    document.head.appendChild(styleElement);
    return styleElement;
}

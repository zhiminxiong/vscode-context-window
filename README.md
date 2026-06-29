# Context Window

VS Code extension that displays the full code context of the current symbol in the sidebar or panel, similar to the context window in Source Insight.

## Special Thanks To

This extension is adapted/modified from `Definition View`: https://github.com/stevepryde/vscode-def-view.git

Special thanks go to all contributors of Definition View. It made creating this extension much easier!

Please check out that extension if you just want documentation in the panel or sidebar.

## Features

![feature](https://github.com/zhiminxiong/vscode-context-window/blob/master/doc/feature.gif?raw=true)

- Like Source Insight, it automatically displays the context of the code at the cursor position.
- Language independent. Works in any language.
- The "Context" view shows in the panel by default. Move to other views or the panel just by dragging.
- Supports syntax highlighting in the context view.

![feature2](https://github.com/zhiminxiong/vscode-context-window/blob/master/doc/feature2.gif?raw=true)
- Floating windows are supported—you can trigger them via a keyboard shortcut or by right-clicking and selecting "Float".

![tokenStyle](https://github.com/zhiminxiong/vscode-context-window/blob/master/doc/tokenStyle.gif?raw=true)

- For custom token parsing and adding a right-click context menu to adjust the style of the selected token, you must first uncheck `useDefaultTokenizer`.

## Configuration

- `contextView.contextWindow.updateMode` — Controls how the documentation view is updated when the cursor moves. Possible values:
    - `live` — (default) The context always tracks the current cursor position.
    - `sticky` — The context tracks the current cursor position. However if there is no symbol at the current position, it continues showing the previous context.
- `contextView.contextWindow.useDefaultTokenizer` — Selects how tokens are highlighted in the context view.
    - Checked by default: Monaco Editor's built-in (Monarch) tokenizer is used for syntax highlighting.
    - When unchecked: the base syntax layer is highlighted by real **TextMate** grammars (harvested from your installed VS Code language extensions, so it matches the main editor), with VS Code **semantic** tokens (resolved from the language server) overlaid on top for precise identifier classification. Semantic highlighting honors your `editor.semanticHighlighting.enabled` setting, including per-language overrides such as `"[csharp]": { "editor.semanticHighlighting.enabled": false }` — languages with it disabled fall back to TextMate only, exactly like the main editor. In this mode you can also use `lightThemeRules` / `darkThemeRules` to customize colors.
- `contextView.contextWindow.lightThemeRules` — Color rules for the light theme
    - Default colors are provided—modify them as needed; leaving the fields empty will fall back to the default tokenizer.
- `contextView.contextWindow.cacheSizeLimit` — Maximum number of files cached in the frontend (webview). Default `30`.
    - Every visited definition file is cached. When the limit is exceeded, eviction uses a size-aware recency score: larger files (more expensive to reload) are kept longer, but no file lives forever.
- `contextView.contextWindow.backendLargeFileSize` — Size threshold in **KB** for caching a file in the extension host (backend). Default `100` (≈ 3000 lines).
    - Only files whose content is larger than this value are cached in the backend, so a frontend miss can refetch them without re-reading the document.
    - Note: setting it too large means almost no file qualifies and the backend cache stays empty (no effect); setting it too small lets small files take up the limited backend slots and crowd out the truly large files. Recommended range: ~50KB to ~300KB.
- `contextView.contextWindow.backendCacheSize` — Maximum number of large files cached in the extension host (backend). Default `20`. The least recently used file is evicted when exceeded.

## Commands

- `Pin current Context` — Stop live updating of the context view. Keeps the currently visible context. 
- `Unpin current Context` — Make the context view start tracking the cursor again.
- `Show Context Window` — Show context view by Keyboard Shortcuts.
- `Display the floating Context Window` — Show floating window by Keyboard Shortcuts.

## Build

- npm install
- vsce package

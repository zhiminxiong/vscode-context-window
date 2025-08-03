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

## Configuration

- `contextView.contextWindow.updateMode` — Controls how the documentation view is updated when the cursor moves. Possible values:
    - `live` — (default) The context always tracks the current cursor position.
    - `sticky` — The context tracks the current cursor position. However if there is no symbol at the current position, it continues showing the previous context.
- `contextView.contextWindow.useDefaultTheme` — Using the default theme of Monaco Editor
    - Checked by default to use the default theme.
    - When unchecked, the custom theme will be used—primarily for token  highlighting—and it must be used together with lightThemeRules or darkThemeRules.
- `contextView.contextWindow.lightThemeRules` — Color rules for the light theme
    - Default colors are provided—modify them as needed; leaving the fields empty will fall back to the default theme.

## Commands

- `Pin current Context` — Stop live updating of the context view. Keeps the currently visible context. 
- `Unpin current Context` — Make the context view start tracking the cursor again.
- `Show Context Window` — Show context view by Keyboard Shortcuts.
- `Display the floating Context Window` — Show floating window by Keyboard Shortcuts.

## Build

- npm install
- vsce package

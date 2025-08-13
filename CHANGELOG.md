# Change Log

All notable changes to the "context-window" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.6.6] 2025.08.13

#### Added

- Add support for detectIndentation.
- When hovering over the right side of the definition list, automatically display the full content of the item.

## [0.6.5] 2025.08.11

- Resolve key conflicts in the Monaco system.

## [0.6.4] 2025.08.10

- Fix the issue where floating window prevent jumping to definition.
- Fix the issue where selected text cannot be copied.
- Feat: When the definition cannot be found, the default behavior is to select the current token.

## [0.6.3] 2025.08.09

- The tab title displays as the filename in floating mode.
- Optimize keyboard response.
- Add support for Go in custom theme.

## [0.6.2] 2025.08.04

- Bug fixes and removal of automatic group locking.

## [0.6.1] 2025.08.04

- Feat: Use a VS Code-style progress bar at the bottom.
- Fix: Atfer restarting VS Code, the webview content is empty when dragging the panel out.

## [0.6.0] 2025.08.03

- Feat: Add custom token settings for custom theme. 
- Feat: Support floating window. (issue #4)

## [0.5.3] 2025.07.27

- Add custom font family and size. issue #1.
- Add control whether the minimap is shown. issue #1.
- Fix: The definition list can't display.
- Feat: Add a toggle for #include... issue(#2)
- Feat: Add a toggle for custom themes issue(#2)

## [0.5.2] 2025.07.25

- Add a custom context menu to the bottom area (support for pin/unpin and copy filename).
- Refined the bottom-area UI.
- Refined the definition list.
- Refactor the js code.

## [0.5.1] 2025.07.23

- Bug fix and optimize bundle size.

## [0.5.0] 2025.07.22

- 支持默认的查找以及gotoline，底部栏界面微调
- Added support for default find and go-to-line; refined the bottom-bar UI.

## [0.4.3] 2025.07.11

- 默认token解析使用js
- Apply js as the default token provider.
- 多定义时选项颜色使用vscode list一致方式，同时增加右键选定颜色的自定义设置
- Aply the same color as vscode's list in multi-definitions, add color config settings for right-click selection.

## [0.4.2] 2025.07.09

- 支持右键选定token，用于查看相同文本
- Support right-click to select a token for viewing identical text.
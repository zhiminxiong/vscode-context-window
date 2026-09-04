# Change Log

All notable changes to the "context-window" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [unReleased] 2026.08.31

#### Changed

- Token Style picker keeps the new preview (word + scope) and the original color / Bold / Italic row. There is no OK button: closing, clicking outside, or leaving the webview applies the current choice; Esc cancels.
- Sticky update-mode icon is a closed eye (same eye as Live, with a slash), so it pairs with Live instead of looking like Pin. The footer control keeps the width of “Sticky” in both states, and sits to the right of Jump mode so changing Definition / Type Definition / Implementation / References does not shift Sticky. The filename strip fills the gap left of those controls, so right-click and double-click work across that empty bar. Jump Trail, Sticky Scroll, and Git Line Blame are also icon toggles on the footer (breadcrumb chevrons / sticky bar plus up-down arrows / horizontal git-commit); the context menu still has the same three items. The Sticky Scroll icon starts from the resolved setting (plugin value, or the main editor’s sticky scroll when unset), not a hardcoded off.
- Line-blame hover: each SHA chip shows the git-commit node to its left. The icon uses the chip color, so the current commit stays green and the parent stays muted.
- Line-blame hover: grow into the free space above or below the line. Only when the card is taller than that space does it lock its height and scroll inside the padding, so the first and last visible lines stay inset from the border.

#### Added

- Relation: **Search and Open Relation** (`contextView.callRelation.quickOpen`) opens a VS Code Quick Pick, searches the workspace as you type, groups hits by file, and opens Relation on the selected line. Each file shows 10 matches first; **... More** appends 15 more and keeps the previous ones visible. It does not jump to the Search view. `contextView.callRelation.quickOpenIndependent` opens that graph in an independent window when on.
- Relation: export the graph from the canvas right-click menu. **Export as SVG / PNG** opens a save dialog (then Reveal); **Copy as Mermaid / DOT** goes straight to the clipboard, ready to paste into Markdown or a PR. SVG and PNG are snapshots of the current view — the same node positions, connector style, theme colors, call-site count bubbles, and name truncation, with the colors baked in so the file stands alone. Mermaid and DOT describe structure only and let the target renderer lay it out, so they drop the "show more" placeholders and carry the call-site count as an edge label.
- Relation (Call): the mouse back / forward buttons walk the center trail, the same stack the top breadcrumb and Backspace use. They do nothing in References mode, where the center cannot move.
- Line-blame hover: an author's Gravatar is downloaded once and kept for the session, so a later hover paints it straight from memory instead of going back to the network (Gravatar only allows five minutes of browser caching) and no longer flips through the letter badge. Authors without one are still looked up each time, in case they register one.

#### Fixed

- Context / Relation open in an independent window without passing through the main editor first. Floating windows are ordinary editor groups whose columns continue past the main window, so the empty window is opened first and the panel is created (or revealed) straight into that column. Previously the panel was created in the active column and then detached, which flashed a tab in the main tab group, and could leave an empty float behind while the panel stayed put — the move ran before the webview held focus, and the "did it work" check read a `TabGroup.isLocked` / auxiliary-window flag that does not exist, so it always reported failure and detached a second window. Hosts that cannot open an empty window still fall back to detaching the tab, and now do so only while the panel has focus. The independent window's group is now locked by the editor itself as it opens, through `workbench.editor.autoLockGroups`. **Lock Editor Group** only ever locks the focused group, and on Cursor a floating window never counts as focused, so that command locked the main tab group instead. The command is still used as a fallback when those settings cannot be written, and then only once the workbench confirms the panel is the editor a command would act on.
- Nothing focuses an editor group by column any more, which on Cursor was locking the main tab group and leaving empty groups behind. Focusing by column runs `focusNthEditorGroup`, and that reports success the moment the command dispatches even though focus never left the main window, so the lock that followed hit the wrong group — most visibly when **Show Relation** ran while Relation was already floating. The same command splits off a brand new group when the column is past the end, and the column could be past the end because the extension host's copy of the layout lags a step behind: after the panel moves into the new window its old group closes, and the numbers shift. That was near-certain from **Search and Open Relation**, where a quick pick was still handing focus back at the same time. Focus is now observed instead of arranged, from `panel.active` or from the tab model, whichever reports first — Cursor leaves `panel.active` stale, and the two are pushed separately. Without that confirmation the lock and Always on Top are skipped rather than aimed at a guess.
- Reload keeps the floating Context Window and the jump trail. The restored editor tab is adopted instead of disposed; the trail is saved as file pointers in workspace state and re-read from disk (missing files are dropped).
- Reload keeps the Relation panel. The tab is adopted instead of closed; only the current center (uri + position) and pin are saved, then the graph is rebuilt from the language server. The center trail of previous hops is not restored.
- Relation (References): left-side nodes group under the real enclosing function (`activate`), skipping TypeScript’s broken arrow names such as `find') callback`. Clicking the node opens that function’s name, not a callback or `registerCommand` line.
- **Double Click Selects Symbol** no longer disturbs line-number selection. Dragging from a line number keeps the start line in both directions, holding still before dragging works, a small move inside one line no longer clears the selection, and press-and-drag is no longer mistaken for a double click. The caret is nudged with `cursorMove` instead of writing the selection, which preserves the editor's line-selection anchor, and the symbol expands only after a short confirmation with no further mouse movement.
- Relation: after a class is shown as References, opening `constructor` (TypeScript maps it to the same item as the class) reloads Call incoming/outgoing instead of reusing the empty-right reference graph.
- Toggling `{ }` (double-click select bracket pair) no longer rebuilds the Monaco theme. The footer flips immediately; only the behavior flag is written. The `{ }` control stays visible even when the setting is off, and the footer context-menu row for it is removed.

## [1.1.0] 2026.08.31

#### Changed

- Call Relation toolbar: click Name / Order. Order sorts callees by first call, callers by file name then call line.
- Line-blame hover grows to the free space above or below the line, and scrolls only when the commit message still does not fit.
- Extension display name is **Context View**. The bottom panel is still **Context Window**.
- Relation window (command **Show Relation**): call hierarchy for functions (`super` / `base` calls resolve to the base method, not the override), and Find All References for variables/fields/types (interface, class, enum, …) grouped by enclosing function (right side empty, like Source Insight). The title shows **Relation (Call)** or **Relation (References)**. Event / callable-type defs that land on a `()` call signature keep the identifier under the cursor (e.g. onDidChangeTextEditorSelection) as the References center. A use is not grouped under an anonymous `name() callback` of the same name; the next outer function is used instead. Getters/setters (document-symbol Property) count as enclosing functions; the node label is the accessor name without a `(get)` / `(set)` prefix, and a click highlights that name. In References mode double-click / trail hops do not change the center (those nodes are not Call Hierarchy items); a click selects the node and, for names like setTimeout() callback, highlights the callee ident. Graph with expand/collapse, Elbow / Direct / Arc connectors (default Arc, chosen from a dropdown), zoom, pan (empty canvas or on a node), and Pin. Also: custom dwell tips (toolbar toggle; Alt when off), find, keyboard navigation, Slim (drop noisy LSP kinds), Alt+click path pin, ×N / ↻ for the same symbol on other paths (hold Alt to highlight all copies), library groups, and Expand All that skips library groups and adds at most 120 nodes per run. Re-run Expand All to continue. Opening a node is immediate; hover includes the arrowhead. If Call Hierarchy is empty at a call site (including when prepare returns nothing), the enclosing caller is loaded as center, the opened symbol is found among its callees, and the center switches to that child; if the callee is not among those children, the caller graph stays and a notice explains that the language server has no hierarchy for the opened symbol. Closing the window clears the graph; Sticky only keeps the last result while the window stays open.

## [1.0.9] 2026.08.30

#### Added

- Jump trail at the top of the Context Window: shows the definition hop chain, with a configurable item limit and a right-click **Copy Call Chain** command.
- Git line blame: after clicking a line number or the empty end of a line, show a trailing git summary; hold Alt to open a hover card (author, time, message, and changes). Can be toggled from the right-click menu. Hover card layout and dark-theme contrast were refined.
- Jump mode pull-up in the Context footer: **Definition** (default), **Type Definition**, **Implementation**, and **References**. References open in the Context panel instead of the main editor.
- Call Relation window: call hierarchy graph with expand/collapse, Elbow / Direct / Arc connectors (default Arc, chosen from a dropdown), zoom, pan (empty canvas or on a node), and Pin. Also: custom dwell tips (toolbar toggle; Alt when off), find, keyboard navigation, Slim (drop noisy LSP kinds), Alt+click path pin, ×N / ↻ for the same symbol on other paths (hold Alt to highlight all copies), library groups, and Expand All that skips library groups and adds at most 120 nodes per run. Re-run Expand All to continue. Opening a node is immediate; hover includes the arrowhead. If Call Hierarchy is empty at a call site (including when prepare returns nothing), the enclosing caller is loaded as center, the opened symbol is found among its callees, and the center switches to that child; if the callee is not among those children, the caller graph stays and a notice explains that the language server has no hierarchy for the opened symbol. Closing the window clears the graph; Sticky only keeps the last result while the window stays open.
- Open Context and Call Relation in an independent floating window, with Always on Top. Opening again focuses the existing window instead of detaching the current editor.

## [1.0.8] 2026.08.13

#### Added

- Recognize JavaScript definitions.

#### Changed

- Upgrade Monaco Editor to 0.56.0.
- Disable `doubleClickSelectsBlock` so double-click selection stays consistent with previous versions.
- Remove the document symbol provider from sticky scroll.
- In light theme, use a brighter border for the custom highlight on the token you jumped back to (background color unchanged).

#### Fixed

- A definition placed too far to the right could be clipped; prefer aligning the definition to the left so it stays visible.

## [1.0.7] 2026.08.08

#### Added

- Added a `stickyScroll` configuration option to control the sticky scroll behavior of the Context window.
- Apply custom highlight to the token after jumping back from a definition.

#### Changed

- Switched semantic token parsing to asynchronous mode for better responsiveness.
- Optimized cursor display: show the cursor on keyboard input and hide it otherwise, with more accurate cursor and line positioning.
- Improved performance and stability of definition navigation and document parsing.

#### Fixed

- Immediately reveal the target line in the center after navigation (#11).
- Fixed focus not being set correctly on right-click.
- Fixed whole-word matching in find.
- Fixed occurrence highlighting inside comments.

## [1.0.6] 2026.08.01

#### Changed

- After jumping to a definition in Context window, clicking the original token in VSCode should be able to restore back to the definition.
- Make sticky scroll consistent with VS Code, and enable selection via left and right mouse buttons.

## [1.0.5] 2026.07.29

#### Changed

- Some bug fixes.
- Uses VS Code's TextMate and semantic parser by default.

## [1.0.4] 2026.07.28

#### Changed

- Fixed pick token style.

## [1.0.3] 2026.07.09

#### Changed

- Fixed incorrect token style when picking via right-click.
- Fixed incorrect hover tips.
- Added an extended double-click selection mode, similar to Source Insight: double-clicking to the left of a bracket selects the bracket pair together with its contents.
- Fixed incorrect keyword style settings.

## [1.0.2] 2026.06.30

#### Changed

- Some bug fixes.

## [1.0.1] 2026.06.29

#### Changed

- Reworked the frontend cache eviction into a size-aware recency score so larger files (more expensive to reload) are kept longer, while no file lives forever.
- When `useDefaultTokenizer` is disabled, base-syntax highlighting now uses real TextMate grammars (harvested from your installed VS Code language extensions) with semantic tokens layered on top (previously Monaco's Monarch tokenizer plus semantic tokens). When `useDefaultTokenizer` is enabled (default), highlighting still uses only Monaco's built-in tokenizer.

#### Added

- `cacheSizeLimit` (default `30`): max number of files cached in the frontend.
- `backendLargeFileSize` (default `100` KB): size threshold above which a file is cached in the extension host.
- `backendCacheSize` (default `20`): max number of large files cached in the extension host.

## [1.0.0] 2026.06.12

#### Changed

- Fixed Context Window Font Size Returns to Default Automatically #9.
- Syntax Parsing & Highlighting Optimization.

## [0.9.3] 2026.03.02

#### Changed

- Fixed inaccurate token parsing when picking token style.
- Optimized token highlight parsing for TypeScript.

## [0.9.2] 2026.02.26

#### Changed

- Fixed underline display issues and some symbol resolution problems in TS.

## [0.9.1] 2026.02.24

#### Changed

- Bottom bar follow the theme color.
- Some minor fixes.

## [0.9.0] 2026.01.04

#### Changed

- Display optimization for the sticky scroll region.

## [0.8.8] 2026.01.02

#### Changed

- Fix support for multi-line highlighting.
- Optimize cursor display behavior.

## [0.8.7] 2026.01.01

#### Changed

- Fix the type parsing exception in TypeScript.
- Fix the issue where the selected symbol is displayed incorrectly in the sticky-scroll area.

## [0.8.6] 2025.12.21

#### Changed

- Fixed the issue causing VS Code to lose focus.

## [0.8.5] 2025.12.21

#### Changed

- Fix the white box flash issue of the textarea on startup.
- Some UI effect tweaks.

## [0.8.4] 2025.12.19

#### Changed

- Fix the issue where the mouse side buttons also trigger click jumps.
- Fix the background display issue when the selected text spans multiple tokens.

## [0.8.3] 2025.12.10

#### Changed

- Upgrading the Monaco Editor to version 0.55.1 brings improvements in both functionality and performance.
- Fixed the accuracy of the scrollbar display area.
- Fixed the issue where clicking on import files in JS/TS would cause abnormal highlighting.

## [0.8.2] 2025.12.05

#### Changed

- Navigate to the URI using a range as the parameter; this allows marking a specific region.

## [0.8.1] 2025.12.04

#### Added

- Add a command to jump to a specified file and location.

## [0.8.0] 2025.11.11

#### Changed

- WebView adds caching to improve performance when jumping to definitions.

## [0.7.2] 2025.09.05

#### Changed

- Drastically improve the performance of jumping to large files.

## [0.7.1] 2025.08.24

#### Added

- When `useDefaultTokenizer` is disabled, add a context-menu option to apply a style to the token under the cursor.

## [0.7.0] 2025.08.21

#### Added

- Sync editor color with VS Code.
- Add "Reveal In File Explorer" option to the context menu.
- Apply bold styling to custom dark theme.

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
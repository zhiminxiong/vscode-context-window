# Context View

Source Insight–style Context Window and Relation (calls/callers) in VS Code. The Context Window shows the full code context of the current symbol in the sidebar or panel; Relation shows who calls a symbol and what it calls.

## Special Thanks To

This extension is adapted/modified from `Definition View`: https://github.com/stevepryde/vscode-def-view.git

Special thanks go to all contributors of Definition View. It made creating this extension much easier!

Please check out that extension if you just want documentation in the panel or sidebar.

## Features

This extension implements Source Insight’s Context Window, plus Relation’s Calls and Callers.

- General Context Window

  ![feature](https://github.com/zhiminxiong/vscode-context-window/blob/master/doc/feature.gif?raw=true)

  - Click a symbol in the VS Code editor and the Context Window jumps to its definition. You can keep jumping from inside the Context Window to inspect source.

  - Every jump inside the Context Window is shown as a breadcrumb **jump trail** at the top. Click a trail item to return the Context Window to that definition.
  - The Context Window is built on Monaco. Monaco’s built-in colors are limited and look quite different from VS Code, so this extension uses VS Code’s **TextMate** and **semantic** highlighting so the Context Window matches the main editor. You can also customize colors inside the Context Window.

- Context Window extras

  ![feature2](https://github.com/zhiminxiong/vscode-context-window/blob/master/doc/feature2.gif?raw=true)

  - Git line blame: click a non-word area (line number or empty end of line) to show a trailing git summary. The detailed hover can be enabled in settings; when it is off, hold **Alt** over the annotation to open it.
  - Right-click to select the word under the cursor.
  - Source Insight–style double-click to select a whole bracket/quote pair (in the Context Window, use a right-button double-click). A setting can enable the same behavior in the VS Code editor; it differs from VS Code’s default double-click selection.
  - Source Insight–style double-click on a line number to select the whole function. A setting can enable the same behavior in the VS Code editor.
  - Floating window: open another Context Window in a separate view, including a fully independent window.

- Relation

  Functions show Calls and Callers. Variables and fields show Find All References grouped by enclosing function (right side empty).

  ![feature3](https://github.com/zhiminxiong/vscode-context-window/blob/master/doc/feature3.gif?raw=true)

  Right-click in the VS Code editor and choose **Show Relation**. This feature depends entirely on the language server (LSP).

## Configuration

#### Context Window

- `contextView.contextWindow.updateMode` — Controls how the Context Window is updated when the cursor moves. Possible values:
    - `live` — (default) Always tracks the current cursor position. Shows empty content if no symbol is found.
    - `sticky` — Tracks the current cursor position, but if there is no symbol at the current position it keeps showing the previous context.
- `contextView.contextWindow.jumpMode` — What a click in the Context Window jumps to. Change it from the pull-up at the right of the Context footer. Possible values:
    - `definition` — (default) Go to Definition.
    - `typeDefinition` — Go to Type Definition (the type of a variable, not where it is declared).
    - `implementation` — Go to Implementation of an interface or virtual function.
    - `references` — Find References. Click a symbol to list references in Context, then click one to open that location in the panel (not the main editor).
- `contextView.contextWindow.useDefaultTokenizer` — Selects how tokens are highlighted in the Context Window. Takes effect when VS Code starts.
    - Unchecked by default: the base syntax layer is highlighted by real **TextMate** grammars (harvested from your installed VS Code language extensions, so it matches the main editor), with VS Code **semantic** tokens (resolved from the language server) overlaid on top for precise identifier classification. Semantic highlighting honors your `editor.semanticHighlighting.enabled` setting, including per-language overrides such as `"[csharp]": { "editor.semanticHighlighting.enabled": false }` — languages with it disabled fall back to TextMate only, exactly like the main editor. In this mode you can also use `lightThemeRules` / `darkThemeRules` to customize colors (right-click a token and pick a style).
    - When checked: Monaco Editor’s built-in (Monarch) tokenizer is used for syntax highlighting.
- `contextView.contextWindow.lightThemeRules` / `contextView.contextWindow.darkThemeRules` — Token color rules for the light / dark theme, saved from the right-click token style picker. Empty by default.
- `contextView.contextWindow.fixToken` — Treat `#include`, `#pragma`, `#region`, and `#endregion` as distinct tokens, separate from `#directive`. Off by default. Takes effect when VS Code starts.
- `contextView.contextWindow.selectionBackground` — Selection background color. Default `#07c2db71`.
- `contextView.contextWindow.inactiveSelectionBackground` — Inactive selection background color. Default `#07c2db71`.
- `contextView.contextWindow.selectionHighlightBackground` — Selection highlight background color. Default `#5bdb0771`.
- `contextView.contextWindow.selectionHighlightBorder` — Selection highlight border color. Default `#5bdb0791`.
- `contextView.contextWindow.minimap` — Show the Context Window minimap. Default `true`.
- `contextView.contextWindow.fontSize` — Font size. Default `14`.
- `contextView.contextWindow.fontFamily` — Font family. Default `Consolas, monospace`.
- `contextView.contextWindow.enableHover` — Show hover tooltips (parameter signatures, JSDoc, etc.) in the Context Window. Hover requests are forwarded to the active language servers of the main editor. Off by default.
- `contextView.contextWindow.occurrencesHighlight` — Highlight every occurrence of the word under the cursor, like `editor.occurrencesHighlight` in the main editor. Off by default: the cursor in the Context Window is placed programmatically when jumping or navigating back, so this highlight can land on a neighbouring identifier instead of the token you clicked. The token you jumped out from is always highlighted on its own, regardless of this setting.
- `contextView.contextWindow.stickyScroll` — Show sticky scroll (pinned function/class headers) in the Context Window. Default `null` — follows the main editor’s `editor.stickyScroll.enabled`. Toggling it from the right-click menu writes this setting explicitly, which then takes precedence over the main editor.
- `contextView.contextWindow.fixStickyScroll` — Extend sticky scroll parsing for C, C++, and C#. Off by default. Takes effect when VS Code starts.
- `contextView.contextWindow.jumpTrail` — Show the jump trail (definition hop breadcrumbs) at the top of the Context Window. On by default. Can be toggled from the right-click menu.
- `contextView.contextWindow.jumpTrailMaxItems` — Maximum number of named items shown on the jump trail. Default `8`, minimum `2`. Extra hops collapse into the `…` dropdown. The first and current items are always kept.
- `contextView.contextWindow.lineBlame` — After clicking a line in the Context Window, show a gray git summary (author, time, commit subject) at the end of that line. Jumping does not show it. On by default. Can be toggled from the right-click menu.
- `contextView.contextWindow.lineBlameHover` — Automatically show the git line-blame hover when the pointer is over the annotation. Off by default: hold **Alt** over the annotation to open it. Releasing Alt does not close it. Has no effect unless Git Line Blame is on and an annotation is visible.
- `contextView.contextWindow.doubleClickSelectsBracketPair` — Double-clicking next to a bracket `(` `[` `{` `<` or a quote `"` `'` `` ` `` selects the whole matching pair including the delimiters. Complements VS Code’s built-in `editor.doubleClickSelectsBlock`, which selects only the content inside. Off by default. Toggle from the status bar (`{si}`), the editor right-click menu, or the keyboard shortcut.
- `contextView.contextWindow.doubleClickSelectsSymbol` — In the main editor, double-clicking a line number selects the smallest enclosing function, method, class, or namespace. Off by default.
- `contextView.contextWindow.contextDoubleClickSelectsSymbol` — In the Context Window, double-clicking a line number selects the smallest enclosing function, method, class, or namespace. On by default. Replaces jumping to the same location in the main editor.
- `contextView.contextWindow.cacheSizeLimit` — Maximum number of files cached in the frontend (webview). Default `30`.
    - Every visited definition file is cached. When the limit is exceeded, eviction uses a size-aware recency score: larger files (more expensive to reload) are kept longer, but no file lives forever.
- `contextView.contextWindow.backendLargeFileSize` — Size threshold in **KB** for caching a file in the extension host (backend). Default `100` (≈ 3000 lines).
    - Only files whose content is larger than this value are cached in the backend, so a frontend miss can refetch them without re-reading the document.
    - Note: setting it too large means almost no file qualifies and the backend cache stays empty (no effect); setting it too small lets small files take up the limited backend slots and crowd out the truly large files. Recommended range: ~50KB to ~300KB.
- `contextView.contextWindow.backendCacheSize` — Maximum number of large files cached in the extension host (backend). Default `20`. The least recently used file is evicted when exceeded.

#### Floating / independent window

- `contextView.independentWindowAlwaysOnTop` — When opening Context or Call Relation in an independent window, turn on Always on Top. Off by default.

#### Call Relation

- `contextView.callRelation.updateMode` — Controls how Call Relation is updated when the cursor moves. Possible values:
    - `live` — (default) Follow the cursor. If the language server finds no call hierarchy, show an empty message.
    - `sticky` — Keep the last graph until the language server returns a new call hierarchy.
- `contextView.callRelation.childSort` — How children of a node are ordered. Click **Name** / **Order** on the Call Relation toolbar. Possible values:
    - `name` — (default) A–Z by symbol name (last identifier).
    - `order` — Callees: first call in the function. Callers: same file by call line, different files by file name.
- `contextView.callRelation.edgeStyle` — Connector style. Can be switched from the Call Relation toolbar. Possible values:
    - `elbow` — Orthogonal bus lines with arrows.
    - `direct` — Straight single-arrow links from the right edge of the caller to the left edge of the callee.
    - `arc` — (default) Curved single-arrow links using the same attachment points as Direct.
- `contextView.callRelation.compactFilter` — When on, keep only the symbol kinds checked in `compactKinds`. Off by default. Toggle from the Call Relation toolbar (**Slim**).
- `contextView.callRelation.compactKinds` — Symbol kinds kept when Slim is on. Default: `function`, `method`, `constructor`, `class`, `struct`, `variable`, `constant`, `property`. Change them from the list beside the Slim button.

#### MCP (AI access)

- `contextView.mcp.enabled` — Serve this window's code intelligence to AI assistants over the Model Context Protocol. On by default. Two tools are offered:
    - `code_relations` — Callers and callees of a function as a tree with the exact call sites, or every reference to a variable or type grouped by the function containing it. The same language-server data the Call Relation panel draws.
    - `enclosing_symbol` — The smallest function, method, class, or namespace containing a line, with its exact range and source.

  The endpoint listens on loopback only, on a port chosen at startup, and requires a bearer token regenerated every time the window starts. Because the answers come from this window's language servers and workspace, the server runs inside the extension and cannot be started separately.

- `contextView.mcp.configFiles` — Extra MCP config files to offer when configuring a client, for ones not on the list below. Each is a path to a `.json` file: absolute, starting with `~`, or relative to the workspace. Empty by default.

  Nothing needs to be configured on VS Code 1.101 or later: the editor asks the extension for the address each time it connects. Older versions and other editors are unaffected — the API is detected at runtime and simply not used when it is absent.

  Every other client is configured from a file, which is written once and cannot hold an address that changes every restart. Run **Context View: Configure MCP Server Entry** to add an entry pointing at a small bridge script that looks the endpoint up when it is launched. The command lists, with the running editor's own files first:

    - `.cursor/mcp.json` and `.codebuddy/mcp.json` — this project only, and shared with anyone who checks it out.
    - `~/.cursor/mcp.json` and `~/.codebuddy/mcp.json` — every project you open.
    - Anything named in `contextView.mcp.configFiles`, plus **Another file…** to give a path once.
    - **Copy the entry**, for a client with no file on this list.

  VS Code is deliberately not offered: it is handed the server through the API above, and a file would register the same tools a second time.

  The chosen file is edited in place rather than rewritten, so servers you already have there keep their settings — including any credentials — along with their comments, key order, and formatting. Comments and trailing commas are accepted, since these files are usually hand-edited. If one still cannot be read, nothing is written to it at all and the command offers to open it or to copy the entry for you to paste.

  The entry is an ordinary stdio server run with `node`, so it is not tied to the editor that wrote it; where no usable `node` is on PATH, that editor's binary stands in as the Node runtime. The workspace is passed as `${workspaceFolder}` so one entry serves every checkout, which is what makes the home-directory files usable. Cursor resolves that to the folder holding the config, which in a home-directory file is your home rather than the project, and some clients pass it through unexpanded — so it can name a workspace nobody is serving. The bridge then tries the directory it was started in, which is the workspace for every client seen so far, and failing that the single window that is serving. It refuses to guess when several are open, and says which ones those are. The path to the script is absolute for this machine, so a project-level file is worth adding to `.gitignore`. Reload the MCP servers in your client afterwards.

  Run **Context View: Show MCP Endpoint** at any time to see the address and which of the two paths is in use.

## Commands

- `Pin current Context` — Stop live updating of the context view. Keeps the currently visible context. 
- `Unpin current Context` — Make the context view start tracking the cursor again.
- `Show Context Window` — Show context view by Keyboard Shortcuts.
- `Display the floating Context Window` — Show floating window by Keyboard Shortcuts.
- `Show MCP Endpoint` — Show the address and token of the MCP endpoint, and how the editor is reaching it.
- `Configure MCP Server Entry` — Add this workspace's MCP server to a client's config file, or copy the entry. Only its own entry is written: other servers, unrelated settings, comments, and formatting are left as they are, and a file that cannot be read is not touched at all.

## Build

- npm install
- vsce package

The MCP transport is hand-written rather than taken from `@modelcontextprotocol/sdk`, which would have added 850 KB to a 182 KB bundle for two tools. `npm run check:mcp` drives the endpoint over real HTTP to check the handshake and the failure cases clients put it in, checks that writing the config entry leaves the rest of a client's file alone, then spawns `media/mcpBridge.js` and speaks stdio to it the way Cursor does. That covers the usual `node` launch; to check the fallback, pass the editor binary the entry would name instead:

```bash
node scripts/checkMcpBridge.js "C:\Users\you\AppData\Local\Programs\cursor\Cursor.exe"
```

`media/mcpBridge.js` is not bundled: it is copied to `~/.context-view/` and run as its own process, so it must stay a dependency-free script in the published package.

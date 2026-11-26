# Code-XR IDE feature audit

**Date:** 2026-11-26 · **Baseline:** `v1.2.1` at `2bbe12f8` (after PR #162) · **Scope:** `apps/ide`

This audit compares the Code-XR IDE (Electron + Monaco, epic #11) with the IDEs
its users already know, mainly VS Code and the JetBrains family, and lists what it
needs to be a tool people can do a full day of work in. It keeps the IDE's current
visual language (see [Visual constraints](#5-visual-constraints)) and leaves out
everything about AI agents, chats, providers and orchestrators: those belong to the
AI-agents epic, which builds on the command registry proposed here.

The result is a prioritised backlog, tracked as epic **#163 "Make the Code-XR IDE a
full everyday IDE"** with one user story per row of the [backlog](#3-prioritised-backlog).

## 1. What the IDE already does

| Area | State | Source |
|---|---|---|
| Secure shell | Sandboxed renderer, context isolation, strict CSP, frozen preload API | #12 |
| Workspace | Open folder, recent folders, reopen last folder, file watcher | #14, #151 |
| Explorer | Tree with file and language icons, create / rename / trash | #14, #138 |
| Editor | One Monaco editor, one model per file, tab strip, dirty state, disk-conflict handling, follows OS theme | #14 |
| Terminal | xterm.js + node-pty, several terminals, configurable shell (Git Bash on Windows) | #137 |
| Analysis | Python env auto-install with progress, XR deep analysis on open, scene beside the code, scene header with local URL and Cloudflare share | #15, #16 (part), #139, #153-#161 |
| Notifications | VS Code-style toasts with progress and actions | #153 |
| About | Versions plus the analysis dependencies and their state | #161 |

The editor itself is good (it is Monaco), but everything *around* it is minimal:
a single editor group, no way to reach actions except the native menu and a few
accelerators, no search, no Git, no language intelligence beyond syntax
highlighting, a status bar that shows only the Python state, and a layout that
cannot be resized or remembered.

## 2. Comparison with VS Code and JetBrains

Legend: **Yes** = present, **Part** = partially, **No** = missing. "Story" names the
existing issue or the new story (#164-#180, epic #163) that closes the gap.

### 2.1 Navigation and commands

| Capability | VS Code | JetBrains | Code-XR IDE | Story |
|---|---|---|---|---|
| Command palette with every action | Yes | Yes (Find Action) | No | #18 |
| User-editable keybindings | Yes | Yes | No | #18 |
| Quick open file by name (fuzzy) | Yes | Yes (Search Everywhere) | No | #164 |
| Go to line / column | Yes | Yes | No (Monaco has it, unbound) | #164 |
| Go to symbol in file | Yes | Yes | No | #164 |
| Recently opened files | Yes | Yes | No | #164 |
| Breadcrumbs | Yes | Yes | No | #172 |
| Outline / structure view | Yes | Yes | No | #172 |

### 2.2 Search

| Capability | VS Code | JetBrains | Code-XR IDE | Story |
|---|---|---|---|---|
| Find / replace in file | Yes | Yes | Yes (Monaco) | - |
| Search across the workspace (regex, case, whole word) | Yes | Yes | No | #165 |
| Include / exclude globs, respects ignore rules | Yes | Yes | No | #165 |
| Replace across files with preview | Yes | Yes | No | #165 |

### 2.3 Editor

| Capability | VS Code | JetBrains | Code-XR IDE | Story |
|---|---|---|---|---|
| Split editors (side by side) | Yes | Yes | No | #168 |
| Preview tabs, reorder by drag, close others / to the right | Yes | Yes | No | #167 |
| Status bar: Ln/Col, selection, language, indentation, EOL, encoding | Yes | Yes | No | #166 |
| Change language mode / indentation / EOL from the status bar | Yes | Yes | No | #166 |
| Auto save, trim trailing whitespace, final newline, `.editorconfig` | Yes | Yes | No | #170 |
| Format document / on save | Yes | Yes | No (needs a formatter or LSP) | #170, #21 |
| Diff editor | Yes | Yes | No | #17 |
| Markdown preview | Yes | Yes | No | #179 |

### 2.4 Workbench and settings

| Capability | VS Code | JetBrains | Code-XR IDE | Story |
|---|---|---|---|---|
| Resizable side bar, panel and scene column | Yes | Yes | No (fixed grid) | #169 |
| Toggle side bar / panel, zen mode | Yes | Yes | Part (terminal panel only) | #169 |
| Layout and open editors restored on restart | Yes | Yes | Part (folder only) | #169 |
| Settings UI + user / workspace settings files | Yes | Yes | No | #18 |
| Theme picker (dark / light / follow OS) | Yes | Yes | Part (follows OS only) | #171 |
| Problems panel | Yes | Yes | No | #173 |
| Output panel (logs of the core, Python, servers) | Yes | Yes (Event Log) | No (logs go to a file) | #174 |

### 2.5 Language intelligence, Git, run and debug

| Capability | VS Code | JetBrains | Code-XR IDE | Story |
|---|---|---|---|---|
| Completion, hover, go to definition, diagnostics (LSP) | Yes | Yes (native) | No | #21 |
| Source control view, stage, commit, branch | Yes | Yes | No | #17 |
| Gutter change markers, inline blame | Yes (blame via ext.) | Yes | No | #175 |
| Run tasks / npm scripts / run current file | Yes | Yes (Run configs) | No | #176 |
| Debugger (DAP) | Yes | Yes | No | #180 |
| Workspace trust before running code | Yes | Yes | No | #177 |

### 2.6 What a generic IDE does not have: Code-XR differentiators

These are where the IDE should go *beyond* VS Code, because the analysis data is
already in the process:

| Capability | Code-XR IDE | Story |
|---|---|---|
| Metrics in the editor: CodeLens per function (CCN, NLOC, params) and a complexity heat strip in the gutter | No (metrics only in the scene and LivePanel) | #178 |
| Metric thresholds reported as problems ("CCN 23 > 15") | No | #173 |
| Scene to code: click a building, the file opens at the function | No | #16 |
| Code to scene: reveal the current file / function in the scene | No | #178 |
| Live re-analysis on save | No | #16 |

## 3. Prioritised backlog

Priorities: **P0** = without it the IDE is not usable for a full day; **P1** = expected
by anyone coming from VS Code / JetBrains; **P2** = completes the picture.
Effort: S (< 1 day), M (1-3 days), L (> 3 days).

| # | Story | Priority | Effort | Depends on |
|---|---|---|---|---|
| #18 | Command palette, keybindings and settings (existing, epic #11) | P0 | L | - |
| #164 | Quick open: files, lines, symbols and recent files | P0 | M | #18 |
| #165 | Search and replace across the workspace | P0 | M | - |
| #166 | Editor status bar: position, language, indentation, EOL, encoding | P0 | S | - |
| #167 | Editor tabs that behave like VS Code (preview, reorder, close actions) | P0 | M | - |
| #168 | Split the editor into two groups | P1 | M | #167 |
| #169 | Resizable, toggleable and remembered layout | P0 | M | - |
| #170 | Editor hygiene: auto save, `.editorconfig`, format on save | P1 | M | #18 |
| #171 | Theme picker: dark, light or follow the OS | P1 | S | #18 |
| #172 | Outline view and breadcrumbs | P1 | M | #21 for most languages |
| #173 | Problems panel, fed by language servers and Code-XR metric thresholds | P1 | M | - |
| #174 | Output panel with the IDE, core, Python and server logs | P1 | S | - |
| #175 | Git in the editor: gutter change markers and inline blame | P1 | M | #17 |
| #176 | Run tasks: npm scripts, Makefile targets and the current file | P1 | M | #137 |
| #177 | Workspace trust before running anything from a folder | P1 | S | #176 |
| #179 | Markdown preview | P2 | S | - |
| #178 | Code-XR metrics in the editor and code-to-scene navigation | P1 | L | #16 |
| #180 | Debugger through the Debug Adapter Protocol | P2 | L | #21, #176 |
| #17 | Integrated terminal and basic Git (existing, Git part) | P1 | L | - |
| #21 | Language intelligence through LSP (existing) | P1 | L | - |

Implementation order (each line is one PR or a small group):
1. #18 registry + palette + keybindings, then #166 status bar, #164 quick open.
2. #165 workspace search, #169 layout, #167 tabs.
3. #18 settings, #171 themes, #170 editor hygiene, #174 output.
4. #173 problems, #178 metrics in the editor, then #17 Git, #175, #21, #172.
5. #176, #177, #168, #179, #180.

## 4. Design decisions that cut across the stories

- **One command registry** (`src/renderer/commands/`) is the only source for the
  palette, the native menu accelerators, keybindings and, later, voice commands and
  the AI agents' tools. IDs are unique (the registry throws, like
  `assertUniqueCommandIds` in the extension). Menu items send the command ID, so a
  rebinding changes the menu label's accelerator too.
- **Main-process services, renderer views.** File search, Git, tasks and language
  servers run in the main process behind typed IPC in `shared/api.ts`; the renderer
  never gets Node or file-system access. This keeps the sandbox from #12.
- **Search without native binaries first.** Workspace search walks the tree with the
  existing `ignoreRules.ts` and streams results. A bundled ripgrep can replace it
  later if large repositories need it; it would be one more native binary per OS to
  sign and ship (#20).
- **Settings in JSON files**, user (`<userData>/settings.json`) and workspace
  (`.code-xr/settings.json`), with a typed schema and a form UI over it, as VS Code
  does. Analysis and visualisation settings come from the core's existing schema.
- **Cross-platform keys.** Bindings are declared with `CmdOrCtrl`; on macOS `Cmd`
  is used, on Windows/Linux `Ctrl`. Nothing assumes a POSIX shell or `/` paths.

## 5. Visual constraints

Every new surface reuses the tokens in `apps/ide/src/renderer/styles.css`
(`--chrome`, `--panel`, `--editor`, `--line`, `--hover`, `--fg`, `--muted`,
`--accent`, `--status`), both themes, 13 px system UI type, monospace only for code
and paths, and the existing icon style (24x24 stroked SVG paths in the activity bar).
Overlays such as the palette and quick open follow VS Code's position (top centre,
600 px max) so muscle memory carries over. No emoji in sources (the `uiPolicy` test).

## 6. Out of scope here

- AI agents, chats, model providers, orchestrators: the AI-agents epic.
- Entering XR from the IDE (#19) and packaging / signing (#20): already in epic #11.
- An extension marketplace: a plugin API is a separate, later decision.

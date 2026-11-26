# Code-XR IDE

The standalone Code-XR IDE: a desktop environment built on **Electron + Monaco** where editing code, analysing it and exploring it in XR are one workflow. The platform decision is ADR 0001 ([`adr/0001-code-xr-ide-platform.md`](../../adr/0001-code-xr-ide-platform.md)); the work is tracked in epic #11.

**Status:** stories #12 (secure scaffold) and #14 (open a project, edit with Monaco) are done, pending a manual try; story #15 (the Python environment) is in progress; story #138 (file and language icons) is done, pending a manual try; story #137 (the integrated terminal) is done on Linux and pending a manual try on Windows and macOS. A folder opens from File > Open Folder… (Ctrl/Cmd+O), the explorer's button or `--folder=<path>` on the command line; without `--folder` the IDE reopens the folder worked on last (#151, the head of the recent list; one that is gone leaves the list and the IDE starts empty; never in the smoke run), and the explorer shows it as a lazily loaded tree (`.git` and `node_modules` hidden, root `.gitignore` matches dimmed). Every entry of the explorer and every tab shows the icon of its language or type, VS Code style: by file name first (`package.json`, `Dockerfile`, `.gitignore`), then by extension, with open and closed folder icons and special ones for `src`, `test`, `.github`, `node_modules` and other common folders (#138; every language of the metric contract has one, anything else gets a generic icon). Files open in Monaco tabs (loaded on the first open, in its own chunk) with syntax highlighting, a dirty mark, File > Save (Ctrl/Cmd+S), Save All (Ctrl/Cmd+Alt+S) and Close Editor (Ctrl/Cmd+W); the explorer and the open files follow the disk (one non-recursive watcher per expanded folder and per open file's folder): a clean tab reloads, an unsaved one keeps your text and is marked as changed or deleted on disk, and saving over a newer file asks first. Closing the window with unsaved tabs asks Save All / Don't Save / Cancel. The explorer creates files and folders (its toolbar, File > New File… Ctrl/Cmd+N, File > New Folder…), renames with F2 and moves to the OS trash with Delete (never a permanent delete); names that Windows would refuse are refused on every OS so a project stays portable. File > Open Recent and the empty explorer list the last 10 folders (kept in the user-data folder); the renderer can only reopen a folder from that list, never an arbitrary path. The Analysis view (second activity item) and the status bar show the Python environment the analyses run in (#15): whether a Python was found, a set-up that asks in a native dialog listing every package and its source before anything is downloaded (the language parsers for the dependency graph included, so an analysis never downloads anything), progress, repair and removal. From the same view, **Analyse project in XR (deep)** runs the extension's directory XR analysis over the open folder (#16, first part) and shows its scene in a column beside the code, and runs on its own when a folder opens unless turned off (#139); the scene's header shows what ran, on what and at which local address, and shares it through a Cloudflare tunnel on request (#155); the remaining analyses, live refresh and scene-to-code navigation follow. View > Terminal (Ctrl+\`) opens a terminal panel under the editor (#137): xterm.js tabs running the default shell in the open folder, with New Terminal (Ctrl+Shift+\`), rename (double-click or F2), kill, a resizable panel, and a profiles menu to start any detected shell, change the default and add a custom one; see [Terminal](#terminal-137).

## Commands

Run them from the repository root after `npm ci`:

| Command | What it does |
|---|---|
| `npm run ide:dev` | Vite dev server with hot reload for the renderer; main and preload are rebuilt and Electron restarted on every change. |
| `npm run ide:build` | Production build into `apps/ide/out/`. |
| `npm run ide:start` | Build, then run the built IDE (no dev server). |
| `npm run ide:smoke` | Build, launch the IDE hidden with `--codexr-smoke`, probe the security baseline from inside the real renderer, open a terminal with the default profile and read back the output of `echo codexr-smoke`, exit 0 or 1. On Linux without a display use `xvfb-run -a npm run ide:smoke`. |
| `npm run ide:test` | Typecheck (Node and web targets separately), lint with zero warnings, unit tests. Part of the root `npm test`. |

## Layout

```
apps/ide/
├── src/
│   ├── main/        Electron main process (Node): window, menu, IPC handlers, app protocol, hardening
│   ├── preload/     the only bridge to the renderer: exposes window.codexr
│   ├── renderer/    the workbench UI (browser code, no Node, no Electron)
│   │   └── public/file-icons/   bundled SVG icons (#138), published with the renderer
│   └── shared/      the renderer <-> main contract (api.ts), imported by all three
├── test/            unit tests (node:test, TypeScript run by Node's type stripping)
├── scripts/         build, dev, start and smoke runners (Vite's JS API), syncFileIcons.mjs
├── THIRD_PARTY_NOTICES.md   licences of bundled third-party material
└── out/             build output, git-ignored: main/index.cjs, preload/index.cjs, renderer/
```

### File icons (#138)

The icons are SVGs from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT, recorded in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)), a devDependency of this package. Only the ones the IDE uses are bundled: `src/renderer/fileIcons.ts` holds the tables and the pure `iconFor(name, kind, expanded?)` (whole file name first, then the longest known extension, so `a.d.ts` beats `a.ts`), and `node scripts/syncFileIcons.mjs` (run from `apps/ide`) copies exactly those SVGs into `src/renderer/public/file-icons/`; commit the result. `test/fileIcons.test.ts` fails if the folder and the tables drift, if a copy differs from the package, or if a language of the metric contract (`backend/src/utils/metric_language_contract.py`) falls back to the generic icon.

They are served from the app like the rest of the renderer, so the CSP did not change (`img-src 'self' data:`), and the smoke run checks that the icons it shows load. A row's icon is an empty `<span>` whose class picks the SVG from one stylesheet built from the same tables, with the set's light-theme variants under `prefers-color-scheme: light`: each SVG is fetched once and a row costs one element, so expanding a 3,000-file folder takes the same time as before (about 280 ms in both builds, Playwright against the built app).

### Using the extension's core (#15)

The analysis engine is the extension's vscode-free core (`apps/vscode-extension/src/core`, #13). The IDE's main process imports it as `@codexr/core/<path>` and Vite bundles those sources into `out/main/index.cjs`. The renderer and the preload may not import it (ESLint), so everything the core does reaches the page through `window.codexr` like any other capability.

- **The host.** `src/main/core/electronHost.ts` implements the core's `CodeXRHost` (the extension's is `app/host/vscodeHost.ts`): questions a person must answer (`confirm`, consent) are native modal dialogs in the main process, never something the renderer can answer; notifications and progress are forwarded to the views; `globalState` is a JSON file (`core/jsonStore.ts`). `core/coreRuntime.ts` registers it at start-up, with the core's storage in `<userData>/core` (a throwaway folder in the smoke run).
- **Type checking.** The core is written for the extension's compiler options, not this package's stricter ones, so the IDE never type-checks core sources. `scripts/coreTypes.mjs` (first step of `npm run typecheck`) finds every `@codexr/core/...` import under `src/`, emits declarations for them into `.core-types/` (git-ignored) with the extension's own settings and **without `vscode` types**, and `tsconfig.node.json` maps the alias there. A core module that still reached `vscode` would fail that step.
- **Tests.** Unit tests cover the IDE's side (`pythonStatus.ts`, `jsonStore.ts`); modules that import the core run in the built app (the smoke run, Playwright checks), since Node's type stripping cannot load the core's sources.

The move of the core into `packages/core` (step 10 of the plan in `docs/ide/vscode-api-inventory.md`) would replace the alias with a workspace dependency and change nothing else here.

Technology choices for the scaffold:

- **TypeScript everywhere, strict.** Two type-check targets: `tsconfig.node.json` (main, preload, shared, tests; Node types, no DOM) and `tsconfig.web.json` (renderer, shared; DOM, no Node types), so a Node API used in the renderer fails the type check.
- **Vite** builds all three targets: main and preload as self-contained CommonJS bundles (a sandboxed preload cannot load local files), the renderer as a normal web build.
- **No UI framework in the renderer for now.** The workbench is built with plain DOM APIs. Monaco, the XR scene and the LivePanel are themselves framework-free, and VS Code's workbench is too; a framework can still be introduced later for complex panels if it pays for itself.
- **Unit tests with `node:test`**, like the extension, running the `.ts` sources directly through Node's type stripping (no compile step). Source files therefore use only erasable TypeScript syntax (`erasableSyntaxOnly`).

### Analyses and the scene view (#16)

`src/main/analysis/analysisService.ts` runs the extension's own pipeline (`AnalysisOrchestrator`) with a `CoreContext` built from the IDE's host; the workspace storage VS Code would give is a folder per project under `<userData>/core/workspaces/<hash>`. The IDE registers its own `LaunchNotifier`, so a finished launch opens in the window that asked instead of a browser, and its server settings use the core's `lateralPanel` open mode: scenes are served over plain HTTP on loopback (a secure context, so WebXR still works) with no self-signed certificate to accept.

The scene is a `WebContentsView` laid over the slot the renderer reserves (`analysis/sceneView.ts`), never an `<iframe>` in the app's page, so the app's CSP keeps `frame-src 'none'` and the scene, served over the network, can never reach `window.codexr`:

- no preload, sandboxed, context isolation, its own in-memory session `codexr-scene` that grants no permission;
- it may only show, and navigate within, a loopback `http(s)` origin with a port (`sceneUrl.ts`);
- **nothing leaves the machine**: the scene's pinned CDN libraries (A-Frame, BabiaXR...) are answered from `apps/vscode-extension/test/vendor/scene-libraries/` (`sceneLibraries.ts`; a test checks every external script in `templates/` has a copy) and every other external request is refused. A-Frame's default text font (`cdn.aframe.io/fonts/Roboto-msdf.*`) is vendored there too (`fonts/`), so scene text renders offline. Packaging (#20) must ship the vendored folder.

**Analyse on open (#139).** When a folder opens (at launch with `--folder`, from File > Open Folder… or Open Recent), the IDE analyses it in XR (deep) without a click, the same analysis as the button. The Analysis view's **Analyse in XR when a folder opens** checkbox turns it off; the choice is kept in the core's global state (`ide.analysis.autoStartOnOpen`, `xr-deep` or `off`, on by default). Without a ready Python environment it waits for one and never sets it up itself. A folder with more than 5,000 files (`.git`, `node_modules`, virtual environments and build output not counted, the walk stops at the limit: `analysis/projectSize.ts`) asks first in a native dialog. Reopening the folder a window already shows reuses its running scene; opening another folder closes the old scene and stops its server, so a project left behind is not served on.

**The scene's header and sharing it through Cloudflare (#155).** Above the scene, the header shows the analysis kind (`XR · deep`), the analysed folder's name (its full path in the tooltip) and the local address (`http://localhost:<port>`, the server's own URL) with a copy button. **Share through Cloudflare** starts the core's `RemoteAccessManager` for that scene's server, exactly as the extension's Active Servers view does: the first time, the core asks in a native dialog before downloading cloudflared (a `cloudflared` already on `PATH` is used without asking). While the tunnel starts the button reads *Starting tunnel…* and is disabled; once shared, the header shows the Cloudflare address under the local one, each with a copy button, and **Stop sharing**. The Cloudflare copy button copies the **invitation link** (`…trycloudflare.com/join?invite=…`), because the core lets a remote guest in only through it and the pairing code the IDE then shows in a native dialog. A failure (cloudflared exited, no link within 30 s) shows its message in the header and the button can be pressed again.

- **Nothing names a server from the page.** `analysis.shareScene()`, `stopSharingScene()` and `copySceneAddress('local' | 'invitation')` act on the scene of the calling window, resolved in the main process from `AnalysisService`'s per-window map; the copy is done there with Electron's `clipboard`, from the main process's own state, so the page never sends text to the clipboard and needs no clipboard permission. State changes reach the window through the `analysis:scene-share-changed` event, tagged with the scene's URL; the main process passes on only a status, a `https://<name>.trycloudflare.com` origin and a bounded error (`analysis/sceneShare.ts`).
- **Only on request.** The core shares every newly launched server on its own while its *cross-network connections* setting is on, and that is its default. The IDE turns the setting off at start-up (in its own core storage, not the extension's) and turns it on only for the duration of a click on **Share** (`startShareOnce`), serialised with analysis launches (`SerialQueue`), so no server is ever launched while it is on and nothing is shared unasked.
- **No orphan cloudflared.** The tunnel stops with **Stop sharing**, when the scene is closed (its server keeps running, the tunnel does not), when the window opens another folder or closes, when a new analysis replaces the window's scene, and when the app quits (the core's manager is disposed on `will-quit`, which stops every tunnel). A tunnel that finishes starting after its scene went is stopped at once.

The renderer only reports the slot's bounds (`analysis.setSceneBounds`, sanitised in the main process) and may start an analysis kind from a closed list; the main process re-checks that a folder is open and the Python environment is ready, so nothing here can trigger a download.

## Security baseline

Following Electron's [security checklist](https://www.electronjs.org/docs/latest/tutorial/security). Each rule lives in one place and is enforced by a test, a startup assertion or the smoke run:

| Rule | Where | Enforced by |
|---|---|---|
| `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (also in workers and subframes), `webSecurity: true`, no insecure content, no `<webview>` | `src/main/security.ts` (`secureWebPreferences`) | `assertSecureWebPreferences` at window creation, against the preferences the window actually runs with: the IDE refuses to start otherwise. Unit tests flip each one. |
| Every renderer sandboxed process-wide | `app.enableSandbox()` in `src/main/hardening.ts` | Smoke: `require` and `process` are unreachable from the page. |
| Strict Content-Security-Policy: `default-src 'none'`, scripts only from the app, no `eval`, no inline scripts. Styles allow `'unsafe-inline'` because Monaco creates `<style>` elements at run time (as in VS Code); nothing else is relaxed, so CSS cannot load or send anything off the app | `buildContentSecurityPolicy` in `src/main/security.ts`, sent as a response header (app protocol in production, `webRequest` in development) | Unit tests; smoke checks that `eval` throws in the real page. |
| Renderer served from `codexr://app/`, never `file://` | `src/main/appProtocol.ts`, `src/main/assetPath.ts` | Unit tests for path traversal (`..`, encoded `%2e%2e`, `%5c`, NUL). |
| No navigation away from the app, no `window.open`, no `<webview>` | `src/main/hardening.ts` | Unit tests for the URL policy; smoke tries both from inside the page. |
| No permission granted (camera, microphone, XR, notifications...) | `src/main/hardening.ts` | Each later story allow-lists only what it needs. |
| The renderer reaches files only inside the open folder, by workspace-relative path | `src/main/workspace/` (`parseWorkspacePath`, `Workspace`), one folder per window | Unit tests for `..`, absolute paths, drive letters, `\\`, NUL and symlinks that lead out; smoke reads a file and tries `../`. |
| IPC only on allow-listed channels, only from trusted frames | `IPC_CHANNELS` in `src/shared/api.ts`, `src/main/ipc.ts` | Unit tests; startup check that every channel has a handler. |
| Typed, frozen preload API, the only path from renderer to Node | `src/preload/index.ts`, `CodeXRApi` in `src/shared/api.ts` | Lint forbids `electron`, `node:*` and main/preload imports in the renderer; smoke checks the API is frozen and answers. |
| The renderer cannot start a process: a terminal starts only from a detected or user-saved profile, named by id, and only the window that created it can write to it or read it | `src/main/terminal/` (`ProfileRegistry.resolve`, `TerminalService`) | Unit tests (unknown ids, foreign windows, bad sizes and input); smoke opens a terminal and reads its output. |
| The dev server URL is ignored in a packaged build | `src/main/index.ts` (`app.isPackaged`) | Code review. |

Running as root (containers, some CI images) requires `--no-sandbox`, which the scripts add only in that case. It turns off Chromium's OS-level sandbox and `app.enableSandbox()`; the per-window `sandbox: true` preference and its assertion stay.

## Terminal (#137)

A bottom panel of terminal tabs: [xterm.js](https://xtermjs.org/) in the renderer, [node-pty](https://github.com/microsoft/node-pty) in the main process. Each terminal starts in the open folder (the home folder when none is open) and keeps running while you switch tabs or hide the panel.

**Shell profiles.** `src/main/terminal/shellProfiles.ts` detects them, as a pure function with the file system, the environment and the registry injected, so every OS is unit-tested on every OS:

- **Windows:** Git Bash first (`--login -i`), found through `HKLM\SOFTWARE\GitForWindows` `InstallPath`, then `Program Files\Git`, `Program Files (x86)\Git` and `%LOCALAPPDATA%\Programs\Git`; then PowerShell 7 (`pwsh.exe`), Windows PowerShell, `cmd.exe`, and WSL when `wsl.exe` exists.
- **macOS / Linux:** `$SHELL`, then `/bin/bash`, then `/bin/sh` (login shells, `-l`, on macOS, as Terminal.app starts them).

The first detected profile is the default until the person picks another in the panel's profiles menu (the chevron); the choice is saved in `terminal-settings.json` in the user-data folder (written through a temporary file and a rename, `core/jsonStore.ts`) and used by every new terminal, after restarts too. A saved default that no longer exists falls back to the first detected profile. #18 will move the picker into the settings UI.

**Security model of the pty IPC.** A terminal runs whatever its executable is told, so the bridge is narrower than "spawn":

- The renderer never sends an executable path, a command line, an environment or a working folder. `terminal.create(profileId, cols, rows)` names a profile from `terminal.profiles()` (or null for the default); `ProfileRegistry.resolve` maps it to an executable in the main process and refuses anything else. The folder is the one the window has open; the environment is the IDE's minus Electron's own switches (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` ...), plus `TERM=xterm-256color`.
- **Custom profiles** are added only through the main process: `terminal.addCustomProfile(args)` opens a native file dialog for the executable, then shows the exact command line (executable plus the proposed arguments, split without any shell expansion) in a native confirmation the page cannot answer. A compromised page can propose arguments but cannot save a profile without the person picking the file and confirming. Saved entries are re-validated on every read (absolute path, at most 32 short arguments, no NUL).
- A pty never leaves the main process. Terminals are numbered by the main process and owned by the `webContents` that created them: input, resize, kill and the data and exit events only work for, and only reach, that window. Sizes are integers from 1 to 1000; one input call carries at most 1,000,000 characters; a window holds at most 20 terminals.
- **No orphans.** A window's ptys are killed when it is closed, crashes or reloads (`destroyed`, `render-process-gone`, `did-navigate`), all of them on `will-quit`, and explicitly before the smoke run's `app.exit`.
- **No CSP change.** xterm.js 6 draws with DOM elements and inline styles, which the existing `style-src 'unsafe-inline'` (needed by Monaco) already allows; it needs no script, worker, eval or network. The smoke run checks for CSP violations while the terminal runs. Copy uses `execCommand('copy')` from the key handler and paste the browser's own paste event, so no clipboard permission is granted.

**Keys.** Ctrl+\` toggles the panel and Ctrl+Shift+\` opens a terminal, also from inside a terminal (xterm leaves those keys to the menu). Ctrl+C sends an interrupt. Copy and paste: Ctrl+Shift+C / Ctrl+Shift+V on Windows and Linux (on Windows Ctrl+C copies while text is selected and Ctrl+V pastes, as in Windows Terminal), Cmd+C / Cmd+V on macOS.

**node-pty under Electron.** node-pty is pinned to `1.2.0-beta.18`, an N-API build whose npm package carries prebuilt binaries for win32, darwin and linux (x64 and arm64), so `npm ci` compiles nothing and the same binary loads in Node and in Electron: no `@electron/rebuild`, no compiler on a developer machine or a CI runner. (1.1.0, the last stable release, has no Linux prebuilds and packs the macOS `spawn-helper` without its execute bit, so spawning fails there.) It is the only package the main bundle leaves external (`scripts/viteConfigs.mjs`), and it is loaded on the first terminal, so a broken native module costs the terminal, not the IDE. Packaging it per OS (outside an asar) belongs to #20.

### Adding a capability to the renderer

1. Add the method to `CodeXRApi` and a channel to `IPC_CHANNELS` (`src/shared/api.ts`).
2. Expose it in `src/preload/index.ts`, one member per channel. Never expose `ipcRenderer` or a generic `invoke`.
3. Register the handler in `src/main/ipc.ts` through `handle()`, which already rejects untrusted frames. Validate every argument: the renderer is untrusted.
4. Add a unit test for any pure logic, and extend the smoke probe if the capability is security-relevant.

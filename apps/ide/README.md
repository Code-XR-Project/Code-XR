# Code-XR IDE

The standalone Code-XR IDE: a desktop environment built on **Electron + Monaco** where editing code, analysing it and exploring it in XR are one workflow. The platform decision is ADR 0001 ([`adr/0001-code-xr-ide-platform.md`](../../adr/0001-code-xr-ide-platform.md)); the work is tracked in epic #11.

**Status:** stories #12 (secure scaffold) and #14 (open a project, edit with Monaco) are done, pending a manual try; story #15 (the Python environment) is in progress; story #138 (file and language icons) is done, pending a manual try. A folder opens from File > Open Folder… (Ctrl/Cmd+O), the explorer's button or `--folder=<path>` on the command line, and the explorer shows it as a lazily loaded tree (`.git` and `node_modules` hidden, root `.gitignore` matches dimmed). Every entry of the explorer and every tab shows the icon of its language or type, VS Code style: by file name first (`package.json`, `Dockerfile`, `.gitignore`), then by extension, with open and closed folder icons and special ones for `src`, `test`, `.github`, `node_modules` and other common folders (#138; every language of the metric contract has one, anything else gets a generic icon). Files open in Monaco tabs (loaded on the first open, in its own chunk) with syntax highlighting, a dirty mark, File > Save (Ctrl/Cmd+S), Save All (Ctrl/Cmd+Alt+S) and Close Editor (Ctrl/Cmd+W); the explorer and the open files follow the disk (one non-recursive watcher per expanded folder and per open file's folder): a clean tab reloads, an unsaved one keeps your text and is marked as changed or deleted on disk, and saving over a newer file asks first. Closing the window with unsaved tabs asks Save All / Don't Save / Cancel. The explorer creates files and folders (its toolbar, File > New File… Ctrl/Cmd+N, File > New Folder…), renames with F2 and moves to the OS trash with Delete (never a permanent delete); names that Windows would refuse are refused on every OS so a project stays portable. File > Open Recent and the empty explorer list the last 10 folders (kept in the user-data folder); the renderer can only reopen a folder from that list, never an arbitrary path. The Analysis view (second activity item) and the status bar show the Python environment the analyses run in (#15): whether a Python was found, a set-up that asks in a native dialog listing every package and its source before anything is downloaded (the language parsers for the dependency graph included, so an analysis never downloads anything), progress, repair and removal. Analyses themselves come with #16.

## Commands

Run them from the repository root after `npm ci`:

| Command | What it does |
|---|---|
| `npm run ide:dev` | Vite dev server with hot reload for the renderer; main and preload are rebuilt and Electron restarted on every change. |
| `npm run ide:build` | Production build into `apps/ide/out/`. |
| `npm run ide:start` | Build, then run the built IDE (no dev server). |
| `npm run ide:smoke` | Build, launch the IDE hidden with `--codexr-smoke`, probe the security baseline from inside the real renderer, exit 0 or 1. On Linux without a display use `xvfb-run -a npm run ide:smoke`. |
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
| The dev server URL is ignored in a packaged build | `src/main/index.ts` (`app.isPackaged`) | Code review. |

Running as root (containers, some CI images) requires `--no-sandbox`, which the scripts add only in that case. It turns off Chromium's OS-level sandbox and `app.enableSandbox()`; the per-window `sandbox: true` preference and its assertion stay.

### Adding a capability to the renderer

1. Add the method to `CodeXRApi` and a channel to `IPC_CHANNELS` (`src/shared/api.ts`).
2. Expose it in `src/preload/index.ts`, one member per channel. Never expose `ipcRenderer` or a generic `invoke`.
3. Register the handler in `src/main/ipc.ts` through `handle()`, which already rejects untrusted frames. Validate every argument: the renderer is untrusted.
4. Add a unit test for any pure logic, and extend the smoke probe if the capability is security-relevant.

# Code-XR IDE

The standalone Code-XR IDE: a desktop environment built on **Electron + Monaco** where editing code, analysing it and exploring it in XR are one workflow. The platform decision is ADR 0001 ([`adr/0001-code-xr-ide-platform.md`](../../adr/0001-code-xr-ide-platform.md)); the work is tracked in epic #11.

**Status:** story #12 (secure scaffold) is done; story #14 (open a project, edit with Monaco) is in progress. A folder opens from File > Open Folder… (Ctrl/Cmd+O), the explorer's button or `--folder=<path>` on the command line, and the explorer shows it as a lazily loaded tree (`.git` and `node_modules` hidden, root `.gitignore` matches dimmed). The editor, the Python environment (#15) and analyses (#16) come next.

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
│   └── shared/      the renderer <-> main contract (api.ts), imported by all three
├── test/            unit tests (node:test, TypeScript run by Node's type stripping)
├── scripts/         build, dev, start and smoke runners (Vite's JS API)
└── out/             build output, git-ignored: main/index.cjs, preload/index.cjs, renderer/
```

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
| Strict Content-Security-Policy: `default-src 'none'`, scripts and styles only from the app, no `eval`, no inline scripts | `buildContentSecurityPolicy` in `src/main/security.ts`, sent as a response header (app protocol in production, `webRequest` in development) | Unit tests; smoke checks that `eval` throws in the real page. |
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

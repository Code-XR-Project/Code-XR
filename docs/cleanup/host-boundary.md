# Host boundary and layering analysis (2026-11-25)

> Read-only analysis of `apps/vscode-extension/src` made for epic #26. It answers one question: how should the code be organized so that the future Code-XR IDE (epic #11) can reuse the analysis and server logic, **without** building the IDE now. Paths are relative to `apps/vscode-extension/src` unless stated otherwise. Counts come from regex and an in-memory import-graph walk.

## 1. Who imports `vscode`

- **369 `.ts` files; 179 import `vscode`** (matches `adr/0001-code-xr-ide-platform.md`). The other 190 do not import it directly, but only **101 are vscode-free once their imports are followed** (94 without `index.ts` barrels).
- **By folder** (vscode files / all files): `code_analysis` 87/200, `views` 23/34, `servers` 13/34, `commands` 9/14, `visualize_data` 8/9, `visualization_settings` 7/10, `active_servers` 6/9, `python_env` 6/10, `babia_examples` 5/7, `utils` 5/13, `babia_templates` 3/11, `core` 2/4, `remote_access` 2/5, `collaboration` 1/5, `learn_more` 1/3, `extension.ts` 1.
- **Heaviest use per file:** TreeView UI 60, `ExtensionContext` only (passed through or used for `extensionPath`) 37, notifications/dialogs only 23, commands 19, storage 16, workspace/editor/fs 15, webview 4, `getConfiguration` 3, types/`Uri` only 2.
- **Overlapping counts:** `ExtensionContext` 152, `window.show*`/`withProgress` 67, TreeItem/ThemeIcon/EventEmitter 65, `Uri` 44, commands 25, `getConfiguration` 9, `globalState` 5, `workspaceState` 4, storage URIs 23, webview 4.
- **Main finding:** most of the coupling is the `ExtensionContext` type plus `show*Message`. Only 9 files read configuration.

## 2. Candidates for a future `packages/core`

- **No changes needed (94 fully vscode-free files):** most of `code_analysis/historical/git*`, `code_analysis/export/*` except `gitRevisionExporter.ts`, `refresh/analysisRefreshCoordinator.ts`, the engine watchers' pure helpers, `engine/components/customComponents/*` (22), `dependencies/dependencyGraphModels.ts`, `configuration/models/*`; in `servers`: `runtime/sse/*`, `runtime/http/*`, `runtime/portManager.ts`, `runtime/broadcast/screenBroadcastSignalingServer.ts`, `runtime/remote/{pairingPage,brandMark}.ts`, `utils/networkUtils.ts`; plus chart models/registry, several `utils/*`, `remote_access/security/remoteSessionAuthority.ts`, `collaboration/model/*`, `core/logging/logPolicy.ts`, `core/startup/startupCoordinator.ts`, `python_env/utils/pythonEnvUtils.ts`.
- **Trivial changes (15 files that pull `vscode` in through a single import):**
  - `servers/runtime/collaboration/collaborationRoomServer.ts`, `remote/{remotePairingApi,remoteAccessPolicy}.ts`, `collaboration/collaborationSessionApi.ts` import the `remote_access`/`collaboration` barrels, which re-export vscode-bound managers. Importing the model/security files directly fixes it.
  - `babia_templates/processing/dimensionValidator.ts` and the dimension-mapping validator depend on `xrFieldSchemaService.ts` (vscode only for the `ExtensionContext` type and `globalState`).
  - `active_servers/services/serverRegistrar.ts` depends on `activeServerRegistry.ts`, which uses vscode only for `vscode.EventEmitter`.
  - The analysis bridges and router depend on `analysisFeatureHost.ts` (optional `ExtensionContext`) and `sessionWatcherManager.ts` (type only).
- `core/logging/logger.ts` reads configuration, the extension mode and the output channel and is imported by 16 files: the first thing a host port would inject (story #13).

## 3. How templates are found at runtime

- **22 files build template paths by hand**, almost always `path.join(context.extensionPath, 'templates', …)`; 39 files touch `extensionPath`/`extensionUri` (236 hits). There is no central resolver.
- **Fallback that could break:** `servers/runtime/{httpServer,httpsDefaultServer,httpsCustomServer,multiServerLauncher}.ts` default `staticRoot` to `path.join(__dirname, '../../../templates')`, which is only right in the unbundled layout. Callers appear to always pass `staticRoot` (to confirm with a test).
  - **Done in #42:** all of them, plus the 17 `extensionPath` call sites, go through `resolveTemplatePath()` (`src/platform/templatePaths.ts`). `test/platform/templatePaths.test.cjs` evaluates `httpServer.js` with the bundle's `__dirname` (`<extension>/dist`) and asserts the default static root is `<extension>/templates`; it also fails on any new `__dirname`-relative template path in `src/`.
- **Templates ship once (since story #41):** the `files` allowlist ships `templates/**`; webpack no longer copies it into `dist/templates`.
- **Moving templates to `packages/xr-scenes`** would need: the copy source changed, a decision on the `files` entry, `scripts/prepare-dev-extension.mjs` and `scripts/dist-fingerprint.mjs` updated, and 38 test files retargeted (11 build `projectRoot/templates` directly; `test/helpers/runtimeAssembly.cjs` and `sourceText.cjs` hardcode it).

## 4. Folder dependencies and layering

Two-way cycles between top-level folders (A→B / B→A import edges):

| Folders | A→B | B→A |
|---|---|---|
| `code_analysis` ↔ `servers` | 6 | 13 |
| `babia_templates` ↔ `code_analysis` | 2 | 21 |
| `active_servers` ↔ `servers` | 4 | 5 |
| `remote_access` ↔ `servers` | 1 | 9 |
| `collaboration` ↔ `remote_access` | 1 | 4 |
| `active_servers` ↔ `remote_access` | 4 | 2 |
| `code_analysis` ↔ `views` | 1 | 3 |
| `code_analysis` ↔ `active_servers` | 2 | 1 |
| `commands` ↔ `code_analysis` | 2 | 1 |

`commands` is also in cycles with `utils`, `python_env`, `learn_more`, `visualization_settings`, `visualize_data`, `babia_examples` and `active_servers`, because they import `commands/shared`.

Layering violations:
- `code_analysis/engine/core/sessionRegistry.ts` (core session state) shows warnings, runs `workbench.view…` commands and uses `vscode.EventEmitter`. **#42:** `createSession` now returns `{ kind: 'created' | 'duplicate' }` and `AnalysisOrchestrator` shows the warnings (texts unchanged, pinned by `analysisOrchestratorDuplicate.test.cjs`); the `vscode.EventEmitter` and the `ExtensionContext` type remain.
- `servers/runtime/multiServerLauncher.ts` imports the UI module `active_servers/views/interactions/handleServerActions.ts`; `previewRenderer.ts` imports the webview `panelManager`.
- `code_analysis/services/serverWatcherIntegration.ts` imports `active_servers/registry` and `serverControl`.
- `executePython.ts` and `gitRevisionExporter.ts` import `python_env/runtime/venvManager.ts` (vscode-bound).
- `utils/commandBuilder.ts` imports `commands/shared`; `utils/getVisualizationConfiguration.ts` dynamically imports `visualization_settings`.

## 5. What this epic does, and what it leaves to story #13

**Plain cleanup, in epic #26 (story #42 unless noted):**
1. Direct model/security imports instead of barrels in the four `servers/runtime/*` files (about 6 files become vscode-free).
2. A Node emitter instead of `vscode.EventEmitter` in `activeServerRegistry.ts`.
3. Delete the zero-byte modules and the configuration example (story #29).
4. One `resolveTemplatePath()` for the 22 call sites; fix or remove the `__dirname` fallback; a `templatesRoot()` test helper.
5. UI side effects out of `sessionRegistry.ts` and the `handleServerActions` import out of `multiServerLauncher.ts` (with story #39).
6. Move the pure `commandRegistry` to `core/`, so feature folders stop importing `commands/shared`.
7. A dependency-direction test that pins the allowed folder edges and fails on a new cycle.

**Belongs to [#13](https://github.com/Code-XR-Project/Code-XR/issues/13) (epic #11) — deliberately not started:** a `HostServices` / ports interface (notifier, configuration, key-value store, asset locator, progress) with a VS Code adapter; injecting `logger.ts` behind a sink port; replacing `ExtensionContext` with narrow parameters in the 37 pass-through files; moving `xrFieldSchemaService` storage behind a port; creating `packages/core` / `packages/xr-scenes` or moving files into them.

# VS Code API inventory for #13 — extracting a host-agnostic Code-XR core

Issue: Code-XR-Project/Code-XR#13 ("Extract a host-agnostic Code-XR core from the VS Code extension").
Date: 2026-11-26. Tree: branch `v1.2.1` at `6f827a19` (merge of PR #99).
Scope: `apps/vscode-extension/src/**/*.ts` (300 files). `node_modules`, `dist`, `out` were never scanned. Paths below are relative to `apps/vscode-extension/src` unless they say otherwise.

**Progress.** Step 1 of §4.2 (the seam, no consumers) landed with this document: `core/host/codeXRHost.ts`, `core/host/hostRegistry.ts`, the adapter in `app/host/vscodeHost.ts` (not `platform/host/`: `platform` sits below `core` in the layer order, so it may not import `core/host`) and `vscodeFreeFloor` 106 -> 116. Step 2 (first part): `core/host/hostPaths.ts` (`hostPathsFromContext`, `privateStorageRoot`, `EXTENSION_MODE` checked against `@types/vscode`); `backendScriptPath.ts` takes `HostPaths` and is vscode-free; the five `storageUri?.fsPath || globalStorageUri.fsPath` copies use `privateStorageRoot`; floor 116 -> 118. Still to do in step 2: `settingsFile.ts`, `generatedHttpsCertificateManager.ts`, `pythonEnvStorage.ts`, `themeUtils.ts`, and the logger-to-sink switches.

---

## 1. Method and counts

### 1.1 Commands

All run from `apps/vscode-extension/src`.

```bash
# files and importers
find . -name '*.ts' | wc -l                                                     # 300
grep -rlE "from ['\"]vscode['\"]|require\(['\"]vscode['\"]\)" --include='*.ts' . | wc -l   # 171

# import shapes (no require('vscode') exists)
grep -rhoE "import (type )?(\* as [a-zA-Z]+|\{[^}]*\}|[a-zA-Z]+) from ['\"]vscode['\"]" --include='*.ts' . | sort | uniq -c

# per-folder counts (top level = field 2, second level = fields 2/3)
grep -rlE "from ['\"]vscode['\"]" --include='*.ts' . | awk -F/ 'NF>3{print $2"/"$3} NF<=3{print $2}' | sort | uniq -c

# every API member, with call sites and distinct files
grep -rnoE "vscode\.[A-Za-z_]+(\.[A-Za-z_]+)?" --include='*.ts' . > members.txt
# ExtensionContext members are reached through a variable, not `vscode.`:
grep -rnoE "\.(globalState|workspaceState|secrets|globalStorageUri|storageUri|extensionPath|extensionMode|extensionUri|subscriptions)\b" --include='*.ts' .

# transitive closure (type imports included), using the repo's own measurement
cd .. && node -e "const m=require('./test/tooling/folderDependencies.cjs').measure(); console.log(m.fileCount, m.vscodeFree.length)"
```

Caveat: member counts are regex counts of the textual `vscode.X.Y` occurrences, so a type annotation and a call both count as a "site". Command-ID strings (`'vscode.open'`, `'vscode.openFolder'`) and the webview-side `vscode.postMessage` inside an HTML template string (`features/active-servers/services/previewRenderer.ts`) were excluded.

### 1.2 Headline numbers

| Metric | Value |
|---|---|
| TS files under `src/` | 300 |
| Files importing `vscode` directly | **171** (57%) — ADR 0001 still says 179 |
| `import * as vscode from 'vscode'` | 167 |
| `import type * as vscode from 'vscode'` | 3 (`core/server/generatedHttpsCertificateManager.ts`, `multiServerLauncher.ts`, `httpsServerBase.ts`) |
| `import type { ExtensionContext } from 'vscode'` | 1 (`core/server/serverFactory.ts`) |
| `require('vscode')` | 0 |
| Files that do not import `vscode` | 129 |
| Files from which **no import path** reaches `vscode` (`measure().vscodeFree`) | **114** (floor in `test/tooling/folderDependencies.json`: 106) |
| Files clean themselves but tainted through an import | 15 (see §5.9) |
| Files that use `vscode` **only for types** (no runtime member) | 53 (33 of them in `core/`, `platform/`, `app/`) |

### 1.3 Per top-level folder

| Folder | TS files | Import `vscode` | Transitively vscode-free |
|---|---:|---:|---:|
| `app/` | 7 | 4 | 1 |
| `core/` | 166 | **54** | 101 |
| `features/` | 114 | **106** | 4 |
| `platform/` | 11 | 6 | 5 |
| `shared/` | 1 | 0 | 1 |
| `extension.ts` | 1 | 1 | 0 |

### 1.4 Per second-level folder

| Folder | Files | Import `vscode` | Transitively free |
|---|---:|---:|---:|
| `app/commands` | 2 | 1 | 0 |
| `app/sidebar` | 4 | 3 | 0 |
| `app/startup` | 1 | 0 | 1 |
| `core/analysis` | 68 | 27 | 41 |
| `core/charts` | 15 | 6 | 8 |
| `core/collaboration` | 4 | 1 | 3 |
| `core/dependencies` | 2 | 1 | 1 |
| `core/export` | 8 | 1 | 7 |
| `core/history` | 16 | 3 | 12 |
| `core/python-env` | 5 | 3 | 2 |
| `core/remote-access` | 4 | 2 | 2 |
| `core/server` | 44 | 10 | 27 |
| `features/active-servers` | 10 | 8 | 1 |
| `features/analysis` | 55 | 52 | 1 |
| `features/collaboration` | 3 | 3 | 0 |
| `features/examples` | 10 | 9 | 1 |
| `features/learn-more` | 5 | 5 | 0 |
| `features/python-env` | 4 | 4 | 0 |
| `features/servers` | 6 | 5 | 0 |
| `features/visualization-settings` | 9 | 9 | 0 |
| `features/visualize-data` | 12 | 11 | 1 |
| `platform` (root files) | 2 | 1 | 1 |
| `platform/commands` | 2 | 1 | 1 |
| `platform/logging` | 3 | 1 | 2 |
| `platform/tree` | 1 | 1 | 0 |
| `platform/ui` | 2 | 1 | 1 |
| `platform/webview` | 1 | 1 | 0 |

Third level inside the two big core areas:

| Folder | Files | Import `vscode` | Transitively free |
|---|---:|---:|---:|
| `core/analysis/scene-assets` | 22 | 0 | 22 |
| `core/analysis/watchers` | 11 | 6 | 5 |
| `core/analysis/launch` | 6 | 1 | 5 |
| `core/analysis/launchers` | 4 | 4 | 0 |
| `core/analysis/parsers` | 4 | 4 | 0 |
| `core/analysis/python` | 4 | 3 | 1 |
| `core/analysis/utils` | 4 | 2 | 2 |
| `core/analysis/processors` | 2 | 2 | 0 |
| `core/analysis/session` | 2 | 2 | 0 |
| `core/analysis/session-servers` | 2 | 1 | 1 |
| `core/analysis/configuration` | 2 | 1 | 1 |
| `core/analysis/languages`, `refresh` | 2 + 2 | 0 | 4 |
| `core/analysis/analysisOrchestrator.ts` | 1 | 1 | 0 |
| `core/server/*.ts` (root) | 15 | 9 | 6 |
| `core/server/analysis` | 6 | 1 | 0 |
| `core/server/collaboration` | 7 | 0 | 6 |
| `core/server/broadcast`, `remote`, `registry`, `http`, `sse`, `ws` | 4+4+3+2+2+1 | 0 | 16 |

---

## 2. Every `vscode.*` member used

Sites = textual occurrences; Files = distinct files. Whole `src/` first, `core/` share in the last column.

### 2.1 Configuration

| Member | Sites | Files | In core |
|---|---:|---:|---:|
| `vscode.workspace.getConfiguration` (`.get('codeXR.debug.verboseLogs')`) | 1 | 1 | 0 |
| `vscode.workspace.onDidChangeConfiguration` | 1 | 1 | 0 |

Both live in `platform/logging/logger.ts`. **Code-XR keeps almost no settings in VS Code configuration** — user settings are JSON files under `globalStorageUri` (`core/server/serverSettingsManager.ts`, `core/charts/settings/settingsStorage.ts`, `core/analysis/configuration/analysisConfigurationStorage.ts`, `core/collaboration/collaborationProfileManager.ts`). That is good news for #13: configuration is a non-issue for the core.

### 2.2 Logging / output

| Member | Sites | Files | In core |
|---|---:|---:|---:|
| `vscode.window.createOutputChannel` | 2 | 2 | 0 |
| `vscode.OutputChannel` (type) | 1 | 1 | 0 |

Logging is already host-agnostic: `platform/logging/sink.ts` (vscode-free) exposes `getLogger(scope)`; `platform/logging/logger.ts` only attaches an OutputChannel as a log target. Three core files still import `logger.ts` instead of `sink.ts` and are tainted by it: `core/analysis/utils/themeUtils.ts`, `core/python-env/venvManager.ts`, `core/server/serverSettingsManager.ts`.

### 2.3 Notifications, dialogs, quick picks, progress

| Member | Sites | Files | In core |
|---|---:|---:|---:|
| `vscode.window.showInformationMessage` | 116 | 37 | 33 / 11 files |
| `vscode.window.showErrorMessage` | 106 | 45 | 11 / 9 |
| `vscode.window.showWarningMessage` | 65 | 30 | 16 / 7 |
| `vscode.window.showQuickPick` | 28 | 15 | 0 |
| `vscode.window.showInputBox` | 9 | 8 | 2 (remoteAccessManager) |
| `vscode.window.showOpenDialog` | 6 | 5 | 0 |
| `vscode.window.withProgress` | 9 | 5 | 5 (executePython, venvManager×3, cloudflaredBinaryManager) |
| `vscode.ProgressLocation.Notification` | 9 | 5 | 5 |
| `vscode.Progress` (type) | 16 | 3 | 16 (executePython 9, venvManager 6, gitRevisionExporter 1) |
| `vscode.CancellationToken` (type) | 1 | 1 | 1 (gitRevisionExporter) |
| `vscode.window.setStatusBarMessage` | 4 | 3 | 2 (fileWatcherOrchestrator, directoryReAnalyzer) |
| `vscode.window.showWorkspaceFolderPick` | 1 | 1 | 0 |
| `vscode.QuickPickItem`, `vscode.OpenDialogOptions` (types) | 4 + 2 | 4 + 2 | 0 |

Group total: 380 sites / 62 files; core: 71 sites / 14 files.

### 2.4 File system and watchers

| Member | Sites | Files | In core |
|---|---:|---:|---:|
| `vscode.workspace.fs` (`readFile`, `writeFile`, `stat`, `createDirectory`, `readDirectory`) | 11 | 6 | 5 (all `core/analysis/configuration/analysisConfigurationStorage.ts`) |
| `vscode.workspace.findFiles` | 1 | 1 | 0 |
| `vscode.workspace.createFileSystemWatcher` / `vscode.FileSystemWatcher` | 1 + 1 | 1 | 0 |
| `vscode.RelativePattern` | 2 | 2 | 0 |
| `vscode.FileType.{Directory,File,SymbolicLink}` | 7 | 4 | 0 |

The core's re-analysis watchers (`core/analysis/watchers/*`) already use Node `fs.watch`/polling — not `vscode.workspace.createFileSystemWatcher`. The only VS Code watcher is in `features/analysis/workspace/workspaceSnapshotService.ts` (sidebar file tree).

### 2.5 Workspace and paths

| Member | Sites | Files | In core |
|---|---:|---:|---:|
| `vscode.workspace.workspaceFolders` | 18 | 12 | 1 (`core/dependencies/dependencyGraphService.ts:253`) |
| `vscode.workspace.onDidChangeWorkspaceFolders` | 1 | 1 | 0 |
| `vscode.workspace.asRelativePath` | 1 | 1 | 0 |
| `vscode.workspace.openTextDocument` | 3 | 3 | 0 |
| `vscode.window.activeTextEditor` | 5 | 4 | 0 |
| `context.extensionPath` | 32 | — | ~30 (templates, Python backend, avatar assets) |
| `context.globalStorageUri(.fsPath)` | 23 | 23 files mention it | 19 files in core |
| `context.storageUri(.fsPath)` | 10 | — | 8 files in core |
| `context.extensionUri` | 1 | 1 | 0 |

The pattern `context.storageUri?.fsPath || context.globalStorageUri.fsPath` is repeated verbatim in five core files: `core/history/historicalComparisonService.ts:87`, `core/history/projectEvolutionService.ts:66`, `core/dependencies/dependencyGraphService.ts:33`, `core/export/gitRevisionExporter.ts:43` and `:67`.

### 2.6 Secrets / storage

| Member | Sites | Files | In core |
|---|---:|---:|---:|
| `ExtensionContext.globalState.get/update` | 9 | 6 | 7 sites / 4 files: `core/analysis/python/xrFieldSchemaService.ts`, `core/charts/settings/settingsStorage.ts`, `core/charts/settings/settingsAccessors.ts`, `core/remote-access/cloudflaredBinaryManager.ts` (download-consent flag) |
| `ExtensionContext.workspaceState.get/update` | 9 | 3 | 0 (`features/analysis/workspace/workspaceSnapshotService.ts`, `features/visualize-data/model/*`) |
| `ExtensionContext.secrets` / `SecretStorage` | 0 | 0 | 0 |

`globalState` in `settingsStorage`/`settingsAccessors` is only read for a legacy-migration key; the live store is a JSON file.

### 2.7 Extension context and lifecycle

| Member | Sites | Files | In core |
|---|---:|---:|---:|
| `vscode.ExtensionContext` (type) | 229 | **143** | 49 files |
| `context.subscriptions.push` | 12 | ~8 | 2 (collaborationProfileManager, remoteAccessManager) |
| `vscode.ExtensionMode.Development` / `context.extensionMode` | 2 | 2 | 1 (`core/analysis/python/backendScriptPath.ts:27`); other is `platform/logging/logger.ts:87` |

`platform/extensionContext.ts` is a module-level holder (`initializeExtensionContext` / `getExtensionContext`) — only `extension.ts` and `core/server/serverSettingsManager.ts` use it.

### 2.8 Commands

| Member | Sites | Files | In core |
|---|---:|---:|---:|
| `vscode.commands.executeCommand` | 53 | 22 | 7 sites / 5 files |
| `vscode.commands.registerCommand` | 1 | 1 | 0 (`platform/commands/commandBuilder.ts`) |
| `vscode.Command` (type) | 16 | 14 | 0 |

The seven core sites are all "poke the UI": `setContext` ×2 (`core/python-env/pythonEnvUiState.ts:108-109`), `codexr.servers.refresh` ×2 (`core/server/serverSettingsManager.ts:140,193`), `codeXR.activeServers.refreshServers` (`core/remote-access/remoteAccessManager.ts:509`), `codexr.server.configure` (`core/server/httpsCustomServer.ts:61`), `workbench.view.extension.codeXRView` (`core/analysis/analysisOrchestrator.ts:25`).

### 2.9 Environment (clipboard, browser)

| Member | Sites | Files | In core |
|---|---:|---:|---:|
| `vscode.env.openExternal` | 15 | 7 | 1 (remoteAccessManager) |
| `vscode.env.clipboard.writeText` | 10 | 4 | 5 (remoteAccessManager ×3, httpsDefaultServer ×2) |

### 2.10 Webviews / UI views

| Member | Sites | Files | In core |
|---|---:|---:|---:|
| `vscode.ThemeIcon` | 170 | 36 | 0 |
| `vscode.TreeItemCollapsibleState.*` | 140 | ~40 | 0 |
| `vscode.ThemeColor` | 49 | 18 | 0 |
| `vscode.TreeItem` / `TreeItemLabel` / `TreeDataProvider` | 26 + 1 + 2 | 18 | 0 |
| `vscode.MarkdownString` | 2 | 2 | 0 |
| `vscode.window.createTreeView` | 1 | 1 | 0 (`extension.ts`) |
| `vscode.window.createWebviewPanel` / `WebviewPanel` / `ViewColumn` | 2 + 4 + 2 | 2 | 0 |
| `vscode.window.createStatusBarItem` / `StatusBarItem` / `StatusBarAlignment` | 1+1+1 | 1 | **3 (`core/analysis/watchers/debounceManager.ts:43`)** |
| `vscode.window.showTextDocument` | 4 | 4 | 0 |

### 2.11 Types / value objects

| Member | Sites | Files | In core |
|---|---:|---:|---:|
| `vscode.Uri` (+ `.parse` 17, `.file` 12, `.joinPath` 5, `.from` 1) | 54 + 35 | 21 | `settingsFile.ts` (×2, parameter type), `analysisConfigurationStorage.ts` (`joinPath` ×2), `remoteAccessManager.ts` (`Uri.parse` for openExternal) |
| `vscode.EventEmitter` | 20 | 13 | 3: `core/analysis/session/sessionRegistry.ts:36`, `core/collaboration/collaborationProfileManager.ts:39`, `core/python-env/pythonEnvUiState.ts:23` |
| `vscode.Event` (type) | 11 | 10 | 0 |
| `vscode.Disposable` | 18 | 12 | 5 (httpServer, remoteAccessManager ×3, collaborationProfileManager, pythonEnvUiState) |

### 2.12 Other

None. No `languages.*`, `debug.*`, `tasks.*`, `authentication.*`, `l10n`, `extensions.getExtension`, `SecretStorage` or `workspace.getConfiguration` outside the logger.

### 2.13 Group totals

| Group | All `src/` (sites / files) | `core/` (sites / files) |
|---|---|---|
| Configuration | 2 / 1 | 0 / 0 |
| Logging / output | 3 / 2 | 0 / 0 |
| Notifications, dialogs, quick picks, progress | 380 / 62 | 71 / 14 |
| File system and watchers | 24 / 6 | 5 / 1 |
| Workspace and paths (incl. context path fields) | 94 / 50 | 53 / 28 |
| Secrets / storage | 18 / 8 | 7 / 4 |
| Extension context and lifecycle | 245 / 143 | 90 / 49 |
| Commands | 70 / 37 | 7 / 5 |
| Env (clipboard, openExternal) | 25 / 10 | 6 / 2 |
| Webviews / UI views | 402 / 43 | 3 / 1 |
| Types / value objects | 138 / 48 | 18 / 8 |

### 2.14 Files that import `vscode` only for types

53 files in total. The 33 outside `features/`, all of them using only `vscode.ExtensionContext` unless noted:

- `app/commands/registerAllCommands.ts`
- `core/analysis/launch/launchKinds.ts`, `launchers/launcherLivePanel.ts`, `launchers/launcherVisualizeDOM.ts`
- `core/analysis/parsers/directoryXRParser.ts`, `livePanelParser.ts`, `visualizeDOMParser.ts`
- `core/analysis/processors/FileRequirementProcessor.ts`, `analysisBootstrap.ts`
- `core/analysis/python/xrFieldSchemaService.ts`
- `core/analysis/session-servers/serverLaunchOrchestrator.ts`, `core/analysis/session/analysisSession.ts`
- `core/analysis/utils/saveFiles.ts`, `themeUtils.ts`
- `core/analysis/watchers/directoryWatcherOrchestrator.ts`, `reAnalysisManager.ts`, `sessionWatcherManager.ts`
- `core/charts/processing/placeholders/createStructure.ts`, `templateHTMLProcessor.ts`, `templateProcessor.ts`
- `core/charts/settings/settingsAccessors.ts`, `settingsStorage.ts`
- `core/export/gitRevisionExporter.ts` (`ExtensionContext`, `Progress`, `CancellationToken`)
- `core/history/gitAnalysisSessionContext.ts`, `historicalComparisonService.ts`, `projectEvolutionService.ts`
- `core/python-env/pythonEnvStorage.ts`
- `core/server/analysis/analysisFeatureHost.ts`, `generatedHttpsCertificateManager.ts`, `httpsServerBase.ts`, `multiServerLauncher.ts`, `serverFactory.ts`
- `platform/extensionContext.ts`, `platform/webview/panelManager.ts` (`WebviewPanel`)

Only 4 of them use `import type`; the rest use `import * as vscode`, which `tsc` elides at emit (no `verbatimModuleSyntax` in `tsconfig.json`), so they do not `require('vscode')` at runtime but still count as edges in `measure()`.

**Of the 54 core files that import `vscode`, 32 need nothing but a type replacement** (mostly `ExtensionContext` → a host/paths type). Only 22 core files make runtime `vscode` calls.

---

## 3. Module classification

### 3.1 Pure UI — stays in the extension

| Folder | Why |
|---|---|
| `extension.ts`, `app/commands`, `app/sidebar` | activation, command registration, the ModularTreeDataProvider |
| `platform/tree`, `platform/commands/commandBuilder.ts`, `platform/webview/panelManager.ts`, `platform/ui/errorHandler.ts`, `platform/logging/logger.ts`, `platform/extensionContext.ts` | VS Code UI plumbing; the adapter (`VSCodeHost`) belongs next to them |
| All of `features/*/views`, `features/*/commands`, `features/*/sections` (95 files) | TreeItems, ThemeIcons, quick picks, command handlers |
| `features/active-servers/services/previewRenderer.ts` | webview panel |

Features that hide service logic worth a later look (not part of the first #13 cut): `features/analysis/workspace/workspaceFileScanner.ts` and `workspaceSnapshotService.ts` (workspace file inventory: `findFiles`, `createFileSystemWatcher`, `workspaceState`), `features/visualize-data/services/visualizationLauncher.ts` (475 L, 31 UI calls) and `visualizationRestorer.ts`, `features/examples/services/exampleLauncher.ts`. The IDE will need equivalents, but they are UI-orchestration today.

### 3.2 Already vscode-free (transitively)

101 of 166 core files, including whole subsystems:

- **Template / scene generation runtime assets**: `core/analysis/scene-assets/` (22/22), `core/analysis/languages`, `core/analysis/refresh`, most of `core/analysis/launch`.
- **Git / history engine**: `core/history/` 12/16 — `gitRepositoryService.ts`, `gitBatchObjectReader.ts`, `gitLineStream.ts`, `gitTimelineSampler.ts`, `gitSnapshotPlan.ts`, `gitOfflineEnvironment.ts`… (they shell out with Node `child_process`, which works unchanged in an Electron main process).
- **Export**: `core/export/` 7/8 (all but `gitRevisionExporter.ts`), including `gitExportPythonWorkerPool.ts`.
- **Servers**: `core/server/sse`, `ws`, `http`, `registry`, `remote`, `broadcast`, `collaboration` (6/7), plus `portManager.ts`, `networkUtils.ts`, `httpsTlsOptions.ts`, `fileToServerMap.ts`, `analysisServerCapabilities.ts`. `core/server/registry/activeServerRegistry.ts` already ships a vscode-free `Event`/`Disposable` lookalike (`RegistryChangeEvent`, `RegistrySubscription`) — the pattern to copy.
- **Python helpers**: `core/python-env/pythonEnvUtils.ts`, `pythonPackageManifest.ts`.
- Logging sink: `platform/logging/sink.ts`, `logPolicy.ts`; `platform/templatePaths.ts`; `shared/nonceGenerator.ts`.

### 3.3 Core candidates that need a few host calls

Host groups used below: **P** = paths (install root, global/workspace storage dirs, mode), **N** = notify (info/warn/error, with action buttons and modal detail), **G** = progress + cancellation, **I** = input prompt, **E** = env (clipboard, openExternal), **K** = key-value store (globalState), **U** = UI signals (refresh views, set context keys, reveal sidebar, status message/indicator), **W** = workspace folders, **V** = events/disposables value types only.

| Module | Files importing vscode | Runtime vscode calls | Host groups |
|---|---|---|---|
| **Analysis pipeline** — `core/analysis/analysisOrchestrator.ts`, `launchers/*` (4), `parsers/*` (4), `processors/*` (2), `session/*` (2), `session-servers/serverLaunchOrchestrator.ts`, `utils/saveFiles.ts`, `utils/themeUtils.ts` | 16 | orchestrator (3 warn + 1 error + `workbench.view…` reveal), `launchPipeline.ts:223`, `launcherXRAnalysis.ts` (3), `fileXRParser.ts` (3); session registry `EventEmitter` | P, N, U, V |
| **Python execution** — `core/analysis/python/executePython.ts` (588 L), `backendScriptPath.ts`, `xrFieldSchemaService.ts` | 3 | `withProgress` (1), `ExtensionMode` check, `globalState` cache | P (+ mode), G, K |
| **Python environment** — `core/python-env/venvManager.ts` (850 L), `pythonEnvStorage.ts`, `pythonEnvUiState.ts` | 3 | venvManager: 3 `withProgress`, 4 info, 3 warn (one is a confirm-with-buttons, one modal detail), 2 error; uiState: `EventEmitter`, 2× `setContext` | P, N, G, U, V |
| **Re-analysis watchers** — `core/analysis/watchers/*` (6 of 11) | 6 | `debounceManager.ts` status-bar item; `setStatusBarMessage` ×2; 1 error toast; `directoryWatcherOrchestrator.ts` imports `platform/ui/errorHandler` (log-only severity) | N, U |
| **Template generation** — `core/charts/processing/*` (3), `core/charts/settings/*` (3) | 6 | none except `globalState` legacy read; everything else is `context.extensionPath` / `globalStorageUri` and `vscode.Uri` as a parameter type (`settingsFile.ts`) | P, K |
| **Analysis configuration storage** — `core/analysis/configuration/analysisConfigurationStorage.ts` | 1 | `vscode.workspace.fs` ×5, `Uri.joinPath` ×2 — replaceable by `fs/promises` + `path.join` (file scheme only) | P |
| **Local HTTP/HTTPS + SSE servers** — `core/server/` root (9) + `core/server/analysis/analysisFeatureHost.ts` | 10 | `httpsDefaultServer.ts` (4 info + 2 clipboard), `httpsCustomServer.ts` (1 warn + `codexr.server.configure`), `serverControl.ts` (3 toasts + `getPanelManager()` + `handleError`), `serverSettingsManager.ts` (2× `codexr.servers.refresh`, uses `getExtensionContext()`); `multiServerLauncher.ts` imports `features/active-servers/views/launchNotifications` (the only `core → features` edge, a documented layer exception that already cites "#13 host ports"); the rest type-only | P, N, E, U, V |
| **Git / history services** — `core/history/historicalComparisonService.ts`, `projectEvolutionService.ts`, `gitAnalysisSessionContext.ts`; `core/dependencies/dependencyGraphService.ts`; `core/export/gitRevisionExporter.ts` | 5 | none in history (type-only, storage dirs); dependencies: 1× `workspace.workspaceFolders`; export: `Progress` + `CancellationToken` types | P, W, G |
| **Collaboration profile** — `core/collaboration/collaborationProfileManager.ts` | 1 | `EventEmitter`, `Disposable`, `subscriptions.push` | P, V |
| **Remote access** — `core/remote-access/remoteAccessManager.ts` (566 L), `cloudflaredBinaryManager.ts` | 2 | 22 UI calls: 8 info, 2 warn, 1 error, 2 input boxes, 3 clipboard, 1 openExternal, 1 refresh command; cloudflared: **download-consent** prompt + `globalState` flag + `withProgress` | P, N, I, E, K, G, U, V |

Rule of thumb from the data: the **storage/history/export/template** side needs only **P** (and K for two caches); the **Python** side needs P + G + N; the **servers** and **remote access** carry most of the remaining UI calls, almost all of them post-action toasts with buttons, which belong behind a notifier rather than inline.

---

## 4. Proposed `CodeXRHost` and migration order

### 4.1 Interface sketch (`core/host/codeXRHost.ts`, vscode-free)

```ts
/** Structurally identical to vscode.Disposable, so VS Code subscriptions fit as-is. */
export interface HostDisposable { dispose(): void }

/** Same call shape as vscode.Event<T> (and as RegistryChangeEvent in activeServerRegistry.ts). */
export type HostEvent<T> = (
    listener: (e: T) => unknown, thisArgs?: unknown, disposables?: HostDisposable[],
) => HostDisposable;

export type HostMode = 'production' | 'development' | 'test';

/** Replaces ExtensionContext as a path bag (extensionPath / globalStorageUri / storageUri / extensionMode). */
export interface HostPaths {
    /** Root holding templates/, dist/code_analysis/python, resources/ (today: context.extensionPath). */
    readonly installRoot: string;
    /** Per-user private storage (today: context.globalStorageUri.fsPath). */
    readonly globalStorageDir: string;
    /** Per-workspace private storage, undefined with no folder open (today: context.storageUri?.fsPath). */
    readonly workspaceStorageDir: string | undefined;
    readonly mode: HostMode;
}

/** Memento subset actually used (globalState.get/update). */
export interface HostKeyValueStore {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Promise<void>;
}

export interface HostProgress { report(value: { message?: string; increment?: number }): void }
export interface HostCancellation {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested: HostEvent<void>;
}

export type Severity = 'info' | 'warning' | 'error';

export interface HostNotifier {
    /** Non-blocking toast; resolves with the clicked action, or undefined. */
    notify(severity: Severity, message: string, ...actions: string[]): Promise<string | undefined>;
    /** Blocking yes/no-style question, e.g. download consent. MUST be answered by a person. */
    confirm(message: string, options: { modal?: boolean; detail?: string; actions: string[] }): Promise<string | undefined>;
    /** Transient status-line text (setStatusBarMessage). */
    status(message: string, timeoutMs?: number): void;
    /** Long-lived status indicator (debounceManager's status-bar item). */
    createStatusIndicator(): { text: string; tooltip?: string; show(): void; hide(): void; dispose(): void };
}

export interface CodeXRHost {
    readonly paths: HostPaths;
    readonly globalState: HostKeyValueStore;
    readonly notifier: HostNotifier;
    withProgress<T>(
        options: { title: string; cancellable?: boolean },
        task: (progress: HostProgress, token: HostCancellation) => Promise<T>,
    ): Promise<T>;
    prompt(options: { prompt: string; placeHolder?: string; password?: boolean; value?: string }): Promise<string | undefined>;
    clipboardWrite(text: string): Promise<void>;
    openExternal(url: string): Promise<boolean>;
    /** Absolute paths of the open workspace folders (vscode.workspace.workspaceFolders). */
    workspaceFolders(): readonly string[];
    /** Semantic UI signals instead of VS Code command IDs. */
    signal(event:
        | { kind: 'refresh'; view: 'servers' | 'activeServers' | 'analysis' }
        | { kind: 'state'; key: 'pythonEnv.uiLocked' | 'pythonEnv.retryAvailable'; value: boolean }
        | { kind: 'revealSidebar' }
        | { kind: 'openServerSettings' }
    ): void;
}
```

Deliberately **left out**: configuration (only the logger reads one setting; keep it in the extension), output channels (the sink already abstracts logging), file system and watchers (core uses Node `fs` already; replace the one `workspace.fs` user with `fs/promises`), tree views, webviews, quick picks, open dialogs, text editors (all UI-only). Post-launch server toasts (`launchNotifications`) and panel removal on server stop are better as **callbacks the feature layer registers** (`onServerLaunched`, `onServerStopped`) than as host methods — they carry server objects, not strings.

Adapters: `app/host/vscodeHost.ts` (`VSCodeHost`, built in `activate()` from `ExtensionContext`, mapping `paths.mode` from `ExtensionMode`, `signal` to the existing command IDs and `setContext` keys); later `apps/ide/…/electronHost.ts` (`ElectronHost`, `paths.installRoot` = app resources, storage under `app.getPath('userData')`, notifier over IPC to the renderer).

### 4.2 Migration order (each step keeps `npm test` green)

`npm test` = typecheck + lint + compile-tests + unit tests, including `test/tooling/dependencyDirection.test.cjs`, which pins folder edges in `folderDependencies.json` and the `vscodeFreeFloor`. Every step: add the new folder/edges to that JSON, re-run `node test/tooling/folderDependencies.cjs`, **raise the floor** to the new measured count.

1. **Introduce the seam, no consumers.** Add `core/host/codeXRHost.ts` (types only, vscode-free), `app/host/vscodeHost.ts` (adapter) and a holder `initializeHost()/getHost()` mirroring `platform/extensionContext.ts`; call it in `extension.ts` next to `initializeExtensionContext`. Unit-test the adapter with `test/helpers/fakeVscode.cjs` (it already fakes `ExtensionMode`, `globalStorageUri`, messages). Add `core/host` to `folderDependencies.json` (`mayImport: []`, every core folder may import it).
2. **Leaf path/type swaps (P only).** Replace `vscode.ExtensionContext`/`vscode.Uri` with `HostPaths`/`string` in modules that only read paths and have few callers: `core/analysis/python/backendScriptPath.ts` (already takes a `Pick<ExtensionContext,'extensionPath'|'extensionMode'>` — change it to `Pick<HostPaths,'installRoot'|'mode'>`), `core/charts/settings/settingsFile.ts` (Uri → `globalStorageDir: string`), `core/server/generatedHttpsCertificateManager.ts`, `core/python-env/pythonEnvStorage.ts`, `core/analysis/utils/themeUtils.ts` (also switch `logger` → `sink`), plus a `privateStorageRoot(paths)` helper replacing the 5 copies of `storageUri?.fsPath || globalStorageUri.fsPath`. Also switch `venvManager.ts` and `serverSettingsManager.ts` from `platform/logging/logger` to `sink`.
3. **Value types.** Replace `vscode.EventEmitter`/`Disposable` with Node `events` + `HostEvent`/`HostDisposable` in `core/analysis/session/sessionRegistry.ts`, `core/collaboration/collaborationProfileManager.ts`, `core/python-env/pythonEnvUiState.ts` (emitter only), and the `Disposable` type positions in `httpServer.ts`, `remoteAccessManager.ts`. Subscribers in `features/analysis/views/AnalysisSectionProvider.ts` and `activeAnalysesDataService.ts` keep compiling because the shape is identical (precedent: `activeServerRegistry.ts`).
4. **Progress and cancellation (G).** `core/export/gitRevisionExporter.ts` (types only), then `core/analysis/python/executePython.ts` (`withProgress` + 9 `Progress` types), then `venvManager.ts` and `cloudflaredBinaryManager.ts` progress.
5. **Key-value store (K).** `xrFieldSchemaService.ts`, `settingsStorage.ts`, `settingsAccessors.ts`, cloudflared consent flag → `host.globalState`. Same keys, so stored state survives.
6. **Notifications (N, I, E).** One module at a time, smallest first: `launchPipeline.ts` → `launcherXRAnalysis.ts` → `fileXRParser.ts` → `analysisOrchestrator.ts` → watchers (`fileWatcherOrchestrator.ts`, `directoryReAnalyzer.ts`, `debounceManager.ts` status indicator) → `serverControl.ts` → `httpsDefaultServer.ts`/`httpsCustomServer.ts` → `venvManager.ts` → `remoteAccessManager.ts` (largest, 22 calls). Tests asserting `fake.messages` keep passing because `VSCodeHost` forwards to the same `vscode.window` calls.
7. **UI signals and callbacks (U).** Replace the 7 `commands.executeCommand` sites with `host.signal(...)`; replace `multiServerLauncher → features/active-servers/views/launchNotifications` with a launch-notification callback (removes the `core/server->features/active-servers` layer exception) and `serverControl → platform/webview/panelManager`/`platform/ui/errorHandler` with an `onServerStopped` callback + logger. `core/dependencies/dependencyGraphService.ts` → `host.workspaceFolders()`.
8. **`workspace.fs` → `fs/promises`** in `analysisConfigurationStorage.ts`.
9. **Retire `ExtensionContext` in core.** Change `SessionCreationParams.context`, the `getInstance(context)` singletons (`UnifiedSessionRegistry`, `XRFieldSchemaService`, `AnalysisConfigurationStorage`, `ServerSettingsManager`), `HttpServerConfig.extensionContext`/`httpsServerBase` config, `ServerControl.extensionContext` and the remaining type-only files to `CodeXRHost`. Add a guard test: no file under `core/` reaches `vscode` (floor = all of `core/`).
10. **Package split** (separate issue, matches `packages/README.md`): move `core/` to `packages/core`, retarget source-text tests in the same commit.

---

## 5. Risks and surprises

1. **`ExtensionContext` travels as data, not just as a parameter.** `SessionCreationParams.context` (`core/analysis/session/analysisSession.ts:85`), `HttpServerConfig.extensionContext` (`core/server/httpServer.ts:43`, `httpsServerBase.ts:20`, filled in `serverFactory.ts:156/172/193`), the static `ServerControl.extensionContext` (`serverControl.ts:28`), `GitAnalysisSessionContext`'s constructor (`core/history/gitAnalysisSessionContext.ts:89`). The `Launch` type in `core/analysis/launch/launchKinds.ts:17` takes a context. 229 type sites in 143 files: step 9 is the big one.
2. **Context-keyed singletons with "first call wins".** `getInstance(context?)` in `sessionRegistry.ts:43`, `xrFieldSchemaService.ts:38`, `analysisConfigurationStorage.ts:52`, `serverSettingsManager.ts:86` (which falls back to `getExtensionContext()`), plus three in `features/`. Tests construct them with fake contexts; swapping the parameter type must keep the optional-argument semantics.
3. **`vscode.Uri` as data.** `core/charts/settings/settingsFile.ts` takes `globalStorageUri: vscode.Uri`; `analysisConfigurationStorage.ts` builds paths with `Uri.joinPath` and reads with `workspace.fs` (behaviour identical to Node `fs` only for the `file:` scheme — remote/virtual workspaces are not supported by the rest of the core anyway, which uses `.fsPath` everywhere).
4. **`vscode.EventEmitter` in core logic** (3 files). Consumers in `features/` call `.event`-shaped subscriptions with `thisArgs`/`disposables` arguments — keep the `vscode.Event` call shape (the `RegistryChangeEvent` precedent) or the feature layer breaks.
5. **`ExtensionMode` decides where the Python backend is.** `core/analysis/python/backendScriptPath.ts:26-28`: in Development it resolves `<extensionPath>/../../backend/src`, else `<extensionPath>/dist/code_analysis/python`; `executePython.ts:395-400` and `gitRevisionExporter.ts:79` rely on the same rule. The IDE needs its own answer (packaged resources vs monorepo), so `HostPaths.mode` plus a host-supplied backend root may be cleaner than reproducing the relative climb.
6. **Hard-coded `/tmp` fallback.** `core/analysis/parsers/directoryXRParser.ts:109`: `path.join(context.storageUri?.fsPath || '/tmp', 'temp_xr_generation')` — non-portable on Windows and a different fallback from the five `|| globalStorageUri.fsPath` copies. Decide one rule when introducing `workspaceStorageDir`.
7. **VS Code command IDs fired from the core.** `setContext`, `workbench.view.extension.codeXRView`, `codexr.servers.refresh`, `codeXR.activeServers.refreshServers`, `codexr.server.configure` (note the inconsistent `codexr`/`codeXR` casing). These are implicit contracts with `package.json` contributions; a host signal keeps them in one adapter.
8. **Consent prompts are a project principle, not UX.** `cloudflaredBinaryManager.ts:72-81` asks before downloading a binary and stores the answer in `globalState`; `venvManager.ts:256` confirms environment deletion. CLAUDE.md: "no network calls or downloads without explicit user consent". `HostNotifier.confirm` must never be auto-answered by an `ElectronHost` or a test double that resolves to "yes" by default.
9. **Direct imports undercount the coupling.** 15 files import nothing from `vscode` but reach it: e.g. `core/charts/getVisualizationConfiguration.ts` via a runtime `require('./settings/settingsAccessors')` inside a function (line 31, invisible to an `import` grep), `core/server/launchServerWithFile.ts` via `multiServerLauncher.ts`, all five `core/server/analysis/*Bridge*`/router files via `analysisFeatureHost.ts`, `core/history/projectEvolutionArtifacts.ts` via `gitAnalysisSessionContext.ts`. Measure with `measure().vscodeFree`, not grep.
10. **Layer exceptions/pairs already point at #13.** `folderDependencies.json` documents `core/server -> features/active-servers` ("the fix is a notification callback … (#13 host ports)") and the `core/analysis <-> core/server` pair ("an event or callback seam for the session (#13)"). Steps 7 and 9 should close and delete those entries; the dependency test will then fail loudly if they come back.
11. **Tests are pinned to paths.** 20 test files reference `src/core/...` source paths as text (most: `core/server/analysis/dependencyGraphBridge.ts` ×6, `httpServer.ts`, `analysisMessageRouter.ts`, `analysisFeatureHost.ts`, `historicalComparisonService.ts`, `directoryXRParser.ts` ×5 each); 59 load compiled `out/core/...` modules; 44 suites use `withFakeVscode`. Some source-text assertions pin literal `show…Message(` calls (e.g. `test/servers/remoteAccessImplementation.test.cjs:184`; 6 test files match `showInformationMessage|showWarningMessage|vscode.window`) — a notifier swap must retarget them in the same commit (`test/helpers/sourceText.cjs` `assertAbsent` requires a canary, so a vacuous pass is unlikely but the edit is needed). Moving files (step 10) touches all of them.
12. **Unit runner is single-process** (`--test-isolation=none`); `fakeVscode.cjs` evicts `out/` modules after each scope. A module-level host holder (`getHost()`) is new global state: it needs the same reset discipline or it leaks between suites.
13. **`vscodeFreeFloor` is stale low** (106 in JSON, 114 measured): raise it in step 1 so progress is ratcheted from the first commit.
14. **ADR 0001 count is stale** (179 files; now 171) and its folder names (`src/code_analysis/`, `views/`, `servers/`) predate the #55 layout.
15. **Webview/panel and tree code never moves.** `platform/webview/panelManager.ts` is reached from `core/server/serverControl.ts`; the IDE's equivalent (Monaco side panel) will be a different implementation behind a callback, not a host method.
16. **Electron compatibility of what is already free** looks good: servers use Node `http`/`https`/`ws`, Git and Python use `child_process.spawn/execFile` (`gitRepositoryService.ts`, `gitBatchObjectReader.ts`, `gitExportPythonWorkerPool.ts`, `venvManager.ts:479`, `remoteAccessManager.ts:122`). These must run in Electron's main (Node) process, not the renderer.

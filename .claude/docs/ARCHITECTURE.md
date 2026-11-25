# Code-XR Architecture

> **Purpose**: High-level system architecture for AI agents and developers. Read this before touching anything under `src/`.
> **Stability**: Stable — update only when the architecture itself changes (new module, changed data flow), not for feature-level changes.
> Facts here were verified against the code on 2026-07-08. Items marked *[inferred]* are conclusions from structure/naming, not verified line-by-line.

## The one-paragraph summary

CodeXR is a VS Code extension (~337 TS files) that analyzes source code with a **Python backend** (Lizard metrics, run in a managed virtual environment) and renders the results as **BabiaXR/A-Frame XR scenes** served by **local HTTP/HTTPS servers** with **SSE live-reload**. The extension side is TypeScript; the in-scene runtime is plain JavaScript living in `templates/components/` and injected into generated HTML.

## Main data flow (the pipeline)

```
User command (context menu / tree / palette)
  └─> src/code_analysis/commands/...            (per-mode command handlers)
      └─> engine/launchers/launcherXRAnalysis.ts | launcherLivePanel.ts | launcherVisualizeDOM.ts
          └─> engine/launchers/launchPipeline.ts  → creates a UnifiedAnalysisSession
              ├─> engine/utils/executePython.ts   → spawns managed venv, runs python/main.py → JSON metrics
              ├─> src/core/charts/                → validates dimension mapping, fills HTML template
              │     (chart registry + placeholder processing over templates/xr/...)
              ├─> engine/components/customComponents/*ComponentAsset.ts
              │     → inlines browser runtimes from templates/components/**/*.js into the HTML
              └─> engine/servers/serverLaunchOrchestrator.ts (+ sessionServerManager)
                    └─> src/core/server (HTTP/HTTPS) serves the scene
                        └─> registered in src/core/server/registry → shown in sidebar tree (src/features/active-servers)
Live updates: engine/watchers/* detect file changes → re-run Python →
  engine/servers/sseNotificationManager.ts → src/core/server/sse/SSEManager.ts → browser reloads data
```

Three analysis modes share this pipeline: **XR** (A-Frame scene in browser/headset), **LivePanel** (2D webview panel), **DOM visualization** (HTML DOM structure in XR). Each mode has its own launcher and parser (`engine/parsers/`); one shared requirement processor (`engine/processors/FileRequirementProcessor.ts` → `analysisBootstrap.ts`) loads the templates the mode needs.

## Activation flow (`src/extension.ts`)

1. `initializeExtensionContext` + `CodeXRLogger.initialize` (`src/platform/`). The logger attaches the "CodeXR" output channel to the vscode-free log sink; everything logged before this (including at module load) was buffered by the sink and is flushed into the channel now.
2. Singletons initialized: `AnalysisConfigurationStorage`, `CollaborationProfileManager`, `RemoteAccessManager`, `ServerSettingsManager`, `getActiveServerRegistry()`, `ServerControl`.
3. `ModularTreeDataProvider` (`src/views/ModularTreeDataProvider.ts`) registered as the single tree view `codexrTree` (one activity-bar container hosts all sections: servers, active servers, examples, visualize data, analyses, python env, visualization settings, learn more). **Collaboration is not a root section**: `CollaborationSectionProvider` is mounted by `ActiveServersSectionProvider` as the nested `COLLABORATION` group (item type `collaboration-group`), so its items — including `Join Remote Session` — render inside `ACTIVE SERVERS`.
4. `registerAllCommands` (`src/commands/index.ts`) merges command arrays from every feature module and registers them via `CommandBuilder.registerAll`. **`assertUniqueCommandIds` throws on duplicate command IDs** — keep this in mind when adding commands.
5. `StartupCoordinator` (`src/core/startup/startupCoordinator.ts`, max 3 concurrent) defers heavy work: restore server settings + ensure HTTPS cert pair, init `ServerWatcherIntegration`, init Python env + prefetch XR field schema, clean stale analysis artifacts.

`deactivate()` tears down remote access, the active-server registry, the SSE manager + `fileToServerMap`, and the tree provider.

`activationEvents` in package.json is empty — activation is driven by contributed commands/views.

## Module map (`src/`)

| Module | Responsibility | Key files |
|---|---|---|
| `code_analysis/` | **The core (246 files).** Analysis engine, sessions, watchers, Python backend, dependency + historical analysis | `engine/launchers/launcherXRAnalysis.ts`, `engine/core/analysisSession.ts`, `engine/orchestrator` → `analysisOrchestrator.ts` |
| `code_analysis/engine/` | Pipeline: launchers, parsers, the requirement processor, session servers, watchers, component-asset injection | `launchPipeline.ts`, `servers/sessionServerManager.ts`, `watchers/sessionWatcherManager.ts`, `utils/executePython.ts` |
| `code_analysis/python/` | Python analysis backend (see `PYTHON_ANALYSIS.md`) | `main.py`, `tools/lizard_analyzer.py`, `utils/xr_field_schema.py` |
| `core/dependencies/` | Dependency-graph analysis service (see `docs/features/DEPENDENCY_GRAPH_XR.md`) | `DependencyGraphService` *[inferred name from docs]* |
| `core/export/` | Analysis export: the manifest, the package transaction and the Git-revision exporter with its Python worker pool | `exportManifest.ts`, `exportPackageTransaction.ts`, `gitRevisionExporter.ts`, `gitRevisionExportCore.ts`, `gitTimelineBlobAnalyzer.ts` |
| `core/history/` | Git history: comparator + Project Evolution. Both services compose a `GitAnalysisSessionContext` (catalogue, per-commit payload cache, analyze/exclude) and a `SingleJobGate` (one job at a time, last successful request); `gitAnalysisShared.ts` holds the pure helpers the export core shares | `gitRepositoryService.ts`, `historicalComparisonService.ts`, `projectEvolutionService.ts`, `gitAnalysisSessionContext.ts`, `gitAnalysisShared.ts` |
| `code_analysis/services/` | Cross-cutting services | `xrFieldSchemaService.ts`, `workspaceSnapshotService.ts`, `serverWatcherIntegration.ts` |
| `core/charts/` | Chart template system: registry, models, dimension validation, HTML placeholder processing, the visualization configuration read by every launch | `chartRegistry.ts`, `chartModels.ts`, `xrFieldModels.ts`, `templateCharts.ts`, `chartPresentation.ts`, `getVisualizationConfiguration.ts` (lazy `require` of `settings/settingsAccessors.ts`), `processing/dimensionValidator.ts`, `processing/templateHTMLProcessor.ts`, `processing/templateProcessor.ts`, `processing/placeholders/` |
| `features/examples/` | Bundled BabiaXR demo examples (tree section + launcher) | `services/exampleLauncher.ts`, `commands/babiaExamplesCommands.ts`, `commands/babiaExamplesCommandRegistrations.ts`, `model/babiaExampleModel.ts`, `views/BabiaExamplesSectionProvider.ts`, `views/babiaExamplesTreeView.ts`, `views/{exampleItems,babiaExampleItems}.ts`, `views/{handleExampleClicks,handleBabiaExampleClicks}.ts` (two factories and two click handlers: a duplication recorded for 1.3.0, src-layout.md §2.1) |
| `core/server/` | Server **infrastructure**: HTTP/HTTPS, ports, self-signed certs, SSE, collaboration/broadcast signaling, server settings, the running-server registry and its control | `httpServer.ts` (façade + composition root), `httpsServerBase.ts` (state, port search, TLS wiring and delegation shared by `httpsCustomServer.ts`/`httpsDefaultServer.ts`; TLS literal in `httpsTlsOptions.ts`), `sse/SSEManager.ts`, `collaboration/collaborationRoomServer.ts`, `multiServerLauncher.ts` (launch orchestration; `serverFactory.ts` picks, builds and starts the server class; the toasts after a launch are in `features/active-servers/views/launchNotifications.ts`, the one allow-listed upward edge), `launchServerWithFile.ts` (was `servers/runtime/index.ts`), `serverControl.ts`, `serverSettingsManager.ts`, `networkUtils.ts`, `fileToServerMap.ts` |
| `core/server/registry/` | The running-server registry (stays in core: the analysis engine, the server and two features use it) | `activeServerRegistry.ts`, `activeServerModel.ts`, `serverRegistrar.ts` |
| `core/server/http/` | Response helpers (`httpRespond.ts`: free functions `sendJsonResponse`/`sendErrorResponse`/CORS/body reading) + `StaticAssetServer` (pages, MIME, traversal guard, no-store) | `httpRespond.ts`, `staticAssets.ts` |
| `core/server/remote/` | Remote pairing + authorization: `RemoteAccessPolicy` (request/WS auth, cookie-free allowlist) and `RemotePairingApi` (identity → pair → confirm → browser token exchange, guest page) | `remoteAccessPolicy.ts`, `remotePairingApi.ts`, `pairingPage.ts` |
| `core/server/ws/` | The WebSocket scaffold the room and the broadcast server share: one path on the shared server's `upgrade` event, authorize-or-destroy, detach; plus the wire constant `DEFAULT_ROOM_ID` | `webSocketEndpoint.ts` |
| `core/server/collaboration/` | WebSocket room + session descriptor API (`CollaborationSessionApi`: descriptor, avatar model, room id). The room server (`collaborationRoomServer.ts`: connection lifecycle, message routing, membership and roles) is the façade over `roomRegistry.ts` (peer and room maps, broadcast), `roomSharedState.ts` (entities, locks, presence, presenter), `participantIdentity.ts` (names and avatar colours), `roomMessageCodec.ts` (parse/send/normalize) and `roomTypes.ts` | `collaborationRoomServer.ts`, `collaborationSessionApi.ts` |
| `core/server/broadcast/` | Screen-broadcast signalling (sender/viewer roles, peer-to-peer negotiation, the media relay for viewers P2P cannot reach). The server (`screenBroadcastSignalingServer.ts`) is the façade over `relayPolicy.ts` (who is relayed, the audience told to the sender, per-viewer thinning thresholds), `mediaFrame.ts` (the relay wire format shared with the runtime: header constants, validation, header read) and `broadcastTypes.ts` | `screenBroadcastSignalingServer.ts` |
| `core/server/analysis/` | Analysis features behind the server: `AnalysisFeatureHost` (capability-gated service construction, refresh wiring, LivePanel SSE notifiers, dispose) + one bridge per feature + the room-message router. Bridges depend on the host; nothing here imports the façade | `analysisFeatureHost.ts`, `analysisMessageRouter.ts`, `dependencyGraphBridge.ts`, `historicalComparisonBridge.ts`, `projectEvolutionBridge.ts`, `analysisBridgeReplies.ts` (the git bridges' shared reference and error replies) |
| `features/active-servers/` | The ACTIVE SERVERS section: the **running** servers' tree and actions (stop/open/copy-URL), the preview renderer and the launch toasts; the registry and `serverControl.ts` are in `core/server/` | `views/ActiveServersSectionProvider.ts`, `views/activeServerItems.ts`, `views/handleServerActions.ts` (the tree's server actions; the dialog text is in `serverDetailsFormat.ts`), `views/launchNotifications.ts`, `services/serverOpenActions.ts` (open a registered server in the browser or the panel; used by the tree actions and the launch notifications), `services/withServer.ts` (the unknown-id guard every server action shares), `services/previewRenderer.ts`, `commands/activeServersCommands.ts`, `commands/activeServersCommandRegistrations.ts` |
| `features/servers/` | The SERVERS section: server configuration commands and tree | `commands/serverCommands.ts`, `commands/serverCommandRegistrations.ts`, `views/ServersSectionProvider.ts`, `views/serverItems.ts`, `views/configurationItems.ts`, `views/handleConfigurationClicks.ts` |
| `views/` | The unified sidebar tree: one provider delegating to per-section providers | `ModularTreeDataProvider.ts` (section-item bridge table), `sectionDefinitions.ts` (the eight root sections), `*/items/`, `*/interactions/` |
| `commands/` | Central command registration aggregator | `index.ts` (`registerAllCommands`, `assertUniqueCommandIds`) |
| `core/collaboration/` | Identity/profiles for collaborative sessions (names, avatars), used by the server and two features | `collaborationProfileManager.ts`, `collaborationProfile.ts`, `anonymousName.ts`, `connectedParticipant.ts` |
| `features/collaboration/` | The collaboration commands and the COLLABORATION tree group (nested inside ACTIVE SERVERS) | `commands/collaborationCommands.ts`, `views/CollaborationSectionProvider.ts`, `views/collaborationItems.ts` |
| `core/remote-access/` | Cross-network sharing via pinned `cloudflared` Quick Tunnel (no sidebar section of its own) | `cloudflaredBinaryManager.ts`, `remoteAccessManager.ts`, `remoteSessionAuthority.ts`, `remoteAccessModel.ts` |
| `core/python-env/` | Managed Python virtual environment (create/verify/reinstall + UI state); used by the analysis engine and the git export | `venvManager.ts`, `pythonPackageManifest.ts`, `pythonEnvStorage.ts`, `pythonEnvUtils.ts`, `pythonEnvUiState.ts` |
| `features/python-env/` | The Python-environment commands and sidebar section | `commands/pythonEnvCommands.ts`, `commands/pythonEnvCommandRegistrations.ts`, `views/PythonEnvSectionProvider.ts`, `views/pythonEnvItems.ts` |
| `features/visualize-data/` | User-driven "visualize your own JSON" flow | `commands/visualizeDataCommands.ts`, `commands/visualizeDataCommandRegistrations.ts`, `model/visualizeDataModel.ts`, `model/visualizeDataState.ts`, `services/visualizationLauncher.ts`, `services/visualizationRestorer.ts`, `services/jsonFieldAnalyzer.ts`, `views/VisualizeDataSectionProvider.ts`, `views/visualizeDataItems.ts` (item factory), `views/visualizeDataSectionItems.ts` (section adapter) |
| `core/charts/settings/` | The visualization-settings store (palette, environment, colours) that the chart pipeline reads | `settingsModel.ts`, `settingsStorage.ts`, `settingsFile.ts`, `settingsAccessors.ts` |
| `features/visualization-settings/` | The visualization-settings commands, sidebar section and colour picker | `commands/visualizationSettingsCommands.ts`, `commands/visualizationSettingsCommandRegistrations.ts`, `views/VisualizationSettingsSectionProvider.ts`, `views/visualizationSettingsItems.ts` (item factory), `views/visualizationSettingsSectionItems.ts` (section adapter), `views/handleSettingsInteraction.ts`, `views/colorPickerUtils.ts`, `views/dynamicColorIconGenerator.ts` |
| `core/` | Startup coordination (moves to `app/` in #55 B14) | `startup/startupCoordinator.ts` |
| `platform/` | Extension-host plumbing with no feature knowledge (the layer `docs/cleanup/src-layout.md` proposes; filled as files move) | `extensionContext.ts`, `logging/sink.ts` (vscode-free: `getLogger(scope)`, pre-activation buffer, console fallback), `logging/logger.ts` (attaches the output channel, tracks `codeXR.debug.verboseLogs`), `logging/logPolicy.ts`, `templatePaths.ts` (`resolveTemplatePath`), `commands/commandRegistry.ts` (`ExtensionCommandRegistration`, `assertUniqueCommandIds`: the pure command model every feature imports), `commands/commandBuilder.ts`, `tree/baseInterfaces.ts` (the section-provider contract every sidebar section implements), `ui/errorHandler.ts`, `ui/detailDialog.ts`, `webview/panelManager.ts` (the `serverId → WebviewPanel` registry) |
| `shared/` | Helpers with no VS Code and no domain | `nonceGenerator.ts` |
| `features/learn-more/` | "Learn more" help section in the tree | `commands/learnMoreCommands.ts`, `commands/learnMoreCommandRegistrations.ts`, `views/LearnMoreSectionProvider.ts`, `views/learnMoreItems.ts`, `views/handleLearnMoreClicks.ts` |
| `utils/` | Helpers still waiting for their #55 batch | `languageMetadata.ts`, `fileToServerMap.ts`, `sha256Generator.ts` |

**Per-feature layout convention** (followed by most modules): `commands/` + `model(s)/` + `runtime/` or `services/` + `views/{items,interactions}` + `registry|storage|state/`. When adding a feature, mirror this pattern.

**Folder dependencies** (stories #42, #55): which folder may import which is data in `test/tooling/folderDependencies.json`, checked by `test/tooling/dependencyDirection.test.cjs` (type imports count). A folder is the first directory under `src/`, or the first two under `core/` and `features/` (`twoLevelAreas`); the same file holds the layer order `app → features → core → platform → shared` (`layers`), which the test enforces (no upward edge, no feature importing another feature) except for the reasoned entries in `layerExceptions`. A new cross-folder direction fails the gate until it is added there; a new two-way pair also needs a written reason. The remaining pairs are each documented in that file (all inside the server/analysis subsystems: `core/server`, `core/remote-access`, `code_analysis` with `core/history` and `core/export`, plus `core/server`/`features/active-servers`, which is the one allow-listed upward edge). `platform/` imports no feature folder, and `core/` none besides that edge.

**Barrel policy** (decided 2026-09-18, measured): 82% of the relative imports in `src/` (807 of 981) already name a concrete file, and 32 of the 82 `index.ts` barrels have no importer at all. So: **import the concrete file; do not add a barrel "for symmetry"**. An unimported barrel is dead code and keeps otherwise-dead modules looking referenced. Story #55 (batch 0) dissolved every re-export barrel that was left: `src/` has none, and the two `index.ts` files that held code are renamed in the move.

**Export convention**: export what another file or a test consumes. A symbol used only inside its own file does not need `export`; an exported symbol with no consumer anywhere in `src/` **and** `test/` is dead (tests load compiled code from `out/`, so a test-only consumer counts as a consumer).

Note: before #55 a feature was split between a feature folder and `views/<feature>/` (e.g. `active_servers/views/` **and** `views/active_servers/`); the moves put both halves in `features/<feature>/views/`. The `src/views/` tree and `src/commands/index.ts` are the current *aggregation points*; per-module `views/`/`commands/` folders are the feature implementations they pull from. *[inferred from import wiring]*

## Cross-module contracts (the seams that matter)

1. **XR field schema**: Python defines analyzable fields in `code_analysis/python/utils/xr_field_schema.py`; TypeScript consumes it via `code_analysis/services/xrFieldSchemaService.ts` (backed by `main.py --mode schema`). Dimension-mapping validation in `core/charts/processing/dimensionValidator.ts` checks user mappings against this schema. **Changing metrics on the Python side requires keeping this schema in sync.**
2. **Chart registry**: `core/charts/chartRegistry.ts` (`BabiaChartRegistry` singleton) is the source of truth for available chart types and their dimension requirements.
3. **File ↔ server mapping**: `src/core/server/fileToServerMap.ts` links analyzed files to the server instance serving their visualization; SSE clients are keyed by file URI in `SSEManager`.
4. **Component-asset injection**: TS files in `code_analysis/engine/components/customComponents/*ComponentAsset.ts` read runtime JS from `templates/components/` and inline it into generated HTML. A runtime shipped as one file is a row of the `SINGLE_FILE_RUNTIME_ASSETS` descriptor table in `customComponents/singleFileRuntimeAssets.ts` (output name, folder, refusal label), and its `*ComponentAsset.ts` is a thin wrapper keeping the named exports; multi-part runtimes go through `runtimeAssembly.ts`. The browser runtimes never import TS code; the contract is the injected globals and entity schemas (see `templates/components/COMPONENTS.md`).
5. **Command registration**: every module exports a command-registration array consumed by `src/commands/index.ts`. Command IDs use prefixes `codeXR.*` / `codexr.*` (both exist — check before adding).

## Logging (since 1.2.1)

Every diagnostic of the extension host goes through `src/platform/logging`. A module logs with `const logger = getLogger('SCOPE')` from `platform/logging/sink.ts`, which has no `vscode` import, so any module (and any unit test that loads it from `out/` without the fake vscode) can log. Lines land in the **CodeXR** output channel as `[ISO time] [LEVEL] [SCOPE] message`, with an optional metadata line (an Error's stack, a string, or JSON).

- **Levels.** `warn` and `error` are always written. `debug` and `info` are written only in development mode or with `codeXR.debug.verboseLogs` on (`logPolicy.ts`). Anything carrying a file system path is `debug`, passed lazily (`logger.debug(() => ...)`), so it costs nothing while verbose logging is off. A caught failure is reported at `warn` or `error`, never only at `debug`.
- **Before activation** the sink keeps up to 1,000 lines in a buffer and flushes them through the level policy when `CodeXRLogger.initialize` attaches the channel; while no channel is attached (and after it is disposed), `warn`/`error` are also echoed to the console.
- **No `console.*` in `src/`.** ESLint's `no-console` is an error for `src/**/*.ts`; `sink.ts` is the only allowlisted file (its console fallback). Browser runtimes under `templates/` are not extension-host code and keep their own (gated) console output.
- `observeLogEntries` on the sink is a test seam: characterization suites record what a module logs (`test/helpers/logCapture.cjs`). Nothing in the extension observes.

## Repo-root layers (outside `src/`)

| Path | What it is |
|---|---|
| `templates/` | Raw HTML templates + **browser-side JS runtimes**. `xr/` (scene templates + SSE client scripts), `analysis_livePanel/` (webview panels), `components/` (A-Frame component runtimes — see `templates/components/COMPONENTS.md`; `components/livepanel/` holds shared 2D LivePanel components such as `dataTable.{js,css}` that `LivePanelParser` bundles ahead of each panel's own `main.js`/`style.css`), `utils/color-picker.html`. Read in place at `<extensionPath>/templates` and shipped by the `files` allowlist; not copied into `dist/` since 1.2.1. Source code builds every template path with `resolveTemplatePath(extensionPath, …)` (`src/platform/templatePaths.ts`), never from `__dirname` (wrong from the bundle); tests use `test/helpers/templatesRoot.cjs`. |
| `test/` | All tests. `.test.cjs` unit suites (Node native runner), Python suites, language fixtures, manual HTML harnesses. See `DEVELOPMENT.md`. |
| `resources/` | Icons and media (per-language icons, collaboration/comparison/screen assets). |
| `examples/` | Bundled sample charts + data for the Babia Examples tree section. |
| `scripts/` | Build utilities: `package-vsix.mjs`, `prepare-dev-extension.mjs` (the manual-metrics report tool is `backend/scripts/report-manual-metrics.py`). |
| `docs/` | Human-facing feature docs, linked from the README (vsce rewrites those links to GitHub). Not shipped in the VSIX since 1.2.1. |
| `backend/manual_test/` | Per-language fixtures for `npm run test:analysis` (see its README); outside this package since 1.2.1. |
| `pages/` | GitHub Pages redirect page (deployed by the only CI workflow). |

## How future agents should use this document

- Use the module map to jump straight to the right folder instead of scanning `src/` (`code_analysis/` alone is 246 files).
- Use the "cross-module contracts" section to know what else must change when you touch a seam (especially Python metrics ↔ field schema ↔ dimension validation).
- For feature-specific depth (dependency graph, historical comparison, project evolution, remote access), read the existing docs in `docs/` — this file deliberately does not duplicate them. See `INDEX.md` for the task → docs mapping.

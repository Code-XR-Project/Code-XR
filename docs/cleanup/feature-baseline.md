# Code-XR Feature Baseline (pre-cleanup inventory)

> **Purpose.** An exhaustive, verifiable inventory of everything the Code-XR VS Code extension contributes, registers, serves and renders, taken **before** the v1.2.1 behaviour-neutral cleanup. After the cleanup every entry below must still exist and still work, **except** the ones listed in the *Authorized removals register* (section 0.3). Each entry cites its source (`file:line`) and says how to verify it.
>
> **Snapshot.** Repository `the repository root`, branch `claude/project-thread-n2s3q6`, extension `code-xr` version **1.2.1** (`apps/vscode-extension/package.json`), taken 2026-11-25, right after the npm-workspaces monorepo move. Read-only inventory: nothing in the repository was modified, and no build or test was run to produce it (`out/` and `dist/` do not exist in this checkout).
>
> **Paths.** Unless prefixed, a path is relative to `apps/vscode-extension/` (so `src/…`, `test/…`, `templates/…`, `package.json`). Python paths start with `backend/`. Line numbers are as of this snapshot. A cleanup moves lines around, so re-locate an entry by its id or symbol, not by its line number.
>
> **Verification legend.** **[A]** = automated check (a command to run, a test name, or a one-liner). **[M]** = manual F5 step in the Extension Development Host ("Run CodeXR Extension" launch config, `.vscode/launch.json:5`). Section 10 consolidates everything into one numbered checklist.

## 0. Headline counts

| Surface | Count | Source of truth | How to re-count [A] |
|---|---|---|---|
| Commands contributed (`contributes.commands`) | **70** | `package.json:65-463` | `node -p "require('./package.json').contributes.commands.length"` |
| Commands registered at runtime | **123** (70 contributed + 53 internal) | `src/commands/index.ts:22-65` | `test/commands/commandContributions.test.cjs` runs the real `registerAllCommands` |
| Internal (registered but not contributed) | **53**: 32 tree-item, 2 programmatic, 2 legacy-alias, **17 pending-removal** | `test/commands/internalCommandIds.cjs:23-90` | same test, "every registered command is either contributed or listed as internal" |
| Configuration settings (VS Code `contributes.configuration`) | **1** (`codeXR.debug.verboseLogs`) | `package.json:465-474` | `node -p "Object.keys(require('./package.json').contributes.configuration.properties)"` |
| Internal settings stores (not VS Code settings) | 6 stores (server, analysis, visualization, collaboration, visualize-data, python env) | section 0.2 | file names under `globalStorageUri` |
| View containers / views | 1 activity-bar container `codexr` / 1 tree view `codexrTree` | `package.json:475-493` | node one-liner in 1.1 |
| Root sidebar sections | **8** (+ nested COLLABORATION group inside ACTIVE SERVERS) | `src/views/sectionDefinitions.ts:77-194` | [M] F5 |
| Menus | 6 menu ids, **49** entries: `view/title` 2, `explorer/context` 12, `editor/context` 8, `view/item/context` 5, `codeXR.analysis.contextMenu` 11, `commandPalette` 11 | `package.json:494-741` | node one-liner in 1.4 |
| Submenus | 1 (`codeXR.analysis.contextMenu`, label "Code-XR: Analysis") | `package.json:742-747` | node one-liner |
| Keybindings | **0** (none contributed) | `package.json` (no `keybindings` key) | node one-liner |
| Activation events | **0** (empty array; activation is implicit from contributed commands/views) | `package.json` `activationEvents: []` | node one-liner |
| Analysis entry points (commands) | 11 analysis kinds + 11 "run last" twins | `src/commands/analysis/AnalysisCommands.ts:13-25` | 1.2 table |
| In-scene analysis modes | 4: `single` (normal), `dependency-graph`, `historical-compare`, `project-evolution` | `src/servers/runtime/analysis/analysisMessageRouter.ts:88-128` | section 4 |
| Metric languages (Python contract) | **23** languages, **48** extensions | `backend/src/utils/metric_language_contract.py:14-38` | section 5 |
| DOM-only language | 1 (HTML: `.html .htm .xhtml`) | `backend/src/utils/metric_language_contract.py:40-42` | section 5 |
| Dependency-graph languages | **23** (same names as the metric contract) | `backend/src/utils/dependency_analysis_engine.py:24-37` | section 5 |
| Chart types (Babia) | **8**: bars, barsmap, cyls, cylsmap, donut, pie, bubbles, boats | `src/babia_templates/charts/templateCharts.ts:88-430` | section 6.10 |
| Browser XR runtimes (flat output files) | **23** (3 shared + 20 CodeXR), 11 of them multi-part (`manifest.json`) | `templates/components/`, `src/code_analysis/engine/components/customComponents/*ComponentAsset.ts` (21 asset files) | section 7 |
| Shared LivePanel components | **5** (charts, dataTable, dependencySummaryPanel, historicalPanel, panelShell) | `templates/components/livepanel/` | section 7 |
| Python CLI modes | 4 `--mode` (`livePanel`, `xr`, `schema`, `dependencies`) x 3 `--type` (`file`, `directory`, `project`) | `backend/src/main.py:29-37` | section 8 |
| Python scripts spawned directly by TS | 4 (`main.py`, `html/html_dom_parser.py`, `summaryFiles/file_reanalysis_coordinator.py` (`sumaryFiles/` until #36 P20), `export/git_export_analysis_worker.py`) | `src/code_analysis/engine/utils/executePython.ts:28,315,346`, `src/code_analysis/export/gitRevisionExporter.ts:78` | section 8 |
| npm scripts (extension workspace) | **25** | `package.json` `scripts` | `node -p "Object.keys(require('./package.json').scripts).length"` |
| npm scripts (root, mirrored) | **25** | `/package.json` `scripts` | same, at the root |
| VSIX `files` allowlist entries | **13** | `package.json` `files` | section 9 |
| Unit test files (`*.test.cjs`) | **74** (697 static `test(` calls; status doc reports 708/708 executed) | `test/**` | `find test -name "*.test.cjs" \| wc -l` |
| Python test functions | **52** in 9 files | `backend/tests/**` | `npm run test:python` |

### 0.1 How the inventory was produced

- `package.json` surfaces were extracted exhaustively with `node` (`require('./package.json').contributes`), and every row carries its line number.
- The runtime command set is the one `test/commands/commandContributions.test.cjs` pins: it runs the real `registerAllCommands` against a fake `vscode` and demands that `registered − contributed` equals `test/commands/internalCommandIds.cjs` exactly. Registration sites were located by grepping each id for `id:`/`commandId:` literals.
- Everything else was read from source, cross-checked against `.claude/docs/ARCHITECTURE.md`, `XR_COMPONENTS.md`, `PYTHON_ANALYSIS.md`, `templates/components/COMPONENTS.md` and `docs/features/*.md`. Where those docs predate the monorepo move, their paths were translated (`src/code_analysis/python/` → `backend/src/`, `test/python/` → `backend/tests/`).

### 0.2 Persisted state that must survive the cleanup (user data compatibility)

A cleanup must not rename any of these keys or files: users already have them on disk, and a rename silently resets their configuration.

| Key / file | Kind | Owner | Source |
|---|---|---|---|
| `codeXR.analysis.lastKind` | globalState + context key (drives the "Run Last" menus) | `src/commands/analysis/AnalysisCommands.ts:9-10,30-39` | default `analyzeProjectXRDeep` (`:11`) |
| `codeXR.analysis.xrFieldSchemaCache.v1.<type>` | globalState (persisted XR field schema; do not touch per `PYTHON_ANALYSIS.md`) | `src/code_analysis/services/xrFieldSchemaService.ts:31,134-147` | |
| `codeXR.analysis.filesByLanguage.summaryCache` | workspaceState (Files by Language snapshot) | `src/code_analysis/services/workspaceSnapshotService.ts:8,416-446` | |
| `visualizeDataState` | workspaceState | `src/visualize_data/state/visualizeDataState.ts:348,360` | |
| `visualizationSettings` | legacy globalState, migrated to a file | `src/visualization_settings/storage/settingsStorage.ts:58,142` | |
| `codexr.cloudflaredDownloadConsented` | globalState (one-time cloudflared download consent) | `src/remote_access/services/cloudflaredBinaryManager.ts:39,72-81` | |
| `<globalStorage>/server-settings.json` | file (server settings) | `src/servers/storage/serverSettingsManager.ts:61,69` | |
| `<globalStorage>/server-certs/` | dir (generated HTTPS key pair) | `src/servers/runtime/generatedHttpsCertificateManager.ts:26,48` | |
| `<globalStorage>/codexr_analysis/` | dir (analysis configuration + profiles) | `src/code_analysis/configuration/analysisConfigurationStorage.ts:25,125`, `profileConfigurationCommands.ts:137` | |
| `<globalStorage>/visualization-configuration/` | dir (visualization settings, color icons) | `src/visualization_settings/storage/settingsStorage.ts:11,26` | |
| `<globalStorage>/collaboration/` | dir (collaboration profile) | `src/collaboration/services/collaborationProfileManager.ts:51` | |
| `<globalStorage>/python-env/` | dir (managed venv) | `src/python_env/storage/pythonEnvStorage.ts:22,36` | |
| `<globalStorage>/remote-access/<cloudflared version>/` | dir (managed cloudflared binary, pinned `2026.5.2`) | `src/remote_access/services/cloudflaredBinaryManager.ts:15,45` | |
| `<globalStorage>/visualize-data/` | dir (stored "Visualize Data" visualizations) | `src/visualize_data/runtime/visualizationRestorer.ts:40` | |
| `<storageUri or globalStorage>/…` private caches for dependency graph, historical comparison, project evolution, git export | dirs | `src/code_analysis/dependencies/dependencyGraphService.ts:21`, `historical/historicalComparisonService.ts:53`, `historical/projectEvolutionService.ts:60`, `export/gitRevisionExporter.ts:43,67` | |
| Context keys `codeXR.pythonEnv.uiLocked`, `codeXR.pythonEnv.retryAvailable` | `setContext` (gate every analysis menu) | `src/python_env/runtime/pythonEnvUiState.ts:105-106` | |

### 0.3 Authorized removals register (allowed to disappear; everything else must stay)

Source: maintainer decisions in `.claude/docs/v1.2.1/ROADMAP.md:20-28` (section B) and wave W2c/W2d rows at `ROADMAP.md:414-449`. Each authorized removal must land with a CHANGELOG `Removed` line.

| # | Item | Where it lives today | Authorization |
|---|---|---|---|
| R1 | The **17 pending-removal command ids** (listed in section 2, rows marked **pending-removal**) | `test/commands/internalCommandIds.cjs:72-89` | ROADMAP B.2 (`:23`), W2-45..W2-49 (`:419-423`) |
| R2 | `CodeXR.helloWorld` (contributed scaffold command, so contributed count 70 → 69) | `package.json:66-69`, `src/commands/index.ts:54-61` | ROADMAP B.2, W2-50 (`:424`) |
| R3 | `codeXR.pythonEnv.debugFailInstallation` is **hidden from the Command Palette** (stays registered and contributed; gains a `commandPalette` `when: false` entry, so that menu grows 11 → 12) | `package.json:291-296` | ROADMAP B.2, W2-51 (`:425`) |
| R4 | `"when": "true"` on the `codexrTree` view (no behaviour change) | `package.json:489` | W2-52 (`:426`) |
| R5 | Abandoned visual-style feature: `templates/components/common/codexrVisualStyleRuntime.js`, `visualStyleComponentAsset.ts`, `test/analysis/codexrVisualStyleRuntime.test.cjs` | see section 7 | ROADMAP B.4 (`:25`), W2-55 (`:433`) |
| R6 | Unreferenced `templates/xr/html/htmlLiveReload.js` | `templates/xr/html/htmlLiveReload.js` | W2-53 (`:431`) |
| R7 | Dead Python: `backend/src/livePanels/file_reanalysis_coordinator.py` (twin of the live `summaryFiles/` one), `backend/src/examples/`, the unread `--output` flag and the `project` `--type` alias of `main.py`, html/ on `sys.path`, `resume_only` + argparse CLI of `livePanel_file_analysis_coordinator.py`, seven never-called helpers | section 8 | W2-58..W2-66 (`:436-444`) |
| R8 | `resources/languages_icons/no_color/` (25 PNGs, 34 MB, not shipped) | `resources/languages_icons/no_color/` | W2-67 (`:445`) |
| R9 | Empty integration-test lane: `test:integration` script, `.vscode-test.mjs`, `@vscode/test-cli`, `@vscode/test-electron`, `@types/mocha` | `package.json` scripts, `.vscode-test.mjs` | ROADMAP B.4, W2-68/69 (`:447-448`); npm scripts 25 → 24 |
| R10 | Diagnostics moving from the DevTools console to the "CodeXR" output channel (logging migration) | `src/core/logging/logger.ts` | ROADMAP B.3 (`:24`) |

**Explicitly NOT removable**: `codexr.servers.refreshServers` and `codexr.servers.refresh` (legacy aliases published in 1.1.0, fenced by the test "the published legacy refresh aliases stay registered", `test/commands/commandContributions.test.cjs:150-161`).

**Expected post-cleanup counts if every authorized removal lands:** contributed commands 69, registered 105 (123 − 17 − 1), internal 36, `commandPalette` menu entries 12, XR runtimes 22, npm scripts 24. Any other delta is a regression.

## 1. Contributed manifest surface (`package.json` → `contributes`)

### 1.1 Identity, activation, containers, views, keybindings

| Field | Value | Source |
|---|---|---|
| `name` / `displayName` / `publisher` | `code-xr` / `Code-XR` / `aMonteSl` | `package.json:2-3`, `:34` |
| `version` | `1.2.1` | `package.json:5` |
| `main` | `./dist/extension.js` (webpack bundle of `src/extension.ts`) | `package.json:48` |
| `engines.vscode` | `^1.98.0` | `package.json:36-38` |
| `license` | `GPL-3.0-only` | `package.json:33` |
| `categories` | Visualization, Data Science, Debuggers, Linters, Testing, Other | `package.json:39-46` |
| `keywords` | 15 entries | `package.json:6-22` |
| `icon` / `galleryBanner` / `homepage` | `resources/icon.png` / `#0e141b` dark / `https://code-xr.adrianmonteslinares.com/` | `package.json:23-28` |
| `activationEvents` | `[]` (empty: VS Code infers activation from the contributed commands and the view) | `package.json:47` |
| `contributes.viewsContainers.activitybar` | one container: id `codexr`, title `CodeXR`, icon `resources/icon.svg` | `package.json:475-483` |
| `contributes.views.codexr` | one tree view: id `codexrTree`, name `CodeXR`, `when: "true"` (removal of the redundant clause authorized, R4), icon `$(server-environment)` | `package.json:484-493` |
| `contributes.submenus` | `codeXR.analysis.contextMenu` labelled `Code-XR: Analysis` | `package.json:742-747` |
| `contributes.keybindings` | **none** | (key absent) |
| `contributes.configuration` | title `CodeXR`, 1 property (table 1.3) | `package.json:465-474` |

The tree view is created in `src/extension.ts:49` (`vscode.window.createTreeView('codexrTree', …)`) and backed by `ModularTreeDataProvider`.

**[A] Snapshot one-liner** (run in `apps/vscode-extension/`; expected output after the cleanup is the same apart from authorized deltas R2-R4):

```bash
node -e 'const p=require("./package.json"),c=p.contributes;console.log(JSON.stringify({cmds:c.commands.length,settings:Object.keys(c.configuration.properties),containers:c.viewsContainers.activitybar.map(x=>x.id),views:c.views.codexr.map(x=>x.id),menus:Object.fromEntries(Object.entries(c.menus).map(([k,v])=>[k,v.length])),submenus:c.submenus.map(s=>s.id),keybindings:(c.keybindings||[]).length,activation:p.activationEvents,files:p.files.length,scripts:Object.keys(p.scripts).length}))'
# today: {"cmds":70,"settings":["codeXR.debug.verboseLogs"],"containers":["codexr"],"views":["codexrTree"],
#         "menus":{"view/title":2,"explorer/context":12,"editor/context":8,"view/item/context":5,"codeXR.analysis.contextMenu":11,"commandPalette":11},
#         "submenus":["codeXR.analysis.contextMenu"],"keybindings":0,"activation":[],"files":13,"scripts":25}
```

Also **[A]** `test/packaging/marketplaceListing.test.cjs` (listing fields) and `test/commands/commandContributions.test.cjs` ("menus and keybindings only name contributed commands").

**[M]** F5: the CodeXR icon appears in the activity bar; clicking it shows the single `CodeXR` tree with the sections listed in section 3.

### 1.2 Contributed commands (70)

Enablement legend: `L` = `!codeXR.pythonEnv.uiLocked` (disabled while the Python environment is being set up); `L*` = `!codeXR.pythonEnv.uiLocked || codeXR.pythonEnv.retryAvailable`; `-` = always enabled. 62 commands carry `L`, 1 carries `L*` (`codeXR.pythonEnv.reinitialize`), 7 carry none (helloWorld, the five collaboration commands, `codeXR.pythonEnv.status`). No command declares a `category`.

**[A] Verify:** `npm test` → `test/commands/commandContributions.test.cjs`: "every command contributed in package.json is registered" (`:102`) and "the real command set registers without a duplicate id" (`:93`). Diff the id list: `node -p "require('./package.json').contributes.commands.map(c=>c.command).join('\n')"` against the table below (expected delta: only R2 `CodeXR.helloWorld`).

| # | Command id | Title | Icon | Enablement | Contributed at (package.json) | Registered at |
|---|---|---|---|---|---|---|
| 1 | `CodeXR.helloWorld` | Hello World |  | - | package.json:67 | src/commands/index.ts:55 |
| 2 | `codeXR.collaboration.selectIdentity` | CodeXR: Select Collaboration Identity |  | - | package.json:71 | src/commands/collaboration/collaborationCommands.ts:37 |
| 3 | `codeXR.collaboration.setName` | CodeXR: Set Collaboration Name |  | - | package.json:75 | src/commands/collaboration/collaborationCommands.ts:68 |
| 4 | `codeXR.collaboration.selectAvatar` | CodeXR: Select Avatar Color |  | - | package.json:79 | src/commands/collaboration/collaborationCommands.ts:93 |
| 5 | `codeXR.collaboration.showAvatarModelInfo` | CodeXR: Show Avatar Model Information |  | - | package.json:83 | src/commands/collaboration/collaborationCommands.ts:121 |
| 6 | `codeXR.collaboration.joinRemote` | CodeXR: Join Remote Session |  | - | package.json:87 | src/commands/collaboration/collaborationCommands.ts:27 |
| 7 | `codexr.server.launch` | Start Local Server |  | L | package.json:91 | src/commands/servers/serverCommands.ts:32 |
| 8 | `codexr.server.configure` | Server Configuration |  | L | package.json:96 | src/commands/servers/serverCommands.ts:25 |
| 9 | `codexr.server.config.httpMode` | Configure HTTP Mode |  | L | package.json:101 | src/commands/servers/serverCommands.ts:39 |
| 10 | `codexr.server.config.port` | Configure Default Port |  | L | package.json:106 | src/commands/servers/serverCommands.ts:46 |
| 11 | `codexr.server.config.autoOpen` | Toggle Auto-Open |  | L | package.json:111 | src/commands/servers/serverCommands.ts:53 |
| 12 | `codexr.server.config.openMode` | Configure Open Mode |  | L | package.json:116 | src/commands/servers/serverCommands.ts:60 |
| 13 | `codexr.server.config.remoteAccess` | Configure Cross-Network Connections |  | L | package.json:121 | src/commands/servers/serverCommands.ts:67 |
| 14 | `codeXR.activeServers.showActions` | Show Server Actions | `$(menu)` | L | package.json:126 | src/active_servers/commands/activeServersCommands.ts:17 |
| 15 | `codeXR.activeServers.openInBrowser` | Open in Browser | `$(browser)` | L | package.json:132 | src/active_servers/commands/activeServersCommands.ts:26 |
| 16 | `codeXR.activeServers.openInPanel` | Open in Panel | `$(layout-panel)` | L | package.json:138 | src/active_servers/commands/activeServersCommands.ts:38 |
| 17 | `codeXR.activeServers.copyUrl` | Copy URL | `$(copy)` | L | package.json:144 | src/active_servers/commands/activeServersCommands.ts:50 |
| 18 | `codeXR.activeServers.startRemoteAccess` | Start Remote Access | `$(remote-explorer)` | L | package.json:150 | src/active_servers/commands/activeServersCommands.ts:74 |
| 19 | `codeXR.activeServers.copyRemoteInvitation` | Copy Remote Invitation | `$(link)` | L | package.json:156 | src/active_servers/commands/activeServersCommands.ts:86 |
| 20 | `codeXR.activeServers.stopRemoteAccess` | Stop Remote Access | `$(debug-disconnect)` | L | package.json:162 | src/active_servers/commands/activeServersCommands.ts:98 |
| 21 | `codeXR.activeServers.stopServer` | Stop Server | `$(stop-circle)` | L | package.json:168 | src/active_servers/commands/activeServersCommands.ts:122 |
| 22 | `codeXR.activeServers.showDetails` | Show Details | `$(info)` | L | package.json:174 | src/active_servers/commands/activeServersCommands.ts:134 |
| 23 | `codeXR.activeServers.removeParticipant` | Remove from Session | `$(circle-slash)` | L | package.json:180 | src/active_servers/commands/activeServersCommands.ts:167 |
| 24 | `codeXR.activeServers.stopAllServers` | Stop All Servers | `$(stop)` | L | package.json:186 | src/active_servers/commands/activeServersCommands.ts:192 |
| 25 | `codeXR.activeServers.refreshServers` | Refresh | `$(refresh)` | L | package.json:192 | src/active_servers/commands/activeServersCommands.ts:201 |
| 26 | `codeXR.activeServers.openView` | Open Active Servers |  | L | package.json:198 | src/active_servers/commands/activeServersCommands.ts:217 |
| 27 | `codeXR.babiaExamples.launchExample` | Launch Example | `$(play)` | L | package.json:203 | src/babia_examples/commands/babiaExamplesCommands.ts:23 |
| 28 | `codeXR.babiaExamples.refresh` | Refresh Examples | `$(refresh)` | L | package.json:209 | src/babia_examples/commands/babiaExamplesCommands.ts:78 |
| 29 | `codeXR.babiaExamples.openFolder` | Open Examples Folder | `$(folder-opened)` | L | package.json:215 | src/babia_examples/commands/babiaExamplesCommands.ts:94 |
| 30 | `codeXR.babiaExamples.showDetails` | Show Example Details | `$(info)` | L | package.json:221 | src/babia_examples/commands/babiaExamplesCommands.ts:110 |
| 31 | `codeXR.babiaExamples.showLibraryInfo` | Show BabiaXR Credits and Licenses | `$(info)` | L | package.json:227 | src/babia_examples/commands/babiaExamplesCommands.ts:33 |
| 32 | `codeXR.babiaExamples.openView` | Open Babia Examples |  | L | package.json:233 | src/babia_examples/commands/babiaExamplesCommands.ts:156 |
| 33 | `codeXR.visualizeData.chartType` | Select Chart Type | `$(graph)` | L | package.json:238 | src/visualize_data/commands/visualizeDataCommands.ts:32 |
| 34 | `codeXR.visualizeData.selectJson` | Select JSON File | `$(file-code)` | L | package.json:244 | src/visualize_data/commands/visualizeDataCommands.ts:39 |
| 35 | `codeXR.visualizeData.dimensionMapping` | Configure Dimension Mapping | `$(settings-gear)` | L | package.json:250 | src/visualize_data/commands/visualizeDataCommands.ts:46 |
| 36 | `codeXR.visualizeData.launchVisualization` | Launch Visualization | `$(play)` | L | package.json:256 | src/visualize_data/commands/visualizeDataCommands.ts:68 |
| 37 | `codeXR.pythonEnv.create` | Create Python Environment | `$(add)` | L | package.json:262 | src/python_env/commands/pythonEnvCommands.ts:22 |
| 38 | `codeXR.pythonEnv.delete` | Delete Python Environment | `$(trash)` | L | package.json:268 | src/python_env/commands/pythonEnvCommands.ts:29 |
| 39 | `codeXR.pythonEnv.status` | Python Environment Status | `$(info)` | - | package.json:274 | src/python_env/commands/pythonEnvCommands.ts:36 |
| 40 | `codeXR.pythonEnv.reinitialize` | Reinitialize Python Environment | `$(refresh)` | L* | package.json:279 | src/python_env/commands/pythonEnvCommands.ts:43 |
| 41 | `codeXR.pythonEnv.verifyInstallation` | Verify Python Environment Installation | `$(check)` | L | package.json:285 | src/python_env/commands/pythonEnvCommands.ts:50 |
| 42 | `codeXR.pythonEnv.debugFailInstallation` | CodeXR: Debug Python Environment Failure | `$(bug)` | L | package.json:291 | src/python_env/commands/pythonEnvCommands.ts:57 |
| 43 | `codeXR.analysis.analyzeFile` | CodeXR: Analyze File (LivePanel) | `$(file-code)` | L | package.json:297 | src/code_analysis/commands/file_analysis/fileAnalysisLivePanelCommands.ts:17 |
| 44 | `codeXR.analysis.analyzeFileXR` | CodeXR: Analyze File (XR) | `$(device-camera-video)` | L | package.json:303 | src/code_analysis/commands/file_analysis/fileAnalysisXRCommands.ts:19 |
| 45 | `codeXR.analysis.analyzeDirectory` | CodeXR: Analyze Directory (LivePanel) | `$(folder)` | L | package.json:309 | src/code_analysis/commands/directory_analysis/directoryAnalysisLivePanelCommands.ts:17 |
| 46 | `codeXR.analysis.analyzeDirectoryDeep` | CodeXR: Analyze Directory (LivePanel Deep) | `$(folder-library)` | L | package.json:315 | src/code_analysis/commands/directory_analysis/directoryAnalysisLivePanelCommands.ts:24 |
| 47 | `codeXR.analysis.analyzeDirectoryXR` | CodeXR: Analyze Directory (XR) | `$(device-desktop)` | L | package.json:321 | src/code_analysis/commands/directory_analysis/directoryAnalysisXRCommands.ts:17 |
| 48 | `codeXR.analysis.analyzeDirectoryXRDeep` | CodeXR: Analyze Directory (XR Deep) | `$(layers-dot)` | L | package.json:327 | src/code_analysis/commands/directory_analysis/directoryAnalysisXRCommands.ts:24 |
| 49 | `codeXR.analysis.analyzeProject` | CodeXR: Analyze Project (LivePanel) | `$(project)` | L | package.json:333 | src/code_analysis/commands/directory_analysis/projectAnalysisCommands.ts:17 |
| 50 | `codeXR.analysis.analyzeProjectDeep` | CodeXR: Analyze Project (LivePanel Deep) | `$(layers)` | L | package.json:339 | src/code_analysis/commands/directory_analysis/projectAnalysisCommands.ts:24 |
| 51 | `codeXR.analysis.analyzeProjectXR` | CodeXR: Analyze Project (XR) | `$(device-desktop)` | L | package.json:345 | src/code_analysis/commands/directory_analysis/directoryAnalysisXRCommands.ts:31 |
| 52 | `codeXR.analysis.analyzeProjectXRDeep` | CodeXR: Analyze Project (XR Deep) | `$(layers-dot)` | L | package.json:351 | src/code_analysis/commands/directory_analysis/directoryAnalysisXRCommands.ts:38 |
| 53 | `codeXR.analysis.visualizeDOM` | CodeXR: Visualize DOM | `$(browser)` | L | package.json:357 | src/code_analysis/commands/dom_visualization/domVisualizationCommands.ts:22 |
| 54 | `codeXR.analysis.activeAnalyses.showActions` | Show Analysis Actions | `$(menu)` | L | package.json:363 | src/code_analysis/views/subsections/active_analyses/commands/activeAnalysesCommands.ts:62 |
| 55 | `codeXR.analysis.activeAnalyses.close` | Close Analysis | `$(close)` | L | package.json:369 | src/code_analysis/views/subsections/active_analyses/commands/activeAnalysesCommands.ts:76 |
| 56 | `codeXR.analysis.activeAnalyses.viewInBrowser` | Open in Browser | `$(link-external)` | L | package.json:375 | src/code_analysis/views/subsections/active_analyses/commands/activeAnalysesCommands.ts:83 |
| 57 | `codeXR.analysis.activeAnalyses.showDetails` | View Details | `$(info)` | L | package.json:381 | src/code_analysis/views/subsections/active_analyses/commands/activeAnalysesCommands.ts:69 |
| 58 | `codeXR.analysis.activeAnalyses.exportFolder` | Export Analysis Folder | `$(export)` | L | package.json:387 | src/code_analysis/views/subsections/active_analyses/commands/activeAnalysesCommands.ts:90 |
| 59 | `codeXR.analysis.activeAnalyses.refresh` | Refresh Active Analyses | `$(refresh)` | L | package.json:393 | src/code_analysis/views/subsections/active_analyses/commands/activeAnalysesCommands.ts:97 |
| 60 | `codeXR.analysis.runLast.analyzeFile` | CodeXR: Run Last: Analyze File (LivePanel) | `$(history)` | L | package.json:399 | src/commands/analysis/AnalysisCommands.ts:44 (template `codeXR.analysis.runLast.${kind}`, kinds at :13-25) |
| 61 | `codeXR.analysis.runLast.analyzeFileXR` | CodeXR: Run Last: Analyze File (XR) | `$(history)` | L | package.json:405 | src/commands/analysis/AnalysisCommands.ts:44 (template `codeXR.analysis.runLast.${kind}`, kinds at :13-25) |
| 62 | `codeXR.analysis.runLast.analyzeDirectory` | CodeXR: Run Last: Analyze Directory (LivePanel) | `$(history)` | L | package.json:411 | src/commands/analysis/AnalysisCommands.ts:44 (template `codeXR.analysis.runLast.${kind}`, kinds at :13-25) |
| 63 | `codeXR.analysis.runLast.analyzeDirectoryDeep` | CodeXR: Run Last: Analyze Directory (LivePanel Deep) | `$(history)` | L | package.json:417 | src/commands/analysis/AnalysisCommands.ts:44 (template `codeXR.analysis.runLast.${kind}`, kinds at :13-25) |
| 64 | `codeXR.analysis.runLast.analyzeDirectoryXR` | CodeXR: Run Last: Analyze Directory (XR) | `$(history)` | L | package.json:423 | src/commands/analysis/AnalysisCommands.ts:44 (template `codeXR.analysis.runLast.${kind}`, kinds at :13-25) |
| 65 | `codeXR.analysis.runLast.analyzeDirectoryXRDeep` | CodeXR: Run Last: Analyze Directory (XR Deep) | `$(history)` | L | package.json:429 | src/commands/analysis/AnalysisCommands.ts:44 (template `codeXR.analysis.runLast.${kind}`, kinds at :13-25) |
| 66 | `codeXR.analysis.runLast.analyzeProject` | CodeXR: Run Last: Analyze Project (LivePanel) | `$(history)` | L | package.json:435 | src/commands/analysis/AnalysisCommands.ts:44 (template `codeXR.analysis.runLast.${kind}`, kinds at :13-25) |
| 67 | `codeXR.analysis.runLast.analyzeProjectDeep` | CodeXR: Run Last: Analyze Project (LivePanel Deep) | `$(history)` | L | package.json:441 | src/commands/analysis/AnalysisCommands.ts:44 (template `codeXR.analysis.runLast.${kind}`, kinds at :13-25) |
| 68 | `codeXR.analysis.runLast.analyzeProjectXR` | CodeXR: Run Last: Analyze Project (XR) | `$(history)` | L | package.json:447 | src/commands/analysis/AnalysisCommands.ts:44 (template `codeXR.analysis.runLast.${kind}`, kinds at :13-25) |
| 69 | `codeXR.analysis.runLast.analyzeProjectXRDeep` | CodeXR: Run Last: Analyze Project (XR Deep) | `$(history)` | L | package.json:453 | src/commands/analysis/AnalysisCommands.ts:44 (template `codeXR.analysis.runLast.${kind}`, kinds at :13-25) |
| 70 | `codeXR.analysis.runLast.visualizeDOM` | CodeXR: Run Last: Visualize DOM | `$(history)` | L | package.json:459 | src/commands/analysis/AnalysisCommands.ts:44 (template `codeXR.analysis.runLast.${kind}`, kinds at :13-25) |

### 1.3 Configuration settings (`contributes.configuration`, 1)

| Key | Type | Default | Description | package.json line | Consumer |
|---|---|---|---|---|---|
| `codeXR.debug.verboseLogs` | boolean | `false` | Enable verbose CodeXR debug logging in the dedicated output channel. | 468 | `src/core/logging/logger.ts:60` (live reload on change), `:104` (read) |

All other user-facing preferences are **not** VS Code settings: they are stored by the extension in its own files/state and edited from the sidebar tree (section 3) — server settings (3.1, 6.1), analysis settings (3.5), visualization settings (3.7), collaboration profile (3.2.1, 6.4). They are part of the baseline just the same.

**[A]** the snapshot one-liner in 1.1 (`settings` key). **[M]** Settings UI → search `codeXR` → exactly one entry, "Enable verbose CodeXR debug logging…"; toggling it changes the verbosity of the "CodeXR" output channel without a reload.

### 1.4 Menus (6 menu ids, 49 entries)

Common facts: every analysis menu entry is gated by `!codeXR.pythonEnv.uiLocked`; the file-analysis entries are gated by a `resourceExtname` regex listing exactly the **48 metric extensions** of the Python contract (section 5); `visualizeDOM` is gated by `/\.(html|htm|xhtml)$/`. The "Run Last" entries appear only for the kind stored in the `codeXR.analysis.lastKind` context key (`src/commands/analysis/AnalysisCommands.ts:30-43`), and are hidden from the palette by `commandPalette` `when: false`.

`METRIC_EXTS` below abbreviates the literal regex `/\.(py|pyw|pyi|rb|rbw|java|c|h|cpp|cxx|cc|hpp|hxx|cs|erl|hrl|f|f90|f95|f03|f08|gd|go|js|mjs|cjs|kt|kts|lua|m|mm|php|phtml|php3|php4|php5|pl|pm|scala|sc|sol|swift|ts|tsx|ttcn|ttcn3|vue|zig)$/` (48 extensions, identical in all 6 occurrences). Note it does **not** include the three extra C++ extensions `.c++ .hh .h++` that the TS label table knows (section 5).

**[A]** `node -e 'const m=require("./package.json").contributes.menus;for(const[k,v] of Object.entries(m))console.log(k,v.length,v.map(e=>e.command||e.submenu).join(","))'`, compare with the tables below. `test/commands/commandContributions.test.cjs:163` ("menus and keybindings only name contributed commands").
**[M]** Right-click a `.py` file in the Explorer → `Code-XR: Analysis` submenu with 11 entries (file entries enabled, HTML entry absent); right-click a folder → directory/project entries; right-click inside an open editor → submenu + the Run-Last entry for the last analysis kind used; right-click an `.html` file → `Visualize DOM`.

#### `view/title` (2 entries, `package.json:495`)

| # | command/submenu | when | group |
|---|---|---|---|
| 1 | `codeXR.activeServers.refreshServers` | `view == codexrTree && !codeXR.pythonEnv.uiLocked` | navigation@1 |
| 2 | `codeXR.activeServers.stopAllServers` | `view == codexrTree && !codeXR.pythonEnv.uiLocked` | navigation@2 |

#### `explorer/context` (12 entries, `package.json:507`)

| # | command/submenu | when | group |
|---|---|---|---|
| 1 | `codeXR.analysis.runLast.analyzeFile` | `codeXR.analysis.lastKind == analyzeFile && resourceExtname =~ METRIC_EXTS && !codeXR.pythonEnv.uiLocked` | codexr@1 |
| 2 | `codeXR.analysis.runLast.analyzeFileXR` | `codeXR.analysis.lastKind == analyzeFileXR && resourceExtname =~ METRIC_EXTS && !codeXR.pythonEnv.uiLocked` | codexr@2 |
| 3 | `codeXR.analysis.runLast.analyzeDirectory` | `codeXR.analysis.lastKind == analyzeDirectory && explorerResourceIsFolder && !codeXR.pythonEnv.uiLocked` | codexr@3 |
| 4 | `codeXR.analysis.runLast.analyzeDirectoryDeep` | `codeXR.analysis.lastKind == analyzeDirectoryDeep && explorerResourceIsFolder && !codeXR.pythonEnv.uiLocked` | codexr@4 |
| 5 | `codeXR.analysis.runLast.analyzeDirectoryXR` | `codeXR.analysis.lastKind == analyzeDirectoryXR && explorerResourceIsFolder && !codeXR.pythonEnv.uiLocked` | codexr@5 |
| 6 | `codeXR.analysis.runLast.analyzeDirectoryXRDeep` | `codeXR.analysis.lastKind == analyzeDirectoryXRDeep && explorerResourceIsFolder && !codeXR.pythonEnv.uiLocked` | codexr@6 |
| 7 | `codeXR.analysis.runLast.analyzeProject` | `codeXR.analysis.lastKind == analyzeProject && !codeXR.pythonEnv.uiLocked` | codexr@7 |
| 8 | `codeXR.analysis.runLast.analyzeProjectDeep` | `codeXR.analysis.lastKind == analyzeProjectDeep && !codeXR.pythonEnv.uiLocked` | codexr@8 |
| 9 | `codeXR.analysis.runLast.analyzeProjectXR` | `codeXR.analysis.lastKind == analyzeProjectXR && !codeXR.pythonEnv.uiLocked` | codexr@9 |
| 10 | `codeXR.analysis.runLast.analyzeProjectXRDeep` | `codeXR.analysis.lastKind == analyzeProjectXRDeep && !codeXR.pythonEnv.uiLocked` | codexr@10 |
| 11 | `codeXR.analysis.runLast.visualizeDOM` | `codeXR.analysis.lastKind == visualizeDOM && resourceExtname =~ /\.(html\|htm\|xhtml)$/ && !codeXR.pythonEnv.uiLocked` | codexr@11 |
| 12 | `submenu:codeXR.analysis.contextMenu` | `!codeXR.pythonEnv.uiLocked` | codexr@99 |

#### `editor/context` (8 entries, `package.json:569`)

| # | command/submenu | when | group |
|---|---|---|---|
| 1 | `codeXR.analysis.runLast.analyzeFile` | `codeXR.analysis.lastKind == analyzeFile && resourceExtname =~ METRIC_EXTS && !codeXR.pythonEnv.uiLocked` | codexr@1 |
| 2 | `codeXR.analysis.runLast.analyzeFileXR` | `codeXR.analysis.lastKind == analyzeFileXR && resourceExtname =~ METRIC_EXTS && !codeXR.pythonEnv.uiLocked` | codexr@2 |
| 3 | `codeXR.analysis.runLast.analyzeProject` | `codeXR.analysis.lastKind == analyzeProject && !codeXR.pythonEnv.uiLocked` | codexr@3 |
| 4 | `codeXR.analysis.runLast.analyzeProjectDeep` | `codeXR.analysis.lastKind == analyzeProjectDeep && !codeXR.pythonEnv.uiLocked` | codexr@4 |
| 5 | `codeXR.analysis.runLast.analyzeProjectXR` | `codeXR.analysis.lastKind == analyzeProjectXR && !codeXR.pythonEnv.uiLocked` | codexr@5 |
| 6 | `codeXR.analysis.runLast.analyzeProjectXRDeep` | `codeXR.analysis.lastKind == analyzeProjectXRDeep && !codeXR.pythonEnv.uiLocked` | codexr@6 |
| 7 | `codeXR.analysis.runLast.visualizeDOM` | `codeXR.analysis.lastKind == visualizeDOM && resourceExtname =~ /\.(html\|htm\|xhtml)$/ && !codeXR.pythonEnv.uiLocked` | codexr@7 |
| 8 | `submenu:codeXR.analysis.contextMenu` | `!codeXR.pythonEnv.uiLocked` | codexr@99 |

#### `view/item/context` (5 entries, `package.json:611`)

| # | command/submenu | when | group |
|---|---|---|---|
| 1 | `codeXR.analysis.activeAnalyses.showDetails` | `view == codexrTree && viewItem =~ /^activeAnalysis\.(creating\|analyzing\|monitoring\|completed\|error\|failed)$/ && !codeXR.pythonEnv.uiLocked` | activeAnalyses@1 |
| 2 | `codeXR.analysis.activeAnalyses.viewInBrowser` | `view == codexrTree && viewItem =~ /^activeAnalysis\.(creating\|analyzing\|monitoring\|completed\|error\|failed)$/ && !codeXR.pythonEnv.uiLocked` | activeAnalyses@2 |
| 3 | `codeXR.analysis.activeAnalyses.exportFolder` | `view == codexrTree && viewItem =~ /^activeAnalysis\.(creating\|analyzing\|monitoring\|completed\|error\|failed)$/ && !codeXR.pythonEnv.uiLocked` | activeAnalyses@3 |
| 4 | `codeXR.analysis.activeAnalyses.close` | `view == codexrTree && viewItem =~ /^activeAnalysis\.(creating\|analyzing\|monitoring\|completed\|error\|failed)$/ && !codeXR.pythonEnv.uiLocked` | activeAnalyses@4 |
| 5 | `codeXR.activeServers.removeParticipant` | `view == codexrTree && viewItem == activeServerParticipantGuest && !codeXR.pythonEnv.uiLocked` | activeServerParticipant@1 |

#### `codeXR.analysis.contextMenu` (11 entries, `package.json:638`)

| # | command/submenu | when | group |
|---|---|---|---|
| 1 | `codeXR.analysis.analyzeFile` | `resourceExtname =~ METRIC_EXTS && !codeXR.pythonEnv.uiLocked` | codexr@1 |
| 2 | `codeXR.analysis.analyzeFileXR` | `resourceExtname =~ METRIC_EXTS && !codeXR.pythonEnv.uiLocked` | codexr@2 |
| 3 | `codeXR.analysis.analyzeDirectory` | `explorerResourceIsFolder && !codeXR.pythonEnv.uiLocked` | codexr@3 |
| 4 | `codeXR.analysis.analyzeDirectoryDeep` | `explorerResourceIsFolder && !codeXR.pythonEnv.uiLocked` | codexr@4 |
| 5 | `codeXR.analysis.analyzeDirectoryXR` | `explorerResourceIsFolder && !codeXR.pythonEnv.uiLocked` | codexr@5 |
| 6 | `codeXR.analysis.analyzeDirectoryXRDeep` | `explorerResourceIsFolder && !codeXR.pythonEnv.uiLocked` | codexr@6 |
| 7 | `codeXR.analysis.analyzeProject` | `!codeXR.pythonEnv.uiLocked` | codexr@7 |
| 8 | `codeXR.analysis.analyzeProjectDeep` | `!codeXR.pythonEnv.uiLocked` | codexr@8 |
| 9 | `codeXR.analysis.analyzeProjectXR` | `!codeXR.pythonEnv.uiLocked` | codexr@9 |
| 10 | `codeXR.analysis.analyzeProjectXRDeep` | `!codeXR.pythonEnv.uiLocked` | codexr@10 |
| 11 | `codeXR.analysis.visualizeDOM` | `resourceExtname =~ /\.(html\|htm\|xhtml)$/ && !codeXR.pythonEnv.uiLocked` | codexr@11 |

#### `commandPalette` (11 entries, `package.json:695`)

| # | command/submenu | when | group |
|---|---|---|---|
| 1 | `codeXR.analysis.runLast.analyzeFile` | `false` |  |
| 2 | `codeXR.analysis.runLast.analyzeFileXR` | `false` |  |
| 3 | `codeXR.analysis.runLast.analyzeDirectory` | `false` |  |
| 4 | `codeXR.analysis.runLast.analyzeDirectoryDeep` | `false` |  |
| 5 | `codeXR.analysis.runLast.analyzeDirectoryXR` | `false` |  |
| 6 | `codeXR.analysis.runLast.analyzeDirectoryXRDeep` | `false` |  |
| 7 | `codeXR.analysis.runLast.analyzeProject` | `false` |  |
| 8 | `codeXR.analysis.runLast.analyzeProjectDeep` | `false` |  |
| 9 | `codeXR.analysis.runLast.analyzeProjectXR` | `false` |  |
| 10 | `codeXR.analysis.runLast.analyzeProjectXRDeep` | `false` |  |
| 11 | `codeXR.analysis.runLast.visualizeDOM` | `false` |  |
## 2. Commands registered at runtime

### 2.1 Registration pipeline

`registerAllCommands` (`src/commands/index.ts:22-65`) concatenates the arrays below in this order, runs `assertUniqueCommandIds` (`:63`, defined in `src/commands/shared/commandRegistry.ts`) and registers them through `CommandBuilder.registerAll` (`src/utils/commandBuilder.ts`). It is called once from `src/extension.ts:57`.

| Order | Provider | File | What it registers |
|---|---|---|---|
| 1 | `getGeneralCommandRegistrations()` | `src/commands/common/generalCommands.ts` | 4 internal refresh ids (`codexr.tree.refresh`, `codexr.servers.refresh`, `codexr.servers.refreshServers`, `codeXR.modularTree.refresh`) |
| 2 | `getServerCommandRegistrations(context)` | `src/commands/servers/serverCommands.ts` | 7 contributed `codexr.server.*` + internal `codexr.server.config.resetToDefault` |
| 3 | `getActiveServersCommandRegistrations(tree)` | `src/commands/active_servers/activeServersCommands.ts` → `src/active_servers/commands/activeServersCommands.ts` | 13 contributed `codeXR.activeServers.*` + 4 internal |
| 4 | `getBabiaExamplesCommandRegistrations(...)` | → `src/babia_examples/commands/babiaExamplesCommands.ts` | 6 contributed `codeXR.babiaExamples.*` |
| 5 | `getVisualizeDataCommandRegistrations(context)` | → `src/visualize_data/commands/visualizeDataCommands.ts` | 4 contributed + 3 internal (+ 1 pending-removal) |
| 6 | `getAnalysisCommandRegistrations(context, refresh)` | `src/commands/analysis/AnalysisCommands.ts` → `src/code_analysis/commands/analysisCommands.ts:32-78` | 11 analysis kinds, 6 active-analyses actions, 11 run-last (generated from a template at `AnalysisCommands.ts:44`), settings/tree-row ids, files-by-language, project-by-language, clean-analysis. Records the last kind (`AnalysisCommands.ts:68-73`) |
| 7 | `getPythonEnvCommandRegistrations(context)` | → `src/python_env/commands/pythonEnvCommands.ts:18-65` | 6 contributed `codeXR.pythonEnv.*` |
| 8 | `getVisualizationSettingsCommandRegistrations(context)` | → `src/visualization_settings/commands/visualizationSettingsCommands.ts` | 2 internal |
| 9 | `getCollaborationCommandRegistrations(context, tree)` | `src/commands/collaboration/collaborationCommands.ts` | 5 contributed `codeXR.collaboration.*` |
| 10 | `getLearnMoreCommandRegistrations(context)` | → `src/learn_more/commands/learnMoreCommands.ts` | 3 internal |
| 11 | `DebugThemeProblem.getCommandRegistrations(context)` | `src/code_analysis/configuration/debugThemeProblem.ts:138,148` | 2 pending-removal debug ids (file deletion authorized, R1) |
| 12 | inline literal | `src/commands/index.ts:54-61` | `CodeXR.helloWorld` (removal authorized, R2) |

**Totals: 123 registered = 70 contributed + 53 internal.** 28 of the ids are built at runtime from templates (comment at `test/commands/commandContributions.test.cjs:19`), which is why only the executing contract test sees the full set.

**[A] Verify:** `npm test` must keep these tests green in `test/commands/commandContributions.test.cjs`:
1. "the real command set registers without a duplicate id" (`:93`)
2. "every command contributed in package.json is registered" (`:102`)
3. "every registered command is either contributed or listed as internal, with how it is reached" (`:111`) — this is the **exact set equality** with the table below; an id removed without being authorized fails here only if its row was not also deleted, so always diff this table against `internalCommandIds.cjs` after the cleanup.
4. "an internal command is reachable the way its kind says" (`:129`)
5. "the published legacy refresh aliases stay registered" (`:150`)
6. "menus and keybindings only name contributed commands" (`:163`)

Plus `test/commands/commandRegistry.test.cjs` (`assertUniqueCommandIds`, `CommandBuilder`).

### 2.2 Internal command ids (53)

Kinds (from `test/commands/internalCommandIds.cjs:3-19`): **tree-item** = a tree row carries it as its click command; **programmatic** = invoked via `executeCommand`; **legacy-alias** = published id kept for users' keybindings, never removed; **pending-removal** = referenced by nothing, removal **AUTHORIZED** (ROADMAP B.2). "First reference" is the first non-registration source line that names the id (for tree items, the tree row).

| # | Command id | Kind | Reason (from the contract file) | Listed at | Registered at | First reference (how it is reached) |
|---|---|---|---|---|---|---|
| 1 | `codeXR.activeServers.copyLanUrl` | tree-item | LAN URL row of a running server | test/commands/internalCommandIds.cjs:25 | src/active_servers/commands/activeServersCommands.ts:62 | src/views/active_servers/items/activeServerItems.ts:173 |
| 2 | `codeXR.activeServers.regeneratePairingCode` | tree-item | remote-access pairing row | test/commands/internalCommandIds.cjs:26 | src/active_servers/commands/activeServersCommands.ts:146 | src/views/active_servers/items/activeServerItems.ts:333 |
| 3 | `codeXR.activeServers.showParticipantDetails` | tree-item | collaboration participant row | test/commands/internalCommandIds.cjs:27 | src/active_servers/commands/activeServersCommands.ts:158 | src/views/active_servers/items/activeServerItems.ts:253 |
| 4 | `codeXR.activeServers.showRemoteStatus` | tree-item | remote-access status row | test/commands/internalCommandIds.cjs:28 | src/active_servers/commands/activeServersCommands.ts:110 | src/views/active_servers/items/activeServerItems.ts:344 |
| 5 | `codeXR.analysis.toggleAnalysisFileMode` | tree-item | analysis file mode row | test/commands/internalCommandIds.cjs:31 | src/code_analysis/commands/subsections/analysis_settings/analysis_file_mode/analysisFileModeCommands.ts:33 | src/code_analysis/views/subsections/analysis_settings/analysis_file_mode/analysisFileMode.ts:41 |
| 6 | `codeXR.analysis.selectAnalysisDirectoryMode` | tree-item | analysis directory mode row | test/commands/internalCommandIds.cjs:32 | src/code_analysis/commands/subsections/analysis_settings/analysis_directory_mode/analysisDirectoryModeCommands.ts:24 | src/code_analysis/views/subsections/analysis_settings/analysis_directory_mode/analysisDirectoryMode.ts:37 |
| 7 | `codeXR.analysis.toggleViewTheme` | tree-item | view theme row | test/commands/internalCommandIds.cjs:33 | src/code_analysis/commands/subsections/analysis_settings/view_theme/viewThemeCommands.ts:30 | src/code_analysis/views/subsections/analysis_settings/view_theme/viewTheme.ts:38 |
| 8 | `codeXR.analysis.toggleAutoAnalysisEnabled` | tree-item | auto-analysis enabled row | test/commands/internalCommandIds.cjs:34 | src/code_analysis/commands/subsections/analysis_settings/auto_analysis_enabled/autoAnalysisEnabledCommands.ts:31 | src/code_analysis/views/subsections/analysis_settings/auto_analysis_enabled/autoAnalysisEnabled.ts:36 |
| 9 | `codeXR.analysis.selectAutoAnalysisDelay` | tree-item | auto-analysis delay row | test/commands/internalCommandIds.cjs:35 | src/code_analysis/commands/subsections/analysis_settings/auto_analysis_delay/autoAnalysisDelayCommands.ts:31 | src/code_analysis/views/subsections/analysis_settings/auto_analysis_delay/autoAnalysisDelay.ts:46 |
| 10 | `codeXR.analysis.selectChartTypeFile` | tree-item | file chart type row | test/commands/internalCommandIds.cjs:36 | src/code_analysis/commands/subsections/analysis_settings/chart_type_file/chartTypeFileCommands.ts:30 | src/code_analysis/views/subsections/analysis_settings/dimension_mapping_file/dimensionMappingFile.ts:19 |
| 11 | `codeXR.analysis.selectChartTypeDirectory` | tree-item | directory chart type row | test/commands/internalCommandIds.cjs:37 | src/code_analysis/commands/subsections/analysis_settings/chart_type_directory/chartTypeDirectoryCommands.ts:30 | src/code_analysis/views/subsections/analysis_settings/dimension_mapping_directory/dimensionMappingDirectory.ts:19 |
| 12 | `codeXR.analysis.selectDimensionMappingFile` | tree-item | file dimension mapping rows | test/commands/internalCommandIds.cjs:38 | src/code_analysis/commands/subsections/analysis_settings/dimension_mapping_file/dimensionMappingFileCommands.ts:23 | src/code_analysis/views/subsections/analysis_settings/dimension_mapping_file/dimensionMappingFile.ts:18 |
| 13 | `codeXR.analysis.selectDimensionMappingDirectory` | tree-item | directory dimension mapping rows | test/commands/internalCommandIds.cjs:39 | src/code_analysis/commands/subsections/analysis_settings/dimension_mapping_directory/dimensionMappingDirectoryCommands.ts:23 | src/code_analysis/views/subsections/analysis_settings/dimension_mapping_directory/dimensionMappingDirectory.ts:18 |
| 14 | `codeXR.analysis.selectFilesSorting` | tree-item | files-by-language sorting row | test/commands/internalCommandIds.cjs:40 | src/code_analysis/commands/subsections/analysis_settings/filesByLanguageSortingCommands.ts:50 | src/code_analysis/views/subsections/analysis_settings/files_by_language_sorting/filesByLanguageSorting.ts:100 |
| 15 | `codeXR.analysis.selectLanguageGroupPrimarySorting` | tree-item | language group sorting row | test/commands/internalCommandIds.cjs:41 | src/code_analysis/commands/subsections/analysis_settings/filesByLanguageSortingCommands.ts:32 | src/code_analysis/views/subsections/analysis_settings/files_by_language_sorting/filesByLanguageSorting.ts:64 |
| 16 | `codeXR.analysis.selectLanguageGroupSecondarySorting` | tree-item | language group secondary sorting row | test/commands/internalCommandIds.cjs:42 | src/code_analysis/commands/subsections/analysis_settings/filesByLanguageSortingCommands.ts:41 | src/code_analysis/views/subsections/analysis_settings/files_by_language_sorting/filesByLanguageSorting.ts:84 |
| 17 | `codeXR.analysis.resetToDefaults` | tree-item | profile configuration: reset row | test/commands/internalCommandIds.cjs:43 | src/code_analysis/commands/subsections/analysis_settings/profile_configuration/profileConfigurationCommands.ts:34 | src/code_analysis/views/subsections/analysis_settings/profile_configuration/profileConfiguration.ts:51 |
| 18 | `codeXR.analysis.saveProfile` | tree-item | profile configuration: save row | test/commands/internalCommandIds.cjs:44 | src/code_analysis/commands/subsections/analysis_settings/profile_configuration/profileConfigurationCommands.ts:43 | src/code_analysis/views/subsections/analysis_settings/profile_configuration/profileConfiguration.ts:67 |
| 19 | `codeXR.analysis.loadProfile` | tree-item | profile configuration: load row | test/commands/internalCommandIds.cjs:45 | src/code_analysis/commands/subsections/analysis_settings/profile_configuration/profileConfigurationCommands.ts:52 | src/code_analysis/views/subsections/analysis_settings/profile_configuration/profileConfiguration.ts:83 |
| 20 | `codeXR.analysis.deleteProfile` | tree-item | profile configuration: delete row | test/commands/internalCommandIds.cjs:46 | src/code_analysis/commands/subsections/analysis_settings/profile_configuration/profileConfigurationCommands.ts:61 | src/code_analysis/views/subsections/analysis_settings/profile_configuration/profileConfiguration.ts:99 |
| 21 | `codeXR.analysis.runAndAnalyzeFile` | tree-item | files-by-language file row | test/commands/internalCommandIds.cjs:49 | src/code_analysis/commands/subsections/files_by_language/filesByLanguageCommands.ts:44 | src/code_analysis/views/subsections/files_by_language/filesByLanguageSubsectionProvider.ts:126 |
| 22 | `codeXR.analysis.projectStructure.analyzeFile` | tree-item | project-by-language file row | test/commands/internalCommandIds.cjs:50 | src/code_analysis/commands/subsections/project_by_language/projectByLanguageCommands.ts:29 | src/code_analysis/views/subsections/project_by_language/projectByLanguageSubsectionProvider.ts:112 |
| 23 | `codeXR.analysis.projectStructure.analyzeDirectory` | tree-item | project-by-language directory row | test/commands/internalCommandIds.cjs:51 | src/code_analysis/commands/subsections/project_by_language/projectByLanguageCommands.ts:40 | src/code_analysis/views/subsections/project_by_language/projectByLanguageSubsectionProvider.ts:95 |
| 24 | `codeXR.visualizeData.mapDimensionField` | tree-item | dimension mapping row | test/commands/internalCommandIds.cjs:54 | src/visualize_data/commands/visualizeDataCommands.ts:53 | src/visualize_data/views/items/visualizeDataItems.ts:263 |
| 25 | `codeXR.browseVisualizations.launch` | tree-item | stored visualization row | test/commands/internalCommandIds.cjs:55 | src/visualize_data/commands/visualizeDataCommands.ts:82 | src/visualize_data/views/items/visualizationItem.ts:90 |
| 26 | `codeXR.browseVisualizations.resetAll` | tree-item | reset stored visualizations row | test/commands/internalCommandIds.cjs:56 | src/visualize_data/commands/visualizeDataCommands.ts:92 | src/visualize_data/views/items/visualizationItem.ts:112 |
| 27 | `codeXR.visualizationSettings.configure` | tree-item | visualization setting row | test/commands/internalCommandIds.cjs:57 | src/visualization_settings/commands/visualizationSettingsCommands.ts:24 | src/views/visualization_settings/interactions/handleVisualizationSettingsClicks.ts:83 |
| 28 | `codeXR.visualizationSettings.resetAll` | tree-item | reset visualization settings row | test/commands/internalCommandIds.cjs:58 | src/visualization_settings/commands/visualizationSettingsCommands.ts:33 | src/views/visualization_settings/items/visualizationSettingsItems.ts:59 |
| 29 | `codeXR.learnMore` | tree-item | Learn More row | test/commands/internalCommandIds.cjs:59 | src/learn_more/commands/learnMoreCommands.ts:14 | src/views/learn_more/items/learnMoreItems.ts:50 |
| 30 | `codeXR.openAuthorWebsite` | tree-item | author website row | test/commands/internalCommandIds.cjs:60 | src/learn_more/commands/learnMoreCommands.ts:23 | src/views/learn_more/items/learnMoreItems.ts:67 |
| 31 | `codeXR.supportDeveloper` | tree-item | support row | test/commands/internalCommandIds.cjs:61 | src/learn_more/commands/learnMoreCommands.ts:32 | src/views/learn_more/items/learnMoreItems.ts:84 |
| 32 | `codexr.server.config.resetToDefault` | tree-item | server configuration: reset row | test/commands/internalCommandIds.cjs:64 | src/commands/servers/serverCommands.ts:74 | src/views/servers/items/serverItems.ts:142 |
| 33 | `codexr.tree.refresh` | programmatic | tree refresh after a server action | test/commands/internalCommandIds.cjs:67 | src/commands/common/generalCommands.ts:10 | src/active_servers/commands/activeServersCommands.ts:212 |
| 34 | `codeXR.modularTree.refresh` | programmatic | CommonCommands.refreshTreeView | test/commands/internalCommandIds.cjs:68 | src/commands/common/generalCommands.ts:37 | src/utils/commonCommands.ts:31 |
| 35 | `codexr.servers.refresh` | legacy-alias | published in 1.1.0 as the servers refresh; still the id most code calls | test/commands/internalCommandIds.cjs:69 | src/commands/common/generalCommands.ts:19 | src/visualize_data/model/visualizeDataModel.ts:87 |
| 36 | `codexr.servers.refreshServers` | legacy-alias | published in 1.1.0; zero callers today, kept for users' keybindings | test/commands/internalCommandIds.cjs:70 | src/commands/common/generalCommands.ts:28 | none |
| 37 | `codeXR.analysis.setAnalysisFileModeXR` | **pending-removal (AUTHORIZED removal)** | superseded by toggleAnalysisFileMode | test/commands/internalCommandIds.cjs:73 | src/code_analysis/commands/subsections/analysis_settings/analysis_file_mode/analysisFileModeCommands.ts:40 | none |
| 38 | `codeXR.analysis.setAnalysisFileModeHivePanel` | **pending-removal (AUTHORIZED removal)** | superseded by toggleAnalysisFileMode | test/commands/internalCommandIds.cjs:74 | src/code_analysis/commands/subsections/analysis_settings/analysis_file_mode/analysisFileModeCommands.ts:47 | none |
| 39 | `codeXR.analysis.setViewThemeDark` | **pending-removal (AUTHORIZED removal)** | superseded by toggleViewTheme | test/commands/internalCommandIds.cjs:75 | src/code_analysis/commands/subsections/analysis_settings/view_theme/viewThemeCommands.ts:35 | none |
| 40 | `codeXR.analysis.setViewThemeLight` | **pending-removal (AUTHORIZED removal)** | superseded by toggleViewTheme | test/commands/internalCommandIds.cjs:76 | src/code_analysis/commands/subsections/analysis_settings/view_theme/viewThemeCommands.ts:40 | none |
| 41 | `codeXR.analysis.enableAutoAnalysis` | **pending-removal (AUTHORIZED removal)** | superseded by toggleAutoAnalysisEnabled | test/commands/internalCommandIds.cjs:77 | src/code_analysis/commands/subsections/analysis_settings/auto_analysis_enabled/autoAnalysisEnabledCommands.ts:36 | none |
| 42 | `codeXR.analysis.disableAutoAnalysis` | **pending-removal (AUTHORIZED removal)** | superseded by toggleAutoAnalysisEnabled | test/commands/internalCommandIds.cjs:78 | src/code_analysis/commands/subsections/analysis_settings/auto_analysis_enabled/autoAnalysisEnabledCommands.ts:41 | none |
| 43 | `codeXR.analysis.setAutoAnalysisDelayRealTime` | **pending-removal (AUTHORIZED removal)** | superseded by selectAutoAnalysisDelay | test/commands/internalCommandIds.cjs:79 | src/code_analysis/commands/subsections/analysis_settings/auto_analysis_delay/autoAnalysisDelayCommands.ts:36 | none |
| 44 | `codeXR.analysis.setAutoAnalysisDelay1s` | **pending-removal (AUTHORIZED removal)** | superseded by selectAutoAnalysisDelay | test/commands/internalCommandIds.cjs:80 | src/code_analysis/commands/subsections/analysis_settings/auto_analysis_delay/autoAnalysisDelayCommands.ts:41 | none |
| 45 | `codeXR.analysis.setAutoAnalysisDelay3s` | **pending-removal (AUTHORIZED removal)** | superseded by selectAutoAnalysisDelay | test/commands/internalCommandIds.cjs:81 | src/code_analysis/commands/subsections/analysis_settings/auto_analysis_delay/autoAnalysisDelayCommands.ts:46 | none |
| 46 | `codeXR.analysis.setAutoAnalysisDelay5s` | **pending-removal (AUTHORIZED removal)** | superseded by selectAutoAnalysisDelay | test/commands/internalCommandIds.cjs:82 | src/code_analysis/commands/subsections/analysis_settings/auto_analysis_delay/autoAnalysisDelayCommands.ts:51 | none |
| 47 | `codeXR.analysis.setAutoAnalysisDelay10s` | **pending-removal (AUTHORIZED removal)** | superseded by selectAutoAnalysisDelay | test/commands/internalCommandIds.cjs:83 | src/code_analysis/commands/subsections/analysis_settings/auto_analysis_delay/autoAnalysisDelayCommands.ts:56 | none |
| 48 | `codeXR.analysis.refreshFilesByLanguage` | **pending-removal (AUTHORIZED removal)** | never wired to a tree item or a menu | test/commands/internalCommandIds.cjs:84 | src/code_analysis/commands/subsections/files_by_language/filesByLanguageCommands.ts:28 | none |
| 49 | `codeXR.analysis.openFileFromLanguageGroup` | **pending-removal (AUTHORIZED removal)** | never wired to a tree item or a menu | test/commands/internalCommandIds.cjs:85 | src/code_analysis/commands/subsections/files_by_language/filesByLanguageCommands.ts:37 | none |
| 50 | `codeXR.analysis.cleanAnalysis` | **pending-removal (AUTHORIZED removal)** | startup cleanup runs on its own; the command has no caller | test/commands/internalCommandIds.cjs:86 | src/code_analysis/commands/clean_analysis/cleanAnalysisCommands.ts:26 | none |
| 51 | `codeXR.visualizeData.debugState` | **pending-removal (AUTHORIZED removal)** | debug command with no caller | test/commands/internalCommandIds.cjs:87 | src/visualize_data/commands/visualizeDataCommands.ts:75 | none |
| 52 | `codexr.debug.themeConfiguration` | **pending-removal (AUTHORIZED removal)** | debugThemeProblem.ts: console-only diagnostics nobody can run | test/commands/internalCommandIds.cjs:88 | src/code_analysis/configuration/debugThemeProblem.ts:138 | none |
| 53 | `codexr.debug.themeWorkflow` | **pending-removal (AUTHORIZED removal)** | debugThemeProblem.ts: console-only diagnostics nobody can run | test/commands/internalCommandIds.cjs:89 | src/code_analysis/configuration/debugThemeProblem.ts:148 | none |

After the cleanup, expected: rows 1-36 unchanged (32 tree-item, 2 programmatic, 2 legacy-alias), rows 37-53 gone. **[M]** each tree-item row is exercised by the per-section F5 steps in section 3.


## 3. Sidebar tree (`codexrTree`) — sections and what each row does

One `ModularTreeDataProvider` (`src/views/ModularTreeDataProvider.ts`) lazily mounts eight root sections, in this order (the literals returned by `createSectionDefinitions` in `src/views/sectionDefinitions.ts:77-194`). The Python env and Learn More sections stay interactive while the UI is locked (`interactiveWhenRestricted: true`, `:166`, `:192`); every other section is inert while `codeXR.pythonEnv.uiLocked` is set.

| # | Root header (label) | Section key | Default state | Provider | Header source |
|---|---|---|---|---|---|
| 1 | `SERVERS` | `SERVERS` | expanded | `src/views/servers/ServersSectionProvider.ts` | `sectionDefinitions.ts:78-88` |
| 2 | `ACTIVE SERVERS` / `ACTIVE SERVERS (N running)` | `activeServers` | expanded | `src/views/active_servers/ActiveServersSectionProvider.ts` | `:89-108` |
| 3 | `BABIA EXAMPLES` | `babiaExamples` | collapsed | `src/views/babia_examples/BabiaExamplesSectionProvider.ts` | `:109-120` |
| 4 | `VISUALIZE DATA` | `visualizeData` | collapsed | `src/views/visualize_data/VisualizeDataSectionProvider.ts` | `:121-132` |
| 5 | `ANALYSIS` | `analysis` | expanded | `src/code_analysis/views/AnalysisSectionProvider.ts` | `:133-144` |
| 6 | `PYTHON ENV` (status-dependent header) | `pythonEnv` | dynamic | `src/views/python_env/PythonEnvSectionProvider.ts`, items `src/python_env/views/items/pythonEnvItems.ts:51` | `:145-167` |
| 7 | `VISUALIZATION SETTINGS` | `visualizationSettings` | collapsed | `src/views/visualization_settings/VisualizationSettingsSectionProvider.ts` | `:168-179` |
| 8 | `LEARN MORE & SUPPORT` | `learnMore` | expanded | `src/views/learn_more/LearnMoreSectionProvider.ts` | `:180-193` |

View-title actions (both sections share the view): **Refresh** (`codeXR.activeServers.refreshServers`) and **Stop All Servers** (`codeXR.activeServers.stopAllServers`), `package.json:495-506`.

**[A]** `grep -c "sectionName: '" src/views/sectionDefinitions.ts` → 8; `test/analysis/analysisTreeBridge.test.cjs`, `test/analysis/uiPolicy.test.cjs` (locked-UI behaviour).
**[M]** F5 → open the CodeXR view → the 8 headers above appear in this order with the stated expansion state; while the venv is being created only PYTHON ENV and LEARN MORE react to clicks.

### 3.1 SERVERS

| Row | Click → command | Source |
|---|---|---|
| `Server Configuration` (group) | expands to the 6 rows below | `src/views/servers/items/serverItems.ts:41-52` |
| └ `HTTP Mode: <HTTP/HTTPS>` | `codexr.server.config.httpMode` — QuickPick `HTTPS (generated local certificates)` / `HTTPS (custom certificates)` / `HTTP (development only)` | `serverItems.ts:82-92`, choices `src/commands/servers/serverCommands.ts:35-37` |
| └ `Default Port: <n>` | `codexr.server.config.port` (input box with validation) | `serverItems.ts:93-103`, `src/servers/views/interactions/handleConfigurationClicks.ts:109` |
| └ `Auto-Open: Enabled/Disabled` | `codexr.server.config.autoOpen` (toggle) | `serverItems.ts:104-114` |
| └ `Open Mode: <browser/lateralPanel>` | `codexr.server.config.openMode` | `serverItems.ts:115-125` |
| └ `Cross-network connections: Enabled/Disabled` | `codexr.server.config.remoteAccess` (QuickPick Disabled/Enabled, `serverCommands.ts:195-208`) | `serverItems.ts:126-136` |
| └ `Reset to Default` | `codexr.server.config.resetToDefault` (internal) | `serverItems.ts:137-147` |
| `Start Local Server` | `codexr.server.launch` — prompts for an HTML file and serves it (multi-server, dynamic port if busy) | `serverItems.ts:57-71`, `serverCommands.ts:71-160` |

Defaults (`src/servers/storage/serverSettingsManager.ts:36-51`): mode `HTTPS`, certSource `default` (generated), port `3000`, autoOpen `true`, openMode `browser`, remoteAccess `{ enabled: true, provider: 'cloudflare-quick' }` (`src/remote_access/model/remoteAccessModel.ts:38-42`; a one-shot migration flips older saved settings to enabled, `serverSettingsManager.ts:312-326`).

**[M]** Expand Server Configuration → 6 rows with current values; change each and see the label update; Reset restores the defaults above; Start Local Server → pick an `.html` → a new ACTIVE SERVERS row appears.

### 3.2 ACTIVE SERVERS (+ nested COLLABORATION)

Provider `src/views/active_servers/ActiveServersSectionProvider.ts`, items `src/views/active_servers/items/activeServerItems.ts`.

| Row | Click → command | Source |
|---|---|---|
| `No active servers` (placeholder) | — | `activeServerItems.ts:57-63` |
| `COLLABORATION` (group, item type `collaboration-group`) | expands to the collaboration rows (3.2.1) | `activeServerItems.ts:72-78`, `src/views/collaboration/CollaborationSectionProvider.ts` |
| `Stop All Servers` (when ≥1 running) | `codeXR.activeServers.stopAllServers` | `activeServerItems.ts:106-117` |
| `<customName or localhost:port>` (one per server; description Browser/Panel + status) | `codeXR.activeServers.showActions` (QuickPick of the actions below) | `activeServerItems.ts:128-150`, description `:463-468` |
| └ `Local network address` | `codeXR.activeServers.copyLanUrl` (internal) | `activeServerItems.ts:167-176` |
| └ `Cross-network address` (when shared; description = invitation URL) | `codeXR.activeServers.copyRemoteInvitation` | `activeServerItems.ts:180-190` |
| └ `Connected users (N)` → one row per participant (`Name/Role/Avatar/Source/Connection/IP` tooltip) | `codeXR.activeServers.showParticipantDetails` (internal); context menu on a **guest** row: `codeXR.activeServers.removeParticipant` (kick) | `activeServerItems.ts:200-266`, menu `package.json` `view/item/context` #5 |
| └ `Cross-network connection` (group, only when the global cross-network setting is on or a tunnel is live) | `Start remote connection` → `startRemoteAccess`; when shared: `Generate new pairing code` → `regeneratePairingCode` (internal), `View remote status` → `showRemoteStatus` (internal), `Stop remote connection` → `stopRemoteAccess`; on error `View remote error` | `activeServerItems.ts:302-390`, status text `:440-458` |
| └ `Actions` (group) | `Open in browser` (`openInBrowser`), `Open in panel` (`openInPanel`, **only when the server is HTTP**), `Copy address` (`copyUrl`), `Server information` (`showDetails`), `Stop server` (`stopServer`) | `activeServerItems.ts:211-217`, `:393-412` |

Header counter: `ACTIVE SERVERS (N running)` (`sectionDefinitions.ts:92-96`). `codeXR.activeServers.openView` focuses the section.

#### 3.2.1 COLLABORATION rows (`src/views/collaboration/items/collaborationItems.ts:36-77`)

| Row | Description | Click → command |
|---|---|---|
| `Join Remote Session` | "Paste invitation link" | `codeXR.collaboration.joinRemote` |
| `Name` | custom name or `Anonymous` (anonymous users get a Star Wars alias per room, `src/collaboration/model/anonymousName.ts`) | `codeXR.collaboration.selectIdentity` (plus palette-only `codeXR.collaboration.setName`) |
| `Avatar Color` | `Automatic` or one of 6 colours (Azure, Amber, Emerald, Violet, Rose, Slate — `src/collaboration/model/collaborationProfile.ts:22-29`) | `codeXR.collaboration.selectAvatar` |
| `3D Model` | `Included` / `Procedural avatar` | `codeXR.collaboration.showAvatarModelInfo` |

**[A]** `test/collaboration/avatarIdSync.test.cjs`, `test/servers/collaborationRoomServer.test.cjs`, `test/servers/remoteAccessImplementation.test.cjs`.
**[M]** Launch any analysis → its server row appears; expand it → the 4 groups; Actions → each of the 5 actions works (Open in panel only listed under HTTP mode); open the scene in two browsers → `Connected users (2)`; right-click the guest → Remove from Session → that browser shows the "removed" screen; Stop server → row disappears.

### 3.3 BABIA EXAMPLES

Items `src/views/babia_examples/items/babiaExampleItems.ts`; examples discovered under `examples/charts/` (`src/babia_examples/runtime/exampleLauncher.ts:37-51`).

| Row | Click → command |
|---|---|
| `About BabiaXR` ("Credits & license") | `codeXR.babiaExamples.showLibraryInfo` (`babiaExampleItems.ts:57-66`) |
| one row per example (7 folders: `bar-chart`, `barsmap`, `bubble-chart`, `cylinder-chart`, `cylindermap-chart`, `mix`, `pie` — 8 HTML files incl. `pie/population.html`; data in `examples/data/*.json`, 6 files) | `codeXR.babiaExamples.launchExample` (`:96`) — serves the example on a new server |
| `No examples found` / `Error loading examples` | placeholders (`:40`, `:75`) |

Palette-only: `codeXR.babiaExamples.refresh`, `.openFolder`, `.showDetails`, `.openView`.
**[A]** `find examples -type f | wc -l` → 14. **[M]** expand → 7+ example rows; click Bar Chart → browser opens a BabiaXR scene.

### 3.4 VISUALIZE DATA ("visualize your own JSON")

Items `src/visualize_data/views/items/visualizeDataItems.ts`, state `src/visualize_data/state/visualizeDataState.ts` (workspaceState `visualizeDataState`).

| Row | Click → command | Source |
|---|---|---|
| `Chart Type` | `codeXR.visualizeData.chartType` (QuickPick from `BabiaChartRegistry`, 8 charts) | `visualizeDataItems.ts:97-105` |
| `Select JSON File` | `codeXR.visualizeData.selectJson` | `:112-120` |
| `Dimension Mapping` (group; "Not available" until chart + JSON chosen) → one row per dimension | `codeXR.visualizeData.mapDimensionField` (internal); palette `codeXR.visualizeData.dimensionMapping` | `:165-192`, `:263` |
| `Launch Visualization` | `codeXR.visualizeData.launchVisualization` (writes to `<globalStorage>/visualize-data/`, serves it) | `:130-140`, `src/visualize_data/views/interactions/visualizationLauncher.ts:387` |
| `Browse Visualizations` (group) → stored visualizations + reset row | `codeXR.browseVisualizations.launch`, `codeXR.browseVisualizations.resetAll` (internal) | `:147-152`, `src/visualize_data/views/items/visualizationItem.ts:90,112` |

**[A]** `test/visualize_data/visualizeDataModel.test.cjs`. **[M]** pick `bars` + `examples/data/sales.json` → map dimensions → Launch → scene opens; it then appears under Browse Visualizations and relaunches from there; restored after reloading the window.

### 3.5 ANALYSIS

`src/code_analysis/views/AnalysisSectionProvider.ts:90-125` returns four subsections:

1. **`Active Analyses (N)`** (`src/code_analysis/views/subsections/active_analyses/services/activeAnalysesDataService.ts:467-490`): one row per running analysis session; click → `codeXR.analysis.activeAnalyses.showActions` (QuickPick: View Details / Open in Browser / Export Analysis Folder / Close Analysis, `activeAnalysesCommands.ts:146-177`); the same four as right-click entries (`package.json` `view/item/context` #1-4, contextValue `activeAnalysis.<status>` with status ∈ creating/analyzing/monitoring/completed/error/failed). Palette: `codeXR.analysis.activeAnalyses.refresh`.
2. **`Analysis Settings`** (`analysisSettingsSubsectionProvider.ts:57-127`, 11 rows, all internal tree-item commands; persisted by `AnalysisConfigurationStorage`, defaults `src/code_analysis/configuration/models/analysisConfiguration.ts:124-156`):

| # | Row label | Command | Values | Default |
|---|---|---|---|---|
| 1 | `Analysis File with Immersive VR/AR` / `… Standard Experience` | `codeXR.analysis.toggleAnalysisFileMode` | `XR` / `LivePanel` | `XR` |
| 2 | `Analysis Directory with [Deep] Immersive VR/AR` / `… [Deep] Standard Experience` | `codeXR.analysis.selectAnalysisDirectoryMode` | `XR`, `XRDeep`, `LivePanel`, `LivePanelDeep` | `XR` |
| 3 | `Visual Theme: Dark Mode / Light Mode` | `codeXR.analysis.toggleViewTheme` | `Dark` / `Light` | `Dark` |
| 4 | `Chart Type (File): <name>` | `codeXR.analysis.selectChartTypeFile` | 8 chart ids | `boats` |
| 5 | `Chart Type (Directory): <name>` | `codeXR.analysis.selectChartTypeDirectory` | 8 chart ids | `boats` |
| 6 | `Dimension Mapping (File)` (group, one row per chart dimension `<dim>: <field>`) | `codeXR.analysis.selectDimensionMappingFile` | fields from XR file schema (13) | area=`parameters`, height=`lineCount`, color=`complexity` |
| 7 | `Dimension Mapping (Directory)` (group) | `codeXR.analysis.selectDimensionMappingDirectory` | fields from XR directory schema (25) | area=`functionCount`, height=`totalLines`, color=`cyclomaticComplexityNumber` |
| 8 | `Debounce Time: <Real-time/1 second/3/5/10 seconds/Nms custom>` | `codeXR.analysis.selectAutoAnalysisDelay` | `RealTime`(0), `1s`, `3s`, `5s`, `10s`, `Custom` (0-20000 ms, `autoAnalysisDelayCommands.ts:136-146`) | `RealTime` |
| 9 | `Auto-Analysis: Enabled/Disabled` | `codeXR.analysis.toggleAutoAnalysisEnabled` | boolean | `true` |
| 10 | `Files by Language Sorting` (group: `Language Groups Primary`, `Language Groups Secondary`, files sorting) | `codeXR.analysis.selectLanguageGroupPrimarySorting`, `…SecondarySorting`, `codeXR.analysis.selectFilesSorting` | alphabetical/fileCount × asc/desc; files alphabetical/lastModified | alpha asc; secondary fileCount desc; files alpha asc |
| 11 | `Profile Configuration` (group: `Reset to Defaults`, `Save Profile`, `Load Profile`, `Delete Profile`) | `codeXR.analysis.resetToDefaults`, `.saveProfile`, `.loadProfile`, `.deleteProfile` | named profiles under `<globalStorage>/codexr_analysis…` | — |

   Also persisted: `xrBabiaUi.visibleByDefault = true` (no tree row). When the schema is not available the mapping groups show `Python Environment Not Ready` (`dimension_mapping_shared/…:290-292`).
3. **`Project Structure - <workspace name>`** (`src/code_analysis/views/subsections/project_by_language/projectByLanguageSubsectionProvider.ts:31-125`): the workspace tree; a directory row → `codeXR.analysis.projectStructure.analyzeDirectory` (runs with the **Directory mode** setting, `projectByLanguageCommands.ts:145-160`), a file row → `codeXR.analysis.projectStructure.analyzeFile`. `No workspace folder open` placeholder.
4. **`Files by Language`** (`src/code_analysis/views/subsections/files_by_language/filesByLanguageSubsectionProvider.ts:35-126`): one group per supported language (icons from `resources/languages_icons/color/`) + `Unsupported Files`; a file row → `codeXR.analysis.runAndAnalyzeFile` (uses the **File mode** setting). Backed by `WorkspaceSnapshotService` with a `createFileSystemWatcher` (`src/code_analysis/services/workspaceSnapshotService.ts:170`) and the workspaceState cache.

**[A]** `test/analysis/activeAnalysesActions.test.cjs`, `test/analysis/dimensionMappingShared.test.cjs`, `test/analysis/workspaceSnapshotModel.test.cjs`, `test/analysis/analysisTreeBridge.test.cjs`.
**[M]** Each of the 11 settings rows: click, change, label updates, value survives a window reload; Save/Load/Delete/Reset profile round-trip; Files by Language lists languages with counts and re-sorts on setting change; clicking a file runs the analysis in the configured file mode; Project Structure directory click runs the configured directory mode.

### 3.6 PYTHON ENV

Rows depend on the venv state (`src/python_env/views/items/pythonEnvItems.ts:51-240`):

| State | Rows (→ command) |
|---|---|
| installing | `Installing virtual environment...` (In progress) |
| error | `Python environment setup failed` + `Retry Python environment installation` (→ `codeXR.pythonEnv.reinitialize`, enabled by `retryAvailable`) + `Show Python environment status` (→ `status`) |
| missing | `No Python environment configured` + `Create Python environment` (→ `codeXR.pythonEnv.create`) |
| invalid | `Python environment exists but is invalid` + `Repair Python environment` (→ `reinitialize`) |
| ready | `Python environment ready` + `Show Python environment status` (→ `status`) + `Verify installation` (→ `verifyInstallation`) + `Reinitialize Python environment` (→ `reinitialize`) |

Palette-only: `codeXR.pythonEnv.delete`, `codeXR.pythonEnv.debugFailInstallation` (to be hidden, R3).
**[M]** fresh profile → section shows installing → ready; Verify installation reports lizard + tree-sitter-language-pack versions; Delete → missing state → Create → ready.

### 3.7 VISUALIZATION SETTINGS

Rows from `src/visualization_settings/model/settingsModel.ts:139-165` (+ reset row `src/views/visualization_settings/items/visualizationSettingsItems.ts:55-63`), each → `codeXR.visualizationSettings.configure` (internal); reset → `codeXR.visualizationSettings.resetAll`.

| Setting | Values | Default (`settingsModel.ts:57-62`) |
|---|---|---|
| Background Color | colour (presets incl. white/black/pink; colour-picker webview `templates/utils/color-picker.html`, `src/visualization_settings/utils/colorPickerUtils.ts:11,43`) | `#FFFFFF` |
| Ground Color | colour | `#000000` |
| Environment Preset | 12 presets: none, default, forest, egypt, dream, volcano, arches, tron, japan, threetowers, poison, contact (`settingsModel.ts:76-89`) | `default` |
| Chart Palette | 9 palettes: ubuntu, blues, bussiness, commerce, flat, foxy, icecream, pearl, sunset (`:94-104`) | `ubuntu` |

These feed the `${BACKGROUND_COLOR}`, `${GROUND_COLOR}`, `${ENVIRONMENT_PRESET}` placeholders of `templates/xr/file/xr-visualization.html`.
**[A]** `test/visualization_settings/settingsStorage.test.cjs`. **[M]** change each setting, launch an XR analysis, see the change; Reset restores defaults.

### 3.8 LEARN MORE & SUPPORT (`src/views/learn_more/items/learnMoreItems.ts:46-90`)

| Row | Command | Opens |
|---|---|---|
| `Open Documentation Website` | `codeXR.learnMore` | `https://code-xr.adrianmonteslinares.com/` (`src/learn_more/commands/learnMoreCommands.ts:5`) |
| `Meet the Creator` | `codeXR.openAuthorWebsite` | `https://adrianmonteslinares.com/` (`:7`) |
| `Support CodeXR (Buy Me a Coffee)` | `codeXR.supportDeveloper` | `https://buymeacoffee.com/adrianadyrx` (`:8`) |

**[M]** each row opens the external URL.

## 4. Analysis modes

### 4.1 Shared pipeline

Command → `src/code_analysis/commands/**` → launcher (`src/code_analysis/engine/launchers/launcherXRAnalysis.ts:128,161`, `launcherLivePanel.ts:24,62`, `launcherVisualizeDOM.ts:15`) → `executeLaunchPipeline` (`launchPipeline.ts:79`) creates a `UnifiedAnalysisSession` → `executePython.ts` runs the managed venv against `backend/src/main.py` → parser (`engine/parsers/fileXRParser.ts`, `directoryXRParser.ts`, `livePanelParser.ts`, `visualizeDOMParser.ts`) fills the template and injects runtimes → `serverLaunchOrchestrator.ts` / `sessionServerManager.ts` start a server (always the shared `MultiServerLauncher` → `HttpServer` path) → server registered in the Active Servers registry and the session in Active Analyses → `SessionWatcherManager.startWatchingSession` (`launcherXRAnalysis.ts:150,184`, `launcherLivePanel.ts:54,94`, `launcherVisualizeDOM.ts:38`).

Per-mode optional server features (`src/servers/runtime/analysisServerCapabilities.ts:38-55`):

| Analysis mode | Dependency graph | Historical comparison | Project evolution |
|---|---|---|---|
| `XR` | yes | yes | yes |
| `LivePanel` | yes | yes | no |
| `VisualizeDOM` | no | no | no |

**[A]** `test/analysis/analysisServerCapabilities.test.cjs`, `test/analysis/analysisModeMegatest.test.cjs`, `test/analysis/analysisPaths.test.cjs`, `test/analysis/analysisNamespace.test.cjs`, `test/analysis/directoryAnalysisStartup.test.cjs`.

### 4.2 The 11 analysis entry points

All are contributed, reachable from the `Code-XR: Analysis` submenu (Explorer + editor context), the palette, and (for some) tree rows; each records itself as "last kind" so its `runLast` twin appears at the top of the context menu.

| Kind | Command | Python call | Template / output | Trigger surfaces |
|---|---|---|---|---|
| File · LivePanel | `codeXR.analysis.analyzeFile` | `--mode livePanel --type file` (`executePython.ts:120-130`) | `templates/analysis_livePanel/file/` | submenu (metric ext), palette, Files by Language row when File mode = LivePanel |
| File · XR | `codeXR.analysis.analyzeFileXR` | `--mode xr --type file` (`:192-213`) | `templates/xr/file/xr-visualization.html` | submenu (metric ext), palette, Files by Language row when File mode = XR (default) |
| Directory · LivePanel | `codeXR.analysis.analyzeDirectory` | `--mode livePanel --type directory` (`:150-171`) | `templates/analysis_livePanel/directory/` | submenu (folder), palette, Project Structure dir row |
| Directory · LivePanel Deep | `codeXR.analysis.analyzeDirectoryDeep` | same + `--deep` (`:171`) | idem | idem |
| Directory · XR | `codeXR.analysis.analyzeDirectoryXR` | `--mode xr --type directory` | `xr-visualization.html` | submenu (folder), palette, Project Structure dir row |
| Directory · XR Deep | `codeXR.analysis.analyzeDirectoryXRDeep` | same + `--deep` (`:213`) | idem | idem |
| Project · LivePanel | `codeXR.analysis.analyzeProject` | directory analysis of the workspace root | LivePanel directory | submenu (any), palette |
| Project · LivePanel Deep | `codeXR.analysis.analyzeProjectDeep` | + `--deep` | idem | idem |
| Project · XR | `codeXR.analysis.analyzeProjectXR` | XR directory analysis of the workspace root | XR | idem |
| Project · XR Deep | `codeXR.analysis.analyzeProjectXRDeep` | + `--deep` | XR | idem (also the default "last kind", `AnalysisCommands.ts:11`) |
| DOM (HTML) | `codeXR.analysis.visualizeDOM` | `html/html_dom_parser.py <file>` (`executePython.ts:303-315`) | `templates/xr/html/dom-visualization-template.html` | submenu (`.html .htm .xhtml`), palette |

"Deep" = recursive into sub-directories; non-deep analyses the directory's own files. Before an XR launch the dimension mapping is validated against the Python field schema (`launcherXRAnalysis.ts:25-127`, `src/babia_templates/processing/dimensionValidator.ts`).

**[M]** For each of the 11 kinds on a sample workspace (e.g. `manual_test/`): run it from the context menu → progress notification → browser (or side panel, per Open Mode) shows the scene/panel → Active Analyses gains a row → ACTIVE SERVERS gains a server → right-click again shows "Run Last: <kind>" at the top and re-runs it.

### 4.3 XR analysis (file / directory / project)

- Scene: A-Frame 1.7.1 + aframe-extras 7.5.4 + aframe-babia-components 1.3.4 + aframe-environment-component 1.5.0 + geometry-merger 2.0.1 loaded from CDNs (`templates/xr/file/xr-visualization.html:8-20`); `xr-mode-ui="enabled: true; XRMode: xr"` (`:28`) = enter-VR and enter-AR buttons.
- Placeholders filled by `src/babia_templates/processing/` (`${TITLE}`, `${DATA_SOURCE}`, `${CHART_COMPONENT}`, `${CHART_BASE_CONFIG}`, `${TREE_BUILDER}`, `${BABIA_UI_SCRIPT}`, `${BABIA_UI_COMPONENT}`, `${BACKGROUND_COLOR}`, `${GROUND_COLOR}`, `${ENVIRONMENT_PRESET}`).
- Scene entities: room, rig with `movement-controls` + `codexr-immersive-rig`, `codexr-pointer-policy`, `codexr-ar-fill-light`, `codexr-analysis-table` / `#codexrAnalysisSurface`, `codexr-analysis-mode`, `codexr-logo`, `codexr-multi-screen-manager`, `codexr-broadcast`, chart base config `#codexr-chart-base-config`.
- Data: `data.json` produced by Python; chart = configured chart type (default Babia boats) with the configured dimension mapping; in-scene Field Mapping panel can switch chart and mapping live (runtime `xr-chart-mapping-ui`).
- Live reload: `templates/xr/sse/live_sse_fileXR.js` injected by `fileXRParser.ts:121` / `directoryXRParser.ts:136`.
- In-room extras: guide screen, virtual screens, collaboration, avatars (section 7).

**[A]** `test/analysis/xrDataSource.test.cjs`, `xrFieldSchemaIntegration.test.cjs`, `babiaChartDimensionContract.test.cjs`, harnesses `npm run test:xr-harness`, `test:xr-mode-harness`, `test:xr-immersive-harness`.
**[M]** File XR on `manual_test/python_metrics.py` → boats chart of functions; Directory XR Deep on `manual_test/` → one element per file; Enter VR / Enter AR buttons visible (WebXR emulator per `docs/xr-testing/WEBXR_EMULATOR_TUTORIAL.md`, checklist `docs/xr-testing/XR_MANUAL_CHECKLIST.md`).

### 4.4 LivePanel analysis (file / directory, deep or not)

- 2D HTML panel served by the same server: `templates/analysis_livePanel/file/fileAnalysis{.html,main.js,style.css}` and `…/directory/directoryAnalysis{.html,main.js,style.css}`, prefixed by the 5 shared components in `templates/components/livepanel/` bundled alphabetically by `src/code_analysis/engine/parsers/livePanelParser.ts` (data table, charts, dependency summary panel, historical panel, panel shell with theme toggle + SSE status indicator).
- Opens in the browser or the VS Code side panel (`src/servers/runtime/previewRenderer.ts:64` webview) depending on Open Mode; the panel option forces HTTP (`httpsOverridden`, `serverCommands.ts:136-139`).
- The view theme setting (Dark/Light) applies here.
- Dependency summary and historical comparison are available in LivePanel too (capability table above).

**[A]** `test/analysis/livePanelBundle.test.cjs`, `livePanelDomIntegration.test.cjs`, `livePanelHistorical.test.cjs`, `directoryLivePanelUi.test.cjs`. **[M]** run LivePanel file + directory (deep and not) → table sortable, charts render, theme toggle works, SSE status indicator is "live"; edit a file → panel refreshes.

### 4.5 DOM visualization (HTML)

- Backend `backend/src/html/html_dom_parser.py` (argv `<file>`) → DOM tree JSON; scene `templates/xr/html/dom-visualization-template.html`; live reload `templates/xr/sse/live_sse_fileDOM.js`; collaboration glue `codexrDomSceneCollaborationRuntime.js`. No dependency/historical/evolution capability.
- `templates/xr/html/htmlLiveReload.js` is unreferenced (removal authorized, R6).

**[A]** `npm run test:htmlanalysis`, `backend/tests/html_dom/test_html_dom_protocol.py`, `test/analysis/domSceneTemplateContract.test.cjs`. **[M]** right-click `manual_test/html_dom_fixture.html` → Visualize DOM → 3D DOM tree; edit the HTML → scene updates.

### 4.6 In-scene analysis modes (XR controller "Visualization mode")

Mode switching is owned by `codexr-analysis-mode` (`templates/components/codexr/analysis-mode/`) and arbitrated server-side by `src/servers/runtime/analysis/analysisMessageRouter.ts:46-128` (messages `analysis-mode-selection`, `analysis-mode-activate`), which publishes the authoritative `analysis-view` entity. Modes: `single` (normal analysis), `dependency-graph`, `historical-compare`, `project-evolution`.

#### 4.6.1 Dependency graph

- Backend: `main.py --mode dependencies --type directory|file` (`executePython.ts:34-48`) → `backend/src/utils/dependency_analysis_engine.py` (`analyze_dependencies` `:656`, `analyze_file_dependencies` `:377`; relations `import, include, require, inheritance, implementation, call, contains` `:21`; confidence exact/best-effort `:24-37`; Tarjan cycles `:574`; private cache `CACHE_VERSION = 3` `:22`; `--dependency-refresh` selective reanalysis; `--project-root` file scope) using `tree-sitter-language-pack` 1.8.1.
- Extension: `src/code_analysis/dependencies/dependencyGraphService.ts`, bridge `src/servers/runtime/analysis/dependencyGraphBridge.ts`, endpoint `/api/dependency-graph/summary` (`httpServer.ts:481`), WS messages `dependency-graph-settings`, `dependency-file-scope-request`, `dependency-graph-start` (`analysisMessageRouter.ts:53-59`).
- Runtime: `codexr-dependency-graph` — 3 layouts (`force-3d`, `hierarchical`, `metric-space`) computed in a Web Worker, render budget 600 nodes / 2,000 edges with group mode + drill-down, node size/height/color and X/Z metric remapping, metric axes, selection highlighting, edge encoding, hidden external dependencies, hierarchical exploration, file dependency scope, animated reconciliation (`docs/features/DEPENDENCY_GRAPH_XR.md:109-476`); visual density budget runtime.
- LivePanel: `templates/components/livepanel/dependencySummaryPanel.js`.

**[A]** `test/analysis/dependencyGraph.test.cjs`, `backend/tests/dependencies/test_dependency_analysis.py`, `test_dependency_golden.py`. **[M]** XR directory analysis → Visualization mode → Dependency graph → graph appears; switch the 3 layouts; click a node → neighbourhood highlighted; back to Normal analysis.

#### 4.6.2 Historical comparison

- Compares the working copy, local branches, remote-tracking branches, tags and the 50 most recent commits, side by side on the table, without checkout/fetch or writes in `.git` (`docs/features/HISTORICAL_COMPARISON_XR.md:3-21`). Git via `execFile` (`src/code_analysis/historical/gitRepositoryService.ts`), service `historicalComparisonService.ts`, bridge `src/servers/runtime/analysis/historicalComparisonBridge.ts`; endpoints `/api/historical/references`, `/api/historical/compare` (`httpServer.ts:485-489`); WS `historical-comparison-references-request`, `historical-comparison-start` (`analysisMessageRouter.ts:66-69`); reactive working copy; babia-boats `codexr-left:`/`codexr-right:` id isolation. Disabled (with reason) outside a Git repo.
- Runtime `historicalComparisonRuntime` (+ shared `codexrGitRefPickerRuntime` in `compare` mode); LivePanel `historicalPanel.js|css`.

**[A]** `test/analysis/historicalComparison.test.cjs`, `historicalComparisonRuntime.test.cjs`, `offlineHistoricalDelta.test.cjs`, `gitRefPickerRuntime.test.cjs`. **[M]** XR analysis inside a git repo → Historical comparison → pick working copy vs a tag/commit → two charts with deltas; edit a file → working-copy side refreshes.

#### 4.6.3 Project evolution (XR only)

- Chronological "movie" of git history on one full-table chart: Auto / Range / Manual timelines, sampled to bounded frames, optional working-copy final frame, play/pause, prev/next, speed presets, overlay (revision/date/frame), `Clear movie` for everyone (`docs/features/PROJECT_EVOLUTION_XR.md:9-55`). Service `src/code_analysis/historical/projectEvolutionService.ts`, sampler `gitTimelineSampler.ts`, bridge `src/servers/runtime/analysis/projectEvolutionBridge.ts`; WS `project-evolution-references-request`, `-clear`, `-apply-frame`, `-start` (`analysisMessageRouter.ts:72-81`). Disabled outside a Git repo.
- Runtime `projectEvolutionRuntime` (+ git-ref picker in `sequence` mode).

**[A]** `test/analysis/projectEvolutionRuntime.test.cjs`, `npm run test:project-evolution-harness`. **[M]** XR analysis in a git repo → Project evolution → Generate automatic movie → frames play; Range and Manual pickers; Clear movie resets all clients.

### 4.7 Export Analysis Folder (offline bundle)

- Command `codeXR.analysis.activeAnalyses.exportFolder` (`src/code_analysis/views/subsections/active_analyses/commands/activeAnalysesCommands.ts:303-420`): multi-select QuickPick built from the session's capabilities — `Normal analysis` (always), `Dependency graph`, `Historical comparison`, `Project evolution` (`src/code_analysis/export/exportModeSelection.ts:36-68`); for the git modes, scope `Entire Git history — N commits` or `Only the latest N commits…`, then performance `Balanced` / `Maximum speed` worker counts; then destination folder.
- Writes a self-contained copy with `codexr-export-manifest.json` (`kind: 'codexr-export'`, capabilities, `entities`, optional `gitData`) (`src/code_analysis/export/exportManifest.ts`), transactional copy (`exportPackageTransaction.ts`), per-revision payloads precomputed by a Python worker pool (`gitExportPythonWorkerPool.ts` → `backend/src/export/git_export_analysis_worker.py`, JSON-lines protocol `ready/analyze/complete/error/shutdown`).
- Offline boot: the collaboration runtime falls back to the manifest when `/api/collaboration/session` fails, no WebSocket opened; historical + evolution run locally from `gitData` (`templates/components/COMPONENTS.md:97-119`).

**[A]** `test/analysis/exportManifest.test.cjs`, `exportPackageTransaction.test.cjs`, `gitRevisionExporter.test.cjs`, `backend/tests/git_export/test_git_export_analysis_worker.py`. **[M]** Export an XR analysis with all four modes → open the exported `index.html` from a static server → scene boots in Normal analysis (not evolution), dependency graph, historical comparison and project evolution all work offline.

### 4.8 Automatic re-analysis (watchers)

| Piece | Behaviour | Source |
|---|---|---|
| `SessionWatcherManager` | one watcher per session, replaced on relaunch, stopped on close | `src/code_analysis/engine/watchers/sessionWatcherManager.ts:20-40` |
| `FileWatcherOrchestrator` | `fs.watch` on the file's parent dir, hash-checked (`fileHashTracker.ts`), debounced | `fileWatcherOrchestrator.ts:50-83` |
| `DirectoryWatcherOrchestrator` | `fs.watch` per directory, snapshot diff (`directorySnapshot.ts`), incremental re-analysis of changed files via `summaryFiles/file_reanalysis_coordinator.py` (`directoryReAnalyzer.ts:45,189`, `executePython.ts:337-346`) | `directoryWatcherOrchestrator.ts:284-312` |
| Debounce / enable | reads **Auto-Analysis** (on/off) and **Debounce Time** (RealTime 0 ms, 1/3/5/10 s, Custom ≤ 20,000 ms) live | `debounceManager.ts:56-62`, `configurationConverter.ts:13-31` |
| Push to clients | `sseNotificationManager.ts:16-90` (`notifyServerStarted/Stopped/AnalysisUpdated/FileChanged`) → `src/servers/runtime/sse/SSEManager.ts` → `GET /events` (`httpServer.ts:405`) → SSE client scripts | |
| Watcher extension set | directory watcher admits the 48 contract extensions + 16 more, never HTML | `src/code_analysis/engine/watchers/analysisFilePolicy.ts:69`, pinned by `test/analysis/watcherExtensionContract.test.cjs:195-253` |
| Dependency graph / historical live refresh | on analysis update the bridges refresh (selective dependency reanalysis, working-copy side) | `src/servers/runtime/analysis/analysisFeatureHost.ts` |

**[A]** `test/analysis/reanalysisArchitecture.test.cjs`, `analysisRefreshCoordinator.test.cjs`, `fileHashTrackerRuntime.test.cjs`, `directorySnapshotRuntime.test.cjs`, `test/directory_analysis/directoryReanalysisData.test.cjs`, `watcherExtensionContract.test.cjs`.
**[M]** With Auto-Analysis on and Debounce = Real-time, save a change in an analysed file → XR scene and LivePanel update without reload; set 5 s → update arrives ~5 s later; turn Auto-Analysis off → no update; directory analysis: add/delete a file → element added/removed.

### 4.9 Analysis settings involved

File mode, Directory mode, View theme, Chart type (file/dir), Dimension mapping (file/dir), Debounce time, Auto-analysis, Files-by-language sorting, profiles — see table in 3.5 (defaults `src/code_analysis/configuration/models/analysisConfiguration.ts:124-156`). Visualization settings (3.7) also shape XR scenes. Server Open Mode / HTTP mode (3.1) decide where and how the result opens.

### 4.10 Startup work (deferred, `src/extension.ts:59-110`, `StartupCoordinator` max 3 concurrent)

1. `restore-server-settings`: load settings + ensure the generated HTTPS key pair.
2. `initialize-server-watcher-integration`: `ServerWatcherIntegration.initialize`.
3. `initialize-python-env`: create/verify venv, prefetch the XR field schema, refresh PYTHON ENV and ANALYSIS.
4. `cleanup-stale-analysis-artifacts`: `CleanAnalysisCommands.executeStartupCleanup` (must survive the removal of the `codeXR.analysis.cleanAnalysis` command, W2-47).

`deactivate()` stops remote access, cleans the server registry, SSE manager and file map (`src/extension.ts:113+`).
**[A]** `test/startup/startupCoordinator.test.cjs`. **[M]** reload window → no error toast; Output › CodeXR shows the four tasks completing.

## 5. Supported languages

Sources of truth: **Python** `backend/src/utils/metric_language_contract.py:14-38` (`_LANGUAGE_SPECS`) and the DOM-only map `:40-42`; **TypeScript** `src/utils/supportedLanguages.ts` (analysis table, what the engine accepts) and `src/utils/languageMetadata.ts:16-41` (tree labels/icons). Other copies that must stay in sync: the 48-extension regex in 6 `package.json` menu `when` clauses (1.4), `src/views/common/supportedLanguages.ts`, `src/code_analysis/engine/watchers/analysisFilePolicy.ts:69`, `src/code_analysis/engine/watchers/directoryReanalysisData.ts:256`, the dependency `CAPABILITIES` list `backend/src/utils/dependency_analysis_engine.py:24-37`, and the icons in `resources/languages_icons/color/` (26 SVGs, shipped).

| # | Language | Metric extensions (Python contract) | Extra extensions labelled by `languageMetadata.ts` only | Dependency graph | Fixture `manual_test/` |
|---|---|---|---|---|---|
| 1 | Python | `.py .pyw .pyi` | | yes | `python_metrics.py` |
| 2 | Ruby | `.rb .rbw` | | yes | `ruby_metrics.rb` |
| 3 | Java | `.java` | | yes | `java_metrics.java` |
| 4 | C | `.c .h` | | yes | `c_metrics.c` |
| 5 | C++ | `.cpp .cxx .cc .hpp .hxx` | `.c++ .hh .h++` (labelled, not analysed — known divergence pinned by `test/utils/languageTables.test.cjs:147`) | yes | `cpp_metrics.cpp` |
| 6 | C# | `.cs` | | yes | `csharp_metrics.cs` |
| 7 | Erlang | `.erl .hrl` | | yes | `erlang_metrics.erl` |
| 8 | Fortran | `.f90 .f95 .f03 .f08 .f` | | yes | `fortran_metrics.f90` |
| 9 | GDScript | `.gd` | | yes | `gdscript_metrics.gd` |
| 10 | Go | `.go` | | yes | `go_metrics.go` |
| 11 | JavaScript | `.js .mjs .cjs` | | yes | `javascript_metrics.js` |
| 12 | Kotlin | `.kt .kts` | | yes | `kotlin_metrics.kt` |
| 13 | Lua | `.lua` | | yes | `lua_metrics.lua` |
| 14 | Objective-C | `.m .mm` | | yes | `objectivec_metrics.m` |
| 15 | PHP | `.php .phtml .php3 .php4 .php5` | | yes | `php_metrics.php` |
| 16 | Perl | `.pl .pm` | | yes | `perl_metrics.pl` |
| 17 | Scala | `.scala .sc` | | yes | `scala_metrics.scala` |
| 18 | Solidity | `.sol` | | yes | `solidity_metrics.sol` |
| 19 | Swift | `.swift` | | yes | `swift_metrics.swift` |
| 20 | TypeScript | `.ts .tsx` | | yes | `typescript_metrics.ts`, `typescript_component.tsx` |
| 21 | TTCN-3 | `.ttcn .ttcn3` | | yes | `ttcn_metrics.ttcn3` |
| 22 | Vue | `.vue` | | yes | `vue_metrics.vue` |
| 23 | Zig | `.zig` | | yes | `zig_metrics.zig` |
| — | HTML (DOM-only) | `.html .htm .xhtml` (DOM visualization only, never metrics) | | no | `html_dom_fixture.html`, `html_dom_advanced_analysis.html` |

**Counts:** 23 metric languages, 48 metric extensions (`SUPPORTED_METRIC_EXTENSIONS`, `:54`), 1 DOM-only language with 3 extensions; `languageMetadata.ts` lists 24 entries (23 + HTML) with 51 + 3 extensions; dependency graph 23 languages. Known, pinned divergences (record-only for 1.3.0, must **not** silently change in a cleanup): the 3 C++ label-only extensions and two icon ids that differ between the two TS tables (`languageTables.test.cjs:147-188`); the directory watcher admits exactly 16 extensions beyond the contract (`watcherExtensionContract.test.cjs:195-213`).

Metrics produced (field schema, `backend/src/utils/xr_field_schema.py`, `XR_SCHEMA_VERSION = 1` `:8`): **13 file fields** (`:29-43`: functionName, lineStart, lineEnd, lineCount, spanLines, complexity, complexityBand, parameters, maxNestingDepth, cyclomaticDensity, filePath, fileName, treePath) and **25 directory fields** (`:46-72`: fileName, filePath, relativePath, language, totalLines, codeLines, commentLines, blankLines, commentRatio, codeRatio, blankRatio, classCount, functionCount, maxComplexity, cyclomaticComplexityNumber, cyclomaticComplexityDensity, highComplexityFunctions (>10), criticalComplexityFunctions (>25), averageFunctionParameters, maxFunctionParameters, averageFunctionLines, maxFunctionLines, averageFunctionNestingDepth, maxFunctionNestingDepth, fileSizeBytes). Engines: Lizard 1.17.31 (`backend/src/tools/lizard_analyzer.py`), class counter, Python comment analyzer.

**[A]**
- `python3 -B -c "import sys; sys.path.insert(0,'backend/src/utils'); import metric_language_contract as m; c=m.get_metric_language_contract(); print(len(c), sum(map(len,c.values())))"` (from the repo root) → `23 48`.
- `npm test` → `test/utils/languageTables.test.cjs` (6 tests), `test/analysis/watcherExtensionContract.test.cjs` (8 tests), `test/packaging/resourceConsumers.test.cjs`, `test/analysis/xrFieldSchemaIntegration.test.cjs`.
- `npm run test:python` → `backend/tests/xr_schema/test_xr_schema.py` (pins 13/25), `backend/tests/analyzers/test_analyzer_extension_coverage.py`, `backend/tests/dependencies/*`.
- `npm run test:analysis` → per-language end-to-end over `manual_test/` (24 language fixtures + `deep/`), asserting XR and LivePanel produce identical `data.json`.

**[M]** Files by Language lists all languages present in a workspace containing `manual_test/`, each with its coloured icon; the `Code-XR: Analysis` file entries appear for every extension in the table and not for e.g. `.rs` or `.hh`.

## 6. Servers, collaboration, remote access, data, settings, Python env

### 6.1 Local HTTP/HTTPS servers

| Capability | Detail | Source |
|---|---|---|
| Modes | `HTTPS (generated local certificates)` (default), `HTTPS (custom certificates)` (user cert + key paths, prompted at launch), `HTTP (development only)` | `src/commands/servers/serverCommands.ts:35-56,107`; `src/servers/runtime/httpsDefaultServer.ts`, `httpsCustomServer.ts`, `httpServer.ts` |
| Generated certificate pair | ensured at startup under `<globalStorage>/server-certs/` | `src/servers/runtime/generatedHttpsCertificateManager.ts:26,48`; `src/extension.ts:70-77` |
| Multi-server | any number of concurrent servers; busy port → next free port, user told "Port changed from X to Y" | `src/servers/runtime/multiServerLauncher.ts`, `portManager.ts`, `serverCommands.ts:114-143` |
| Lateral-panel open mode | opens in a VS Code webview; HTTPS is overridden to HTTP for that launch | `src/servers/runtime/previewRenderer.ts:64`, `serverCommands.ts:136-139` |
| Auto-open | opens browser/panel after launch when enabled | server settings `launch.autoOpen` |
| Static serving | pages, MIME, path-traversal guard, `no-store` | `src/servers/runtime/http/staticAssets.ts`, `httpRespond.ts` |
| HTTP routes | `/` and `/index.html` (scene), `/join…` (remote pairing page), `/health`, `/events` (SSE), `/api/*` | `src/servers/runtime/httpServer.ts:384-411` |
| API endpoints (12) | `/api/status`, `/api/config`, `/api/collaboration/session`, `/api/collaboration/avatar-model`, `/api/remote/pair/request`, `/api/remote/identity`, `/api/remote/pair/confirm`, `/api/remote/browser`, `/api/remote/profile`, `/api/dependency-graph/summary`, `/api/historical/references`, `/api/historical/compare` (+ 404 default) | `httpServer.ts:433-493` |
| WebSocket endpoints (2) | `/codexr-room` (collaboration room), `/codexr-broadcast` (screen broadcast signalling) | `httpServer.ts:544`, `:565` |

**[A]** `test/servers/httpsCertificates.test.cjs`, `test/analysis/analysisServerCapabilities.test.cjs`; grep check: `grep -c "case '/" src/servers/runtime/httpServer.ts` (12 API cases today). **[M]** For each HTTP mode: Start Local Server → page loads (HTTPS shows the generated certificate); launch two analyses on the same port setting → second gets another port; Open Mode = lateral panel → opens inside VS Code; `curl -k https://localhost:<port>/health` responds.

### 6.2 SSE live reload

`SSEManager` (`src/servers/runtime/sse/SSEManager.ts`) keyed by analysed file URI via `src/utils/fileToServerMap.ts`; endpoint `/events` (`httpServer.ts:405`, handler `:512-535`); notifications from `src/code_analysis/engine/servers/sseNotificationManager.ts:16-90`; browser clients `templates/xr/sse/live_sse_fileXR.js`, `live_sse_fileDOM.js`, LivePanel `panelShell.js` status indicator. **[A]** `test/analysis/reanalysisArchitecture.test.cjs`. **[M]** see 4.8.

### 6.3 Active servers registry and actions

Registry `src/active_servers/registry/activeServerRegistry.ts`, control `src/active_servers/runtime/serverControl.ts`; 13 contributed actions + 4 internal (section 2): show actions, open in browser, open in panel (HTTP only), copy URL, copy LAN URL, start/stop remote access, copy invitation, regenerate pairing code, show remote status, stop server, stop all, show details, show participant details, remove participant, refresh, open view. **[M]** see 3.2.

### 6.4 Collaboration rooms

| Capability | Detail | Source |
|---|---|---|
| Room server | WebSocket `/codexr-room`; message types `register`, `room-join`, `host-transfer`, `participant-kick`, `presenter-started`, `presenter-stopped`, `presence-update`, `entity-added`, `entity-updated`, `entity-transform`, `entity-removed`, `entity-lock`, `entity-unlock` | `src/servers/runtime/collaboration/collaborationRoomServer.ts:309-345` |
| Roles | host / guest, server-authoritative host transfer and kick | same; tree shows `Role: Host/Guest` (`activeServerItems.ts:260`) |
| Kick | `codeXR.activeServers.removeParticipant` (guest rows only); client shows a terminal disconnect screen (`session-ended`, `participant-kick`) | `package.json` `view/item/context` #5; `templates/components/codexr/collaboration/codexrCollaborationRuntime/disconnectScreen.js` |
| Session descriptor / avatar model | `/api/collaboration/session`, `/api/collaboration/avatar-model` | `src/servers/runtime/collaboration/collaborationSessionApi.ts` |
| Identity | custom name or anonymous (Star Wars alias per room); avatar colour auto or one of 6; profile file `<globalStorage>/collaboration/` | `src/collaboration/model/*.ts`, `src/collaboration/services/collaborationProfileManager.ts:51`; commands `codeXR.collaboration.selectIdentity`, `setName`, `selectAvatar`, `showAvatarModelInfo` |
| Avatars | bundled glTF model (`resources/avatars/**`, shipped), auto-fitted height, per-player tint, name tags; procedural fallback | `templates/components/codexr/avatar/codexrAvatarRuntime.js` |
| Shared state | entity snapshot replay; passive mode-entity contract; analysis-view authority | `templates/components/COMPONENTS.md:85-96` |
| Profile changes propagate live | room sessions updated on profile change | `httpServer.ts:551-559` |

**[A]** `test/servers/collaborationRoomServer.test.cjs`, `test/analysis/collaborationRuntime.test.cjs`, `test/collaboration/avatarIdSync.test.cjs`. **[M]** two browsers on one scene → each sees the other's avatar with name tag and colour; moving a screen/chart replicates; host transfers host role; host kicks guest; stopping the server shows "session ended" to guests.

### 6.5 Screen broadcast (virtual screens)

WebSocket `/codexr-broadcast`, messages `register`, `broadcast-start`, `broadcast-stop`, `viewer-join`, `relay-request`, `viewer-leave`, `signal-offer`, `signal-answer`, `signal-ice` (`src/servers/runtime/broadcast/screenBroadcastSignalingServer.ts:178-200`). One broadcaster per screen (`broadcast-denied`), direct WebRTC on the same network, server-relayed frames (WebCodecs VP8/Opus, JPEG fallback) for tunnel guests, parked viewers (`viewer-waiting`), quality by audience size, temporal layers (`COMPONENTS.md:56-78`). Runtimes `virtualScreenRuntime` + `codexrMultiScreenManagerRuntime`.
**[A]** `test/servers/screenBroadcastSignalingServer.test.cjs`, `test/analysis/virtualScreenRuntime.test.cjs`, `test/analysis/audioPolicy.test.cjs`. **[M]** create a screen in the room, Share a browser tab → second participant presses `Join · name` and sees it; × leaves; a second sharer is denied.

### 6.6 Remote access (Cloudflare Quick Tunnel)

| Capability | Detail | Source |
|---|---|---|
| Global switch | `Cross-network connections` setting, **enabled by default** (`DEFAULT_REMOTE_ACCESS_SETTINGS.enabled = true`, migration flips old settings once) | `src/remote_access/model/remoteAccessModel.ts:38-42`, `serverSettingsManager.ts:312-326` |
| Consent gate (the opt-in point) | managed `cloudflared` **2026.5.2** is downloaded only after a one-time modal consent (`codexr.cloudflaredDownloadConsented`), checksum-verified; a system `cloudflared` is used if present; declining suppresses auto-start | `src/remote_access/services/cloudflaredBinaryManager.ts:15,39,48-98,102,138,224`; `remoteAccessManager.ts:206-243` |
| Per-server tunnel | `startSharing` / `stopSharing` / `stopAll`; auto-start for running servers when enabled; toast "Server X is now shared across networks" + copy link | `src/remote_access/services/remoteAccessManager.ts:76,191-265` |
| Invitations + pairing | invitation link (`copyInvitation`), `/join` pairing page, six-digit pairing code (regenerable), browser identity → pair request → confirm → browser token exchange, profile update | `remoteAccessManager.ts:269-324`; `src/servers/runtime/remote/remotePairingApi.ts`, `pairingPage.ts`, `remoteAccessPolicy.ts:10-14` (cookie-free allowlist), `src/remote_access/security/remoteSessionAuthority.ts` |
| Join from VS Code | `codeXR.collaboration.joinRemote` pastes an invitation link | `remoteAccessManager.ts:278` |
| Teardown | `deactivate()` stops all tunnels | `src/extension.ts` deactivate |

Docs: `docs/features/CLOUDFLARE_REMOTE_ACCESS.md`.
**[A]** `test/servers/remoteAccessImplementation.test.cjs`, `test/servers/remoteSessionAuthority.test.cjs`. **[M]** with a fresh profile: start remote connection → consent modal → accept → status `Shared`; copy invitation → open on another network → pairing code asked → confirm → guest joins; regenerate code invalidates the old one; Stop remote connection → link dead; decline consent → no download, nothing shared.

### 6.7 Visualize Data (user JSON) — see 3.4

Flow: chart type (registry) → JSON file → per-dimension field mapping (validated) → launch (template filled, stored under `<globalStorage>/visualize-data/`, served) → browse/relaunch/reset stored visualizations; restored on reload (`src/visualize_data/runtime/visualizationRestorer.ts`).

### 6.8 Babia examples — see 3.3

7 example folders / 8 HTML pages + 6 data files under `examples/` (shipped), launched on a server; credits/licences via `showLibraryInfo` (`THIRD_PARTY_NOTICES.md`).

### 6.9 Visualization settings — see 3.7

Background colour, ground colour, environment preset (12), chart palette (9), reset; colour-picker webview `templates/utils/color-picker.html`; dynamic colour icons in the tree (`src/visualization_settings/utils/dynamicColorIconGenerator.ts`).

### 6.10 Chart system

Registry `src/babia_templates/registry/chartRegistry.ts` (`BabiaChartRegistry`) loaded from `src/babia_templates/charts/templateCharts.ts`:

| id | Name | Babia component | Dimensions | Source line |
|---|---|---|---|---|
| `bars` | Bar Chart | `babia-bars` | x_axis, height | `templateCharts.ts:88-112` |
| `barsmap` | Barsmap Chart | `babia-barsmap` | x_axis, z_axis, height | `:125-156` |
| `cyls` | Cyls Chart | `babia-cyls` | x_axis, height, radius | `:170-202` |
| `cylsmap` | Cylsmap Chart | `babia-cylsmap` | x_axis, z_axis, height, radius | `:216-255` |
| `donut` | Donut Chart | `babia-doughnut` | key, size | `:270-294` |
| `pie` | Pie Chart | `babia-pie` | key, size | `:307-331` |
| `bubbles` | Bubbles Chart | `babia-bubbles` | x_axis, z_axis, height, radius | `:344-383` |
| `boats` | (Babia Boats, default "code city") | `babia-boats` | area, height, color (hierarchical) | `:398-430` |

Presentation contract `src/babia_templates/charts/chartPresentation.ts` (`CHART_PRESENTATION_PROFILES`: rotation, fit strategy, base attributes, row budget, surface lift); validation `processing/dimensionValidator.ts`; placeholder processing `processing/templateProcessor.ts`, `templateHTMLProcessor.ts`, `placeholders/createChart.ts`, `createStructure.ts`.
**[A]** `test/analysis/babiaChartDimensionContract.test.cjs`, `controllerViewMapSync.test.cjs`, `xrChartMappingUiRuntime.test.cjs`. **[M]** switch each of the 8 chart types in the Field Mapping panel of an XR scene; each renders inside the table.

### 6.11 Python environment management

| Command | Behaviour | Source |
|---|---|---|
| `codeXR.pythonEnv.create` | find system Python, create venv under `<globalStorage>/python-env/` with retry, ensure/upgrade pip, install pinned packages | `src/python_env/runtime/venvManager.ts:101-250,580-688` |
| `codeXR.pythonEnv.delete` | delete the venv | `venvManager.ts:252` |
| `codeXR.pythonEnv.status` | detailed status | `src/python_env/commands/pythonEnvCommands.ts:36` |
| `codeXR.pythonEnv.reinitialize` | validate and rebuild if needed (also the "Retry"/"Repair" row) | `pythonEnvCommands.ts:43` |
| `codeXR.pythonEnv.verifyInstallation` | health check + refresh installed-packages snapshot | `venvManager.ts:329,363-393` |
| `codeXR.pythonEnv.debugFailInstallation` | forces an installation failure (debug; to be hidden from palette, R3) | `venvManager.ts:338` |
| Startup init | `initializeEnvironment` on activation; UI lock + retry context keys | `venvManager.ts:63`, `src/python_env/runtime/pythonEnvUiState.ts:105-106` |
| Pinned packages | `lizard==1.17.31`, `tree-sitter-language-pack==1.8.1` | `src/python_env/runtime/pythonPackageManifest.ts:9-24` |

**[A]** `test/python_env/pythonEnvUtils.test.cjs`, `test/python_env/analysisRunnerPin.test.cjs`, `test/analysis/uiPolicy.test.cjs`. **[M]** see 3.6.

### 6.12 Logging / diagnostics

"CodeXR" output channel logger `src/core/logging/logger.ts` (verbosity from `codeXR.debug.verboseLogs`), `logPolicy.ts`; browser console APIs `CodeXR.help()`, `CodeXRDebug`, `CodeXRChartDebug`, `CodeXRDependencyGraphRuntime` (`docs/xr-testing/XR_DEBUG_COMMANDS.md`). **[A]** `test/logging/logger.test.cjs`, `logPolicy.test.cjs`, `test/analysis/codexrDebugRuntime.test.cjs`, `xrChartDebugRuntime.test.cjs`. **[M]** in a scene's DevTools console `CodeXR.help()` prints the command list.

## 7. Browser runtimes (`templates/components/`)

Authoritative inventory: `templates/components/COMPONENTS.md` (load order `:143-154`). Each runtime is read by a `*ComponentAsset.ts` in `src/code_analysis/engine/components/customComponents/` and inlined into the generated scene under a **flat output name**; multi-part runtimes are concatenated from `codexr/<component>/<runtimeBase>/` in `manifest.json` order by `runtimeAssembly.ts` (path builder `:30`). Generated scenes must keep the same 23 flat names (minus R5).

| # | Flat output name (asset constant) | Location / parts | Asset file | Global / A-Frame component | Provides | Unit test |
|---|---|---|---|---|---|---|
| 1 | `codexrCommonRuntime.js` | `common/codexrCommonRuntime.js` | `commonComponentAsset.ts:4` | `window.CodeXRCommonRuntime` (`:459`) | tooltips, billboards, hitboxes, text compaction, entity creation | `codexrCommonRuntime.test.cjs`, `runtimeSharedHelperSync.test.cjs` |
| 2 | `codexrGitRefPickerRuntime.js` | `common/codexrGitRefPickerRuntime.js` | `commonGitRefPickerComponentAsset.ts:4` | `CodeXRGitRefPickerRuntime` (`:770`) | Git ref vocabulary, picker `compare`/`sequence` modes, `sampleTimeline` port, `registerGitGatedMode` | `gitRefPickerRuntime.test.cjs` |
| 3 | `codexrVisualStyleRuntime.js` | `common/codexrVisualStyleRuntime.js` | `visualStyleComponentAsset.ts:4` | `CodeXRVisualStyleRuntime` (`:5`) | abandoned visual-style feature — **removal authorized (R5)** | `codexrVisualStyleRuntime.test.cjs` |
| 4 | `codexrPointerPolicyRuntime.js` | `codexr/pointer-policy/` | `pointerPolicyComponentAsset.ts:4` | `codexr-pointer-policy` (`:75`) | single active pointer: mouse / gaze (real immersive, no controllers) / laser of last-used hand; drag ownership | `pointerPolicyRuntime.test.cjs` |
| 5 | `codexrImmersiveRigRuntime.js` | `codexr/immersive-rig/` | `immersiveRigComponentAsset.ts:4` | `codexr-immersive-rig` (`:212`), `codexr-ar-fill-light` (`:165`), `CodeXRStickGateRuntime` (`:77`) | **immersive VR/AR**: fly in immersive sessions, pose save/restore, AR recenter, real-WebXR floor height, gamepad-connected patch, per-hand stick gate, AR fill light | `immersiveRigRuntime.test.cjs`, `npm run test:xr-immersive-harness` |
| 6 | `analysisTableRuntime.js` | `codexr/analysis-table/analysisTableRuntime/` (13 parts) | `analysisTableComponentAsset.ts:3` | `codexr-analysis-table`, `codexr-chart-containment`, `codexr-boats-layout-stability` (`zonesAndProfiles.js:6-12`) | the XR table, surface, table modes, per-chart containment/fit strategies | `xrAnalysisTableRuntime.test.cjs`, `npm run test:xr-harness` |
| 7 | `xrChartMappingUiRuntime.js` | `codexr/xr-chart-mapping-ui/…/` (10 parts) | `xrChartMappingUiComponentAsset.ts:3` | `CodeXRMappingUiRuntime`, `CodeXRAnalysisControllerRuntime` (`stateAndBootstrap.js:273-274`) | **the in-scene controller**: Field Mapping panel, live chart switching, transactional mapping, row-budgeted `babia-queryjson` slices | `xrChartMappingUiRuntime.test.cjs`, `controllerViewMapSync.test.cjs` |
| 8 | `analysisModeRuntime.js` | `codexr/analysis-mode/…/` (6 parts) | `analysisModeComponentAsset.ts:3` | `CodeXRAnalysisModeRuntime` (`snapshotsAndLifecycles.js:273`), `CodeXRAnalysisSurfaceRuntime`, `CodeXRNormalAnalysisRefreshRuntime` (`surfaceAndRefresh.js:317,360`) | mode selector + transitions (normal / historical / dependency / evolution), normal-analysis live refresh | `analysisModeMegatest.test.cjs`, `npm run test:xr-mode-harness` |
| 9 | `dependencyGraphRuntime.js` | `codexr/dependency-graph/…/` (9 parts) | `dependencyGraphComponentAsset.ts:3` | `codexr-dependency-graph` (`configAndStatus.js:6`), `CodeXRDependencyGraphRuntime` (`viewLifecycle.js:292`) | dependency graph: 3 layouts in a worker, filters, navigation, axes, edge encoding, tooltips | `dependencyGraph.test.cjs` |
| 10 | `dependencyVisualBudgetRuntime.js` | `codexr/dependency-visual-budget/` | `dependencyVisualBudgetComponentAsset.ts:4` | `CodeXRDependencyVisualBudgetRuntime` (`:137`) | graph visual density budgeting | `dependencyGraph.test.cjs` |
| 11 | `historicalComparisonRuntime.js` | `codexr/historical-comparison/…/` (7 parts) | `historicalComparisonComponentAsset.ts:3` | `CodeXRHistoricalComparisonRuntime` (`liveRefreshAndRegistration.js:310`) | source selection panel, two-zone comparison charts, live refresh, offline git data | `historicalComparisonRuntime.test.cjs`, `offlineHistoricalDelta.test.cjs` |
| 12 | `projectEvolutionRuntime.js` | `codexr/project-evolution/…/` (9 parts) | `projectEvolutionComponentAsset.ts:3` | `CodeXRProjectEvolutionRuntime` (`transportAndRegistration.js:372`) | evolution player, timelines, overlay, offline frames | `projectEvolutionRuntime.test.cjs`, `npm run test:project-evolution-harness` |
| 13 | `virtualScreenRuntime.js` | `codexr/virtual-screen/virtualScreenRuntime/` (10 parts) | `virtualScreenComponentAsset.ts:5` | `CodeXRVirtualScreenRuntime` (`moduleAndConfig.js:19`) | **virtual screen**: chrome, drag/resize/depth, follow, collision bumpers, WebRTC + relay broadcast, fixed-content subtypes | `virtualScreenRuntime.test.cjs` |
| 14 | `codexrMultiScreenManagerRuntime.js` | `codexr/virtual-screen/codexrMultiScreenManagerRuntime.js` | `virtualScreenComponentAsset.ts:6` | `codexr-multi-screen-manager` (`:42`) | screen creation, placement, multi-screen controls | `virtualScreenRuntime.test.cjs` |
| 15 | `guideScreenRuntime.js` (+ page `guide.html`) | `codexr/guide-screen/…/` (3 parts) + `templates/guide/guide.html` | `guideScreenComponentAsset.ts:5-6` | `CodeXRGuideRuntime` (`guideScreen.js:337`) | in-room user guide (virtual-screen subtype `guide`), tabs, glossary, pagination; same model served as `guide.html` | `guideScreenRuntime.test.cjs` |
| 16 | `codexrCollaborationRuntime.js` | `codexr/collaboration/…/` (6 parts) | `collaborationComponentAsset.ts:5` | `CodeXRCollaborationRuntime` (`moduleAndConfig.js:12`) | presence, identity, avatars, pointers, entity sync, disconnect screen, **offline-export boot** | `collaborationRuntime.test.cjs` |
| 17 | `codexrDomSceneCollaborationRuntime.js` | `codexr/dom-scene/` | `collaborationComponentAsset.ts:6` | `CodeXRDomSceneCollaborationRuntime` (`:16`) | DOM-scene collaboration glue | `domSceneTemplateContract.test.cjs` |
| 18 | `codexrAvatarRuntime.js` | `codexr/avatar/` | `avatarComponentAsset.ts:4` | `codexr-avatar` (`:174`), `CodeXRAvatarRuntime` (`:7`) | glTF avatar, height fit, tint, name tags | `collaborationRuntime.test.cjs`, `avatarIdSync.test.cjs` |
| 19 | `codexrRoomRuntime.js` | `codexr/xr-room/` (+ 4 SVG textures) | `codexrRoomComponentAsset.ts:4` | `codexr-room` (`:19`) | room shell; functionally removed in AR | `xrRoomRuntime.test.cjs` |
| 20 | `codexrLogoRuntime.js` | `codexr/logo/…/` (2 parts) | `logoComponentAsset.ts:3` | `codexr-logo` (`codexrLogo.js:13`), `CodeXRLogoRuntime` (`:463`) | 3D CodeXR mark over the empty table | `codexrLogoRuntime.test.cjs` |
| 21 | `renderBudgetRuntime.js` | `codexr/render-budget/` | `renderBudgetComponentAsset.ts:4` | `CodeXRRenderBudgetRuntime` (`:141`) | FPS/render quality monitor, static mode (reduced motion) | (covered by consumers' tests) |
| 22 | `codexrDebugRuntime.js` | `codexr/debug/` | `codexrDebugComponentAsset.ts:4` | `CodeXRDebug` (`:425`), `codexr-desktop-only` (`:285`) | `CodeXR.help()`, diagnostics, watch, HUD | `codexrDebugRuntime.test.cjs` |
| 23 | `xrChartDebugRuntime.js` | `codexr/xr-chart-debug/…/` (5 parts) | `xrChartDebugComponentAsset.ts:3` | `CodeXRChartDebug` (`initialize.js:388`) | legacy chart debug helpers (gizmo, raycast, rig flight) | `xrChartDebugRuntime.test.cjs` |

Shared **LivePanel** components (`templates/components/livepanel/`, bundled alphabetically by `src/code_analysis/engine/parsers/livePanelParser.ts`): `charts.js|css`, `dataTable.js|css` (sortable data table), `dependencySummaryPanel.js`, `historicalPanel.js|css`, `panelShell.js|css` (**livepanel shell**: theme toggle, SSE status indicator, notifications, DataTable registry, shared formatters). Panel-specific: `templates/analysis_livePanel/{file,directory}/*` (6 files).

Other browser assets: SSE clients `templates/xr/sse/live_sse_fileXR.js`, `live_sse_fileDOM.js`; scene templates `templates/xr/file/xr-visualization.html`, `templates/xr/html/dom-visualization-template.html`; `templates/utils/color-picker.html`; `templates/xr/html/htmlLiveReload.js` (dead, R6). Total files under `templates/`: 130.

**[A]**
- `npm test` → every `test/analysis/*Runtime*.test.cjs` above, plus `runtimeAssemblyParity.test.cjs` (assembled output == parts), `xrRuntimeManifestAsymmetry.test.cjs`, `runtimeSharedHelperSync.test.cjs`, `test/packaging/distCharacterization.test.cjs`.
- Snapshot: `ls src/code_analysis/engine/components/customComponents/*ComponentAsset.ts | wc -l` → 21 (20 after R5); `find templates/components -name manifest.json | wc -l` → 11; `grep -rhoE "root\.CodeXR[A-Za-z]+ *=" templates/components | sort -u | wc -l` → 22 globals (21 after R5).
- Manual harnesses: `npm run test:xr-harness`, `test:xr-mode-harness`, `test:xr-immersive-harness`, `test:project-evolution-harness` (load assembled copies from `test/manual/assembled/`, regenerated by `node test/manual/buildAssembledRuntimes.cjs`).

**[M]** In an XR scene: open DevTools and check `typeof` of each global above is not `undefined`; `CodeXR.help()` works; Enter VR (emulator) → fly on, single laser follows the last-used controller; Enter AR → room disappears and stops intercepting the laser, rig recentred, charts lit; create a virtual screen, drag/resize it, open the in-room guide; the logo floats while the table is empty; Field Mapping switches chart and dimensions live.

## 8. Python backend (`backend/src/`)

Copied verbatim into `dist/code_analysis/python/` by webpack (`webpack.config.js:40-55`, ignores `*.ts` and `__pycache__`, `noErrorOnMissing: false`); run in the managed venv by `src/code_analysis/engine/utils/executePython.ts` (`executePythonScript` `:364`). Output protocol: JSON printed between `=== JSON_START ===` / `=== JSON_END ===` on stdout (`main.py:84-86`), progress/logs on stderr (`utils/progress_logger.py`); on error the same markers wrap `{error: true, message, mode, type, target}` and exit code 1 (`main.py:87-98`). Source-text pins: quote style and import order of `main.py` are asserted by tests (`PYTHON_ANALYSIS.md`).

### 8.1 `main.py` CLI (`backend/src/main.py:27-106`)

| Flag | Values | Notes |
|---|---|---|
| `--mode` (required) | `livePanel`, `xr`, `schema`, `dependencies` | `:29` |
| `--type` (required) | `file`, `directory`, `project` (`project` is normalized to `directory`, `:44`; the alias is authorized for removal, R7) | `:30` |
| `--target` | path; required unless `--mode schema` (`:41-42`) | `:31` |
| `--output` | unread (authorized for removal, R7) | `:32` |
| `--files` | explicit file subset (directory modes) | `:33` |
| `--deep` | recursive directory analysis | `:34` |
| `--cache` | private dependency-extraction cache path | `:35` |
| `--dependency-refresh` | validated selective-refresh request JSON | `:36` |
| `--project-root` | project root for file dependency resolution | `:37` |

| Mode × type | Dispatch | Output | TS caller |
|---|---|---|---|
| `schema` × file/directory | `get_xr_schema` (`utils/xr_field_schema.py`) | field schema (13 file / 25 directory fields, version 1) | `executePython.ts:26-31` → `xrFieldSchemaService.ts` (globalState cache) |
| `dependencies` × directory | `analyze_dependencies(target, recursive=--deep, cache, refresh)` (`utils/dependency_analysis_engine.py:656`) | graph: nodes, edges (relation, confidence, occurrences), metrics (fanIn/fanOut/degree/cycles) | `executePython.ts:34-59` |
| `dependencies` × file | `analyze_file_dependencies(target, project_root, cache)` (`:377`) | file-scope graph | idem |
| `livePanel` × file | `livePanels/livePanel_file_analysis_coordinator.analyze_file_comprehensive` (`:21`) | file metrics + functions | `executePython.ts:120-148` |
| `livePanel` × directory | `livePanel_directory_analysis_coordinator.analyze_directory_comprehensive` (`:27`) or `…_deep_….analyze_directory_deep_comprehensive` (`:27`) with `--deep` | per-file summaries | `executePython.ts:150-190` |
| `xr` × file | `XR/xr_file_analysis_coordinator.analyze_file_for_xr` (`:18`) | per-function rows (`data.json`) | `executePython.ts:192-230` |
| `xr` × directory | `XR/xr_directory_analysis_coordinator.analyze_directory_xr(is_deep, filtered_files)` (`:25`) | per-file rows (`data.json`) | idem |

### 8.2 Other scripts spawned by the extension

| Script | Invocation | Output | TS caller |
|---|---|---|---|
| `html/html_dom_parser.py` | `<file>` argv (`:68-82`) | DOM tree JSON (`emit_json_result`, `:62`) | `executePython.ts:303-315` |
| `summaryFiles/file_reanalysis_coordinator.py` | file list argv (`:40-80`) | per-file summaries for incremental directory re-analysis | `executePython.ts:337-346` ← `directoryReAnalyzer.ts:45,189` |
| `export/git_export_analysis_worker.py` | long-lived worker, JSON lines on stdin/stdout: emits `ready` (`PROTOCOL_VERSION = 1`, `:23`), accepts `analyze` / `shutdown`, answers `complete` / `error` / `stopped` (`:71-98`) | per-revision analysis payloads for offline export | `src/code_analysis/export/gitRevisionExporter.ts:78`, `gitExportPythonWorkerPool.ts` |

### 8.3 Analyzers and utilities (must keep behaving identically)

`tools/lizard_analyzer.py` (CCN, function/line counts, complexity bands >10 / >25), `tools/class_counter_analyzer.py`, `tools/python_comment_analyzer.py`; `utils/file_analysis_engine.py`, `directory_analysis_engine.py`, `directory_scan_utils.py`, `file_metric_summary.py`, `line_metric_utils.py`, `babia_path_utils.py`, `metric_language_contract.py`, `xr_field_schema.py`, `dependency_analysis_engine.py`, `progress_logger.py`. Each `tools/*.py` (except `class_counter_analyzer.py`, whose CLI went in W5-46), `XR/*.py`, `livePanels/*.py` also has a standalone argv `main()` (not used by the extension). Dead code authorized for removal is listed in R7 (`livePanels/file_reanalysis_coordinator.py`, `examples/example_progress_coordinator.py`, …).

**Do-not-touch contract** (`.claude/docs/PYTHON_ANALYSIS.md` "field-schema contract"): `XR_SCHEMA_VERSION`, order/count/labels of `XR_FILE_FIELDS` (13) and `XR_DIRECTORY_FIELDS` (25), `_text_field`/`_numeric_field` call syntax, `build_complexity_band` thresholds, `summarize_function_metrics`, field ids ⊂ emitted keys.

**[A]**
- `npm run test:python` (= `test:backend`, runner `test/runners/run-python-tests.cjs`): 9 suites / 52 tests in `backend/tests/` (analyzers, dependencies ×2 incl. goldens, directory_scanning, git_export, html_dom, path_normalization, xr_file_analysis, xr_schema).
- `npm run test:analysis` (per-language XR vs LivePanel `data.json` equivalence over `manual_test/`), `npm run test:htmlanalysis`, `npm run report:manual-metrics`.
- Smoke: `python3 -B backend/src/main.py --mode schema --type file` prints the 13-field schema between the markers (venv not needed for `schema`).
- `test/analysis/xrFieldSchemaIntegration.test.cjs`, `test/python_env/analysisRunnerPin.test.cjs` (lizard pin).

**[M]** Each analysis kind in 4.2 completes and the Output › CodeXR channel shows the Python mode/type lines; the dependency graph and DOM visualization load; an export with git modes runs the worker pool to completion.

## 9. Build, packaging and test surface

### 9.1 npm scripts (extension workspace `apps/vscode-extension/package.json:749-775`, 25)

The root `package.json` mirrors 24 of them via `npm run <x> --workspace=code-xr` and adds `test:backend` (= `test:python`), 25 in total; `vscode:prepublish` is not mirrored. Run everything from the repository root.

| Script | Does | Notes |
|---|---|---|
| `vscode:prepublish` | `npm run package` | vsce hook |
| `compile` | webpack dev build → `dist/` (bundle `src/extension.ts`, copy `backend/src` → `dist/code_analysis/python`, `templates/`, `examples/`) | `webpack.config.js:12-75` |
| `compile:dev-host` | compile + `scripts/prepare-dev-extension.mjs` (stages `.vscode-test/dev-extension` for F5) | pre-launch task of "Run CodeXR Extension" |
| `watch` | webpack `--watch` | |
| `package` | webpack `--mode production` | deterministic bundle (fingerprintable) |
| `typecheck` | `tsc --noEmit` | gate |
| `compile-tests` | wipe `out/`, `tsc --outDir out` | tests load compiled code from `out/` |
| `watch-tests` | `tsc -w --outDir out` | |
| `lint` | ESLint over `src` | gate |
| `test` | → `test:basic` | **default gate** |
| `test:basic` | typecheck + lint + compile-tests + test:unit | CI job "npm test" |
| `test:unit` | `test/runners/run-node-tests.cjs` (Node native runner over 74 `*.test.cjs`) | |
| `test:python` | `test/runners/run-python-tests.cjs` (`backend/tests`) | |
| `test:all` | test:basic + test:python | |
| `test:integration` | `@vscode/test-cli` (empty lane) | **authorized removal R9** |
| `package:vsix` | `package` + `scripts/package-vsix.mjs` | see 9.2 |
| `test:analysis` | `test/runners/run-analysis-tests.cjs` (per-language fixtures, installs pinned lizard) | |
| `test:htmlanalysis` | `test/runners/run-html-analysis-tests.cjs` | |
| `test:xr-harness` | `run-xr-containment-harness.cjs` → `test/manual/xr-containment-harness.html` | manual browser harness |
| `test:xr-mode-harness` | `run-xr-mode-cycle-harness.cjs` → `xr-mode-cycle-harness.html` (+ 4 JSON fixtures) | |
| `test:xr-immersive-harness` | `run-xr-immersive-harness.cjs` → `xr-immersive-harness.html` | |
| `test:project-evolution-harness` | `run-project-evolution-harness.cjs` → `project-evolution-playback-harness.html` | |
| `report:manual-metrics` | analysis runner `--report-only` | |
| `guardrails:measure` | `test/tooling/measureGuardrails.cjs` (AST metrics) | |
| `guardrails:update` | same `--write` → `test/tooling/guardrail-baseline.json` | ratchet baseline |

Non-script tooling: `scripts/dist-fingerprint.mjs` + `scripts/dist-diff.mjs` (H1/H2 proof that `dist/` did not change), `scripts/report-manual-metrics.py`, `test/manual/buildAssembledRuntimes.cjs`. CI `.github/workflows/ci.yml`: jobs "npm test" (matrix OS, `npm ci` + `npm test`), "python suites" (backend suites, per-language fixtures, HTML DOM), "package the VSIX" (+ dist fingerprint); `.github/workflows/deploy-pages-redirect.yml` (GitHub Pages redirect from `pages/`). Launch configs `.vscode/launch.json`: "Run CodeXR Extension" (staged dev host) and "Run CodeXR Extension (workspace direct)".

**[A]** `node -p "Object.keys(require('./apps/vscode-extension/package.json').scripts).join(' ')"` and the same for `./package.json`; compare with the table (expected delta: only `test:integration` gone from both, R9).

### 9.2 VSIX packaging (`scripts/package-vsix.mjs`)

`files` allowlist (13 entries, `package.json:49-63`; there is no `.vscodeignore`):

| # | Entry | Ships |
|---|---|---|
| 1 | `dist/**/*` | extension bundle + copied Python backend + templates + examples |
| 2 | `resources/favicon.ico` | |
| 3 | `resources/icon.png` | marketplace icon |
| 4 | `resources/icon.svg` | activity-bar icon (also the logo contour source) |
| 5 | `resources/avatars/**/*` | collaboration glTF avatar |
| 6 | `resources/languages_icons/color/**/*` | 26 language SVGs (`no_color/` is NOT shipped; its deletion is R8) |
| 7 | `README.md` | |
| 8 | `LICENSE` | |
| 9 | `THIRD_PARTY_NOTICES.md` | BabiaXR and other credits |
| 10 | `CHANGELOG.md` | |
| 11 | `docs/**/*` | `docs/features/` (4), `docs/project/ROADMAP_V1.2.0.md`, `docs/xr-testing/` (3) |
| 12 | `templates/**/*` | 130 files |
| 13 | `examples/**/*` | 14 files |

Script guards: refuses to package if `files` still includes `certs/**/*` (`package-vsix.mjs:18-19`); deletes a stale `dist/certs`; refuses if `dist/extension.js` is missing (`:33-37`); strips source maps from `dist/` (`:42-63`); rewrites README link base to the monorepo subfolder. Baseline (status doc, 2026-09-18): VSIX 6,450,820 bytes / 360 entries; production `dist/extension.js` 1,257,031 bytes, deterministic.

**[A]** `npm run package:vsix` succeeds; `unzip -l code-xr-1.2.1.vsix | tail -1` → entry count ≈ 360 (minus removed files, each named); `test/packaging/distCharacterization.test.cjs`, `marketplaceListing.test.cjs`, `resourceConsumers.test.cjs`; `node scripts/dist-diff.mjs before.json after.json --expect-identical-bundle` for H1 commits.
**[M]** install the VSIX in a clean VS Code profile (`code --install-extension code-xr-1.2.1.vsix`) and repeat the smoke checks of section 10.

### 9.3 Test inventory

- **Unit (Node)**: 74 files in `test/` — analysis (51), collaboration (1), commands (2), directory_analysis (1), helpers (2), logging (2), packaging (3), python_env (2), servers (5), startup (1), tooling (1), utils (1), visualization_settings (1), visualize_data (1). 697 static `test(` calls; 708/708 executed per `.claude/docs/V1.2.1_STATUS.md`.
- **Python**: 9 files, 52 test functions in `backend/tests/`.
- **End-to-end metric fixtures**: `manual_test/` 24 language fixtures + 2 HTML fixtures + `deep/`.
- **Manual browser harnesses**: 4 HTML harnesses in `test/manual/`.
- **Guardrail ratchet**: `test/tooling/guardrailRatchet.test.cjs` vs `guardrail-baseline.json` (metrics may only improve).

## 10. Verification checklist (run after the cleanup)

Run from the repository root unless noted. "Expected" values assume every authorized removal (0.3) has landed; if some have not, use the pre-cleanup value from section 0. Any other difference is a regression to investigate before merging.

### 10.A Automated

1. `npm ci` succeeds.
2. `npm test` is green (typecheck + lint + compile-tests + unit). It must still contain and pass `test/commands/commandContributions.test.cjs` (6 tests), `test/utils/languageTables.test.cjs`, `test/analysis/watcherExtensionContract.test.cjs`, `test/analysis/runtimeAssemblyParity.test.cjs`, `test/packaging/*.test.cjs` and `test/tooling/guardrailRatchet.test.cjs`. Test count may drop only by the deleted visual-style suite (R5) and any test deleted together with an authorized removal (name each one).
3. `npm run test:python` → backend suites green (52 today; fewer only if a test of removed dead Python code was deleted, named in the commit).
4. `npm run test:analysis` → every language fixture green, XR and LivePanel `data.json` identical.
5. `npm run test:htmlanalysis` green.
6. Manifest snapshot (in `apps/vscode-extension/`): run the one-liner in 1.1. Expected: `cmds` 69, `settings` `["codeXR.debug.verboseLogs"]`, `containers` `["codexr"]`, `views` `["codexrTree"]`, menus `view/title 2, explorer/context 12, editor/context 8, view/item/context 5, codeXR.analysis.contextMenu 11, commandPalette 12`, `submenus` 1, `keybindings` 0, `activation` `[]`, `files` 13, `scripts` 24.
7. Contributed id diff: `node -p "require('./package.json').contributes.commands.map(c=>c.command).sort().join('\n')"` equals the 70 ids of table 1.2 minus `CodeXR.helloWorld`, with titles and icons unchanged.
8. Internal id diff: `node -p "require('./test/commands/internalCommandIds.cjs').INTERNAL_COMMAND_IDS.map(e=>e.id+' '+e.kind).join('\n')"` equals rows 1-36 of table 2.2 (32 tree-item, 2 programmatic, 2 legacy-alias, 0 pending-removal). `codexr.servers.refresh` and `codexr.servers.refreshServers` still present.
9. Menu `when` clauses: `node -e 'const m=require("./package.json").contributes.menus;console.log(JSON.stringify(m))' | md5sum` differs from the baseline only by the R3 `commandPalette` entry for `codeXR.pythonEnv.debugFailInstallation` (re-derive by diffing the JSON, not just the hash).
10. Language contract: `python3 -B -c "import sys; sys.path.insert(0,'backend/src/utils'); import metric_language_contract as m; c=m.get_metric_language_contract(); print(len(c), sum(map(len,c.values())))"` → `23 48`; the menu regex still lists the same 48 extensions; `grep -c '{ name:' apps/vscode-extension/src/utils/languageMetadata.ts` → 24.
11. Field schema: `python3 -B backend/src/main.py --mode schema --type file` → 13 fields; `--type directory` → 25 fields; `schemaVersion` 1.
12. Python CLI: `python3 -B backend/src/main.py --help` still lists `--mode {livePanel,xr,schema,dependencies}`, `--target`, `--files`, `--deep`, `--cache`, `--dependency-refresh`, `--project-root` (only `--output` and the `project` type may be gone, R7). `backend/src/html/html_dom_parser.py`, `backend/src/summaryFiles/file_reanalysis_coordinator.py`, `backend/src/export/git_export_analysis_worker.py` exist.
13. Runtimes (in `apps/vscode-extension/`): `ls src/code_analysis/engine/components/customComponents/*ComponentAsset.ts | wc -l` → 20; `find templates/components -name manifest.json | wc -l` → 11; `grep -rhoE "root\.CodeXR[A-Za-z]+ *=" templates/components | sort -u | wc -l` → 21; `ls templates/components/livepanel` → the 9 files of section 7; the 23 flat output names of table 7 minus `codexrVisualStyleRuntime.js` (22) still appear as `*_OUTPUT_NAME` constants.
14. Server surface: `grep -c "case '/" src/servers/runtime/httpServer.ts` → 12; `/codexr-room` and `/codexr-broadcast` still registered; room message types (6.4) and broadcast message types (6.5) all still handled (`grep -c "case '" src/servers/runtime/collaboration/collaborationRoomServer.ts src/servers/runtime/broadcast/screenBroadcastSignalingServer.ts`).
15. Sidebar: `grep -c "sectionName: '" src/views/sectionDefinitions.ts` → 8.
16. Capabilities: `test/analysis/analysisServerCapabilities.test.cjs` green (XR 3/3, LivePanel 2/3, VisualizeDOM 0/3).
17. Persisted keys (0.2): each key/file name still greps to its owner, e.g. `grep -rn "codeXR.analysis.lastKind\|codeXR.analysis.xrFieldSchemaCache.v1\|codeXR.analysis.filesByLanguage.summaryCache\|visualizeDataState\|codexr.cloudflaredDownloadConsented\|server-settings.json\|server-certs\|codexr_analysis\|visualization-configuration\|python-env" src --include=*.ts` returns every one.
18. Pinned versions unchanged: `lizard 1.17.31`, `tree-sitter-language-pack 1.8.1` (`pythonPackageManifest.ts`), `cloudflared 2026.5.2`; CDN script versions in `templates/xr/file/xr-visualization.html:8-20` (A-Frame 1.7.1, aframe-extras 7.5.4, babia 1.3.4, environment 1.5.0, geometry-merger 2.0.1).
19. `npm run package:vsix` succeeds; VSIX entry list equals the baseline minus the files removed by name (R5, R6, R7, R8); `node apps/vscode-extension/scripts/dist-diff.mjs` per the H1/H2 protocol for each cleanup commit.
20. `npm run guardrails:measure` shows only improvements versus `test/tooling/guardrail-baseline.json`.
21. Manual harnesses open and pass their on-page checks: `npm run test:xr-harness`, `test:xr-mode-harness`, `test:xr-immersive-harness`, `test:project-evolution-harness`.

### 10.B Manual (F5 "Run CodeXR Extension", fresh user-data dir, workspace = repo root or a git clone of a sample project containing `apps/vscode-extension/manual_test/`)

22. Activation: no error toast; Output › CodeXR shows the 4 deferred startup tasks; the activity-bar icon opens the `CodeXR` tree with SERVERS, ACTIVE SERVERS, BABIA EXAMPLES, VISUALIZE DATA, ANALYSIS, PYTHON ENV, VISUALIZATION SETTINGS, LEARN MORE & SUPPORT in that order.
23. Python env: PYTHON ENV goes installing → ready; analysis menus disabled while installing (UI lock), enabled after; Status, Verify installation, Reinitialize, Delete → Create all work; `Debug Python Environment Failure` no longer in the palette (R3) but still contributed and registered.
24. Settings UI: only `codeXR.debug.verboseLogs`; toggling it changes Output › CodeXR verbosity live.
25. Command Palette: type `CodeXR` → all contributed commands except the 11 Run-Last ones (and R3) are listed; Hello World is gone (R2).
26. Context menus: on a `.py` file → `Code-XR: Analysis` submenu with Analyze File (LivePanel/XR) + directory/project entries per the `when` clauses; on a folder → directory entries; on an `.html` → Visualize DOM; inside an editor → submenu + Run Last for the last kind.
27. Run all 11 analysis kinds (4.2) once each: each opens its scene/panel, adds an Active Analyses row and an ACTIVE SERVERS row; the Run Last entry then re-runs the same kind.
28. XR scene: boats chart; Field Mapping switches through all 8 chart types and remaps dimensions; Enter VR and Enter AR (WebXR emulator) work per `docs/xr-testing/XR_MANUAL_CHECKLIST.md` (single laser, fly, AR recentre, room gone in AR); logo over empty table; guide screen; virtual screen create/drag/resize; `CodeXR.help()` in the console.
29. In-scene modes (in a git repo): Dependency graph (3 layouts, node selection, back to normal), Historical comparison (working copy vs tag/commit, live refresh on save), Project evolution (auto/range/manual movie, play/pause/speed, Clear movie). Outside a git repo the two git modes are disabled with a reason.
30. LivePanel file and directory (deep and not): table, charts, theme toggle, SSE status live, dependency summary and historical panel present; Open Mode = lateral panel opens inside VS Code over HTTP.
31. DOM visualization of `manual_test/html_dom_fixture.html`; edit → scene updates.
32. Auto re-analysis: save a change → XR and LivePanel refresh in place; Debounce 5 s delays it; Auto-Analysis off stops it; add/delete a file under an analysed directory → element appears/disappears.
33. ANALYSIS settings: all 11 rows change and persist across a window reload; profiles Save/Load/Delete/Reset; Files by Language groups + sorting + click-to-analyse; Project Structure directory/file clicks use the configured modes; Active Analyses actions View Details / Open in Browser / Export / Close.
34. Export Analysis Folder with all four modes (entire history and latest-N, Balanced and Maximum speed) → serve the copy statically → boots in Normal analysis; dependency graph, historical comparison and project evolution all work offline.
35. SERVERS: each of the 6 configuration rows (3 HTTP modes incl. custom certificates, port, auto-open, open mode, cross-network, reset) and Start Local Server with an HTML file; two servers at once get different ports.
36. ACTIVE SERVERS per server: Local network address copy, Actions (open in browser, open in panel for HTTP only, copy address, server information, stop server), Stop All Servers, view-title Refresh / Stop All.
37. Collaboration: two browsers → avatars with names/colours, entity sync, host/guest roles, host transfer, kick a guest from the tree (`Remove from Session`), stop server → "session ended"; COLLABORATION rows (Join Remote Session, Name, Avatar Color, 3D Model) work.
38. Screen broadcast: share a tab on a virtual screen, second participant joins, one-broadcaster rule enforced.
39. Remote access: Start remote connection → cloudflared consent modal (first time) → Shared; copy invitation; join from another network/profile with the pairing code; regenerate code; View remote status; Stop remote connection; declining consent shares nothing.
40. BABIA EXAMPLES: About BabiaXR credits; launch each of the 7 examples.
41. VISUALIZE DATA: chart type + `examples/data/sales.json` + mapping → Launch; Browse Visualizations relaunch + reset; state survives reload.
42. VISUALIZATION SETTINGS: background/ground colour (colour picker), 12 environment presets, 9 palettes, reset — each visible in a new XR scene.
43. LEARN MORE: the three rows open the docs site, the author site and Buy Me a Coffee.
44. Deactivate (close window) with servers and a tunnel running → no orphan `cloudflared` process, ports released.
45. Install the packaged VSIX in a clean profile and repeat 22, 27 and 28 as a smoke test of the shipped artefact.

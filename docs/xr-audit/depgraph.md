# Dependency-graph XR analysis: audit (area "depgraph")

Repo: /home/user/Code-XR @ d89e08d4 (v1.2.1). All paths are relative to the repo root unless they start with `/tmp`.
Scratch harness, scripts and datasets: `/tmp/claude-0/-home-user/af5ccea8-f538-575c-b7b6-8256e5a53df6/scratchpad/audit/depgraph/`
(`run.cjs`, `run5.cjs` = Playwright scenarios on the real assembled runtime; `build.cjs` = harness builder; `run_dep.py`, `cmp.py`, `resolve_check.py` = Python engine probes; `venv/` = backend venv with the pinned lizard + tree-sitter-language-pack).

Tests run:
- `node --test test/analysis/dependencyGraph.test.cjs test/analysis/dependencyFileScope.test.cjs test/analysis/dependencyGraphBridge.test.cjs`: 55/55 pass.
- `CODEXR_PYTHON=<scratch venv>/bin/python npm run test:python`: 73/73 pass. This needed a venv built from `backend/requirements.txt`, because the system python has no lizard.
- None of these tests covers any finding below.

## 1. How the area works

- **Entry.** The scene's mode option `dependency-graph` is registered by `CodeXRDependencyGraphRuntime` (`apps/vscode-extension/templates/components/codexr/dependency-graph/dependencyGraphRuntime/viewLifecycle.js`).
  - `selectDependencyMode()` activates the mode at once when the shared entity `dependency-graph/main` is already `ready`.
  - Otherwise `start()` hops the local mode runtime to `selection` and sends `dependency-graph-start` over the collaboration WebSocket.
- **Host.** `DependencyGraphBridge.handleDependencyGraphStartMessage` (`apps/vscode-extension/src/core/server/analysis/dependencyGraphBridge.ts`) does three things:
  - It refuses when the service is busy.
  - It switches the authoritative `analysis-view` to `dependency-graph`.
  - It upserts the entity (`analyzing`, or `ready` when a dataset URL is cached), then asks `analysisRefreshCoordinator.requestRefresh(...,'dependency-graph')`.
- **Refresh.** The coordinator calls `refreshDependencyGraph(batch)`, which calls `DependencyGraphService.analyze()` (`apps/vscode-extension/src/core/dependencies/dependencyGraphService.ts`). The service spawns `backend/src/main.py --mode dependencies`. The engine is `backend/src/utils/dependency_analysis_engine.py`, with no timeout and no cancel.
  - The service writes `dependencies/dependency-graph-<rev>.json` plus `dependency-graph.json`.
  - The bridge upserts `{status:'ready', datasetUrl, revision}`.
  - Drilling into a file goes through `dependency-file-scope-request` → `analyzeFileScope` → `dependencies/dependency-scope-<rev>.json`, and the entity's `datasetUrl` becomes that file.
  - Navigation and filters (`dependency-graph-settings`) only merge `scope/layout/filters/mapping` into the entity. They never touch `datasetUrl`.
- **Browser.**
  - `applySharedState(snapshot)` fetches `datasetUrl` and stores it as `state.projectDataset` (directory) or `state.fileDatasets[path]` (file).
  - `filteredDataset()` projects it with `projectDirectoryScope` / `projectFileScope` (`datasetProjection.js`). This aggregates child directories by summing per-file metrics, and replaces external nodes with one summary node unless `showExternal`.
  - `renderGraph()` mounts the `codexr-dependency-graph` A-Frame component. `setGraph()` posts the nodes to an inline Blob Web Worker (`createLayoutWorker`, `scalesAndControls.js:471`). `applyPositions` reconciles the nodes and edges (InstancedMesh edges, one entity per node).
  - Leaving the mode runs `deactivate → disposeView → removeGraph`, which removes the entity, and A-Frame `remove()` terminates the worker.
- **Panel.** The detail card (`tooltipsAndSelection.js`) shows `nodeDetailModel` metrics. Its action button calls `openDirectory` / `openFile` / `publishState({showExternal:true})`.

## 2. Findings

### DEPGRAPH-1: Directory/parent card metrics are sums of per-file metrics: Fan-out, Degree, Relations, Cycle and Instab. are wrong for folders
- Severity: major  - Type: bug
- Evidence:
  - `apps/vscode-extension/templates/components/codexr/dependency-graph/dependencyGraphRuntime/datasetProjection.js:271-275`. `addNodeMetrics` adds every per-file metric key, including `fanIn`, `fanOut`, `degree`, `relationCount` and `cycleSize`, into the aggregate: `target.metrics[metric] += Number(source?.metrics?.[metric] || 0);`
  - It is used for child directories (`:328`) and for the `..` parent, which receives the whole rest of the project (`:333-334`).
  - `scalesAndControls.js:171-186` computes `Instab.` from those sums.
  - Per file, Python defines `fanIn=len(incoming)`, `fanOut=len(outgoing)` (distinct neighbours), `degree=len(incoming|outgoing)` and `relationCount` = edge records touching the file (`backend/src/utils/dependency_analysis_engine.py:343-375`).
- What the screenshot's numbers mean:
  - Fan-in 46 / Fan-out 1773 / Degree 1819 / Relations 1997 is internally consistent as a sum. Degree = 46+1773 because no file has a neighbour in both directions. Relations > Degree because one neighbour can be reached by several relation kinds (import + call), and each kind is an edge record.
  - But the numbers do not describe the folder:
    - Fan-in/fan-out count edges between files *inside* the folder.
    - The same external package is counted once per file.
    - They include `call` relations, which are hidden by default (DEPGRAPH-2 explains why those dominate).
    - They count once more on top of the external summary that the table shows.
  - `Cycle` is the sum of SCC sizes, which is meaningless for a folder.
- Reproduced on this repo's `apps/vscode-extension/src` (291 files, real engine, `run_dep.py` + script in the scratch dir):

  | folder | card Fan-in / Fan-out / Degree / Relations / **Cycle** / Instab. | real folder-level distinct out / in neighbours (no calls) |
  |---|---|---|
  | `app` (7 files) | 9 / 150 / 159 / 183 / **416** / 94% | out 7 / in 1 |
  | `core` (157) | 585 / 4072 / 4652 / 5175 / **5516** / 87% | out 109 / in 3 |
  | `features` (114) | 246 / 2334 / 2580 / 2922 / **4784** / 90% | out 65 / in 3 |

- Failure scenario: open any folder card. The user reads "Cycle 416" for a 7-file folder, and Fan-out/Instab. values that do not match the edges drawn to that box.
- Confidence: CONFIRMED (numbers computed from the real engine output with the runtime's own summation rule).
- Proposed fix:
  - In `projectDirectoryScope` (and `projectFileScope`'s "Other project files" node), stop summing graph metrics. Derive the aggregate's `fanIn`/`fanOut`/`degree`/`relationCount` from the projected boundary edges (`aggregateProjectedEdges` already builds them): count distinct source/target aggregates, respecting `relationFilters` and `showExternal`.
  - Keep `totalLines` as a sum and add a `files` count.
  - For `cycleSize`, use the largest SCC touching the folder, or "files in cycles", and label it as such.
  - Recompute after `filteredDataset()` applies the filters, so a card matches what is on screen.
  - Test: a unit test in `test/analysis/dependencyGraph.test.cjs` on `__testing.projectDirectoryScope` with a 3-file fixture: 2 files in `a/` importing each other plus one external. Assert that the folder node reports fanOut = 1 (external), not 3, and a cycle value of 2 at most.

### DEPGRAPH-2: Unresolved call references become "external packages": `this`, `constructor`, `async`, `super`, built-ins and the file's own function names
- Severity: major  - Type: bug
- Evidence:
  - `backend/src/utils/dependency_analysis_engine.py:816-836`. `_resolve_edge_counts` treats every relation the same way: `if not target_id: target_id = _ensure_external_node(reference, external_nodes, nodes)`.
  - The file-scope variant correctly drops unresolved calls (`:536-541`: `if not target_id: continue`).
  - `CALL_PATTERN = r'\b([A-Za-z_][\w.]*)\s*\('` with `CALL_KEYWORDS` (`:60-64`) also matches definitions (`def f(`, `function foo(`, `constructor(`).
- On `apps/vscode-extension/src`:
  - 2,450 external nodes for 291 files.
  - 5,190 of the 5,846 external edges are `call/ambiguous`.
  - The top "packages" are `this` (145), `getLogger` (138), `constructor` (137), `String`, `error`, `Date`, `Array`, `map`, `JSON`, `async`, `super`...
- A Python fixture `pkg2/views.py` with `def f(): ...` produces `views.py -> EXT:f call ambiguous`.
- Consequences:
  - fanOut/degree/instability of every file is inflated, and DEPGRAPH-1 multiplies that for folders. This is the main reason for "Fan-out 1773".
  - The hidden-external summary card reports "2450 hidden packages".
  - `External: shown` puts thousands of junk nodes on the table (DEPGRAPH-5).
  - Calls are filtered *off* by default (`DEFAULT_RELATION_FILTERS.call=false`), but the metrics still count them.
- Confidence: CONFIRMED (engine output, `cmp.py` / inline scripts in the scratch dir).
- Proposed fix:
  - In `_resolve_edge_counts`, drop a `call` whose reference does not resolve to an internal file, the same way file mode does. At least do not create external nodes for calls.
  - Skip definition sites in the lexical call extractor (preceded by `def|function|func|fn|fun|sub` or a method-declaration context), and add `this|super|constructor|async|await|new|typeof|...` to `CALL_KEYWORDS`.
  - Consider computing the stored `fanIn`/`fanOut` without `call`/ambiguous relations, or exposing both.
  - Test:
    - `backend/tests/dependencies/test_dependency_analysis.py`: a TS + Python fixture with `constructor(`, `this.x(`, `def f(`. Assert no external node with those labels.
    - Update `test_dependency_golden.py`.

### DEPGRAPH-3: Import resolution ignores the importing file's directory and depends on PYTHONHASHSEED. Wrong edges are marked `exact`, and edges flip between runs
- Severity: major  - Type: bug
- Evidence:
  - `backend/src/utils/dependency_analysis_engine.py:625-636`. `_normalize_reference` returns `list({value, without_suffix, dotted, stem})`, a **set**, so the key order follows hash randomisation.
  - `_first_match` (`:378-380`) returns the first key found.
  - `lookup.setdefault(key, node_id)` (`:893-894`) maps every stem (`util`, `index`, `types`, `models`) to the alphabetically first file with that stem in the whole project.
  - Relative specifiers (`./util`, `../x/util`, Python `.models`) are never joined with the importer's directory.
  - `ExecutePython` sets no `PYTHONHASHSEED` (grep finds none), and every refresh is a new process.
- Reproduced:
  - Fixture `fixture-stem/`: `a/util.ts`, `b/util.ts`, `c/util.ts`, `c/main.ts: import {z} from './util'`, `c/alias.ts: import {y} from 'b/util'`.
    - Seeds 0-7: `c/main.ts -> a/util.ts` every time, which is the wrong file, marked `import exact`.
    - `c/alias.ts -> a/util.ts` for seeds 0,1,2,6,7 and `-> b/util.ts` for seeds 3,4,5, so the result depends on the seed.
  - `c/typed.ts: import type {T} from './types'` produces a bogus external package `type`. On this repo, `type` is the 6th most common "package" with 24 edges.
  - Python `from .models import X` becomes external package `.models` (fixture `fixture-py/`).
  - On this repo's `src` the stems happen to be unique, so 1,040/1,040 relative imports resolved correctly. Projects with `index.ts`, `utils.*`, `types.*` or `__init__.py` in several folders get wrong, cross-folder edges. That creates false cycles (feeding DEPGRAPH-1's Cycle value) and false fan-in on whichever file sorts first.
- Failure scenario:
  - A user analyses a typical TS/JS/Python project: the graph shows `src/feature/x.ts → src/aaa/index.ts` instead of its sibling `index.ts`.
  - After each save (incremental refresh = new Python process), some edges can jump to another target. Edge ids are hashes of source/target/kind (`_build_edges`), so the reconciliation animates edges disappearing and appearing with no code change.
- Confidence: CONFIRMED (fixtures above; `PYTHONHASHSEED=0..7 venv/bin/python run_dep.py fixture-stem f$s.json`).
- Proposed fix (`dependency_analysis_engine.py`):
  1. Make `_normalize_reference` order-stable (`list(dict.fromkeys([...]))`) with explicit priority: full path, then without suffix, then dotted, then stem last.
  2. Resolve relative specifiers first against `posixpath.dirname(importer)`, trying the language's extensions and `index.*` / `__init__.py`. Only fall back to the global stem lookup when that fails, and downgrade the confidence to `probable`.
  3. Strip the `type` modifier in TS `import type`/`export type` before resolution.
  4. Pass `PYTHONHASHSEED=0` in the spawn env (`executePython.ts` `spawnAndCollect`) as a belt-and-braces measure.
  - Tests: a golden fixture with duplicate stems, run under two `PYTHONHASHSEED` values in `backend/tests/dependencies/` with `subprocess`, asserting byte-identical edge lists and the sibling target.
  - This resolves the REPORT §9 item "edge target picked from a set". **It is user-facing, not just a quirk.**

### DEPGRAPH-4: The entity's `datasetUrl` and `scope` drift apart, so a reload, a late joiner or a collaborator gets an empty table with no error
- Severity: major  - Type: bug
- Evidence:
  - `dependencyGraphBridge.ts:208-231`. A file-scope request sets `datasetUrl: /dependencies/dependency-scope-<rev>.json` with **no** `projectDatasetUrl`.
  - `handleDependencyGraphSettingsMessage` (`:179-205`) changes `scope` but never `datasetUrl`.
  - In the browser, `openFile` reuses a locally cached dataset and only publishes `scope` (`scalesAndControls.js:8-14`).
  - `filteredDataset()` (`datasetProjection.js:383-387`) returns `{nodes:[],edges:[]}` when the dataset type does not match the scope.
  - The only escape is the refresh path, which does add `projectDatasetUrl` (`dependencyGraphBridge.ts:363-376`).
- Reproduced in the real runtime (harness `run.cjs s1`, `run5.cjs`):
  - Directory scope + project dataset: 7 nodes. `openFile('core/dependencies/dependencyGraphService.ts')`: 14 nodes. "Go to parent" (`openDirectory('core/dependencies')`): 4 nodes. The server entity is now `{datasetUrl:'/s/scope-file.json', scope:{kind:'directory',relativePath:'core/dependencies'}}`.
  - Reloading the page with that entity: **0 nodes**, `state.dataset.targetType=file`, `projectDataset=false`, breadcrumb "Folder: core/dependencies", no error.
  - The reverse case: entity `scope=file`, `datasetUrl=project` (what a cached `openFile` publishes after a refresh) also gives **0 nodes**.
  - `start()` does not help: the cached-URL "restoring" path republishes the same `datasetUrl`. Only "Re-analyze" (forceFull) recovers.
- Failure scenario:
  - Drill into a file, go back up, then reload the browser tab, enter VR on another device, or have a colleague join: the dependency table is empty.
  - In collaboration, participant A opens a file it had cached. Participant B (no cache) shows an empty table, because B never fetches the file dataset.
- Confidence: CONFIRMED (Playwright harness with the real assembled `dependencyGraphRuntime.js`; the fake server mirrors the bridge's merge rules).
- Proposed fix:
  - Keep **both** URLs in the entity at all times: `projectDatasetUrl` (set by every directory analysis, and kept by the file-scope request) and `fileDatasetUrls[path]` or `fileDatasetUrl` for the active file scope.
  - Have `applySharedState` fetch the dataset that matches `snapshot.scope`. Fall back to `projectDatasetUrl`, and when a file dataset is missing, send `dependency-file-scope-request` instead of rendering empty.
  - In `filteredDataset`, if the selected dataset is missing, show a status ("Loading file symbols...") and request it. Never render an empty graph silently.
  - Server side: `handleDependencyGraphSettingsMessage` should not accept `scope.kind:'file'` unless that file's dataset exists, or should trigger `analyzeFileScope` itself.
  - Test: extend `test/runners/run-xr-mode-cycle-harness.cjs` with the S1c and S6 scenarios (entity with mismatched scope/datasetUrl → expect nodes > 0), plus a bridge unit test asserting that `projectDatasetUrl` survives a file-scope request.

### DEPGRAPH-5: No 600-node / 2,000-edge render budget exists, and the force-3d "layout" piles every node past the 16th onto one circle
- Severity: major  - Type: bug / ux (docs mismatch)
- Evidence:
  - `apps/vscode-extension/docs/features/DEPENDENCY_GRAPH_XR.md` ("The runtime limits a rendered view to 600 nodes and 2,000 edges. Larger datasets open in group mode") does not match the code.
    - No limit exists anywhere in `dependencyGraphRuntime/*`. The only `600` is a density score divisor in `dependency-visual-budget/dependencyVisualBudgetRuntime.js:52`.
    - There is no "group mode".
  - `setGraph` creates one `a-entity` per node.
  - The worker's force-3d branch (`scalesAndControls.js:480`): `radius=Math.min(Math.min(w,d)*.45, .28+ring*.22)` with `ring=floor(sqrt(i))`. That reaches the cap of 1.0575 at ring 4, so every node with index ≥ 16 sits on the same radius-1.06 circle, varied only by 5 y-levels. Edges are ignored, so there is no force at all, and a 2.1-wide disc is used on a 4.7×2.35 table.
- Reproduced (harness `run.cjs s2`, real runtime, this repo's `src` dataset at the project root with `External: shown`, a single click):
  - 2,456 node entities, 2,669 DOM entities under the graph root.
  - **2,440 nodes on the same ring**.
  - Profile `dense`, where edge opacity drops to 0.02-0.06.
  - No notice to the user.
  - With hidden externals the same root shows 7 nodes. A flat folder with N files shows N nodes, also uncapped.
- Failure scenario: the user clicks the orange external-summary node, then "Show external" (`tooltipsAndSelection.js:120`). The headset has to render thousands of entities in a solid ring, frame time collapses on Quest-class devices, and nothing says the view is degraded.
- Confidence: CONFIRMED (counts and positions read from the component; timing on a headset not measured).
- Proposed fix:
  - Enforce the documented budget in `filteredDataset()`. Rank nodes by degree, keep the top 600 and the edges among them, and replace the rest with one aggregate "N more" portal node (reuse `createAggregateNode`). Show a status line "Showing 600 of 2,456 nodes".
  - For externals, cap to the top-K packages by occurrences.
  - Replace the force-3d placement with a real bounded layout that uses the table's aspect ratio: a few hundred iterations of a simple force simulation in the worker, or at least a Fibonacci spiral whose radius grows with sqrt(i/N) up to the table bounds in x and z separately.
  - Tests: a unit test on a `filteredDataset`-level budget function (2,000 synthetic nodes gives ≤ 600 + 1). A harness assertion that the number of distinct radii is > 20 for 300 nodes.

### DEPGRAPH-6: One Web Worker leaks on every entry into dependency mode
- Severity: minor (accumulates over a session)  - Type: bug
- Evidence:
  - `viewLifecycle.js:15-18`. `renderGraphWhenReady` calls `component.setGraph` as soon as `refs.graph.components[COMPONENT]` exists, which is **before** A-Frame has run `init`.
  - `setGraph` calls `this.ensureWorker()` (`componentCore.js:241`), which creates worker #1 because `this.worker` is undefined.
  - Then `init` runs: `this.worker = null; ... this.ensureWorker();` (`componentCore.js:6, 51`) overwrites the reference with worker #2 without terminating #1.
  - `remove()` only terminates #2. The pre-init `pendingGraph` is also wiped, so the first layout pass is wasted, and the `componentinitialized` listener renders again.
  - Each leaked worker also keeps its Blob URL, which is never revoked (`scalesAndControls.js:483`).
- Reproduced (harness `run3.cjs s3`, Worker constructor instrumented). Three enter/leave cycles give workers `created 2/4/6, terminated 1/2/3`. The stack traces show creation #1 from `setGraph ← renderGraphWhenReady ← applySharedState ← performTransition`, and #2 from `init ← initComponent`.
- Failure scenario: a long session switching between analyses accumulates one idle thread plus its heap per entry. On a standalone headset that adds memory pressure.
- Confidence: CONFIRMED.
- Proposed fix:
  - In `init`, terminate any existing worker (`this.worker?.terminate?.()`) instead of nulling it. Better: make `renderGraphWhenReady` require `component.initialized === true` (or `refs.graph.hasLoaded`) before calling `setGraph`, so the retry loop and the `componentinitialized` listener do their job.
  - Revoke the Blob URL right after `new Worker(...)`.
  - Add `worker.onerror`, which today is absent. A throw in the worker (for example a node without `metrics` in metric-space) leaves `pendingGraph` unresolved and the old graph frozen, with no status.
  - Test: a harness assertion that `created - terminated <= 1` after N cycles, and `=== 0` once the graph root is gone.

### DEPGRAPH-7: Re-entering the mode while a refresh runs strands the user in the selector, and the 20 s watchdog falsely reports "did not respond"
- Severity: minor  - Type: ux / robustness
- Evidence:
  - `viewLifecycle.js:134-135, 154-201`. `selectDependencyMode` only short-cuts when the snapshot is `ready`. With status `analyzing` it calls `start()`, which hops to `selection` first.
  - The server refuses with "A dependency analysis is already running." (`dependencyGraphBridge.ts:315-320`, pinned by the bridge test).
  - The later `ready` entity is ignored because the mode is no longer dependency (`applySharedState` early return, `:97-100`).
  - Separately, `setTransitionLocked(true)` arms a 20 s watchdog (`datasetProjection.js:93-113`). `dependency-graph-progress` messages do not refresh it, so any first analysis over 20 s shows the red "The dependency analysis did not respond. Try again." while it is progressing.
  - While locked, `publishState` (`datasetProjection.js:404`) silently drops every navigation, filter or "Open folder" click.
- Reproduced (harness `run5.cjs` S5, entity `analyzing` + busy server):
  - After the click: `mode:selection, nodes:0`, error status.
  - After the refresh publishes `ready`: still `mode:selection, nodes:0`. The user must click Dependencies again.
  - The watchdog case was traced in code. A full deep scan of `apps/vscode-extension` (550 files, 6,172 nodes) took 38 s wall-clock here under load, so >20 s is realistic.
- Failure scenario: in dependency mode, save a file (refresh starts), switch to Normal and back. The user lands on the analysis selector with an error, although the graph will be ready seconds later.
- Confidence: CONFIRMED (stranding) / LIKELY (watchdog false alarm).
- Proposed fix:
  - In `selectDependencyMode`, treat `status:'analyzing'` with a known `datasetUrl` (or any `analyzing`) as "attach": call `activateReadySnapshot`-like logic that enters the mode, shows progress, and renders when `ready` arrives.
  - On the server, when busy, answer by activating the view and returning the current entity instead of an error.
  - Re-arm or extend the watchdog on every `dependency-graph-progress` and on `analyzing` snapshots.
  - Show "Busy: please wait" when `publishState` is dropped.
  - Test: a harness scenario S5 asserting final `mode === 'dependency-graph'` and nodes > 0.

### DEPGRAPH-8: Browser file-scope cache is never invalidated, so re-opening a file after edits shows stale symbols
- Severity: minor  - Type: bug
- Evidence:
  - `scalesAndControls.js:11-14`. `openFile` publishes the scope without asking the server when `state.fileDatasets[path]` exists.
  - `state.fileDatasets` is only ever added to (`viewLifecycle.js:67-70`). It is not cleared on a new project `revision`/`sourceRevision`.
  - The server cache keys by content hash (`dependencyGraphService.ts:82-84`), but it is bypassed here.
- Failure scenario: drill into `a.ts`, go up, edit `a.ts` (the directory refresh runs), then open `a.ts` again. The old symbols and calls are shown. This compounds with DEPGRAPH-4 for other participants.
- Confidence: LIKELY (traced; the same code path that S6 exercised).
- Proposed fix: key `fileDatasets` by `(path, project sourceRevision)` or clear it whenever a new directory dataset with a higher `sourceRevision` is stored. Always send `dependency-file-scope-request` (the server answers from its hash cache cheaply). Test: a vm unit test in `dependencyFileScope.test.cjs`.

### DEPGRAPH-9: Analysis jobs cannot be cancelled or timed out, and dataset revisions accumulate in the served folder and in exports
- Severity: minor  - Type: robustness
- Evidence:
  - `DependencyGraphService.dispose()` only nulls `activeJob` (`dependencyGraphService.ts:71-74`). `executeDependencyAnalysis` has no timeout (`executePython.ts:85-111`).
  - Leaving the mode does not stop Python. A hung parse would keep `isBusy()` true, so every later start answers "already running" until the extension restarts.
  - Every refresh writes two pretty-printed copies (`dependency-graph-<rev>.json` + `dependency-graph.json`; 6.2 MB for the extension folder) and never deletes older revisions or `dependency-scope-*.json`. With live refresh on every save this grows without bound and is copied into exports (`exportPackageTransaction.ts` only removes the whole folder when the mode is not selected).
- Confidence: LIKELY (traced).
- Proposed fix:
  - Pass an AbortSignal/timeout through `executePythonScript` and kill the child on dispose or mode exit if no one waits.
  - Keep the last two revisions plus the active scope file and delete older ones after publishing.
  - Write compact JSON.

### DEPGRAPH-10: File node ids collide on case-sensitive filesystems
- Severity: minor  - Type: bug
- Evidence: `_node_id("file", relative.lower())` (`dependency_analysis_engine.py:880`). The lookup keys are lower-cased too.
- Reproduced: `Util.ts` and `util.ts` in one folder both get `file:22d7d69277642e62`. Duplicate node ids break the reconciliation keyed by id.
- Confidence: CONFIRMED (`fixture-case/`).
- Proposed fix: hash the exact relative path, and keep case-folding only for resolution keys on case-insensitive platforms.
- On "Windows paths in node ids": not an issue. The engine uses `_portable_relative` (forward slashes), the bridge rewrites `\` to `/`, and the runtime's `normalizeRelativePath` does the same.

### DEPGRAPH-11: REPORT §9 item "shared-state fetch does not check snapshot identity": low user impact
- Severity: minor  - Type: robustness
- Evidence: `viewLifecycle.js:77-88`. `loadProjectDataset` checks only `isLoadCurrent` (load and view generation), not `state.snapshot === snapshot`.
- A newer `ready` snapshot always bumps `datasetLoadGeneration`, so the stale result is discarded. A newer non-ready snapshot (`analyzing`) does not, but then `renderGraph()` refuses to render (`status !== 'ready'`). The worst case is a briefly older `projectDataset` that the next `ready` snapshot overwrites.
- Not a user-facing bug today. Fix it together with DEPGRAPH-4 by adding the identity check.
- Confidence: LIKELY (traced).

### DEPGRAPH-12: Test gaps
- Severity: minor  - Type: test-gap
- No test covers:
  - folder card metrics;
  - external-node creation from calls;
  - relative or duplicate-stem resolution, or determinism across hash seeds;
  - scope/datasetUrl consistency after drill-down plus reload;
  - worker create/terminate balance;
  - any node or edge budget;
  - re-entry while busy.
- `dependencyGraph.test.cjs` even pins the missing identity check "as-is".
- The scratch harness (`build.cjs`, `run.cjs`, `run5.cjs`) shows that extending `test/manual/xr-mode-cycle-harness.html` with the following is enough to make S1c, S2, S3, S5 and S6 CI checks:
  - a configurable `dependencyState` (`window.__DEP_STATE`);
  - a `dependency-graph-settings` / `dependency-file-scope-request` echo;
  - a busy flag.

## 3. Architecture recommendations (for the unified launcher and the unified chart rebuild)

- **One analysis-session contract per mode.** Dependency mode mixes three channels: the `analysis-view` entity (which mode), its own entity (status + `datasetUrl` + view settings), and local caches (`projectDataset`, `fileDatasets`).
  - For the unified launcher, each mode should expose the same lifecycle: `canAttach(snapshot)` → `activate` → `render(dataset)` → `deactivate`, plus a status machine `idle | analyzing | ready | error`.
  - Entering a mode while it is `analyzing` should *attach* (DEPGRAPH-7), never restart or refuse.
  - The server entity should always carry every URL needed to rebuild the current view from scratch (DEPGRAPH-4). Treat "late joiner / reload reproduces the same view" as an acceptance test for every mode.
- **Budget and containment in the projection step, not the renderer.** `filteredDataset()` is the natural single place for the unified "rebuild inside the table" mechanism: project → filter → **budget (cap + aggregate)** → layout within `{width, depth, height}` from the table runtime → render.
  - Pass the table bounds in instead of the hard-coded `GRAPH_WIDTH/DEPTH`, root position `0 1.02 -18` (`tooltipsAndSelection.js:345`) and `rig` reset coordinates (`viewLifecycle.js:40`), so the graph follows the analysis-table component like the other charts.
- **Metrics belong to the projection.** Aggregated nodes need metrics computed from the projected edge set (DEPGRAPH-1). Do the same for "Other project files", the parent node and the external summary, so that the cards always describe what is drawn.
- **Worker ownership.** Create the worker lazily from the projection or render service (one per page, revocable Blob URL, `onerror` → status + unlock) rather than inside a component instance that can be called before `init` (DEPGRAPH-6).
- **Engine determinism as a contract.** Add a golden test that runs the engine twice under different `PYTHONHASHSEED` values and asserts identical output. Edge ids are the reconciliation keys, so instability shows up as visible churn in XR.

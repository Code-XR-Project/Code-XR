# Verification: area "depgraph" (DEPGRAPH-1..12) on v1.2.1 @ 6f827a19

Scratch dir: `<scratch>/depgraph/`. It holds the venv built from `backend/requirements.txt`, the fixtures in `fx/`, the probes `run_dep.py`, `cmp.py`, `show.py`, `resolve_check.py` and `folder_card.cjs`, and the browser harness `build.cjs` + `run.cjs` + `server.cjs`, with the served files in `h/`.

The browser harness is a copy of the current `test/manual/xr-mode-cycle-harness.html`. It is patched in three ways so it behaves like the real server:
- The `dependency-graph-settings` handler follows the real bridge's merge rule (`scopeWithItsDataset`). The repo's own harness just runs `Object.assign`.
- The file-scope request sets `datasetUrl` the same way the bridge does.
- `window.__BUSY` makes `dependency-graph-start` answer "already running", and `window.__SILENT` makes it accept the start and then never answer.

It runs the real assembled runtimes on a dynamic port, offline through `harnessBrowser.cjs`. Nothing in `/home/user/Code-XR` was modified; `git status` is clean.

| ID | Sev | Verdict | Evidence (short) |
|---|---|---|---|
| DEPGRAPH-1 | G | FIXED (verified by run) | `folder_card.cjs` runs the real runtime's projection, budget and `aggregateMetricsFromEdges` + `nodeDetailModel` on the real engine output for `apps/vscode-extension/src` (300 files). Card values now equal distinct boundary neighbours computed independently from raw edges: app Fan-out 4 / Fan-in 1 (truth 4/1), core 4/3 (4/3), features 4/3 (4/3), platform 1/4 (1/4), shared 1/2 (1/2). "Cycle" is replaced by "In cycles" (core 48 of 166 files), and a "Files" row was added. The audit had app 150/9, Cycle 416. |
| DEPGRAPH-2 | G | FIXED (verified by run) | On `src`: 30 external nodes (audit: 2,450). External `call` edges: **0** (audit: 5,190). The top externals are real modules: vscode, path, fs, crypto, http. The `calls.ts` fixture (`constructor(`, `this.go(`, `super.`, `String(`, `function foo(`) and Python `def f()` give no external node. Some lexical noise remains in non-call relations; see "New observations". |
| DEPGRAPH-3 | G | FIXED (verified by run) | Fixture `fx/stem` with `a/ b/ c/util.ts`, `./util`, `b/util`, `import type`, run under `PYTHONHASHSEED` = 0,1,2,3,4,5,6,7,11,42 (env honoured; checked that `-I` would ignore it). Every run gives `c/main.ts -> c/util.ts exact`, `c/alias.ts -> b/util.ts`, `c/typed.ts -> c/types.ts`, with no `type` package. The 10 outputs are byte-identical (one md5). Python `from .models` resolves to `pkg2/models.py`. `backend/` under seeds 0,1,7 is byte-identical. `resolve_check.py` on `src`: 1,073/1,073 relative imports resolve to the correct file. `executePython.ts:454` spawns with `PYTHONHASHSEED: '0'`. |
| DEPGRAPH-4 | G | FIXED (verified by run) | Harness S1, with the bridge-faithful merge: project, then `openFile('src/analysis.ts')`, then `openDirectory('src')`. The entity left behind is `{datasetUrl: project, projectDatasetUrl, fileDatasetUrl, scope: dir src}`. Reloading with it gives 5 nodes (audit: 0). A late joiner in file scope gets 4 nodes, targetType file. A drifted legacy entity (scope=file, datasetUrl=project, no file dataset) sends a `dependency-file-scope-request` and renders 4 nodes instead of an empty table. Bridge unit test "a scope enters the room only with the dataset that draws it" passes. |
| DEPGRAPH-5 | G | FIXED (verified by run) | Harness S2, flat folder of 2,456 files and 4,910 edges: 600 nodes, 1,613 edges, notice "Showing 600 of 2457 nodes and 1613 of 4910 relations (render budget)...". There are 398 distinct radii (audit: 2,440 on one ring), and 0 nodes lie outside the 4.7x2.35 table. `core/server` with externals shown: 54 nodes, 53 radii. The docs now name `RENDER_BUDGET` (DEPENDENCY_GRAPH_XR.md:154). |
| DEPGRAPH-6 | m | FIXED (verified by run) | Harness S3, Worker constructor instrumented, three enter/leave cycles: created/terminated 1/1, 2/2, 3/3, so 0 are live once the graph root is gone (audit: 2/1, 4/2, 6/3). The Blob URL is revoked (`scalesAndControls.js:513`), `worker.onerror` is set (`componentCore.js:93`), and `setGraph` is gated on `initialized` (`viewLifecycle.js:10-12`). |
| DEPGRAPH-7 | m | PARTIAL | Both headline defects are fixed by run. Harness S5 (entity `analyzing`, server busy): after the click, mode is `dependency-graph` with progress text, not the selector; after `ready` it shows 7 nodes. Harness S7 (start accepted, progress every 5 s for 30 s): no "did not respond", still locked, last progress shown. Not fixed: `publishState` still drops clicks silently while locked (`datasetProjection.js:502`), and the server still refuses a start while busy (`dependencyGraphBridge.ts:347-352`); the client now attaches instead of starting, which avoids that refusal. |
| DEPGRAPH-8 | m | FIXED (verified by run) | Harness S1: after a new project revision, reopening the same file sends a second `dependency-file-scope-request` (count 1 to 2). The unit test "a new project revision drops the cached file datasets" passes. |
| DEPGRAPH-9 | m | FIXED (verified by code reading + unit tests) | Job timeout of 10 min and cancel-on-dispose: `dependencyGraphService.ts:12,17-19,87-90`. The work runs under `runWithLaunchSignal` (`jobRunner.ts:228`). `jobRunner.test.cjs` 8/8 pass, including timeout, cancel and the grace period for work that ignores the abort. Compact JSON and `pruneDatasetRevisions`, which keeps 2 per prefix (`dependencyGraphService.ts:178-181, 231-234, 289-317`), are tested in `dependencyFileScope.test.cjs`. Leaving the mode still does not kill Python, but the timeout frees the slot. See the observation on pruning order below. |
| DEPGRAPH-10 | m | FIXED (verified by run) | `fx/case`: `Util.ts` -> `file:51fbde309d8797ba`, `util.ts` -> `file:22d7d69277642e62`, which are distinct (audit: the same id). |
| DEPGRAPH-11 | m | FIXED (verified by code reading + unit test) | `loadProjectDataset` checks `state.snapshot === snapshot` both before and after `json()` (`viewLifecycle.js:119-121`). The characterization test "project after snapshot replaced" now drops the stale dataset and passes. |
| DEPGRAPH-12 | m | FIXED (verified by run) | New `dependencyGraphS13.test.cjs` covers folder card, budget, radii, Blob URL, init gate, scope URL and cache. `test_dependency_resolution.py` covers resolution and runs three hash seeds in subprocesses; 41/41 backend dependency tests pass. The mode-cycle harness has four dependency scenarios, and `run-xr-mode-cycle-harness.cjs` passes. Residual gap, minor: the repo harness's settings echo is a plain `Object.assign` (not the bridge rule), and its start never answers "busy", so the go-to-parent-then-reload drift and the real busy refusal are only covered by the bridge unit tests plus this verification harness. |

## Still failing / partial

**DEPGRAPH-7 (PARTIAL, minor).** Re-entry while analyzing now attaches, and progress re-arms the 20 s watchdog; both were verified. One part of the evidence and of the proposed fix remains. While the transition lock is held, for example during "Re-analyze" (`reanalyze()` locks until the answer), `publishState` returns early with no feedback (`templates/components/codexr/dependency-graph/dependencyGraphRuntime/datasetProjection.js:501-502`). Navigation, filter and "Open folder" clicks vanish. On the server side the start is still refused while busy, but the client no longer triggers that refusal in the re-entry case.
- Proposed issue title: "Dependency graph: clicks during a re-analysis are silently dropped; show 'Busy, please wait'".

## New observations (not audit findings; minor, for triage)

1. **The engine still creates junk externals from inheritance/implementation regexes.** These are not calls, so they are outside DEPGRAPH-2.
   - Python `class B(A): pass` and `class X: pass` give `-> EXT:pass inheritance probable` (fixtures `fx/py`, `fx/py2`).
   - On `src` the same thing produces `string>`, `HttpsServerBaseConfig>`, `any`, `object`, `scheme`, and a `require` target `|` (`core/dependencies/dependencyGraphModels.ts`).
   - Cause: the `INHERITANCE_PATTERNS[0]` `:[ \t]*` branch (`backend/src/utils/dependency_analysis_engine.py:60-62`). This regex predates the S13 fix.
   - Proposed title: "Dependency engine: Python `class X: pass` and TS generics produce bogus inheritance externals".
2. **Possible risk in DEPGRAPH-9 pruning (inferred, not reproduced).** `pruneDatasetRevisions` keeps the numerically highest two revisions. `DependencyGraphService.revision` restarts at 0 for each service instance. If a service is ever re-created on a `staticRoot` that already holds higher-numbered files, the file it just wrote would be pruned at once, and the room entity would point to a 404. Session folders use a fresh nonce per session (`sessionRegistry.ts:162-176`), so this is only reachable if a server is restarted on an existing session folder; I did not confirm such a path. Suggestion: seed `revision` from the max on disk, or prune by mtime.

## Commands run

- `python3 -m venv venv && venv/bin/pip install -r /home/user/Code-XR/backend/requirements.txt` (lizard 1.17.31, tree-sitter-language-pack 1.8.1); `pip install pytest`.
- `for s in 0 1 2 3 4 5 6 7 11 42; do PYTHONHASHSEED=$s venv/bin/python -s run_dep.py fx/stem seed_stem_$s.json; ... fx/py ...; done`; `cmp.py seed_*`, `show.py`, `md5sum` gives 10 identical.
  - Note: `python -I` implies `-E`, which ignores `PYTHONHASHSEED`. That was confirmed with `hash('util')`, so the seeded runs use `-s` on my own fixtures. The `-I` runs were random-seed runs and were also identical.
- `PYTHONHASHSEED={0,1,7} venv/bin/python -s run_dep.py /home/user/Code-XR/backend big_$s.json` gives identical md5.
- `venv/bin/python -I resolve_check.py apps/vscode-extension/src cache_src.json` (adapted to exact-path ids): 1073 resolvable, 0 wrong.
- `venv/bin/python -I run_dep.py apps/vscode-extension/src src.json` + the inline external/call counter; `run_dep.py fx/case`.
- `cd backend && venv/bin/python -m pytest -q -p no:cacheprovider tests/dependencies`: 41 passed.
- `node --test test/analysis/dependencyGraph.test.cjs dependencyFileScope.test.cjs dependencyGraphBridge.test.cjs dependencyGraphS13.test.cjs`: 68/68 pass. `node --test test/analysis/jobRunner.test.cjs`: 8/8 pass.
- `node test/runners/run-xr-mode-cycle-harness.cjs`: passed, including the four dependency scenarios.
- `node folder_card.cjs src.json` (DEPGRAPH-1).
- `node build.cjs && node run.cjs {s1,s2,s3,s5,s7}`: the browser harness (DEPGRAPH-4/5/6/7/8).

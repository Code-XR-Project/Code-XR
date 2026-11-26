# Verification: historical comparison (HIST-1..13) on v1.2.1 @ 6f827a19

Paths relative to `apps/vscode-extension/` unless noted. Probes and repos are in
`<scratch>/historical/`.
Fix commits found: 39074545 (S12, #84), bffdc436 (S6, #78), 48d7329d (S8, #80), 45d74f45 (S14, #86). The verdicts below come from runs and reads of the current code, not from those commit messages.

| ID | Sev | Verdict | Evidence (short) |
|---|---|---|---|
| HIST-1 | G | FIXED (verified by run) | `hostloop2.cjs` uses the real compiled `AnalysisFeatureHost` with a refresh that always throws. LivePanel and XR-in-History each made 3 attempts (351/1054/2457 ms), then stopped, sent 1 room `historical-comparison-error` (`comparison-live-refresh-stopped`) and 1 SSE `state:error`, and called `suspendLiveRefresh`. With XR in `single` it made 1 attempt, set the refresh as pending, and resumed on re-entry. Before the fix the same failure made 10 attempts in 3.6 s and broadcast 0 errors. |
| HIST-2 | G | FIXED (verified by run) | Real 230-commit repo (`svc.cjs`). Picked the oldest listed commit (#200), added 5 commits so it left the listing (`still in listing? false`), then refreshed 3 times: all ok, same SHA. `sourceById` is now add-only (gitRepositoryService.ts:118-122). |
| HIST-3 | G | PARTIAL | Real browser (`scen.cjs switch` / `switch2`, h2.html, freshly assembled runtimes). Fixed: bars→cyls keeps `codexrChartDataSlice__codexrComparisonData{Left,Right}`. Still failing: bars→boats gives both clones `babia-boats from:"tree"` with no `tree` entity and data length 0. boats→cyls gives both clones `codexrChartDataSlice__data`, the normal analysis. |
| HIST-4 | G | FIXED (verified by run) | `scen.cjs stale`: re-entry shows `rightSrcUrl:/scratch/right2.json?revision=2`, `resultRight:commit-2` and nameplate `abcdef1`. Before the fix these were revision 1 and `HEAD~1`. `scen.cjs race`: re-entry shows `right2.json?revision=3`. Before the fix it stayed on revision 1. |
| HIST-5 | G | FIXED (verified by run) | `svc.cjs`, big repo (1 top-level file and 5,100 nested): shallow materialize gives `ok files 1 in 155 ms`. Before the fix it failed with `comparison-snapshot-file-limit`. Mid repo, shallow: 1 file in 56 ms (was 8.5 s). Deep materialize over the limit now maps to the typed `comparison-snapshot-limit`. Residual: a deep copy still runs one `git show` per file, so 1,501 files take 10.9 s (`deep.cjs`). |
| HIST-6 | G | FIXED (verified by run, simulated) | `winpath.cjs` runs under a `path.win32` shim with cwd on C:. The `D:\work\proj\src` working copy now keys `file:core/a.ts` and `file:ui/a.ts`, the same as the commit side. Before the fix both collapsed to `file:a.ts`. Fix at gitAnalysisShared.ts:35-49. Real Windows check: manual-test-guide row 4.2. |
| HIST-7 | G | PARTIAL | `cancel.cjs` on the real `HistoricalComparisonService` + `JobRunner` with a comparison that never settles. A second compare gets `comparison-busy`. `cancelComparison()` rejects the job with `comparison-cancelled`, the gate frees within the 5 s grace, and the next compare runs. The 1.5 s job timeout gives `comparison-timeout`. git has a 180 s timeout plus the launch signal (gitRepositoryService.ts:592-631), Python is killed on abort (executePython.ts:460-471), and each revision has a 5 min watchdog. XR sends `historical-comparison-cancel`. Still missing: LivePanel has no cancel (historicalPanel.js has no cancel call and the only routes are `/historical/references` and `/historical/compare`), and leaving the mode does not cancel. |
| HIST-8 | m | PARTIAL | Fixed by code: the snapshot is released in `finally` after each revision (gitAnalysisSessionContext.ts:121-127); revisions older than the previous one are pruned (historicalComparisonService.ts:285-297); every `fs.rm` uses `maxRetries:5`. Not fixed: startup cleanup sweeps only `fileAnalysis`/`directoryAnalysis`/`visualizeDOMAnalysis`/`analysis` (storageFolders.ts:9-22), never `historical-comparisons/`; `dispose()` removes `<session>/snapshots` but leaves the `<session>` folder. |
| HIST-9 | m | FIXED (verified by code reading + run) | The slot is reserved synchronously before any await, and busy goes to the requester alone via `messageContext.send` (historicalComparisonBridge.ts:174-187). `setRefreshEnabled` runs only after success (:224-231). `cancel.cjs` confirms a second compare while one runs gets `comparison-busy`. |
| HIST-10 | m | FIXED (verified by run) | Browser `scen.cjs settle` / `reenter`: status is `""` after render and after re-entry. Before the fix it stayed "Loading comparison datasets...". Typed codes `comparison-reference-gone`, `-snapshot-limit` and `-step-timeout` (historicalComparisonService.ts:30-55) and runtime mapping at compareFlowAndMessages.js:165-185. Cosmetic leftover: an aborted fetch leaves "Loading comparison datasets..." in state while in `single`; re-entry clears it. |
| HIST-11 | m | PARTIAL | Fixed: the picker lists 200 commits (`svc.cjs`: `commits listed 200`). `isDeterministicNoDataError` is false for "JSON markers not found" / "Unable to parse result" and true only for "no JSON/empty payload". Not fixed: no load-more or by-SHA entry, and no indexing progress. The first `filterSources` takes 1,266 ms for 451 sources × 300 files (`tags.cjs`), with only "Loading local Git references...". |
| HIST-12 | m | STILL FAILING | `createChartFromTemplate` still copies every attribute except a blacklist (comparisonCharts.js:151-171), so `data-codexr-normal-root` and `data-codexr-analysis-*` still leak. test/manual/xr-mode-cycle-harness.html still has no `codexrNormalAnalysisRoot` wrapper. With that harness layout (h.html), re-entry still leaves both clones `visible:false` with `transitioning:true` and the status stuck on "Loading comparison datasets..." at +6 s. test/runners/run-xr-mode-cycle-harness.cjs still never runs a comparison. |
| HIST-13 | m | PARTIAL | Fixed: live-refresh failures now reach LivePanel over SSE (`hostloop2.cjs livepanel`: `sse [{state:'error',...}]`). Not fixed: historicalPanel.js:113-165 still waits on SSE alone after the 202, with no `/api/historical/status`, poll or timeout. |

Counts: FIXED 7 (HIST-1, 2, 4, 5, 6, 9, 10) · PARTIAL 5 (HIST-3, 7, 8, 11, 13) · STILL FAILING 1 (HIST-12).

## Still failing / partial

- **HIST-3 (G, PARTIAL).** Flat-to-flat switches now keep the comparison sources (CHARTS-17). Any switch to or from boats is still wrong:
  - bars→boats: both clones get `from:"tree"`, which does not exist in a flat scene, so the boats are empty.
  - boats→flat: both clones fall back to the normal `data` slice, so the two halves show the working copy under LEFT/RIGHT nameplates.
  - The historical runtime has no chart-type hook (no delegate/rebuild found in historicalComparisonRuntime/*.js).
  - Proposed issue: "Historical compare: switching to or from Babia Boats rebinds both comparison clones to the normal analysis (tree/data)".
- **HIST-7 (G→m remaining, PARTIAL).** The core hang is solved (timeouts, XR cancel, gate release). Still missing:
  - LivePanel has no cancel control and no cancel route, so a LivePanel user waits up to the 15 min job timeout with 409s.
  - Leaving History with no result yet does not cancel the job.
  - Proposed issue: "LivePanel historical compare: add Cancel (route + button) and cancel a result-less job on mode leave".
- **HIST-8 (m, PARTIAL).** `historical-comparisons/<session>/` is not in `getSweptStorageFolders()`. Leftovers from a crash or kill are never removed, and the empty `<session>` folder outlives `dispose()`.
  - Proposed issue: "Startup cleanup should sweep historical-comparisons/ (and remove the empty session folder on dispose)".
- **HIST-11 (m, PARTIAL).** The horizon is 200 commits, with no load-more, by-SHA entry, search, or progress during the first eligibility indexing (~1.3 s for 451 refs here; it grows with tags × files).
  - Proposed issue: "Git ref picker: by-SHA / load-more beyond 200 commits and progress while indexing".
- **HIST-12 (m, STILL FAILING).** The clone copy rule is unchanged, the harness is still unwrapped, and the runner has no compare scenarios. This is also why HIST-3's boats path is not caught by CI.
  - Proposed issue: "Build comparison clones from a whitelist, wrap the mode-cycle harness chart like the real template, and add compare/re-enter/chart-switch/parked-update scenarios to run-xr-mode-cycle-harness".
- **HIST-13 (m, PARTIAL).** LivePanel completion still depends only on SSE.
  - Proposed issue: "LivePanel historical: GET /api/historical/status and poll after SSE reconnect so 'Comparing...' cannot hang".
- Residual note on HIST-5: deep snapshots still spawn one `git show` per file (1,501 files in 10.9 s on Linux). `GitBatchObjectReader` is unused there. This is a performance follow-up, not the reported defect.

## Commands run

All with `PATH=/opt/node24/bin:$PATH`, `NODE_OPTIONS` unset, from the scratch dir above. Nothing in the checkout was modified.

- `node hostloop2.cjs`: HIST-1 and HIST-13. Real host under fakeVscode; scenarios: LivePanel, XR in History, and XR elsewhere then re-entry.
- `node svc.cjs`: HIST-5 (repos `big` with 5,101 files and `mid` with 1,501, shallow and deep), HIST-2 and HIST-11 (repo `old`, 230 commits plus 5 new).
- `node deep.cjs`: deep materialize timing.
- `node tags.cjs`: repo `tags` with 300 files, 250 commits and 250 tags; 451 sources.
- `node winpath.cjs`: HIST-6, `path.win32` shim.
- `node cancel.cjs`: HIST-7 and HIST-9 job gate, cancel and timeout.
- Inline `node -e` check of `isDeterministicNoDataError` (HIST-11).
- `node scen.cjs switch|switch2|stale|race|reenter|settle`, plus `H=h.html node scen.cjs reenter`: Playwright, offline via test/helpers/harnessBrowser.cjs, runtimes freshly assembled into scratch with test/helpers/runtimeAssembly.cjs (byte-identical to test/manual/assembled).
- `node --test test/analysis/{historicalStaysCorrect,historicalComparison,historicalComparisonRuntime,livePanelHistorical,gitHistoryServices,gitMaterializeDirectory,gitListReferences,gitAnalysisShared}.test.cjs`: all pass (9/17/5/10/31/6/4/4).

# XR audit: historical comparison (area "historical")

Paths are relative to `apps/vscode-extension/` unless they start with `backend/` or `docs/`.
Scratch evidence (scripts, harness copies, repos) is in
`/tmp/claude-0/-home-user/af5ccea8-f538-575c-b7b6-8256e5a53df6/scratchpad/audit/historical/`.

Area tests run, all green: historicalComparison (16), historicalComparisonRuntime (5), livePanelHistorical (10),
gitMaterializeDirectory (5), gitRefPickerRuntime (7), offlineHistoricalDelta (8), gitHistoryServices (24).
None of the bugs below is covered by them. Most of those tests read source text or stub git.

## 1. How the area works

- **Host.** `AnalysisFeatureHost` (src/core/server/analysis/analysisFeatureHost.ts) builds one `HistoricalComparisonService` per XR or LivePanel session. That service owns:
  - a `GitRepositoryService` with a private snapshot root under `storageUri/historical-comparisons/<session>/snapshots`;
  - a `GitAnalysisSessionContext`, which holds the payload cache per commit and calls `ExecutePython`;
  - a `SingleJobGate`, so only one comparison runs at a time.
- **How a comparison starts.** XR sends the room message `historical-comparison-start` to `HistoricalComparisonBridge.handleHistoricalComparisonStartMessage`. LivePanel uses `POST /api/historical/compare`, which answers 202 and reports progress over SSE.
- **The compare job.** `compare()` runs these steps:
  1. `resolveSource` on both ids. A working-copy id re-lists every reference.
  2. `analyzeSource` on each side. The working copy is read from the live `data.json`. A commit is materialized with `ls-tree` plus one `git show` per file, then analyzed by Python with no timeout.
  3. Each payload is decorated with `filePath` and `comparisonKey` (`decorateDirectoryEntries`).
  4. `buildDelta`, then `staticRoot/comparison/revision-N-{left,right}.json` and `revision-N.json` are written.
  5. The result is upserted as the shared room entity `historical-comparison/main`.
- **Live refresh.** While the active request has a working-copy side, every re-analysis event schedules `refreshHistoricalComparison` (350 ms debounce), which runs the whole comparison again.
- **Browser runtime.** The runtime is `templates/components/codexr/historical-comparison/historicalComparisonRuntime/*`. Its `applySharedState` fetches both datasets, then either:
  - calls `refreshLiveSide`, when the sources are the same and one side is live, or
  - calls `renderComparison`, which clones the scene chart twice (`createChartFromTemplate`) into the `historical-left` and `historical-right` containment zones. Boats get inline trees with the uid namespaces `codexr-left:` and `codexr-right:`; other charts get `babia-queryjson` sources named `codexrComparisonData{Left,Right}`.
- **Leaving and re-entering.** Leaving the mode preserves and hides the comparison root (`parkComparisonGeometry`). Re-entering restores it in place (`restoreComparisonScene`).
- **Source picker.** It is `templates/components/common/codexrGitRefPickerRuntime.js` in compare mode. It is fed by `getReferences()`, which `GitAnalysisSourceCatalog.filterSources` filters through a blob index.

## 2. Findings

### HIST-1: A failed live refresh retries every 350 ms forever and never tells the user
- Severity: major. Type: bug.
- Evidence:
  - src/core/server/analysis/analysisFeatureHost.ts:304-307: `catch (error) { logger.error('...Live refresh failed:', error); this.scheduleHistoricalComparisonRefresh(); }`. There is no attempt limit, no backoff, no error broadcast, and the retry does not check the current view mode. The XR subscription checks `view.mode === 'historical-compare'` (lines 131-134) only for the first event.
  - `scheduleHistoricalComparisonRefresh` (265-277) re-arms itself while `hasLiveSource()` holds. `activeRequest` is never cleared, because nothing calls `forgetLastRequest()` for this service.
  - Each attempt broadcasts `historical-comparison-progress` "Resolving Git references..." to the room (289-294) and spawns about 6 git processes (`listReferences`).
- Failure scenario: compare `feature/x` with the live working copy, merge the branch and delete it, then save a file. Every refresh now throws `unknown-comparison-source`, or `git-command-failed` from `rev-parse --verify` when the old map still has it.
  - The server loops at about 3 attempts per second for the rest of the session.
  - The room keeps receiving "analyzing" progress, and the XR status text flips to "Resolving Git references..." forever.
  - Any compare the user starts in between can hit the `isBusy()` window and get "Another comparison is already being generated."
  - Other permanent triggers: HIST-2, and the snapshot limits in HIST-5. A working copy whose `data.json` becomes `[]` gives `GitAnalysisSourceError`, which loops the same way.
- Confidence: CONFIRMED.
  - `scratch/historical/hostloop.cjs` loads the real compiled `AnalysisFeatureHost` under `fakeVscode` and injects a service whose refresh rejects.
  - One source-change event produced 10 refresh attempts and 10 progress broadcasts in 3.6 s, and 0 error broadcasts.
- Proposed fix (analysisFeatureHost.ts):
  - Retry only on `comparison-busy`.
  - On any other error, broadcast `historical-comparison-error` to the room and send SSE `historical-progress` with state `error` to LivePanel.
  - Stop the live link: add `HistoricalComparisonService.detachLiveRefresh()`, which calls `jobs.forgetLastRequest()`, or a "stale" flag.
  - Also skip the refresh when the XR view is not `historical-compare`, and run it again on re-entry.
- Test: a unit test in a new test/analysis/historicalLiveRefresh.test.cjs that uses `withFakeVscode`. Use the hostloop.cjs pattern and assert that `refreshActiveComparison` is called exactly once, with one error broadcast.

### HIST-2: A commit side becomes unresolvable once it drops out of the 50 most recent commits
- Severity: major. Type: bug.
- Evidence:
  - src/core/history/gitRepositoryService.ts:109-116: `if (sourceId === 'working-copy' || this.sourceById.size === 0) { await this.listReferences(); } ... if (!source) throw new Error('unknown-comparison-source')`.
  - `listReferences()` clears the map (83) and refills it with `log --all --max-count=50` (69-75).
  - Commit ids are `commit-<sha256(sha)>`, so they cannot be resolved without being in that list, even though the SHA is still a valid object.
- Failure scenario: compare the oldest listed commit (#50) with the working copy. Make one commit.
  - The first live refresh still resolves the commit from the old map, because `Promise.all` order lets it.
  - The second refresh fails with `unknown-comparison-source`, which feeds the endless loop in HIST-1.
  - The same happens if any 50 commits land on any branch (`--all`), for example after a fetch, or on a busy remote.
  - A collaborator whose picker is older sends ids that also fail.
- Confidence: CONFIRMED. `scratch/historical/svc2.cjs` runs against a real 56-commit repo and prints "refresh 1 ok / refresh 2 ERR unknown-comparison-source".
- Proposed fix: keep a session-scoped resolved-source registry that `listReferences` adds to and never clears. Alternatively, accept `commit:<sha>` ids and resolve them with `rev-parse --verify <sha>^{commit}` when they are missing from the latest list. Branch and tag ids are already re-verified.
- Test: the gitHistoryServices or historicalComparison unit test builds a real repo with more than 50 commits, resolves the oldest id, commits once, calls `resolveSource('working-copy')` twice, then resolves the old id again.

### HIST-3: Switching chart type in comparison mode points both sides at the normal analysis data
- Severity: major. Type: bug.
- Evidence:
  - The comparison clones become the mapping targets (comparisonCharts.js:334-341). The Field Mapping chart buttons stay active in `historical.mapping`, and nothing locks them (`mappingControlsLocked` applies to evolution playback only).
  - `selectChart` → `applyChartTypeToEntity` → `buildRuntimeChartData` → `getChartFromSource` (xr-chart-mapping-ui runtime, assembled lines 982-996). Two branches go wrong:
    - Hierarchical target (boats): `from` becomes `'tree'` unless the old `from` contains "Tree". Inline `data` is dropped.
    - Flat target coming from boats (no `from`): `from` falls back to `'data'`.
  - The historical runtime does not listen for chart changes, so it never rebuilds its comparison sources.
- Failure scenario: run a comparison with a bars chart, then click "Babia Boats" in Field Mapping.
  - Both clones get `babia-boats from: tree`, which is the normal working-copy tree.
  - Clicking "Cyls" next gives both clones `from: data`.
  - Both halves of the table then show the same working-copy data under the "LEFT: <commit>" and "RIGHT: live" nameplates. The comparison is silently meaningless.
  - In a real bars scene there is no `tree` entity, so the boats clones never build. Containment then reports "still rebuilding" indefinitely, which is the "stuck chart" symptom.
- Confidence: CONFIRMED.
  - Done in a real headless browser with the assembled runtimes (`scratch/historical/scen.cjs switch`, harness `h2.html`). The chart option was clicked through the UI.
  - Output after the clicks: `after switch to boats {"left":{"comp":"babia-boats","from":"tree"},"right":{"comp":"babia-boats","from":"tree"}}`, then `cyls ... "from":"data"` on both sides.
- Proposed fix, which is exactly the "unified chart rebuild" need:
  - Give each mode a chart-construction hook in the mapping runtime, for example `registerChartTypeDelegate(contextId, fn)`, which evolution already half-has (`delegatedEntityApply`).
  - In historical mode, a chart switch should call `renderComparison(state.result, payloads.left, payloads.right)` with the new chart id. That rebuilds both clones from the comparison payloads: inline trees for boats, `codexrComparisonData*` sources (and slices) for flat charts.
  - At minimum, make `getChartFromSource` keep comparison sources and rebuild inline boats data.
- Test: a Playwright scenario, which could be added to `run-xr-mode-cycle-harness.cjs`: Compare → select boats → assert that each clone's data differs and does not use `from: tree`. Then select cyls and assert `from` matches `/Comparison/`.

### HIST-4: A comparison that changes while the mode is parked is applied only to the live side; updates can also be lost
- Severity: major. Type: bug.
- Evidence:
  - liveRefreshAndRegistration.js:183-198 and compareFlowAndMessages.js:268-275. While the mode is not active, `applySharedState` only does `state.result = snapshot.result`. On re-entry, `activate` restores the old geometry and calls `applySharedState(state.result)`.
  - Inside it, `previousResult = state.result`, which is already the new result. So `canRefreshLiveSide(result, previousResult)` (liveRefreshAndRegistration.js:8-21) compares the new result with itself: `sameSources` is always true, and only the live side is refreshed.
  - Second path: compareFlowAndMessages.js:277-293. If the user leaves while the datasets are being fetched, the generation check returns before `state.result` is assigned. The newer result is dropped, and no later message re-sends the entity.
- Failure scenarios:
  - (a) Collaboration: B is in the normal view while A runs a new comparison, working copy vs commit-2 instead of commit-1. B opens History.
    - The right chart still reads commit-1's dataset and its nameplate still says "HEAD~1".
    - The companion table uses commit-1's payload.
    - `getState().result.right` says commit-2.
  - (b) Any client: an update arrives during the enter animation and the user leaves within the fetch. On re-entry the client shows revision 1 forever, while the server holds revision 3.
- Confidence: CONFIRMED in the real browser harness (`scen.cjs stale` and `scen.cjs race`).
  - stale: `re-entered {"rightSrcUrl":"/test/manual/xr-mode-history-right.json?revision=1","resultRight":"commit-2","nameplates":[...,"HEAD~1  -  No commit date"]}`.
  - race: on re-entry, `resultRight:"commit-1"` with `revision=1`.
- Proposed fix (liveRefreshAndRegistration.js and compareFlowAndMessages.js):
  - Track `refs.renderedResult`, the result whose geometry is mounted, separately from `state.result`. Decide `canRefreshLiveSide(result, refs.renderedResult)`, comparing the source ids of both sides.
  - In `applySharedState`, record `state.pendingResult = snapshot.result` before awaiting. On a generation abort, keep it as `state.result`, so the re-entry path re-syncs it.
- Test: add both scenarios to the mode-cycle Playwright runner. The harness already has `CodeXRHarness.apply`.

### HIST-5: Shallow directory comparisons materialize the whole subtree, which fails on large repositories and is slow
- Severity: major. Type: bug.
- Evidence:
  - gitRepositoryService.ts:286-300 always runs `ls-tree -r` and copies every analyzable file recursively.
  - The eligibility index honours `recursive` (gitTimelineBlobIndex.ts:229, `if (this.recursive && ...)`), so the picker shows the revision as usable.
  - `planDirectorySnapshot` (341-347) then throws `comparison-snapshot-file-limit` or `-size-limit` on files that the shallow Python run would never read.
  - `copyPlannedFiles` (359-375) spawns one `git show` per file, one at a time. `GitBatchObjectReader` exists but is not used here.
  - The error is not a `GitAnalysisSourceError`, so the client shows the generic "Historical comparison failed. Please try again." (compareFlowAndMessages.js:264). A retry fails the same way.
- Failure scenario: shallowly analyze the root of a large repository (one top-level `.py` file and more than 5,000 nested files), pick a commit, and press Compare. It fails every time.
  - With 1,500 nested files it works but spends 8.5 s copying files that are never analyzed. On Windows, process spawns cost about 10 times more.
- Confidence: CONFIRMED with `scratch/historical/svc1.cjs` and `svc2.cjs` on real repos:
  - "index shallow eligible files 1" then "materialize ERR comparison-snapshot-file-limit";
  - "1500 nested files materialized for a shallow target in 8501 ms".
- Proposed fix:
  - Pass `isDeep` into `GitRepositoryService.materialize`. For shallow runs, list only the top level (`ls-tree` without `-r`, filtering out tree entries).
  - Better: materialize from the `GitTimelineBlobIndex` plan the catalogue already built, through `GitBatchObjectReader`, so the eligibility rules and the materialization rules are the same code.
  - Map the limit errors to an exclusion, or at least to a specific message.
- Test: in gitMaterializeDirectory.test.cjs, add a case that asserts the shallow materialization writes top-level files only, plus a real-repo test with more than 5,000 nested files that compares successfully.

### HIST-6: On Windows, a working copy on a drive other than the extension host's cwd drive collapses to basenames
- Severity: major. Type: bug.
- Evidence:
  - Python strips drive letters from `filePath` (backend/src/utils/babia_path_utils.py:52-55).
  - `decorateDirectoryEntries` passes that drive-less path to `toPortableRelativePath(analyzedTargetPath, ...)` (src/core/history/gitAnalysisShared.ts:304-310), which calls `path.resolve(candidate)`. On win32 that resolves against the cwd drive, usually C: (the VS Code install).
  - For a target `D:\work\proj\src` the relative path crosses drives, so `path.relative` returns an absolute path, and the code falls back to `path.basename(candidate)`.
- Failure scenario: the repo is at `D:\projects\app`. Compare `src` (working copy) against a tag.
  - The working-copy side keys files as `file:a.ts`, so `core/a.ts` and `ui/a.ts` collide.
  - The commit side (snapshot under C: storage) keys them as `file:core/a.ts`.
  - Every file counts as removed plus added, duplicate basenames are lost, and the working-copy boats tree is flat.
  - Project evolution's working-copy frame and the Git export use the same helper.
- Confidence: LIKELY, reproduced by simulation. `scratch/historical/winpath.cjs` loads the compiled module with `path` set to `path.win32` and cwd set to `C:\...`, and gets `D:` keys `file:a.ts | file:a.ts` against commit keys `file:core/a.ts | file:ui/a.ts`. It needs confirming on a real Windows machine.
- Proposed fix (gitAnalysisShared.ts): normalize both sides to POSIX and drive-less before comparing, using the same rule as `normalize_path_for_babia`. Alternatively, have Python emit a `relativePath` per entry and prefer it.
- Test: a unit test that runs the module under a `path.win32` shim (the winpath.cjs pattern), with D: and C: targets.

### HIST-7: No timeout and no cancel. A stuck git or Python run keeps the mode busy for the whole session
- Severity: major. Type: robustness.
- Evidence:
  - `ExecutePython.spawnAndCollect` (src/core/analysis/python/executePython.ts:438-497) has no timeout and no kill, and `executeAnalysis` uses `withProgress({ cancellable: false })` (161-167). `analyzeSource` does not pass `silent`, so each side shows a non-cancellable notification.
  - `runGit` and `runGitBuffer` (gitRepositoryService.ts:528-572) have no timeout either.
  - `SingleJobGate` stays busy until the promise settles (gitAnalysisSessionContext.ts:255-268).
  - There is no `historical-comparison-cancel` message. The router handles only references and start (analysisMessageRouter.ts:89-92), while evolution has `cancellationRevision`.
  - Leaving the mode does not abort the job.
- Failure scenario: a revision with a pathological file makes lizard run for minutes, or `git status` stalls on a huge working tree or network drive (OneDrive, an SMB share).
  - XR shows "Analyzing <side>..." with no way out.
  - Every later Compare gets "Another comparison is already being generated." (409 in LivePanel).
  - The live refresh polls `isBusy` every 350 ms indefinitely (analysisFeatureHost.ts:284-287).
- Confidence: LIKELY (traced in code, not reproduced).
- Proposed fix:
  - Add an `AbortSignal` through `compare` → `analyzeSource` → `ExecutePython` (`child.kill()`) and through git (`execFile` `timeout` and `signal`).
  - Add a `historical-comparison-cancel` room message and a LivePanel cancel button. Cancel on mode leave when no result exists yet.
  - Add a per-side timeout, for example 5 minutes, reported as a specific error.
- Test: a unit test with a stubbed `ExecutePython` that never resolves. Assert that cancel releases the gate and that the next compare is accepted.

### HIST-8: Temporary snapshots and comparison artifacts accumulate on disk
- Severity: minor. Type: robustness.
- Evidence:
  - Snapshots are deleted only on `dispose()` (gitRepositoryService.ts:220-222), although the payload is cached in memory right after Python returns. Each compared commit keeps up to 100 MiB under storageUri for the whole session.
  - Nothing sweeps `historical-comparisons/*` at activation, so a crashed or killed VS Code leaks them permanently. The empty `<sessionId>` parent folder is never removed either.
  - Every compare, including every live refresh on save, writes three new full-payload JSON files to `staticRoot/comparison/revision-N*.json` (historicalComparisonService.ts:143-173) and never deletes older revisions.
  - On Windows, the `fs.rm` at line 211 has no `maxRetries`. A Defender or indexer lock (EBUSY or EPERM) makes the compare fail.
- Failure scenario: a long session with a live comparison and frequent saves on a large deep analysis grows `comparison/` by MBs per save. Repeated crashes fill the extension storage.
- Confidence: LIKELY.
- Proposed fix:
  - Remove the snapshot directory in a `finally` once Python finishes.
  - Sweep `historical-comparisons/` and `project-evolution/` for session ids that are no longer live at startup.
  - Keep only the current and previous `revision-*` files.
  - Use `fs.rm(..., { maxRetries: 5, retryDelay: 100 })`.
- Test: a unit test that asserts the snapshot directory is gone after `analyzeSource` resolves (real repo, stubbed `ExecutePython`).

### HIST-9: Concurrent starts and the refresh flag set before success
- Severity: minor. Type: bug.
- Evidence:
  - historicalComparisonBridge.ts:139-176 checks `isBusy()`, then awaits `reconcileSession` and `refreshMode` before calling `compare()`. Two starts in that window, from two collaborators or a double tap, both pass. The loser throws `comparison-busy`, which is broadcast to every client (199-206), including the user whose job is still running.
  - `setRefreshEnabled(...)` (153-157) runs for the new request before it succeeds, so a failed request leaves the refresh flag describing it while `activeRequest` still holds the previous one.
- Confidence: LIKELY.
- Proposed fix: reserve the gate synchronously, for example with `jobs.tryReserve()`. Send the busy error only to the requester (`messageContext.send`). Set the refresh flag after success.

### HIST-10: Misleading and stale status text
- Severity: minor. Type: ux.
- Evidence:
  - `applySharedState` sets "Loading comparison datasets..." (compareFlowAndMessages.js:278) and never clears it on success. In the harness the panel status still said it after a successful render and after re-entry.
  - `handleError` (255-265) maps any message containing `git-command-failed` to "History compare requires an analysis inside a local Git repository.", even for a deleted branch (`rev-parse --verify` failure). Every other code, such as the snapshot limits, `unknown-comparison-source` or a Python failure, becomes "Please try again."
- Confidence: CONFIRMED for the stale status (harness output `"status":"Loading comparison datasets..."` after render). LIKELY for the messages.
- Proposed fix: clear the status after the render. Have the server send typed codes (`reference-gone`, `snapshot-limit`, `analysis-timeout`) and give each a specific message.

### HIST-11: Picker scalability and permanent exclusions after transient failures
- Severity: minor. Type: ux.
- Evidence:
  - Only `log --all --max-count=50` commits are offered (gitRepositoryService.ts:69-75). Older history can be reached only through tags or branches. There is no search, and paging is prev/next only.
  - The first `getReferences` indexes every branch and tag (gitAnalysisEligibility.ts:161-172). Measured: 451 sources over 300 files took 2.5 s on first open (`scratch/historical/tags.cjs`), with no progress shown beyond "Loading local Git references...". This grows linearly with tags times files.
  - `isDeterministicNoDataError` (gitAnalysisEligibility.ts:75-78) also matches "Unable to parse result" or "JSON markers not found", which a crashed, killed or broken-venv Python produces as well. The commit is then removed from both pickers for the rest of the session (`recordDeterministicExclusion`).
- Confidence: CONFIRMED for the timing. LIKELY for the transient exclusion.
- Proposed fix:
  - Add a "Load more" or by-SHA entry backed by HIST-2's registry, and a progress message during indexing.
  - Classify exclusions only from validated payloads (empty or non-array), not from process failures.

### HIST-12: The comparison clone copies every attribute of the scene chart, and the harness hides real breakage
- Severity: minor. Type: architecture and test-gap.
- Evidence:
  - `createChartFromTemplate` (comparisonCharts.js:131-151) copies all attributes except a blacklist.
  - In `test/manual/xr-mode-cycle-harness.html` the normal chart has no `codexrNormalAnalysisRoot` wrapper, unlike the real template (templates/xr/file/xr-visualization.html:88-101). The surface runtime therefore stamps `data-codexr-normal-root`, `data-codexr-analysis-root` and `data-codexr-analysis-mode="single"` on the chart itself, and the clones inherit those markers.
  - On re-entry, `mountNormalRoots` and `detachNormalRoots` then treated the clones as normal roots and left both comparison charts `visible=false`. This was traced with a setAttribute spy.
  - With the real wrapper (`h2.html`) re-entry is fine. The harness is therefore not representative, and the copy rule is fragile: any marker added to the chart entity in the future leaks into the clones.
  - The mode-cycle runner never runs a comparison, never re-enters with one, never switches charts in compare mode and never pushes an update while parked. That is why HIST-3 and HIST-4 are uncaught.
- Proposed fix:
  - Build clones from the canonical chart builder (`buildDeclarativeChartEntity` and the chart base config) plus an explicit whitelist, instead of copying attributes.
  - Wrap the harness chart like the real template.
  - Extend `run-xr-mode-cycle-harness.cjs` with compare, leave and re-enter, compare with a chart switch, and an update while parked.

### HIST-13: LivePanel waits on SSE alone, and its live-refresh errors are invisible
- Severity: minor. Type: robustness.
- Evidence:
  - templates/components/livepanel/historicalPanel.js:122-165. After the 202, completion arrives only through the SSE messages `historical-progress` and `historical-updated`. If the SSE connection drops during a long analysis, or the event is missed on reconnect, the button stays "Comparing..." with no poll or timeout.
  - The host's live refresh (analysisFeatureHost.ts:289-303) never calls `notifyLivePanelHistoricalProgress` on failure, so LivePanel live updates stop silently while HIST-1 loops.
- Confidence: LIKELY.
- Proposed fix: add `GET /api/historical/status` (busy, last revision, last error) and poll it after an SSE reconnect. Route refresh errors to SSE.

### Documentation
- docs/features/HISTORICAL_COMPARISON_XR.md is in English now, not Spanish.
- It claims "Each side keeps the chart type chosen for the original analysis" and that "every client renders the same ... revision". HIST-3 and HIST-4 contradict both.
- The "5,000 files" limit is counted recursively even for shallow analyses (HIST-5).
- It does not mention the 50-commit horizon breaking live comparisons (HIST-2).

### Checked and not bugs
- Non-Git folders: availability is disabled with a reason.
- Empty repository with no commits: the picker offers only the working copy.
- Detached HEAD: labelled "Detached HEAD <sha> (live)".
- Target missing in a revision: excluded from the picker.
- The two zones do not overlap: the centre gap is 0.18, and the zones come from one function used by both the profiles and the fallback.
- Leaving to single restores the normal chart and the mapping with the real wrapper.
- Metric (axis) changes on boats clones keep the inline data (`buildChartComponentUpdate` merges).
- No item in REPORT.md section 9 belongs to this area.

## 3. Architecture recommendations

1. **One chart-construction service.** The mapping runtime should own "build or rebuild chart X for context C from dataset D in zone Z", with each mode registering how to supply D. Historical (two zones, inline boats trees), evolution (one frame) and single (data or tree) would then all go through it. That fixes HIST-3 by construction and removes `createChartFromTemplate`'s attribute copying (HIST-12).
2. **Separate the rendered state from the received state in each mode runtime.** Use `rendered` (the geometry mounted) and `latest` (from the server), and reconcile them on activate. Do not overload `state.result` (HIST-4). This belongs in the unified launcher's mode lifecycle contract: `activate` → `reconcile(latest, rendered)`.
3. **The launcher contract should require cancellation and status.** Each analysis type exposes `start(request, signal)`, `cancel()`, `status()` and `onLeave` policy. The host runs a shared job gate with timeout, abort and typed errors. Historical currently has none of these (HIST-7, HIST-9, HIST-13). Evolution has a home-grown revision counter; unify the two.
4. **Live-refresh policy is shared infrastructure.** Use bounded retry with backoff, surface the error, auto-detach when a source is gone, and stay mode-aware (HIST-1). Put it in `analysisRefreshCoordinator`, not in each feature host.
5. **Git sources are content-addressed.** Resolve by SHA through one registry and materialize from the blob index plan with the batch reader, so eligibility, materialization and export share one file-selection rule (HIST-2, HIST-5). Do path identity in one drive-agnostic normalizer shared with Python's rule (HIST-6).

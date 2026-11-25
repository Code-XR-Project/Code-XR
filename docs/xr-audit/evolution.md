# XR audit: Project Evolution (area "evolution")

Auditor scratch dir: `/tmp/claude-0/-home-user/af5ccea8-f538-575c-b7b6-8256e5a53df6/scratchpad/audit/evolution/`
- `hostRepro.test.cjs`: host-side repros A to L. They run the compiled `out/` services under the repo's fake vscode, against real git repos built in the scratch dir. Run them with `node --test --test-name-pattern="^X" hostRepro.test.cjs`.
- `sandbox.cjs`, `repro-generating-stuck.cjs`, `repro-cleared-stuck.cjs`: browser-runtime repros. They load the assembled `projectEvolutionRuntime.js` in a `vm` with a fake collaboration client.

Baseline (all green): `projectEvolutionRuntime` 17/17, `gitHistoryServices` 24/24, `gitRevisionExporter` 15/15, `gitRevisionExportPhases` 7/7, `gitListReferences` 4/4, `gitMaterializeDirectory` 5/5, `gitExportPreflight` 1/1, `gitRefPickerRuntime` 7/7, `exportPackageTransaction` 3/3, `historicalComparison` 16/16, `gitAnalysisShared` 4/4. `npm run test:project-evolution-harness` with the CDN preload exits 0. The harness writes into `apps/vscode-extension/output/project-evolution-harness/`, a gitignored build-output folder. `gitRevisionExporter.test.cjs`'s formerly Windows-only failure is the decorator test with `C:` roots: `buildBabiaStyleFilePath` now strips the drive letter, and CI was green on Windows (REPORT §1), so it is no longer reproducible here.

## 1. How it works

- **Server side.** `AnalysisFeatureHost` (`src/core/server/analysis/analysisFeatureHost.ts:138`) creates one `ProjectEvolutionService` per XR session. `ProjectEvolutionBridge` (`src/core/server/analysis/projectEvolutionBridge.ts`) maps collaboration-room messages to it:
  - `project-evolution-references-request`
  - `-start`: runs fire-and-forget, broadcasts `-progress`, and finally upserts the shared entity `project-evolution/main`.
  - `-apply-frame`: copies `dataN.json` over a shared `data.json`, then broadcasts `-frame-applied`.
  - `-clear`
- **Generate** (`projectEvolutionService.ts:147`) has four phases:
  1. Resolve the timeline: `git log --all --reverse --max-count=240` plus the working copy (`buildAutomaticTimeline`), or a range or manual picks.
  2. Filter through `GitAnalysisSourceCatalog`, which uses a `GitTimelineBlobIndex` over persistent `git cat-file --batch` processes.
  3. Sample to 24 frames (`gitTimelineSampler`).
  4. Analyze with 4 async "workers". Each one `materialize()`s the commit to disk (one `git show` per file) and runs the full Python `main.py --mode xr` through `ExecutePython`, via `GitAnalysisSessionContext.analyzeSource`. The results are cached per commit in an unbounded Map. Finally `writeEvolutionArtifacts` writes `evolution/revision-N/data{i}.json`, `data.json` and `manifest.json`.
- **Jobs.** `SingleJobGate` refuses a second job. Cancellation is a counter (`cancellationRevision`) that is checked only between revisions.
- **Export path.** `exportGitRevisionData` → `runGitRevisionExport` → `GitTimelineBlobAnalyzer`. It indexes every selected commit's tree via cat-file and analyzes each distinct blob+extension once in `GitExportPythonWorkerPool` (persistent `git_export_analysis_worker.py` children). It writes `git-revisions/*.json` plus `gitData`, which the browser's `offlineGitData.js` turns into movies offline.
- **Browser.** `projectEvolutionRuntime` has 9 parts:
  - It registers a mode lifecycle with `CodeXRAnalysisModeRuntime` (activate, deactivate, capture and restore state) and a Git-gated selector option.
  - It builds a selection panel around the shared git-ref picker in `sequence` mode.
  - It plays frames through `seek` → `requestBridgeFrame` (server copies the frame to the bridge) → `applyBridgeFrameToChart`. That last step uses one declarative pipeline (`babia-queryjson` → tree builder → chart under `codexrProjectEvolutionRoot`), wrapped in analysis-table containment data transitions, and guarded by `viewGeneration` and `playbackGeneration` counters.
- **Who is "generating".** Each client works out the `generating` flag from the broadcast `-progress` messages. There is no server-authoritative job state.

## 2. Findings

### EVO-1: A failed generation leaves the client "generating"; leaving the mode then deletes the previous good movie for the whole room
- Severity: **blocker** | Type: bug
- Evidence:
  - `templates/components/codexr/project-evolution/projectEvolutionRuntime/playbackControlsAndMessages.js:286-302`. `handleProgress` sets `state.generating = payload.state === 'analyzing' && frameCount > 0`. `handleError` stops playback and sets the status, but never resets `generating` or hides the progress bar.
  - `frameApplication.js:150-161`. `applyClearedState` does not reset it either.
  - `transportAndRegistration.js:152-161`:
    ```js
    function releaseEvolutionOnLeave() {
      invalidateEvolutionView(...);
      if (state.generating) { state.generating = false; renderGenerationProgress({state:'idle'}); clearMovie(); }
    ```
    `clearMovie()` sends `project-evolution-clear`. The server-side `handleProjectEvolutionClearMessage` (`projectEvolutionBridge.ts:43-83`) deletes `revision-N`, removes the shared entity and broadcasts `-cleared` to everybody.
- Failure scenario:
  1. A movie exists.
  2. The user presses Generate again (another range, for example). The server sends a few `analyzing` progress messages, then fails: insufficient data, a range that is not found, the busy race, a Python error, and so on.
  3. The panel shows the error, but the progress bar stays at "Generating frame k / n".
  4. The user goes back to Single.
  5. The client sends `project-evolution-clear`, and the previously generated movie is deleted for every participant. The same stale flag also follows a `-cleared` broadcast, which leaves the progress bar frozen.
- Confidence: **CONFIRMED** (`repro-generating-stuck.cjs`). After `-error`, `generating = true` and the movie at revision 1 is still loaded. `lifecycle.deactivate()` then sends `['project-evolution-clear']`. `repro-cleared-stuck.cjs` shows that `generating` stays true after `-cleared`.
- Proposed fix:
  - Reset `generating` and call `renderGenerationProgress({state:'idle'})` in `handleError`, `applyClearedState` and `applySharedState`.
  - Better: see EVO-2. A server-authoritative job state, and leave-mode never sending a destructive clear.
- Test: add a case to `test/analysis/projectEvolutionRuntime.test.cjs` that drives the handlers the way the sandbox does, sending progress then error, and asserts `getState().generating === false` and that deactivate sends nothing.

### EVO-2: "Cancel" is implemented as "Clear": any participant leaving mid-generation wipes the room's movie, and the server does not actually stop
- Severity: **major** | Type: bug / architecture
- Evidence:
  - `transportAndRegistration.js:148-161`. The comment says *"a generation in flight is CANCELLED and everything cleaned (the server aborts its workers on project-evolution-clear…)"*.
  - `projectEvolutionService.ts:107-121`. `clearGeneratedMovie` bumps `cancellationRevision` **and** `rm`s the current `revision-N`, which is the old good movie.
  - `projectEvolutionService.ts:212-265`. Workers check the counter only after `analyzeSource` returns, so Python and git keep running.
  - The first worker to notice throws `project-evolution-cleared`, so `Promise.all` rejects immediately and `SingleJobGate.run`'s `finally` (`gitAnalysisSessionContext.ts:255-268`) frees the gate **while the other workers are still materializing and analyzing**. Those orphans later `cache.set()` into the cache that was just cleared.
  - Every client receives the broadcast progress, so every client that is in the mode and leaves triggers the clear, not only the one who pressed Generate.
- Failure scenario A: user A generates, and user B (or A in another tab) switches to Dependency graph. A's generation is aborted, the old movie is deleted, and A sees "Project evolution movie cleared."
- Failure scenario B: Clear, then Generate again immediately. The new job runs alongside orphan Python processes from the old one. Both `rm -rf` and rewrite the same `snapshots/<sha>` directory (`gitRepositoryService.ts:208-212`) when they hit the same commit. A partial snapshot can then be analyzed, cached, and even recorded as a *deterministic* exclusion in the shared catalogue (`gitAnalysisSessionContext.ts:204-219`), which hides that commit from both Git pickers until the session ends.
- Confidence:
  - Scenario A: **LIKELY**. Code-traced; the client half is confirmed by EVO-1's repro.
  - Early gate release: **LIKELY** (code).
  - Snapshot-directory race: **SUSPECTED**. Repro G, which picks the same commit as a branch and as a commit in manual mode, did not corrupt it with the timing used.
- Proposed fix:
  - Split the protocol into `project-evolution-cancel` (job only, keeps the last good movie, owner-only or explicit button) and `-clear` (files and entity).
  - Leaving the mode must not cancel. Let the job finish in the background; the entity is passive anyway.
  - Plumb an `AbortSignal` from `generate()` into `GitRepositoryService.runGit*` (`execFile` `signal`) and `ExecutePython.spawnAndCollect` (`child.kill()`).
  - Make `analyzeSources` await all workers (`Promise.allSettled`) before releasing the gate.
  - Key snapshot directories by `sha + jobId`, or serialize materialization per sha with a `Map<sha, Promise>`.
- Test: extend `gitHistoryServices.test.cjs` with a stub analyzer that blocks on a deferred. Assert that `isBusy()` stays true until every in-flight analysis settles after clear or cancel, and that a cancel does not delete `revision-N`.

### EVO-3: No timeout and no kill for per-revision analysis: one slow or hung revision keeps the service "busy" forever, even after Clear
- Severity: **major** | Type: robustness
- Evidence:
  - `gitAnalysisSessionContext.ts:133`: `await new ExecutePython(this.extensionContext).executeAnalysis(revisionSession)`.
  - `src/core/analysis/python/executePython.ts:438-497`. `spawnAndCollect` has no timeout or kill.
  - `gitRepositoryService.ts:528-572`. `execFile` git calls have no timeout.
  - `projectEvolutionBridge.ts:137-146` answers `project-evolution-busy` while `isBusy()`.
- Failure scenario: a revision with a pathological file (for example huge minified JS through lizard), or a git process waiting on a lazy fetch (EVO-10). The movie "never finishes". Clear does not help, because the worker that never returns is never re-checked. Every later Generate gets "Another project evolution analysis is already running." until VS Code reloads. This matches the "it always gives trouble / gets stuck" report.
- Confidence: **CONFIRMED** (repro A). After `clearGeneratedMovie()` and a 500 ms wait, `isBusy() === true` and a second `generate()` rejects with `project-evolution-busy`.
- Proposed fix:
  - Per-revision watchdog: a timeout scaled to file count, which kills the child and turns the revision into an `analysis-failed` exclusion.
  - Plus the AbortSignal from EVO-2.
  - Expose a "Cancel generation" button that only cancels.
- Test: unit test with a never-resolving stub analyzer and a fake clock. Assert that the job rejects or excludes after the timeout and `isBusy()` returns to false.

### EVO-4: Clear landing after the analyses finish is ignored: the movie is written and published after everyone was told it was cleared
- Severity: **major** | Type: bug (race)
- Evidence:
  - `projectEvolutionService.ts:163-191`. Cancellation is checked only inside `analyzeSources`. `writeEvolutionArtifacts` (`:269-318`) does `++this.revision`, then `rm`, `mkdir`, 24 × `writeFile` and the manifest, with no check.
  - The bridge then unconditionally calls `upsertSharedEntity` and `setSnapshotAvailable(true)` (`projectEvolutionBridge.ts:189-206`).
  - Because `this.revision` is bumped synchronously at the start of the write phase, a concurrent `clearGeneratedMovie` `rm`s the directory being written. The next `writeFile` throws ENOENT, which reaches every client as `project-evolution-failed`.
- Failure scenario: a user presses "Clear movie", or leaves the mode (EVO-2), during the last seconds. Every client gets `-cleared` and empties the panel. A moment later the movie entity arrives and the selection panel turns back into a movie; or the room gets an ENOENT error.
- Confidence: **CONFIRMED** (repro B). Clear was issued right after the final "Analyzed N / N" progress, and `generate()` still RESOLVED with revision 1 and 7 frames, with all files on disk.
- Proposed fix:
  - Check the token before `++revision`, after the writes, and again in the bridge before `upsertSharedEntity`. On mismatch, `rm` the new directory and throw `project-evolution-cleared`.
  - Make Clear await the running job's settlement (or cancel it, as in EVO-2) instead of racing it.
- Test: the repro B pattern, a clear scheduled from the final progress callback. Assert rejection with `project-evolution-cleared` and no `revision-*` left.

### EVO-5: The shared `data.json` "bridge" races: concurrent frame applies fail with ENOENT or leave the wrong frame's data under the right label, and the error stops playback for the whole room
- Severity: **major** | Type: bug / architecture
- Evidence:
  - `projectEvolutionService.ts:123-145` and `:486-490`:
    ```ts
    const tempPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.copyFile(sourcePath, tempPath);
    await fs.promises.rename(tempPath, destinationPath);
    ```
    Two applies in the same millisecond share one temp name, and the renames land in completion order, not request order.
  - The browser always reads the bridge URL online. `framePlaybackEngine.js:8-18` uses `bridgeUrl()`; the frame's own `url` is used only offline.
  - Errors go out with `messageContext.broadcast` (`projectEvolutionBridge.ts:118-126`). `handleError` (`playbackControlsAndMessages.js:296-302`) rejects every client's pending apply and calls `stop()`.
  - The `-start` busy race has the same shape. `isBusy()` is checked synchronously, but `generate()` only starts after `await reconcileSession` (`:178-183`), so a double-click or two users produce a broadcast `project-evolution-busy` error that stops everybody while the first job keeps running.
- Failure scenario:
  - Fast Next/Next/Previous, or two participants seeking or playing in the same room, gives intermittent ENOENT errors. Playback stops for everyone.
  - Worse, client A requests frame 5, B requests frame 2, and A then fetches `data.json?t=…` after B's copy. A shows frame 2's data titled "Frame 5". This is silent.
- Confidence: **CONFIRMED** (repro F). 200 rounds of 3 concurrent `applyFrameToBridge` gave **380 / 600 rejections with ENOENT**. The data mis-labelling follows from the same ordering race (code).
- Proposed fix:
  - Delete the bridge. Point `babia-queryjson` at `frame.url` (`/evolution/revision-N/data{i+1}.json?t=…`), exactly as the offline path already does. The URL changes every frame anyway because of the cache buster.
  - `project-evolution-apply-frame` then becomes, at most, a "follow me" broadcast carrying `frameIndex`, with no file I/O.
  - Reply to errors with `messageContext.send` (the requester only). Broadcast only room-level state.
- Test:
  - A unit test that concurrent applies never reject, or the removal of `applyFrameToBridge`.
  - The harness's `/__project_evolution_apply_frame` route should stop copying.
  - A Playwright step with a seek storm that asserts the datasource URL's `frame=` matches `runtime.frameIndex`.

### EVO-6: The timeline is `git log --all`, so stashes, notes, remote and other-branch commits become movie frames, and the movie can travel past HEAD and back
- Severity: **major** | Type: bug
- Evidence:
  - `gitRepositoryService.ts:138-145`: `['log','--all','--reverse',…]`. The same applies to `listReferences` (`:69-75`) and the export.
  - `--all` includes `refs/stash` (a 2-parent "merge", which `gitTimelineSampler.isMilestone` **prefers**), the stash's "index on …" commit, and `refs/notes/*`. It also includes every local and remote branch.
  - `resolveCurrentStateSource` (`projectEvolutionService.ts:418-422`) appends the working copy as the last frame. Frames from other branches that are newer than HEAD therefore come *before* the final HEAD state.
- Failure scenario:
  - A stash (`git stash`) shows up as a milestone frame titled "On main: WIP…" containing uncommitted, possibly deleted, work. A `git notes` commit shows up as a frame.
  - On a detached or older checkout, or a feature branch, the movie plays the newer `main` commits and then jumps "back" to the live state.
- Confidence: **CONFIRMED**.
  - Repro C, suggested frames: `"Notes added by 'git notes add'"`, `"merge On main: WIP never committed"`, `"index on main: …"`, `c2`, `c1`, live.
  - Repro J (shallow clone, detached at `HEAD~1`): frames `9610f415, 38206cd5, 36030e9e (merge, newer than HEAD), Detached HEAD 38206cd5 (live)`.
- Proposed fix:
  - Live movie: replace `--all` with `HEAD` (first-parent optional), with `--exclude=refs/stash --exclude=refs/notes/*` as a minimum.
  - Offer "all branches" only as an explicit option.
  - Export: same, or `--branches --tags --remotes` instead of `--all`.
- Test: a `gitListReferences.test.cjs` / `gitHistoryServices` case with a stash plus a note, asserting neither appears in `listTimelineSources`. Also a detached-HEAD case asserting that no frame is newer than HEAD.

### EVO-7: Only the newest 240 commits exist for the live movie: long histories never start at the beginning, and older tags or branches offered in the picker fail with a raw error
- Severity: **major** | Type: bug / ux
- Evidence:
  - `projectEvolutionService.ts:27` sets `TIMELINE_SCAN_LIMIT = 240`. `listTimelineSources(240)` gives `--max-count` (newest 240), then `--reverse`.
  - The picker lists every branch and tag (`getReferences` merges `references.sources`). In range mode, `resolveTimelineIndex` returns −1 for a ref outside the window, so `throw new Error('project-evolution-range-not-found')` (`:355-357`). `describeBridgeError` (`analysisBridgeReplies.ts:70-82`) shows the raw code.
  - The sampler's doc (`gitTimelineSampler.ts:16-18`) promises that the "first revision [is] always included".
  - The export (`all`) covers the full history, so live and offline Auto movies of the same project differ.
- Failure scenario: in a repository with 300+ commits, the Auto movie starts at commit 60 (or 2,500 of 2,789 for the JetUML export repo). The user picks the `v0.1` tag as range start and gets "project-evolution-range-not-found".
- Confidence: **CONFIRMED**.
  - Repro D: 300 commits, first suggested frame = `c60`, root not included.
  - Repro K: the old tag is offered, and range → `ERROR "project-evolution-range-not-found"`.
- Proposed fix:
  - Sample from the full first-parent history using `git rev-list --count` plus `--skip`-based probes, or `git log --format=%H %ct` (cheap, about 50 bytes per commit) without materializing. Then sample 24.
  - For range mode, resolve endpoints with `git rev-list A..B` / `merge-base` instead of looking them up in a window.
  - Map error codes to sentences.
- Test: repro D / K as assertions in `gitHistoryServices.test.cjs`.

### EVO-8: The live pipeline is very expensive: one `git show` process per file per revision, a full Python directory analysis per revision, a VS Code toast per revision, and snapshots kept on disk
- Severity: **major** | Type: robustness / performance (the "never finishes" root cause)
- Evidence:
  - `gitRepositoryService.ts:359-375` (`copyPlannedFiles` runs `git show <sha>:<path>` per file).
  - `gitAnalysisSessionContext.ts:133` calls `executeAnalysis(revisionSession)` **without `{silent:true}`**. `executePython.ts:156-167` then wraps each revision in `vscode.window.withProgress({location: Notification, title:'CodeXR Analysis', cancellable:false})`, so up to 24 toasts appear, 4 at a time.
  - Snapshots under `storage/project-evolution/<session>/snapshots/<sha>` are only deleted on `dispose()` (`gitRepositoryService.ts:220-222`). With up to 100 MB per snapshot, that can reach about 2.4 GB for 24 frames.
  - The per-commit payload cache (`GitAnalysisSessionContext.cache`) is unbounded across regenerations with different ranges.
  - No dedupe: files that are byte-identical across frames are re-analyzed per frame. The export pipeline already solves this with blob-level dedupe (`gitTimelineBlobAnalyzer.ts`).
- Failure scenario: a 1,000-file directory needs about 10 s of git spawning per frame on Linux, about 250 s for a 24-frame movie, before Python runs. On Windows, process spawn is several times slower. Progress only moves between revisions, so the bar sits still for minutes.
- Confidence: **CONFIRMED** for the cost (repro L: 1,000 files materialized in 10.4 s, 10.4 ms/file). The toasts are **LIKELY** (code-traced; they need the maintainer's eyes in VS Code).
- Proposed fix:
  - Make live evolution (and historical comparison) consume the export's `GitTimelineBlobAnalyzer` + `GitExportPythonWorkerPool`. It reads from cat-file, keeps no working-tree snapshots, analyzes each unique blob once, already has a cancel token that kills workers, and reports per-file progress.
  - Keep a per-session prepared store as the cache.
  - Short of that: pass `{silent:true}`, `rm` each snapshot right after its analysis, and bound the cache (LRU by commit).
  - Payload parity between per-blob and `main.py` directory analysis must be verified first: compare one commit both ways in a test.
- Test: a `gitHistoryServices` case asserting `fake.progress` (fakeVscode recorder) receives no notification per revision, and that the snapshots dir is empty after generate.

### EVO-9: Windows: the export Python worker decodes its stdin with the ANSI code page, so any non-ASCII path (for example `C:\Users\Adrián\…`) fails every job
- Severity: **major** (Windows users with non-ASCII profile names; the maintainer's own name qualifies) | Type: bug
- Evidence:
  - `src/core/export/gitExportPythonWorkerPool.ts:141-147` writes `JSON.stringify({inputPath, outputPath…})` as UTF-8. JSON.stringify does not escape non-ASCII. The spawn (`:66-74`) sets no `PYTHONUTF8` / `PYTHONIOENCODING`.
  - `backend/src/export/git_export_analysis_worker.py:73` uses `for raw_line in sys.stdin:`. On Windows, Python below 3.15 decodes piped stdin with the locale code page (cp1252), so the path becomes mojibake, `os.path.isfile` is false, and the worker returns `worker-input-missing`.
  - The paths live under `context.storageUri`, which is inside the user profile.
- Failure scenario: Export Analysis Folder with History or Evolution on Windows, user profile `C:\Users\Adrián`. Every blob job fails twice (retry), every revision is excluded, and the result is "Fewer than two revisions could be analyzed…". The offline Git modes are unavailable.
- Confidence: **CONFIRMED (emulated on Linux)**. The same command fed to the real worker with `PYTHONIOENCODING=utf-8` gives `complete`; with `cp1252` it gives `{"type":"error","error":"worker-input-missing"}`. The maintainer should check on real Windows.
- Also: the worker's `Path.unlink(missing_ok=True)` (`:66`) needs Python 3.8+, but `venvManager.ts:593` still advertises "Python 3.7+". On 3.7 every successful job would raise in `finally` and be reported as failed (LIKELY).
- Proposed fix:
  - Spawn with `env: {...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'}`.
  - In the worker: `sys.stdin.reconfigure(encoding='utf-8')`, or read `sys.stdin.buffer` and decode.
  - Belt and braces: escape non-ASCII in Node (`\uXXXX`).
  - Replace `missing_ok` with try/except `FileNotFoundError`.
- Test: a worker-pool test whose `temporaryRoot` contains `á`, run with `PYTHONIOENCODING=cp1252` in the spawn env to emulate Windows.

### EVO-10: Partial clones: every Git mode silently fetches from the remote, which violates the no-network-without-consent principle and can hang on credentials
- Severity: **major** (principle) | Type: robustness
- Evidence:
  - `gitRepositoryService.ts:519-526` (`cat-file -e`), `:553-572` (`git show`).
  - `gitBatchObjectReader.ts:46-50` (`cat-file --batch`, also used by the eligibility catalogue on every references request).
  - No `GIT_NO_LAZY_FETCH` / `--no-lazy-fetch` / `GIT_TERMINAL_PROMPT=0` anywhere.
- Failure scenario: a repository cloned with `--filter=blob:none` (common for large repos). Opening the Evolution panel, or generating, makes git fetch each missing blob from `origin` one by one. This is very slow, uses the network without consent, and with an authenticated remote may block on a credential helper or askpass. The job then hangs (EVO-3).
- Confidence: **CONFIRMED** with a local `file://` promisor remote. `git cat-file -e <old>:a.js` succeeded only by lazily fetching (the pack count grew). This was a local remote only; real network behaviour is inferred.
- Proposed fix:
  - Run all history git commands with `env GIT_NO_LAZY_FETCH=1` (git 2.44+; also pass `--no-lazy-fetch` when supported) and `GIT_TERMINAL_PROMPT=0`.
  - Treat a missing object as a deterministic `analysis-failed` exclusion with a clear reason ("blob not present locally (partial clone)").
  - Detect `remote.*.promisor=true` in `getAvailability()` and say so.

### EVO-11: Old `evolution/revision-*` folders accumulate; Clear deletes only the newest; the export then ships a stale movie the user had replaced and cleared
- Severity: minor | Type: bug
- Evidence:
  - `projectEvolutionService.ts:269-277`: each generate creates `revision-N` and never removes `revision-(N-1)`.
  - `:107-121`: clear removes only `revision-${this.revision}`.
  - The export copies the whole static folder (`exportPackageTransaction.ts:63`) and `findNewestEvolutionRevision` (`exportManifest.ts:491-503`) picks the highest remaining number.
  - `this.revision` restarts at 0 on a new service, so Clear before the first generate does nothing.
- Failure scenario: Generate, Generate again, Clear, then Export with Evolution. The export advertises and ships revision-1, an older movie, as "the movie computed before export". Disk use also grows with every regeneration.
- Confidence: **CONFIRMED** (repro H: after two generations and Clear, `evolution/` = `['revision-1']`).
- Proposed fix: after a successful write of revision N, `rm` every other `revision-*`, and on clear `rm` the whole `evolution/` folder. Seed `this.revision` from the highest existing folder.

### EVO-12: Export "latest N" is silently clamped to 1000 commits; "all" can overflow git's 16 MB buffer on very large histories
- Severity: minor | Type: bug
- Evidence:
  - `gitRepositoryService.ts:135-137`: `Math.min(1000, …)`.
  - `gitExportOptions.ts:61-74` (`validateGitRevisionScope`) accepts up to the total count, and the UI (`activeAnalysesCommands.ts:468-490`) asks for any N.
  - `runGit` uses `maxBuffer: 16 MB` (`:530-534`), which an unlimited `git log --all --format=…%s` exceeds at roughly 80k+ commits, giving "git timeline could not be listed".
- Confidence: **CONFIRMED** (repro I: 1,100 commits, latest 1,050 requested, 1,000 returned). Overflow: LIKELY (arithmetic).
- Proposed fix: no clamp for explicit export scopes. Stream `git log` (spawn + line reader) instead of `execFile` buffering. `timelineSelection` should report the real count.

### EVO-13: Manual mode drops picks after 24 without telling the user; online order is click order while offline is chronological
- Severity: minor | Type: ux / inconsistency
- Evidence:
  - The client sends `maxFrames: references.maxFrames || 24` (`playbackControlsAndMessages.js:224-227`). The server does `request.sourceIds.slice(0, maxFrames)` (`projectEvolutionService.ts:324-327`).
  - `GitRepositoryService.resolveSourcesInChronologicalOrder` (`:190-195`) does **not** sort, despite its name.
  - The offline `buildOfflineFrames` sorts chronologically (`offlineGitData.js:89-97`, pinned by the "manual keeps chronological order" test).
- Confidence: **CONFIRMED** (repro E: picks c3, c1, c2 produce frames in the order third, first, second).
- Proposed fix: decide on one order (the docs say "selection order"; the offline code says chronological). Rename or implement accordingly, and show "max 24" in the panel or refuse a 25th pick.

### EVO-14: The generation progress bar is non-monotonic and never reaches 100 %
- Severity: minor | Type: ux
- Evidence:
  - `projectEvolutionService.ts:217-258`. With 4 concurrent workers, each progress message carries the `frameIndex` of the item that just *started* or *finished*, so a later message can carry a lower `frameIndex` than an earlier one.
  - `timelineAndSources.js:195-207` renders `index / count` as "Generating frame index+1 / count". The bar jumps backwards (5/24 → 2/24) and stalls for the whole duration of one revision.
- Confidence: LIKELY (code).
- Proposed fix: send `completed` and `total` (and in-flight labels). Render `completed / total`.

### EVO-15: Playback edge cases: Play at the end does nothing; a room snapshot replay resets the position to frame 1; speed change during a seek can skip a frame
- Severity: minor | Type: ux
- Evidence:
  - `framePlaybackEngine.js:226-228,309-321`. On the last frame, `play()` → `scheduleNext` → immediately "Project evolution finished." It does not restart from frame 1.
  - `frameApplication.js:65-74`. `applySharedState` sets `frameIndex = 0` even when the same revision is replayed (reconnect), so `hasPreservedFrame` fails and the client re-seeks frame 1.
  - `transportAndRegistration.js:70-80`. `setSpeed` starts a new `scheduleNext` without waiting for the in-flight `seek`. If the server answer takes longer than the new countdown, the next `seek(frameIndex+1)` supersedes it and a frame is skipped.
- Confidence: Play at end and replay reset: LIKELY. Skipped frame: SUSPECTED.
- Proposed fix: Play at the end restarts from 0. Keep `frameIndex` when `shared.result.revision` is unchanged. In `setSpeed` only re-arm the countdown when no seek is pending.

### EVO-16: Containment data transitions are not exception-safe, so the chart can be left un-contained
- Severity: minor | Type: robustness
- Evidence:
  - `framePlaybackEngine.js:39-56,90-127` (`beginEvolutionDataTransition` … `finish/cancel` with no `try/finally`).
  - `containmentComponentCore.js:405-411`: while `dataTransitionActive`, `tick` returns early and `requestRenormalize` only queues.
  - Any throw between begin and finish (for example inside `setDeclarativeAttribute` or the mapping runtime) leaves the chart frozen outside containment ("chart off the table") until the next transition.
- Confidence: SUSPECTED (not reproduced; the harness's happy path passes).
- Proposed fix: wrap every begin…finish in `try { … } catch { cancel…; throw }`. Better still, move the whole "swap dataset under containment" sequence into one shared helper in the analysis-table runtime, used by every mode (see §3).

### EVO-17: Export worker pool: no per-job timeout, and a 10 s ready timeout with up to 32 cold interpreters
- Severity: minor | Type: robustness
- Evidence:
  - `gitExportPythonWorkerPool.ts:124-149`. `analyze()` waits indefinitely for `complete`/`error`; only user cancellation (`:270-272`) kills it.
  - `:7`: `WORKER_READY_TIMEOUT_MS = 10_000`. With the Maximum profile (`gitExportOptions.ts:50-52`, up to 32 workers), a cold lizard import under antivirus on Windows can exceed it. The `createWorker` failure then propagates and fails the whole export.
- Confidence: SUSPECTED.
- Proposed fix: per-job timeout (kill, retry once, record failure). Ready-timeout failure should degrade the worker count rather than abort.

### EVO-18: Shared picker lists the remote HEAD alias as a branch named "origin"
- Severity: minor | Type: bug (shared with historical comparison)
- Evidence: `gitRepositoryService.ts:417` filters `shortName.endsWith('/HEAD')`, but `%(refname:short)` of `refs/remotes/origin/HEAD` is `origin`.
- Confidence: **CONFIRMED** (repro J sources: `'origin|branch'` next to `'origin/main|branch'`).
- Proposed fix: filter on `fullRef.endsWith('/HEAD')`.

### EVO-19: Docs drift (`apps/vscode-extension/docs/features/PROJECT_EVOLUTION_XR.md`)
- Severity: minor | Type: docs
- Statements that are wrong or incomplete:
  - "Large histories are sampled": the live movie never sees anything older than the newest 240 commits (EVO-7).
  - "`Clear movie` removes the generated `/evolution/` JSON files": it removes only the current revision (EVO-11).
  - "Each frame replaces the active chart datasource": through a shared `data.json` bridge (EVO-5).
  - The `--all` source set, the 24-frame cap for range and manual, and the cancel-on-leave behaviour are not mentioned. Neither are the per-revision cost or the Windows and partial-clone caveats.
  - The doc names `projectEvolutionRuntime.js` as one file; it is now 9 parts plus a manifest.
- Proposed fix: rewrite after EVO-2, EVO-5 and EVO-7 land.

### EVO-20: Test gaps
- Severity: minor | Type: test-gap
- The runtime suite is mostly regexes over the source (`projectEvolutionRuntime.test.cjs:38-100`). There is no behavioural test of the error, cleared, leave and generating interplay (EVO-1/2).
- `gitHistoryServices` has no cancellation, clear-during-generate, or concurrency tests (EVO-2/3/4/5), and no stash, notes, detached or partial-clone fixtures (EVO-6/10).
- The Playwright harness (`test/runners/run-project-evolution-harness.cjs`) fakes the apply-frame endpoint with synchronous `copyFileSync`, so it can never see EVO-5. It also never exercises generation, errors or Clear.
- The `sandbox.cjs` pattern from this audit (vm + fake collaboration client + fake mode runtime) is a cheap way to add these tests.

## 3. Architecture recommendations (for the unified launcher and the unified chart rebuild)

1. **One analysis-job contract on the server**, shared by evolution, historical comparison and the dependency graph. Replace `SingleJobGate` plus fire-and-forget bridges with a `JobRunner` with:
   - `start(kind, request) → jobId`, `cancel(jobId)`;
   - an `AbortSignal` plumbed into every child process (git, Python);
   - a watchdog timeout;
   - `Promise.allSettled` before releasing the slot;
   - one **server-authoritative shared entity** `analysis-job/<kind>` = `{jobId, state: running|ready|failed|cancelled, completed, total, message, ownerParticipantId}`.

   Clients render from that entity instead of inferring `generating` from broadcast progress. That removes EVO-1, EVO-2, EVO-4 and EVO-14 by construction. The launcher adds a mode by registering `{kind, buildRequest, run(request, signal, progress) → result entity}`.

2. **Cancel is not Clear, and leaving a mode never mutates server state.** Mode lifecycles (`deactivate`) should only park visuals. Destructive actions are explicit buttons, and errors go to the requester (`send`), not the room (`broadcast`), unless they are room state.

3. **One Git revision provider.** Promote the export's `GitTimelineBlobIndex` + `GitTimelineBlobAnalyzer` + `GitExportPythonWorkerPool` to the only way any Git mode obtains a revision payload:
   - it materializes nothing;
   - it analyzes each blob once;
   - it can be cancelled and reports progress per file;
   - it runs the same code online and offline, so live and exported movies match.

   Give it a single timeline policy object `{refs: HEAD|branches|all, excludeStash, firstParent, maxScan}` used by the live movie, the pickers and the export (EVO-6, EVO-7, EVO-12). Harden every git spawn in one place (`GIT_NO_LAZY_FETCH`, `GIT_TERMINAL_PROMPT=0`, timeouts, streaming output) and every Python spawn (`PYTHONUTF8=1`).

4. **Frames are immutable URLs.** No shared mutable bridge file: the client loads `revision-N/data{i}.json` directly (EVO-5). The same rule should apply to the historical-compare sides. Each payload file should be written once and only read after that, so multi-client playback needs no server round-trip.

5. **Unified chart rebuild.** Evolution's `declarativePipeline.js` (datasource → tree → chart under one root, reuse the Babia instance, `begin/finishChartDataTransition`, `waitForChartsStable`) is the closest thing the codebase has to the desired "rebuild contained in the table" primitive. Extract it into the analysis-table runtime as `swapChartDataset(rootId, {url, chartId, mapping}, {viewGeneration})`. That helper should:
   - own the containment transition with try/finally (EVO-16);
   - own the cache-busting and the `componentinitialized` waits;
   - own the generation guard.

   Single, historical (two roots) and evolution would then all call it. The launcher's mode descriptor supplies only `{tableZones, chartRoots, datasetFor(state)}`.

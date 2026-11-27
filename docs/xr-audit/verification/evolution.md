# Verification: Project Evolution (area "evolution"), v1.2.1 @ 6f827a19

Scratch dir: `<scratch>/evolution/`
(original repros copied there; new probes `verifyA.cjs`, `cancel.cjs`, `hostVerify.cjs`, `g2.cjs`, `partial.cjs`, `L.cjs`, helpers in `lib.cjs`). Git on this box: 2.43.0. Python worker probe used Python 3.13 with lizard.

| ID | Sev | Verdict | Evidence (short) |
|---|---|---|---|
| EVO-1 | B | FIXED (verified by run) | Original `repro-generating-stuck.cjs`: after `-error` `generating = false`, leave sends `[]` (was `['project-evolution-clear']`). `repro-cleared-stuck.cjs`: `generating = false` after `-cleared`, leave sends `[]`. Code: `playbackControlsAndMessages.js:347-360` (handleError resets), `frameApplication.js:73,161`, `transportAndRegistration.js:163-183` (leave never mutates server). |
| EVO-2 | G | PARTIAL | Fixed: Cancel ≠ Clear (`project-evolution-cancel`, bridge `handleProjectEvolutionCancelMessage`); `cancel.cjs`: cancel → job rejects `project-evolution-cancelled` in 52 ms, `busy=false`, old `revision-1` kept and still resolvable; leave sends nothing (EVO-1 repro); workers awaited with `Promise.allSettled` (`projectEvolutionService.ts:300`); children killed via job signal (`executePython.ts:460-471`). **Still failing**: same commit analysed twice concurrently (tag + its commit, or branch + commit, in manual mode) races on one `snapshots/<sha>` dir; `g2.cjs`/`hostVerify.cjs G` reproduce partial frames (`v1.0:9` of 30 files) and ENOENT / "no data records" exclusions. |
| EVO-3 | G | FIXED (verified by run) | `verifyA.cjs`: Clear with analyses hung (stub ignoring the signal) returns after the 5 s grace, `busy=false`; with a 400 ms per-revision watchdog the hung revision is excluded (`revision-analysis-timeout`) and the movie still finishes (4 frames), `busy=false`. Job deadline 30 min, git command timeout 180 s. |
| EVO-4 | G | FIXED (verified by run) | `hostVerify.cjs B`: Clear fired from the final "completed = total" progress → generate REJECTED `project-evolution-cancelled`, `evolution/` = none (was RESOLVED revision 1 with files). |
| EVO-5 | G | FIXED (verified by run) | `hostVerify.cjs F`: 600 concurrent `resolveFrame` → 0 failures (was 380/600 ENOENT); each frame its own immutable URL `/evolution/revision-1/dataN.json`, no shared `data.json` written. Apply-frame errors go to requester only (`messageContext.send`, bridge); start reserves synchronously, busy answered to requester only. Client loads `frame.url` (`framePlaybackEngine.js:12-22`); runtime test "every frame plays from its own file" passes. |
| EVO-6 | G | FIXED (verified by run) | Repro C: frames = c1, c2, live (no stash/notes). `hostVerify.cjs O`: on `feature` with 3 newer `main` commits + stash → base, feat1, feature (live). `J`: detached shallow → `[38206cd5, Detached HEAD (live)]`, nothing newer than HEAD. Picker uses `--branches --tags --remotes`; export uses `listTimelineSources` (first-parent HEAD). |
| EVO-7 | G | FIXED (verified by run) | `hostVerify.cjs D`: 300 commits → first suggested and first movie frame = root `c0`. `K`: range from tag `v0.1` (outside 240) → 24 frames c0…live; bad endpoint → readable sentence. |
| EVO-8 | G | PARTIAL | Fixed: `{ silent: true }` (`gitAnalysisSessionContext.ts:209`, `executePython.ts:158`), snapshot released after each revision (`cancel.cjs`: snapshots dir empty after generate), cache LRU 128. **Not fixed**: still one `git show` process per file (`gitRepositoryService.ts:422-438`); `L.cjs`: 1000 files materialized in 4.4 s (4.4 ms/file) per revision; no blob dedupe across frames. |
| EVO-9 | G | FIXED (verified by run, emulated) | Real worker `backend/src/export/git_export_analysis_worker.py` with `PYTHONIOENCODING=cp1252` and an `Adrián/` path: raw UTF-8 line → `complete`; `asciiJson` line → `complete` (was `worker-input-missing`). Spawn env sets `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`; `missing_ok` removed. Real Windows still to be checked manually. |
| EVO-10 | G | PARTIAL | Fixed: no lazy fetch (`partial.cjs`, file:// promisor remote: missing blobs 4 → 4 after references + generate), `partialClone`/notice reported. **Still failing on git 2.43**: the first missing blob makes `git cat-file --batch-check` die (exit 128, `fatal: could not fetch … from promisor remote`), `GitBatchMetadataReader` sets a terminal error, and **every** revision, including complete HEAD/main, is excluded ("could not be inspected: git-cat-file-check-closed (128)" / "write EPIPE"). Picker shows only `main (live)`; generate fails "1 remain after filtering". |
| EVO-11 | m | FIXED (verified by run) | `hostVerify.cjs H`: after 2 generations `evolution/` = `['revision-2']`; after Clear the folder is gone; with a leftover `revision-7` the next movie is `revision-8` and 7 is removed. |
| EVO-12 | m | FIXED (verified by run) | `hostVerify.cjs I`: 1100 commits, latest 1050 → 1050, all → 1100; `git log` is streamed (`streamGitLines`), no `maxBuffer`. |
| EVO-13 | m | FIXED (verified by run) | Repro E: picks c3,c1,c2 → frames first, second, third (chronological, matches offline). >maxFrames refused with a message (`projectEvolutionService.ts:343-349`; test "S10: manual picks play oldest first…"). |
| EVO-14 | m | FIXED (verified by code reading + existing test) | Server sends `completed` (`projectEvolutionService.ts:258-285`); client renders max(completed) (`timelineAndSources.js:195-218`). Tests "S10: progress only grows…" and gitHistoryServices `completed` assertion pass. |
| EVO-15 | m | FIXED (verified by code reading + existing test) | Play at end seeks 0 (`transportAndRegistration.js:20-30`); same-revision replay keeps frame (`frameApplication.js:65-80`); `setSpeed` skips re-arm while `seekInFlight` (`transportAndRegistration.js:86-95`). Runtime test "S10: … Play at the end restarts, replays keep the frame" passes. |
| EVO-16 | m | STILL FAILING (code reading) | `framePlaybackEngine.js:94-130` and `:43-59`: begin…finish data transition still has no try/catch/finally; a throw between them leaves `dataTransitionActive` set until the next transition or leaving the mode (mitigation: `invalidateEvolutionView` cancels it, `transportAndRegistration.js:111`). No shared `swapChartDataset` helper. |
| EVO-17 | m | FIXED (verified by code reading) | `gitExportPythonWorkerPool.ts`: per-job timeout 120 s → worker killed, retried once, then recorded as failure (`:148-165`, `:346-367`); ready timeout 30 s; failed worker starts degrade the pool (`:320-334`). Not exercised by a run. |
| EVO-18 | m | FIXED (verified by run) | `hostVerify.cjs J` sources: `main`, `origin/main`, commits; no `origin` entry. Filter on `fullRef.endsWith('/HEAD')` (`gitRepositoryService.ts:465-467`). |
| EVO-19 | m | PARTIAL | `docs/features/PROJECT_EVOLUTION_XR.md` now documents first-parent HEAD, full-history sampling, own-file frames, whole-folder Clear, Cancel vs Clear, manifest parts. Still missing: per-revision cost and the partial-clone caveat (grep finds no "partial"). |
| EVO-20 | m | FIXED (verified by run) | New behavioural tests pass: gitHistoryServices 31/31 (S6 cancel/clear/watchdog, S10), gitTimeline 7/7 (stash/notes/detached/long history/range/1000 clamp), jobRunner 8/8, projectEvolutionRuntime 19/19, crossPlatformOffline 5/5. Gaps left: no test with a duplicated commit (EVO-2 snapshot race), the partial-clone test covers only `materialize`, not the batch-check catalogue path that fails on git 2.43. |

Verdict counts: FIXED 15 (EVO-1, 3, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15, 17, 18, 20), PARTIAL 4 (EVO-2, 8, 10, 19), STILL FAILING 1 (EVO-16). The blocker EVO-1 is fixed.

## Still failing / partial

### EVO-2 (partial): two analyses of the same commit share one snapshot folder
- `GitRepositoryService.materialize` does `rm -rf snapshots/<sha>` then writes it; the new EVO-8 `releaseSnapshot` (`gitAnalysisSessionContext.ts:121-127`, `gitRepositoryService.ts:314-321`) deletes it as soon as ONE analysis finishes. In manual mode a tag (or branch) and its commit are two sources with the same sha, analysed by two workers at once.
- Run: `node g2.cjs` (real catalogue, tag `v1.0` + its commit + live, 150 ms analyzer), 11 runs: `['v1.0:30','cb35686e:30','main (live):1']` most times, but also `['v1.0:9', ...]` (a frame built from 9 of 30 files: wrong data, silent) and exclusions `ENOENT: no such file or directory, scandir …/snapshots/cb35686e…/app`. With the stub catalogue (`hostVerify.cjs G`) the excluded reason is "The analysis produced no data records.", which `requireUsablePayload` records as a deterministic exclusion (hides the commit from both pickers for the session).
- Severity: minor-to-major (needs duplicate picks; silent wrong frame).
- Proposed issue: "Evolution: two sources on the same commit race on one snapshots/<sha> folder (partial frames, false exclusions)". Fix: dedupe by sha before analysis (or `Map<sha, Promise>` per sha) and key snapshot dirs by sha+job.

### EVO-8 (partial): still one `git show` per file
- `copyPlannedFiles` (`gitRepositoryService.ts:422-438`) spawns `git show <sha>:<path>` per file; `L.cjs`: 1000 files → 4.4 s per revision (~106 s of spawning for 24 frames before Python). No blob-level dedupe.
- Proposed issue: "Evolution: materialize revisions through cat-file --batch / blob dedupe instead of one git show per file".

### EVO-10 (partial): partial clone on git < 2.5x kills the batch-check reader and excludes every revision
- Repro: `node partial.cjs` (5 commits, `git clone --filter=blob:none file://…`, 4 old blobs missing). Output:
  `picker sources [ 'main (live)' ] excluded [ 'origin/main: … git-cat-file-check-closed (128): warning: lazy fetching disabled…', 'facaa2b0 (HEAD, complete): …', … ]` and `generate -> ERROR Project evolution needs at least two revisions with data; 1 remain after filtering.`
- Manual: `printf "$cur\n$old\n" | GIT_NO_LAZY_FETCH=1 git cat-file --batch-check` → first line OK, then `fatal: could not fetch 0bd5aac… from promisor remote`, exit 128. `GitBatchMetadataReader` (`gitBatchObjectReader.ts:185-226`) then fails every pending and future request (terminalError), so complete revisions are excluded too, with a cryptic reason instead of `PARTIAL_CLONE_MISSING_MESSAGE`. Commit cd86c96b handles only the git 2.5x "BAD size" output. Git 2.43 is the Ubuntu 24.04 default. The existing test (`crossPlatformOffline.test.cjs:69`) only exercises `materialize`, so it passes here.
- No network was used (good). Severity: major for partial-clone users on git 2.43 (all Git modes, shared catalogue, unusable).
- Proposed issue: "Partial clone on git 2.43: one missing blob kills cat-file --batch-check and excludes every revision, HEAD included".

### EVO-16 (still failing): data transitions not exception-safe
- `framePlaybackEngine.js:94-130` (`applyBridgeFrameToChart`) and `:43-59` (`applyEvolutionChartSelection`): no try/finally around begin…finish. Same as audit; not reproduced at runtime (would need a throwing Babia/mapping step).
- Proposed issue: "Evolution: wrap chart data transitions in try/finally (cancel on throw)".

### EVO-19 (partial): docs miss partial-clone and cost caveats
- Proposed issue: "PROJECT_EVOLUTION_XR.md: document per-revision cost and partial-clone behaviour".

## Commands run
(all with `export PATH=/opt/node24/bin:$PATH; unset NODE_OPTIONS`, cwd = scratch dir unless noted)
- `node repro-generating-stuck.cjs`; `node repro-cleared-stuck.cjs` (original repros, unchanged)
- `node --test --test-name-pattern="^C:|^E:|^H:" hostRepro.test.cjs` (original; A no longer applies as written: the job slot is released by an unref'd grace timer, so a standalone script needs a keep-alive)
- `node verifyA.cjs` (EVO-3/EVO-2 hang + watchdog), `node cancel.cjs` (EVO-2 cancel keeps movie, EVO-8 snapshots)
- `node hostVerify.cjs B,F,G,H,J,O,K` and `node hostVerify.cjs D,I` (EVO-4/5/2/11/18/6/7/12)
- `node g2.cjs` ×11 (EVO-2 snapshot race, real catalogue)
- `node partial.cjs` (EVO-10, file:// promisor remote) + manual `git cat-file --batch-check` in the clone
- `node L.cjs` (EVO-8 materialize cost)
- Python worker (EVO-9): `PYTHONIOENCODING=cp1252 python git_export_analysis_worker.py` fed raw UTF-8 and `asciiJson` commands for a path under `Adrián/`
- From `apps/vscode-extension`: `node --test test/analysis/{crossPlatformOffline,gitHistoryServices,gitListReferences,gitTimeline,jobRunner,projectEvolutionRuntime,gitRevisionExporter,gitRevisionExportPhases,gitExportPreflight,exportPackageTransaction,exportManifest,gitRefPickerRuntime,gitMaterializeDirectory}.test.cjs` → all pass (5, 31, 4, 7, 8, 19, 15, 7, 1, 3, 11, 7, 6; 0 fail, 0 skipped)
- `node test/runners/run-project-evolution-harness.cjs` → exit 0 (offline vendored libs via harnessBrowser)

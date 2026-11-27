# XR audit: fix verification (epic #72)

Date: 2026-11-26. Checked: `v1.2.1` @ `6f827a19` (after PR #99, the last merge of epic #72).

This is an independent check that the 102 findings of the [XR audit](../README.md) are really fixed.
It did not trust the PR descriptions or the CHANGELOG: every verdict comes from running something
against the current compiled code, or from reading the current code path. It was run as seven parallel
checks, one per area, reusing the audit's own repro scripts (adapted where modules had moved) and
adding new probes where a repro no longer fit. No code was changed.

## Result

| Area | Report | Findings | Fixed | Partial | Still failing | Manual only |
|---|---|---|---|---|---|---|
| In-scene panels | [panels.md](panels.md) | 9 | 6 | 2 | 0 | 1 |
| Launch, servers, sessions | [launcher.md](launcher.md) | 18 | 18 | 0 | 0 | 0 |
| Charts and containment | [charts.md](charts.md) | 18 | 14 | 3 | 1 | 0 |
| Project evolution | [evolution.md](evolution.md) | 20 | 15 | 4 | 1 | 0 |
| Dependency graph | [depgraph.md](depgraph.md) | 12 | 11 | 1 | 0 | 0 |
| Historical comparison | [historical.md](historical.md) | 13 | 7 | 5 | 1 | 0 |
| Mode switching and lifecycle | [lifecycle.md](lifecycle.md) | 12 | 9 | 2 | 1 | 0 |
| **Total** | | **102** | **80** | **17** | **4** | **1** |

- **All 6 blockers are fixed, each proven by re-running its repro**: PANELS-1, CHARTS-1, CHARTS-10,
  EVO-1, LIFECYCLE-1, LIFECYCLE-4.
- **41 of the 47 major findings are fully fixed.** The other 6 are partly fixed (below).
- No regression was found. The 4 "still failing" items are all minor.
- Several fixes can only be confirmed on another platform: LAUNCHER-13 (macOS/Windows port sharing,
  not covered by the manual guide), LAUNCHER-15, EVO-9 and HIST-6 (Windows, simulated here; manual
  guide rows 4.1 and 4.2), PANELS-8 (headset; row 1.1).

## Test suites on the same commit

| Suite | Result |
|---|---|
| `npm test` (typecheck, lint, unit) | 1173 / 1173 pass |
| `npm run test:python` | 83 / 83 pass |
| `test:xr-harness`, `test:xr-chart-bounds-harness` (24 scenes), `test:xr-mode-harness`, `test:project-evolution-harness` | pass |
| `test:xr-immersive-harness` | passes on an idle machine; fails ("W must move the rig forward") while seven other Chromium checks run in parallel. This is the known frame-time limit of aframe-extras (frames over 200 ms drop movement), not a regression, but it is still load-sensitive. |

Environment note: the pinned Playwright looks for `chromium_headless_shell-1228`; this container only
had build 1243, so the browsers were pointed at it. Nothing in the repo depends on that.

## Major findings that are only partly fixed

| ID | What is fixed | What is left |
|---|---|---|
| PANELS-3 | Two "+ Add screen" presses land 5 m apart. | A screen brought 0.2 m in front of another still hides it (the overlap check only tests box intersection). "Bring" next to a wall can place a screen outside the room (no clamp when no free spot is found, `placementRegistry.js`). |
| EVO-2 | Cancel is separate from Clear, keeps the old movie, kills the children and frees the slot. | The same commit picked twice in manual mode (a tag plus its commit) races on one `snapshots/<sha>` folder: partial frames, ENOENT, and a commit hidden for the session. |
| EVO-8 | No per-revision VS Code notification, snapshots released, cache capped. | Still one `git show` per file and revision (`gitRepositoryService.ts:422-438`, 4.4 s per revision at 1000 files); identical files are not deduplicated across frames. |
| EVO-10 | Git no longer downloads anything in a partial clone. | On git 2.43 (Ubuntu 24.04 default), the first missing blob kills `git cat-file --batch-check`, so every revision is excluded, HEAD included, with a cryptic "git-cat-file-check-closed (128)". CI runs git 2.56, which is why the tests pass. |
| HIST-3 | Switching between two flat charts keeps the comparison data. | Switching to or from Babia Boats rebinds both comparison sides to the wrong data (empty `tree`, or the normal analysis). |
| HIST-7 | Timeouts on git, Python, each revision and the job; Cancel in XR frees the slot. | LivePanel has no Cancel; leaving History does not cancel a job that has no result yet. |

## Minor findings not fully fixed

| ID | Verdict | What is left |
|---|---|---|
| CHARTS-16 | Still failing | Hovering a pie/donut slice, rebuilding, then moving away throws `removeChild`; the BabiaXR compat patch does not guard the hover legend. |
| EVO-16 | Still failing | The chart data transition in `framePlaybackEngine.js` has no try/finally; a throw leaves the chart uncontained. |
| HIST-12 | Still failing | Comparison clones copy every attribute except a blocklist; the mode-cycle harness has no comparison scenario, which is why HIST-3 is not caught. |
| LIFECYCLE-8 | Still failing (harness layout only) | Comparison clones keep the normal chart's `data-codexr-*` markers. Real scenes wrap the chart and are not affected. |
| PANELS-9 | Partial | The evolution overlay is still at a fixed position; controller panel and guide anchor ignore cards. |
| CHARTS-12, CHARTS-17 | Partial | Re-analysis and mapping validation still run on fixed timers instead of waiting for the chart. |
| CHARTS-18 | Partial | Chart titles are not escaped (`;` in a folder name breaks the attribute); `buildFilteredBounds` ignores hidden ancestors; render budget skips Babia charts. |
| EVO-19 | Partial | `PROJECT_EVOLUTION_XR.md` omits the per-revision cost and partial-clone behaviour. |
| DEPGRAPH-7 | Partial | Clicks during a re-analysis are dropped with no message. |
| HIST-8 | Partial | Startup cleanup never sweeps `historical-comparisons/`. |
| HIST-11 | Partial | No "load more" or by-SHA entry past 200 commits; no progress while indexing. |
| HIST-13 | Partial | LivePanel learns that a comparison finished only through SSE; no status endpoint or poll. |
| LIFECYCLE-11 | Partial | Dependency-graph mount and collaboration registration still give up silently. |
| LIFECYCLE-12 | Partial | Normal-analysis activation has a promise with no `.catch`. |

## New problems found during the verification

- **Dependency graph, bogus "packages" (minor):** class and generic declarations still create external
  packages (`pass`, `string>`, `any`, `|`), from an older pattern in
  `backend/src/utils/dependency_analysis_engine.py:60-62`.
- **Dependency dataset pruning (minor, inferred):** pruning keeps the two highest-numbered files, but
  numbering restarts at 0 when the service is recreated. A server restarted on an existing folder would
  delete the file it just wrote. No path that does this was found.
- **Historical deep comparison (performance):** copies files one git call at a time, 10.9 s for 1,501 files.

## Proposed follow-up issues

Grouped so each is one story. Not created yet.

1. Screen placement: treat a screen stacked in front of another as blocked, and clamp "Bring" to the room (PANELS-3).
2. Project evolution: deduplicate same-commit sources so they do not race on one snapshot folder (EVO-2).
3. Partial clones on git < 2.5x: survive a missing blob in `cat-file --batch-check` instead of excluding every revision (EVO-10).
4. Project evolution performance: batch file reads per revision and reuse identical blobs across frames (EVO-8, plus the deep historical copy).
5. Historical comparison: correct data binding when switching to/from Babia Boats, whitelist clone attributes, and add comparison scenarios to the mode-cycle harness (HIST-3, HIST-12, LIFECYCLE-8).
6. LivePanel historical: Cancel button, cancel a result-less job on mode leave, and a status endpoint (HIST-7, HIST-13).
7. Robustness pass on minor items: CHARTS-16 legend guard, EVO-16 try/finally, CHARTS-18 title escaping, LIFECYCLE-11/12, DEPGRAPH-7 busy message, HIST-8 cleanup.
8. Dependency graph: drop declaration-derived bogus external packages.
9. Manual check on macOS/Windows of the port probe against a local dev server (LAUNCHER-13); add a row to the manual test guide.

Timer-driven waits (CHARTS-12, CHARTS-17), PANELS-9, HIST-11 and EVO-19 are polish and can wait.

## How to read the area reports

Each area report has a table of verdicts, details for anything not fully fixed, and the commands run.
Paths shown as `<scratch>/…` were throwaway probes in the verification session and are not committed;
the audit's original repro scripts are in the project's shared files (`xr-audit/repro/`).

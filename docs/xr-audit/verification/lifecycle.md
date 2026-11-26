# Verification: lifecycle (LIFECYCLE-1..12), branch v1.2.1 @ 6f827a19

Repro scripts copied to `verify/lifecycle/`. The harness is served over HTTP from a mirror `verify/lifecycle/ext/` (symlinks to the repo `templates/`, `test/vendor`, `test/helpers`; a copy of `test/manual` with freshly assembled runtimes), so the repo's `test/manual/assembled` was not touched by the audit scripts. Chromium = /opt/pw-browsers/chromium-1243 via `harnessBrowser.cjs` (offline).

| ID | Sev | Verdict | Evidence (short) |
|---|---|---|---|
| LIFECYCLE-1 | B | FIXED (verified by run) | `scenarios.cjs activateHangs` (dataset fetch hangs): opening the selector lands in `selection` (tr=false), picking Normal -> `mode single, transitioning false`, normal chart visible (before: stuck in dependency-graph forever). Audit vm test 2 now fails (transition settles). Code: AbortController + `settleWithin` watchdog, default 45 s (`selectorAndPanel.js:500-560`, `constantsAndDomUtils.js:79`). |
| LIFECYCLE-2 | G | FIXED (verified by run) | `selectorLateMessage`: server message order now `selection, activate:historical, refs-request, selection, activate:dependency-graph`; client stays `dependency-graph` for 4.8 s (before: snapped back to selection). Audit vm test 1 now fails (no late selection sent). |
| LIFECYCLE-3 | G | FIXED (verified by run) | `activateThrows`: VISIBLE "Could not open Dependency graph: ... Pick it again to retry", `analysis-mode-selection` sent after the failure, dep activate called once (before: hidden message, activate twice, server never told), `requested: single`. Audit vm test 3 now fails. |
| LIFECYCLE-4 | B | FIXED (verified by run) | `pe-scenario.cjs` all 3 cases: re-entry lands in `project-evolution`, no TypeError logged (before: TypeError and bounce to selection). No-treebuilder case leaves no half-built root. |
| LIFECYCLE-5 | G | FIXED (verified by run) | `datasetFails` (HTTP 500): mode -> selection with VISIBLE "Could not open Dependency graph: The dependency data could not be loaded (HTTP 500). Pick it again to retry..." (before: empty mode reading "ready"). |
| LIFECYCLE-6 | m | FIXED (verified by run) | `dep-start.cjs` (start message dropped): 1.5 s VISIBLE "Opening dependencies..."; 21.5 s VISIBLE "The dependency analysis did not respond. Try again." and unlocked. `attemptSend` capped (`START_SEND_MAX_ATTEMPTS`, `viewLifecycle.js:288`). |
| LIFECYCLE-7 | G | FIXED (verified by run) | Harness over HTTP and file://: `babia-queryjson` = `url: ./xr-mode-normal-data.json?codexrModeRevision=1&t=...`, fetch to the right URL, no "URL scheme" error (before: `url: url: ...` every load). SSE client also strips a leaked `url:` (`live_sse_fileXR.js:219-278`). Unit test in dependencyGraph.test.cjs passes. |
| LIFECYCLE-8 | m | STILL FAILING | `hist-scenario.cjs`: after a comparison, back in single, `codexrComparisonChartLeft/Right` have parent `codexrAnalysisSurface`, rendered, attrs `data-codexr-normal-root=true data-codexr-analysis-mode=single`. Deny-list in `comparisonCharts.js:153-169` still copies `data-codexr-*` markers; `getNormalSurfaceRoots` (`surfaceAndRefresh.js:53-71`) still adopts every marked node. Harness-only trigger (real template wraps the chart in `#codexrNormalAnalysisRoot`), same as audit. |
| LIFECYCLE-9 | m | FIXED (verified by code reading + unit tests) | Per-entity try/catch with console.error (`entitySync.js:204-220`), parse separated from dispatch (`clientCore.js:306`); collaborationRuntime.test.cjs (S7 cases) passes. |
| LIFECYCLE-10 | m | FIXED (verified by run) | `sse-test.cjs`: after a server-side drop, 2 connections (1 open) and the post-reconnect `dataRefresh` refreshes (before: 3 connections, no refresh). DOM client reloads only after a reconnect following an error, with back-off (`live_sse_fileDOM.js:55-95`). liveReloadClient.test.cjs passes. |
| LIFECYCLE-11 | m | PARTIAL | Fixed: collab WebSocket exponential back-off + jitter (`clientCore.js:241-252`); revision floor reset on room snapshot (`snapshotsAndLifecycles.js:244-249`); analysis-view registration warns at 3 s and keeps polling. Still: dependency `mount` retries 30x100 ms and stops silently (`viewLifecycle.js:413-415`); registerCollaboration stops after attempt 90 (~63 s) without a final log (`snapshotsAndLifecycles.js:231-234`). |
| LIFECYCLE-12 | m | PARTIAL | Fixed: worker Blob URL revoked (`scalesAndControls.js:508-513`); single references-request per entry (selectorLateMessage sent list shows one). Still: `single` activate `void waitForNormalChartReady(...).then(...)` has no `.catch` (`snapshotsAndLifecycles.js:201-213`). leakCycles not re-run. |

Extra: `node test/runners/run-xr-mode-cycle-harness.cjs` (test:xr-mode-harness) passes, including the new dependency-graph scenarios. `rapidSwitch` still converges (single / dependency-graph finals, transitioning false).

Counts: FIXED 9, STILL FAILING 1, PARTIAL 2.

## Still failing / partial

### LIFECYCLE-8 (m) STILL FAILING
- Evidence above (`verify/lifecycle/hist-scenario.cjs` output). Only reachable when the normal chart itself carries the root markers (harness layout); real generated scenes wrap it, so LIKELY not user-facing today.
- Proposed issue: "Historical comparison clones copy data-codexr-* ownership markers; Normal analysis adopts them (strip markers / restrict mountNormalRoots)".

### LIFECYCLE-11 (m) PARTIAL
- Proposed issue: "Dependency-graph mount and analysis-view collaboration registration still give up silently after their retry caps".

### LIFECYCLE-12 (m) PARTIAL
- Proposed issue: "Normal-analysis activate: add .catch to waitForNormalChartReady so a rejection still shows the chart and logs".

## Commands run
```
export PATH=/opt/node24/bin:$PATH; unset NODE_OPTIONS; cd verify/lifecycle
node --test unit/lifecycle-audit.test.cjs            # 3/3 bug-asserting repros now FAIL (= fixed)
node scenarios.cjs activateHangs activateThrows datasetFails selectorLateMessage rapidSwitch
node pe-scenario.cjs; node dep-start.cjs; node hist-scenario.cjs; node sse-test.cjs
node probe-url.cjs; node probe-url-http.cjs
cd /home/user/Code-XR/apps/vscode-extension
node --test test/analysis/collaborationRuntime.test.cjs test/analysis/liveReloadClient.test.cjs test/analysis/dependencyGraph.test.cjs   # 65/65
node test/runners/run-xr-mode-cycle-harness.cjs      # passed
```

# Verification: charts (CHARTS-1..18), v1.2.1 @ 6f827a19

Scenes were regenerated from the CURRENT compiled `out/` and `templates/`. `gen-scene.cjs` was rewritten to use `test/helpers/fakeVscode.cjs` and `DIRECTORY_XR_RUNTIME_ASSETS`, the same way `run-xr-chart-bounds-harness.cjs` does. No stale `scene-boats/` copy was used. The runs used real A-Frame 1.7.1 and BabiaXR 1.3.4, vendored through `test/helpers/harnessBrowser.cjs`, in headless Chromium with SwiftShader. Scripts, scenes and logs are in `<scratch>/charts/`.

Environment note: Playwright 1.61.1 looks for `chromium_headless_shell-1228`, but only build 1243 is installed. Every launch needs `executablePath: /opt/pw-browsers/chromium-1243/chrome-linux64/chrome`. For the repo runners I added it with a preload, `node -r pw-exe.cjs …`, without touching the repo.

| ID | Sev | Verdict | Evidence (short) |
|---|---|---|---|
| CHARTS-1 | B | FIXED (verified by run) | `run-initial` bars/cyls/barsmap/cylsmap at n=3/40/400: every settled chart is 0 m off the table (before: 1.25–2.6 m). The axis matches the slice (bars 3 rows → axis 3.75, 20 rows → 25; before: stuck at 50). Shrinks are also 0 m off: SSE re-analysis 40→5/12/3, remap x_axis→language (5 rows), evolution frame 160→3 rows. Fix: `analysisTableRuntime/babiaCompat.js` (direct `updateLine`, re-fit on axis resize). |
| CHARTS-2 | G | FIXED (verified by run + code) | `diagnosticsAndPid.js` `keepSpanInsideRegion` and `computeContainmentOverhang` now check the anchor by position. Across all runs no settled chart was off the table. Note: the check uses the "usable top" limit (6.154 m), not the 5.614 m target zone, so `offZoneX` is still up to 0.27 m (bars n=3, barsmap n=3, bubbles), but always on the table. |
| CHARTS-3 | G | FIXED (verified by run + code) | `geometryUtils.js` `refreshGeometryBoundingBox` recomputes the box on a position version or count change. The unit test "bounding boxes are recomputed when a line rewrites its positions in place" passes. Containment and my always-recompute probe agree after axis shrinks. |
| CHARTS-4 | G | FIXED (verified by run) | `frames-switch` (renderer hook, every drawn frame): boats → cylsmap/bubbles/bars/barsmap/cyls/boats drew 0 frames past the table. Before: 38–75 m frames for up to 1.6 s. The first visible frame is already fitted. pie/donut are flagged only because their 1.96 m height exceeds the old 1.8 m band, which S8 raised to 2 m on purpose. `frames-offset` (switches plus re-analyses): 0 bad frames out of ~36 each. |
| CHARTS-5 | G | FIXED (verified by run) | `frames-initial`: bars-3, cyls-40, barsmap-400 and bubbles-40 drew 0 over-table frames; worst height 1.3 m (before: 36 m towers until 3.2 s). `animation:false` is pinned by the unit test "no chart grows up from the floor". |
| CHARTS-6 | G | FIXED (verified by run) | The generated HTML contains `id="codexrChartDataSlice__data"` and `from: codexrChartDataSlice__data`. The chart-bounds runner asserts the chart only ever read the slice (all 21 budgeted scenes passed). My probe never saw `from: data`. |
| CHARTS-7 | G | FIXED (verified by run) | `ghost.cjs` remap x_axis fileName→language gives 5 elements, 5 distinct names, slice 5 (before: 20 elements, 15 ghosts). `dup.cjs DUP=8` with 120 files: bars and cyls render 8 elements for an 8-row slice (before: 120). |
| CHARTS-8 | G | FIXED (verified by run) | `run-evo.cjs bars` on the evolution harness: source `codexrChartDataSlice__codexrProjectEvolutionData`; the 160-row frame has 20 elements and 0 of 28 samples over the table (before: 138 elements, 129.9 m wide for 3.8 s); the 3-row frame settles 0 m off. |
| CHARTS-9 | G | FIXED (verified by code reading + unit) | `comparisonCharts.js:321-322` resolves each side's slice before building; `:196` takes the scale from the profile's `initialScale`, not `0.01 0.05 0.01`. `clone-check.cjs` on the current runtime gives scale `1.5 1.5 1.5` and keeps the slice source. The unit test "each comparison side reads the row-budgeted slice of its own revision" passes. Not measured visually (no live comparison run, same as the audit). Residual: `resolveComparisonSliceSource` falls back to the RAW source when the slice has not started within 1.2 s (`comparisonCharts.js:141-145`). |
| CHARTS-10 | B | FIXED (verified by run) | `run-reanalysis.cjs bars-40 … 5,drop,12,drop,drop,7`. After `dropClients()` the client reconnected (`clientCount` 1). A later `analysis-updated` with 12 rows reached the chart (`chartRows 12`, `dataUrl data.json?t=…` updated), and again after two more drops (7 rows). Before: ignored. Code: `live_sse_fileXR.js` `connectLiveReload()` binds every handler and reassigns `eventSource`. |
| CHARTS-11 | G | FIXED (verified by run + unit) | After every re-analysis the slice `sliceUrl` stays `''` (before: `?t=…`, which fetched `index.html`). `bustDataSource` and `withQueryParam` keep `?revision=`. The unit test "cache busting keeps query parameters and skips sources without a url" passes. |
| CHARTS-12 | m | PARTIAL | The revert is fixed, verified by run: `remap-during-sse.cjs` clicked x_axis→language and pushed `analysis-updated` while the mapping was pending. The remap survived (`sel`, `lkg` and the chart attribute are all `language`; `mapping-confirmed`). The fixed timers remain: `live_sse_fileXR.js:315,323,329,339,376,381,390` (100/240/260/300/900 ms), plus `waitForChartsStable` with an 8 s timeout. |
| CHARTS-13 | m | FIXED (verified by run) | An empty re-analysis (`[]`) gives `reason: 'no-data'`, `phase: empty`, valid and stabilized, with nothing visible, for both bars and boats (before: `invalid-axis-length`, or stuck in `waiting-geometry`). Both recover at 40 rows. |
| CHARTS-14 | m | FIXED (verified by run) | Bubbles n=40/400: `below = 0` (before: 0.38–0.60 m under the tabletop). |
| CHARTS-15 | m | FIXED (verified by run) | pie/donut are now about 1.96–2.0 m in diameter (before: 1.27 m), on the table. Whether that size reads well still needs a headset check (design call). |
| CHARTS-16 | m | STILL FAILING | `pie-legend.cjs` / `pie-legend-switch.cjs`: `mouseenter` on a pie slice, then a rebuild (switch to donut, or re-analysis 5→3 rows), then `mouseleave` gives `[pageerror] Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.` `babiaCompat.js` has no legend guard; the vendored Babia still does `n.removeChild(legend)`. |
| CHARTS-17 | m | PARTIAL | Fixed: evolution queues a second mapping change (`frameApplication.js:239-244`), and `getChartFromSource` keeps flat producers (`mappingProfiles.js:346-361`); both are covered by passing unit tests. Off-table geometry now counts as invalid (CHARTS-2), so switch validation can catch it. Remaining: validation bursts at 650…18000 ms (`pendingValidation.js:182`) and the 26 s `waitForChartsStable` timeouts (`:116,:138`). |
| CHARTS-18 | m | PARTIAL | The test gap is closed: `run-xr-chart-bounds-harness.cjs` now asserts world bounds against the table (24/24 pass). Still open: the chart title is interpolated unescaped (a generated scene with title `my;proj` gives `title: Directory Analysis: my;proj;`); `buildFilteredBounds` checks `node.visible` on the node only (`geometryUtils.js:446`); render-budget still does not cover Babia charts (the slice row budget mitigates it). |

Counts: FIXED 13 (CHARTS-1–11, 13–15), PARTIAL 3 (12, 17, 18), STILL FAILING 1 (16), NOT VERIFIABLE 0. The headset perception checks on CHARTS-4, 5, 8 and 15 remain manual.

## Still failing / partial

- **CHARTS-16 (minor), STILL FAILING.** Hovering a pie or donut slice during a rebuild throws an uncaught `removeChild` page error when the cursor leaves. Reproduced on the current code (see the table).
  Proposed issue: *"Guard BabiaXR pie/doughnut hover legend removal in babiaCompat (removeChild page error after a rebuild)"*.
- **CHARTS-12 (minor), PARTIAL.** A pending remap is no longer reverted. Re-analysis still runs on fixed wall-clock timers rather than a built signal.
  Proposed issue: *"Live reload: replace fixed 240/260/300/900 ms timers with the containment built signal"*.
- **CHARTS-17 (minor), PARTIAL.** The validation burst ladder and the 26 s timeouts are still in `pendingValidation.js`.
  Proposed issue: *"Mapping validation: drop the 650–18000 ms burst ladder and 26 s timeout in favour of the containment ready event"*.
- **CHARTS-18 (minor), PARTIAL.**
  Proposed issues: *"Escape `;` in chart titles interpolated into Babia component strings"*; *"buildFilteredBounds: decide and document whether hidden ancestors are measured"*. The second may be intentional now that containment measures a chart while it is hidden.
- **Observation (not a finding regression).** Two runs sampled a visible, unfitted state through the 200 ms DOM probe: 2.48 m off for barsmap at bootstrap or after a switch, and 7.45 m on a re-analysis 5→12 rows. No drawn frame ever showed it (renderer hook, 0 bad frames across ~250 frames in `frames-offset` / `frames-switch` / `frames-initial`). It is an intermediate state that is never painted in headless. At ~6–10 fps one painted frame could slip through, so it is worth a glance in a headset.
- **CHARTS-9 residual.** A comparison side silently renders unbudgeted raw data if its slice is not live within 1.2 s.

## Commands run

All commands ran with `PATH=/opt/node24/bin:$PATH`, `NODE_OPTIONS` unset, from the scratch dir unless noted.

- `node -r pw-exe.cjs test/runners/run-xr-chart-bounds-harness.cjs` (cwd: extension; runner only, no recompile). 24/24 ok, "Chart bounds harness passed", exit 0.
- `node -r pw-exe.cjs test/runners/run-xr-containment-harness.cjs` (= `test:xr-harness`). "Playwright harness validation passed", exit 0.
- `node --test test/analysis/{historicalComparison,liveReloadClient,xrAnalysisTableRuntime,xrChartMappingUiRuntime,xrChartTableBounds,projectEvolutionRuntime}.test.cjs`. 135/135 pass.
- `node run-initial.cjs bars,cyls,barsmap,cylsmap 3,40,400` and `node run-initial.cjs bubbles,pie,donut,boats 40,400` (axis and element counts added).
- `node frames-initial.cjs {bars-3, cyls-40, barsmap-400, bubbles-40}`.
- `node frames-switch.cjs boats-40 boats 40 cylsmap,bubbles,bars,pie,barsmap,cyls,donut,boats` (bbox now always recomputed).
- `node frames-offset.cjs boats-40 boats 40 sw:barsmap sw:bars sw:barsmap re:5 re:12 re:400 re:3` (new; offset per drawn frame).
- `WAIT=5000 node run-switch.cjs boats-40 boats 40 pie,bars,donut,boats,cylsmap,bubbles,barsmap,cyls,pie,donut,pie`.
- `node run-reanalysis.cjs bars-40 bars 40 5,drop,12,drop,drop,7`, `… bars-40 bars 40 0,40`, `… boats-40 boats 40 0,40`.
- `node ghost.cjs bars-40 bars 40 x language`, `DUP=8 node dup.cjs {bars,cyls}-dup-120 … 120`, `node run-remap.cjs bars-40 bars 40 x_axis=language`.
- `node run-evo.cjs bars` (serves a freshly assembled runtime copy from scratch, byte-identical to `test/manual/assembled`).
- `node clone-check.cjs` (current historical-comparison runtime in a vm).
- `node pie-legend.cjs`, `node pie-legend-switch.cjs` (new; CHARTS-16).
- `node remap-during-sse.cjs` (new; CHARTS-12).
- `TITLE='Directory Analysis: my;proj' node gen-title.cjs …` (CHARTS-18 title).

# Charts audit: build, rebuild and containment of BabiaXR charts on the analysis table

All paths below are relative to `apps/vscode-extension/` unless stated otherwise. `T/` = `templates/components/codexr/`.
The scripts and screenshots behind every number are in `/tmp/claude-0/-home-user/af5ccea8-f538-575c-b7b6-8256e5a53df6/scratchpad/audit/charts/`. `gen-scene.cjs` builds a REAL directory scene with the compiled `out/` TemplateProcessor and the real runtime assets. `lib.cjs` serves it, with a controllable `/events` SSE channel, and runs it with real A-Frame 1.7.1 and BabiaXR 1.3.4 in headless Chromium (SwiftShader). Its `__probe()` measures the world bounds of what is actually visible under `#chart` against the physical tabletop (6.514 x 4.118 m) and the containment target zone (5.614 x 3.218 m, centred at 0, 1, -18).

## 1. How the area works (summary)

1. **Initial generation.** `src/core/charts/templateCharts.ts` and `processing/placeholders/createChart.ts` + `createStructure.ts` emit one `<a-entity id="chart" codexr-chart-containment=... data-codexr-active-chart-id=...>`. That entity carries a `babia-*` component reading `from: data` (the raw producer). It also gets the profile's rotation and `initialScale`, and `#codexr-chart-base-config` (CHART_PRESENTATION_PROFILES from `chartPresentation.ts`).
2. **Row-budget slice.** At runtime the xr-chart-mapping-ui `chartDataSlice.js` creates a `codexrChartDataSlice__<source>` babia-queryjson entity (ranked, deduped top-N rows) and re-points the chart's `from` at it, polling every 400 ms for up to 25 attempts.
3. **Mapping UI.** `mappingProfiles.js` changes chart type (`applyChartTypeToEntity`: strip components and children, marker, rotation, `initialScale`, new component, orphan sweeps) and remaps fields (`applyMappingToCharts`). It keeps its own mirror of the presentation profiles. `pendingValidation.js` validates and confirms or reverts the change.
4. **Containment.** `codexr-chart-containment` (analysis-table runtime) measures three bound sets (full / primary content / containment), scales by size against a limit and anchors the PRIMARY bounds on the tabletop. It is driven by throttled `requestRenormalize`, retries, a steady controller and timer bursts.
5. **Paths that rebuild the chart outside the mapping UI:**
   - SSE re-analysis (`templates/xr/sse/live_sse_fileXR.js`): cache-busts queryjson URLs, restores UI state, fires fixed timers.
   - Project evolution (`declarativePipeline.js buildEvolutionChart`, frame swaps with data transitions).
   - Historical comparison (`comparisonCharts.js createChartFromTemplate` clones).
6. **Two builders, five drivers.** There are two chart builders (the generator and `buildDeclarativeChartEntity`) and five drivers, each with its own timers. None of them waits on a deterministic "Babia finished building" signal. render-budget does not touch Babia charts at all.

## 2. Findings

### CHARTS-1: Babia axis lines never shrink, so row charts settle off the table (and containment reports "ok")
- **Severity:** blocker
- **Type:** bug
- **Evidence:**
  - BabiaXR 1.3.4 axis components animate `line__xaxis.end` through A-Frame's `animation` component. Under A-Frame 1.7.1 that animation is a no-op on the line component's `end` property. `animtest.cjs` proved it: both an object `to` and a string `to` leave `end` at its first value (x = 50) forever. The axis is drawn once at its first length and never shrinks.
  - The generated chart builds first from the raw producer, `src/core/charts/templateCharts.ts:113,157,203`: `componentBody: \`from: data;` (all rows). It is re-pointed to the 20/30-row slice later, so the axis is first sized for ALL rows.
- **Measured (final, settled state, `run-initial.cjs`, `initial.log`):**

  | chart | rows | axis local length vs needed | final world bounds vs tabletop | status |
  |---|---|---|---|---|
  | bars | 40 | 50 vs 25 | 1.35 m off table on x | settled, ok |
  | bars | 400 | huge | 20 bars squeezed into a sliver; scale 0.0094; 4.7 m width is mostly empty axis | settled, ok |
  | cyls | 40 | | 1.25 m off | settled, ok |
  | barsmap | 400 | | 2.60 m off | settled, ok |
  | cylsmap | 400 | | 2.59 m off | settled, ok |

  The same stale axis appears on every shrink:
  - SSE re-analysis 40 → 5 rows: 2.48 m off (`run-reanalysis.cjs`, `re-bars.log`).
  - Remap x_axis → language (5 distinct): 1.42 m off (`run-remap.cjs`).
  - Evolution frame 160 rows → 3 rows: 1.51 m off (`run-evo.cjs`, `shots/evo-bars-frame3(3 rows).png`).
  - Screenshots: `shots/initial-bars-40.png`, `shots/initial-bars-400.png`.
- **Failure scenario:** any directory with more than 20 files opens a bars/cyls/barsmap/cylsmap scene whose axis hangs over the table edge, or whose bars are a thin sliver at one end of a long empty axis. Every later shrink makes it worse.
- **Confidence:** CONFIRMED. Real scenes, real Babia, measured per frame. `axisfix.cjs` showed that forcing `axis.updateLine` with animation off brings the vertices to 25 (correct).
- **Proposed fix:**
  - (a) Add a CodeXR Babia-compat shim, loaded right after the Babia bundle. It wraps `AFRAME.components['babia-axis-x'|'babia-axis-y'|'babia-axis-z'].Component.prototype.init/update` so that `this.axis.anim = false` and the line is rewritten directly.
  - (b) Generate the chart reading from the slice (see CHARTS-6), so the first build already has the budgeted row count.
- **Test:** a Playwright harness scenario (template: `run-initial.cjs`) for bars/cyls/barsmap/cylsmap at n = 3/40/400. Assert that the x-axis line vertex extent equals the bar count times the spacing, and that `overGeo.offTableX/Z === 0` after settle. Also add a unit test that the shim sets `anim=false`.

### CHARTS-2: Containment checks size, never position, so the chart is "ok" while hanging off the table
- **Severity:** major
- **Type:** bug
- **Evidence:**
  - `T/analysis-table/analysisTableRuntime/containmentLimits.js:98-` `computePlanarAxisTargetScale(primarySize, containmentSize, currentScale, containmentLimitSize, ...)`: `var ratio = primarySize / containmentLimitSize;`. Only sizes go in. The limit is targetWidth + tableTopPadding (0.9) − 2 × edgeMargin (0.18) = 6.154 m, which is wider than the 5.614 m zone.
  - `diagnosticsAndPid.js:248` `computeAnchorOffset` centres the PRIMARY bounds. The primary set excludes `axis|tick|grid|label|legend|title` (`zonesAndProfiles.js:267-268`), so axes and labels that extend to one side are never centred or clamped.
  - The steady controller's settled watch (`steadyController.js:440-500`) compares sizes only. `waitForChartsStable` and `pendingValidation.js evaluatePendingMapping` accept these states.
- **Failure scenario:** with bars n = 3, the bars are centred but the axis/labels extend to one side: 0.33 m off the TABLE and 0.78 m off the zone, at 6.098 m wide, while `getChartStatus()` returns `ready/valid/stabilized, reason ok`. All of CHARTS-1 passes validation for the same reason.
- **Confidence:** CONFIRMED (`run-initial.cjs`, probe vs `getChartStatus()`).
- **Proposed fix:**
  - The fit computes the world AABB of the containment bounds and checks `min/max` against the zone rectangle.
  - The anchor centres the containment bounds when they are offset from the primary bounds (or clamps the offset so that `[min, max]` stays inside).
  - Expose `offZoneX/Z` in `getChartStatus()`. Make `valid` false when either value exceeds the tolerance.
- **Test:**
  - Unit test in `test/analysis/*` on `computeAnchorOffset`/limits, with an asymmetric containment box.
  - Harness assertion: `status.valid === true` implies `overAll.offZoneX/Z <= 0.02`.

### CHARTS-3: Containment measures with a stale cached `geometry.boundingBox`
- **Severity:** major
- **Type:** bug
- **Evidence:** `T/analysis-table/analysisTableRuntime/geometryUtils.js:365-366`
  ```js
  if (!node.geometry.boundingBox && typeof node.geometry.computeBoundingBox === 'function') {
    node.geometry.computeBoundingBox();
  ```
  Babia and A-Frame's `line` component rewrite positions in place, so the cached box is never invalidated.
- **Failure scenario:** after an axis update, the line vertices span 25 but the measured bbox still spans 50 (`axisfix.cjs`). Containment fits the old geometry, so the chart either shrinks for nothing or misses an overflow. Any in-place geometry update (axis, line, text re-layout) is affected.
- **Confidence:** CONFIRMED (`axisfix.cjs`: verts 25, bbox 50, before the probe was changed to always recompute).
- **Proposed fix:**
  - Always call `computeBoundingBox()` during a measurement pass. The cost is trivial at Babia mesh counts.
  - Or compare `geometry.attributes.position.version` against a cached version.
- **Test:** a unit test with a fake geometry whose positions change after the first measure. Assert that the second measure reflects the change.

### CHARTS-4: Chart switch renders a giant unfitted chart for up to 1.6 s, then animates from it
- **Severity:** major
- **Type:** bug / ux
- **Evidence:**
  - `mappingProfiles.js:257-261` (and the presentation profile): `initialScale: '1.5 1.5 1.5'` is applied by `applyChartTypeToEntity` before Babia builds.
  - `diagnosticsAndPid.js:22` `shouldAnimateContainmentTransform`: any reason other than `init`/`bootstrap-visible`/`hard-height-guard` (i.e. mapping, componentchanged, analysis-updated) animates 650 ms from the CURRENT (unfitted) transform.
  - `containmentComponentCore.js` `requestRenormalize` is a 280 ms leading-edge throttle that drops the trailing request.
- **Measured** with a renderer hook recording the world bounds of every drawn frame (`frames-switch.cjs`, `switch40.log`), on a switch from boats with 40 rows:

  | target chart | worst drawn frame | how long |
  |---|---|---|
  | cylsmap | 75 x 15 x 17 m | |
  | bubbles | 65 x 12 x 29 m | |
  | bars | 38 m wide, over 1.8 m tall | up to 1.6 s |

  Sampled worst off-table: 34–72 m.
- **Failure scenario:** in a headset every chart switch flashes a building-sized chart around the user for about a second before it shrinks onto the table. This is the "floating chart after a switch" symptom.
- **Confidence:** CONFIRMED in the headless renderer. Needs the maintainer's eyes in a headset to judge the perceived severity; frame timing differs on a Quest.
- **Proposed fix:**
  - Hide the chart (`object3D.visible = false`) from component install until the first fit after the "built" signal, then reveal it.
  - Never animate from a transform that was never fitted: only animate between two fitted transforms.
  - Make the throttle trailing-edge, so the last request always runs.
- **Test:** harness scenario `frames-switch.cjs` (8 chart types x 3 sizes). Assert that no drawn frame has `overGeo` off the table by more than 0.05 m or a height above the band.

### CHARTS-5: Initial build is fitted mid-growth, which draws towers 25–36 m tall for about 3 s
- **Severity:** major
- **Type:** bug / ux
- **Evidence:**
  - BabiaXR row charts default `animation: true`, `dur: 2000` (bars grow from 0).
  - Containment fits while the heights grow, so the y scale reaches 2.49. When growth finishes, the drawn height overshoots until the next pass.
  - `chartPresentation.ts` `baseAttributes` for bars/cyls/barsmap/cylsmap do not set `animation: false`.
- **Measured** (`frames-initial.cjs`):
  - bars, 3 rows: 10 of 53 drawn frames over the table; worst drawn height 36.2 m at 1.9 s; last over-table frame at 3.19 s.
  - cyls, 40 rows: first over-table frame 96.8 m wide; worst height 29 m; last over-table frame at 3.28 s.
  - SSE re-analysis to 5 rows: 26.5 m tower (`re-bars.log`).
  - Remap: 12.5 m tower.
- **Failure scenario:** the first seconds of every scene and every re-analysis show a tower through the ceiling.
- **Confidence:** CONFIRMED (headless). Needs a headset check for perceived impact.
- **Proposed fix:**
  - Set `animation: false` in `baseAttributes` for all row charts (both the TS profile and the runtime mirror).
  - Alternatively, keep Babia's animation but treat "animation finished" as part of the built signal and keep the chart hidden until then.
- **Test:** same per-frame harness on the initial load, n = 3/40/400 for every chart type.

### CHARTS-6: Generated scenes build from raw data first and are re-pointed to the slice later
- **Severity:** major
- **Type:** architecture / bug
- **Evidence:**
  - `src/core/charts/templateCharts.ts:113,157,203`: `from: data;`.
  - `T/xr-chart-mapping-ui/xrChartMappingUiRuntime/chartDataSlice.js` `scheduleChartDataSliceSync` (400 ms x 25 attempts) creates `codexrChartDataSlice__data` and rewrites `from` afterwards.
- **Failure scenario:** every scene does two Babia builds. The first is over all N rows (400 bars, the oversized axis of CHARTS-1, the containment fit on the wrong geometry), and the second runs over the slice. If the mapping-ui runtime fails to load or errors, the chart stays unbudgeted forever.
- **Confidence:** CONFIRMED (probe `from` changes from `data` to `codexrChartDataSlice__data` during the first seconds; the axis length stays at the raw-row value).
- **Proposed fix:** emit the slice entity in the generated HTML (or compute the slice in TS at generation time into a second producer) and generate the chart with `from: codexrChartDataSlice__data`.
- **Test:**
  - TS unit test: the generated HTML for each chart id contains the slice producer and `from: codexrChartDataSlice__`.
  - Harness: `from` never equals `data` in any probe sample.

### CHARTS-7: Remap leaves ghost bars (the component is updated before the slice)
- **Severity:** major
- **Type:** bug
- **Evidence:** `T/xr-chart-mapping-ui/xrChartMappingUiRuntime/mappingProfiles.js:196-225`. `setDeclarativeAttribute(chartEntity, componentName, ...)` runs for every entity first. `refreshChartDataSlicesForMapping(...)` runs only after the loop. Babia therefore rebuilds once on the OLD slice with the NEW key field.
  - In that rebuild, babia-bars reuses elements keyed by `babia-name`. Its `currentBars` map is built before the loop, so duplicate keys create elements that are never tracked or removed.
- **Measured** (`ghost.cjs`, `shots/remap-bars-40-x_axis-language.png`):
  - Remap x_axis fileName → language: 20 bar elements with 5 distinct names while the slice has 5 rows. 15 ghosts persist after the mapping is confirmed.
  - Real-world variant (`dup.cjs`, `DUP=8`, `shots/dup-bars-dup-120.png`): a 120-file project whose basenames repeat (`index.ts`, `__init__.py`) renders 120 bar elements against an 8-row slice, a wall of bars.
- **Confidence:** CONFIRMED.
- **Proposed fix:**
  - Recompute the slice BEFORE writing the component (producer → slice → chart order).
  - Clear the chart's children when the key field changes.
  - In the slice, dedupe on the effective key (already partially done by `keyBy`), and for the initial raw build, see CHARTS-6.
- **Test:** harness remap scenario. Assert that the count of `[babia-name]` children equals the slice length, and that the names are unique.

### CHARTS-8: Evolution flat charts bypass the slice, which gives walls of bars and about 3.8 s of frozen, oversized frames
- **Severity:** major
- **Type:** bug / architecture
- **Evidence:**
  - `T/project-evolution/projectEvolutionRuntime/declarativePipeline.js:3,129,184`: `EVOLUTION_DATA_ID = 'codexrProjectEvolutionData'`, passed as `sourceId` for non-boats charts.
  - `buildDeclarativeChartComponentData` keeps `ordered.from = existingData.from` (raw).
  - `declarativePipeline.js:465,480`: `if (component.animation === true)` … `(!sawAnimation || component.animation !== true)`. `animation` is a static schema flag, not "animating now", so the wait never ends early and each frame waits duration + 1800 ms.
  - Data transitions freeze containment for that whole wait.
  - `test/analysis/projectEvolutionRuntime.test.cjs:265` pins the raw source: `circular.getAttribute('babia-doughnut') === 'from: codexrProjectEvolutionData'`.
  - `test/runners/run-project-evolution-harness.cjs` asserts `from: codexrProjectEvolutionData`.
  - `.claude/docs/XR_COMPONENTS.md` claims slices flow through evolution frames, which is wrong.
- **Measured** (`run-evo.cjs`, `shots/evo-bars-frame2(160 rows).png`):
  - A 160-row frame gives 138 bar elements (duplicate-key collisions), scale 0.0236, depth 2.4 cm.
  - Frame 1→2: the chart was 129.9 m wide from 176 to 3988 ms; 24 of 30 samples were over the table.
  - Frame to 3 rows: stale axis, 1.51 m off (CHARTS-1).
- **Failure scenario:** playing the evolution movie on a real repository shows unreadable walls of bars and building-sized transients on every frame.
- **Confidence:** CONFIRMED (headless). The movie timing should be judged by the maintainer in a headset.
- **Proposed fix:**
  - Route evolution through the same slice (`codexrChartDataSlice__codexrProjectEvolutionData`).
  - Replace the animation-flag wait with the built signal of the unified pipeline.
  - Keep the chart hidden or at its last fitted transform during the transition.
  - Update the two tests to assert the slice source, and fix the doc.
- **Test:** the unit test asserts the slice id. The harness plays 3 frames (160/40/3 rows) and asserts the per-frame bounds.

### CHARTS-9: Comparison clones bypass the slice and use a hardcoded scale
- **Severity:** major
- **Type:** bug / architecture
- **Evidence:** `T/historical-comparison/historicalComparisonRuntime/comparisonCharts.js:165,170`.
  ```js
  chartData.from = sourceId;            // codexrComparisonDataLeft (raw)
  clone.setAttribute('scale', '0.01 0.05 0.01');   // for every chart type
  ```
- **Failure scenario:** for a 400-file revision each side renders 400 bars with no budget, dedupe or value filter, and with duplicate-key collisions (CHARTS-7). The fixed non-uniform scale is wrong for pie/donut/bubbles (it distorts round charts) and ignores the presentation profile.
- **Confidence:**
  - CONFIRMED for the source and scale (`clone-check.cjs` ran the real `createChartFromTemplate` in a vm: `from: codexrComparisonDataLeft`, scale `0.01 0.05 0.01` for bars).
  - Visual overflow not measured, because the harness comparison run produced no clones (`cmp.cjs` abandoned). Needs the maintainer's eyes on a real comparison.
- **Proposed fix:** build clones through the unified pipeline, with a per-side slice and a per-side containment zone (half table).
- **Test:** extend `historicalComparison.test.cjs` (next to `:1044`, the rotation test) to assert the slice source and the profile scale. Add a harness scenario with two revisions of 400 rows.

### CHARTS-10: SSE reconnect creates an orphan EventSource, so live updates die until the page reloads
- **Severity:** blocker
- **Type:** bug
- **Evidence:** `templates/xr/sse/live_sse_fileXR.js:144-152`.
  ```js
  setTimeout(() => {
    ...
    eventSource.close();
    new EventSource('/events');
  }, 3000);
  ```
  The new EventSource is not assigned and has no handlers. Closing the original also disables the browser's built-in auto-reconnect.
- **Failure scenario:** the extension's server restarts, or the network blips (Wi-Fi on a headset). The page reconnects (server `clientCount` back to 1), but `analysis-updated` is ignored from then on and the scene silently stops updating.
- **Confidence:** CONFIRMED (`run-reanalysis.cjs`: after `dropClients()`, the orphan connected; a pushed `analysis-updated` changed neither the data URL nor the refresh count).
- **Proposed fix:** delete the custom reconnect and let the native EventSource retry. Or wrap creation in `connect()`, which re-attaches every handler and reassigns `eventSource`.
- **Test:** a harness scenario that drops clients, pushes `analysis-updated` and asserts a refresh. This file is shared by every XR scene, so it also needs a unit test with a fake EventSource.

### CHARTS-11: SSE cache-bust rewrites the slice entity's URL and drops query parameters
- **Severity:** major
- **Type:** bug
- **Evidence:** `templates/xr/sse/live_sse_fileXR.js:185-194`. Every `[babia-queryjson]` gets `url = urlStr.split('?')[0] + '?t=' + timestamp;`.
  - Slice entities have an empty URL (inline `data`), so they become `?t=…`, which fetches `index.html` as JSON and produces an unhandled rejection.
  - Comparison producers lose their `?revision=` parameter.
- **Failure scenario:** after a re-analysis, the slice producer briefly holds HTML-parse garbage or errors. The comparison sides reload the wrong revision (the default).
- **Confidence:**
  - CONFIRMED for the slice (observed `sliceUrl = '?t=…'` in `run-reanalysis.cjs`).
  - LIKELY for the comparison (from code).
- **Proposed fix:** cache-bust only entities with a non-empty URL and no `data-codexr-slice` marker, and preserve existing params (`URL` + `searchParams.set('t', …)`). Better, let the unified pipeline own re-analysis: refetch the producer, then recompute the slices.
- **Test:** a unit test of the cache-bust helper over three URL shapes (empty, plain, with query).

### CHARTS-12: SSE `restoreState` silently reverts a pending mapping, and fixed timers race the rebuild
- **Severity:** minor
- **Type:** robustness
- **Evidence:**
  - `live_sse_fileXR.js:112-113`: `mappingUiRuntime.restoreState(mappingUiState)` re-applies `lastKnownGoodMapping`.
  - The fixed delays (renormalize at 240/260 ms, boats at 900 ms, `completeNormalRefresh` at 300 ms, then `waitForChartsStable` with an 8 s timeout) are not tied to Babia completion.
  - Observed: the first `codexr-normal-analysis-refreshed` event had not fired within 7–8 s.
- **Failure scenario:** the user is mid-remap when a file save triggers re-analysis. The remap is silently undone. On a slow headset, the timers fire before the rebuild and containment fits the old geometry.
- **Confidence:**
  - LIKELY for the revert (code).
  - CONFIRMED for the event delay.
- **Proposed fix:** re-analysis calls `pipeline.rebuild({reason: 'analysis-updated'})` with the CURRENT (pending or confirmed) mapping. Remove the timers.
- **Test:** a harness test that starts a remap, pushes `analysis-updated` and asserts the remap survives.

### CHARTS-13: Empty re-analysis gives a misleading error or a stuck "rebuilding" state
- **Severity:** minor
- **Type:** ux
- **Evidence and measurements** (`run-reanalysis.cjs` with `[]`):
  - bars: `status.reason = invalid-axis-length` ("The selected mapping generated invalid axis values"), and the stale axis remains.
  - boats: stuck in `waiting-geometry` ("still rebuilding") indefinitely.
  - Both recover when data returns.
- **Failure scenario:** a directory whose files all get filtered out (or a parse failure) shows an error that blames the mapping, or a spinner that never ends.
- **Confidence:** CONFIRMED.
- **Proposed fix:** the pipeline detects zero slice rows before installing the component, clears the chart and shows an explicit "No data for this mapping" state. Containment treats empty as valid, with nothing to contain.
- **Test:** harness: push `[]` and assert the empty-state marker and `status.valid`.

### CHARTS-14: Bubbles are anchored on the smallest bubble, so the axes sink below the tabletop
- **Severity:** minor
- **Type:** bug / ux
- **Evidence:** `chartPresentation.ts` bubbles profile: `fit: uniform`, `surfaceLift: 0.03`. The primary bounds exclude the axes, so the anchor puts the primary geometry's lowest point on the table.
- **Measured:** n = 40 and n = 400, the axes sit 0.38–0.60 m BELOW the tabletop (`below` in `bsm1ndph5.output`), visible under the table (`shots/initial-bubbles-400.png`). They also stick out of the zone by 0.37–0.38 m on x.
- **Confidence:** CONFIRMED.
- **Proposed fix:** for charts with a y axis, anchor `min(containmentBounds.y)` to the surface, or set the Babia axis origin at y = 0 for bubbles.
- **Test:** harness: `overAll.below === 0` for every chart type.

### CHARTS-15: Pie and donut are tiny on the table
- **Severity:** minor
- **Type:** ux
- **Evidence:** a uniform fit limited by the height band (0.38–0.72 x 1.8 m) for a disc standing at `rotation 90 0 0`.
- **Measured:** about 1.27 m diameter on a 5.6 m table.
- **Confidence:** CONFIRMED.
- **Proposed fix:** exempt standing discs from the height band, or lay them flat with a slight tilt. This is a design call for the maintainer, in a headset.

### CHARTS-16: Babia pie hover legend throws `removeChild` during a rebuild
- **Severity:** minor
- **Type:** robustness
- **Evidence:** babia-pie `processData` removes all of the entity's children, while its hover legend lives in an implicit global. A rebuild during hover gives `[pageerror] ... removeChild` (observed in the switch logs).
- **Confidence:** CONFIRMED (page error seen); the user-visible effect is minor.
- **Proposed fix:** the compat shim guards the legend removal (`if (legend && legend.parentNode)`).

### CHARTS-17: The transaction and evolution mapping paths drop or mis-route changes
- **Severity:** minor
- **Type:** robustness
- **Evidence:**
  - `frameApplication.js:228`: `if (state.applyingMapping) { return; }`. A second mapping change made while the first applies is dropped, not queued.
  - `mappingProfiles.js getChartFromSource` returns `'data'` for any source that is not tree and not Comparison. Evolution's `resolveChartDataSourceId` call therefore updates the MAIN slice record as a side effect.
  - `pendingValidation.js`: `scheduleChartSwitchValidation` reverts only on invalid geometry, yet CHARTS-2 makes off-table geometry "valid". The validation bursts fire from 650 ms to 18 s, and the 26 s timeout reverts a valid but not stabilized chart.
- **Confidence:** LIKELY (code reading; not reproduced end-to-end).
- **Proposed fix:** a single queued transaction per chart entity in the unified pipeline (latest request wins after the current one settles). Source ids resolve explicitly per producer.

### CHARTS-18: Smaller robustness issues
- **Severity:** minor
- **Type:** robustness / test-gap
- **Issues:**
  - `geometryUtils.js` `buildFilteredBounds` checks `node.visible` on the node only, so meshes under an invisible ancestor are counted. Use `traverseVisible`. (SUSPECTED)
  - The chart title is interpolated unescaped into the component string in `templateCharts.ts`. A `;` or `:` in the folder name would break the attribute parse. (LIKELY)
  - render-budget covers only the logo, the dependency graph and debug. Babia charts (400-element comparisons, evolution walls) have no budget. (CONFIRMED by grep)
  - There is no test asserting world bounds against the table for any chart type. All existing harness checks read `getChartStatus()`, which CHARTS-2 shows can say "ok" while the chart is off the table. (test-gap)

## 3. Architecture recommendations

### Problem
- The chart is built by two builders: the generator, and `buildDeclarativeChartEntity`/`applyChartTypeToEntity`.
- Five drivers call those builders: bootstrap, switch, remap, SSE, evolution and comparison clones.
- Each driver decides on its own:
  - which data source to read (raw or slice);
  - when the build is "done" (timers from 240 ms to 26 s, the animation-flag wait);
  - whether containment animates or freezes.
- Containment is a feedback loop running on stale, size-only measurements. Nearly every finding above is one of these choices made differently, or too early.

### Design: one pipeline, `CodeXRChartPipeline`
A browser runtime under `T/analysis-table/` (or a new `T/chart-pipeline/`), loaded before the mapping-ui, evolution and comparison runtimes.

```js
CodeXRChartPipeline.request({
  entity,            // or entityId
  chartId,           // registry id; profile resolved from #codexr-chart-base-config only
  sourceId,          // the PRODUCER id (data | codexrProjectEvolutionData | codexrComparisonDataLeft ...)
  mapping,           // dimension -> field
  zone,              // containment zone (full table, or left/right half for comparison)
  reason             // 'bootstrap' | 'switch' | 'remap' | 'analysis-updated' | 'evolution-frame' | 'comparison'
}) -> Promise<{ status: 'ready'|'empty'|'invalid', bounds, transactionId }>
```

One serialized queue per entity. A newer request supersedes a queued one, never a running one. Steps:

1. **Resolve the profile** from the single TS source (`chartPresentation.ts` → `#codexr-chart-base-config`). Delete the `mappingProfiles.js` mirror.
2. **Slice first.** Ensure `codexrChartDataSlice__<sourceId>`, recompute it for `(chartId, mapping)` (budget, rank, dedupe on the effective key), and get the row count. If there are 0 rows, clear the chart, set the empty state and return `'empty'` (CHARTS-13).
3. **Begin transition.** Hide the chart: `object3D.visible = false`, or keep the last fitted transform frozen. Freeze containment.
4. **Apply the presentation**: marker, rotation, and a provisional scale computed from the row count and profile (not a fixed 1.5).
5. **Install or update the Babia component** with `from: <slice id>` and `animation: false`, under the compat shim (axis `anim=false`, pie legend guard). Clear the children if the chart id or key field changed.
6. **Wait for a deterministic built signal:** the component's NotiBuffer update has been processed, AND the child count plus the summed position-attribute versions have been unchanged for two consecutive frames. No wall-clock timers; one safety timeout that reports `invalid`, never a silent revert.
7. **Fit once:** recompute every bbox (CHARTS-3). Scale by size, then anchor on containment bounds with a positional check against the zone (CHARTS-2), and lift so `min.y` sits on the surface (CHARTS-14).
8. **Reveal:** animate only if both transforms are fitted (CHARTS-4).
9. **Validate.** `valid` means inside the zone (position included). The transaction confirms or reverts on that, and emits `codexr-chart-ready` with bounds. SSE, evolution and tests wait on this event instead of timers.

Containment keeps its steady controller only to react to external changes (table moved, window resize) through the same `request({reason: 'relayout'})`.

### Migration steps (each step shippable on its own)
1. **Compat shim and measurement fixes** (CHARTS-1, CHARTS-3, CHARTS-5, CHARTS-16):
   - the shim;
   - `animation:false` in `baseAttributes`;
   - always `computeBoundingBox`.

   Low risk, and it removes the largest symptoms.
2. **Positional containment** (CHARTS-2, CHARTS-14): update `computeAnchorOffset` and the status; harness assertions on world bounds.
3. **SSE fixes** (CHARTS-10, CHARTS-11): the reconnect, and a cache-bust that skips slices and keeps params. These are independent of the pipeline and are blockers.
4. **Introduce `CodeXRChartPipeline`**, implemented with the existing helpers, and route `applyChartTypeToEntity`/`applyMappingToCharts`/`panelUi.selectChart` through it, slice first (CHARTS-4, CHARTS-7, CHARTS-17).
5. **Generator:** emit the slice producer and `from: codexrChartDataSlice__data`. Bootstrap calls `request({reason:'bootstrap'})` (CHARTS-6).
6. **Evolution:** `buildEvolutionChart` and frame swaps call `request({reason:'evolution-frame'})`. Delete `waitForEvolutionChartAnimation`. Update `projectEvolutionRuntime.test.cjs:265`, the evolution harness assertion and `.claude/docs/XR_COMPONENTS.md` (CHARTS-8).
7. **Comparison:** `createChartFromTemplate` calls `request({zone: half, reason:'comparison'})`; drop the hardcoded scale (CHARTS-9).
8. **SSE re-analysis** calls `request({reason:'analysis-updated'})` with the current mapping. Delete the fixed timers and `restoreState`'s mapping re-apply (CHARTS-12).
9. **Delete the dead per-path machinery:**
   - the orphan sweeps at 400/1500 ms;
   - the validation bursts;
   - `scheduleChartDataSliceSync` polling;
   - the profile mirror.

   Wire render-budget to the slice budget, so comparison and evolution respect a device-tier row cap.

### Test plan
- **Unit** (`test/analysis/*.test.cjs`, node runner):
  - the shim;
  - `computeAnchorOffset` with asymmetric bounds;
  - slice-before-component ordering (spy order);
  - the cache-bust helper;
  - the SSE reconnect with a fake EventSource;
  - evolution and comparison source ids.
- **Harness** (Playwright, the scripts in the scratch folder are ready templates): a matrix of 8 chart types x {3, 40, 400 rows, duplicate basenames} x {initial, switch from each type, remap, re-analysis grow/shrink/empty, evolution 3 frames, comparison}. Per drawn frame, assert:
  - no visible geometry off the table by more than 0.05 m;
  - height inside the band;
  - nothing below the tabletop;
  - after `codexr-chart-ready`, bounds inside the zone and child count equal to the slice length.

### Needs the maintainer's eyes
I could not run VS Code or a headset. These need checking there:
- the perceived severity of the transients on a Quest (CHARTS-4, CHARTS-5, CHARTS-8);
- the pie/donut size decision (CHARTS-15);
- a real historical comparison (CHARTS-9 visual);
- SSE reconnect behaviour through the real extension server and Cloudflare tunnel (CHARTS-10).

# Lifecycle audit: in-scene orchestration of the four XR analyses

Area: `analysis-mode` runtime (mode registry, transitions, `selection`), its coupling to the analysis-table / controller / logo, the three mode lifecycles (historical, dependency graph, project evolution), the server echo (`analysis-view`), collaboration sync, SSE live reload, and debug APIs.
Abbreviation: `T/` = `apps/vscode-extension/templates/components/codexr/`.

Scratch harness (does not touch the repo): `/tmp/claude-0/-home-user/af5ccea8-f538-575c-b7b6-8256e5a53df6/scratchpad/audit/lifecycle/`
- `scenarios.cjs`: Playwright scenarios over the real assembled runtimes in `test/manual/xr-mode-cycle-harness.html`, **served over HTTP** (`server.cjs`). Scenarios: `rapidSwitch activateThrows activateHangs datasetFails selectorLateMessage leakCycles`. Env flags: `TREEBUILDER=1` (mock `babia-treebuilder` so project evolution can render), `NO_LISTENERS=1` (turns off listener tracking so the CDP heap counters are honest), `CYCLES=n`.
- `instrument.js` (init script) adds fault injection: `__faults[mode].activate = 'throw'|'reject'|'hang'|ms` wraps any lifecycle registered through the public `register`, and `__fetchFaults` makes a fetch hang, fail or reject. It also counts listeners, intervals and timeouts.
- `pe-scenario.cjs`, `hist-scenario.cjs`, `dep-start.cjs`, `sse-test.cjs`: focused repros.
- `unit/lifecycle-audit.test.cjs`: three `node --test` vm repros that need no browser. All three pass, so each one demonstrates its bug.
- Run any of them with `export PATH=/opt/node24/bin:$PATH; NODE_OPTIONS="--require <scratchpad>/vendor/cdn-route.cjs" node <script>`.

**Harness caveat (also a test gap).** The stock harness loads over `file://`. Chromium blocks every `fetch` there (CORS), so the dependency dataset, the comparison datasets and the evolution frames **never load** in `npm run test:xr-mode-harness`. That harness only checks panel routing. It also has no `babia-treebuilder`, so project evolution can never render a frame in it.

## 1. How the area works

- **Entry points.** These all funnel into `changeAnalysis(mode, ctx)` (`T/analysis-mode/analysisModeRuntime/transitionsAndViews.js:2`):
  - the controller header button "Analyses" (`registerPanelView` → `onShow` → `openSelector()`, and `onToggleActive` → `resumeRequestedMode()`);
  - the selector option plates (`requestModeActivation` → sends `analysis-mode-activate` to the server, then `changeAnalysis` locally);
  - per-mode entry points (`enterHistoricalSelection`, dependency `start()`/`activateReadySnapshot`, PE `changeToEvolutionAnalysis`);
  - the server's authoritative `analysis-view` entity echo (`snapshotsAndLifecycles.js:211`).
- **Serial queue.** `changeAnalysis` bumps `state.generation` and chains `performTransition` behind `state.transition`, so transitions are serialized and never cancelled. There is same-mode and in-flight dedupe.
- **`performTransition`** (`selectorAndPanel.js:278`) runs `captureState` → `deactivate(prev)` → generation check → `releasePrimaryAnalysisOwnership` → `restoreState` → `applyAnalysisMode` (table theme via `CodeXRAnalysisTableRuntime.setMode`, Analyses button colour, controller view) → `activate`.
  - A throw sends it to `selection` plus `clearVisualizationsForSelection`.
  - A generation change after `activate` resolves leads to `deactivate`.
- **`selection`** is a real mode. Its lifecycle sweeps the analysis surface and the residual roots. The table theme `selection` makes `codexr-logo` assemble over the table (`T/logo/codexrLogoRuntime/codexrLogo.js:205`).
- **Lifecycles.**
  - `single` and `selection` are built in.
  - `historical-compare`, `dependency-graph` and `project-evolution` register from their own runtimes. Their `activate` fetches data, mounts roots on `#codexrAnalysisSurface` and waits for chart stability.
  - An `activation.token.isCurrent()` exists, but only PE reads it. Nothing can abort an in-flight await.
- **Collaboration.** Every peer applies the room's `analysis-view` entity: guests follow whoever switched last, and any guest can switch it for everyone (no role check in `src/core/server/analysis/analysisMessageRouter.ts:69-131`). The server bumps `viewRevision` on owner change. The client drops echoes older than its last revision and dedupes an echo toward the in-flight target.
- **SSE (`templates/xr/sse/*`).** In XR sessions the server does not push data events (`notifyClients: analysisMode !== 'XR'` in the watcher orchestrators). XR data refresh rides the `analysis-view` `modeRevision` instead (`refreshNormalDataSources`). The XR SSE client is effectively vestigial; the DOM client is live.

## 2. Findings

### LIFECYCLE-1: An `activate()` that never settles freezes the analysis switcher for the rest of the session
- Severity: blocker   - Type: bug / robustness
- Evidence:
  - `T/analysis-mode/analysisModeRuntime/transitionsAndViews.js:50-53`: `var previousTransition = state.transition.catch(function () {}); var nextTransition = previousTransition.then(function () { return performTransition(mode, context, generation); })`. Every later transition waits for the previous one, with no timeout and no abort.
  - `selectorAndPanel.js:319` `await invoke(lifecycles[mode], 'activate', …)` waits for it with no limit.
  - Unbounded awaits inside real `activate`s:
    - dependency `T/dependency-graph/dependencyGraphRuntime/viewLifecycle.js:281-283` (`return applySharedState(state.snapshot)`) → `:112` `await fetch(snapshot.datasetUrl …)` with no AbortController or timeout;
    - historical `T/historical-comparison/historicalComparisonRuntime/liveRefreshAndRegistration.js:203-213` → `compareFlowAndMessages.js:162-165` `await Promise.all([fetch(left), fetch(right)])`, also unbounded;
    - PE is bounded but long: 3×1200 ms component waits + 8 s frame-apply + 8 s data refresh + animation + 12 s containment (`framePlaybackEngine.js:167-179`, `declarativePipeline.js:298-318`, `:527`).
  - The existing test `analysisModeMegatest.test.cjs:743` *pins* "Visualization mode waits for a long historical activation" and always releases the promise. It never tests one that never settles.
- Failure scenario: the dataset or comparison HTTP request stalls (tunnel or remote session hiccup, a server busy writing a large `dependency-graph.json`, a laptop asleep while the Quest stays on). The user picks Dependency graph. The table turns purple and stays empty. They press "Analyses": the selector panel appears (the panel's `onShow` paints it immediately) but the mode stays `dependency-graph`. Picking "Normal analysis" does nothing, now or ever. Only a page reload recovers. This is the reported "analysis gets stuck, mode cannot be left".
- Confidence: CONFIRMED.
  - `scenarios.cjs activateHangs` (fetch of `xr-mode-dependency-data.json` hangs): after opening the selector the state is `pending:"selection"`; 5 s after picking Normal it is still `mode:"dependency-graph", transitioning:true, pending:"single"`.
  - vm repro: `unit/lifecycle-audit.test.cjs` test 2.
- Proposed fix (analysis-mode runtime, plus each lifecycle):
  1. Give each activation an `AbortSignal` (`activation.signal`) and abort the in-flight one as soon as a newer `changeAnalysis` is queued. Do not wait behind it: the new transition calls the outgoing lifecycle's `deactivate`/`cancel` immediately.
  2. Wrap `activate` in a watchdog (for example 15 s, per-lifecycle `activateTimeoutMs`). On expiry, treat it as an activation error (see LIFECYCLE-3).
  3. Pass `signal` to every `fetch` in `dependencyGraphRuntime` (`applySharedState`, `loadProjectDataset`), in `historicalComparisonRuntime` (`applySharedState`, offline loaders), and to PE's `requestBridgeFrame`/`waitFor*` helpers.
- Test: new megatest cases "a never-settling activate is abandoned when the user picks another mode" and "activate timeout lands in the error state". Add the `activateHangs` scenario to the Playwright harness (served over HTTP).

### LIFECYCLE-2: Picking a mode while an earlier transition is still running bounces you back to the selector (late `analysis-mode-selection`)
- Severity: major   - Type: bug (ordering/race)
- Evidence:
  - `T/analysis-mode/analysisModeRuntime/selectorAndPanel.js:199-207`: `openSelector` sends `analysis-mode-selection` only in `.then()` of its own queued transition.
  - `selectorAndPanel.js:130-131`: `requestModeActivation` sends `analysis-mode-activate` **immediately**.
  - The selector options are clickable before the selection transition has even started, because the panel's `onShow` shows them (`selectorAndPanel.js:249-261`).
  - Server: `analysisRefreshCoordinator.changeActiveMode` bumps `viewRevision` on owner change, so the late "selection" is the newest authoritative state and every client applies it (`snapshotsAndLifecycles.js:215-266`).
  - The test `analysisModeMegatest.test.cjs:672` pins the "clear locally, then publish selection" order but never interleaves a pick.
- Failure scenario: enter Project evolution with a movie (its activate takes seconds), or historical with a comparison. Within those seconds, press "Analyses" and pick Dependency graph. The scene enters the dependency graph and then, about a second later, snaps back to the empty selector with the logo. Guests in the room go to the selector too. It reads as "I chose an analysis and it threw me out".
- Confidence: CONFIRMED.
  - `scenarios.cjs selectorLateMessage` (async server model: 60 ms echo, `viewRevision` bumped on owner change). Server message order: `activate:historical-compare` → `activate:dependency-graph` → `analysis-mode-selection` (last). Client timeline: `historical…` → `dependency-graph/dependency-graph` → `selection/visualization-mode`, and it stays there.
  - vm repro: `unit/lifecycle-audit.test.cjs` test 1.
- Proposed fix: make the selection announcement part of the same ordered intent stream as activations. Either:
  - (a) send `analysis-mode-selection` synchronously in `openSelector` (before queueing, like `requestModeActivation` does), or
  - (b) better, give every local intent an `intentId`/sequence number that the server echoes back, and have `openSelector` skip its late send when a newer intent was issued (`state.generation !== generationAtOpen`).

  The cleanest version is part of the unified launcher: one `requestMode(mode)` that sends exactly one server message per user intent, in click order.
- Test: megatest with a fake client recording send order. Assert that the last message equals the user's last pick. Use the Playwright `selectorLateMessage` scenario.

### LIFECYCLE-3: A failed activation hides its own error message, leaves the server (and guests) in the failed mode, and the echo retries it
- Severity: major   - Type: bug / ux / collaboration desync
- Evidence:
  - `selectorAndPanel.js:327-348`: on error it calls `applyAnalysisMode('selection', …)` and then `setStatusMessage('CodeXR could not open this analysis. …', 'error', 6000)`.
  - But `T/xr-chart-mapping-ui/xrChartMappingUiRuntime/statusAndSharedState.js:18`: `var visible = state.activePanelView === 'mapping' && !!state.statusMessage;`. The panel is `visualization-mode`, so the message is **never visible**.
  - No `analysis-mode-selection` is sent on this path. The server keeps the failed mode, and its echo (arriving after the failure, not deduped because `transitioning` is false) re-runs the failing activate (`snapshotsAndLifecycles.js:259`).
  - `applyAnalysisMode` already set `state.requestedMode` to the failed mode (`modeApplication.js:4-6`), so pressing the "Analyses" header again (`onToggleActive: resumeRequestedMode`) retries it a third time.
  - The late-registration path `selectorAndPanel.js:33-42` has no catch at all.
- Failure scenario: project evolution throws (see LIFECYCLE-4). The table flips to the selector with the logo. No message is visible. The PE activate runs twice. Every guest receives `analysis-view=project-evolution`: guests whose activate succeeds sit in PE while the host sits in the selector. A reconnecting peer is sent into PE again.
- Confidence: CONFIRMED.
  - `scenarios.cjs activateThrows`: `errorTexts: ["hidden: CodeXR could not open this analysis. …"]`, lifecycle calls `activate@gen3, deactivate@gen3, activate@gen4, deactivate@gen4`, and the only message sent to the server is `analysis-mode-activate:dependency-graph`.
  - vm repro: `unit/lifecycle-audit.test.cjs` test 3.
  - Multi-peer divergence is inferred from the same code path.
- Proposed fix:
  1. On activation failure, publish `analysis-mode-selection` (or a new `analysis-mode-failed {mode, intentId}`) so the server and guests converge.
  2. Do not set `requestedMode` until activate succeeds.
  3. Show the error **on the selector view** (an error plate inside `#codexrVisualizationModePanel` with "Retry" and "Back to Normal analysis"), not on the mapping-only status line.
  4. Record `lastError {mode, message, at}` in `getState()` for debugging.
- Test: megatest "failed activation publishes selection and does not retry on echo". Playwright: assert a VISIBLE error text in `visualization-mode`.

### LIFECYCLE-4: Project evolution becomes impossible to re-enter after any half-built frame pipeline (TypeError in `activate`)
- Severity: blocker (for PE)   - Type: bug
- Evidence:
  - `T/project-evolution/projectEvolutionRuntime/transportAndRegistration.js:246-248`: `if (currentFrame && refs.evolutionRoot) { ensureEvolutionRoot(currentFrame); refs.evolutionChart.setAttribute?.('visible', true);`. This null-checks `evolutionRoot` but not `evolutionChart`.
  - `declarativePipeline.js:295-317`: `ensureEvolutionRoot()` runs first. The datasource, tree builder and chart are then each built and awaited with 1200 ms timeouts, and any of them can return `null` while the root stays.
  - `applyEvolutionChartSelection` calls `releaseEvolutionChart()` (chart = null, root kept) before rebuilding, at `framePlaybackEngine.js:24-25`.
  - Nothing resets `refs` until a new movie revision arrives (`frameApplication.js:84-86`).
- Failure scenario: a movie is generated, but the first frame's pipeline fails at the datasource, tree or chart stage. On a Quest under load a component can easily take longer than 1200 ms; a chart-type change interrupted by leaving the mode can also leave the root without a chart. The user leaves PE. Every later entry into PE throws `Cannot read properties of null (reading 'setAttribute')` and bounces to the selector, with no visible error (LIFECYCLE-3) and an echo retry. PE stays broken until a new movie is generated. This matches "project evolution has always given trouble".
- Confidence:
  - CONFIRMED for the failure path. `pe-scenario.cjs` "no treebuilder": the pipeline fails ("Project evolution tree is not available."), and re-entry logs `[CodeXR][AnalysisMode] Could not activate mode: project-evolution TypeError: Cannot read properties of null (reading 'setAttribute')` and lands in `mode=selection`. The same TypeError appears 5× in `leakCycles` without the mock.
  - LIKELY for the "chart switch then leave" trigger. My timing did not hit the window with mock charts.
- Proposed fix:
  - In `activate`, guard with `if (refs.evolutionChart)`. Better, treat "root without chart" as no preserved frame: call `releaseEvolutionVisualization()` and fall through to `seek()`.
  - Make `ensureDeclarativeEvolutionPipeline` transactional: build into locals and only assign `refs.*` once all three components are ready. On failure, remove what it created.
- Test: add to `projectEvolutionRuntime.test.cjs`: "activate after a pipeline that failed at the tree stage re-seeks instead of throwing". Playwright: `pe-scenario.cjs` case 1.

### LIFECYCLE-5: Data load failures in the dependency graph leave an empty mode that says "ready"
- Severity: major   - Type: ux / robustness
- Evidence:
  - `T/dependency-graph/dependencyGraphRuntime/viewLifecycle.js:124-126`: the catch calls `setStatus(error.message, true)`.
  - But the status line is rebuilt from `state.snapshot.message` by `renderControls()` (`scalesAndControls.js:443`), which re-runs on every panel route, entity update and render-budget quality change (`componentCore.js:53-57`). The error is overwritten by "…ready."
  - The mode stays `dependency-graph` with the normal chart parked and nothing mounted. No retry is offered.
  - The historical path behaves the same way (`compareFlowAndMessages.js:184-186`: status only, mode stays).
- Failure scenario: the dataset request returns 404 or 500 (a stale `datasetUrl` after a server restart, a truncated write). The user sees an empty purple table and a panel reading "Dependency graph ready.".
- Confidence: CONFIRMED. `scenarios.cjs datasetFails` (HTTP 500 injected): `mode:"dependency-graph"`, `visibleRoots:[]`, `errorTexts:[]`; `probe-dep.cjs` shows the status reads "Harness dependency graph ready.". The stock harness actually runs in this state all the time: `file://` blocks the fetch (see harness caveat).
- Proposed fix:
  - Lifecycles should *throw*, or return `{ok:false, error, retry}`, when their data cannot be loaded. Then one generic in-scene error state (LIFECYCLE-3 fix) handles it.
  - Keep a sticky `state.loadError` that `renderControls` renders in preference to `snapshot.message`, until the next successful load.
- Test: Playwright `datasetFails` asserting a VISIBLE error and a working "Retry". Unit test in `dependencyGraph.test.cjs`: "renderControls keeps the load error".

### LIFECYCLE-6: The dependency-graph start path gives no visible feedback, and silently eats clicks for up to 20 s
- Severity: minor   - Type: ux
- Evidence:
  - `viewLifecycle.js:175-185`: `setTransitionLocked(true, 'Opening dependencies...')` followed by a cosmetic hop to `selection`. The status is written to the **dependency panel**, but the visible view is the selector.
  - The watchdog message "did not respond" (`datasetProjection.js:103-110`) and the `dependency-graph-error` status (`viewLifecycle.js:253-256`) also land on the hidden panel.
  - A second click returns early at `viewLifecycle.js:159` (`if (state.transitionLocked) { return; }`) with no message.
  - The retry loop `attemptSend` (`viewLifecycle.js:192-199`) retries every 500 ms forever while the socket is down; only a new `start()` stops it.
- Failure scenario: the server is slow or fails the dependency analysis. The user sees the selector plus the logo, clicks "Dependency graph" again (ignored), and after 20 s still sees nothing.
- Confidence: CONFIRMED with `dep-start.cjs` (start message dropped): at 1.5 s and at 21.5 s no status text is visible, and the second click sent nothing.
- Proposed fix: show transit progress on the selector itself, through the same in-scene error/progress plate as LIFECYCLE-3, while the logo is up. Cap `attemptSend` retries, or stop on the lock watchdog.
- Test: Playwright `dep-start.cjs` asserting a VISIBLE "Opening dependencies…" and then "did not respond".

### LIFECYCLE-7: The boot-time normal-data refresh can corrupt the data URL to `url: url: ./data.json`, after which the normal chart can never refresh
- Severity: major (if it triggers in real scenes; harness-confirmed)   - Type: bug
- Evidence:
  - `T/analysis-mode/analysisModeRuntime/snapshotsAndLifecycles.js:82-93`: `var current = dataEntity.getAttribute?.('babia-queryjson'); … var currentUrl = typeof current === 'string' ? current : current.url || ''; var nextUrl = currentUrl.split('?')[0] + '?codexrModeRevision=' …; var declarativeUrl = 'url: ' + nextUrl;`.
  - Before A-Frame initialises the component, `getAttribute` returns the raw declaration `"url: ./data.json"` (the real template declares exactly that: `templates/xr/file/xr-visualization.html:73`). The result is `url: url: ./data.json?…`.
  - Once poisoned, every later refresh reads `.url === "url: ./…"` and keeps it, because `split('?')` preserves the prefix. The SSE client has the same string branch (`templates/xr/sse/live_sse_fileXR.js:190-199`).
- Failure scenario: the room's `analysis-view` snapshot (with `modeRevision.single ≥ 1`) is applied before `#data` initialises. Every later live-reload of the Normal analysis fetches `url: ./data.json?...` (`Fetch API cannot load … URL scheme "url" is not supported`), and the chart silently keeps stale data.
- Confidence: CONFIRMED in the harness. Every page load shows the DOM attribute `url: url: ./xr-mode-normal-data.json?codexrModeRevision=1&t=…` (`probe-url.cjs`) and the fetch error. In real scenes it is SUSPECTED and timing-dependent, because the WebSocket snapshot usually lands after the scene has loaded. The maintainer should check the console of a freshly opened XR scene for "URL scheme \"url\"".
- Proposed fix: parse the URL with the same tolerant parser `getProducerId` uses (`/(?:^|;)\s*url\s*:\s*([^;]+)/`) for both string and object forms, in `refreshNormalDataSources` and the SSE client. Defer the refresh until `dataEntity.hasLoaded`.
- Test: megatest with a stub entity whose `getAttribute` returns `"url: ./data.json"`. Assert the written attribute is `url: ./data.json?codexrModeRevision=…`.

### LIFECYCLE-8: Historical comparison clones inherit the normal chart's root markers, so the Normal analysis "adopts" them (two analyses on one table)
- Severity: minor in fresh scenes; major in any scene whose chart is itself the normal root   - Type: robustness / bug
- Evidence:
  - `T/historical-comparison/historicalComparisonRuntime/comparisonCharts.js:134-151` copies **every** attribute of the original chart except a short deny-list. That list does not include `data-codexr-analysis-root`, `data-codexr-analysis-mode`, `data-codexr-normal-root` or `data-codexr-preserve`.
  - `surfaceAndRefresh.js:53-71,216-232` (`mountNormalRoots`) then re-parents **every** `[data-codexr-normal-root="true"]` to the surface and makes it visible.
- Failure scenario (harness, where `#normalChart` carries the markers):
  - Run a comparison and go back to Normal analysis. `codexrComparisonChartLeft` and `Right` are moved **out of** `#codexrHistoricalComparisonRoot` and rendered next to the normal chart.
  - Go back to historical. The comparison root is shown but its charts are gone, so it is empty.
  - Real generated scenes wrap the chart in `#codexrNormalAnalysisRoot` (`xr-visualization.html:91-101`), so they are not affected today. Any future scene layout without the wrapper, or a clone made from the wrapper, would reproduce it.
- Confidence: CONFIRMED in the harness (`hist-scenario.cjs`: "back in single": the comparison charts have parent `codexrAnalysisSurface` and are rendered). For real scenes it is LIKELY not user-facing.
- Proposed fix:
  - Allow-list instead of deny-list when cloning, or strip all `data-codexr-*` ownership markers from clones.
  - In `mountNormalRoots`, only adopt elements that are not inside another mode's root (`!el.closest('[data-codexr-analysis-root]:not([data-codexr-analysis-mode="single"])')`).
  - Also make the harness scene match the real template (wrapper root), which is a test gap.
- Test: `historicalComparisonRuntime.test.cjs`: "clones carry no analysis-root markers". Megatest: "mountNormalRoots never adopts a node inside another mode's root".

### LIFECYCLE-9: Errors inside collaboration message handlers are swallowed; one throwing runtime drops the rest of a room snapshot
- Severity: minor   - Type: robustness / diagnosability
- Evidence:
  - `T/collaboration/codexrCollaborationRuntime/clientCore.js:287-292`: `try { handleServerMessage(JSON.parse(event.data)); } catch (_error) { // Ignore malformed collaboration payloads. }`. This also hides runtime exceptions thrown synchronously by any `applySharedState`.
  - `entitySync.js:142-151`: a `forEach` applies each entity with no per-entity try. A throw aborts the remaining entities and skips `replaceParticipants` and `handleSnapshotPresence`.
  - `T/render-budget/renderBudgetRuntime.js:54` also has `try { subscriber(…) } catch {}`.
- Failure scenario: a guest joins and one runtime throws on the snapshot (for example on an unexpected payload shape). The `analysis-view` entity (or the PE or dependency entity) behind it is never applied, so the guest sits in the wrong mode, and nothing appears in the console.
- Confidence: LIKELY (traced; no current throwing runtime was found).
- Proposed fix: wrap JSON parsing separately from dispatch, isolate each `applyEntityStateToRuntime` call in try/catch with `console.error('[CodeXR][Collab] runtime X failed', e)`, and apply `analysis-view` last (after the data entities) so modes activate with their data present.
- Test: `collaborationRuntime.test.cjs`: "a throwing entity runtime does not prevent the analysis-view from applying".

### LIFECYCLE-10: The XR SSE client's reconnect handler kills live reload after the first error (orphan EventSource); the DOM client reloads the page in a loop
- Severity: minor (XR: the XR server sends no data events today; DOM: user-visible)   - Type: bug
- Evidence:
  - `templates/xr/sse/live_sse_fileXR.js:138-153`: `setTimeout(() => { … eventSource.close(); new EventSource('/events'); }, 3000);`. The new source is neither stored nor given handlers, and closing the original disables the browser's native auto-reconnect.
  - `templates/xr/sse/live_sse_fileDOM.js:55-61`: `eventSource.close(); location.reload();` after any error.
  - Known related issue (REPORT §9): with two servers for the same target, `/events` returns 404, so the DOM page would reload every ~3 s.
- Failure scenario:
  - XR: after a network blip, `dataRefresh` and `analysis-updated` events are ignored forever (dead path today, but it would bite as soon as XR SSE is re-enabled).
  - DOM: with the server down, the page reloads into the browser's error page, losing the visualization. With `/events` returning 404, it reloads endlessly.
- Confidence: CONFIRMED for XR with `sse-test.cjs` (connection dropped server-side: 3 connections opened, an event sent after reconnect produces no refresh). DOM is LIKELY (code).
- Proposed fix: delete the manual reconnect and rely on native EventSource reconnection (with a `retry:` hint from the server), or re-create *and rebind* through one `connect()` function. For DOM, back off and only reload after a successful `onopen` that follows an error. For XR, either remove the vestigial data handlers, or keep them and make them mode-aware (they refresh **every** `[babia-queryjson]`, including parked evolution and comparison sources: `live_sse_fileXR.js:163-164,251`).
- Test: `livePanelSse.test.cjs`-style vm test with a fake EventSource asserting that handlers survive an error; Playwright `sse-test.cjs`.

### LIFECYCLE-11: Silent give-ups during boot and retries without back-off
- Severity: minor   - Type: robustness
- Evidence:
  - `snapshotsAndLifecycles.js:201-209`: `registerCollaboration(attempt)` gives up after 30×100 ms with no log. The analysis-view runtime is then never registered, so that page never follows the room's mode.
  - `viewLifecycle.js:293-295`: the dependency `mount` retries 30× and stops silently.
  - `clientCore.js:230-245`: the WebSocket reconnects every 900 ms forever, with no back-off or jitter, and logs a `console.warn` each time (`:295`).
  - `lastAuthoritativeViewRevision` is never reset on room re-join (`snapshotsAndLifecycles.js:217-232`). If the server's coordinator state restarts at a lower `viewRevision` while the page survives, every new authoritative view is "Ignored stale" until the counter catches up.
- Failure scenario: a slow-loading page whose collaboration client appears after 3 s ignores all mode changes from other participants. After a server-side session restart that reuses the port, mode sync silently stops.
- Confidence: LIKELY (code). The revision-reset case is SUSPECTED; it depends on whether a page can outlive its server's coordinator state.
- Proposed fix: use event-driven registration (the client exposes `whenReady`) instead of capped polling. Back off exponentially (0.9 s → 15 s cap). Reset `lastAuthoritativeViewRevision` on `room-joined` (or include a server epoch id in the snapshot and reset when it changes).
- Test: vm megatest for the epoch reset; `collaborationRuntime.test.cjs` for back-off.

### LIFECYCLE-12: Small leaks and inefficiencies (not the cause of slow-downs)
- Severity: minor   - Type: robustness
- Evidence and measurements:
  - Ten full cycles through dependency → historical (with comparison) → PE (with movie) → normal, served over HTTP with the tree-builder mock and listener tracking off (`TREEBUILDER=1 NO_LISTENERS=1 CYCLES=10`).
  - Scene graph: entities, three.js objects, renderer geometries and textures, intervals, and document/window/scene listeners were all **exactly stable**.
  - After forced GC, CDP `Memory.getDOMCounters` went from 4724 to 4794 nodes and 1793 to 1813 listeners, and the heap from 15.9 to 17.7 MB. That is small and plausibly cached panel text; there is no per-cycle geometry leak.
  - Real leak: the dependency layout worker is created from `URL.createObjectURL(new Blob(...))` on every graph entity (`T/dependency-graph/dependencyGraphRuntime/scalesAndControls.js:483`) and never revoked. That is one Blob per dependency-mode entry.
  - Duplicate `historical-comparison-references-request` messages are sent on a single entry (seen twice in a row in `selectorLateMessage`).
  - `single` activate's `void waitForNormalChartReady(...).then(...)` (`snapshotsAndLifecycles.js:181-193`) has no `.catch`. If it rejects, `setNormalVisualizationVisible(true)` never runs, and an unhandled rejection is the only trace.
- Confidence: CONFIRMED (measurements). The Blob URL is LIKELY (code). Real BabiaXR components may behave differently from the harness mocks, so the maintainer should repeat `CodeXRDebug.status()` before and after ten switches on a real scene.
- Proposed fix: create the worker Blob URL once per page (module-level) or revoke it after `new Worker`. Dedupe the references request per entry. Add `.catch` with an error state to the single refresh.

### Rechecks of items that are NOT bugs here (for the record)
- **Rapid A→B→C switching** converges correctly: the final mode's content is the only content and `transitioning` ends false. The generation checks in `performTransition` and the `isCurrent` checks in the dependency and PE code work. Evidence: `scenarios.cjs rapidSwitch`, three sequences including PE→dep→hist, each settled in ≤ 260 ms. The problem is only *blocking* (LIFECYCLE-1), not mixing.
- **REPORT §9 "dependency panel's shared-state fetch does not check snapshot identity"** (`loadProjectDataset`): `isLoadCurrent` already drops a stale load when a newer one starts, so I found no user-facing effect.
- **Two users switching at once:** the server serializes writes. Both clients converge on the last write, through an extra intermediate transition each (some flicker). Note that any guest can switch the mode for everyone; there is no role check in `analysisMessageRouter.ts`. That is a product decision; flag it to the maintainer.
- **Pointer policy and immersive rig** do not hook mode transitions. Nothing found there in this area.

## 3. Architecture recommendations: an in-scene mode lifecycle contract

The current contract is "an object with optional `captureState/deactivate/restoreState/activate/resolveControllerView`, with `activate` free to await anything". It has no cancellation, no timeout and no error state, and errors are signalled three different ways (throw, `setStatus` and return, or hang). A contract to pair with a unified host-side launcher:

```js
CodeXRAnalysisModeRuntime.register(mode, {
  // static metadata the launcher/selector can render without the mode loaded
  label, color, mappingContextId, availability(): {enabled, reason},
  activateTimeoutMs: 15000,
  resolveControllerView(),
  captureState(): snapshot,            // sync, cheap, never throws
  // MUST honour ctx.signal: pass it to fetch, check it after every await,
  // and return {status:'ready'} | {status:'empty', view} | throw ModeError{code, message, retryable}
  async enter(ctx /* {signal, savedState, context, reportProgress(msg, pct)} */),
  async exit(ctx /* {reason: 'switch'|'cancel'|'error', signal} */),  // idempotent, must not throw
  dispose(),                           // runtime teardown
});
```

Orchestrator rules (in `analysisModeRuntime`):
1. **Cancel, don't queue.** A new intent aborts the in-flight `enter` (`AbortController.abort()`), awaits `exit({reason:'cancel'})` with its own short timeout, and starts the new one. A hung lifecycle can therefore never hold the table (fixes LIFECYCLE-1).
2. **One state machine.** The states are `idle(mode)` → `exiting(prev)` → `entering(next, intentId)` → `ready(next)` | `failed(next, error)`. `getState()` exposes it, along with `startedAt`, `hook` and `lastError`. The table theme, the logo and the Analyses button colour derive from that state only. The logo shows for `selection`, `entering` and `failed`, which makes it a real "loading" or "error" indicator.
3. **A visible failure state** in the selector panel: the message, "Retry" and "Back to Normal analysis". `setStatusMessage` on the mapping view stops being the error channel (fixes LIFECYCLE-3, 5, 6).
4. **One ordered intent stream to the server.** Every user action sends exactly one message carrying `{mode, intentId}`. The server echoes `intentId`, and clients ignore echoes for superseded intents. Failure publishes `analysis-mode-failed` so the room converges (fixes LIFECYCLE-2, 3).
5. **Ownership of mounted content goes through the surface API only** (`mountRoot(mode, el)`, `removeMode`, `preserveModeRoots`). Never copy `data-codexr-*` ownership attributes onto created nodes; the surface stamps them (fixes LIFECYCLE-8). The same API is the natural place for the brief's "unified chart rebuild/containment" mechanism: a mode asks the surface for a contained chart slot and never re-parents nodes itself.
6. **Transactional enter.** Build into locals and commit `refs` only on success; on failure or cancel, remove what was created (fixes LIFECYCLE-4 in general, not only for PE).
7. **Debug API.** Add `CodeXRDebug.lifecycle()`, which prints the state machine, the in-flight hook and how long it has been running, plus `lastError` and the last 20 transitions with durations (the runtime already logs these, but only to the console with `[CodeXR.Debug]`). Add `CodeXRDebug.forceMode('single')`, which aborts and resets as an escape hatch for a stuck headset session.
8. **Tests.** Every new mode passes a shared conformance suite run in vm: enter/exit idempotence, honouring `signal`, timeout → failed, throw → failed plus a visible error, and no `data-codexr-*` copying. The Playwright mode harness must run **over HTTP** with the real data fixtures and a tree builder, and include the `activateHangs`, `activateThrows`, `selectorLateMessage` and `leakCycles` scenarios from the scratch dir. Today it validates panel routing over empty modes.

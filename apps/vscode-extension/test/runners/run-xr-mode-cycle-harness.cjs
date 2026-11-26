const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startStaticServer } = require('../helpers/staticHttpServer.cjs');
const { buildAssembledRuntimes } = require('../manual/buildAssembledRuntimes.cjs');
const { launchHarnessChromium } = require('../helpers/harnessBrowser.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const harnessPath = path.join(projectRoot, 'test', 'manual', 'xr-mode-cycle-harness.html');
// Served over HTTP (projectRoot at '/'): from file:// Chromium blocks fetch(),
// so the modes' datasets never loaded and a load failure went unnoticed.
let staticServer = null;
async function harnessUrl() {
  staticServer ||= await startStaticServer(projectRoot);
  return staticServer.url(path.relative(projectRoot, harnessPath));
}
async function closeStaticServer() {
  if (staticServer) { await staticServer.close(); staticServer = null; }
}
buildAssembledRuntimes();
const html = fs.readFileSync(harnessPath, 'utf8');

// Static contract: the harness bundles the whole controller stack.
assert.match(html, /codexr-tooling-config-xr-mapping-ui/);
assert.match(html, /assembled\/xrChartMappingUiRuntime\.js/);
assert.match(html, /assembled\/analysisModeRuntime\.js/);
assert.match(html, /assembled\/historicalComparisonRuntime\.js/);
assert.match(html, /assembled\/dependencyGraphRuntime\.js/);

async function runPlaywrightIfAvailable() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.log('[xr-mode-harness] Playwright is not installed; static harness validation passed.');
    return;
  }

  // Close the browser even when an assertion fails: leaked pages keep the
  // process alive forever, turning a red run into a silent hang.
  const browser = await launchHarnessChromium(chromium);
  try {
    await runScenario(browser);
    await runComparisonScenarios(browser);
    await runDependencyScenarios(browser);
  } finally {
    await browser.close();
    await closeStaticServer();
  }
  console.log('[xr-mode-harness] controller mode-cycle validation passed.');
}

// The controller is the single access point to every analysis surface: this
// scenario walks the real user path — open the analysis selector from the
// panel's header button, enter each analysis mode, and come back — asserting
// the controller view/mode state at every step.
async function runScenario(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(await harnessUrl(), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#scene', { timeout: 10000 });
  await page.evaluate(() => new Promise((resolve) => {
    const scene = document.getElementById('scene');
    if (scene.hasLoaded) { resolve(); return; }
    scene.addEventListener('loaded', () => resolve(), { once: true });
  }));

  function controllerState() {
    return {
      panelView: window.CodeXRMappingUiRuntime.getActivePanelView(),
      mode: window.CodeXRAnalysisModeRuntime.getState().mode,
      optionCount: document.querySelectorAll('[data-codexr-mode-option]').length,
    };
  }

  async function waitForState(expected, label) {
    const deadline = Date.now() + 8000;
    let state = null;
    while (Date.now() < deadline) {
      state = await page.evaluate(controllerState);
      if ((!expected.panelView || state.panelView === expected.panelView)
        && (!expected.mode || state.mode === expected.mode)) {
        return state;
      }
      await page.waitForTimeout(150);
    }
    assert.fail(`${label}: controller stayed in ${JSON.stringify(state)}, expected ${JSON.stringify(expected)}`);
  }

  async function clickEntity(selector, label) {
    const clicked = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) { return false; }
      el.dispatchEvent(new Event('click', { bubbles: false }));
      return true;
    }, selector);
    assert.equal(clicked, true, `${label}: entity ${selector} not found`);
  }

  // 1. The analysis-selector header button must exist — a capped registration
  //    retry used to silently drop it, leaving no way to switch analyses.
  await page.waitForFunction(
    () => !!document.querySelector('#codexrMappingUiView-visualization-mode'),
    { timeout: 8000 },
  );
  await waitForState({ panelView: 'mapping' }, 'initial state');

  // 2. Header button opens the analysis selector with its mode options.
  await clickEntity('#codexrMappingUiView-visualization-mode', 'open selector');
  const selection = await waitForState({ panelView: 'visualization-mode', mode: 'selection' }, 'open selector');
  // Normal analysis + historical comparison + dependency graph + project
  // evolution.
  assert.ok(selection.optionCount >= 4, `expected >=4 analysis options, saw ${selection.optionCount}`);

  // 3. Enter each analysis from the selector, returning via the same button.
  //    Project evolution is entered with NO movie generated — the cold path
  //    that used to throw inside activate() and bounce back to the selector.
  const journeys = [
    ['dependency-graph', { panelView: 'dependency-graph', mode: 'dependency-graph' }],
    ['historical-compare', { panelView: 'historical-selection', mode: 'historical-compare' }],
    ['project-evolution', { panelView: 'project-evolution', mode: 'project-evolution' }],
    ['single', { panelView: 'mapping', mode: 'single' }],
  ];
  for (const [optionId, expected] of journeys) {
    if ((await page.evaluate(controllerState)).panelView !== 'visualization-mode') {
      await clickEntity('#codexrMappingUiView-visualization-mode', `reopen selector before ${optionId}`);
      await waitForState({ panelView: 'visualization-mode', mode: 'selection' }, `reopen selector before ${optionId}`);
    }
    await clickEntity(`[data-codexr-mode-option="${optionId}"]`, `select ${optionId}`);
    await waitForState(expected, `enter ${optionId}`);
  }

  // 4. Back in normal analysis, the Field Mapping view is interactive again:
  //    switching the chart type through the controller works.
  const chartSwitch = await page.evaluate(() => {
    const runtime = window.CodeXRMappingUiRuntime;
    const before = runtime.getState().chartId;
    const buttons = [...document.querySelectorAll('.codexr-mapping-ui-chart-option')];
    const other = buttons.find((el) => el.getAttribute('data-codexr-chart-id') !== before);
    if (!other) { return { before, after: before, clicked: false }; }
    other.dispatchEvent(new Event('click', { bubbles: false }));
    return { before, after: runtime.getState().chartId, clicked: true };
  });
  if (chartSwitch.clicked) {
    assert.notEqual(chartSwitch.after, chartSwitch.before, 'chart selector click must switch the active chart');
  }
}

// HIST-3 / HIST-12 / LIFECYCLE-8: a historical comparison in the wrapped
// layout the real template generates. Each side must keep reading ITS revision
// across every chart switch (Bars <-> Boats, Boats <-> flat), the clones must
// never be adopted by the Normal analysis, and leaving and re-entering the
// mode must bring the comparison back visible and settled.
// Markers the comparison sets on its own clones (never copied).
const DERIVED_CLONE_MARKERS = ['data-codexr-active-chart-id', 'data-codexr-chart-containment',
  'data-codexr-comparison-target-type'];
const COMPARISON_CHART_COMPONENTS = ['babia-bars', 'babia-barsmap', 'babia-cyls', 'babia-cylsmap',
  'babia-pie', 'babia-doughnut', 'babia-bubbles', 'babia-boats'];

function comparisonState(componentNames) {
  const isShown = (element) => {
    for (let node = element; node && node.object3D; node = node.parentNode) {
      if (!node.object3D.visible) { return false; }
    }
    return !!element;
  };
  const side = (id) => {
    const element = document.getElementById(id);
    if (!element) { return null; }
    const component = componentNames.filter((name) => element.hasAttribute(name));
    const data = component.length === 1 ? (element.getAttribute(component[0]) || {}) : {};
    let namespaces = [];
    if (data.data) {
      try {
        const collect = (nodes) => nodes.flatMap((node) => [String(node.uid || '').split(':')[0], ...collect(node.children || [])]);
        namespaces = [...new Set(collect(JSON.parse(data.data)))];
      } catch { namespaces = ['<unparseable>']; }
    }
    return {
      component,
      from: data.from || '',
      namespaces,
      parent: element.parentNode?.id || '',
      markers: element.getAttributeNames().filter((name) => name.startsWith('data-codexr-')).sort(),
      shown: isShown(element),
    };
  };
  const mode = window.CodeXRAnalysisModeRuntime.getState();
  return {
    mode: mode.mode,
    transitioning: !!mode.transitioning,
    status: window.CodeXRHistoricalComparisonRuntime.getState().status || '',
    chartId: window.CodeXRMappingUiRuntime.getState().chartId,
    left: side('codexrComparisonChartLeft'),
    right: side('codexrComparisonChartRight'),
    normalShown: isShown(document.getElementById('normalChart')),
    // Comparison nodes the Normal analysis would treat as its own: a normal
    // root marker on them or an ancestor (LIFECYCLE-8).
    adoptedByNormal: [...document.querySelectorAll('[id^="codexrComparison"]')]
      .filter((node) => node.closest('[data-codexr-normal-root="true"], [data-codexr-analysis-mode="single"]'))
      .map((node) => node.id),
  };
}

// True when each side reads its own revision under `component`.
function sidesReadOwnRevision(state, component) {
  const flatSource = { left: /^(codexrChartDataSlice__)?codexrComparisonDataLeft$/, right: /^(codexrChartDataSlice__)?codexrComparisonDataRight$/ };
  return ['left', 'right'].every((key) => {
    const side = state[key];
    if (!side || side.component.length !== 1 || side.component[0] !== component) { return false; }
    if (component === 'babia-boats') {
      return side.from === '' && side.namespaces.length === 1 && side.namespaces[0] === `codexr-${key}`;
    }
    return flatSource[key].test(side.from) && side.namespaces.length === 0;
  });
}

async function runComparisonScenarios(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(await harnessUrl(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('scene')?.hasLoaded
    && window.CodeXRAnalysisModeRuntime?.getState?.().mode === 'single'
    && window.CodeXRMappingUiRuntime?.isPanelReady?.(), null, { timeout: 30000 });

  const read = () => page.evaluate(comparisonState, COMPARISON_CHART_COMPONENTS);
  async function waitFor(predicateSource, argument, label) {
    try {
      await page.waitForFunction(
        ([source, componentNames, arg]) => {
          const predicate = new Function('state', 'arg', source);
          return predicate(window.__codexrComparisonState(componentNames), arg);
        },
        [predicateSource, COMPARISON_CHART_COMPONENTS, argument],
        { timeout: 20000, polling: 200 },
      );
    } catch {
      assert.fail(`${label}: comparison stayed at ${JSON.stringify(await read())}`);
    }
    return read();
  }
  await page.evaluate(`window.__codexrComparisonState = ${comparisonState.toString()};`);
  await page.evaluate(`window.__sidesReadOwnRevision = ${sidesReadOwnRevision.toString()};`);
  const settledOn = 'return state.mode === "historical-compare" && !state.transitioning'
    + ' && state.left && state.right && state.left.shown && state.right.shown'
    + ' && window.__sidesReadOwnRevision(state, arg);';

  // The chart itself carries the normal-root markers, the way the unwrapped
  // layout made the Normal analysis adopt copies of them (LIFECYCLE-8).
  await page.evaluate(() => {
    const chart = document.getElementById('normalChart');
    chart.setAttribute('data-codexr-normal-root', 'true');
    chart.setAttribute('data-codexr-analysis-mode', 'single');
    chart.setAttribute('data-codexr-harness-sentinel', 'scene-chart-only');
  });

  // 1. Enter: Compare from the harness client, like the panel's button.
  await page.evaluate(() => window.CodeXRHistoricalComparisonRuntime.__testing.selectHistoricalMode());
  await page.evaluate(() => window.CodeXRHarness.client.sendMessage('historical-comparison-start', {
    leftSourceId: 'working-copy', rightSourceId: 'commit-1',
  }));
  const entered = await waitFor(settledOn, 'babia-bars', 'enter the comparison on bars');
  for (const key of ['left', 'right']) {
    // Whitelist clone (HIST-12 / LIFECYCLE-8): the scene chart's ownership
    // markers (stamped on it below, as an unwrapped scene would carry them)
    // never travel; only the markers derived for the clone itself remain.
    const copied = entered[key].markers.filter((name) => !DERIVED_CLONE_MARKERS.includes(name));
    assert.deepEqual(copied, [], `${key} clone carries no copied data-codexr-* marker`);
    assert.equal(entered[key].parent, 'codexrHistoricalComparisonRoot');
  }
  assert.equal(entered.normalShown, false, 'the normal chart is parked under the comparison');

  // 2. Switch chart types through the controller: Bars -> Boats -> Bars ->
  //    Boats -> Cyls -> Pie. Each step must keep every side on its revision.
  const journey = [['boats', 'babia-boats'], ['bars', 'babia-bars'], ['boats', 'babia-boats'],
    ['cyls', 'babia-cyls'], ['pie', 'babia-pie']];
  for (const [chartId, component] of journey) {
    const switched = await page.evaluate((id) => window.CodeXRMappingUiRuntime.selectChart(id), chartId);
    assert.equal(switched, true, `switch to ${chartId} accepted`);
    await waitFor(settledOn, component, `switch to ${chartId}`);
  }

  // 3. Leave for the Normal analysis: the clones stay in the comparison root
  //    (hidden with it), are not adopted as normal roots, and the normal
  //    chart comes back.
  await page.evaluate(() => window.CodeXRHarness.client.sendMessage('analysis-mode-activate', { mode: 'single' }));
  const left = await waitFor('return state.mode === "single" && !state.transitioning && state.normalShown'
    + ' && !(state.left && state.left.shown) && !(state.right && state.right.shown);', null, 'leave to single');
  assert.deepEqual(left.adoptedByNormal, [], 'no comparison node is adopted by the Normal analysis');
  assert.equal(left.left.parent, 'codexrHistoricalComparisonRoot');

  // 4. Re-enter: the preserved comparison comes back visible and settled,
  //    wearing the chart the controller shows, each side still on its own
  //    revision. (The controller's chart type is shared across modes, so the
  //    comparison follows it back; what must never change is the data.)
  await page.evaluate(() => window.CodeXRHistoricalComparisonRuntime.__testing.selectHistoricalMode());
  const reentered = await waitFor('const components = { bars: "babia-bars", barsmap: "babia-barsmap", cyls: "babia-cyls",'
    + ' cylsmap: "babia-cylsmap", pie: "babia-pie", donut: "babia-doughnut", bubbles: "babia-bubbles", boats: "babia-boats" };'
    + ` ${settledOn.replace('return ', 'return state.status === "" && ').replace('(state, arg)', '(state, components[state.chartId])')}`,
  null, 're-enter the comparison');
  assert.equal(reentered.normalShown, false);
  assert.deepEqual(reentered.adoptedByNormal, []);

  // 5. And it still switches correctly after the round trip.
  await page.evaluate(() => window.CodeXRMappingUiRuntime.selectChart('boats'));
  await waitFor(settledOn, 'babia-boats', 'switch to boats after re-entry');
  await page.evaluate(() => window.CodeXRMappingUiRuntime.selectChart('bars'));
  await waitFor(settledOn, 'babia-bars', 'switch back to bars after re-entry');

  assert.deepEqual(errors, []);
  await page.close();
  console.log('[xr-mode-harness] historical comparison scenarios passed (enter, Bars/Boats/flat switches, leave, re-enter).');
}

// DEPGRAPH-12: the dependency graph against room states the S13 fixes were
// for. Each scenario opens a fresh page whose room entity starts from
// window.__DEP_STATE, like a participant joining at that moment.
const DEPENDENCY_SCOPE = './xr-mode-dependency-scope.json';
const BIG_DATASET = './__generated/big-dependency-data.json';

function bigDependencyDataset(nodeCount = 900, edgeCount = 2400) {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `file:m${index}.ts`, kind: 'file', label: `m${index}.ts`, relativePath: `m${index}.ts`,
    language: 'TypeScript', external: false,
    metrics: { totalLines: 10 + index, degree: 0, fanIn: 0, fanOut: 0, relationCount: 0, cycleSize: 0 },
  }));
  const edges = Array.from({ length: edgeCount }, (_, index) => {
    const source = index % nodeCount;
    const target = (index * 7 + 1) % nodeCount;
    return { id: `edge:${index}`, source: nodes[source].id, target: nodes[target === source ? (target + 1) % nodeCount : target].id,
      kind: 'import', confidence: 'exact', count: 1 };
  });
  return { schemaVersion: 2, revision: 1, sourceRevision: 1, targetType: 'directory', targetRelativePath: '', nodes, edges };
}

async function openDependencyPage(browser, depState) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/big-dependency-data\.json/, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(bigDependencyDataset()),
  }));
  await page.addInitScript((state) => {
    window.__DEP_STATE = state;
    const NativeWorker = window.Worker;
    window.__workers = { created: 0, terminated: 0 };
    window.Worker = function HarnessWorker(url, options) {
      const worker = new NativeWorker(url, options);
      window.__workers.created += 1;
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => { window.__workers.terminated += 1; terminate(); };
      return worker;
    };
  }, depState || {});
  await page.goto(await harnessUrl(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('scene')?.hasLoaded
    && window.CodeXRAnalysisModeRuntime?.getState?.().mode === 'single'
    && window.CodeXRDependencyGraphRuntime?.getState?.().snapshot, null, { timeout: 30000 });
  return { page, errors };
}

async function enterDependencies(page, timeout = 30000) {
  await page.evaluate(() => window.CodeXRDependencyGraphRuntime.__testing.selectDependencyMode());
  try {
    await page.waitForFunction(() => window.CodeXRAnalysisModeRuntime.getState().mode === 'dependency-graph'
      && !window.CodeXRAnalysisModeRuntime.getState().transitioning, null, { timeout });
  } catch {
    const seen = await page.evaluate(() => ({
      mode: window.CodeXRAnalysisModeRuntime.getState(),
      status: window.CodeXRDependencyGraphRuntime.getState().status || null,
      texts: [...document.querySelectorAll('a-text')].map((t) => t.getAttribute('value')).filter((v) => /depend|could not|load|respond|fail/i.test(v || '')).slice(0, 6),
    }));
    assert.fail(`entering the dependency graph stalled: ${JSON.stringify(seen)}`);
  }
}

async function leaveDependencies(page) {
  await page.evaluate(() => window.CodeXRHarness.client.sendMessage('analysis-mode-activate', { mode: 'single' }));
  await page.waitForFunction(() => window.CodeXRAnalysisModeRuntime.getState().mode === 'single'
    && !window.CodeXRAnalysisModeRuntime.getState().transitioning, null, { timeout: 30000 });
}

function graphState() {
  const runtime = window.CodeXRDependencyGraphRuntime.getState();
  const component = document.getElementById('codexrDependencyGraph')?.components?.['codexr-dependency-graph'];
  const positions = Object.values(component?.nodes || {}).map((record) => record.el.object3D.position);
  return {
    targetType: runtime.dataset?.targetType || null,
    scope: runtime.snapshot?.scope || null,
    nodes: positions.length,
    outsideTable: positions.filter((p) => Math.abs(p.x) > 2.35 || Math.abs(p.z) > 1.175).length,
    budgetNotice: runtime.renderBudgetNotice || '',
  };
}

async function waitForGraph(page, predicate, label, argument) {
  try {
    await page.waitForFunction(predicate, argument, { timeout: 20000, polling: 200 });
  } catch {
    assert.fail(`${label}: graph stayed at ${JSON.stringify(await page.evaluate(graphState))}`);
  }
  return page.evaluate(graphState);
}

const hasNodes = () => {
  const component = document.getElementById('codexrDependencyGraph')?.components?.['codexr-dependency-graph'];
  return Object.keys(component?.nodes || {}).length > 0;
};

async function runDependencyScenarios(browser) {
  // 1. Drill into a file and back in one session, then reload with the room
  //    entity that left behind: the late joiner sees the same view (DEPGRAPH-4).
  let { page, errors } = await openDependencyPage(browser, {});
  await enterDependencies(page);
  await waitForGraph(page, hasNodes, 'project graph');
  await page.evaluate(() => window.CodeXRDependencyGraphRuntime.openFile('src/analysis.ts'));
  const inFile = await waitForGraph(page, () => window.CodeXRDependencyGraphRuntime.getState().dataset?.targetType === 'file'
    && document.getElementById('codexrDependencyGraph')?.components?.['codexr-dependency-graph']
    && Object.keys(document.getElementById('codexrDependencyGraph').components['codexr-dependency-graph'].nodes || {}).length > 0, 'drill into a file');
  assert.equal(inFile.scope.kind, 'file');
  const requests = await page.evaluate(() => window.CodeXRHarness.sent.map(([type]) => type));
  assert.ok(requests.includes('dependency-file-scope-request'), 'opening a file asks the server (DEPGRAPH-8)');
  const roomEntity = await page.evaluate(() => JSON.parse(JSON.stringify(window.CodeXRHarness.dependencyState)));
  assert.equal(roomEntity.fileDatasetUrl, DEPENDENCY_SCOPE);
  assert.deepEqual(errors, []);
  await page.close();

  ({ page, errors } = await openDependencyPage(browser, roomEntity));
  await enterDependencies(page);
  const lateJoiner = await waitForGraph(page, () => window.CodeXRDependencyGraphRuntime.getState().dataset?.targetType === 'file'
    && Object.keys(document.getElementById('codexrDependencyGraph')?.components?.['codexr-dependency-graph']?.nodes || {}).length > 0,
  'late joiner in file scope');
  assert.equal(lateJoiner.scope.relativePath, 'src/analysis.ts');
  assert.deepEqual(errors, []);
  await page.close();

  // 2. A project past the render budget keeps the best-connected nodes, says
  //    so, and stays on the table (DEPGRAPH-5).
  ({ page, errors } = await openDependencyPage(browser, { datasetUrl: BIG_DATASET, projectDatasetUrl: BIG_DATASET }));
  await enterDependencies(page);
  const budgeted = await waitForGraph(page, () => window.CodeXRDependencyGraphRuntime.getState().renderBudgetNotice
    && Object.keys(document.getElementById('codexrDependencyGraph')?.components?.['codexr-dependency-graph']?.nodes || {}).length > 0,
  'budgeted graph');
  assert.ok(budgeted.nodes <= 601, `at most 600 nodes plus "N more", saw ${budgeted.nodes}`);
  assert.match(budgeted.budgetNotice, /Showing 600 of 900 nodes/);
  assert.equal(budgeted.outsideTable, 0, 'every node stays on the table');
  assert.deepEqual(errors, []);

  // 3. Entering and leaving three times does not leak layout workers (DEPGRAPH-6).
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await leaveDependencies(page);
    await enterDependencies(page);
    await waitForGraph(page, hasNodes, `cycle ${cycle}`);
  }
  const workers = await page.evaluate(() => window.__workers);
  assert.ok(workers.created - workers.terminated <= 1, `live workers after 3 cycles: ${JSON.stringify(workers)}`);
  await page.close();

  // 4. Entering while a refresh is still running attaches to it and draws the
  //    graph when it lands, instead of an error (DEPGRAPH-7).
  ({ page, errors } = await openDependencyPage(browser, { status: 'analyzing', message: 'Updating changed dependency sources...' }));
  await enterDependencies(page);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.CodeXRAnalysisModeRuntime.getState().mode), 'dependency-graph');
  await page.evaluate(() => {
    Object.assign(window.CodeXRHarness.dependencyState, { status: 'ready', message: 'Harness dependency graph ready.', revision: 2 });
    window.CodeXRHarness.apply('dependency-graph', Object.assign({}, window.CodeXRHarness.dependencyState));
  });
  await waitForGraph(page, hasNodes, 'graph after the running refresh finished');
  assert.deepEqual(errors, []);
  await page.close();
  console.log('[xr-mode-harness] dependency graph scenarios passed (drill-down + late joiner, budget, workers, busy re-entry).');
}

runPlaywrightIfAvailable().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

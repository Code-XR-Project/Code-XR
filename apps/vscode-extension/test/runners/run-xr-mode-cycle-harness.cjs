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

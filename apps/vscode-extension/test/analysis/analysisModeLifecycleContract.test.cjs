// The in-scene mode lifecycle contract (epic #72, story S7): a mode that
// hangs, fails or is overtaken by a newer pick must always leave the switcher
// usable, say why on the selector, and keep the room in step.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const { readAssembledRuntime } = require(path.join(projectRoot, 'test', 'helpers', 'runtimeAssembly.cjs'));

const quietConsole = { error() {}, warn() {}, log() {}, table() {} };
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function createFakeElement(tagName) {
  const element = {
    tagName,
    attributes: {},
    children: [],
    listeners: {},
    parentNode: null,
    get firstChild() { return this.children[0] || null; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      this.children = this.children.filter(candidate => candidate !== child);
      child.parentNode = null;
      return child;
    },
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); },
  };
  return element;
}

/** Boots the runtime with a document, a controller panel and a room client. */
function bootRuntime(options = {}) {
  const sent = [];
  const entityRuntimes = [];
  let panelView = null;
  const context = {
    setTimeout,
    clearTimeout,
    Date,
    console: options.console || quietConsole,
    document: {
      createElement: createFakeElement,
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    CodeXRMappingUiRuntime: {
      isPanelReady() { return true; },
      registerPanelView(view) { panelView = view; return () => {}; },
      setPanelViewButtonColor() {},
      setChartEntityIds() {},
    },
    CodeXRCollaborationRuntime: {
      getClient() {
        return {
          sendMessage(type, payload) { sent.push({ type, payload }); },
          registerEntityRuntime(runtime) { entityRuntimes.push(runtime); },
        };
      },
    },
  };
  vm.runInNewContext(readAssembledRuntime('analysis-mode', 'analysisModeRuntime.js'), context);
  const runtime = context.CodeXRAnalysisModeRuntime;
  return {
    runtime,
    sent,
    get panelView() { return panelView; },
    analysisView: () => entityRuntimes.find(candidate => candidate.entityKind === 'analysis-view'),
    headline() {
      const text = panelView?.content?.children?.find(child => child.attributes['data-codexr-mode-selector-status']);
      return text ? { value: text.attributes.value, tone: text.attributes['data-codexr-mode-selector-status'] } : null;
    },
    optionLabels() {
      return (panelView?.content?.children || [])
        .filter(child => child.attributes['data-codexr-mode-option'])
        .map(child => child.children[0].attributes.value);
    },
  };
}

test('a never-settling activate is abandoned when the user picks another mode', async () => {
  const { runtime } = bootRuntime();
  const roots = new Set();
  let releaseDependency;
  let seenSignal = null;
  runtime.register('dependency-graph', {
    activate(activation) {
      seenSignal = activation.signal;
      roots.add('dependency-graph');
      // A dataset fetch that never answers.
      return new Promise(resolve => { releaseDependency = resolve; });
    },
    deactivate() {
      roots.delete('dependency-graph');
      roots.delete('dependency-graph-late-root');
    },
  });
  runtime.register('single', {
    activate() { roots.add('single'); },
    deactivate() { roots.delete('single'); },
  });

  const dependency = runtime.changeAnalysis('dependency-graph', { reason: 'test' });
  await tick();
  assert.equal(runtime.getState().activation.mode, 'dependency-graph');

  // Picking Normal analysis no longer waits behind the hung activate.
  const normal = runtime.changeAnalysis('single', { reason: 'test' });
  assert.equal(seenSignal.aborted, true, 'the hung activation is told to stop');
  assert.equal(await dependency, false);
  assert.equal(await normal, true);
  assert.equal(runtime.getState().mode, 'single');
  assert.equal(runtime.getState().transitioning, false);
  assert.deepEqual(Array.from(roots), ['single']);

  // When the stale activate finally settles, what it mounted late is removed.
  roots.add('dependency-graph-late-root');
  releaseDependency();
  await tick(5);
  assert.deepEqual(Array.from(roots).filter(root => root.startsWith('dependency')), []);
});

test('an activate that times out lands on the selector with a visible error and a Retry option', async () => {
  const harness = bootRuntime();
  const { runtime, sent } = harness;
  runtime.registerModeOption({ id: 'dependency-graph', label: 'Dependency graph', onSelect() {} });
  let deactivated = 0;
  let signal = null;
  runtime.register('dependency-graph', {
    activateTimeoutMs: 20,
    activate(activation) { signal = activation.signal; return new Promise(() => {}); },
    deactivate() { deactivated += 1; },
  });
  runtime.register('selection', { activate() {} });

  assert.equal(await runtime.changeAnalysis('dependency-graph', { reason: 'local-analysis-mode-option' }), false);

  const state = runtime.getState();
  assert.equal(state.mode, 'selection');
  assert.equal(state.transitioning, false);
  assert.equal(state.lastError.mode, 'dependency-graph');
  assert.equal(state.lastError.code, 'timeout');
  assert.equal(signal.aborted, true, 'the timed-out activation is aborted');
  assert.ok(deactivated >= 1);
  // "Analyses" must not resume the mode that just failed.
  assert.equal(state.requestedMode, 'single');
  // The room is told to leave the failed mode.
  assert.deepEqual(sent.map(message => message.type), ['analysis-mode-selection']);
  // The selector says what happened, and the failed option reads "Retry".
  const headline = harness.headline();
  assert.equal(headline.tone, 'error');
  assert.match(headline.value, /^Could not open Dependency graph: Opening Dependency graph did not finish within 0 s\./);
  assert.ok(harness.optionLabels().includes('Retry: Dependency graph'));
});

test('a failed activation is not retried by the room echo, and success clears the error', async () => {
  const harness = bootRuntime();
  const { runtime } = harness;
  let activations = 0;
  let fail = true;
  runtime.register('historical-compare', {
    activate() {
      activations += 1;
      if (fail) { throw new Error('comparison data could not be loaded (HTTP 500)'); }
    },
  });
  runtime.register('selection', { activate() {} });

  assert.equal(await runtime.changeAnalysis('historical-compare', { reason: 'local-analysis-mode-option' }), false);
  assert.equal(activations, 1);
  assert.match(harness.headline().value, /HTTP 500/);

  // The server's echo of the pick arrives after the failure.
  harness.analysisView().applySharedState({ mode: 'historical-compare', viewRevision: 3 });
  await tick(5);
  assert.equal(activations, 1, 'the echo did not re-run the failing activate');
  assert.equal(runtime.getState().mode, 'selection');

  // A deliberate retry runs, and a success clears the error.
  fail = false;
  assert.equal(await runtime.changeAnalysis('historical-compare', { reason: 'local-analysis-mode-option' }), true);
  assert.equal(activations, 2);
  assert.equal(runtime.getState().lastError, null);
  assert.equal(runtime.getState().requestedMode, 'historical-compare');
});

test('a failure caused by the room echo does not send the room back to the selector', async () => {
  const { runtime, sent, analysisView } = bootRuntime();
  runtime.register('project-evolution', { activate() { throw new Error('tree not available'); } });
  runtime.register('selection', { activate() {} });

  analysisView().applySharedState({ mode: 'project-evolution', viewRevision: 2 });
  await tick(5);
  assert.equal(runtime.getState().mode, 'selection');
  assert.equal(runtime.getState().lastError.mode, 'project-evolution');
  // Another participant chose it and it may work for them: this page only
  // reports its own failure.
  assert.deepEqual(sent, []);
});

test('picking an analysis while the selector is still opening keeps the pick (no late selection)', async () => {
  const { runtime, sent } = bootRuntime();
  let releaseSelection;
  runtime.register('selection', {
    activate() { return new Promise(resolve => { releaseSelection = resolve; }); },
  });
  runtime.register('dependency-graph', { activate() {} });

  const opening = runtime.openSelector();
  await tick();
  // The user picks Dependency graph before the selection transition lands.
  sent.push({ type: 'analysis-mode-activate', payload: { mode: 'dependency-graph' } });
  const pick = runtime.changeAnalysis('dependency-graph', { reason: 'local-analysis-mode-option' });
  releaseSelection();
  assert.equal(await opening, false);
  assert.equal(await pick, true);

  // The last word the server hears is the pick, not a stale "selection".
  assert.equal(sent.at(-1).type, 'analysis-mode-activate');
  assert.ok(!sent.some(message => message.type === 'analysis-mode-selection'));
  assert.equal(runtime.getState().mode, 'dependency-graph');
});

test('a hook that never settles cannot hold the switcher', async () => {
  const { runtime } = bootRuntime();
  runtime.__testing.setHookTimeoutMs(30);
  runtime.register('project-evolution', {
    activate() {},
    // A deactivate that hangs (a stuck animation wait, for one).
    deactivate() { return new Promise(() => {}); },
  });
  runtime.register('single', { activate() {} });
  assert.equal(await runtime.changeAnalysis('project-evolution'), true);
  const started = Date.now();
  assert.equal(await runtime.changeAnalysis('single'), true);
  assert.ok(Date.now() - started < 2000, 'the hung deactivate was abandoned after its timeout');
  assert.equal(runtime.getState().mode, 'single');
});

test('modes can report opening progress on the selector', () => {
  const harness = bootRuntime();
  harness.runtime.setSelectorStatus('Opening dependencies...');
  assert.deepEqual(harness.headline(), { value: 'Opening dependencies...', tone: 'info' });
  harness.runtime.setSelectorStatus('The dependency analysis did not respond.', 'error');
  assert.equal(harness.headline().tone, 'error');
  harness.runtime.setSelectorStatus('');
  assert.equal(harness.headline().value, 'Choose how the analysis table represents the data.');
});

test('a room snapshot after a server restart is applied even with a lower view revision', async () => {
  const { runtime, analysisView } = bootRuntime();
  const entered = [];
  runtime.register('dependency-graph', { activate() { entered.push('dependency-graph'); } });
  runtime.register('historical-compare', { activate() { entered.push('historical-compare'); } });
  analysisView().applySharedState({ mode: 'dependency-graph', viewRevision: 40 }, { source: 'room' });
  await tick(5);
  // A plain update older than what was applied is stale and ignored...
  analysisView().applySharedState({ mode: 'historical-compare', viewRevision: 3 }, { source: 'room' });
  await tick(5);
  assert.equal(runtime.getState().mode, 'dependency-graph');
  // ...but a fresh room snapshot (re-join to a restarted session) is the
  // room's whole state and resets the floor.
  analysisView().applySharedState({ mode: 'historical-compare', viewRevision: 3 }, { source: 'snapshot' });
  await tick(5);
  assert.equal(runtime.getState().mode, 'historical-compare');
  assert.equal(runtime.getState().lastAuthoritativeViewRevision, 3);
});

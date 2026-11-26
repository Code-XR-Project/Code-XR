// Issue #109 (epic #72): the minor failure paths left by the verification.
// One test (or more) per finding: CHARTS-16, EVO-16, CHARTS-18, LIFECYCLE-11,
// LIFECYCLE-12, DEPGRAPH-7, HIST-8.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const { readAssembledRuntime } = require(path.join(projectRoot, 'test', 'helpers', 'runtimeAssembly.cjs'));
const { createFakeVscode, withFakeVscode, fakeExtensionContext } = require('../helpers/fakeVscode.cjs');

const quietConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {}, table() {} };

/**
 * Pulls one top-level function of an assembled runtime out by name, so its
 * failure paths can run against stubs instead of a whole scene.
 */
function extractFunction(source, signature) {
    const start = source.indexOf(signature);
    assert.notEqual(start, -1, 'missing ' + signature);
    const open = source.indexOf('{', source.indexOf(')', start));
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        const character = source[index];
        if (character === '{') { depth += 1; }
        if (character === '}') {
            depth -= 1;
            if (depth === 0) { return source.slice(start, index + 1); }
        }
    }
    throw new Error('unterminated ' + signature);
}

// ── CHARTS-16 ────────────────────────────────────────────────────────

function loadAnalysisTableWithBabiaPie() {
    const inits = [];
    const babiaChart = (name) => {
        function Component() {}
        Component.prototype.init = function originalInit() { inits.push(name); };
        return { Component };
    };
    const sandbox = {
        console: quietConsole,
        setTimeout() { return 1; },
        clearTimeout() {},
        AFRAME: {
            components: { 'babia-pie': babiaChart('babia-pie'), 'babia-doughnut': babiaChart('babia-doughnut') },
            registerComponent(name, definition) { this.components[name] = definition; },
        },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(readAssembledRuntime('analysis-table', 'analysisTableRuntime.js'), sandbox);
    return { sandbox, inits, testing: sandbox.CodeXRAnalysisTableRuntime.__testing };
}

function fakeNode(className) {
    return { parentNode: null, classList: { contains: (name) => name === className } };
}

function fakeChartElement() {
    return {
        children: [],
        appendChild(child) { this.children.push(child); child.parentNode = this; },
        removeChild(child) {
            const index = this.children.indexOf(child);
            if (index === -1) {
                throw new Error("Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.");
            }
            this.children.splice(index, 1);
            child.parentNode = null;
            return child;
        },
    };
}

test('CHARTS-16: a pie/donut hover legend removed by a rebuild no longer throws on mouseleave', () => {
    const { sandbox, inits } = loadAnalysisTableWithBabiaPie();
    for (const name of ['babia-pie', 'babia-doughnut']) {
        const el = fakeChartElement();
        sandbox.AFRAME.components[name].Component.prototype.init.call({ el });
        assert.ok(inits.includes(name), 'the original init still runs');

        // Hover: Babia appends the legend to the chart entity.
        const legend = fakeNode('babiaxrLegend');
        el.appendChild(legend);
        // Rebuild: processData empties the chart, legend included.
        el.children.length = 0;
        legend.parentNode = null;
        // mouseleave on the old slice: Babia's `n.removeChild(legend)`.
        assert.doesNotThrow(() => el.removeChild(legend));

        // An attached legend is still removed for real.
        const live = fakeNode('babiaxrLegend');
        el.appendChild(live);
        assert.equal(el.removeChild(live), live);
        assert.equal(el.children.length, 0);

        // Anything else keeps the native error: only the legend case is swallowed.
        assert.throws(() => el.removeChild(fakeNode('babiaxrChart')), /not a child/);
    }
});

test('CHARTS-16: the legend guard installs once per element', () => {
    const { testing } = loadAnalysisTableWithBabiaPie();
    const el = fakeChartElement();
    assert.equal(testing.guardBabiaLegendRemoval(el), true);
    assert.equal(testing.guardBabiaLegendRemoval(el), false);
});

// ── CHARTS-18 ────────────────────────────────────────────────────────

function fakeThree() {
    class Vector3 {
        constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
        copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
        set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    }
    class Box3 {
        constructor(min = new Vector3(), max = new Vector3()) { this.min = min; this.max = max; }
        clone() { return new Box3(new Vector3().copy(this.min), new Vector3().copy(this.max)); }
        copy(box) { this.min.copy(box.min); this.max.copy(box.max); return this; }
        union(box) {
            this.min.set(Math.min(this.min.x, box.min.x), Math.min(this.min.y, box.min.y), Math.min(this.min.z, box.min.z));
            this.max.set(Math.max(this.max.x, box.max.x), Math.max(this.max.y, box.max.y), Math.max(this.max.z, box.max.z));
            return this;
        }
        getSize(target) { return target.set(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z); }
        getCenter(target) { return target.set((this.max.x + this.min.x) / 2, (this.max.y + this.min.y) / 2, (this.max.z + this.min.z) / 2); }
    }
    return { Box3, Vector3 };
}

function meshNode(three, size, options = {}) {
    return {
        visible: options.visible !== false,
        children: options.children || [],
        geometry: size === null ? null : { boundingBox: new three.Box3(new three.Vector3(0, 0, 0), new three.Vector3(size, size, size)) },
        updateMatrixWorld() {},
        traverse() {},
    };
}

test('CHARTS-18: buildFilteredBounds skips the subtree under a hidden ancestor', () => {
    const { testing } = loadAnalysisTableWithBabiaPie();
    const three = fakeThree();
    const insideHiddenGroup = meshNode(three, 50);
    const hiddenGroup = meshNode(three, null, { visible: false, children: [insideHiddenGroup] });
    const visibleBar = meshNode(three, 2);
    const chart = meshNode(three, null, { children: [visibleBar, hiddenGroup] });

    const bounds = testing.buildFilteredBounds(three, chart, null);
    assert.equal(bounds.size.x, 2, 'a mesh under a hidden group must not stretch the bounds');

    // The measured root itself is exempt: containment measures a chart while
    // it is still hidden, before revealing it.
    chart.visible = false;
    assert.equal(testing.buildFilteredBounds(three, chart, null).size.x, 2);
});

test('CHARTS-18: a `;` in the title no longer breaks the chart component string', async () => {
    await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
        const { CreateChart, escapeChartTitleForComponent } = requireOut('core/charts/processing/placeholders/createChart.js');
        assert.equal(escapeChartTitleForComponent('Directory Analysis: my;proj'), 'Directory Analysis: my,proj');
        assert.equal(escapeChartTitleForComponent('a "b" & <c> ${X} {{Y}}'), 'a &quot;b&quot; &amp; &lt;c&gt; &#36;&#123;X&#125; &#123;&#123;Y&#125;&#125;');

        const result = CreateChart.createChartEntity('bars', [
            { dimension: 'x_axis', dataField: 'fileName' },
            { dimension: 'height', dataField: 'totalLines' },
        ], 'Directory Analysis: my;proj $& "q"');
        assert.equal(result.success, true, result.error);
        const attribute = /babia-bars="([^"]*)"/.exec(result.chartHtml);
        assert.ok(attribute, 'the attribute stays one double-quoted value');
        // Decode the entities the way the HTML parser does, then split the
        // way A-Frame does: the title must come back whole.
        const decoded = attribute[1].replace(/&quot;/g, '"').replace(/&#36;/g, '$').replace(/&amp;/g, '&');
        const properties = Object.fromEntries(decoded.split(';').map((part) => part.trim()).filter(Boolean)
            .map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]));
        assert.equal(properties.title, 'Directory Analysis: my,proj $& "q"');
        assert.equal(properties.proj, undefined);
    });
});

// ── EVO-16 ───────────────────────────────────────────────────────────

function loadEvolutionTransitions(stubs) {
    const source = readAssembledRuntime('project-evolution', 'projectEvolutionRuntime.js');
    const calls = [];
    const sandbox = {
        state: { viewGeneration: 1, playing: false, frameIndex: 0, dataRefreshGeneration: 1, result: { revision: 1, frames: [{ index: 0 }] } },
        refs: {},
        isEvolutionViewCurrent: () => true,
        releaseEvolutionChart() {},
        frameUrlWithCache: () => '/frame.json',
        getEvolutionDataBuffer: () => ({ data: [] }),
        ensureDeclarativeEvolutionPipeline: async () => ({ chart: {}, chartId: 'bars', componentName: 'babia-bars', dataSourceCreated: false }),
        captureEvolutionChartTransition: () => null,
        configureEvolutionChart: () => true,
        refreshEvolutionDataSource: () => 2,
        beginInitialEvolutionDataLoad: () => 2,
        waitForEvolutionDataRefresh: async () => true,
        waitForEvolutionChartAnimation: async () => true,
        waitForEvolutionContainmentStable: async () => true,
        nextRenderFrame: async () => {},
        setStatus() {},
        beginEvolutionDataTransition: (reason) => calls.push(['begin', reason]),
        finishEvolutionDataTransition: (reason) => calls.push(['finish', reason]),
        cancelEvolutionDataTransition: (reason) => calls.push(['cancel', reason]),
        ...stubs,
    };
    vm.runInNewContext([
        extractFunction(source, 'async function applyEvolutionChartSelection('),
        extractFunction(source, 'async function applyBridgeFrameToChart('),
        'this.applyEvolutionChartSelection = applyEvolutionChartSelection;',
        'this.applyBridgeFrameToChart = applyBridgeFrameToChart;',
    ].join('\n'), sandbox);
    return { sandbox, calls };
}

test('EVO-16: a throw inside a frame transition still cancels it (never left uncontained)', async () => {
    const boom = () => { throw new Error('babia exploded'); };
    for (const failing of ['waitForEvolutionDataRefresh', 'waitForEvolutionChartAnimation', 'refreshEvolutionDataSource']) {
        const { sandbox, calls } = loadEvolutionTransitions({ [failing]: boom });
        await assert.rejects(sandbox.applyBridgeFrameToChart({ index: 0 }, '/bridge.json', 1), /babia exploded/);
        assert.deepEqual(calls.map(([kind]) => kind), ['begin', 'cancel'], failing);
    }
});

test('EVO-16: a throw inside a chart selection transition still cancels it', async () => {
    for (const failing of ['configureEvolutionChart', 'waitForEvolutionChartAnimation']) {
        const { sandbox, calls } = loadEvolutionTransitions({ [failing]: () => { throw new Error('mapping failed'); } });
        await assert.rejects(sandbox.applyEvolutionChartSelection(false, 1), /mapping failed/);
        assert.deepEqual(calls.map(([kind]) => kind), ['begin', 'cancel'], failing);
    }
});

test('EVO-16: the happy paths finish exactly once and never cancel', async () => {
    const frame = loadEvolutionTransitions({});
    assert.equal(await frame.sandbox.applyBridgeFrameToChart({ index: 0 }, '/bridge.json', 1), true);
    assert.deepEqual(frame.calls.map(([kind]) => kind), ['begin', 'finish']);
    const selection = loadEvolutionTransitions({});
    assert.equal(await selection.sandbox.applyEvolutionChartSelection(false, 1), true);
    assert.deepEqual(selection.calls.map(([kind]) => kind), ['begin', 'finish']);
    const refused = loadEvolutionTransitions({ waitForEvolutionDataRefresh: async () => false });
    assert.equal(await refused.sandbox.applyBridgeFrameToChart({ index: 0 }, '/bridge.json', 1), false);
    assert.deepEqual(refused.calls.map(([kind]) => kind), ['begin', 'cancel'], 'a soft failure cancels once, not twice');
});

// ── LIFECYCLE-11 ─────────────────────────────────────────────────────

test('LIFECYCLE-11: the dependency-graph mount logs once when it gives up', () => {
    const source = readAssembledRuntime('dependency-graph', 'dependencyGraphRuntime.js');
    const warnings = [];
    const timers = [];
    const sandbox = {
        root: { console: { warn: (...args) => warnings.push(args.join(' ')) } },
        refs: {},
        state: {},
        buildPanel() {},
        registerDependencyModeOption() {},
        setTimeout: (fn) => timers.push(fn),
    };
    vm.runInNewContext(extractFunction(source, 'function mount(attempt)') + '\nthis.mount = mount;', sandbox);
    sandbox.mount(0);
    while (timers.length) { timers.shift()(); }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Gave up mounting after 3 s: controls panel, mode option, mode lifecycle not available/);
});

test('LIFECYCLE-11: analysis-view collaboration registration logs once when it gives up', () => {
    const source = readAssembledRuntime('analysis-mode', 'analysisModeRuntime.js');
    const logs = [];
    const timers = [];
    const sandbox = {
        root: {
            console: { warn: (msg) => logs.push(['warn', msg]), info: (msg) => logs.push(['info', msg]) },
            setTimeout: (fn) => { timers.push(fn); return {}; },
            CodeXRCollaborationRuntime: { getClient: () => null },
        },
        state: {},
    };
    vm.runInNewContext(extractFunction(source, 'function registerCollaboration(attempt)') + '\nthis.registerCollaboration = registerCollaboration;', sandbox);
    sandbox.registerCollaboration(0);
    while (timers.length) { timers.shift()(); }
    assert.deepEqual(logs.map(([level]) => level), ['warn', 'info']);
    assert.match(logs[1][1], /No collaboration client after ~1 min/);
});

// ── LIFECYCLE-12 ─────────────────────────────────────────────────────

test('LIFECYCLE-12: a rejected normal-chart wait still shows the chart and is handled', async () => {
    const source = readAssembledRuntime('analysis-mode', 'analysisModeRuntime.js');
    const lifecycles = {};
    const visible = [];
    const warnings = [];
    const sandbox = {
        root: { console: { warn: (...args) => warnings.push(args.join(' ')) } },
        state: { mode: 'single', activeLifecycleMode: 'single' },
        register: (mode, lifecycle) => { lifecycles[mode] = lifecycle; },
        clearVisualizationsForSelection: async () => {},
        getConfig: () => ({}),
        ensureAnalysisSurfaceRuntime: () => ({ activateMode() {} }),
        getNormalMappingTargetIds: () => [],
        restoreChartTransforms() {},
        waitForNormalChartReady: () => Promise.reject(new Error('charts never settled')),
        setNormalVisualizationVisible: (value) => visible.push(value),
    };
    vm.runInNewContext(extractFunction(source, 'function registerBuiltInLifecycles()') + '\nthis.registerBuiltInLifecycles = registerBuiltInLifecycles;', sandbox);
    sandbox.registerBuiltInLifecycles();

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        lifecycles.single.activate({});
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
    assert.deepEqual(visible, [true]);
    assert.match(warnings[0], /Normal chart did not report ready/);
});

// ── DEPGRAPH-7 ───────────────────────────────────────────────────────

test('DEPGRAPH-7: a click during a re-analysis says "Busy, please wait" and the unlock clears it', () => {
    const source = readAssembledRuntime('dependency-graph', 'dependencyGraphRuntime.js');
    const statusEl = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    const sent = [];
    const sandbox = {
        root: {},
        refs: { status: statusEl },
        state: { snapshot: { layout: 'radial' }, transitionLocked: true },
        client: () => ({ sendMessage: (type) => sent.push(type) }),
        renderControls() {},
        renderGraph() {},
        setTimeout: () => 1,
        clearTimeout() {},
        FLOW_DEFAULTS: { flowSize: 'm', flowSpeed: 'm' },
    };
    vm.runInNewContext([
        "var BUSY_STATUS_MESSAGE = 'Busy, please wait...';",
        extractFunction(source, 'function setStatus(message, error)'),
        extractFunction(source, 'function setTransitionLocked(locked, message)'),
        extractFunction(source, 'function publishState(patch)'),
        'this.publishState = publishState; this.setTransitionLocked = setTransitionLocked; this.setStatus = setStatus;',
    ].join('\n'), sandbox);
    assert.match(source, /var BUSY_STATUS_MESSAGE = 'Busy, please wait\.\.\.';/);

    sandbox.publishState({ layout: 'grid' });
    assert.deepEqual(sent, [], 'the click is still refused while locked');
    assert.equal(sandbox.state.snapshot.layout, 'radial');
    assert.equal(statusEl.attributes.value, 'Busy, please wait...');
    assert.equal(statusEl.attributes.visible, true);

    sandbox.setTransitionLocked(false);
    assert.equal(statusEl.attributes.value, '', 'the busy notice does not outlive the lock');

    // Unlocking never wipes a different message (a budget notice, an error).
    sandbox.setTransitionLocked(true);
    sandbox.setStatus('Showing 600 of 2457 nodes', false);
    sandbox.setTransitionLocked(false);
    assert.equal(statusEl.attributes.value, 'Showing 600 of 2457 nodes');

    sandbox.publishState({ layout: 'grid' });
    assert.deepEqual(sent, ['dependency-graph-settings']);
});

// ── HIST-8 ───────────────────────────────────────────────────────────

test('HIST-8: startup cleanup sweeps stale historical-comparisons sessions', async () => {
    const context = fakeExtensionContext();
    try {
        await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
            const { HISTORICAL_COMPARISON_STORAGE_FOLDER, getSweptStorageFolders } = requireOut('core/analysis/launch/storageFolders.js');
            assert.equal(HISTORICAL_COMPARISON_STORAGE_FOLDER, 'historical-comparisons');
            assert.ok(getSweptStorageFolders().includes('historical-comparisons'));
            // The service writes under the same name the sweep reads.
            const serviceSource = fs.readFileSync(path.join(projectRoot, 'src', 'core', 'history', 'historicalComparisonService.ts'), 'utf8');
            assert.match(serviceSource, new RegExp(`'${HISTORICAL_COMPARISON_STORAGE_FOLDER}'`));

            const root = path.join(context.storageUri.fsPath, 'historical-comparisons');
            const stale = path.join(root, 'old-session', 'snapshots', 'abc');
            fs.mkdirSync(stale, { recursive: true });
            fs.writeFileSync(path.join(stale, 'a.ts'), 'x');
            const past = new Date(Date.now() - 60_000);
            fs.utimesSync(path.join(root, 'old-session'), past, past);

            const { CleanAnalysisCommands } = requireOut('features/analysis/commands/cleanAnalysisCommands.js');
            await CleanAnalysisCommands.executeStartupCleanup(context, Date.now() - 1_000);
            assert.equal(fs.existsSync(path.join(root, 'old-session')), false);
        });
    } finally {
        context.cleanup();
    }
});

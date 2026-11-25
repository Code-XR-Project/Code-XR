/**
 * LivePanel live updates (SSE), driven end to end in both panels.
 *
 * Each panel is assembled exactly as `LivePanelParser` serves it (the shared
 * components under templates/components/livepanel/, sorted, then the panel's
 * own script) and run in a `vm` context with a permissive fake DOM and a fake
 * EventSource. The test then calls the panel's `initializeSSE()`, plays every
 * server message type through the EventSource, and records what the panel
 * DID: which status it showed, which reloads it triggered, what it handed to
 * the historical panel. Console output is diagnostics and is not recorded.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const sharedDir = path.join(projectRoot, 'templates', 'components', 'livepanel');
const panelsDir = path.join(projectRoot, 'templates', 'analysis_livePanel');

function readBundle(panel, scriptName) {
    const shared = fs.readdirSync(sharedDir)
        .sort()
        .filter((name) => name.endsWith('.js'))
        .map((name) => fs.readFileSync(path.join(sharedDir, name), 'utf8'));
    return [...shared, fs.readFileSync(path.join(panelsDir, panel, scriptName), 'utf8')].join('\n\n');
}

/** An element that accepts anything a panel does to it at load time. */
function fakeElement() {
    const element = {
        style: {},
        dataset: {},
        children: [],
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        textContent: '',
        innerHTML: '',
        value: '',
        addEventListener() {},
        removeEventListener() {},
        appendChild(child) { this.children.push(child); return child; },
        append() {},
        remove() {},
        setAttribute() {},
        getAttribute: () => null,
        removeAttribute() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        closest: () => null,
        insertAdjacentHTML() {},
        getContext: () => null,
    };
    return element;
}

function runPanel(panel, scriptName, spiedFunctions) {
    const sources = [];
    function FakeEventSource(url) {
        this.url = url;
        sources.push(this);
    }
    const sandbox = {
        document: {
            getElementById: () => fakeElement(),
            createElement: () => fakeElement(),
            createElementNS: () => fakeElement(),
            addEventListener() {},
            querySelector: () => null,
            querySelectorAll: () => [],
            body: fakeElement(),
            head: fakeElement(),
            documentElement: fakeElement(),
        },
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        localStorage: { getItem: () => null, setItem() {} },
        acquireVsCodeApi: () => ({ postMessage() {} }),
        EventSource: FakeEventSource,
        fetch: () => new Promise(() => {}),
        setTimeout: () => 0,
        clearTimeout() {},
        requestAnimationFrame: () => 0,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.addEventListener = () => {};
    const context = vm.createContext(sandbox);
    vm.runInContext(readBundle(panel, scriptName), context, { filename: `${panel}-main.js` });

    // Top-level function declarations are properties of the vm global, and the
    // panel code resolves them at call time, so replacing them records calls.
    const calls = [];
    for (const name of spiedFunctions) {
        assert.equal(typeof sandbox[name], 'function', `${panel}: ${name} should be a global function`);
        sandbox[name] = (...args) => { calls.push([name, ...args]); };
    }
    const historicalPanel = vm.runInContext('historicalPanel', context);
    historicalPanel.handleSseMessage = (message) => { calls.push(['historicalPanel.handleSseMessage', message]); };

    vm.runInContext('initializeSSE()', context);
    assert.equal(sources.length, 1, `${panel}: exactly one EventSource`);
    const source = sources[0];
    assert.equal(source.url, '/events');
    assert.equal(sandbox.analysisSSE, source, `${panel}: the EventSource is kept on window.analysisSSE`);

    const transcript = [];
    const play = (step, action) => {
        calls.length = 0;
        action();
        transcript.push([step, ...JSON.parse(JSON.stringify(calls))]);
    };
    const message = (payload) => source.onmessage({ data: JSON.stringify(payload) });

    play('open', () => source.onopen({}));
    play('connected', () => message({ type: 'connected', fileUri: 'f' }));
    play('analysis-updated', () => message({ type: 'analysis-updated' }));
    play('analysis-updated (nested)', () => message({ data: { type: 'analysis-updated' } }));
    play('dependency-updated', () => message({ type: 'dependency-updated' }));
    play('historical-progress (flat)', () => message({ type: 'historical-progress', phase: 'left' }));
    play('historical-progress (nested)', () => message({ type: 'historical-progress', data: { type: 'historical-progress', phase: 'right' } }));
    play('historical-updated', () => message({ type: 'historical-updated', data: { type: 'historical-updated', id: 7 } }));
    play('heartbeat', () => message({ type: 'heartbeat' }));
    play('unknown', () => message({ type: 'something-else' }));
    play('unparseable', () => source.onmessage({ data: '{not json' }));
    play('error', () => source.onerror({}));
    return transcript;
}

const HISTORICAL_STEPS = [
    ['heartbeat'],
    ['unknown'],
    ['unparseable'],
    ['error', ['showSSEStatus', 'error']],
];

test('directory LivePanel: every SSE message drives the same actions', () => {
    const transcript = runPanel('directory', 'directoryAnalysismain.js', [
        'showSSEStatus', 'flashSSEStatus', 'showUpdateNotification', 'reloadAnalysisData', 'loadDependencySummary',
    ]);
    assert.deepEqual(transcript, [
        ['open', ['showSSEStatus', 'connected']],
        ['connected', ['showSSEStatus', 'connected']],
        ['analysis-updated', ['flashSSEStatus', 'New data received'], ['showUpdateNotification'], ['reloadAnalysisData']],
        ['analysis-updated (nested)', ['flashSSEStatus', 'New data received'], ['showUpdateNotification'], ['reloadAnalysisData']],
        ['dependency-updated', ['flashSSEStatus', 'New data received'], ['loadDependencySummary']],
        ['historical-progress (flat)', ['historicalPanel.handleSseMessage', { type: 'historical-progress', phase: 'left' }]],
        ['historical-progress (nested)', ['historicalPanel.handleSseMessage', { type: 'historical-progress', phase: 'right' }]],
        ['historical-updated', ['flashSSEStatus', 'New data received'], ['historicalPanel.handleSseMessage', { type: 'historical-updated', id: 7 }]],
        ...HISTORICAL_STEPS,
    ]);
});

test('file LivePanel: every SSE message drives the same actions', () => {
    const transcript = runPanel('file', 'fileAnalysismain.js', [
        'showSSEStatus', 'flashSSEStatus', 'loadAnalysisData', 'loadDependencySummary',
    ]);
    assert.deepEqual(transcript, [
        ['open', ['showSSEStatus', 'connected']],
        ['connected', ['showSSEStatus', 'connected']],
        ['analysis-updated', ['flashSSEStatus', 'New data received'], ['loadAnalysisData']],
        ['analysis-updated (nested)', ['flashSSEStatus', 'New data received'], ['loadAnalysisData']],
        ['dependency-updated', ['flashSSEStatus', 'New data received'], ['loadDependencySummary']],
        ['historical-progress (flat)', ['historicalPanel.handleSseMessage', { type: 'historical-progress', phase: 'left' }]],
        ['historical-progress (nested)', ['historicalPanel.handleSseMessage', { type: 'historical-progress', phase: 'right' }]],
        ['historical-updated', ['flashSSEStatus', 'New data received'], ['historicalPanel.handleSseMessage', { type: 'historical-updated', id: 7 }]],
        ...HISTORICAL_STEPS,
    ]);
});

test('a panel whose EventSource constructor throws shows the error state', () => {
    for (const [panel, script] of [['directory', 'directoryAnalysismain.js'], ['file', 'fileAnalysismain.js']]) {
        const statuses = [];
        const sandbox = {
            document: {
                getElementById: () => fakeElement(),
                createElement: () => fakeElement(),
                createElementNS: () => fakeElement(),
                addEventListener() {},
                querySelector: () => null,
                querySelectorAll: () => [],
                body: fakeElement(),
                head: fakeElement(),
                documentElement: fakeElement(),
            },
            console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
            localStorage: { getItem: () => null, setItem() {} },
            acquireVsCodeApi: () => ({ postMessage() {} }),
            EventSource: function EventSource() { throw new Error('blocked'); },
            fetch: () => new Promise(() => {}),
            setTimeout: () => 0,
            clearTimeout() {},
        };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.addEventListener = () => {};
        const context = vm.createContext(sandbox);
        vm.runInContext(readBundle(panel, script), context);
        sandbox.showSSEStatus = (status) => statuses.push(status);
        vm.runInContext('initializeSSE()', context);
        assert.deepEqual(statuses, ['error'], `${panel}: a failed EventSource shows the error state`);
        assert.equal(sandbox.analysisSSE, undefined, `${panel}: nothing is stored on failure`);
    }
});

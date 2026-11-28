/**
 * LivePanel live updates over the live channel (#346), driven end to end in
 * both panels.
 *
 * Each panel is assembled exactly as `LivePanelParser` serves it (the live
 * channel runtime, the shared components under templates/components/livepanel/,
 * sorted, then the panel's own script) and run in a `vm` context with a
 * permissive fake DOM and a fake WebSocket. The test then calls the panel's
 * `initializeLiveUpdates()`, plays every server message type through the
 * socket, and records what the panel
 * DID: which status it showed, which reloads it triggered, what it handed to
 * the historical panel. Console output is diagnostics and is not recorded.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LIVE_CHANNEL_RUNTIME, createFakeWebSocketClass, createTimers, mathWithoutJitter } = require('../helpers/fakeLiveChannel.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const sharedDir = path.join(projectRoot, 'templates', 'components', 'livepanel');
const panelsDir = path.join(projectRoot, 'templates', 'analysis_livePanel');

function readBundle(panel, scriptName) {
    const shared = fs.readdirSync(sharedDir)
        .sort()
        .filter((name) => name.endsWith('.js'))
        .map((name) => fs.readFileSync(path.join(sharedDir, name), 'utf8'));
    return [LIVE_CHANNEL_RUNTIME, ...shared, fs.readFileSync(path.join(panelsDir, panel, scriptName), 'utf8')].join('\n\n');
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
    const timers = createTimers();
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
        WebSocket: createFakeWebSocketClass(sources),
        Math: mathWithoutJitter(),
        location: { protocol: 'http:', host: 'localhost:4000' },
        fetch: () => new Promise(() => {}),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
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
    historicalPanel.handleLiveMessage = (message) => { calls.push(['historicalPanel.handleLiveMessage', message]); };
    historicalPanel.syncStatus = () => { calls.push(['historicalPanel.syncStatus']); };

    vm.runInContext('initializeLiveUpdates()', context);
    assert.equal(sources.length, 1, `${panel}: exactly one WebSocket`);
    assert.equal(sources[0].url, 'ws://localhost:4000/codexr-live');
    assert.equal(typeof sandbox.analysisLiveChannel.close, 'function', `${panel}: the channel is kept on window.analysisLiveChannel`);

    const transcript = [];
    const play = (step, action) => {
        calls.length = 0;
        action();
        transcript.push([step, ...JSON.parse(JSON.stringify(calls))]);
    };
    const socket = () => sources.at(-1);
    const ENVELOPE = new Set(['v', 'channel', 'epoch', 'revision']);
    const strip = (message) => Object.fromEntries(Object.entries(message).filter(([key]) => !ENVELOPE.has(key)));
    // The panels hand the whole envelope to the historical panel; compare the payload.
    historicalPanel.handleLiveMessage = (message) => { calls.push(['historicalPanel.handleLiveMessage', strip(message)]); };

    play('connected', () => socket().greet(0));
    play('analysis-updated', () => socket().receive({ type: 'analysis-updated', revision: 1 }));
    play('dependency-updated', () => socket().receive({ type: 'dependency-updated', revision: 2 }));
    play('historical-progress', () => socket().receive({ type: 'historical-progress', revision: 3, state: 'running' }));
    play('historical-updated', () => socket().receive({ type: 'historical-updated', revision: 4, id: 7 }));
    play('heartbeat', () => socket().receive({ type: 'heartbeat', revision: 4 }));
    play('unknown', () => socket().receive({ type: 'something-else', revision: 4 }));
    play('unparseable', () => socket().receiveRaw('{not json'));
    play('dropped', () => socket().drop());
    // Back with nothing missed: no reloads.
    play('reconnect (nothing missed)', () => { timers.fire(1000); socket().greet(4); });
    // Back after a message was published while offline: everything is re-read
    // (generalises #108 / HIST-13: the historical status is read again).
    play('reconnect (missed updates)', () => { socket().drop(); timers.fire(1000); socket().greet(6); });
    return transcript;
}

function expectedTranscript(reload) {
    return [
        ['connected', ['showLiveStatus', 'connected'], ['showLiveStatus', 'connected']],
        ['analysis-updated', ['flashLiveStatus', 'New data received'], ...reload],
        ['dependency-updated', ['flashLiveStatus', 'New data received'], ['loadDependencySummary']],
        ['historical-progress', ['historicalPanel.handleLiveMessage', { state: 'running', type: 'historical-progress' }]],
        ['historical-updated', ['flashLiveStatus', 'New data received'], ['historicalPanel.handleLiveMessage', { id: 7, type: 'historical-updated' }]],
        ['heartbeat'],
        ['unknown'],
        ['unparseable'],
        ['dropped', ['showLiveStatus', 'error']],
        ['reconnect (nothing missed)', ['showLiveStatus', 'connected'], ['showLiveStatus', 'connected']],
        ['reconnect (missed updates)',
            ['showLiveStatus', 'error'],
            ['showLiveStatus', 'connected'], ['showLiveStatus', 'connected'],
            ['flashLiveStatus', 'New data received'], ...reload, ['loadDependencySummary'], ['historicalPanel.syncStatus']],
    ];
}

test('directory LivePanel: every live message drives the same actions', () => {
    const transcript = runPanel('directory', 'directoryAnalysismain.js', [
        'showLiveStatus', 'flashLiveStatus', 'showUpdateNotification', 'reloadAnalysisData', 'loadDependencySummary',
    ]);
    assert.deepEqual(transcript, expectedTranscript([['showUpdateNotification'], ['reloadAnalysisData']]));
});

test('file LivePanel: every live message drives the same actions', () => {
    const transcript = runPanel('file', 'fileAnalysismain.js', [
        'showLiveStatus', 'flashLiveStatus', 'loadAnalysisData', 'loadDependencySummary',
    ]);
    assert.deepEqual(transcript, expectedTranscript([['loadAnalysisData']]));
});

test('a panel without the live channel runtime shows the error state', () => {
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
            fetch: () => new Promise(() => {}),
            setTimeout: () => 0,
            clearTimeout() {},
        };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.addEventListener = () => {};
        const context = vm.createContext(sandbox);
        vm.runInContext(readBundle(panel, script), context);
        // The panel may already have connected at load (no readyState in the fake DOM).
        sandbox.CodeXRLiveChannel = undefined;
        sandbox.analysisLiveChannel = undefined;
        sandbox.showLiveStatus = (status) => statuses.push(status);
        vm.runInContext('initializeLiveUpdates()', context);
        assert.deepEqual(statuses, ['error'], `${panel}: a missing runtime shows the error state`);
        assert.equal(sandbox.analysisLiveChannel, undefined, `${panel}: nothing is stored on failure`);
    }
});

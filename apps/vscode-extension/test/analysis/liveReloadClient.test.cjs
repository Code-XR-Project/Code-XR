const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// XR epic, story S2 (audit CHARTS-10, CHARTS-11, LIFECYCLE-10): the live
// reload clients injected into every generated XR and DOM scene.

const projectRoot = path.resolve(__dirname, '..', '..');
const { LIVE_CHANNEL_RUNTIME, createFakeWebSocketClass, createTimers, mathWithoutJitter } = require('../helpers/fakeLiveChannel.cjs');
// What the generated main.js holds: the shared runtime, then the page script (liveReloadScripts.ts).
const xrSource = `${LIVE_CHANNEL_RUNTIME}\n\n${fs.readFileSync(path.join(projectRoot, 'templates', 'xr', 'live', 'liveReloadXR.js'), 'utf8')}`;
const domSource = `${LIVE_CHANNEL_RUNTIME}\n\n${fs.readFileSync(path.join(projectRoot, 'templates', 'xr', 'live', 'liveReloadDOM.js'), 'utf8')}`;
const WATCHDOG_MS = 45000;

function createDataEntity(id, value) {
    const entity = {
        id,
        value,
        emitted: [],
        getAttribute(name) {
            return name === 'babia-queryjson' ? entity.value : null;
        },
        setAttribute(name, next) {
            if (name === 'babia-queryjson') {
                entity.value = next;
            }
        },
        emit(name) {
            entity.emitted.push(name);
        },
    };
    return entity;
}

function loadXrClient({ dataEntities = [], offlineExport = false } = {}) {
    const sources = [];
    const timers = createTimers();
    const statuses = [];
    const context = {
        console: { log() {}, warn() {}, error() {} },
        URLSearchParams,
        Math: mathWithoutJitter(),
        location: { protocol: 'http:', host: 'localhost:3000' },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        fetch: () => Promise.resolve({ ok: false }),
        CustomEvent: class CustomEvent {
            constructor(type, init) {
                this.type = type;
                this.detail = init && init.detail;
            }
        },
        document: {
            getElementById(id) {
                if (id === 'codexr-tooling-config-virtual-screen') {
                    return { textContent: JSON.stringify({ offlineExport }) };
                }
                return null;
            },
            querySelector() {
                return { tagName: 'A-SCENE' };
            },
            querySelectorAll(selector) {
                return selector === '[babia-queryjson]' ? dataEntities : [];
            },
            addEventListener() {},
            dispatchEvent(event) {
                if (event.type === 'codexr-live-reload-status') {
                    statuses.push(event.detail.status);
                }
            },
        },
    };
    context.WebSocket = createFakeWebSocketClass(sources);
    context.window = context;
    vm.runInNewContext(xrSource, context, { filename: 'main.js' });
    return { context, sources, timers, statuses };
}

test('XR live reload: one WebSocket to /codexr-live on the page origin; a dropped one is reopened with every handler bound', () => {
    const data = createDataEntity('data', { url: './data.json' });
    const { sources, timers, statuses } = loadXrClient({ dataEntities: [data] });
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, 'ws://localhost:3000/codexr-live');
    sources[0].greet(0);

    sources[0].drop();
    assert.equal(sources.length, 1, 'no reconnect before the back-off delay');
    assert.equal(timers.live(1000).length, 1);
    timers.fire(1000);

    assert.equal(sources.length, 2);
    sources[1].greet(0);
    sources[1].receive({ type: 'dataRefresh' });
    assert.match(data.value.url, /^\.\/data\.json\?t=\d+$/, 'the reconnected socket still refreshes the data');
    assert.deepEqual(statuses.slice(0, 4), ['connecting', 'open', 'reconnecting', 'open']);
});

test('XR live reload: back-off doubles up to its cap and a greeting resets it', () => {
    const { sources, timers } = loadXrClient();
    const delays = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
        sources.at(-1).drop();
        const [timer] = timers.live().filter((candidate) => candidate.ms !== WATCHDOG_MS);
        delays.push(timer.ms);
        timers.fire(timer.ms);
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    sources.at(-1).greet(0);
    sources.at(-1).drop();
    assert.equal(timers.live(1000).length, 1, 'a successful connection resets the back-off');
});

test('XR live reload: events from a replaced connection are ignored', () => {
    const { sources, timers } = loadXrClient();
    const first = sources[0];
    first.drop();
    timers.fire(1000);
    first.drop();
    assert.equal(timers.live().filter((timer) => timer.ms !== WATCHDOG_MS).length, 0);
});

test('XR live reload: a reconnect that missed an update refreshes the data once (resync)', () => {
    const data = createDataEntity('data', { url: './data.json' });
    const { sources, timers } = loadXrClient({ dataEntities: [data] });
    sources[0].greet(4);
    sources[0].drop();
    timers.fire(1000);
    sources[1].greet(4);
    assert.equal(data.value.url, './data.json', 'nothing missed: no refresh');
    sources[1].drop();
    timers.fire(1000);
    sources[2].greet(5);
    assert.match(data.value.url, /^\.\/data\.json\?t=\d+$/, 'one update was published while offline');
});

test('XR live reload: cache busting keeps query parameters and skips sources without a url', () => {
    const plain = createDataEntity('data', { url: './data.json', from: '' });
    const revision = createDataEntity('compareRight', { url: './comparison/revision-2/data.json?revision=abc' });
    const slice = createDataEntity('codexrChartDataSlice__data', { url: '', data: '[]' });
    const inline = createDataEntity('inline', { url: '', data: '[1]' });
    const raw = createDataEntity('raw', 'url: ./tree.json; path: x');
    const poisoned = createDataEntity('poisoned', { url: 'url: url: ./data.json?codexrModeRevision=1' });
    const { sources, timers } = loadXrClient({ dataEntities: [plain, revision, slice, inline, raw, poisoned] });
    sources[0].greet(0);
    sources[0].receive({ type: 'analysis-updated' });
    timers.runAll([WATCHDOG_MS]);

    assert.match(plain.value.url, /^\.\/data\.json\?t=\d+$/);
    assert.equal(plain.value.from, '');
    assert.match(revision.value.url, /^\.\/comparison\/revision-2\/data\.json\?revision=abc&t=\d+$/);
    assert.deepEqual(slice.value, { url: '', data: '[]' });
    assert.deepEqual(inline.value, { url: '', data: '[1]' });
    assert.match(raw.value, /^url: \.\/tree\.json\?t=\d+; path: x$/);
    assert.match(poisoned.value.url, /^\.\/data\.json\?codexrModeRevision=1&t=\d+$/);
    assert.deepEqual(plain.emitted, ['data-loaded']);
    assert.deepEqual(slice.emitted, []);
});

test('XR live reload: a remap made after the update arrived is not reverted (CHARTS-12)', () => {
    const data = createDataEntity('data', { url: './data.json' });
    const { context, sources, timers } = loadXrClient({ dataEntities: [data] });
    const restored = [];
    let current = { chartId: 'bars', lastKnownGoodMapping: { x_axis: 'fileName', height: 'totalLines' } };
    let pending = false;
    context.CodeXRMappingUiRuntime = {
        getState: () => JSON.parse(JSON.stringify(current)),
        hasPendingMapping: () => pending,
        restoreState: (snapshot) => restored.push(snapshot),
    };
    sources[0].greet(0);
    sources[0].receive({ type: 'analysis-updated' });
    // The visitor remaps while the charts rebuild.
    current = { chartId: 'bars', lastKnownGoodMapping: { x_axis: 'fileName', height: 'functionCount' } };
    timers.runAll([WATCHDOG_MS]);
    assert.ok(restored.length >= 1);
    for (const snapshot of restored) {
        assert.equal(snapshot.lastKnownGoodMapping.height, 'functionCount', 'the mapping on screen now is the one kept');
    }

    // A remap still being validated is left alone entirely.
    restored.length = 0;
    pending = true;
    sources[0].receive({ type: 'analysis-updated' });
    timers.runAll([WATCHDOG_MS]);
    assert.deepEqual(restored, []);
});

test('XR live reload: an offline export never opens a connection', () => {
    const { sources, statuses } = loadXrClient({ offlineExport: true });
    assert.equal(sources.length, 0);
    assert.deepEqual(statuses, ['disabled']);
});

function loadDomClient({ htmlEntity = null } = {}) {
    const sources = [];
    const timers = createTimers();
    const reloads = [];
    const context = {
        console: { log() {}, warn() {}, error() {} },
        Math: mathWithoutJitter(),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        requestAnimationFrame: (fn) => fn(),
        location: { protocol: 'https:', host: 'abc.trycloudflare.com', reload: () => reloads.push(Date.now()) },
        document: {
            querySelector(selector) { return selector === '#htmlDOM' ? htmlEntity : null; },
            addEventListener() {},
        },
    };
    context.WebSocket = createFakeWebSocketClass(sources);
    context.window = context;
    vm.runInNewContext(domSource, context, { filename: 'main.js' });
    return { sources, timers, reloads };
}

test('DOM live reload: wss behind HTTPS; drops never reload in a loop; one reload when a reconnect missed an update', () => {
    const { sources, timers, reloads } = loadDomClient();
    assert.equal(sources[0].url, 'wss://abc.trycloudflare.com/codexr-live');
    sources[0].greet(2);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        sources.at(-1).drop();
        timers.runAll([WATCHDOG_MS]);
    }
    assert.equal(reloads.length, 0, 'no reload while the server is unreachable');
    assert.equal(sources.length, 6);
    sources.at(-1).greet(3);
    assert.equal(reloads.length, 1, 'reload once to pick up the update missed while disconnected');
});

test('DOM live reload: a reconnect that missed nothing does not reload; HTML updates still apply', () => {
    const attributes = [];
    const htmlEntity = {
        getAttribute: () => ({ distanceLevels: 0.5 }),
        removeAttribute() {},
        setAttribute: (name, value) => attributes.push([name, value]),
    };
    const { sources, timers, reloads } = loadDomClient({ htmlEntity });
    sources[0].greet(1);
    sources[0].drop();
    timers.fire(1000);
    sources[1].greet(1);
    assert.equal(reloads.length, 0);
    sources[1].receive({ type: 'htmlUpdated', action: 'reload-html', htmlContent: '<p>new</p>' });
    assert.deepEqual(JSON.parse(JSON.stringify(attributes)), [['babia-html', { renderHTML: true, renderHTMLOnlyLeafs: true, html: '<p>new</p>', distanceLevels: 0.5 }]]);
});

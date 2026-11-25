const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// XR epic, story S2 (audit CHARTS-10, CHARTS-11, LIFECYCLE-10): the live
// reload clients injected into every generated XR and DOM scene.

const projectRoot = path.resolve(__dirname, '..', '..');
const xrSource = fs.readFileSync(path.join(projectRoot, 'templates', 'xr', 'sse', 'live_sse_fileXR.js'), 'utf8');
const domSource = fs.readFileSync(path.join(projectRoot, 'templates', 'xr', 'sse', 'live_sse_fileDOM.js'), 'utf8');

function createEventSourceClass(registry) {
    return class FakeEventSource {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.listeners = {};
            this.closed = false;
            registry.push(this);
        }
        addEventListener(type, handler) {
            (this.listeners[type] = this.listeners[type] || []).push(handler);
        }
        close() {
            this.closed = true;
            this.readyState = 2;
        }
        open() {
            this.readyState = 1;
            this.onopen?.({});
        }
        fail(fatal) {
            this.readyState = fatal ? 2 : 0;
            this.onerror?.({ type: 'error' });
        }
        dispatch(type, data = '{}') {
            const event = { type, data };
            if (type === 'message') {
                this.onmessage?.(event);
            }
            for (const handler of this.listeners[type] || []) {
                handler(event);
            }
        }
    };
}

function createTimers() {
    const pending = [];
    return {
        pending,
        setTimeout(fn, ms) {
            const timer = { fn, ms, cancelled: false };
            pending.push(timer);
            return timer;
        },
        clearTimeout(timer) {
            if (timer) {
                timer.cancelled = true;
            }
        },
        runAll() {
            while (pending.length) {
                const timer = pending.shift();
                if (!timer.cancelled) {
                    timer.fn();
                }
            }
        },
    };
}

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
        EventSource: null,
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
    context.EventSource = createEventSourceClass(sources);
    context.window = context;
    vm.runInNewContext(xrSource, context, { filename: 'live_sse_fileXR.js' });
    return { context, sources, timers, statuses };
}

test('XR live reload: a connection the browser gave up on is reopened with every handler bound', () => {
    const data = createDataEntity('data', { url: './data.json' });
    const { sources, timers, statuses } = loadXrClient({ dataEntities: [data] });
    assert.equal(sources.length, 1);
    sources[0].open();

    sources[0].fail(true);
    assert.equal(sources.length, 1, 'no reconnect before the back-off delay');
    assert.equal(timers.pending.at(-1).ms, 1000);
    timers.runAll();

    assert.equal(sources.length, 2);
    sources[1].open();
    sources[1].dispatch('dataRefresh');
    assert.match(data.value.url, /^\.\/data\.json\?t=\d+$/, 'the reconnected source still refreshes the data');
    assert.deepEqual(statuses.slice(0, 4), ['connecting', 'open', 'reconnecting', 'connecting']);
});

test('XR live reload: the browser\'s own retry is left alone, and back-off doubles up to its cap', () => {
    const { sources, timers } = loadXrClient();
    sources[0].fail(false);
    assert.equal(timers.pending.length, 0, 'a CONNECTING source is retried by the browser itself');
    assert.equal(sources[0].closed, false);

    const delays = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
        sources.at(-1).fail(true);
        delays.push(timers.pending.at(-1).ms);
        timers.runAll();
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    sources.at(-1).open();
    sources.at(-1).fail(true);
    assert.equal(timers.pending.at(-1).ms, 1000, 'a successful connection resets the back-off');
});

test('XR live reload: events from a replaced connection are ignored', () => {
    const { sources, timers } = loadXrClient();
    const first = sources[0];
    first.fail(true);
    timers.runAll();
    first.fail(true);
    assert.equal(timers.pending.length, 0);
});

test('XR live reload: cache busting keeps query parameters and skips sources without a url', () => {
    const plain = createDataEntity('data', { url: './data.json', from: '' });
    const revision = createDataEntity('compareRight', { url: './comparison/revision-2/data.json?revision=abc' });
    const slice = createDataEntity('codexrChartDataSlice__data', { url: '', data: '[]' });
    const inline = createDataEntity('inline', { url: '', data: '[1]' });
    const raw = createDataEntity('raw', 'url: ./tree.json; path: x');
    const poisoned = createDataEntity('poisoned', { url: 'url: url: ./data.json?codexrModeRevision=1' });
    const { sources, timers } = loadXrClient({ dataEntities: [plain, revision, slice, inline, raw, poisoned] });
    sources[0].open();
    sources[0].dispatch('analysis-updated');
    timers.runAll();

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
    sources[0].open();
    sources[0].dispatch('analysis-updated');
    // The visitor remaps while the charts rebuild.
    current = { chartId: 'bars', lastKnownGoodMapping: { x_axis: 'fileName', height: 'functionCount' } };
    timers.runAll();
    assert.ok(restored.length >= 1);
    for (const snapshot of restored) {
        assert.equal(snapshot.lastKnownGoodMapping.height, 'functionCount', 'the mapping on screen now is the one kept');
    }

    // A remap still being validated is left alone entirely.
    restored.length = 0;
    pending = true;
    sources[0].dispatch('analysis-updated');
    timers.runAll();
    assert.deepEqual(restored, []);
});

test('XR live reload: an offline export never opens a connection', () => {
    const { sources, statuses } = loadXrClient({ offlineExport: true });
    assert.equal(sources.length, 0);
    assert.deepEqual(statuses, ['disabled']);
});

function loadDomClient() {
    const sources = [];
    const timers = createTimers();
    const reloads = [];
    const context = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        requestAnimationFrame: (fn) => fn(),
        location: { reload: () => reloads.push(Date.now()) },
        document: {
            querySelector() { return null; },
            addEventListener() {},
        },
    };
    context.EventSource = createEventSourceClass(sources);
    context.window = context;
    vm.runInNewContext(domSource, context, { filename: 'live_sse_fileDOM.js' });
    return { sources, timers, reloads };
}

test('DOM live reload: errors never reload the page in a loop; one reload once the server is back', () => {
    const { sources, timers, reloads } = loadDomClient();
    sources[0].open();
    for (let attempt = 0; attempt < 5; attempt += 1) {
        sources.at(-1).fail(true);
        timers.runAll();
    }
    assert.equal(reloads.length, 0, 'no reload while the server is unreachable');
    assert.equal(sources.length, 6);
    sources.at(-1).open();
    assert.equal(reloads.length, 1, 'reload once to pick up updates missed while disconnected');
});

test('DOM live reload: a reconnected source still applies HTML updates', () => {
    const { sources, timers } = loadDomClient();
    sources[0].fail(true);
    timers.runAll();
    assert.equal(sources[1].listeners.message.length, 1);
});

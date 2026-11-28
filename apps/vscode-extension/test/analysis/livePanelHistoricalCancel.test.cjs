/**
 * #108 (HIST-7, HIST-13): a historical comparison can be cancelled from the
 * LivePanel, leaving History cancels a comparison with no result yet, and the
 * panel reads the job status on load and after a live-channel resync.
 *
 * Executed, not grepped: the compiled service methods over a real JobRunner,
 * the compiled bridge behind a real HTTP server, the compiled feature host,
 * and the shared LivePanel client inside a `vm` with a fake DOM.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

function readProjectFile(...segments) {
    return fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The real HistoricalComparisonService methods over a real JobRunner; only
 * the Git/Python work (`executeComparison`) is replaced by a controllable
 * promise per call.
 */
function createService({ HistoricalComparisonService }, { JobRunner }) {
    const service = Object.create(HistoricalComparisonService.prototype);
    service.jobs = new JobRunner({
        busyCode: 'comparison-busy',
        cancelledCode: 'comparison-cancelled',
        timeoutCode: 'comparison-timeout',
        timeoutMs: 0,
        graceMs: 50,
    });
    service.revision = 0;
    service.lastResultRevision = null;
    service.refreshJobId = null;
    service.liveRefreshSuspended = false;
    service.pending = [];
    service.executeComparison = (request) => new Promise((resolve, reject) => {
        service.pending.push({
            request,
            finish: () => {
                service.revision += 1;
                resolve({ revision: service.revision, request });
            },
            fail: (error) => reject(error),
        });
    });
    return service;
}

async function withModules(body) {
    await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
        // Shared instances: loaded before the modules that import them.
        const coordinatorModule = requireOut('core/analysis/refresh/analysisRefreshCoordinator.js');
        const jobRunner = requireOut('core/analysis/launch/jobRunner.js');
        const statusModule = requireOut('core/history/historicalComparisonStatus.js');
        const serviceModule = requireOut('core/history/historicalComparisonService.js');
        const { HistoricalComparisonBridge } = requireOut('core/server/analysis/historicalComparisonBridge.js');
        const { AnalysisFeatureHost } = requireOut('core/server/analysis/analysisFeatureHost.js');
        await body({
            coordinator: coordinatorModule.analysisRefreshCoordinator,
            jobRunner,
            statusModule,
            HistoricalComparisonBridge,
            AnalysisFeatureHost,
            newService: () => createService(serviceModule, jobRunner),
        });
    });
}

test('#108 status: idle, running, done with its revision, idle after a cancel, error after a failure', async () => {
    await withModules(async ({ newService, jobRunner }) => {
        const service = newService();
        assert.deepEqual(service.getComparisonStatus(), { state: 'idle', jobId: null, revision: null, message: null });

        const first = service.compare({ leftSourceId: 'working-copy', rightSourceId: 'main' });
        await wait(0);
        const running = service.getComparisonStatus();
        assert.equal(running.state, 'running');
        assert.match(running.jobId, /^job-/);
        service.pending.shift().finish();
        await first;
        assert.deepEqual(service.getComparisonStatus(), { state: 'done', jobId: running.jobId, revision: 1, message: null });

        // A cancelled job leaves the previous result as the one to show.
        const second = service.compare({ leftSourceId: 'working-copy', rightSourceId: 'v1' });
        await wait(0);
        assert.equal(service.cancelComparison(), true);
        await assert.rejects(second, (error) => error instanceof jobRunner.JobCancelledError && error.reason === 'cancelled');
        const afterCancel = service.getComparisonStatus();
        assert.equal(afterCancel.state, 'idle');
        assert.equal(afterCancel.revision, 1);

        await wait(80); // the grace period frees the slot of the never-settling work
        const third = service.compare({ leftSourceId: 'working-copy', rightSourceId: 'v2' });
        await wait(0);
        service.pending.at(-1).fail(new Error('unknown-comparison-source'));
        await assert.rejects(third);
        const failed = service.getComparisonStatus();
        assert.equal(failed.state, 'error');
        assert.match(failed.message, /no longer exists in the repository/);
        assert.equal(failed.revision, 1);
    });
});

test('#108 a timed-out job reports error, not idle', async () => {
    await withModules(async ({ newService, statusModule }) => {
        const service = newService();
        const job = service.compare({ leftSourceId: 'working-copy', rightSourceId: 'main' });
        await wait(0);
        service.jobs.cancel('timeout');
        await assert.rejects(job);
        assert.deepEqual(service.getComparisonStatus().state, 'error');
        assert.equal(service.getComparisonStatus().message, statusModule.HISTORICAL_COMPARISON_TIMEOUT_MESSAGE);
    });
});

test('#108 leaving History cancels a new pick but lets the live refresh of the result on screen finish', async () => {
    await withModules(async ({ newService }) => {
        const service = newService();
        assert.equal(service.cancelComparisonWithoutResult(), false, 'nothing running');

        const first = service.compare({ leftSourceId: 'working-copy', rightSourceId: 'main' });
        await wait(0);
        service.pending.shift().finish();
        await first;

        // The live refresh repeats the request already on screen.
        const refresh = service.refreshActiveComparison();
        await wait(0);
        assert.equal(service.isBusy(), true);
        assert.equal(service.cancelComparisonWithoutResult(), false, 'a refresh has a result on screen');
        service.pending.shift().finish();
        assert.equal((await refresh).revision, 2);

        const pick = service.compare({ leftSourceId: 'working-copy', rightSourceId: 'v1' });
        await wait(0);
        assert.equal(service.cancelComparisonWithoutResult(), true, 'a new pick has no result yet');
        await assert.rejects(pick, /comparison-cancelled/);
    });
});

/** A real HTTP server routing the LivePanel endpoints to the compiled bridge, as HttpServer does. */
async function withLivePanelServer(service, body) {
    await withModules(async (modules) => {
        const live = [];
        const host = {
            sessionId: 'sess-108',
            historicalComparisonService: service || modules.newService(),
            notifyLivePanelHistoricalProgress: (progress) => live.push(['progress', progress]),
            notifyLivePanelHistoricalUpdated: (revision) => live.push(['updated', revision]),
        };
        const bridge = new modules.HistoricalComparisonBridge(host);
        const routes = {
            '/api/historical/compare': (req, res) => bridge.handleHistoricalCompare(req, res),
            '/api/historical/cancel': (req, res) => bridge.handleHistoricalCancel(req, res),
            '/api/historical/status': (req, res) => bridge.handleHistoricalStatus(req, res),
        };
        const server = http.createServer((req, res) => {
            void routes[req.url](req, res);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const call = async (route, method, payload) => {
            const response = await fetch(base + route, {
                method,
                headers: payload ? { 'content-type': 'application/json' } : undefined,
                body: payload ? JSON.stringify(payload) : undefined,
            });
            return { status: response.status, body: await response.json() };
        };
        try {
            await body({ call, live, service: host.historicalComparisonService });
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
}

test('#108 LivePanel Cancel uses the same service cancel as XR, frees the slot and tells the panel over the live channel', async () => {
    await withLivePanelServer(null, async ({ call, live, service }) => {
        const started = await call('/api/historical/compare', 'POST', { leftSourceId: 'working-copy', rightSourceId: 'main' });
        assert.equal(started.status, 202);
        const jobId = started.body.jobId;
        await wait(10);
        assert.equal((await call('/api/historical/status', 'GET')).body.state, 'running');
        assert.equal((await call('/api/historical/compare', 'POST', { leftSourceId: 'working-copy', rightSourceId: 'v1' })).status, 409);

        // A stale job id (another page's job) does not stop this one.
        assert.deepEqual((await call('/api/historical/cancel', 'POST', { jobId: 'job-other' })).body, { cancelled: false, jobId });
        assert.equal(service.isBusy(), true);

        assert.deepEqual((await call('/api/historical/cancel', 'POST', { jobId })).body, { cancelled: true, jobId });
        await wait(10);
        assert.deepEqual(live.at(-1), ['progress', { state: 'cancelled', message: 'Historical comparison cancelled.', jobId }]);
        assert.equal((await call('/api/historical/status', 'GET')).body.state, 'idle');

        // The slot is free again (after the 50 ms grace of a work that ignores the signal).
        await wait(80);
        const next = await call('/api/historical/compare', 'POST', { leftSourceId: 'working-copy', rightSourceId: 'v1' });
        assert.equal(next.status, 202);
        await wait(10);
        service.pending.at(-1).finish();
        await wait(10);
        assert.deepEqual(live.at(-1), ['updated', 1]);
        assert.deepEqual((await call('/api/historical/status', 'GET')).body, { state: 'done', jobId: next.body.jobId, revision: 1, message: null });
        assert.deepEqual((await call('/api/historical/cancel', 'POST', {})).body, { cancelled: false, jobId: next.body.jobId });
        assert.equal((await call('/api/historical/status', 'GET')).status, 200);
    });
});

test('#108 the status and cancel routes are wired in HttpServer and refuse wrong methods', async () => {
    const routing = readProjectFile('src', 'core', 'server', 'httpServer.ts');
    assert.match(routing, /case '\/historical\/cancel':\s*await this\.historicalBridge\.handleHistoricalCancel\(req, res\);/);
    assert.match(routing, /case '\/historical\/status':\s*this\.historicalBridge\.handleHistoricalStatus\(req, res\);/);
    await withLivePanelServer(null, async ({ call }) => {
        assert.equal((await call('/api/historical/cancel', 'GET')).status, 405);
        assert.equal((await call('/api/historical/status', 'POST', {})).status, 405);
    });
});

test('#108 leaving History in the room cancels a comparison with no result yet and tells the room', async () => {
    await withModules(async ({ AnalysisFeatureHost, coordinator, newService }) => {
        const messages = [];
        const config = {};
        const host = new AnalysisFeatureHost(config, {
            getRoom: () => ({ broadcastServerMessage: (roomId, message) => messages.push(message), upsertServerEntity() {} }),
            getRoomId: () => 'room',
        });
        const sessionId = `s108-${Math.random()}`;
        config.analysisSessionId = sessionId;
        const service = newService();
        host.historicalComparisonService = service;
        try {
            host.handleHistoricalViewChanged(coordinator.changeActiveMode(sessionId, 'historical-compare'));
            const pick = service.compare({ leftSourceId: 'working-copy', rightSourceId: 'main' });
            await wait(0);
            const jobId = service.getJobStatus().id;
            host.handleHistoricalViewChanged(coordinator.changeActiveMode(sessionId, 'single'));
            await assert.rejects(pick, /comparison-cancelled/);
            assert.deepEqual(messages, [{
                type: 'historical-comparison-cancelled',
                payload: { message: 'Historical comparison cancelled. You left History.', jobId },
            }]);

            // A mode change that does not leave History cancels nothing.
            await wait(80);
            const other = service.compare({ leftSourceId: 'working-copy', rightSourceId: 'v1' });
            await wait(0);
            host.handleHistoricalViewChanged(coordinator.changeActiveMode(sessionId, 'dependency-graph'));
            assert.equal(service.isBusy(), true);
            service.pending.at(-1).finish();
            await other;
            assert.equal(messages.length, 1);
        } finally {
            host.historicalComparisonService = null;
            coordinator.disposeSession(sessionId);
        }
    });
    // The host subscribes the handler to the coordinator for every session with a comparison.
    const source = readProjectFile('src', 'core', 'server', 'analysis', 'analysisFeatureHost.ts');
    assert.match(source, /analysisRefreshCoordinator\.onStateChanged\(sessionId, \(view\) => this\.handleHistoricalViewChanged\(view\)\)/);
});

test('#108 a cancelled live refresh is not retried as a failure', async () => {
    await withModules(async ({ AnalysisFeatureHost, coordinator, jobRunner }) => {
        const config = {};
        const host = new AnalysisFeatureHost(config, { getRoom: () => null, getRoomId: () => 'room' });
        const sessionId = `s108-refresh-${Math.random()}`;
        config.analysisSessionId = sessionId;
        coordinator.changeActiveMode(sessionId, 'historical-compare');
        const live = [];
        host.notifyLivePanelHistoricalProgress = (progress) => live.push(progress);
        let calls = 0;
        host.historicalComparisonService = {
            hasLiveSource: () => true,
            isBusy: () => false,
            refreshActiveComparison: async () => {
                calls += 1;
                throw new jobRunner.JobCancelledError('cancelled', 'comparison-cancelled');
            },
        };
        try {
            host.scheduleHistoricalComparisonRefresh(0);
            await wait(1200);
            assert.equal(calls, 1);
            assert.deepEqual(live, [{ state: 'cancelled', message: 'Historical comparison cancelled.' }]);
        } finally {
            clearTimeout(host.historicalRefreshTimer);
            host.historicalComparisonService = null;
            coordinator.disposeSession(sessionId);
        }
    });
});

// ── The shared LivePanel client ───────────────────────────────────────────

function createElement(id) {
    const classes = new Set();
    const listeners = {};
    return {
        id,
        textContent: '',
        disabled: false,
        value: '',
        dataset: {},
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            contains: (name) => classes.has(name),
            toggle: (name, force) => {
                const on = force === undefined ? !classes.has(name) : !!force;
                if (on) { classes.add(name); } else { classes.delete(name); }
                return on;
            },
        },
        listeners,
        addEventListener: (type, handler) => { listeners[type] = handler; },
        appendChild() {},
    };
}

/** historicalPanel.js in a vm, with a scripted fetch and a recording sendBeacon. */
function loadPanel(routes) {
    const elements = new Map();
    const getElementById = (id) => {
        if (!elements.has(id)) {
            elements.set(id, createElement(id));
        }
        return elements.get(id);
    };
    getElementById('historical-cancel-btn').classList.add('hidden');
    const requests = [];
    const beacons = [];
    const windowListeners = {};
    const sandbox = {
        document: { getElementById, createElement: () => createElement('created') },
        console: { log() {}, warn() {}, error() {} },
        navigator: { sendBeacon: (url, blob) => { beacons.push([url, blob]); return true; } },
        Blob: class { constructor(parts, options) { this.text = parts.join(''); this.type = options.type; } },
        fetch: (url, init = {}) => {
            requests.push([url, init.method || 'GET', init.body ? JSON.parse(init.body) : null]);
            const route = Object.keys(routes).find((prefix) => url.startsWith(prefix));
            const reply = route ? routes[route](init) : { status: 404, body: {} };
            return Promise.resolve({
                ok: reply.status >= 200 && reply.status < 300,
                status: reply.status,
                json: () => Promise.resolve(reply.body),
            });
        },
        addEventListener: (type, handler) => { windowListeners[type] = handler; },
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(`${readProjectFile('templates', 'components', 'livepanel', 'historicalPanel.js')}\nthis.panel = new CodexrHistoricalPanel();`, context);
    return { panel: sandbox.panel, el: getElementById, requests, beacons, windowListeners };
}

const flush = async () => {
    for (let index = 0; index < 10; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

const REFERENCES = {
    status: 200,
    body: { enabled: true, references: { sources: [{ id: 'working-copy', label: 'Working copy' }, { id: 'main', label: 'main' }] } },
};

test('#108 panel: Cancel shows only while comparing, posts the job id, and the live cancel releases the buttons', async () => {
    const env = loadPanel({
        '/api/historical/references': () => REFERENCES,
        '/api/historical/status': () => ({ status: 200, body: { state: 'idle', jobId: null, revision: null, message: null } }),
        '/api/historical/compare': () => ({ status: 202, body: { accepted: true, jobId: 'job-1' } }),
        '/api/historical/cancel': () => ({ status: 200, body: { cancelled: true, jobId: 'job-1' } }),
    });
    await env.panel.initialize();
    assert.equal(env.el('historical-cancel-btn').classList.contains('hidden'), true);

    await env.panel.compare();
    assert.equal(env.panel.jobId, 'job-1');
    assert.equal(env.el('historical-cancel-btn').classList.contains('hidden'), false);
    assert.equal(env.el('historical-compare-btn').textContent, 'Comparing...');

    // The button is bound by initialize(); clicking it posts the job id.
    env.el('historical-cancel-btn').listeners.click();
    await flush();
    assert.deepEqual(env.requests.at(-1), ['/api/historical/cancel', 'POST', { jobId: 'job-1' }]);
    assert.equal(env.el('historical-status').textContent, 'Cancelling comparison...');

    assert.equal(env.panel.handleLiveMessage({ type: 'historical-progress', state: 'cancelled', message: 'Historical comparison cancelled.' }), true);
    assert.equal(env.el('historical-compare-btn').disabled, false);
    assert.equal(env.el('historical-cancel-btn').classList.contains('hidden'), true);
    assert.equal(env.el('historical-status').textContent, 'Historical comparison cancelled.');
    assert.equal(env.el('historical-status').classList.contains('error'), false);
    assert.equal(env.panel.jobId, null);
});

test('#108 panel: closing the page cancels its own unfinished job by id, and nothing when idle', async () => {
    const env = loadPanel({
        '/api/historical/references': () => REFERENCES,
        '/api/historical/status': () => ({ status: 200, body: { state: 'idle', jobId: null, revision: null, message: null } }),
        '/api/historical/compare': () => ({ status: 202, body: { accepted: true, jobId: 'job-7' } }),
    });
    await env.panel.initialize();
    assert.equal(typeof env.windowListeners.pagehide, 'function');
    env.windowListeners.pagehide();
    assert.deepEqual(env.beacons, []);

    await env.panel.compare();
    env.windowListeners.pagehide();
    assert.equal(env.beacons.length, 1);
    assert.equal(env.beacons[0][0], '/api/historical/cancel');
    assert.deepEqual(JSON.parse(env.beacons[0][1].text), { jobId: 'job-7' });
});

test('#108 panel: status on load picks up a running job, then a reconnect read loads the missed result', async () => {
    let status = { state: 'running', jobId: 'job-9', revision: null, message: null };
    const env = loadPanel({
        '/api/historical/references': () => REFERENCES,
        '/api/historical/status': () => ({ status: 200, body: status }),
        './comparison/revision-3.json': () => ({
            status: 200,
            body: { left: { url: 'l.json', source: { label: 'Working copy' } }, right: { url: 'r.json', source: { label: 'main' } } },
        }),
        'l.json': () => ({ status: 200, body: [] }),
        'r.json': () => ({ status: 200, body: [] }),
    });
    const rendered = [];
    env.panel.render = (result) => rendered.push(result);
    await env.panel.initialize();
    assert.equal(env.panel.busy, true, 'a job started before the page loaded keeps Compare busy');
    assert.equal(env.panel.jobId, 'job-9');
    assert.equal(env.el('historical-cancel-btn').classList.contains('hidden'), false);

    // The `historical-updated` event was lost while the stream was down.
    status = { state: 'done', jobId: 'job-9', revision: 3, message: null };
    await env.panel.syncStatus();
    await flush();
    assert.equal(env.panel.busy, false);
    assert.equal(rendered.length, 1);
    assert.equal(env.panel.renderedRevision, 3);
    assert.match(env.el('historical-status').textContent, /^Compared Working copy vs main/);

    // Reading the same status again does not reload what is on screen.
    await env.panel.syncStatus();
    await flush();
    assert.equal(rendered.length, 1);

    // An error read after a reconnect releases a busy panel with the sentence.
    env.panel.setBusy(true);
    status = { state: 'error', jobId: 'job-10', revision: 3, message: 'A Git or analysis step took too long and was stopped.' };
    await env.panel.syncStatus();
    assert.equal(env.panel.busy, false);
    assert.equal(env.el('historical-status').textContent, 'A Git or analysis step took too long and was stopped.');
    assert.equal(env.el('historical-status').classList.contains('error'), true);
});

/**
 * The live channel's server half (epic #341, WS1 #342 / WS2 #343): the pure
 * protocol, the hub's fan-out, revision/epoch, heartbeat and cleanup, and the
 * /codexr-live endpoint end to end over a real `ws` client.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { WebSocket } = require('ws');

const projectRoot = path.resolve(__dirname, '..', '..');
const out = (...parts) => require(path.join(projectRoot, 'out', 'core', 'server', 'live', ...parts));
const protocol = out('liveChannelProtocol.js');
const { LiveChannelHub } = out('liveChannelHub.js');
const { attachLiveChannelEndpoint } = out('liveChannelEndpoint.js');

class FakeSocket {
    constructor() {
        this.readyState = 1;
        this.sent = [];
        this.pings = 0;
        this.terminated = false;
        this.closedWith = null;
        this.listeners = {};
    }
    on(event, listener) { (this.listeners[event] = this.listeners[event] || []).push(listener); }
    emit(event, ...args) { for (const listener of this.listeners[event] || []) { listener(...args); } }
    send(data) { this.sent.push(JSON.parse(data)); }
    ping() { this.pings += 1; }
    terminate() { this.terminated = true; this.readyState = 3; this.emit('close'); }
    close(code, reason) { this.closedWith = [code, reason]; this.readyState = 3; this.emit('close'); }
    types() { return this.sent.map((message) => message.type); }
}

function manualTimers() {
    const timers = { started: 0, stopped: 0, callback: null };
    return {
        timers,
        options: {
            setInterval: (callback) => { timers.started += 1; timers.callback = callback; return {}; },
            clearInterval: () => { timers.stopped += 1; timers.callback = null; },
        },
    };
}

test('protocol: envelope fields win over the payload and every message type is known', () => {
    const message = JSON.parse(protocol.encodeLiveMessage({
        type: 'historical-progress', channel: 's1', revision: 3, epoch: 'e', now: new Date(0),
        payload: { state: 'running', type: 'spoofed', revision: 99 },
    }));
    assert.deepEqual(message, {
        state: 'running', v: 1, type: 'historical-progress', channel: 's1', revision: 3, epoch: 'e', timestamp: '1970-01-01T00:00:00.000Z',
    });
    assert.equal(protocol.isLiveMessageType('dataRefresh'), true);
    assert.equal(protocol.isLiveMessageType('reload'), false);
});

test('protocol: back-off doubles from 1 s to a 30 s cap, jitter adds at most 20%', () => {
    const delays = [];
    let delay = 0;
    for (let attempt = 0; attempt < 7; attempt += 1) {
        delay = protocol.nextReconnectDelay(delay, 0);
        delays.push(delay);
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    assert.equal(protocol.nextReconnectDelay(0, 0.999), 1200);
    assert.equal(protocol.nextReconnectDelay(30000, 0.999), 30000);
});

test('protocol: resync only after a missed update or a new server epoch', () => {
    assert.equal(protocol.needsResync(null, { epoch: 'a', revision: 4 }), false, 'the first greeting is not a resync');
    assert.equal(protocol.needsResync({ epoch: 'a', revision: 4 }, { epoch: 'a', revision: 4 }), false);
    assert.equal(protocol.needsResync({ epoch: 'a', revision: 4 }, { epoch: 'a', revision: 5 }), true);
    assert.equal(protocol.needsResync({ epoch: 'a', revision: 4 }, { epoch: 'a', revision: 0 }), true, 'channel reopened');
    assert.equal(protocol.needsResync({ epoch: 'a', revision: 4 }, { epoch: 'b', revision: 4 }), true, 'server restarted');
});

test('protocol: the browser runtime mirrors the server constants and helpers', () => {
    const source = fs.readFileSync(path.join(projectRoot, 'templates', 'components', 'live', 'liveChannel.js'), 'utf8');
    const sandbox = { setTimeout() {}, clearTimeout() {}, console };
    sandbox.window = sandbox;
    vm.runInNewContext(source, sandbox);
    const runtime = sandbox.CodeXRLiveChannel;
    const constants = { ...runtime.constants };
    assert.deepEqual(constants, {
        LIVE_CHANNEL_PATH: protocol.LIVE_CHANNEL_PATH,
        LIVE_HEARTBEAT_INTERVAL_MS: protocol.LIVE_HEARTBEAT_INTERVAL_MS,
        LIVE_CLIENT_SILENCE_TIMEOUT_MS: protocol.LIVE_CLIENT_SILENCE_TIMEOUT_MS,
        LIVE_RECONNECT_MIN_DELAY_MS: protocol.LIVE_RECONNECT_MIN_DELAY_MS,
        LIVE_RECONNECT_MAX_DELAY_MS: protocol.LIVE_RECONNECT_MAX_DELAY_MS,
        LIVE_CLOSE_REMOVED: protocol.LIVE_CLOSE_REMOVED,
    });
    for (const [previous, random] of [[0, 0], [0, 0.5], [1000, 0.3], [16000, 0.9], [30000, 0]]) {
        assert.equal(runtime.nextReconnectDelay(previous, random), protocol.nextReconnectDelay(previous, random));
    }
    for (const [last, greeting] of [[null, { epoch: 'a', revision: 1 }], [{ epoch: 'a', revision: 1 }, { epoch: 'a', revision: 1 }], [{ epoch: 'a', revision: 1 }, { epoch: 'a', revision: 2 }], [{ epoch: 'a', revision: 1 }, { epoch: 'b', revision: 1 }]]) {
        assert.equal(runtime.needsResync(last, greeting), protocol.needsResync(last, greeting));
    }
    assert.equal(runtime.url({ protocol: 'https:', host: 'x.trycloudflare.com' }), 'wss://x.trycloudflare.com/codexr-live');
    assert.equal(runtime.url({ protocol: 'http:', host: 'localhost:3000' }), 'ws://localhost:3000/codexr-live');
});

test('hub: greeting, fan-out per channel and revision counting', () => {
    const { options } = manualTimers();
    const hub = new LiveChannelHub({ ...options, epoch: 'E' });
    hub.publishDataRefresh('s1'); // nobody listening yet: the revision still counts
    const a = new FakeSocket();
    const b = new FakeSocket();
    const other = new FakeSocket();
    hub.attach('s1', a);
    hub.attach('s1', b);
    hub.attach('s2', other);
    assert.deepEqual(a.sent[0], { ...a.sent[0], type: 'connected', channel: 's1', revision: 1, epoch: 'E', v: 1 });
    assert.equal(other.sent[0].revision, 0);

    assert.equal(hub.publishAnalysisUpdated('s1'), 2);
    assert.equal(hub.publish('s1', 'historical-progress', { state: 'running' }), 2);
    assert.deepEqual(a.types(), ['connected', 'analysis-updated', 'historical-progress']);
    assert.deepEqual(other.types(), ['connected']);
    assert.equal(a.sent[1].action, 'reload-data');
    assert.equal(a.sent[2].state, 'running');
    assert.equal(a.sent[2].revision, 3);
    assert.equal(hub.revision('s1'), 3);
    assert.deepEqual(hub.activeChannels().sort(), ['s1', 's2']);
});

test('hub: closed, failing and non-open sockets are dropped', () => {
    const { options } = manualTimers();
    const hub = new LiveChannelHub(options);
    const closing = new FakeSocket();
    const broken = new FakeSocket();
    const healthy = new FakeSocket();
    for (const socket of [closing, broken, healthy]) {
        hub.attach('s1', socket);
    }
    closing.readyState = 2;
    broken.send = () => { throw new Error('EPIPE'); };
    assert.equal(hub.publishDataRefresh('s1'), 1);
    assert.equal(hub.clientCount('s1'), 1);
    healthy.emit('close');
    assert.equal(hub.clientCount('s1'), 0);
});

test('hub: heartbeat pings, sends an observable heartbeat and terminates a socket that missed a pong', () => {
    const { timers, options } = manualTimers();
    const hub = new LiveChannelHub(options);
    const answering = new FakeSocket();
    const silent = new FakeSocket();
    hub.attach('s1', answering);
    hub.attach('s1', silent);
    assert.equal(timers.started, 1, 'the timer starts with the first socket');

    hub.heartbeat();
    assert.equal(answering.pings, 1);
    assert.deepEqual(answering.types(), ['connected', 'heartbeat']);
    answering.emit('pong');
    hub.heartbeat();
    assert.equal(silent.terminated, true, 'no pong since the previous round');
    assert.equal(answering.terminated, false);
    assert.equal(hub.revision('s1'), 0, 'heartbeats never bump the revision');

    answering.emit('close');
    assert.equal(timers.stopped, 1, 'the timer stops with the last socket');
});

test('hub: closeChannel and dispose close every socket with a proper code', () => {
    const { timers, options } = manualTimers();
    const hub = new LiveChannelHub(options);
    const a = new FakeSocket();
    const b = new FakeSocket();
    hub.attach('s1', a);
    hub.attach('s2', b);
    hub.closeChannel('s1');
    assert.deepEqual(a.closedWith, [protocol.LIVE_CLOSE_GOING_AWAY, 'analysis stopped']);
    assert.equal(hub.clientCount('s1'), 0);
    hub.dispose();
    assert.deepEqual(b.closedWith, [protocol.LIVE_CLOSE_NORMAL, 'server shutting down']);
    assert.equal(timers.callback, null);
    assert.deepEqual(hub.activeChannels(), []);
});

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function nextMessage(socket) {
    return new Promise((resolve, reject) => {
        socket.once('message', (data) => resolve(JSON.parse(String(data))));
        socket.once('error', reject);
    });
}

test('endpoint: /codexr-live joins the served channel, refuses unauthorised upgrades, closes with no analysis', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const hub = new LiveChannelHub({ epoch: 'E' });
    let channel = 'session-1';
    let authorized = true;
    const endpoint = attachLiveChannelEndpoint(server, { authorize: () => authorized, resolveChannel: () => channel, hub });
    const port = await listen(server);
    try {
        const client = new WebSocket(`ws://127.0.0.1:${port}/codexr-live`);
        const greeting = await nextMessage(client);
        assert.equal(greeting.type, 'connected');
        assert.equal(greeting.channel, 'session-1');
        const update = nextMessage(client);
        hub.publishDataRefresh('session-1');
        assert.equal((await update).type, 'dataRefresh');

        authorized = false;
        const refused = new WebSocket(`ws://127.0.0.1:${port}/codexr-live`);
        await new Promise((resolve) => refused.once('error', resolve));

        authorized = true;
        channel = null;
        const orphan = new WebSocket(`ws://127.0.0.1:${port}/codexr-live`);
        const code = await new Promise((resolve) => orphan.once('close', (closeCode) => resolve(closeCode)));
        assert.equal(code, protocol.LIVE_CLOSE_NO_ANALYSIS);

        const closed = new Promise((resolve) => client.once('close', resolve));
        endpoint.dispose();
        await closed;
        for (let attempt = 0; attempt < 50 && hub.clientCount('session-1') > 0; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(hub.clientCount('session-1'), 0, 'the hub forgot the terminated socket');
    } finally {
        hub.dispose();
        await new Promise((resolve) => server.close(resolve));
    }
});

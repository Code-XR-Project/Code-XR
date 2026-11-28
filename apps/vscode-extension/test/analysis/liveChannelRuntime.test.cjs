/**
 * The browser live channel runtime (epic #341, WS3 #344), on its own: what it
 * dispatches, the half-open watchdog, resync, close() and the disabled case.
 * Page wiring is covered by liveReloadClient and livePanelLiveChannel.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { LIVE_CHANNEL_RUNTIME, createFakeWebSocketClass, createTimers, mathWithoutJitter } = require('../helpers/fakeLiveChannel.cjs');

const WATCHDOG_MS = 45000;

function loadRuntime() {
    const sockets = [];
    const timers = createTimers();
    const errors = [];
    const context = {
        console: { log() {}, warn() {}, error: (...args) => errors.push(args.join(' ')) },
        Math: mathWithoutJitter(),
        location: { protocol: 'http:', host: 'localhost:3000' },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        WebSocket: createFakeWebSocketClass(sockets),
    };
    context.window = context;
    vm.runInNewContext(LIVE_CHANNEL_RUNTIME, context);
    // Bundled twice (a page that includes two bundles) must not redefine it.
    const first = context.CodeXRLiveChannel;
    vm.runInNewContext(LIVE_CHANNEL_RUNTIME, context);
    assert.equal(context.CodeXRLiveChannel, first);
    return { runtime: context.CodeXRLiveChannel, sockets, timers, errors };
}

function connect(runtime) {
    const log = { messages: [], statuses: [], resyncs: [] };
    const channel = runtime.connect({
        onMessage: (message) => log.messages.push(message.type),
        onStatus: (status) => log.statuses.push(status),
        onResync: (greeting) => log.resyncs.push(greeting.revision),
    });
    return { channel, log };
}

test('runtime: dispatches every message but heartbeats, and survives garbage and throwing handlers', () => {
    const { runtime, sockets, errors } = loadRuntime();
    const { log } = connect(runtime);
    sockets[0].greet(0);
    sockets[0].receive({ type: 'heartbeat' });
    sockets[0].receive({ type: 'analysis-updated', revision: 1 });
    sockets[0].receiveRaw('{not json');
    sockets[0].receiveRaw('{"no":"type"}');
    assert.deepEqual(log.messages, ['connected', 'analysis-updated']);
    assert.deepEqual(log.statuses, ['connecting', 'open']);
    assert.equal(errors.length, 1, 'the unparseable message is reported once');

    const throwing = runtime.connect({ onMessage: () => { throw new Error('boom'); } });
    sockets[1].greet(0);
    assert.equal(errors.length, 2, 'a failing handler is reported, not thrown into the socket');
    throwing.close();
});

test('runtime: a socket silent for three heartbeats is replaced; any message re-arms the watchdog', () => {
    const { runtime, sockets, timers } = loadRuntime();
    const { log } = connect(runtime);
    sockets[0].greet(0);
    assert.equal(timers.live(WATCHDOG_MS).length, 1);
    sockets[0].receive({ type: 'heartbeat' });
    assert.equal(timers.live(WATCHDOG_MS).length, 1, 're-armed, not stacked');

    timers.fire(WATCHDOG_MS);
    assert.equal(sockets[0].closed, true, 'the half-open socket is closed');
    assert.deepEqual(log.statuses.slice(-1), ['reconnecting']);
    sockets[0].drop(); // its late onclose must not schedule a second reconnect
    assert.equal(timers.live(1000).length, 1);
    timers.fire(1000);
    assert.equal(sockets.length, 2);
});

test('runtime: resync runs once per reconnect that missed something, never on the first connect', () => {
    const { runtime, sockets, timers } = loadRuntime();
    const { log } = connect(runtime);
    sockets[0].greet(3);
    assert.deepEqual(log.resyncs, []);
    sockets[0].receive({ type: 'dataRefresh', revision: 4 });
    sockets[0].drop();
    timers.fire(1000);
    sockets[1].greet(4);
    assert.deepEqual(log.resyncs, [], 'the update was received live');
    sockets[1].drop();
    timers.fire(1000);
    sockets[2].greet(6);
    assert.deepEqual(log.resyncs, [6]);
    sockets[2].drop();
    timers.fire(1000);
    sockets[3].greet(0, 'E2');
    assert.deepEqual(log.resyncs, [6, 0], 'a restarted server (new epoch) resyncs too');
});

test('runtime: close() stops everything; disabled never connects', () => {
    const { runtime, sockets, timers } = loadRuntime();
    const { channel, log } = connect(runtime);
    sockets[0].greet(0);
    channel.close();
    assert.equal(sockets[0].closed, true);
    assert.equal(channel.getStatus(), 'disabled');
    sockets[0].drop();
    assert.equal(timers.live().length, 0, 'no reconnect and no watchdog after close()');
    assert.deepEqual(log.statuses, ['connecting', 'open', 'disabled']);

    const statuses = [];
    runtime.connect({ disabled: true, onStatus: (status) => statuses.push(status) });
    assert.equal(sockets.length, 1);
    assert.deepEqual(statuses, ['disabled']);
});

test('runtime: a WebSocket constructor that throws is retried with back-off', () => {
    const { runtime, timers, errors } = loadRuntime();
    let attempts = 0;
    const statuses = [];
    runtime.connect({
        WebSocket: function Blocked() { attempts += 1; throw new Error('blocked'); },
        onStatus: (status) => statuses.push(status),
    });
    assert.equal(attempts, 1);
    assert.equal(errors.length, 1);
    timers.fire(1000);
    assert.equal(attempts, 2);
    assert.equal(timers.live(2000).length, 1);
    assert.deepEqual(statuses, ['connecting', 'reconnecting']);
});

test('runtime: a socket closed with 4001 (removed by the host) never reconnects', () => {
    const { runtime, sockets, timers } = loadRuntime();
    const { channel, log } = connect(runtime);
    sockets[0].greet(0);
    sockets[0].readyState = 3;
    sockets[0].onclose({ code: 4001 });
    assert.equal(timers.live().length, 0, 'no reconnect and no watchdog');
    assert.equal(channel.getStatus(), 'disabled');
    assert.deepEqual(log.statuses.slice(-1), ['disabled']);
    assert.equal(sockets.length, 1);
});

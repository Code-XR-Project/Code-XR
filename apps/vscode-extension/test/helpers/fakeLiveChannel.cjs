/**
 * Test doubles for the browser live channel (templates/components/live/liveChannel.js):
 * a fake WebSocket whose "server" side the test drives, manual timers, and a
 * loader that runs the runtime plus a page script in one vm context, the way
 * the generated `main.js` bundles them.
 */
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const LIVE_CHANNEL_RUNTIME = fs.readFileSync(path.join(projectRoot, 'templates', 'components', 'live', 'liveChannel.js'), 'utf8');

function createFakeWebSocketClass(registry) {
    return class FakeWebSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.closed = false;
            registry.push(this);
        }
        close() {
            this.closed = true;
            this.readyState = 3;
        }
        /** Server side: greet the page (the first message of every socket). */
        greet(revision = 0, epoch = 'E1') {
            this.readyState = 1;
            this.receive({ type: 'connected', revision, epoch });
        }
        /** Server side: one message in the live envelope. */
        receive(message) {
            this.onmessage?.({ data: JSON.stringify({ v: 1, channel: 's1', epoch: 'E1', revision: 0, ...message }) });
        }
        receiveRaw(data) {
            this.onmessage?.({ data });
        }
        /** The connection dropped (server stopped, network lost). */
        drop() {
            this.readyState = 3;
            this.onerror?.({ type: 'error' });
            this.onclose?.({ code: 1006 });
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
        /** Live timers with the given delay. */
        live(ms) {
            return pending.filter((timer) => !timer.cancelled && (ms === undefined || timer.ms === ms));
        },
        /** Fires the first live timer with that delay (and nothing else). */
        fire(ms) {
            const timer = pending.find((candidate) => !candidate.cancelled && candidate.ms === ms);
            if (!timer) {
                throw new Error(`no pending timer of ${ms} ms`);
            }
            timer.cancelled = true;
            timer.fn();
        },
        /** Runs every live timer except the ones with the excluded delays, until none is left. */
        runAll(exclude = []) {
            for (let guard = 0; guard < 1000; guard += 1) {
                const timer = pending.find((candidate) => !candidate.cancelled && !exclude.includes(candidate.ms));
                if (!timer) {
                    return;
                }
                timer.cancelled = true;
                timer.fn();
            }
            throw new Error('runAll: timers keep rescheduling');
        },
    };
}

/** Deterministic Math for the vm context: no jitter. */
function mathWithoutJitter() {
    const math = Object.create(Math);
    math.random = () => 0;
    return math;
}

module.exports = { LIVE_CHANNEL_RUNTIME, createFakeWebSocketClass, createTimers, mathWithoutJitter };

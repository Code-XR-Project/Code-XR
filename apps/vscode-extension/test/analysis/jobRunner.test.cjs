'use strict';

/**
 * The shared job runner (S6, issue #78), from out/: atomic reservation, the
 * job states, the deadline, cancel reaching the work's signal, late results
 * discarded, the slot held while the work unwinds (with a grace limit), and
 * the per-step watchdog signal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeVscode, withFakeVscode } = require('../helpers/fakeVscode.cjs');

async function withRunner(body) {
    await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
        const launch = requireOut('core/analysis/launch/launchControl.js');
        const jobs = requireOut('core/analysis/launch/jobRunner.js');
        await body({ ...jobs, launch });
    });
}

const options = (overrides = {}) => ({
    busyCode: 'x-busy',
    cancelledCode: 'x-cancelled',
    timeoutCode: 'x-timeout',
    timeoutMs: 0,
    graceMs: 50,
    ...overrides,
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('tryReserve takes the slot synchronously; a second start is refused until the job ends', async () => {
    await withRunner(async ({ JobRunner }) => {
        const states = [];
        const runner = new JobRunner(options({ onStateChange: (status) => states.push(status.state) }));
        const ticket = runner.tryReserve({ n: 1 });
        assert.ok(ticket && /^job-/.test(ticket.id));
        assert.equal(runner.tryReserve({ n: 2 }), null);
        await assert.rejects(runner.run({ n: 3 }, async () => 'never'), /^Error: x-busy$/);
        assert.equal(await ticket.execute(async () => 'done'), 'done');
        assert.equal(runner.isBusy(), false);
        assert.deepEqual(runner.lastRequest, { n: 1 });
        assert.deepEqual(states, ['queued', 'running', 'done']);
        assert.equal(runner.status.state, 'done');
        assert.ok(runner.status.endedAt);
    });
});

test('a failed job keeps the previous successful request and reports its error', async () => {
    await withRunner(async ({ JobRunner }) => {
        const runner = new JobRunner(options());
        await runner.run({ n: 1 }, async () => 'ok');
        await assert.rejects(runner.run({ n: 2 }, async () => {
            throw new Error('boom');
        }), /boom/);
        assert.deepEqual(runner.lastRequest, { n: 1 });
        assert.deepEqual([runner.status.state, runner.status.error], ['failed', 'boom']);
    });
});

test('release() gives back a reservation that never ran; cancel() of a queued job frees it too', async () => {
    await withRunner(async ({ JobRunner, JobCancelledError }) => {
        const runner = new JobRunner(options());
        runner.tryReserve({}).release();
        assert.equal(runner.isBusy(), false);
        assert.equal(runner.status.state, 'cancelled');

        const queued = runner.tryReserve({});
        assert.equal(runner.cancel(), true);
        assert.equal(runner.isBusy(), false);
        await runner.cancelAndWait(); // resolves: the slot is already free
        await assert.rejects(queued.execute(async () => 'late'), JobCancelledError);
    });
});

test('cancel aborts the signal the work runs under, and the job rejects at once with the cancelled code', async () => {
    await withRunner(async ({ JobRunner, JobCancelledError, launch }) => {
        const runner = new JobRunner(options());
        let seen = null;
        const job = runner.run({}, (signal) => new Promise((resolve, reject) => {
            seen = launch.currentLaunchSignal();
            assert.equal(seen, signal, 'the work sees the job signal through the async context');
            signal.addEventListener('abort', () => reject(new Error('child killed')));
        }));
        await delay(5);
        assert.equal(runner.cancel(), true);
        await assert.rejects(job, (error) => error instanceof JobCancelledError
            && error.reason === 'cancelled' && error.message === 'x-cancelled');
        assert.equal(seen.aborted, true);
        await delay(0);
        assert.equal(runner.isBusy(), false);
        assert.equal(runner.status.state, 'cancelled');
        assert.equal(runner.lastRequest, null);
    });
});

test('a job past its deadline is aborted with the timeout code', async () => {
    await withRunner(async ({ JobRunner, JobCancelledError }) => {
        const runner = new JobRunner(options({ timeoutMs: 20 }));
        const job = runner.run({}, (signal) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('killed')));
        }));
        await assert.rejects(job, (error) => error instanceof JobCancelledError
            && error.reason === 'timeout' && error.message === 'x-timeout');
        await delay(0);
        assert.equal(runner.isBusy(), false);
    });
});

test('a result that arrives after the cancel is discarded, and the slot waits for the work to end', async () => {
    await withRunner(async ({ JobRunner, JobCancelledError }) => {
        const runner = new JobRunner(options({ graceMs: 10_000 }));
        let finish;
        const job = runner.run({}, () => new Promise((resolve) => {
            finish = resolve; // ignores the signal, like a step that cannot be killed
        }));
        await delay(5);
        runner.cancel();
        await assert.rejects(job, JobCancelledError);
        assert.equal(runner.isBusy(), true, 'the work is still unwinding: no new job beside it');
        finish('late result');
        await delay(0);
        assert.equal(runner.isBusy(), false);
        assert.equal(runner.lastRequest, null);
    });
});

test('work that ignores the abort frees the slot after the grace period, so the service is never stuck', async () => {
    await withRunner(async ({ JobRunner }) => {
        const runner = new JobRunner(options({ graceMs: 30 }));
        const job = runner.run({}, () => new Promise(() => {}));
        job.catch(() => undefined);
        await delay(5);
        const waited = runner.cancelAndWait();
        assert.equal(runner.isBusy(), true);
        await waited;
        assert.equal(runner.isBusy(), false);
        assert.ok(runner.tryReserve({}), 'a new job can start');
    });
});

test('withTimeout aborts on its deadline or with its parent, and dispose clears the timer', async () => {
    await withRunner(async ({ withTimeout }) => {
        const timed = withTimeout(undefined, 10, 'step-timeout');
        await delay(30);
        assert.equal(timed.signal.reason, 'step-timeout');

        const parent = new AbortController();
        const child = withTimeout(parent.signal, 10_000);
        parent.abort('cancelled');
        assert.equal(child.signal.reason, 'cancelled');
        child.dispose();

        const disposed = withTimeout(undefined, 10);
        disposed.dispose();
        await delay(30);
        assert.equal(disposed.signal.aborted, false);
    });
});

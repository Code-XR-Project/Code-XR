import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FunctionMetricsTracker } from '@codexr/core/metrics/functionMetricsTracker';
import type { FunctionMetricsSnapshot } from '@codexr/core/metrics/functionMetrics';

const fn = (name: string, complexity: number) => ({ functionName: name, lineStart: 1, lineEnd: 4, lineCount: 4, complexity, parameters: 1 });
const settle = (ms = 0) => new Promise((done) => setTimeout(done, ms));

describe('the shared function metrics tracker (#173, #178)', () => {
    it('measures a folder, re-measures a changed file and drops an old folder', async () => {
        const calls: string[] = [];
        const answers = new Map<string, unknown>([
            ['/p:directory', [{ relativePath: 'a.py', functions: [fn('run', 12)] }, { relativePath: 'b.py', functions: [fn('x', 1)] }]],
            ['/p/a.py:file', [{ relativePath: 'a.py', functions: [fn('run', 3)] }]],
        ]);
        const seen: (FunctionMetricsSnapshot | null)[] = [];
        const tracker = new FunctionMetricsTracker(async (target, kind) => {
            calls.push(`${target}:${kind}`);
            return answers.get(`${target}:${kind}`) ?? [];
        }, { onChange: (snapshot) => seen.push(snapshot) });

        tracker.analyse('/p');
        await settle();
        assert.deepEqual(tracker.snapshot?.files.map((file) => file.path), ['a.py', 'b.py']);
        assert.ok(tracker.knows('/p', 'a.py') && !tracker.knows('/q', 'a.py'));

        tracker.fileChanged('/q', 'a.py', '/q/a.py');
        tracker.fileChanged('/p', 'a.py', '/p/a.py');
        tracker.fileChanged('/p', 'a.py', '/p/a.py');
        await settle(450);
        assert.deepEqual(calls, ['/p:directory', '/p/a.py:file']);
        assert.equal(tracker.snapshot?.files[0]?.functions[0]?.complexity, 3);

        tracker.clear();
        assert.equal(tracker.snapshot, null);
        assert.equal(seen.length, 3);
        assert.equal(seen.at(-1), null);
    });

    it('ignores the answer of a run the folder outlived', async () => {
        let release: (value: unknown) => void = () => undefined;
        const seen: (FunctionMetricsSnapshot | null)[] = [];
        const tracker = new FunctionMetricsTracker(() => new Promise((done) => { release = done; }), { onChange: (snapshot) => seen.push(snapshot) });
        tracker.analyse('/old');
        tracker.clear();
        release([{ relativePath: 'a.py', functions: [fn('run', 1)] }]);
        await settle();
        assert.equal(tracker.snapshot, null);
        assert.deepEqual(seen, [null]);
    });
});

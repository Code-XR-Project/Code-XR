import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMetrics, type FileMetrics } from '../src/main/agents/tools/analysisQueries.ts';
import { computeMetricDelta, formatMetricDelta, metricTotals } from '../src/main/analysis/metricDelta.ts';

/** AF9 (#274): the metric delta of an agent's turn, from two analyses' records. */

/** A record shaped like the backend's XR directory output (xr_field_schema.py, XR_DIRECTORY_FIELDS). */
function record(relativePath: string, metrics: Record<string, number>, language = 'TypeScript'): FileMetrics {
    return {
        fileName: path.posix.basename(relativePath),
        filePath: `/project/${relativePath}`,
        relativePath,
        language,
        totalLines: 0, codeLines: 0, commentLines: 0, blankLines: 0, commentRatio: 0,
        classCount: 0, functionCount: 0, maxComplexity: 0, cyclomaticComplexityNumber: 0,
        highComplexityFunctions: 0, criticalComplexityFunctions: 0,
        averageFunctionParameters: 0, maxFunctionParameters: 0, averageFunctionLines: 0, maxFunctionLines: 0,
        fileSizeBytes: 0,
        ...metrics,
    };
}

const before = [
    record('src/a.ts', { totalLines: 120, codeLines: 100, functionCount: 5, maxComplexity: 12, cyclomaticComplexityNumber: 3, highComplexityFunctions: 1 }),
    record('src/b.ts', { totalLines: 50, codeLines: 40, functionCount: 2, maxComplexity: 3, cyclomaticComplexityNumber: 1 }),
    record('lib/old.py', { totalLines: 30, codeLines: 20, functionCount: 1, maxComplexity: 2, cyclomaticComplexityNumber: 2 }, 'Python'),
];
const afterTurn = [
    record('src/a.ts', { totalLines: 140, codeLines: 118, functionCount: 6, maxComplexity: 15, cyclomaticComplexityNumber: 3.5, highComplexityFunctions: 2 }),
    record('src/b.ts', { totalLines: 50, codeLines: 40, functionCount: 2, maxComplexity: 3, cyclomaticComplexityNumber: 1 }),
    record('src\\c.ts', { totalLines: 12, codeLines: 10, functionCount: 1, maxComplexity: 1, cyclomaticComplexityNumber: 1 }),
];

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-delta-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

describe('metric delta of a turn', () => {
    it('reports added, removed, changed and touched-but-unchanged files, with project totals', () => {
        const report = computeMetricDelta(before, afterTurn, ['src/a.ts', './src/b.ts', 'src/c.ts', 'lib/old.py', 'README.md']);
        assert.equal(report.status, 'ok');
        assert.deepEqual(report.files.map((file) => [file.path, file.status]), [
            ['README.md', 'not-analysed'],
            ['lib/old.py', 'removed'],
            ['src/a.ts', 'changed'],
            ['src/b.ts', 'unchanged'],
            ['src/c.ts', 'added'],
        ]);
        const a = report.files.find((file) => file.path === 'src/a.ts')!;
        assert.deepEqual(a.metrics.codeLines, { before: 100, after: 118, delta: 18 });
        assert.deepEqual(a.metrics.maxComplexity, { before: 12, after: 15, delta: 3 });
        assert.deepEqual(a.metrics.cyclomaticComplexityNumber, { before: 3, after: 3.5, delta: 0.5 });
        // Only the metrics that moved are listed.
        assert.equal(a.metrics.classCount, undefined);
        assert.deepEqual(report.files.find((file) => file.path === 'src/b.ts')!.metrics, {});
        const added = report.files.find((file) => file.path === 'src/c.ts')!;
        assert.deepEqual(added.metrics.codeLines, { before: null, after: 10, delta: 10 });
        const removed = report.files.find((file) => file.path === 'lib/old.py')!;
        assert.equal(removed.language, 'Python');
        assert.deepEqual(removed.metrics.codeLines, { before: 20, after: null, delta: -20 });

        assert.equal(report.totals.before?.codeLines, 160);
        assert.equal(report.totals.after?.codeLines, 168);
        assert.deepEqual(report.totals.delta, {
            files: 0, codeLines: 8, totalLines: 2, functionCount: 1, classCount: 0,
            highComplexityFunctions: 1, criticalComplexityFunctions: 0, maxComplexity: 3, avgComplexity: -0.17,
        });
        assert.equal(report.summary, '3 files (1 added, 1 removed, 1 changed): code lines +8 (160 -> 168), functions +1, max complexity 12 -> 15, avg complexity 2 -> 1.83, high-complexity functions +1');
    });

    it('lists every differing file when the changed paths are unknown', () => {
        const report = computeMetricDelta(before, afterTurn);
        assert.deepEqual(report.files.map((file) => [file.path, file.status]), [
            ['lib/old.py', 'removed'],
            ['src/a.ts', 'changed'],
            ['src/c.ts', 'added'],
        ]);
    });

    it('expands a changed folder to the analysed files under it', () => {
        const report = computeMetricDelta(before, afterTurn, ['lib', 'src/']);
        assert.deepEqual(report.files.map((file) => file.path), ['lib/old.py', 'src/a.ts', 'src/b.ts', 'src/c.ts']);
    });

    it('says when nothing moved', () => {
        const report = computeMetricDelta(before, before, ['src/b.ts']);
        assert.equal(report.summary, 'No metric changes.');
        assert.deepEqual(report.files.map((file) => file.status), ['unchanged']);
        assert.equal(computeMetricDelta(before, before, []).files.length, 0);
    });

    it('handles a missing analysis on either side', () => {
        const noBaseline = computeMetricDelta(null, afterTurn, ['src/a.ts']);
        assert.equal(noBaseline.status, 'no-baseline');
        assert.equal(noBaseline.totals.after?.files, 3);
        assert.deepEqual(noBaseline.files, []);
        const noAnalysis = computeMetricDelta(before, null, ['src/a.ts']);
        assert.equal(noAnalysis.status, 'no-analysis');
        assert.equal(noAnalysis.totals.before?.files, 3);
        assert.deepEqual(noAnalysis.totals.delta, {});
    });

    it('keeps totals null for metrics no record has', () => {
        const totals = metricTotals([{ relativePath: 'notes.txt' }]);
        assert.equal(totals.maxComplexity, null);
        assert.equal(totals.avgComplexity, null);
        assert.equal(totals.codeLines, 0);
        assert.deepEqual(metricTotals([]).files, 0);
    });

    it('formats a report for an agent', () => {
        const text = formatMetricDelta(computeMetricDelta(before, afterTurn, ['src/c.ts', 'src/b.ts']));
        const lines = text.split('\n');
        assert.match(lines[0]!, /^1 file \(1 added\): code lines \+8/);
        assert.equal(lines[1], '- src/b.ts [unchanged]');
        assert.match(lines[2]!, /^- src\/c\.ts \[added\]: codeLines - -> 10 \(\+10\), totalLines - -> 12 \(\+12\)/);
    });

    it('works on the records readMetrics reads from a data.json', async () => {
        const dir = (name: string, records: readonly FileMetrics[]): string => {
            const folder = path.join(base, name);
            fs.mkdirSync(folder);
            fs.writeFileSync(path.join(folder, 'data.json'), JSON.stringify(records));
            return folder;
        };
        const report = computeMetricDelta(await readMetrics(dir('before', before)), await readMetrics(dir('after', afterTurn)), ['src/c.ts']);
        assert.deepEqual(report.files.map((file) => [file.path, file.status]), [['src/c.ts', 'added']]);
    });
});

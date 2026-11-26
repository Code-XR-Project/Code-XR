import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countAnalysedRecords, readAnalysedFileCount, watchAnalysedFileCount } from '../src/main/analysis/analysedFiles.ts';

describe('analysed file count (#203)', () => {
    it('counts the records of data.json', () => {
        assert.equal(countAnalysedRecords('[{"fileName":"a.py"},{"fileName":"b.ts"}]'), 2);
        assert.equal(countAnalysedRecords('[]'), 0);
        assert.equal(countAnalysedRecords('{"files":[]}'), undefined);
        assert.equal(countAnalysedRecords('not json'), undefined);
    });

    it('reads data.json next to the served index.html', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-analysed-'));
        try {
            fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify([{}, {}, {}]));
            assert.equal(await readAnalysedFileCount(path.join(dir, 'index.html')), 3);
            assert.equal(await readAnalysedFileCount(path.join(dir, 'missing', 'index.html')), undefined);
            assert.equal(await readAnalysedFileCount(undefined), undefined);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reports a changed count after data.json is rewritten (#16)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-analysed-'));
        const counts: number[] = [];
        fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify([{}]));
        const stop = watchAnalysedFileCount(path.join(dir, 'index.html'), 1, (files) => counts.push(files));
        try {
            fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify([{}, {}]));
            const deadline = Date.now() + 5000;
            while (counts.length === 0 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.deepEqual(counts, [2]);
        } finally {
            stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('watches nothing without a served file', () => {
        assert.doesNotThrow(watchAnalysedFileCount(undefined, undefined, () => assert.fail('no change expected')));
    });
});

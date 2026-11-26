import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countAnalysedRecords, readAnalysedFileCount } from '../src/main/analysis/analysedFiles.ts';

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
});

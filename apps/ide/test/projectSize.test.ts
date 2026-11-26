import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { countFilesUpTo } from '../src/main/analysis/projectSize.ts';

describe('countFilesUpTo', () => {
    let root = '';
    before(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-size-'));
        const write = (relative: string): void => {
            const file = path.join(root, relative);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '');
        };
        for (let i = 0; i < 6; i++) {
            write(`src/deep/file${i}.ts`);
        }
        write('README.md');
        write('.git/objects/aa/blob');
        write('node_modules/pkg/index.js');
    });
    after(() => fs.rmSync(root, { recursive: true, force: true }));

    it('counts the project files, not .git or node_modules', async () => {
        assert.equal(await countFilesUpTo(root, 100), 7);
    });

    it('stops as soon as the count passes the limit', async () => {
        const count = await countFilesUpTo(root, 3);
        assert.ok(count > 3 && count <= 7, `got ${count}`);
    });

    it('treats a missing folder as empty', async () => {
        assert.equal(await countFilesUpTo(path.join(root, 'nope'), 10), 0);
    });
});

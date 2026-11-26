import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_RECENT_FOLDERS, RecentFolders, parseRecent, withRecent } from '../src/main/recentFolders.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-recent-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const abs = (name: string): string => path.resolve(base, name);

describe('withRecent', () => {
    it('moves the folder to the front without duplicates and caps the list', () => {
        let list: string[] = [];
        for (let i = 0; i < MAX_RECENT_FOLDERS + 3; i++) {
            list = withRecent(list, abs(`p${i}`), 'linux');
        }
        assert.equal(list.length, MAX_RECENT_FOLDERS);
        assert.equal(list[0], abs(`p${MAX_RECENT_FOLDERS + 2}`));
        list = withRecent(list, abs('p5'), 'linux');
        assert.equal(list[0], abs('p5'));
        assert.equal(list.filter((p) => p === abs('p5')).length, 1);
    });

    it('treats case as the same folder on Windows and macOS, not on Linux', () => {
        assert.equal(withRecent([abs('Proj')], abs('proj'), 'win32').length, 1);
        assert.equal(withRecent([abs('Proj')], abs('proj'), 'darwin').length, 1);
        assert.equal(withRecent([abs('Proj')], abs('proj'), 'linux').length, 2);
    });
});

describe('parseRecent', () => {
    it('keeps absolute path strings only and survives a broken file', () => {
        assert.deepEqual(parseRecent(JSON.stringify({ folders: [abs('a'), 'relative', 3, null, abs('b')] })), [abs('a'), abs('b')]);
        assert.deepEqual(parseRecent('{not json'), []);
        assert.deepEqual(parseRecent('null'), []);
        assert.deepEqual(parseRecent(JSON.stringify({ folders: 'x' })), []);
    });
});

describe('RecentFolders', () => {
    it('persists, answers membership exactly, removes and clears', async () => {
        const file = path.join(base, 'state', 'recent-folders.json');
        const seen: (readonly string[])[] = [];
        const recent = new RecentFolders(file, (list) => seen.push([...list]));
        await recent.load();
        assert.deepEqual(recent.folders, []);
        await recent.add(abs('one'));
        await recent.add(abs('two'));
        assert.ok(recent.has(abs('one')));
        assert.ok(!recent.has(abs('three')));
        assert.ok(!recent.has(42));

        const again = new RecentFolders(file);
        await again.load();
        assert.deepEqual(again.folders, [abs('two'), abs('one')]);

        await recent.remove(abs('one'));
        assert.deepEqual(recent.folders, [abs('two')]);
        await recent.clear();
        assert.deepEqual(recent.folders, []);
        assert.deepEqual(seen.at(-1), []);
        assert.equal(seen.length, 5);
    });
});

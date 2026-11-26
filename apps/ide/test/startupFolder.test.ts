import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chooseStartupFolder } from '../src/main/workspace/startupFolder.ts';

describe('chooseStartupFolder', () => {
    it('opens the --folder argument first', () => {
        assert.deepEqual(chooseStartupFolder('/work/a', ['/work/b'], false), { kind: 'argument', folder: '/work/a' });
        assert.deepEqual(chooseStartupFolder('/work/a', [], true), { kind: 'argument', folder: '/work/a' });
    });

    it('reopens the folder worked on last', () => {
        assert.deepEqual(chooseStartupFolder(null, ['/work/b', '/work/c'], false), { kind: 'last', folder: '/work/b' });
    });

    it('opens nothing with no history, or in the smoke run', () => {
        assert.deepEqual(chooseStartupFolder(undefined, [], false), { kind: 'none' });
        assert.deepEqual(chooseStartupFolder(null, ['/work/b'], true), { kind: 'none' });
    });
});

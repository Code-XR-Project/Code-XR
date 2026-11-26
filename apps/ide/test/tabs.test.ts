import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    closeTargets, cycleTab, discardQuestion, EMPTY_SESSION, MAX_RESTORED_TABS, moveTab, parseSession, serializeSession, sessionKey,
} from '../src/renderer/editor/tabsModel.ts';

const tabs = [
    { path: 'a.ts', dirty: false },
    { path: 'b.ts', dirty: true },
    { path: 'c.ts', dirty: false },
    { path: 'd.ts', dirty: true },
];

describe('group closes (#167)', () => {
    it('picks the tabs each close takes, in tab order', () => {
        assert.deepEqual(closeTargets('others', tabs, 'b.ts'), ['a.ts', 'c.ts', 'd.ts']);
        assert.deepEqual(closeTargets('right', tabs, 'b.ts'), ['c.ts', 'd.ts']);
        assert.deepEqual(closeTargets('right', tabs, 'd.ts'), []);
        assert.deepEqual(closeTargets('saved', tabs, null), ['a.ts', 'c.ts']);
        assert.deepEqual(closeTargets('all', tabs, null), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
        assert.deepEqual(closeTargets('others', tabs, null), []);
        assert.deepEqual(closeTargets('right', tabs, 'gone.ts'), []);
    });

    it('asks once, listing only the unsaved tabs', () => {
        assert.equal(discardQuestion(['a.ts', 'c.ts'], new Set(['b.ts'])), null);
        assert.equal(discardQuestion(['b.ts'], new Set(['b.ts'])), 'b.ts has unsaved changes. Close it and discard them?');
        const question = discardQuestion(['a.ts', 'b.ts', 'c.ts', 'd.ts'], new Set(['b.ts', 'd.ts'])) ?? '';
        assert.match(question, /^These 2 files have unsaved changes:\nb\.ts\nd\.ts\n\nClose the 4 tabs and discard them\?$/);
        const many = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
        assert.match(discardQuestion(many, new Set(many)) ?? '', /\.\.\. and 4 more/);
    });
});

describe('cycling and reordering (#167)', () => {
    const order = ['a', 'b', 'c'];
    it('wraps around both ways', () => {
        assert.equal(cycleTab(order, 'c', 1), 'a');
        assert.equal(cycleTab(order, 'a', -1), 'c');
        assert.equal(cycleTab(order, 'b', 1), 'c');
        assert.equal(cycleTab(order, null, 1), 'a');
        assert.equal(cycleTab(order, null, -1), 'c');
        assert.equal(cycleTab([], null, 1), null);
    });

    it('moves a tab before another, or to the end', () => {
        assert.deepEqual(moveTab(order, 'c', 'a'), ['c', 'a', 'b']);
        assert.deepEqual(moveTab(order, 'a', null), ['b', 'c', 'a']);
        assert.deepEqual(moveTab(order, 'a', 'c'), ['b', 'a', 'c']);
        assert.deepEqual(moveTab(order, 'b', 'b'), order);
        assert.deepEqual(moveTab(order, 'x', 'a'), order);
    });
});

describe('tab session (#167)', () => {
    it('round-trips per folder', () => {
        const session = { tabs: [{ path: 'src/a.ts', viewState: { cursorState: [] } }, { path: 'README.md', viewState: null }], active: 'README.md', preview: 'src/a.ts' };
        assert.deepEqual(parseSession(serializeSession(session)), session);
        assert.notEqual(sessionKey('/home/me/one'), sessionKey('/home/me/two'));
    });

    it('drops damaged entries and paths that leave the folder', () => {
        const text = JSON.stringify({
            version: 1,
            tabs: [{ path: '../etc/passwd' }, { path: '/abs' }, { path: 'ok.ts', viewState: 'x' }, { path: 'ok.ts' }, null, { path: 7 }],
            active: 'missing.ts',
            preview: 'ok.ts',
        });
        assert.deepEqual(parseSession(text), { tabs: [{ path: 'ok.ts', viewState: null }], active: null, preview: 'ok.ts' });
        assert.deepEqual(parseSession('nope'), EMPTY_SESSION);
        assert.deepEqual(parseSession(JSON.stringify({ version: 2, tabs: [{ path: 'a' }] })), EMPTY_SESSION);
    });

    it('keeps at most MAX_RESTORED_TABS', () => {
        const many = { tabs: Array.from({ length: MAX_RESTORED_TABS + 5 }, (_, i) => ({ path: `f${i}`, viewState: null })), active: null, preview: null };
        assert.equal(parseSession(serializeSession(many)).tabs.length, MAX_RESTORED_TABS);
    });
});

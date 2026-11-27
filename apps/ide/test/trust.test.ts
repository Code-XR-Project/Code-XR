import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSameOrInside, MAX_TRUST_DECISIONS, parseDecisions, trustedThrough, trustOf, withDecision } from '../src/main/trust/trustModel.ts';
import { trustChoices, trustTooltip } from '../src/renderer/trustChoices.ts';

describe('workspace trust model (#177)', () => {
    it('trusts a folder and everything under it, never a sibling with the same prefix', () => {
        const decisions = withDecision([], '/home/me/work', true, 'linux');
        assert.equal(trustOf('/home/me/work', decisions, 'linux'), 'trusted');
        assert.equal(trustOf('/home/me/work/app/src', decisions, 'linux'), 'trusted', 'a parent trusts its children');
        assert.equal(trustOf('/home/me/work-two', decisions, 'linux'), 'unknown');
        assert.equal(trustOf('/home/me', decisions, 'linux'), 'unknown', 'a child never trusts its parent');
        assert.equal(trustedThrough('/home/me/work/app', decisions, 'linux'), '/home/me/work');
    });

    it('lets a folder be restricted inside a trusted parent, and trusted again', () => {
        let decisions = withDecision([], '/w', true, 'linux');
        decisions = withDecision(decisions, '/w/download', false, 'linux');
        assert.equal(trustOf('/w/download', decisions, 'linux'), 'restricted');
        assert.equal(trustOf('/w/download/sub', decisions, 'linux'), 'trusted', 'Restricted Mode is per folder');
        decisions = withDecision(decisions, '/w/download', true, 'linux');
        assert.equal(trustOf('/w/download', decisions, 'linux'), 'trusted');
        assert.equal(decisions.length, 2, 'one decision per folder');
    });

    it('compares paths without case on Windows and macOS, with case on Linux', () => {
        const windows = withDecision([], 'C:\\Users\\Me\\Code', true, 'win32');
        assert.equal(trustOf('c:\\users\\me\\code\\App', windows, 'win32'), 'trusted');
        assert.equal(trustOf('D:\\Users\\Me\\Code', windows, 'win32'), 'unknown');
        assert.equal(trustOf('/Users/me/CODE/app', withDecision([], '/Users/me/code', true, 'darwin'), 'darwin'), 'trusted');
        assert.equal(trustOf('/home/Me/code', withDecision([], '/home/me/code', true, 'linux'), 'linux'), 'unknown');
        assert.equal(isSameOrInside('C:\\a', 'C:\\a\\..\\b', 'win32'), false);
    });

    it('reads stored decisions defensively and keeps a bounded list', () => {
        assert.deepEqual(parseDecisions([{ path: '/a', trusted: true }, { path: '', trusted: true }, { path: '/b', trusted: 'yes' }, null, 3]), [{ path: '/a', trusted: true }]);
        assert.deepEqual(parseDecisions('nope'), []);
        let many: ReturnType<typeof withDecision> = [];
        for (let index = 0; index < MAX_TRUST_DECISIONS + 10; index += 1) {
            many = withDecision(many, `/f${index}`, true, 'linux');
        }
        assert.equal(many.length, MAX_TRUST_DECISIONS);
        assert.equal(many[0]?.path, `/f${MAX_TRUST_DECISIONS + 9}`, 'the newest first');
    });
});

describe('workspace trust view (#177)', () => {
    const base = { folder: '/home/me/work/app', parent: '/home/me/work', trustedThrough: null };

    it('offers what would change', () => {
        assert.deepEqual(trustChoices({ ...base, state: 'unknown' }).map((item) => item.id), ['folder', 'parent', 'restrict']);
        assert.deepEqual(trustChoices({ ...base, state: 'restricted' }).map((item) => item.id), ['folder', 'parent']);
        assert.deepEqual(trustChoices({ ...base, state: 'trusted', trustedThrough: '/home/me/work/app' }).map((item) => item.id), ['parent', 'restrict']);
        assert.deepEqual(trustChoices({ ...base, state: 'trusted', trustedThrough: '/home/me/work' }).map((item) => item.id), ['folder', 'restrict']);
        assert.deepEqual(trustChoices({ state: 'unknown', folder: null, parent: null, trustedThrough: null }), []);
        assert.match(trustChoices({ ...base, state: 'unknown' })[1]?.label ?? '', /Trust every folder in work/);
    });

    it('explains the state', () => {
        assert.equal(trustTooltip({ ...base, state: 'trusted', trustedThrough: '/home/me/work' }), 'Trusted through /home/me/work');
        assert.match(trustTooltip({ ...base, state: 'restricted' }), /^Restricted Mode\. .*Git.*analysis/);
        assert.match(trustTooltip({ ...base, state: 'unknown' }), /^Not trusted yet/);
    });
});

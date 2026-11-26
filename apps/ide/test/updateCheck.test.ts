import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickUpdate } from '../src/main/updates/updateRelease.ts';

const page = (tag: string): string => `https://github.com/Code-XR-Project/Code-XR/releases/tag/${tag}`;
const release = (tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ tag_name: tag, html_url: page(tag), draft: false, prerelease: false, ...extra });

describe('pickUpdate (#20)', () => {
    it('offers the newest published IDE release above the running one', () => {
        const releases = [release('ide-v0.2.0'), release('ide-v0.10.1'), release('ide-v0.3.5'), release('v1.2.1')];
        assert.deepEqual(pickUpdate(releases, '0.1.0'), { version: '0.10.1', url: page('ide-v0.10.1') });
    });

    it('offers nothing when the running version is the newest', () => {
        assert.equal(pickUpdate([release('ide-v0.1.0'), release('ide-v0.0.9')], '0.1.0'), null);
    });

    it('skips drafts, pre-releases, the extension\'s tags and malformed entries', () => {
        const releases = [release('ide-v9.0.0', { draft: true }), release('ide-v8.0.0', { prerelease: true }), release('v7.0.0'), release('ide-v6.0'), null, 'x', { tag_name: 3 }];
        assert.equal(pickUpdate(releases, '0.1.0'), null);
        assert.equal(pickUpdate({ message: 'API rate limit exceeded' }, '0.1.0'), null);
    });

    it('never offers a page outside this repository\'s releases', () => {
        assert.equal(pickUpdate([release('ide-v1.0.0', { html_url: 'https://evil.example/releases/tag/ide-v1.0.0' })], '0.1.0'), null);
        assert.equal(pickUpdate([release('ide-v1.0.0', { html_url: 'https://github.com/Code-XR-Project/Code-XR-evil/releases/x' })], '0.1.0'), null);
    });
});

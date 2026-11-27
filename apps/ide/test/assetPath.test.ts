import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveRendererAsset } from '../src/main/assetPath.ts';

const root = path.resolve('fixture-renderer');

describe('resolveRendererAsset', () => {
    it('serves index.html for the root', () => {
        assert.equal(resolveRendererAsset(root, '/'), path.join(root, 'index.html'));
    });

    it('serves files inside the renderer folder', () => {
        assert.equal(resolveRendererAsset(root, '/assets/main-abc.js'), path.join(root, 'assets', 'main-abc.js'));
        assert.equal(resolveRendererAsset(root, '/assets/a%20b.css'), path.join(root, 'assets', 'a b.css'));
    });

    for (const attempt of [
        '/../secret.txt',
        '/%2e%2e/secret.txt',
        '/assets/%2e%2e/%2e%2e/secret.txt',
        '/..%2fsecret.txt',
        '/..%5csecret.txt',
        '/%00index.html',
        '/%E0%A4%A',
    ]) {
        it(`refuses ${attempt}`, () => {
            assert.equal(resolveRendererAsset(root, attempt), null);
        });
    }

    it('refuses an absolute path smuggled through encoding', () => {
        const absolute = process.platform === 'win32' ? '/C:%5CWindows%5Cwin.ini' : '/%2Fetc%2Fpasswd';
        const resolved = resolveRendererAsset(root, absolute);
        assert.ok(resolved === null || resolved.startsWith(root + path.sep));
    });
});

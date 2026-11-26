import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localSceneOrigin, sanitizeBounds, sceneTitle, targetName } from '../src/main/analysis/sceneUrl.ts';

describe('localSceneOrigin', () => {
    it('accepts a Code-XR server on loopback', () => {
        assert.equal(localSceneOrigin('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
        assert.equal(localSceneOrigin('http://localhost:3001/index.html'), 'http://localhost:3001');
        assert.equal(localSceneOrigin('https://[::1]:3443/x'), 'https://[::1]:3443');
    });

    for (const url of [
        'https://example.com:3000/',
        'http://192.168.1.4:3000/',
        'http://127.0.0.1/',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'http://user:pw@127.0.0.1:3000/',
        'http://127.0.0.1.evil.test:3000/',
        'not a url',
    ]) {
        it(`refuses ${url}`, () => assert.equal(localSceneOrigin(url), null));
    }
});

describe('sanitizeBounds', () => {
    it('rounds to whole, non-negative pixels', () => {
        assert.deepEqual(sanitizeBounds({ x: 10.4, y: -3, width: 300.6, height: 200 }), { x: 10, y: 0, width: 301, height: 200 });
    });

    it('refuses what is not a visible rectangle', () => {
        assert.equal(sanitizeBounds(null), null);
        assert.equal(sanitizeBounds({ x: 0, y: 0, width: 0, height: 10 }), null);
        assert.equal(sanitizeBounds({ x: 0, y: 0, width: Number.NaN, height: 10 }), null);
        assert.equal(sanitizeBounds({ x: '0', y: 0, width: 10, height: 10 }), null);
    });

    it('caps absurd sizes', () => {
        assert.deepEqual(sanitizeBounds({ x: 0, y: 0, width: 1e9, height: 1e9 }), { x: 0, y: 0, width: 16384, height: 16384 });
    });
});

describe('sceneTitle', () => {
    it('names the analysed folder on every OS', () => {
        assert.equal(sceneTitle('/home/a/Code-XR'), 'XR · Code-XR');
        assert.equal(sceneTitle('C:\\Users\\a\\Code-XR\\'), 'XR · Code-XR');
    });
});

describe('targetName', () => {
    it('is the folder or file name on every OS', () => {
        assert.equal(targetName('/home/a/Code-XR/'), 'Code-XR');
        assert.equal(targetName('C:\\Users\\a\\src\\main.py'), 'main.py');
        assert.equal(targetName('/'), '/');
    });
});

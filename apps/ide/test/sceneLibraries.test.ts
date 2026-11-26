import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentTypeOf, isLoopbackUrl, SCENE_LIBRARIES, vendoredLibraryFor } from '../src/main/analysis/sceneLibraries.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, '..', '..', 'vscode-extension', 'test', 'vendor', 'scene-libraries');
const templates = path.join(here, '..', '..', 'vscode-extension', 'templates');

function htmlFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? htmlFiles(full) : entry.name.endsWith('.html') ? [full] : [];
    });
}

describe('scene libraries', () => {
    it('maps each pinned CDN URL to a vendored file that exists', () => {
        for (const [, file] of SCENE_LIBRARIES) {
            assert.ok(fs.existsSync(path.join(vendor, file)), file);
        }
    });

    it('covers every external script the templates load, so a scene never needs the network', () => {
        const urls = new Set<string>();
        for (const file of htmlFiles(templates)) {
            for (const match of fs.readFileSync(file, 'utf8').matchAll(/<script[^>]*\bsrc="(https:[^"]+)"/g)) {
                urls.add(match[1]!);
            }
        }
        assert.ok(urls.size > 0);
        for (const url of urls) {
            assert.ok(vendoredLibraryFor(url), `no vendored copy for ${url}`);
        }
    });

    it('serves A-Frame\'s default font, so scene text renders offline', () => {
        assert.equal(vendoredLibraryFor('https://cdn.aframe.io/fonts/Roboto-msdf.json'), 'fonts/Roboto-msdf.json');
        assert.equal(vendoredLibraryFor('https://cdn.aframe.io/fonts/Roboto-msdf.png'), 'fonts/Roboto-msdf.png');
        assert.equal(contentTypeOf('fonts/Roboto-msdf.png'), 'image/png');
        assert.equal(contentTypeOf('fonts/Roboto-msdf.json'), 'application/json; charset=utf-8');
        assert.equal(contentTypeOf('aframe-1.7.1.min.js'), 'application/javascript; charset=utf-8');
    });

    it('does not answer look-alike hosts', () => {
        assert.equal(vendoredLibraryFor('https://evil.test/aframe.io/releases/1.7.1/aframe.min.js'), null);
        assert.equal(vendoredLibraryFor('https://unpkg.com/aframe-babia-components@9.9.9/x.js'), null);
    });

    it('recognises loopback only', () => {
        assert.ok(isLoopbackUrl('https://localhost:3443/'));
        assert.ok(isLoopbackUrl('http://127.0.0.1:3000/x'));
        assert.equal(isLoopbackUrl('https://localhost.evil.test/'), false);
        assert.equal(isLoopbackUrl('nope'), false);
    });
});

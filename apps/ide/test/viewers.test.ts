import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clampZoom, dataUrlBytes, findInPages, fitZoom, formatBytes, itemsInRange, MAX_FIND_MATCHES, MAX_ZOOM, MIN_ZOOM, stepZoom, zoomLabel } from '../src/renderer/viewers/viewerModel.ts';
import { compareFilesId, compareSavedId, CustomEditorRegistry, extensionOf, isSchemeId, parseCompareId, VIEWER_IMAGE_EXTENSIONS } from '../src/renderer/editor/customEditorRegistry.ts';
import { imageMimeType, MAX_DOCUMENT_BYTES, Workspace } from '../src/main/workspace/workspace.ts';

describe('Viewer model (#256)', () => {
    it('steps the zoom through the fixed levels, from any value', () => {
        assert.equal(stepZoom(1, 1), 1.1);
        assert.equal(stepZoom(1, -1), 0.9);
        assert.equal(stepZoom(1.03, 1), 1.1, 'a fitted zoom steps to the next level up');
        assert.equal(stepZoom(1.03, -1), 1);
        assert.equal(stepZoom(MAX_ZOOM, 1), MAX_ZOOM);
        assert.equal(stepZoom(MIN_ZOOM, -1), MIN_ZOOM);
        assert.equal(clampZoom(100), MAX_ZOOM);
        assert.equal(clampZoom(Number.NaN), 1);
        assert.equal(zoomLabel(1.254), '125%');
    });

    it('fits a width into the room left by the margins', () => {
        assert.equal(fitZoom(500, 1032), 2);
        assert.equal(fitZoom(0, 800), 1);
        assert.equal(fitZoom(100_000, 800), MIN_ZOOM);
    });

    it('finds every case-insensitive match, page by page', () => {
        assert.deepEqual(findInPages(['Abc abc', '', 'xABCx'], 'abc'), [{ page: 0, offset: 0 }, { page: 0, offset: 4 }, { page: 2, offset: 1 }]);
        assert.deepEqual(findInPages(['aaaa'], 'aa'), [{ page: 0, offset: 0 }, { page: 0, offset: 2 }], 'matches do not overlap');
        assert.deepEqual(findInPages(['abc'], ''), []);
        assert.equal(findInPages(['a'.repeat(5000)], 'a').length, MAX_FIND_MATCHES);
    });

    it('maps a match to the text items it covers', () => {
        // Items "Hello ", "", "wor", "ld!": "o wo" starts at 4 and spans 4.
        assert.deepEqual(itemsInRange([6, 0, 3, 4], 4, 4), [0, 2]);
        assert.deepEqual(itemsInRange([6, 0, 3, 4], 9, 1), [3]);
        assert.deepEqual(itemsInRange([3], 5, 1), []);
    });

    it('formats sizes and measures a data URL', () => {
        assert.equal(formatBytes(512), '512 B');
        assert.equal(formatBytes(2048), '2.0 KB');
        assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
        assert.equal(dataUrlBytes('data:image/png;base64,iVBORw=='), 4);
        assert.equal(dataUrlBytes('data:image/png;base64,'), 0);
    });
});

describe('Custom editor seam (#256)', () => {
    const input = (id: string): { readonly id: string } => ({ id });

    it('asks the resolvers in order and stops at the first answer', () => {
        const registry = new CustomEditorRegistry<{ readonly id: string }>();
        const asked: string[] = [];
        registry.register((id) => { asked.push(`a:${id}`); return id.startsWith('chat:') ? input(id) : null; });
        const remove = registry.register((id) => { asked.push(`b:${id}`); return input(`b-${id}`); });
        assert.equal(registry.resolve('chat:1')?.id, 'chat:1');
        assert.equal(registry.resolve('x.pdf')?.id, 'b-x.pdf');
        assert.deepEqual(asked, ['a:chat:1', 'a:x.pdf', 'b:x.pdf']);
        remove();
        assert.equal(registry.resolve('x.pdf'), null);
    });

    it('reads extensions the way the viewers pick files', () => {
        assert.equal(extensionOf('docs/Paper.PDF'), 'pdf');
        assert.equal(extensionOf('a.b/c'), '');
        assert.equal(extensionOf('.gitignore'), '', 'a dot file has no extension');
        for (const extension of VIEWER_IMAGE_EXTENSIONS) {
            assert.ok(imageMimeType(`x.${extension}`), `the image viewer's ${extension} is one readImage serves`);
        }
        assert.equal(VIEWER_IMAGE_EXTENSIONS.has('svg'), false, 'SVG stays text');
        assert.equal(isSchemeId('chat:42'), true);
        assert.equal(isSchemeId('docs/a.pdf'), false);
        assert.equal(isSchemeId('C-1.pdf'), false);
    });
});

describe('Comparison tab ids (#288)', () => {
    it('round-trips both kinds, whatever the names hold', () => {
        assert.deepEqual(parseCompareId(compareSavedId('src/a.ts')), { kind: 'saved', path: 'src/a.ts' });
        assert.deepEqual(parseCompareId(compareFilesId('a|b.ts', 'dir/c d.ts')), { kind: 'files', left: 'a|b.ts', right: 'dir/c d.ts' });
        assert.equal(isSchemeId(compareSavedId('a.ts')), true, 'never taken for a file path');
        assert.equal(isSchemeId(compareFilesId('a.ts', 'b.ts')), true);
    });

    it('rejects malformed ids', () => {
        assert.equal(parseCompareId('compare-saved:'), null);
        assert.equal(parseCompareId('compare:onlyone'), null);
        assert.equal(parseCompareId('compare:a|b|c'), null);
        assert.equal(parseCompareId('compare:%E0%A4%A|b'), null, 'bad escape');
        assert.equal(parseCompareId('src/a.ts'), null);
    });
});

describe('Document reads, main process (#256)', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-viewers-')));
    const root = path.join(base, 'project');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'paper.pdf'), Buffer.from('%PDF-1.7\n%âã\n', 'latin1'));
    fs.writeFileSync(path.join(root, 'docs', 'notes.txt'), 'text');
    fs.writeFileSync(path.join(base, 'outside.pdf'), Buffer.from('%PDF'));
    let linked = true;
    try {
        fs.symlinkSync(path.join(base, 'outside.pdf'), path.join(root, 'link.pdf'));
    } catch {
        linked = false; // Windows without the symlink privilege
    }
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    it('reads PDFs of the folder only, as bytes', async () => {
        const workspace = await Workspace.open(root);
        const bytes = await workspace.readDocument('docs/paper.pdf');
        assert.ok(bytes instanceof Uint8Array);
        assert.equal(Buffer.from(bytes).subarray(0, 8).toString('latin1'), '%PDF-1.7');
        assert.equal(await workspace.readDocument('docs/notes.txt'), null, 'not a document type');
        assert.equal(await workspace.readDocument('docs'), null, 'no extension');
        await assert.rejects(workspace.readDocument('../outside.pdf'));
        if (linked) {
            await assert.rejects(workspace.readDocument('link.pdf'), 'a symlink out of the folder');
        }
        await assert.rejects(workspace.readDocument(42));
        assert.ok(MAX_DOCUMENT_BYTES >= 32 * 1024 * 1024);
    });
});

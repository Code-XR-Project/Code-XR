import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockIndexForLine, headingSlugger, renderMarkdownBlocks, resolveImage, resolveLink, resolveRelativePath } from '../src/renderer/editor/markdownModel.ts';
import { isMarkdownPath } from '../src/renderer/editor/markdownPath.ts';
import { imageMimeType, MAX_PREVIEW_IMAGE_BYTES, Workspace } from '../src/main/workspace/workspace.ts';
import { isOpenableExternalLink } from '../src/main/security.ts';

describe('Markdown preview model (#179)', () => {
    it('renders one block per top-level element, each with the line it starts on', () => {
        const text = [
            '# Title', //                         1
            '', //                                2
            'Some *text* and a [link](b.md).', // 3
            '', //                                4
            '- one', //                           5
            '- two', //                           6
            '', //                                7
            '| a | b |', //                       8
            '|---|---|', //                       9
            '| 1 | 2 |', //                       10
            '', //                                11
            '```ts', //                           12
            'const x = 1;', //                    13
            '```', //                             14
            '![logo](img/logo.png)', //           15
        ].join('\n');
        const blocks = renderMarkdownBlocks(text);
        assert.deepEqual(blocks.map((block) => block.line), [1, 3, 5, 8, 12, 15]);
        assert.match(blocks[0]?.html ?? '', /<h1>Title<\/h1>/);
        assert.match(blocks[1]?.html ?? '', /<em>text<\/em>/);
        assert.match(blocks[2]?.html ?? '', /<li>one<\/li>/);
        assert.match(blocks[3]?.html ?? '', /<table>/);
        assert.match(blocks[4]?.html ?? '', /class="language-ts"/);
        assert.match(blocks[5]?.html ?? '', /<img src="img\/logo.png" alt="logo"/);
    });

    it('resolves reference links across blocks', () => {
        const blocks = renderMarkdownBlocks('See [the docs][d].\n\n[d]: docs/a.md\n');
        assert.match(blocks[0]?.html ?? '', /href="docs\/a.md"/);
    });

    it('passes raw HTML through for the sanitiser (the model itself never trusts it)', () => {
        const blocks = renderMarkdownBlocks('<script>alert(1)</script>\n');
        assert.match(blocks[0]?.html ?? '', /<script>/);
    });

    it('finds the block for an editor line', () => {
        const blocks = [{ line: 1 }, { line: 5 }, { line: 9 }];
        assert.equal(blockIndexForLine(blocks, 1), 0);
        assert.equal(blockIndexForLine(blocks, 4), 0);
        assert.equal(blockIndexForLine(blocks, 5), 1);
        assert.equal(blockIndexForLine(blocks, 100), 2);
        assert.equal(blockIndexForLine([], 3), 0);
    });

    it('slugs headings like GitHub', () => {
        const slug = headingSlugger();
        assert.equal(slug('Getting Started!'), 'getting-started');
        assert.equal(slug('Getting Started'), 'getting-started-1');
        assert.equal(slug('Añadir lenguajes'), 'añadir-lenguajes');
        assert.equal(slug('???'), 'section');
    });

    it('classifies links: anchors, files of the folder, http(s) and mailto, nothing else', () => {
        assert.deepEqual(resolveLink('docs/guide.md', '#install'), { kind: 'anchor', id: 'install' });
        assert.deepEqual(resolveLink('docs/guide.md', 'api.md#types'), { kind: 'file', path: 'docs/api.md', anchor: 'types' });
        assert.deepEqual(resolveLink('docs/guide.md', '../README.md'), { kind: 'file', path: 'README.md', anchor: null });
        assert.deepEqual(resolveLink('docs/guide.md', '/src/a%20b.ts'), { kind: 'file', path: 'src/a b.ts', anchor: null });
        assert.deepEqual(resolveLink('README.md', 'https://example.com/x'), { kind: 'external', url: 'https://example.com/x' });
        assert.deepEqual(resolveLink('README.md', 'mailto:a@b.c'), { kind: 'external', url: 'mailto:a@b.c' });
        for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '//evil.com/x', '../../outside.md', '', null]) {
            assert.deepEqual(resolveLink('docs/guide.md', href), { kind: 'none' }, String(href));
        }
    });

    it('classifies images: the folder, remote, inline raster data, nothing else', () => {
        assert.deepEqual(resolveImage('docs/guide.md', 'img/a.png'), { kind: 'workspace', path: 'docs/img/a.png' });
        assert.deepEqual(resolveImage('docs/guide.md', '../media/b.gif?raw=1'), { kind: 'workspace', path: 'media/b.gif' });
        assert.deepEqual(resolveImage('README.md', 'https://img.shields.io/x.svg'), { kind: 'remote', url: 'https://img.shields.io/x.svg' });
        assert.deepEqual(resolveImage('README.md', 'data:image/png;base64,AAAA'), { kind: 'data' });
        for (const src of ['data:image/svg+xml;base64,AAAA', 'file:///x.png', '../../x.png', '']) {
            assert.deepEqual(resolveImage('docs/guide.md', src), { kind: 'none' }, src);
        }
    });

    it('keeps relative paths inside the folder', () => {
        assert.equal(resolveRelativePath('a/b/c.md', './d.md'), 'a/b/d.md');
        assert.equal(resolveRelativePath('a/b/c.md', '..\\..\\e.md'), 'e.md');
        assert.equal(resolveRelativePath('a/c.md', '../../e.md'), null);
        assert.equal(resolveRelativePath('a/c.md', '..'), null);
    });

    it('knows Markdown files by extension', () => {
        assert.equal(isMarkdownPath('README.md'), true);
        assert.equal(isMarkdownPath('docs/Guide.MARKDOWN'), true);
        assert.equal(isMarkdownPath('src/md.ts'), false);
        assert.equal(isMarkdownPath('.md'), false);
        assert.equal(isMarkdownPath(null), false);
    });
});

describe('Markdown preview, main process (#179)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-markdown-'));
    const root = path.join(base, 'project');
    fs.mkdirSync(path.join(root, 'img'), { recursive: true });
    fs.writeFileSync(path.join(root, 'img', 'dot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(root, 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    fs.writeFileSync(path.join(base, 'outside.png'), Buffer.from([1]));
    after(() => fs.rmSync(base, { recursive: true, force: true }));

    it('inlines raster images of the folder only', async () => {
        const workspace = await Workspace.open(root);
        assert.equal(await workspace.readImage('img/dot.png'), 'data:image/png;base64,iVBORw==');
        assert.equal(await workspace.readImage('img/logo.svg'), null, 'no SVG');
        await assert.rejects(workspace.readImage('../outside.png'));
        assert.equal(imageMimeType('a/b.JPG'), 'image/jpeg');
        assert.equal(imageMimeType('a.b/c'), null);
        assert.ok(MAX_PREVIEW_IMAGE_BYTES >= 1024 * 1024);
    });

    it('opens only http, https and mailto links outside', () => {
        for (const url of ['https://example.com', 'http://localhost:3000/x', 'mailto:a@b.c']) {
            assert.equal(isOpenableExternalLink(url), true, url);
        }
        for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'not a url', 42, null, `https://x/${'a'.repeat(9000)}`]) {
            assert.equal(isOpenableExternalLink(url), false, String(url).slice(0, 30));
        }
    });
});

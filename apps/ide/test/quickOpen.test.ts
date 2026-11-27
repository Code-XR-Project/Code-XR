import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listWorkspaceFiles } from '../src/main/workspace/fileIndex.ts';
import { parseGitignore } from '../src/main/workspace/ignoreRules.ts';
import { paletteView, scoreFile, type PaletteContext } from '../src/renderer/commands/paletteModel.ts';
import { createQuickOpenFiles } from '../src/renderer/quickOpenFiles.ts';

async function tree(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'codexr-quickopen-'));
    for (const [relative, text] of Object.entries(files)) {
        const absolute = path.join(root, ...relative.split('/'));
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, text);
    }
    return root;
}

describe('workspace file index (#164)', () => {
    it('lists every file with / separators, shallow ones first, leaving out .git, node_modules and gitignored entries', async () => {
        const root = await tree({
            'README.md': '', 'src/a.ts': '', 'src/deep/b.ts': '', '.git/HEAD': '', 'node_modules/x/index.js': '',
            'build/out.js': '', 'logs/app.log': '', 'keep.log': '',
        });
        try {
            const index = await listWorkspaceFiles(root, parseGitignore('build/\n*.log\n!keep.log\n'));
            assert.equal(index.truncated, false);
            assert.deepEqual([...index.files].sort(), ['README.md', 'keep.log', 'src/a.ts', 'src/deep/b.ts']);
            assert.ok(index.files.indexOf('README.md') < index.files.indexOf('src/deep/b.ts'));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('stops at the limit and says so', async () => {
        const root = await tree({ 'a.txt': '', 'b.txt': '', 'c.txt': '', 'sub/d.txt': '' });
        try {
            const index = await listWorkspaceFiles(root, [], 2);
            assert.equal(index.truncated, true);
            assert.equal(index.files.length, 2);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('does not follow symbolic links out of the folder', async (context) => {
        const outside = await tree({ 'secret.txt': '' });
        const root = await tree({ 'inside.txt': '' });
        try {
            try {
                await symlink(outside, path.join(root, 'link'), 'junction');
            } catch {
                context.skip('symbolic links need privileges here');
                return;
            }
            const index = await listWorkspaceFiles(root, []);
            assert.deepEqual(index.files, ['inside.txt']);
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        }
    });
});

describe('quick open (#164)', () => {
    const files = [
        'src/renderer/editor/editorGroup.ts',
        'src/renderer/editor/monaco.ts',
        'src/renderer/explorer.ts',
        'docs/everything-related-to-group-tests.md',
        'package.json',
    ];
    const context = (overrides: Partial<PaletteContext> = {}): PaletteContext => ({
        commands: [], isEnabled: () => true, recent: [], formatKey: (key) => key, lineCount: 10,
        hasFolder: true, files, recentFiles: [], activeFile: null, ...overrides,
    });

    it('ranks a match in the file name above one spread over the path', () => {
        const name = scoreFile('edgrp', 'src/renderer/editor/editorGroup.ts');
        const spread = scoreFile('edgrp', 'docs/everything-related-to-group-tests.md');
        assert.ok(name && name.highlights.length === 5);
        assert.ok(!spread || name.score > spread.score);
        assert.equal(paletteView('edgrp', context()).entries[0]?.id, 'src/renderer/editor/editorGroup.ts');
    });

    it('shows the name as the label and the folder as the description, with a file icon', () => {
        const entry = paletteView('monaco', context()).entries[0];
        assert.deepEqual([entry?.label, entry?.description, entry?.fileIcon], ['monaco.ts', 'src/renderer/editor', 'monaco.ts']);
        assert.deepEqual(paletteView('monaco', context()).action(entry!), { kind: 'file', path: 'src/renderer/editor/monaco.ts' });
    });

    it('puts the query typed as is inside a name before letters picked across words', () => {
        const typed = scoreFile('test', 'test/smoke.test.ts');
        const picked = scoreFile('test', 'src/main/terminal/terminalService.ts');
        assert.ok(typed && picked && typed.score > picked.score);
        assert.deepEqual(typed.highlights, [6, 7, 8, 9]);
        // At the start of the name wins over the middle.
        assert.ok(scoreFile('test', 'a/test-js.svg')!.score > typed.score);
    });

    it('lets the query name folders too', () => {
        assert.equal(paletteView('editor/mon', context()).entries[0]?.id, 'src/renderer/editor/monaco.ts');
    });

    it('lists recently opened files first while empty, without the active one, then the prefixes', () => {
        const view = paletteView('', context({ recentFiles: ['package.json', 'src/renderer/explorer.ts'], activeFile: 'package.json' }));
        assert.deepEqual(view.entries.map((entry) => entry.id), ['src/renderer/explorer.ts', 'help.commands', 'help.line', 'help.symbols', 'help.workspaceSymbols']);
        assert.equal(view.entries[0]?.group, 'recently opened');
    });

    it('says what is going on without a folder, while listing, and with no match', () => {
        assert.match(paletteView('x', context({ hasFolder: false })).empty, /Open a folder/);
        assert.match(paletteView('x', context({ files: null })).empty, /Listing/);
        assert.match(paletteView('zzzz', context()).empty, /No matching files/);
        assert.match(paletteView('zzzz', context({ filesTruncated: true })).empty, /very large folder/);
    });

    it('hands "@" to the editor at once, or explains why not', () => {
        assert.deepEqual(paletteView('@', context()).immediate, { kind: 'symbols' });
        assert.match(paletteView('@', context({ lineCount: null })).empty, /Open a file first/);
    });

    it('keeps the newest list, ignoring one that arrives after the folder changed', async () => {
        let resolveFirst: (value: { files: string[]; truncated: boolean }) => void = () => undefined;
        let calls = 0;
        let loaded = 0;
        const quickOpen = createQuickOpenFiles(() => {
            calls++;
            return calls === 1
                ? new Promise((resolve) => { resolveFirst = resolve; })
                : Promise.resolve({ files: ['new.ts'], truncated: false });
        }, () => { loaded++; });
        quickOpen.reload();
        quickOpen.reset();
        quickOpen.reload();
        await new Promise((resolve) => setImmediate(resolve));
        resolveFirst({ files: ['old.ts'], truncated: false });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(quickOpen.files(), ['new.ts']);
        assert.equal(loaded, 1);
        quickOpen.opened('a.ts');
        quickOpen.opened('b.ts');
        quickOpen.opened('a.ts');
        assert.deepEqual(quickOpen.recent(), ['a.ts', 'b.ts']);
    });
});

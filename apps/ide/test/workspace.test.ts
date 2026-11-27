import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_EDITOR_FILE_BYTES, Workspace } from '../src/main/workspace/workspace.ts';
import { MODIFIED_ON_DISK } from '../src/shared/api.ts';

let base: string;
let root: string;
let outside: string;

function write(relative: string, content: string | Buffer): void {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

/** Creates a symlink, or returns false where the OS refuses (Windows without the privilege). */
function trySymlink(target: string, linkRelative: string, type: 'file' | 'dir'): boolean {
    try {
        fs.symlinkSync(target, path.join(root, linkRelative), type === 'dir' && process.platform === 'win32' ? 'junction' : type);
        return true;
    } catch {
        return false;
    }
}

before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-workspace-'));
    root = path.join(base, 'project');
    outside = path.join(base, 'secret');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'key.txt'), 'top secret');
    write('.gitignore', 'dist/\n*.log\n');
    write('src/main.ts', 'export {};\n');
    write('src/util10.ts', '');
    write('src/util2.ts', '');
    write('README.md', '# hi\n');
    write('debug.log', 'x');
    write('dist/bundle.js', '');
    write('node_modules/pkg/index.js', '');
    write('.git/HEAD', 'ref: refs/heads/main\n');
    write('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
});

/** Removes a link only, never its target (a junction is a directory to unlink on Windows). */
function removeLink(linkRelative: string): void {
    const link = path.join(root, linkRelative);
    try {
        fs.unlinkSync(link);
    } catch {
        fs.rmdirSync(link);
    }
}

after(() => {
    fs.rmSync(base, { recursive: true, force: true });
});

describe('Workspace', () => {
    it('gives an entry path for the clipboard, never one outside the folder (#167)', async () => {
        const workspace = await Workspace.open(root);
        assert.equal(workspace.displayPath('src/index.ts', 'absolute'), path.join(path.resolve(root), 'src', 'index.ts'));
        assert.equal(workspace.displayPath('src/index.ts', 'relative'), ['src', 'index.ts'].join(path.sep));
        assert.throws(() => workspace.displayPath('../outside.txt', 'absolute'));
        assert.throws(() => workspace.displayPath('/etc/passwd', 'relative'));
        assert.throws(() => workspace.displayPath('src/index.ts', 'other'));
    });

    it('lists folders first, then files, in natural order, without .git and node_modules', async () => {
        const workspace = await Workspace.open(root);
        const entries = await workspace.listDirectory('');
        assert.deepEqual(entries.map((e) => e.name), ['dist', 'src', '.gitignore', 'debug.log', 'image.png', 'README.md']);
        assert.deepEqual((await workspace.listDirectory('src')).map((e) => e.path), ['src/main.ts', 'src/util2.ts', 'src/util10.ts']);
        assert.equal(workspace.info.name, 'project');
    });

    it('marks .gitignore matches instead of hiding them', async () => {
        const workspace = await Workspace.open(root);
        const byName = new Map((await workspace.listDirectory('')).map((e) => [e.name, e]));
        assert.equal(byName.get('dist')?.ignored, true);
        assert.equal(byName.get('debug.log')?.ignored, true);
        assert.equal(byName.get('src')?.ignored, false);
    });

    it('reads text, and reports binary and oversized files without sending them', async () => {
        const workspace = await Workspace.open(root);
        const text = await workspace.readFile('src/main.ts');
        assert.equal(text.kind, 'text');
        assert.equal(text.kind === 'text' && text.text, 'export {};\n');
        assert.equal((await workspace.readFile('image.png')).kind, 'binary');
        write('big.txt', Buffer.alloc(MAX_EDITOR_FILE_BYTES + 1, 0x61));
        const big = await workspace.readFile('big.txt');
        assert.equal(big.kind, 'too-large');
        fs.rmSync(path.join(root, 'big.txt'));
    });

    it('refuses paths that leave the folder', async () => {
        const workspace = await Workspace.open(root);
        await assert.rejects(() => workspace.readFile('../secret/key.txt'));
        await assert.rejects(() => workspace.listDirectory('..'));
        await assert.rejects(() => workspace.readFile(path.join(outside, 'key.txt')));
        await assert.rejects(() => workspace.readFile('src'), /Not a file/);
    });

    it('does not follow a symlink out of the folder', async (t) => {
        if (!trySymlink(outside, 'escape', 'dir')) {
            t.skip('symlinks are not available here');
            return;
        }
        const workspace = await Workspace.open(root);
        assert.ok(!(await workspace.listDirectory('')).some((e) => e.name === 'escape'), 'an escaping link is listed');
        await assert.rejects(() => workspace.readFile('escape/key.txt'), /leaves the workspace/);
        await assert.rejects(() => workspace.listDirectory('escape'), /leaves the workspace/);
        removeLink('escape');
        assert.ok(fs.existsSync(path.join(outside, 'key.txt')), 'removing the link touched its target');
    });

    it('follows a symlink that stays inside', async (t) => {
        if (!trySymlink(path.join(root, 'src'), 'src-link', 'dir')) {
            t.skip('symlinks are not available here');
            return;
        }
        const workspace = await Workspace.open(root);
        const link = (await workspace.listDirectory('')).find((e) => e.name === 'src-link');
        assert.equal(link?.kind, 'directory');
        assert.equal((await workspace.readFile('src-link/main.ts')).kind, 'text');
        removeLink('src-link');
    });

    it('saves an existing file and returns its new modification time', async () => {
        write('notes.txt', 'v1');
        const workspace = await Workspace.open(root);
        const read = await workspace.readFile('notes.txt');
        assert.equal(read.kind, 'text');
        const saved = await workspace.writeFile('notes.txt', 'v2 é', read.kind === 'text' ? read.mtimeMs : undefined);
        assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'v2 é');
        assert.equal(saved.mtimeMs, fs.statSync(path.join(root, 'notes.txt')).mtimeMs);
    });

    it('refuses to overwrite a file that changed on disk since it was read', async () => {
        write('shared.txt', 'theirs');
        const workspace = await Workspace.open(root);
        const stale = fs.statSync(path.join(root, 'shared.txt')).mtimeMs - 1000;
        await assert.rejects(() => workspace.writeFile('shared.txt', 'mine', stale), new RegExp(MODIFIED_ON_DISK));
        assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'theirs');
    });

    it('refuses bad writes: a folder, a missing file, outside the folder, non-text, too large', async () => {
        const workspace = await Workspace.open(root);
        await assert.rejects(() => workspace.writeFile('src', 'x'), /Not a file/);
        await assert.rejects(() => workspace.writeFile('missing.txt', 'x'));
        await assert.rejects(() => workspace.writeFile('../secret/key.txt', 'x'));
        await assert.rejects(() => workspace.writeFile('README.md', 42), /must be a string/);
        await assert.rejects(() => workspace.writeFile('README.md', 'x', 'yesterday'), /must be a number/);
        await assert.rejects(() => workspace.writeFile('README.md', 'a'.repeat(MAX_EDITOR_FILE_BYTES + 1)), /too large/);
        assert.equal(fs.readFileSync(path.join(outside, 'key.txt'), 'utf8'), 'top secret');
        assert.ok(!fs.existsSync(path.join(root, 'missing.txt')), 'a save created a file');
    });

    it('validates the watched entries before watching anything', async () => {
        const workspace = await Workspace.open(root);
        const noop = (): void => {};
        try {
            assert.throws(() => workspace.setWatched('src', noop), /array/);
            assert.throws(() => workspace.setWatched(new Array(10_001).fill({ path: '', kind: 'directory' }), noop), /array/);
            assert.throws(() => workspace.setWatched([{ path: 'src' }], noop), /path and a kind/);
            assert.throws(() => workspace.setWatched([{ path: 3, kind: 'file' }], noop), /path and a kind/);
            assert.throws(() => workspace.setWatched([{ path: '../secret', kind: 'directory' }], noop));
            assert.doesNotThrow(() => workspace.setWatched([{ path: '', kind: 'directory' }, { path: 'src/main.ts', kind: 'file' }], noop));
        } finally {
            workspace.dispose();
        }
    });

    it('creates files and folders without ever overwriting', async () => {
        const workspace = await Workspace.open(root);
        assert.equal(await workspace.createEntry('src', 'created.ts', 'file'), 'src/created.ts');
        assert.equal(fs.readFileSync(path.join(root, 'src', 'created.ts'), 'utf8'), '');
        assert.equal(await workspace.createEntry('', 'newdir', 'directory'), 'newdir');
        assert.ok(fs.statSync(path.join(root, 'newdir')).isDirectory());
        await assert.rejects(() => workspace.createEntry('', 'README.md', 'file'), /already exists/);
        await assert.rejects(() => workspace.createEntry('', 'src', 'directory'), /already exists/);
        assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# hi\n');
        await assert.rejects(() => workspace.createEntry('', 'node_modules', 'directory'), /hidden by the explorer/);
        await assert.rejects(() => workspace.createEntry('', 'a/b', 'file'), /valid name/);
        await assert.rejects(() => workspace.createEntry('README.md', 'x', 'file'), /Not a folder/);
        await assert.rejects(() => workspace.createEntry('../secret', 'x', 'file'));
        await assert.rejects(() => workspace.createEntry('', 'x', 'symlink'), /kind/);
        assert.ok(!fs.existsSync(path.join(outside, 'x')));
    });

    it('renames within the folder, refusing a taken name, the root and outside paths', async () => {
        const workspace = await Workspace.open(root);
        write('ren/one.txt', '1');
        write('ren/two.txt', '2');
        assert.equal(await workspace.rename('ren/one.txt', 'uno.txt'), 'ren/uno.txt');
        assert.equal(fs.readFileSync(path.join(root, 'ren', 'uno.txt'), 'utf8'), '1');
        await assert.rejects(() => workspace.rename('ren/uno.txt', 'two.txt'), /already exists/);
        assert.equal(fs.readFileSync(path.join(root, 'ren', 'two.txt'), 'utf8'), '2');
        assert.equal(await workspace.rename('ren/uno.txt', 'UNO.txt'), 'ren/UNO.txt');
        assert.deepEqual(fs.readdirSync(path.join(root, 'ren')).sort(), ['UNO.txt', 'two.txt']);
        assert.equal(await workspace.rename('ren', 'renamed'), 'renamed');
        await assert.rejects(() => workspace.rename('', 'x'), /cannot be renamed/);
        await assert.rejects(() => workspace.rename('../secret', 'x'));
        await assert.rejects(() => workspace.rename('missing.txt', 'x.txt'));
        await assert.rejects(() => workspace.rename('renamed/two.txt', 'CON'), /reserved/);
    });

    it('trashes through the injected function only, never the root or outside', async () => {
        const workspace = await Workspace.open(root);
        write('bin/old.txt', 'x');
        const trashed: string[] = [];
        const trashItem = async (absolute: string): Promise<void> => { trashed.push(absolute); };
        await workspace.trash('bin/old.txt', trashItem);
        assert.deepEqual(trashed, [path.join(fs.realpathSync.native(root), 'bin', 'old.txt')]);
        await assert.rejects(() => workspace.trash('', trashItem), /cannot be renamed or deleted/);
        await assert.rejects(() => workspace.trash('../secret/key.txt', trashItem));
        await assert.rejects(() => workspace.trash('bin/missing.txt', trashItem));
        assert.equal(trashed.length, 1);
    });

    it('trashes a symlink as a link, never its target', async (t) => {
        const workspace = await Workspace.open(root);
        if (!trySymlink(path.join(outside, 'key.txt'), 'trash-link.txt', 'file')) {
            t.skip('symlinks are not available here');
            return;
        }
        const trashed: string[] = [];
        await workspace.trash('trash-link.txt', async (absolute) => { trashed.push(absolute); });
        assert.deepEqual(trashed, [path.join(fs.realpathSync.native(root), 'trash-link.txt')]);
        removeLink('trash-link.txt');
    });

    it('refuses to open a file as a folder', async () => {
        await assert.rejects(() => Workspace.open(path.join(root, 'README.md')), /Not a folder/);
    });
});

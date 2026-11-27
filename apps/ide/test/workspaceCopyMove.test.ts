import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace/workspace.ts';

/** #285: copy, move, reveal and terminal folders of the explorer, at the workspace layer. */

let base: string;
let root: string;
let outside: string;

function write(relative: string, content: string): void {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function read(relative: string): string {
    return fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
}

function exists(relative: string): boolean {
    return fs.existsSync(path.join(root, ...relative.split('/')));
}

/** Creates a symlink, or returns false where the OS refuses (Windows without the privilege). */
function trySymlink(target: string, linkRelative: string, type: 'file' | 'dir'): boolean {
    try {
        fs.symlinkSync(target, path.join(root, ...linkRelative.split('/')), type === 'dir' && process.platform === 'win32' ? 'junction' : type);
        return true;
    } catch {
        return false;
    }
}

beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-copy-')));
    root = path.join(base, 'project');
    outside = path.join(base, 'secret');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'key.txt'), 'top secret');
    write('src/main.ts', 'main');
    write('src/lib/util.ts', 'util');
    write('docs/readme.md', 'docs');
    write('.env', 'X=1');
});

afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
});

describe('Workspace.copyEntry (#285)', () => {
    it('copies a file into another folder under its own name', async () => {
        const workspace = await Workspace.open(root);
        assert.equal(await workspace.copyEntry('src/main.ts', 'docs'), 'docs/main.ts');
        assert.equal(read('docs/main.ts'), 'main');
        assert.equal(read('src/main.ts'), 'main');
    });

    it('copies a folder with everything in it, to the top folder too', async () => {
        const workspace = await Workspace.open(root);
        assert.equal(await workspace.copyEntry('src', 'docs'), 'docs/src');
        assert.equal(read('docs/src/main.ts'), 'main');
        assert.equal(read('docs/src/lib/util.ts'), 'util');
        assert.equal(await workspace.copyEntry('docs/readme.md', ''), 'readme.md');
        assert.equal(read('readme.md'), 'docs');
    });

    it('names a copy over a taken name " copy", then " copy 2", keeping the extension', async () => {
        const workspace = await Workspace.open(root);
        assert.equal(await workspace.copyEntry('src/main.ts', 'src'), 'src/main copy.ts');
        assert.equal(await workspace.copyEntry('src/main.ts', 'src'), 'src/main copy 2.ts');
        assert.equal(await workspace.copyEntry('src/main copy.ts', 'src'), 'src/main copy 3.ts');
        assert.equal(read('src/main copy 2.ts'), 'main');
        assert.equal(await workspace.copyEntry('src/lib', 'src'), 'src/lib copy');
        assert.equal(await workspace.copyEntry('src/lib', 'src'), 'src/lib copy 2');
        assert.equal(read('src/lib copy 2/util.ts'), 'util');
        // A dotfile has no extension.
        assert.equal(await workspace.copyEntry('.env', ''), '.env copy');
        // Never overwritten.
        assert.equal(read('src/main.ts'), 'main');
    });

    it('refuses a folder pasted into itself or below itself', async () => {
        const workspace = await Workspace.open(root);
        await assert.rejects(() => workspace.copyEntry('src', 'src'), /into itself/);
        await assert.rejects(() => workspace.copyEntry('src', 'src/lib'), /into itself/);
        assert.deepEqual(fs.readdirSync(path.join(root, 'src')).sort(), ['lib', 'main.ts']);
        // Duplicating a folder beside itself is fine.
        assert.equal(await workspace.copyEntry('src', ''), 'src copy');
    });

    it('refuses `..`, absolute paths, the root and a file as the target folder', async () => {
        const workspace = await Workspace.open(root);
        await assert.rejects(() => workspace.copyEntry('../secret/key.txt', ''), /Invalid workspace path/);
        await assert.rejects(() => workspace.copyEntry('src/main.ts', '../secret'), /Invalid workspace path/);
        await assert.rejects(() => workspace.copyEntry(path.join(outside, 'key.txt'), ''));
        await assert.rejects(() => workspace.copyEntry('', 'docs'), /cannot be renamed, moved, copied/);
        await assert.rejects(() => workspace.copyEntry('src/main.ts', 'docs/readme.md'), /Not a folder/);
        await assert.rejects(() => workspace.copyEntry('missing.txt', 'docs'));
        assert.deepEqual(fs.readdirSync(outside), ['key.txt']);
    });

    it('refuses a symlink that leads out, at either end', async (t) => {
        const workspace = await Workspace.open(root);
        if (!trySymlink(path.join(outside, 'key.txt'), 'key-link.txt', 'file') || !trySymlink(outside, 'out', 'dir')) {
            t.skip('symlinks are not available here');
            return;
        }
        await assert.rejects(() => workspace.copyEntry('key-link.txt', 'docs'), /leaves the workspace/);
        await assert.rejects(() => workspace.copyEntry('src/main.ts', 'out'), /leaves the workspace/);
        assert.ok(!exists('docs/key-link.txt'));
        assert.deepEqual(fs.readdirSync(outside), ['key.txt']);
    });

    it('leaves out a link inside a copied folder that leads out, and copies one that stays in', async (t) => {
        const workspace = await Workspace.open(root);
        if (!trySymlink(path.join(outside, 'key.txt'), 'src/key-link.txt', 'file') || !trySymlink(path.join(root, 'docs', 'readme.md'), 'src/readme-link.md', 'file')) {
            t.skip('symlinks are not available here');
            return;
        }
        assert.equal(await workspace.copyEntry('src', 'docs'), 'docs/src');
        assert.ok(!exists('docs/src/key-link.txt'));
        assert.equal(read('docs/src/readme-link.md'), 'docs');
    });

    it('refuses a copy over the entry or size limit, writing nothing', async () => {
        const workspace = await Workspace.open(root);
        await assert.rejects(() => workspace.copyEntry('src', 'docs', { maxEntries: 3, maxBytes: 1024 }), /more than 3 files and folders/);
        await assert.rejects(() => workspace.copyEntry('src', 'docs', { maxEntries: 100, maxBytes: 5 }), /larger than/);
        await assert.rejects(() => workspace.copyEntry('src/main.ts', 'docs', { maxEntries: 100, maxBytes: 2 }), /larger than/);
        assert.deepEqual(fs.readdirSync(path.join(root, 'docs')), ['readme.md']);
        // The same copy under the limit goes through (src, main.ts, lib, util.ts).
        assert.equal(await workspace.copyEntry('src', 'docs', { maxEntries: 4, maxBytes: 1024 }), 'docs/src');
    });
});

describe('Workspace.moveEntry (#285)', () => {
    it('moves a file and a folder into another folder', async () => {
        const workspace = await Workspace.open(root);
        assert.equal(await workspace.moveEntry('src/main.ts', 'docs'), 'docs/main.ts');
        assert.equal(read('docs/main.ts'), 'main');
        assert.ok(!exists('src/main.ts'));
        assert.equal(await workspace.moveEntry('src/lib', ''), 'lib');
        assert.equal(read('lib/util.ts'), 'util');
        assert.ok(!exists('src/lib'));
    });

    it('changes nothing when moved into the folder it is in', async () => {
        const workspace = await Workspace.open(root);
        assert.equal(await workspace.moveEntry('src/main.ts', 'src'), 'src/main.ts');
        assert.equal(read('src/main.ts'), 'main');
    });

    it('refuses a taken name, never overwriting', async () => {
        const workspace = await Workspace.open(root);
        write('docs/main.ts', 'other');
        await assert.rejects(() => workspace.moveEntry('src/main.ts', 'docs'), /already exists/);
        assert.equal(read('docs/main.ts'), 'other');
        assert.equal(read('src/main.ts'), 'main');
    });

    it('refuses a folder moved into itself or below itself, and the root', async () => {
        const workspace = await Workspace.open(root);
        await assert.rejects(() => workspace.moveEntry('src', 'src/lib'), /into itself/);
        await assert.rejects(() => workspace.moveEntry('', 'docs'), /cannot be renamed, moved, copied/);
        assert.equal(read('src/lib/util.ts'), 'util');
    });

    it('refuses `..` and a symlink that leads out', async (t) => {
        const workspace = await Workspace.open(root);
        await assert.rejects(() => workspace.moveEntry('../secret/key.txt', ''), /Invalid workspace path/);
        await assert.rejects(() => workspace.moveEntry('src/main.ts', '..'), /Invalid workspace path/);
        if (!trySymlink(outside, 'out', 'dir')) {
            t.skip('symlinks are not available here');
            return;
        }
        await assert.rejects(() => workspace.moveEntry('src/main.ts', 'out'), /leaves the workspace/);
        await assert.rejects(() => workspace.moveEntry('out/key.txt', ''), /leaves the workspace/);
        assert.equal(read('src/main.ts'), 'main');
        assert.deepEqual(fs.readdirSync(outside), ['key.txt']);
    });
});

describe('Workspace.revealablePath and terminalFolder (#285)', () => {
    it('resolves inside the folder: a folder itself, a file to its folder', async () => {
        const workspace = await Workspace.open(root);
        assert.equal(await workspace.revealablePath('src/main.ts'), path.join(root, 'src', 'main.ts'));
        assert.equal(await workspace.revealablePath(''), root);
        assert.equal(await workspace.terminalFolder('src/lib'), path.join(root, 'src', 'lib'));
        assert.equal(await workspace.terminalFolder('src/main.ts'), path.join(root, 'src'));
        assert.equal(await workspace.terminalFolder(''), root);
    });

    it('refuses `..` and a symlink that leads out', async (t) => {
        const workspace = await Workspace.open(root);
        await assert.rejects(() => workspace.revealablePath('../secret'), /Invalid workspace path/);
        await assert.rejects(() => workspace.terminalFolder('../secret'), /Invalid workspace path/);
        if (!trySymlink(outside, 'out', 'dir')) {
            t.skip('symlinks are not available here');
            return;
        }
        await assert.rejects(() => workspace.revealablePath('out'), /leaves the workspace/);
        await assert.rejects(() => workspace.terminalFolder('out'), /leaves the workspace/);
    });
});

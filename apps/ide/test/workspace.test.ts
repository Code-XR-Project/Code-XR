import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_EDITOR_FILE_BYTES, Workspace } from '../src/main/workspace/workspace.ts';

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

    it('refuses to open a file as a folder', async () => {
        await assert.rejects(() => Workspace.open(path.join(root, 'README.md')), /Not a folder/);
    });
});

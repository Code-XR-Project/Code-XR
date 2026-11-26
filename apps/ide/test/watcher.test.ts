import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceWatcher, foldersToWatch } from '../src/main/workspace/watcher.ts';

let base: string;
let root: string;

before(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-watcher-')));
    root = path.join(base, 'project');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(base, 'outside'));
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export {};\n');
});

after(() => {
    fs.rmSync(base, { recursive: true, force: true });
});

/** Collects every batch the watcher reports, and waits for one that satisfies `done`. */
function recorder(): { onChange(paths: readonly string[]): void; until(done: (seen: Set<string>) => boolean, ms?: number): Promise<Set<string>> } {
    const seen = new Set<string>();
    let wake: (() => void) | null = null;
    return {
        onChange(paths) {
            for (const p of paths) { seen.add(p); }
            wake?.();
        },
        async until(done, ms = 3000) {
            const deadline = Date.now() + ms;
            while (!done(seen) && Date.now() < deadline) {
                await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 50); });
            }
            return seen;
        },
    };
}

describe('foldersToWatch', () => {
    it('watches folders themselves and the parent of each file, once', () => {
        assert.deepEqual(foldersToWatch([
            { path: '', kind: 'directory' },
            { path: 'src', kind: 'directory' },
            { path: 'src/main.ts', kind: 'file' },
            { path: 'README.md', kind: 'file' },
            { path: 'docs/a/b.md', kind: 'file' },
        ]), ['', 'docs/a', 'src']);
    });

    it('refuses paths that leave the workspace', () => {
        assert.throws(() => foldersToWatch([{ path: '../outside', kind: 'directory' }]));
    });
});

describe('WorkspaceWatcher', () => {
    it('reports a changed file with the folder that lists it, batched', async () => {
        const rec = recorder();
        const watcher = new WorkspaceWatcher(root, root, rec.onChange, 30);
        try {
            watcher.setFolders(['', 'src']);
            assert.deepEqual(watcher.watchedFolders, ['', 'src']);
            fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const x = 1;\n');
            fs.writeFileSync(path.join(root, 'src', 'new.ts'), '');
            const seen = await rec.until((s) => s.has('src/main.ts') && s.has('src/new.ts'));
            assert.ok(seen.has('src'), [...seen].join(', '));
            assert.ok(seen.has('src/main.ts'));
            assert.ok(seen.has('src/new.ts'));
        } finally {
            watcher.dispose();
        }
    });

    it('ignores .git and node_modules', async () => {
        const rec = recorder();
        const watcher = new WorkspaceWatcher(root, root, rec.onChange, 30);
        try {
            watcher.setFolders(['']);
            fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), '');
            fs.mkdirSync(path.join(root, '.git'), { recursive: true });
            const seen = await rec.until(() => false, 300);
            assert.ok(![...seen].some((p) => p.startsWith('node_modules') || p.startsWith('.git')), [...seen].join(', '));
        } finally {
            watcher.dispose();
        }
    });

    it('drops folders no longer wanted and skips ones that do not exist', () => {
        const watcher = new WorkspaceWatcher(root, root, () => {}, 30);
        try {
            watcher.setFolders(['', 'src', 'missing']);
            assert.deepEqual(watcher.watchedFolders, ['', 'src']);
            watcher.setFolders(['src']);
            assert.deepEqual(watcher.watchedFolders, ['src']);
        } finally {
            watcher.dispose();
        }
        assert.deepEqual(watcher.watchedFolders, []);
    });

    it('never watches a folder whose real path leaves the workspace', (t) => {
        try {
            fs.symlinkSync(path.join(base, 'outside'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            t.skip('symlinks are not available here');
            return;
        }
        const watcher = new WorkspaceWatcher(root, root, () => {}, 30);
        try {
            watcher.setFolders(['link', 'src']);
            assert.deepEqual(watcher.watchedFolders, ['src']);
        } finally {
            watcher.dispose();
            fs.rmSync(path.join(root, 'link'), { force: true, recursive: false });
        }
    });
});

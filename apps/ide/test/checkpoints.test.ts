import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CheckpointStore, normalizeProjectPath, shadowRepoName } from '../src/main/checkpoints/checkpointStore.ts';
import {
    baseFor, basesToQuery, createReviewBase, keepAll, keepFile, keepFiles, mergePendingChanges, parseReviewBase, serializeReviewBase,
} from '../src/main/checkpoints/reviewBase.ts';

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-checkpoints-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

let counter = 0;

/** A fresh project folder with `files`, and a store whose shadow repos live outside it. */
function project(files: Record<string, string | Buffer>, options: { maxFiles?: number; maxFileBytes?: number } = {}): { root: string; store: CheckpointStore } {
    counter += 1;
    const root = path.join(base, `project-${counter}`);
    for (const [relative, content] of Object.entries(files)) {
        write(root, relative, content);
    }
    fs.mkdirSync(root, { recursive: true });
    const store = new CheckpointStore({ storageDir: path.join(base, 'storage'), projectRoot: root, ...options });
    return { root, store };
}

function write(root: string, relative: string, content: string | Buffer): void {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function read(root: string, relative: string): string | null {
    const target = path.join(root, ...relative.split('/'));
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
}

function realGit(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

async function snapshotOrFail(store: CheckpointStore, label: string): Promise<string> {
    const checkpoint = await store.snapshot(label);
    assert.ok(checkpoint, `snapshot "${label}" returned null: ${store.disabledReason ?? ''}`);
    return checkpoint.id;
}

describe('CheckpointStore: snapshots and changes', () => {
    it('lists added, modified and deleted files with line counts', async () => {
        const { root, store } = project({ 'a.txt': 'one\ntwo\nthree\n', 'src/b.ts': 'export const b = 1;\n', 'gone.md': 'bye\n' });
        const checkpoint = await store.snapshot('Before prompt 1');
        assert.ok(checkpoint);
        assert.match(checkpoint.id, /^[0-9a-f]{40,64}$/);
        assert.equal(checkpoint.label, 'Before prompt 1');
        assert.equal(checkpoint.fileCount, 3);
        assert.equal(typeof checkpoint.createdAt, 'number');

        write(root, 'a.txt', 'one\nTWO\nthree\nfour\n');
        write(root, 'new/c.txt', 'c\n');
        fs.rmSync(path.join(root, 'gone.md'));
        write(root, 'image.bin', Buffer.from([0, 1, 2, 0, 255]));

        const changes = await store.changes(checkpoint.id);
        assert.deepEqual(changes, [
            { path: 'a.txt', status: 'modified', additions: 2, deletions: 1, binary: false },
            { path: 'gone.md', status: 'deleted', additions: 0, deletions: 1, binary: false },
            { path: 'image.bin', status: 'added', additions: 0, deletions: 0, binary: true },
            { path: 'new/c.txt', status: 'added', additions: 1, deletions: 0, binary: false },
        ]);
        assert.deepEqual(await store.changes(await snapshotOrFail(store, 'now')), []);
    });

    it('reads a file at a checkpoint and the diff text against disk', async () => {
        const { root, store } = project({ 'a.txt': 'old\n' });
        const id = await snapshotOrFail(store, 'one');
        write(root, 'a.txt', 'new\n');
        write(root, 'b.txt', 'b\n');
        assert.equal(await store.fileAt(id, 'a.txt'), 'old\n');
        assert.equal(await store.fileAt(id, 'b.txt'), null);
        assert.deepEqual(await store.diffText(id, 'a.txt'), { oldText: 'old\n', newText: 'new\n' });
        assert.deepEqual(await store.diffText(id, 'b.txt'), { oldText: null, newText: 'b\n' });
        fs.rmSync(path.join(root, 'a.txt'));
        assert.deepEqual(await store.diffText(id, 'a.txt'), { oldText: 'old\n', newText: null });
    });

    it('chains checkpoints and keeps them in a shadow repository outside the project', async () => {
        const { root, store } = project({ 'a.txt': 'a\n' });
        const first = await snapshotOrFail(store, 'first');
        const second = await snapshotOrFail(store, 'second');
        assert.notEqual(first, second);
        assert.equal(path.basename(store.gitDir), shadowRepoName(root));
        assert.ok(!store.gitDir.startsWith(root + path.sep));
        assert.ok(!fs.existsSync(path.join(root, '.git')));
        const parent = execFileSync('git', ['--git-dir', store.gitDir, 'rev-parse', `${second}^`], { encoding: 'utf8' }).trim();
        assert.equal(parent, first);
    });

    it('refuses bad ids and paths that leave the project', async () => {
        const { store } = project({ 'a.txt': 'a\n' });
        const id = await snapshotOrFail(store, 'one');
        await assert.rejects(store.changes('--output=/tmp/x'), /Not a checkpoint id/);
        await assert.rejects(store.changes('a'.repeat(40)), /does not exist/);
        await assert.rejects(store.restoreFiles(id, ['../outside.txt']), /cannot leave the project/);
        await assert.rejects(store.restoreFiles(id, ['.git/config']), /\.git folder/);
        await assert.rejects(store.fileAt(id, '/etc/passwd'), /relative to the project/);
        assert.equal(normalizeProjectPath('.\\src\\a.ts'), 'src/a.ts');
    });
});

describe('CheckpointStore: restore', () => {
    it('restoreFiles puts content back, deletes added files and recreates deleted ones', async () => {
        const { root, store } = project({ 'a.txt': 'original\n', 'keep/b.txt': 'b\n', 'other.txt': 'other\n' });
        const id = await snapshotOrFail(store, 'one');
        write(root, 'a.txt', 'agent edit\n');
        write(root, 'added/deep/x.txt', 'x\n');
        fs.rmSync(path.join(root, 'keep', 'b.txt'));
        write(root, 'other.txt', 'user edit\n');

        await store.restoreFiles(id, ['a.txt', 'added/deep/x.txt', 'keep/b.txt']);
        assert.equal(read(root, 'a.txt'), 'original\n');
        assert.equal(read(root, 'added/deep/x.txt'), null);
        assert.ok(!fs.existsSync(path.join(root, 'added')), 'folders left empty are removed');
        assert.equal(read(root, 'keep/b.txt'), 'b\n');
        assert.equal(read(root, 'other.txt'), 'user edit\n', 'a path not named is left alone');
        assert.deepEqual((await store.changes(id)).map((change) => change.path), ['other.txt']);
    });

    it('restoreAll previews, then restores every changed file', async () => {
        const { root, store } = project({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
        const id = await snapshotOrFail(store, 'one');
        write(root, 'a.txt', 'A\n');
        fs.rmSync(path.join(root, 'b.txt'));
        write(root, 'd.txt', 'd\n');

        assert.deepEqual(await store.previewRestore(id), ['a.txt', 'b.txt', 'd.txt']);
        assert.equal(read(root, 'a.txt'), 'A\n', 'a preview writes nothing');
        assert.deepEqual(await store.restoreAll(id), ['a.txt', 'b.txt', 'd.txt']);
        assert.equal(read(root, 'a.txt'), 'a\n');
        assert.equal(read(root, 'b.txt'), 'b\n');
        assert.equal(read(root, 'c.txt'), 'c\n');
        assert.equal(read(root, 'd.txt'), null);
        assert.deepEqual(await store.changes(id), []);
        assert.deepEqual(await store.restoreAll(id), []);
    });

    it('keeps CRLF bytes, even when the project asks git to normalize line endings', async () => {
        const crlf = Buffer.from('line one\r\nline two\r\n');
        const { root, store } = project({ 'win.txt': crlf, 'mixed.txt': Buffer.from('a\r\nb\nc\r\n'), '.gitattributes': '* text=auto eol=lf\n' });
        const id = await snapshotOrFail(store, 'one');
        write(root, 'win.txt', 'rewritten\n');
        write(root, 'mixed.txt', 'rewritten\n');
        await store.restoreAll(id);
        assert.deepEqual(fs.readFileSync(path.join(root, 'win.txt')), crlf);
        assert.deepEqual(fs.readFileSync(path.join(root, 'mixed.txt')), Buffer.from('a\r\nb\nc\r\n'));
        assert.equal(await store.fileAt(id, 'win.txt'), 'line one\r\nline two\r\n');
    });

    it('keeps the executable bit', { skip: process.platform === 'win32' }, async () => {
        const { root, store } = project({ 'run.sh': '#!/bin/sh\necho hi\n' });
        fs.chmodSync(path.join(root, 'run.sh'), 0o755);
        const id = await snapshotOrFail(store, 'one');
        fs.rmSync(path.join(root, 'run.sh'));
        await store.restoreAll(id);
        assert.equal(fs.statSync(path.join(root, 'run.sh')).mode & 0o111, 0o111);
    });
});

describe('CheckpointStore: what is not snapshotted', () => {
    it('skips gitignored files, node_modules, the default excludes, .git/info/exclude and large files', async () => {
        const { root, store } = project({
            '.gitignore': 'secret.env\ncache/\n',
            'src/app.ts': 'app\n',
            'secret.env': 'TOKEN=1\n',
            'cache/blob.txt': 'cached\n',
            'node_modules/pkg/index.js': 'module\n',
            'dist/bundle.js': 'bundle\n',
            'server.log': 'log\n',
            'local-only.txt': 'local\n',
            'huge.bin': Buffer.alloc(2048, 1),
        }, { maxFileBytes: 1024 });
        realGit(root, 'init', '-q');
        fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), 'local-only.txt\n');

        const id = await snapshotOrFail(store, 'one');
        const tracked = execFileSync('git', ['--git-dir', store.gitDir, 'ls-tree', '-r', '--name-only', id], { encoding: 'utf8' }).trim().split('\n').sort();
        assert.deepEqual(tracked, ['.gitignore', 'src/app.ts']);

        write(root, 'node_modules/pkg/index.js', 'changed\n');
        write(root, 'secret.env', 'TOKEN=2\n');
        assert.deepEqual(await store.changes(id), []);
        assert.deepEqual(await store.restoreAll(id), []);
        assert.equal(read(root, 'secret.env'), 'TOKEN=2\n', 'an ignored file is never touched by a restore');
    });

    it('leaves a project that is itself a git repository byte-identical', async () => {
        const { root, store } = project({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
        realGit(root, 'init', '-q', '-b', 'main');
        realGit(root, 'add', '.');
        realGit(root, 'commit', '-q', '-m', 'initial');
        write(root, 'a.txt', 'staged\n');
        realGit(root, 'add', 'a.txt');
        write(root, 'b.txt', 'unstaged\n');
        write(root, 'untracked.txt', 'u\n');

        const dotGit = path.join(root, '.git');
        const fingerprint = (): string[] => [
            fs.readFileSync(path.join(dotGit, 'HEAD'), 'utf8'),
            fs.readFileSync(path.join(dotGit, 'index')).toString('base64'),
            fs.readFileSync(path.join(dotGit, 'config'), 'utf8'),
            realGit(root, 'rev-parse', 'HEAD'),
            realGit(root, 'status', '--porcelain=v2', '--untracked-files=all'),
            fs.readdirSync(path.join(dotGit, 'objects')).sort().join(','),
        ];
        // Status may refresh the stat cache of the real index once; measure after that.
        realGit(root, 'status');
        const before = fingerprint();

        const id = await snapshotOrFail(store, 'one');
        write(root, 'b.txt', 'agent\n');
        await store.changes(id);
        await store.restoreAll(id);
        assert.equal(read(root, 'b.txt'), 'unstaged\n');
        assert.deepEqual(fingerprint(), before);
    });

    it('excludes a nested repository instead of failing on it', async () => {
        const { root, store } = project({ 'a.txt': 'a\n', 'vendor/lib/x.txt': 'x\n', 'empty-repo/y.txt': 'y\n' });
        realGit(path.join(root, 'vendor', 'lib'), 'init', '-q');
        realGit(path.join(root, 'vendor', 'lib'), 'add', '.');
        realGit(path.join(root, 'vendor', 'lib'), 'commit', '-q', '-m', 'nested');
        // A nested repository without a commit makes a plain `git add -A` fail outright.
        realGit(path.join(root, 'empty-repo'), 'init', '-q');

        const id = await snapshotOrFail(store, 'one');
        const tracked = execFileSync('git', ['--git-dir', store.gitDir, 'ls-tree', '-r', '--name-only', id], { encoding: 'utf8' }).trim().split('\n');
        assert.deepEqual(tracked, ['a.txt']);
        write(root, 'a.txt', 'A\n');
        assert.deepEqual((await store.changes(id)).map((change) => change.path), ['a.txt']);
        assert.equal(realGit(path.join(root, 'vendor', 'lib'), 'status', '--porcelain'), '');
    });

    it('turns itself off past maxFiles, with a reason to show', async () => {
        const files: Record<string, string> = {};
        for (let index = 0; index < 6; index += 1) {
            files[`f${index}.txt`] = `${index}\n`;
        }
        const { store } = project(files, { maxFiles: 5 });
        assert.equal(await store.snapshot('one'), null);
        assert.equal(store.disabledReason, 'This project is too large for checkpoints (more than 5 files).');
        assert.equal(await store.snapshot('two'), null);
        await assert.rejects(store.previewRestore('a'.repeat(40)), /does not exist|too large/);
        store.clearDisabled();
        assert.equal(store.disabledReason, null);
    });
});

describe('CheckpointStore: concurrency and lifecycle', () => {
    it('serializes concurrent calls into a linear chain', async () => {
        const { root, store } = project({ 'a.txt': '0\n' });
        const results = await Promise.all(Array.from({ length: 6 }, (_, index) => {
            write(root, `file-${index}.txt`, `${index}\n`);
            return store.snapshot(`snapshot ${index}`);
        }));
        const ids = results.map((checkpoint) => checkpoint?.id);
        assert.equal(new Set(ids).size, 6);
        const log = execFileSync('git', ['--git-dir', store.gitDir, 'rev-list', 'refs/codexr/checkpoints'], { encoding: 'utf8' }).trim().split('\n');
        assert.deepEqual(log, [...ids].reverse());
    });

    it('serializes two stores of the same project', async () => {
        const { root, store } = project({ 'a.txt': 'a\n' });
        const twin = new CheckpointStore({ storageDir: path.join(base, 'storage'), projectRoot: root });
        const results = await Promise.all([store.snapshot('a'), twin.snapshot('b'), store.snapshot('c'), twin.snapshot('d')]);
        assert.ok(results.every((checkpoint) => checkpoint !== null));
    });

    it('refuses calls after dispose', async () => {
        const { store } = project({ 'a.txt': 'a\n' });
        await snapshotOrFail(store, 'one');
        await store.dispose();
        await assert.rejects(store.snapshot('two'), /disposed/);
    });

    it('reports a missing git executable clearly', async () => {
        counter += 1;
        const store = new CheckpointStore({ storageDir: path.join(base, 'storage'), projectRoot: path.join(base, `project-${counter}`), git: 'codexr-no-such-git' });
        await assert.rejects(store.snapshot('one'), /need git/);
    });
});

describe('reviewBase', () => {
    it('compares each file against its own base once kept', () => {
        let state = createReviewBase('base1');
        assert.equal(baseFor(state, 'a.ts'), 'base1');
        state = keepFile(state, 'a.ts', 'snap2');
        assert.equal(baseFor(state, 'a.ts'), 'snap2');
        assert.equal(baseFor(state, 'b.ts'), 'base1');
        assert.equal(baseFor(state, 'constructor'), 'base1');
        assert.deepEqual(basesToQuery(state), ['base1', 'snap2']);
        state = keepFiles(state, ['b.ts', 'c.ts'], 'snap3');
        assert.deepEqual(basesToQuery(state), ['base1', 'snap2', 'snap3']);
        assert.deepEqual(keepFile(state, 'a.ts', 'base1').fileBases, { 'b.ts': 'snap3', 'c.ts': 'snap3' });
        assert.deepEqual(keepAll(state, 'snap4'), { baseId: 'snap4', fileBases: {} });
    });

    it('merges per-base changes, each file from its own base', () => {
        const state = keepFile(createReviewBase('base1'), 'a.ts', 'snap2');
        const changes = new Map([
            ['base1', [{ path: 'b.ts', status: 'modified' }, { path: 'a.ts', status: 'modified' }]],
            ['snap2', [{ path: 'a.ts', status: 'added' }, { path: 'b.ts', status: 'deleted' }]],
        ]);
        assert.deepEqual(mergePendingChanges(state, changes), [{ path: 'a.ts', status: 'added' }, { path: 'b.ts', status: 'modified' }]);
    });

    it('round-trips through JSON and rejects malformed data', () => {
        const state = keepFile(createReviewBase('base1'), 'src/a.ts', 'snap2');
        assert.deepEqual(parseReviewBase(serializeReviewBase(state)), state);
        assert.deepEqual(parseReviewBase(JSON.parse(serializeReviewBase(state)) as unknown), state);
        assert.equal(parseReviewBase('{not json'), null);
        assert.equal(parseReviewBase({ baseId: 3 }), null);
        assert.equal(parseReviewBase({ baseId: 'b', fileBases: { 'a.ts': 4 } }), null);
        assert.equal(parseReviewBase({ baseId: 'b', fileBases: [] }), null);
        assert.deepEqual(parseReviewBase({ baseId: 'b' }), { baseId: 'b', fileBases: {} });
    });
});

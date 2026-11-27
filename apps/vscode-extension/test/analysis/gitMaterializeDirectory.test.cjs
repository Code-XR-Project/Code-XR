const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GitRepositoryService } = require('../../out/core/history/gitRepositoryService.js');
const { shouldMaterializeDirectoryFile } = require('../../out/core/history/gitSnapshotPlan.js');

// Characterization of GitRepositoryService.materializeDirectory (ROADMAP
// W4-T26, CX-11) with `git ls-tree` and the blob reader stubbed: which tree
// it asks for, which entries it copies, the warnings it collects, the two
// snapshot limits, and the folder it returns. historicalComparison.test.cjs
// covers the same path against a real repository. Since #106 the contents
// come from one `cat-file --batch` per revision (`openBlobSource`), not one
// `git show` per file.

const SHA = 'a'.repeat(40);
const crypto = require('node:crypto');
const blobOf = (repositoryPath) => crypto.createHash('sha1').update(repositoryPath).digest('hex');
const blob = (repositoryPath, size = 10, mode = '100644', type = 'blob') => `${mode} ${type} ${blobOf(repositoryPath)} ${String(size).padStart(7)}\t${repositoryPath}`;

const temps = [];
test.after(() => {
    for (const folder of temps) {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

async function materialize(targetRelativePath, entries, { exists = true } = {}) {
    const sourceDirectory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-materialize-')));
    temps.push(sourceDirectory);
    const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-materialize-store-'));
    temps.push(snapshotRoot);
    const service = new GitRepositoryService('/repo', snapshotRoot);
    const calls = [];
    const pathOfBlob = new Map(entries.map((entry) => [entry.split(/\s+/)[2], entry.split('\t')[1]]));
    service.openBlobSource = (cwd) => {
        calls.push(['cat-file --batch', cwd]);
        return {
            async read(blobSha) {
                calls.push(['read', pathOfBlob.get(blobSha)]);
                return Buffer.from(`content of ${pathOfBlob.get(blobSha)}`, 'utf8');
            },
            async dispose() {
                calls.push(['dispose']);
            },
        };
    };
    service.gitObjectExists = async (cwd, spec) => {
        calls.push(['exists', cwd, spec]);
        return exists;
    };
    service.runGitBuffer = async (cwd, args) => {
        calls.push([cwd, ...args]);
        if (args[0] === 'ls-tree') {
            return Buffer.from(entries.join('\0') + '\0', 'utf8');
        }
        return Buffer.from(`content of ${args[1]}`, 'utf8');
    };
    let result;
    try {
        result = await service.materializeDirectory('/repo', SHA, targetRelativePath, sourceDirectory);
    } catch (error) {
        result = { error: error.message };
    }
    const written = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                written.push(path.relative(sourceDirectory, full).split(path.sep).join('/'));
            }
        }
    };
    walk(sourceDirectory);
    return { result, calls, written: written.sort(), sourceDirectory };
}

test('a blob listed with no size is missing (partial clone): an error, not a silent skip', async () => {
    const { result, calls, written } = await materialize('.', [
        blob('src/a.py'),
        blob('docs/notes.bin', '-'),
        blob('src/old.py', '-'),
    ]);
    assert.match(result.error, /^git-object-missing:/);
    assert.deepEqual(written, []);
    assert.equal(calls.some((call) => call[0] === 'cat-file --batch'), false, 'nothing is copied before the plan is complete');
    // Git 2.5x prints BAD instead of - for the size of a missing blob.
    const recent = await materialize('.', [blob('src/a.py'), blob('src/old.py', 'BAD')]);
    assert.match(recent.result.error, /^git-object-missing:/);
});

test('repository root: copies analysable blobs, warns about submodules and oversized files', async () => {
    const { result, calls, written, sourceDirectory } = await materialize('.', [
        blob('src/a.py'),
        blob('src/deep/b.ts', 20),
        blob('vendor-module', '-', '160000', 'commit'),
        blob('README.md'),
        blob('node_modules/pkg/index.js'),
        blob('big.py', 8 * 1024 * 1024 + 1),
        blob('exact.py', 8 * 1024 * 1024),
        'not an ls-tree line',
    ]);
    assert.deepEqual(result, {
        targetPath: sourceDirectory,
        missingTarget: false,
        warnings: [
            'Skipped unsupported Git entry: vendor-module',
            'Skipped oversized file: big.py',
        ],
    });
    assert.deepEqual(written, ['exact.py', 'src/a.py', 'src/deep/b.ts']);
    assert.equal(fs.readFileSync(path.join(sourceDirectory, 'src', 'a.py'), 'utf8'), 'content of src/a.py');
    assert.deepEqual(calls.slice(0, 3), [
        ['exists', '/repo', `${SHA}^{tree}`],
        ['/repo', 'ls-tree', '-r', '-z', '-l', SHA],
        ['cat-file --batch', '/repo'],
    ]);
    assert.deepEqual(calls.filter((call) => call[0] === 'read').map((call) => call[1]).sort(), ['exact.py', 'src/a.py', 'src/deep/b.ts']);
    assert.deepEqual(calls.at(-1), ['dispose'], 'one reader per revision, closed when it is written');
});

test('nested target: filters against the target, keeps repository paths on disk', async () => {
    const { result, calls, written, sourceDirectory } = await materialize('src/app', [
        blob('src/app/a.py'),
        blob('src/app/dist/generated.js'),
        blob('src/other.py'),
        blob('src/app/sub/c.py'),
    ]);
    assert.deepEqual(result, {
        targetPath: path.join(sourceDirectory, 'src', 'app'),
        missingTarget: false,
        warnings: [],
    });
    assert.deepEqual(written, ['src/app/a.py', 'src/app/sub/c.py']);
    assert.deepEqual(calls.slice(0, 2), [
        ['exists', '/repo', `${SHA}:src/app`],
        ['/repo', 'ls-tree', '-r', '-z', '-l', SHA, '--', 'src/app'],
    ]);
});

test('a target absent from the commit is reported missing without listing the tree', async () => {
    const { result, calls, written } = await materialize('src/gone', [blob('src/gone/a.py')], { exists: false });
    assert.deepEqual(result, { targetPath: null, missingTarget: true, warnings: [] });
    assert.equal(calls.length, 1);
    assert.deepEqual(written, []);
});

test('the file and size limits abort before anything is copied', async () => {
    const many = Array.from({ length: 5001 }, (_, index) => blob(`f${index}.py`, 1));
    const tooMany = await materialize('.', many);
    assert.deepEqual(tooMany.result, { error: 'comparison-snapshot-file-limit' });
    assert.deepEqual(tooMany.written, []);
    const exactly = await materialize('.', many.slice(0, 5000).concat(blob('skipped.md', 1)));
    assert.equal(exactly.written.length, 5000);

    const heavy = Array.from({ length: 13 }, (_, index) => blob(`h${index}.py`, 8 * 1024 * 1024));
    const tooBig = await materialize('.', heavy);
    assert.deepEqual(tooBig.result, { error: 'comparison-snapshot-size-limit' });
    assert.deepEqual(tooBig.written, []);
});

test('precondition of the copy loop: the planning filter already rejects empty and escaping paths', () => {
    // The filter moved to gitSnapshotPlan.ts with the rest of the plan (S12).
    for (const relativePath of ['', '../a.py', '../../src/a.py', '/abs/a.py']) {
        assert.equal(shouldMaterializeDirectoryFile(relativePath), false, relativePath);
    }
    assert.equal(shouldMaterializeDirectoryFile('a.py'), true);
    assert.equal(shouldMaterializeDirectoryFile('sub/a.py'), true);
});

// ------------------------------------------------------------------ #106

const childProcess = require('node:child_process');
const { GitSnapshotBlobStore, writeSnapshotFiles } = require('../../out/core/history/gitSnapshotWriter.js');
const { runWithLaunchSignal } = require('../../out/core/analysis/launch/launchControl.js');

function git(cwd, args) {
    return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function walkFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkFiles(full));
        } else {
            files.push(full);
        }
    }
    return files;
}

test('#106: a revision is read through one cat-file batch, and a blob shared by frames is read and written once', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-batch-snapshot-'));
    temps.push(root);
    const repo = path.join(root, 'repo');
    const app = path.join(repo, 'app');
    fs.mkdirSync(path.join(app, 'sub'), { recursive: true });
    git(repo, ['init', '--quiet', '--initial-branch=main']);
    git(repo, ['config', 'user.name', 'CodeXR Tests']);
    git(repo, ['config', 'user.email', 'codexr-tests@example.invalid']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    for (let index = 0; index < 40; index += 1) {
        fs.writeFileSync(path.join(app, index % 2 ? 'sub' : '', `f${index}.js`), `function f${index}() { return ${index}; }\r\n\0binary-safe\n`);
    }
    fs.writeFileSync(path.join(app, 'same-a.py'), 'x = 1\n');
    fs.writeFileSync(path.join(app, 'sub', 'same-b.py'), 'x = 1\n');
    const commits = [];
    const commit = (message) => {
        git(repo, ['add', '.']);
        git(repo, ['commit', '--quiet', '-m', message]);
        commits.push(git(repo, ['rev-parse', 'HEAD']));
    };
    commit('one');
    fs.writeFileSync(path.join(app, 'f0.js'), 'function f0() { return "two"; }\n');
    commit('two');
    fs.writeFileSync(path.join(app, 'sub', 'f1.js'), 'function f1() { return "three"; }\n');
    commit('three');

    const service = new GitRepositoryService(app, path.join(root, 'snapshots'));
    const shows = [];
    const originalRunGitBuffer = service.runGitBuffer.bind(service);
    service.runGitBuffer = (cwd, args) => {
        if (args[0] === 'show') {
            shows.push(args[1]);
        }
        return originalRunGitBuffer(cwd, args);
    };
    let readers = 0;
    let reads = 0;
    const originalOpen = service.openBlobSource.bind(service);
    service.openBlobSource = (cwd) => {
        readers += 1;
        const source = originalOpen(cwd);
        return { read: (sha) => { reads += 1; return source.read(sha); }, dispose: (force) => source.dispose(force) };
    };
    try {
        for (const sha of commits) {
            const source = { id: `commit:${sha}`, kind: 'gitRef', refType: 'commit', label: sha, commitSha: sha };
            const result = await service.materialize(source);
            const written = walkFiles(result.targetPath);
            assert.equal(written.length, 42, sha);
            for (const file of written) {
                const repositoryPath = path.relative(repo, path.join(app, path.relative(result.targetPath, file))).split(path.sep).join('/');
                const expected = childProcess.execFileSync('git', ['show', `${sha}:${repositoryPath}`], { cwd: repo });
                assert.ok(fs.readFileSync(file).equals(expected), `${sha}:${repositoryPath} is byte-identical`);
                if (process.platform !== 'win32') {
                    assert.ok(fs.statSync(file).nlink >= 2, `${repositoryPath} is a link to the stored blob`);
                }
            }
            await service.releaseSnapshot(source);
        }
        assert.deepEqual(shows, [], 'no git show per file');
        assert.equal(readers, 3, 'one cat-file process per revision');
        // 41 distinct blobs in the first frame (same-a.py and same-b.py are
        // one blob), one new blob in each of the next two frames.
        assert.equal(reads, 43, 'every distinct blob is read from Git once');
        assert.equal(service.blobStore.size, 43);
    } finally {
        await service.dispose();
    }
    assert.equal(fs.existsSync(path.join(root, 'snapshots')), false, 'dispose removes the stored blobs with the snapshots');
});

test('#106: past its budget the store writes blobs straight into the snapshot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-blob-budget-'));
    temps.push(root);
    const store = new GitSnapshotBlobStore(path.join(root, 'store'), 10);
    const reads = [];
    const read = async (sha) => {
        reads.push(sha);
        return Buffer.from(sha.repeat(2));
    };
    const destination = (name) => path.join(root, name);
    await store.place({ repositoryPath: 'a', blobSha: 'small', size: 10 }, destination('a'), read);
    await store.place({ repositoryPath: 'b', blobSha: 'big', size: 11 }, destination('b'), read);
    await store.place({ repositoryPath: 'c', blobSha: 'small', size: 10 }, destination('c'), read);
    await store.place({ repositoryPath: 'd', blobSha: 'big', size: 11 }, destination('d'), read);
    assert.deepEqual(reads, ['small', 'big', 'big'], 'the stored blob is read once; the one over budget every time');
    assert.deepEqual(fs.readdirSync(path.join(root, 'store')), ['small']);
    for (const name of ['a', 'b', 'c', 'd']) {
        assert.equal(fs.readFileSync(destination(name), 'utf8'), name === 'a' || name === 'c' ? 'smallsmall' : 'bigbig');
    }
});

test('#106: Cancel stops the batch reader, and a failed read is not remembered for the blob', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-blob-cancel-'));
    temps.push(root);
    const store = new GitSnapshotBlobStore(path.join(root, 'store'));
    const files = Array.from({ length: 40 }, (_, index) => ({ repositoryPath: `d/f${index}.js`, blobSha: `blob${index}`, size: 1 }));
    const controller = new AbortController();
    let disposedWith = null;
    const hanging = () => ({
        read: () => new Promise((resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('git-cat-file-cancelled')));
        }),
        async dispose(force) {
            disposedWith = force;
        },
    });
    const writing = runWithLaunchSignal(controller.signal, () => writeSnapshotFiles({
        files,
        sourceDirectory: path.join(root, 'snap'),
        store,
        openSource: hanging,
        assertInside: () => undefined,
        signal: controller.signal,
    }));
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(writing, /^Error: git-command-cancelled$/);
    assert.equal(disposedWith, true, 'the reader is killed, not drained');
    assert.equal(store.size, 0, 'nothing half-read is kept');
    await writeSnapshotFiles({
        files: files.slice(0, 2),
        sourceDirectory: path.join(root, 'again'),
        store,
        openSource: () => ({ read: async (sha) => Buffer.from(sha), dispose: async () => undefined }),
        assertInside: () => undefined,
    });
    assert.equal(fs.readFileSync(path.join(root, 'again', 'd', 'f1.js'), 'utf8'), 'blob1');
});

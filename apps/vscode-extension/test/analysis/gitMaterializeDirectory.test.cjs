const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GitRepositoryService } = require('../../out/core/history/gitRepositoryService.js');

// Characterization of GitRepositoryService.materializeDirectory (ROADMAP
// W4-T26, CX-11) with `git ls-tree` and `git show` stubbed: which tree it
// asks for, which entries it copies, the warnings it collects, the two
// snapshot limits, and the folder it returns. historicalComparison.test.cjs
// covers the same path against a real repository.

const SHA = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const blob = (repositoryPath, size = 10, mode = '100644', type = 'blob') => `${mode} ${type} ${BLOB} ${String(size).padStart(7)}\t${repositoryPath}`;

const temps = [];
test.after(() => {
    for (const folder of temps) {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

async function materialize(targetRelativePath, entries, { exists = true } = {}) {
    const sourceDirectory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-materialize-')));
    temps.push(sourceDirectory);
    const service = new GitRepositoryService('/repo', '/snapshots');
    const calls = [];
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
        blob('dash.py', '-'),
    ]);
    assert.deepEqual(result, {
        targetPath: sourceDirectory,
        missingTarget: false,
        warnings: [
            'Skipped unsupported Git entry: vendor-module',
            'Skipped oversized file: big.py',
            'Skipped oversized file: dash.py',
        ],
    });
    assert.deepEqual(written, ['exact.py', 'src/a.py', 'src/deep/b.ts']);
    assert.equal(fs.readFileSync(path.join(sourceDirectory, 'src', 'a.py'), 'utf8'), `content of ${SHA}:src/a.py`);
    assert.deepEqual(calls, [
        ['exists', '/repo', `${SHA}^{tree}`],
        ['/repo', 'ls-tree', '-r', '-z', '-l', SHA],
        ['/repo', 'show', `${SHA}:src/a.py`],
        ['/repo', 'show', `${SHA}:src/deep/b.ts`],
        ['/repo', 'show', `${SHA}:exact.py`],
    ]);
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
    const service = new GitRepositoryService('/repo', '/snapshots');
    for (const relativePath of ['', '../a.py', '../../src/a.py', '/abs/a.py']) {
        assert.equal(service.shouldMaterializeDirectoryFile(relativePath), false, relativePath);
    }
    assert.equal(service.shouldMaterializeDirectoryFile('a.py'), true);
    assert.equal(service.shouldMaterializeDirectoryFile('sub/a.py'), true);
});

/**
 * S14 (#86): the Git and Python paths work with non-ASCII paths, other drives
 * and partial clones, and never use the network on their own.
 * EVO-9 (export worker stdin), HIST-6 (working copy on D:), EVO-10 (partial
 * clones). LAUNCHER-15 (DOM backend UTF-8) was fixed earlier; its spawn env is
 * pinned here too. The worker side of EVO-9 is in
 * backend/tests/git_export/test_git_export_analysis_worker.py.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const out = (relative) => require(path.join(projectRoot, 'out', ...relative.split('/')));
const { asciiJson } = out('core/export/gitExportPythonWorkerPool.js');
const { toPortableRelativePath } = out('core/history/gitAnalysisShared.js');
const { gitOfflineEnvironment, isPartialCloneConfig, isPartialCloneMissingObject } = out('core/history/gitOfflineEnvironment.js');
const { GitRepositoryService } = out('core/history/gitRepositoryService.js');

const roots = [];
test.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

test('S14 EVO-9: the export worker gets ASCII-only commands and a UTF-8 Python', () => {
    const line = asciiJson({ inputPath: 'C:\\Users\\Adrián\\código\\a.py', id: 'clave-漢字' });
    assert.match(line, /^[\x20-\x7e]*$/, 'pure ASCII');
    assert.deepEqual(JSON.parse(line), { inputPath: 'C:\\Users\\Adrián\\código\\a.py', id: 'clave-漢字' });
    const pool = fs.readFileSync(path.join(projectRoot, 'src', 'core', 'export', 'gitExportPythonWorkerPool.ts'), 'utf8');
    assert.match(pool, /env: \{ \.\.\.process\.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' \}/);
    const executePython = fs.readFileSync(path.join(projectRoot, 'src', 'core', 'analysis', 'python', 'executePython.ts'), 'utf8');
    assert.match(executePython, /PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'/, 'LAUNCHER-15 stays fixed');
});

test('S14 HIST-6: a working copy on another drive keeps its relative paths', () => {
    // Python strips the drive (normalize_path_for_babia): the payload says
    // `/work/proj/src/core/a.ts` for `D:\work\proj\src\core\a.ts`.
    const root = 'D:\\work\\proj\\src';
    assert.equal(toPortableRelativePath(root, '/work/proj/src/core/a.ts'), 'core/a.ts');
    assert.equal(toPortableRelativePath(root, '/work/proj/src/ui/a.ts'), 'ui/a.ts');
    assert.equal(toPortableRelativePath(root, 'D:\\work\\proj\\src\\ui\\a.ts'), 'ui/a.ts');
    assert.equal(toPortableRelativePath(root, 'D:/work/proj/src/ui/a.ts'), 'ui/a.ts');
    assert.equal(toPortableRelativePath('d:\\Work\\Proj\\src', 'D:\\work\\proj\\src\\Core\\A.ts'), 'Core/A.ts', 'case-insensitive drive folders');
    assert.equal(toPortableRelativePath(root, 'D:\\elsewhere\\x.ts'), 'x.ts');
    assert.equal(toPortableRelativePath(root, root), '');
    assert.equal(toPortableRelativePath('\\\\server\\share\\proj', '\\\\server\\share\\proj\\a\\b.ts'), 'a/b.ts');
});

test('S14 EVO-10: Git runs offline and names a missing partial-clone object', () => {
    const env = gitOfflineEnvironment({ PATH: '/bin' });
    assert.equal(env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.PATH, '/bin');
    assert.ok(isPartialCloneMissingObject('fatal: could not fetch 5626abf0 from promisor remote'));
    assert.ok(!isPartialCloneMissingObject('fatal: not a git repository'));
    for (const file of ['gitRepositoryService.ts', 'gitBatchObjectReader.ts', 'gitLineStream.ts']) {
        const source = fs.readFileSync(path.join(projectRoot, 'src', 'core', 'history', file), 'utf8');
        const spawns = (source.match(/(?:spawn|execFile)\(\s*'git'/g) || []).length;
        const envs = (source.match(/env: gitOfflineEnvironment\(\)/g) || []).length;
        assert.ok(envs >= 1 && envs >= spawns, `${file}: every git process gets the offline env (${envs}/${spawns})`);
    }
});

function git(cwd, args) {
    return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('S14 EVO-10: an old blob missing from a partial clone is reported, not downloaded', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-partial-'));
    roots.push(root);
    const origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    git(origin, ['init', '--quiet', '--initial-branch=main']);
    git(origin, ['config', 'user.name', 'CodeXR Tests']);
    git(origin, ['config', 'user.email', 'codexr-tests@example.invalid']);
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    fs.writeFileSync(path.join(origin, 'a.js'), 'export const a = 1;\n');
    git(origin, ['add', '.']);
    git(origin, ['commit', '--quiet', '-m', 'one']);
    fs.writeFileSync(path.join(origin, 'a.js'), 'export const a = 2;\n');
    git(origin, ['commit', '--quiet', '-am', 'two']);
    const clone = path.join(root, 'clone');
    try {
        childProcess.execFileSync('git', ['clone', '--quiet', '--filter=blob:none', `file://${origin.replace(/\\/g, '/')}`, clone], { stdio: 'ignore' });
    } catch {
        t.skip('this git cannot make a partial clone');
        return;
    }
    // Some git versions keep the old blob after a blob:none clone of a tiny
    // local repository; then there is nothing missing to report.
    const oldBlob = `${git(clone, ['rev-parse', 'HEAD~1'])}:a.js`;
    const blobPresent = (() => {
        try {
            childProcess.execFileSync('git', ['cat-file', '-e', oldBlob], { cwd: clone, stdio: 'ignore', env: gitOfflineEnvironment() });
            return true;
        } catch {
            return false;
        }
    })();
    if (blobPresent) {
        t.skip(`${git(clone, ['--version'])} kept the old blob in the partial clone`);
        return;
    }
    const objectCount = () => git(clone, ['count-objects', '-v']);
    const before = objectCount();
    const service = new GitRepositoryService(clone, path.join(root, 'snapshots'));
    const references = await service.listReferences();
    assert.equal(references.partialClone, true, 'the picker knows it is a partial clone');
    assert.match(references.notice, /partial clone/);
    const full = await new GitRepositoryService(origin, path.join(root, 'origin-snapshots')).listReferences();
    assert.equal(full.partialClone, false);
    assert.equal(full.notice, null);
    const old = references.sources.find((source) => source.refType === 'commit' && source.label !== 'two'
        && source.commitSha === git(clone, ['rev-parse', 'HEAD~1']));
    assert.ok(old, 'the first commit is offered');
    const resolved = await service.resolveSource(old.id);
    const outcome = await service.materialize(resolved).then((result) => ({ result }), (error) => ({ error }));
    if (!outcome.error) {
        const probe = (args) => {
            try {
                return childProcess.execFileSync('git', args, { cwd: clone, encoding: 'utf8', env: gitOfflineEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (error) {
                return `failed: ${error.stderr || error.message}`;
            }
        };
        assert.fail([
            'materialize resolved',
            git(clone, ['--version']),
            `format ${probe(['rev-parse', '--show-object-format']).trim()}`,
            `ls-tree ${JSON.stringify(probe(['ls-tree', '-r', '-l', old.commitSha]))}`,
            `result ${JSON.stringify(outcome.result)}`,
            `objects before ${JSON.stringify(before)}, after ${JSON.stringify(objectCount())}`,
        ].join(' | '));
    }
    assert.match(outcome.error.message, /git-object-missing/);
    assert.equal(objectCount(), before, 'nothing was fetched');
    await service.dispose();
});

test('S14 EVO-10: the partial-clone notice reads the two settings git clone --filter writes', () => {
    assert.ok(isPartialCloneConfig('remote.origin.promisor true\n'));
    assert.ok(isPartialCloneConfig('extensions.partialclone origin\r\n'));
    assert.ok(!isPartialCloneConfig('remote.origin.promisor false\n'));
    assert.ok(!isPartialCloneConfig(''));
    const runtime = fs.readFileSync(path.join(projectRoot, 'templates', 'components', 'codexr', 'historical-comparison',
        'historicalComparisonRuntime', 'compareFlowAndMessages.js'), 'utf8');
    assert.match(runtime, /state\.references\?\.notice/, 'the XR panel shows the notice');
    const livePanel = fs.readFileSync(path.join(projectRoot, 'templates', 'components', 'livepanel', 'historicalPanel.js'), 'utf8');
    assert.match(livePanel, /this\.references\.notice/, 'the LivePanel shows the notice');
});

/**
 * #105 (EVO-10 on Git 2.43): build a partial clone of a three-commit origin.
 * HEAD's blobs are present; the two older versions of a.js are not. Returns
 * null (and skips) when this Git cannot make one or kept the old blobs.
 */
function makePartialClone(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-partial-batch-'));
    roots.push(root);
    const origin = path.join(root, 'origin');
    fs.mkdirSync(path.join(origin, 'app'), { recursive: true });
    git(origin, ['init', '--quiet', '--initial-branch=main']);
    git(origin, ['config', 'user.name', 'CodeXR Tests']);
    git(origin, ['config', 'user.email', 'codexr-tests@example.invalid']);
    git(origin, ['config', 'commit.gpgsign', 'false']);
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    for (let index = 1; index <= 3; index += 1) {
        fs.writeFileSync(path.join(origin, 'app', 'a.js'), `export function a() { return ${index}; }\n`);
        fs.writeFileSync(path.join(origin, 'app', 'b.js'), 'export function b() { return 0; }\n');
        git(origin, ['add', '.']);
        git(origin, ['commit', '--quiet', '-m', `c${index}`]);
    }
    const clone = path.join(root, 'clone');
    try {
        childProcess.execFileSync('git', ['clone', '--quiet', '--filter=blob:none', `file://${origin.replace(/\\/g, '/')}`, clone], { stdio: 'ignore' });
    } catch {
        t.skip('this git cannot make a partial clone');
        return null;
    }
    const present = (spec) => {
        try {
            childProcess.execFileSync('git', ['cat-file', '-e', spec], { cwd: clone, stdio: 'ignore', env: gitOfflineEnvironment() });
            return true;
        } catch {
            return false;
        }
    };
    if (present('HEAD~2:app/a.js')) {
        t.skip(`${git(clone, ['--version'])} kept the old blobs in the partial clone`);
        return null;
    }
    const sha = (spec) => git(clone, ['rev-parse', spec]);
    return {
        clone,
        sha,
        objectCount: () => git(clone, ['count-objects', '-v']),
        source: (rev) => ({ id: `commit:${sha(rev)}`, label: rev, kind: 'gitRef', refType: 'commit', commitSha: sha(rev) }),
    };
}

test('#105: older Git cannot lazy-fetch either (no transport is allowed)', (t) => {
    assert.equal(gitOfflineEnvironment({}).GIT_ALLOW_PROTOCOL, 'codexr-offline');
    const repo = makePartialClone(t);
    if (!repo) {
        return;
    }
    // Emulate a Git without GIT_NO_LAZY_FETCH (< 2.44): drop that variable.
    const { GIT_NO_LAZY_FETCH: _ignored, ...env } = gitOfflineEnvironment();
    const before = repo.objectCount();
    const result = childProcess.spawnSync('git', ['cat-file', '-p', repo.sha('HEAD~2:app/a.js')], { cwd: repo.clone, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.ok(isPartialCloneMissingObject(result.stderr), result.stderr);
    assert.equal(repo.objectCount(), before, 'nothing was fetched');
});

test('#105: a missing blob fails only its own cat-file request, on every Git version', async (t) => {
    const repo = makePartialClone(t);
    if (!repo) {
        return;
    }
    const { GitBatchMetadataReader, GitBatchObjectReader } = out('core/history/gitBatchObjectReader.js');
    const { PARTIAL_CLONE_MISSING_MESSAGE } = out('core/history/gitOfflineEnvironment.js');
    const before = repo.objectCount();
    const specs = [
        repo.sha('HEAD:app/a.js'),
        repo.sha('HEAD~2:app/a.js'), // missing: Git 2.43 dies here
        repo.sha('HEAD:app/b.js'),
        repo.sha('HEAD~1:app/a.js'), // missing again, on the restarted process
        repo.sha('HEAD^{tree}'),
    ];
    const missing = new Set([1, 3]);
    const metadata = new GitBatchMetadataReader(repo.clone);
    const objects = new GitBatchObjectReader(repo.clone);
    try {
        for (const [name, read] of [
            ['metadata', (spec) => metadata.readMetadata(spec)],
            ['objects', (spec) => objects.readObject(spec)],
        ]) {
            const settled = await Promise.allSettled(specs.map(read));
            settled.forEach((outcome, index) => {
                if (missing.has(index)) {
                    assert.equal(outcome.status, 'rejected', `${name} #${index}`);
                    assert.equal(outcome.reason.message, PARTIAL_CLONE_MISSING_MESSAGE, `${name} #${index}`);
                } else {
                    assert.equal(outcome.status, 'fulfilled', `${name} #${index}: ${outcome.reason && outcome.reason.message}`);
                    assert.equal(outcome.value.objectName, specs[index]);
                }
            });
            // The reader is still usable afterwards.
            const again = await read(specs[0]);
            assert.equal(again.objectName, specs[0], `${name} recovers`);
        }
        const content = await objects.readObject(specs[0]);
        assert.match(content.content.toString('utf8'), /return 3/);
    } finally {
        await metadata.dispose();
        await objects.dispose();
    }
    assert.equal(repo.objectCount(), before, 'nothing was fetched');
});

test('#105: the shared index keeps HEAD and excludes only the incomplete revisions', async (t) => {
    const repo = makePartialClone(t);
    if (!repo) {
        return;
    }
    const { GitTimelineBlobIndex } = out('core/history/gitTimelineBlobIndex.js');
    const { PARTIAL_CLONE_MISSING_MESSAGE } = out('core/history/gitOfflineEnvironment.js');
    const before = repo.objectCount();
    const index = new GitTimelineBlobIndex(repo.clone, 'app', 'directory', true);
    try {
        // Oldest first, so the dead process is hit before HEAD is read.
        const revisions = await index.build(['HEAD~2', 'HEAD~1', 'HEAD'].map(repo.source));
        assert.equal(revisions[0].failureReason, PARTIAL_CLONE_MISSING_MESSAGE);
        assert.equal(revisions[1].failureReason, PARTIAL_CLONE_MISSING_MESSAGE);
        assert.equal(revisions[2].failureReason, undefined);
        assert.deepEqual(revisions[2].files.map((file) => file.relativePath), ['a.js', 'b.js']);
        const blob = await index.readBlob(revisions[2].files[0].blobSha);
        assert.match(blob.toString('utf8'), /return 3/);
    } finally {
        await index.dispose();
    }
    assert.equal(repo.objectCount(), before, 'nothing was fetched');
});

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
const { gitOfflineEnvironment, isPartialCloneMissingObject } = out('core/history/gitOfflineEnvironment.js');
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
    const old = (await service.listReferences()).sources.find((source) => source.refType === 'commit' && source.label !== 'two'
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

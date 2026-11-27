const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, fakeExtensionContext, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

// Characterization of inspectGitRevisionExport, the export preflight
// (ROADMAP W4-T34): what it returns for a directory target, a file target
// and a folder outside any repository, against a real fixture repository.
// The only consumer (promptGitExportRequest) reads commitCount alone, so
// the preflight returns nothing else and resolves the root only once.

function runGit(repositoryPath, args) {
    return childProcess.execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

const temps = [];
test.after(() => {
    for (const folder of temps) {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

function buildRepository() {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-preflight-')));
    temps.push(root);
    const repositoryPath = path.join(root, 'repository');
    fs.mkdirSync(path.join(repositoryPath, 'src'), { recursive: true });
    runGit(repositoryPath, ['init', '--initial-branch=main']);
    runGit(repositoryPath, ['config', 'user.email', 'test@example.com']);
    runGit(repositoryPath, ['config', 'user.name', 'Code-XR Test']);
    for (let index = 1; index <= 3; index += 1) {
        fs.writeFileSync(path.join(repositoryPath, 'src', 'a.py'), `x = ${index}\n`, 'utf8');
        runGit(repositoryPath, ['add', '.']);
        runGit(repositoryPath, ['commit', '-m', `commit ${index}`]);
    }
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    return { repositoryPath, outside };
}

async function inspect(targetPath) {
    const context = fakeExtensionContext();
    try {
        return await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
            const { inspectGitRevisionExport } = requireOut('core/export/gitRevisionExporter.js');
            try {
                return await inspectGitRevisionExport(context, { id: 'sess', targetPath });
            } catch (error) {
                return { error: error.message };
            }
        });
    } finally {
        context.cleanup();
    }
}

test('the preflight counts the commits of the repository holding the target', async () => {
    const { repositoryPath, outside } = buildRepository();
    // The repository root is no longer returned: nothing read it (W4-T34).
    assert.deepEqual(await inspect(path.join(repositoryPath, 'src')), { commitCount: 3 });
    assert.deepEqual(await inspect(path.join(repositoryPath, 'src', 'a.py')), { commitCount: 3 });
    const failure = await inspect(outside);
    assert.match(failure.error, /^git-command-failed: /);
});

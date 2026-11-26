/**
 * S12 (#84): a historical comparison stays correct while the user keeps
 * committing and switching modes (HIST-1, -2, -4, -5, -8, -10, -11, -13).
 * Real temporary repositories for the Git service; the compiled feature host
 * under the fake vscode for the live-refresh loop.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));
const { readAssembledRuntime } = require(path.join(projectRoot, 'test', 'helpers', 'runtimeAssembly.cjs'));
const { GitRepositoryService, PICKER_COMMIT_COUNT } = require('../../out/core/history/gitRepositoryService.js');
const { isDeterministicNoDataError } = require('../../out/core/history/gitAnalysisEligibility.js');

const roots = [];
test.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function git(cwd, args, input) {
    return childProcess.execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

function newRepository() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-historical-s12-'));
    roots.push(root);
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '--quiet', '--initial-branch=main']);
    git(repo, ['config', 'user.name', 'CodeXR Tests']);
    git(repo, ['config', 'user.email', 'codexr-tests@example.invalid']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    return { root, repo, service: () => new GitRepositoryService(repo, path.join(root, `snapshots-${Math.random()}`)) };
}

/** `count` commits on top of `parent` through fast-import, then main checked out. */
function appendCommits(repo, parent, count) {
    const parts = [];
    for (let index = 1; index <= count; index += 1) {
        const message = `later ${index}`;
        const content = `export const later = ${index};\n`;
        parts.push(
            'commit refs/heads/main',
            `committer CodeXR Tests <codexr-tests@example.invalid> ${1800000000 + index * 60} +0000`,
            `data ${Buffer.byteLength(message)}`,
            message,
            ...(index === 1 ? [`from ${parent}`] : []),
            'M 644 inline later.js',
            `data ${Buffer.byteLength(content)}`,
            content,
        );
    }
    git(repo, ['fast-import', '--quiet', '--force'], `${parts.join('\n')}\n`);
    git(repo, ['reset', '--quiet', '--hard', 'main']);
}

test('S12 HIST-2: a picked commit stays resolvable after newer commits push it out of the picker', async () => {
    const { repo, service } = newRepository();
    fs.writeFileSync(path.join(repo, 'main.js'), 'export const value = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '--quiet', '-m', 'first']);
    const first = git(repo, ['rev-parse', 'HEAD']);
    const gitService = service();
    const picked = (await gitService.listReferences()).sources.find((source) => source.commitSha === first && source.refType === 'commit');
    assert.ok(picked);

    appendCommits(repo, first, PICKER_COMMIT_COUNT + 5);
    // The live refresh re-lists the references (working copy) on every save.
    const relisted = await gitService.listReferences();
    assert.ok(!relisted.sources.some((source) => source.commitSha === first), 'the old commit left the listing');
    await gitService.resolveSource('working-copy');
    const resolved = await gitService.resolveSource(picked.id);
    assert.equal(resolved.commitSha, first);
});

test('S12 HIST-2: a deleted branch is reported as gone, not as a failed git command', async () => {
    const { repo, service } = newRepository();
    fs.writeFileSync(path.join(repo, 'main.js'), 'export const value = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '--quiet', '-m', 'first']);
    git(repo, ['branch', 'feature']);
    const gitService = service();
    const feature = (await gitService.listReferences()).sources.find((source) => source.label === 'feature');
    git(repo, ['branch', '-D', 'feature']);
    await assert.rejects(gitService.resolveSource(feature.id), /comparison-reference-not-found/);
});

test('S12 HIST-11: the picker offers more than 50 commits', async () => {
    const { repo, service } = newRepository();
    fs.writeFileSync(path.join(repo, 'main.js'), 'export const value = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '--quiet', '-m', 'first']);
    appendCommits(repo, git(repo, ['rev-parse', 'HEAD']), 80);
    const commits = (await service().listReferences()).sources.filter((source) => source.refType === 'commit');
    assert.equal(commits.length, 81);
    assert.ok(PICKER_COMMIT_COUNT >= 200);
});

test('S12 HIST-5: a shallow comparison copies only the target\'s own files', async () => {
    const { repo, service } = newRepository();
    fs.mkdirSync(path.join(repo, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'top.py'), 'def top():\n    return 1\n');
    fs.writeFileSync(path.join(repo, 'nested', 'a.py'), 'def a():\n    return 2\n');
    fs.writeFileSync(path.join(repo, 'nested', 'deeper', 'b.py'), 'def b():\n    return 3\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '--quiet', '-m', 'files']);
    const gitService = service();
    const commit = (await gitService.listReferences()).sources.find((source) => source.refType === 'commit');
    const resolved = await gitService.resolveSource(commit.id);

    const shallow = await gitService.materialize(resolved, { recursive: false });
    assert.ok(fs.existsSync(path.join(shallow.targetPath, 'top.py')));
    assert.ok(!fs.existsSync(path.join(shallow.targetPath, 'nested')));

    const deep = await gitService.materialize(resolved);
    assert.ok(fs.existsSync(path.join(deep.targetPath, 'nested', 'deeper', 'b.py')));
    await gitService.dispose();
});

test('S12 HIST-11: only a "no data" answer excludes a revision; a dead Python does not', () => {
    assert.equal(isDeterministicNoDataError(new Error('JSON markers not found in output')), false);
    assert.equal(isDeterministicNoDataError(new Error('Unable to parse result')), false);
    assert.equal(isDeterministicNoDataError(new Error('The analysis produced no data')), true);
    assert.equal(isDeterministicNoDataError(new Error('empty payload')), true);
});

test('S12 HIST-10: comparison failures get a typed code and a sentence', async () => {
    await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
        const { classifyHistoricalComparisonError, describeHistoricalComparisonError } = requireOut('core/history/historicalComparisonService.js');
        assert.equal(classifyHistoricalComparisonError(new Error('unknown-comparison-source')).code, 'comparison-reference-gone');
        assert.equal(classifyHistoricalComparisonError(new Error('comparison-reference-not-found')).code, 'comparison-reference-gone');
        assert.equal(classifyHistoricalComparisonError(new Error('comparison-snapshot-file-limit')).code, 'comparison-snapshot-limit');
        assert.equal(classifyHistoricalComparisonError(new Error('git-command-timeout: x')).code, 'comparison-step-timeout');
        assert.equal(classifyHistoricalComparisonError(new Error('python exploded')), null);
        assert.match(describeHistoricalComparisonError(new Error('python exploded')), /The analysis failed \(python exploded\)\./);
    });
});

/** The compiled host with a stub room and a stub comparison service whose refresh always fails. */
async function withFailingHost(viewMode, body) {
    await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
        // The coordinator first: the host then shares this instance of it.
        const { analysisRefreshCoordinator } = requireOut('core/analysis/refresh/analysisRefreshCoordinator.js');
        const { AnalysisFeatureHost } = requireOut('core/server/analysis/analysisFeatureHost.js');
        const config = {};
        const messages = [];
        const host = new AnalysisFeatureHost(config, {
            getRoom: () => ({ broadcastServerMessage: (roomId, message) => messages.push(message), upsertServerEntity() {} }),
            getRoomId: () => 'room',
        });
        const sessionId = `s12-${viewMode}-${Math.random()}`;
        config.analysisSessionId = sessionId;
        analysisRefreshCoordinator.changeActiveMode(sessionId, viewMode);
        let suspended = false;
        const service = {
            calls: 0,
            hasLiveSource: () => !suspended,
            isBusy: () => false,
            suspendLiveRefresh: () => { suspended = true; },
            refreshActiveComparison: async () => {
                service.calls += 1;
                throw new Error('unknown-comparison-source');
            },
        };
        host.historicalComparisonService = service;
        try {
            await body({ host, service, messages, isSuspended: () => suspended });
        } finally {
            clearTimeout(host.historicalRefreshTimer);
            host.historicalComparisonService = null;
            analysisRefreshCoordinator.disposeSession(sessionId);
        }
    });
}

test('S12 HIST-1: a failing live refresh backs off, stops after 3 attempts and tells the room once', async () => {
    await withFailingHost('historical-compare', async ({ host, service, messages, isSuspended }) => {
        host.scheduleHistoricalComparisonRefresh();
        // 350 ms, then 700 and 1400 of back-off: about 2.5 s for three attempts.
        await new Promise((resolve) => setTimeout(resolve, 3200));
        assert.equal(service.calls, 3);
        const errors = messages.filter((message) => message.type === 'historical-comparison-error');
        assert.equal(errors.length, 1);
        assert.equal(errors[0].payload.code, 'comparison-live-refresh-stopped');
        assert.match(errors[0].payload.message, /no longer exists in the repository/);
        assert.equal(isSuspended(), true, 'the live link stops until a new comparison');
        await new Promise((resolve) => setTimeout(resolve, 800));
        assert.equal(service.calls, 3, 'no attempt after giving up');
    });
});

test('S12 HIST-1: no retry while the room is in another mode; it waits for re-entry', async () => {
    await withFailingHost('selection', async ({ host, service, messages }) => {
        host.scheduleHistoricalComparisonRefresh();
        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert.equal(service.calls, 1);
        assert.equal(messages.filter((message) => message.type === 'historical-comparison-error').length, 0);
        assert.equal(host.historicalRefreshPendingOnEntry, true);
    });
});

test('S12 HIST-4/HIST-10: the client decides against the mounted result, keeps a result it could not load, and clears the loading text', () => {
    const source = readAssembledRuntime('historical-comparison', 'historicalComparisonRuntime.js');
    assert.match(source, /canRefreshLiveSide\(result, refs\.renderedResult \|\| null\)/);
    assert.match(source, /refs\.renderedResult = result;/);
    assert.match(source, /refs\.renderedResult = null;/);
    // Stored before the first await, so leaving mid-fetch cannot drop it.
    // \r?\n: a Windows checkout assembles the runtime with CRLF line ends.
    assert.match(source, /state\.result = snapshot\.result;\r?\n\s+if \(!isHistoricalModeActiveOrActivating\(\)\) \{\r?\n\s+return;/);
    assert.match(source, /await renderComparison\(result, datasets\[0\], datasets\[1\]\);\r?\n\s+\}\r?\n[\s\S]{0,120}setStatus\('', 'info'\);/);
    assert.match(source, /code === 'comparison-live-refresh-stopped'/);
    assert.doesNotMatch(source, /not a git repository\|git-command-failed/);
});

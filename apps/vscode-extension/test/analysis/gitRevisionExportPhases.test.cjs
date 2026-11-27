const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGitRevisionExport } = require('../../out/core/export/gitRevisionExportCore.js');

// Characterization of runGitRevisionExport (ROADMAP W4-T22/T23, CX-02) with a
// fake Git service instead of a fixture repository, so each scenario chooses
// its timeline, its refs and what every revision analyses to. Pins how a
// failing revision is classified (code and stage), how identical payloads
// share one file, when the run gives up and removes git-revisions/, and the
// whole gitData it assembles.

const temps = [];
test.after(() => {
    for (const folder of temps) {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

function makeDestination() {
    const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-export-phases-')));
    temps.push(folder);
    return folder;
}

const commit = (n, extra = {}) => ({
    id: `commit:${n}`,
    kind: 'gitRef',
    refType: 'commit',
    refName: `c${n}`,
    commitSha: `${String(n).repeat(40)}`.slice(0, 40),
    label: `c${n}`,
    timestamp: 1700000000 + n,
    live: false,
    revisionType: 'commit',
    ...extra,
});
const ref = (id, n, refType = 'branch') => commit(n, { id, refType, refName: id, label: id, revisionType: refType });
const WORKING_COPY = {
    id: 'working-copy', kind: 'workingCopy', label: 'Working copy', activeBranch: 'main', dirty: true, live: true, revisionType: 'working',
};

/**
 * `analyses` maps a commit sha to what the store returns for it: an entries
 * array, an Error/string to throw, or undefined for one entry naming the sha.
 */
async function runExport({
    timeline = [commit(1), commit(2), commit(3)],
    refs = [WORKING_COPY],
    analyses = {},
    workingCopy = [{ fileName: 'a.py', filePath: 'a.py', totalLines: 1 }],
    store,
    request,
    token,
} = {}) {
    const destination = makeDestination();
    const progress = [];
    const outcome = await runGitRevisionExport(
        {
            gitService: {
                listReferences: async () => ({
                    repositoryRoot: '/repo',
                    targetRelativePath: '',
                    workingTreeDirty: true,
                    activeBranch: 'main',
                    pageSize: 5,
                    sources: refs,
                }),
                listTimelineSources: async () => timeline,
                dispose: () => undefined,
            },
            prepareRevisionStore: store || (async (sources) => ({
                statistics: { revisionCount: sources.length },
                async get(source) {
                    const analysis = analyses[source.commitSha];
                    if (analysis instanceof Error || typeof analysis === 'string') {
                        throw analysis;
                    }
                    return {
                        entries: analysis || [{ fileName: 'a.py', filePath: 'a.py', totalLines: 1, sha: source.commitSha }],
                        analyzedTargetPath: '/snapshot',
                        warnings: [],
                    };
                },
                async dispose() {},
            })),
            readWorkingCopyPayload: async () => workingCopy,
        },
        {
            targetPath: '/repo',
            targetType: 'directory',
            destinationPath: destination,
            request,
            token,
            progress: { report: (value) => progress.push(value) },
        },
    );
    const revisionsDir = path.join(destination, 'git-revisions');
    const files = fs.existsSync(revisionsDir) ? fs.readdirSync(revisionsDir).sort() : null;
    return { outcome, files, progress, destination };
}

test('a failing revision is classified by its message: code and stage', async () => {
    // [thrown, expected code, expected stage]. The two regexes disagree in
    // places, and those rows are pinned as they are (quirks, not intent).
    const table = [
        ['The target does not exist in this revision', 'target-missing', 'index'],
        ['git-revision-target-missing', 'target-missing', 'analysis'],
        ['No analyzable files', 'no-analyzable-content', 'index'],
        ['git-revision-no-analyzable-content', 'no-analyzable-content', 'analysis'],
        ['The analysis produced no data records.', 'no-analyzable-content', 'analysis'],
        ['file-limit reached', 'limit-exceeded', 'index'],
        ['size-limit reached', 'limit-exceeded', 'index'],
        ['The snapshot exceeds the configured maximum', 'limit-exceeded', 'analysis'],
        ['rate limit hit', 'analysis-failed', 'index'],
        ['boom', 'analysis-failed', 'analysis'],
    ];
    for (const [message, code, stage] of table) {
        for (const thrown of [new Error(message), message]) {
            const { outcome } = await runExport({ analyses: { [commit(2).commitSha]: thrown } });
            assert.deepEqual(outcome.gitData.skippedRevisions, [{
                id: 'commit:2', label: 'c2', commitSha: commit(2).commitSha, code, stage, reason: message,
            }], `${typeof thrown}: ${message}`);
        }
    }
    // An unusable payload is classified through the same chain, by its reason.
    const empty = await runExport({ analyses: { [commit(2).commitSha]: [] } });
    assert.deepEqual(
        empty.outcome.gitData.skippedRevisions.map(({ code, stage, reason }) => [code, stage, reason]),
        [['no-analyzable-content', 'analysis', 'The analysis produced no data records.']],
    );
    const shapeless = await runExport({ analyses: { [commit(2).commitSha]: [1, 'x'] } });
    assert.equal(shapeless.outcome.gitData.skippedRevisions[0].code, 'no-analyzable-content');
    // A store that resolves to nothing fails every revision the same way.
    const noStore = await runExport({ store: async () => undefined });
    assert.equal(noStore.outcome.gitData, undefined);
    assert.equal(noStore.outcome.failureReason, 'Fewer than two revisions could be analyzed, so offline comparisons are not possible.');
});

test('a failing revision excludes every ref sharing its commit, each with the same classification', async () => {
    const { outcome } = await runExport({
        refs: [WORKING_COPY, ref('main', 3), ref('v1', 3, 'tag')],
        analyses: { [commit(3).commitSha]: new Error('target does not exist') },
    });
    assert.deepEqual(
        outcome.gitData.skippedRevisions.map(({ id, code, stage }) => [id, code, stage]),
        [['commit:3', 'target-missing', 'index'], ['main', 'target-missing', 'index'], ['v1', 'target-missing', 'index']],
    );
    assert.equal(outcome.gitData.partial, true);
});

/**
 * Latest-3 export: c1 and c2 analyse to the same payload, c3 fails; `main`
 * and tag `v1` share c2, `old` points outside the timeline.
 */
function snapshotScenario() {
    const same = [{ fileName: 'a.py', filePath: 'a.py', totalLines: 1 }];
    return runExport({
        timeline: [commit(1), commit(2), commit(3)],
        refs: [WORKING_COPY, ref('main', 2), ref('v1', 2, 'tag'), ref('old', 9)],
        analyses: { [commit(1).commitSha]: same, [commit(2).commitSha]: same, [commit(3).commitSha]: new Error('boom') },
        request: { scope: { kind: 'latest', count: 3 }, performanceProfile: 'balanced' },
    });
}

test('the assembled gitData: usable refs first, shared payloads, skipped revisions, selection counts', async () => {
    const { outcome, files, progress } = await snapshotScenario();
    const payload = (source, file) => ({ ...source, payloadUrl: `./git-revisions/${file}`, itemCount: 1 });
    const gitData = outcome.gitData;
    assert.equal(outcome.cancelled, false);
    assert.deepEqual(Object.keys(gitData), [
        'references', 'timelineSourceIds', 'suggestedSourceIds', 'maxFrames', 'workingCopyPayloadUrl',
        'timelineSelection', 'pipelineStatistics', 'analyzedRevisionCount', 'skippedRevisions', 'partial',
    ]);
    assert.deepEqual(gitData, {
        references: {
            repositoryRoot: '/repo',
            targetRelativePath: '',
            workingTreeDirty: true,
            activeBranch: 'main',
            pageSize: 5,
            // References first (in their order), then the timeline commits
            // they do not already list; `old` is outside the scope, so absent.
            sources: [
                payload(WORKING_COPY, 'working-copy.json'),
                payload(ref('main', 2), '111111111111.json'),
                payload(ref('v1', 2, 'tag'), '111111111111.json'),
                payload(commit(1), '111111111111.json'),
                payload(commit(2), '111111111111.json'),
            ],
        },
        timelineSourceIds: ['commit:1', 'commit:2', 'working-copy'],
        suggestedSourceIds: ['commit:1', 'commit:2', 'working-copy'],
        maxFrames: 24,
        workingCopyPayloadUrl: './git-revisions/working-copy.json',
        timelineSelection: {
            kind: 'latest',
            requestedCommitCount: 3,
            selectedCommitCount: 3,
            exportedCommitCount: 2,
            exportedSourceCount: 5,
        },
        pipelineStatistics: { revisionCount: 3 },
        analyzedRevisionCount: 2,
        skippedRevisions: [{
            id: 'commit:3', label: 'c3', commitSha: commit(3).commitSha, code: 'analysis-failed', stage: 'analysis', reason: 'boom',
        }],
        partial: true,
    });
    // c2 analysed to the same bytes as c1, so it shares c1's file.
    assert.deepEqual(files, ['111111111111.json', 'working-copy.json']);
    assert.deepEqual(progress.map(({ message }) => message), [
        'Building offline revision: 1/3 · c1',
        'Building offline revision: 2/3 · c2',
        'Building offline revision: 3/3 · c3',
    ]);
    assert.ok(progress.every(({ increment }) => increment === 10 / 3));
});

test('content-hash de-dup: only identical decorated payloads share a file, named after the first commit', async () => {
    const { outcome, files } = await runExport({
        analyses: {
            [commit(1).commitSha]: [{ fileName: 'a.py', totalLines: 1 }],
            [commit(2).commitSha]: [{ fileName: 'a.py', totalLines: 2 }],
            [commit(3).commitSha]: [{ fileName: 'a.py', totalLines: 1 }],
        },
    });
    assert.deepEqual(files, ['111111111111.json', '222222222222.json', 'working-copy.json']);
    const urlOf = (id) => outcome.gitData.references.sources.find((source) => source.id === id).payloadUrl;
    assert.equal(urlOf('commit:3'), './git-revisions/111111111111.json');
    assert.equal(urlOf('commit:2'), './git-revisions/222222222222.json');
    assert.equal(outcome.gitData.partial, undefined);
    assert.equal(outcome.gitData.skippedRevisions, undefined);
});

test('under two usable sources the run gives up and removes git-revisions/', async () => {
    const fewer = 'Fewer than two revisions could be analyzed, so offline comparisons are not possible.';
    // Only the working copy survives.
    const onlyWorkingCopy = await runExport({ timeline: [commit(1)], analyses: { [commit(1).commitSha]: 'boom' } });
    assert.deepEqual(onlyWorkingCopy.outcome, { cancelled: false, failureReason: fewer });
    assert.equal(onlyWorkingCopy.files, null);
    // Two usable sources, but a single frame: a ref and its own commit, no working copy.
    const oneFrame = await runExport({ timeline: [commit(1)], refs: [WORKING_COPY, ref('main', 1)], workingCopy: 'not an array' });
    assert.deepEqual(oneFrame.outcome, { cancelled: false, failureReason: fewer });
    assert.equal(oneFrame.files, null);
    // Without a working-copy source two commits are enough.
    const twoCommits = await runExport({ timeline: [commit(1), commit(2)], refs: [] });
    assert.deepEqual(twoCommits.outcome.gitData.timelineSourceIds, ['commit:1', 'commit:2']);
    assert.equal(twoCommits.outcome.gitData.workingCopyPayloadUrl, undefined);
    assert.deepEqual(twoCommits.files, ['111111111111.json', '222222222222.json']);
});

test('cancellation mid-run keeps what completed, or gives up honestly when too little did', async () => {
    let calls = 0;
    let cancelAfter = 2;
    const token = { get isCancellationRequested() { return calls >= cancelAfter; } };
    const store = async () => ({
        statistics: {},
        async get(source) {
            calls += 1;
            return { entries: [{ fileName: 'a.py', totalLines: calls, sha: source.commitSha }], analyzedTargetPath: '/s', warnings: [] };
        },
        async dispose() {},
    });
    const kept = await runExport({ store, token });
    assert.equal(kept.outcome.cancelled, true);
    assert.equal(kept.outcome.gitData.partial, true);
    assert.equal(kept.outcome.gitData.skippedRevisions, undefined);
    assert.deepEqual(kept.outcome.gitData.timelineSourceIds, ['commit:1', 'commit:2', 'working-copy']);

    calls = 0;
    cancelAfter = 1;
    const tooFew = await runExport({ store, token, workingCopy: [] });
    assert.deepEqual(tooFew.outcome, {
        cancelled: true,
        failureReason: 'The git analysis was cancelled before enough revisions completed.',
    });
    assert.equal(tooFew.files, null);
});

test('listing and store failures are reported, and nothing is left behind', async () => {
    const thrownByStore = await runExport({ store: async () => { throw new Error('pool exploded'); } });
    assert.deepEqual(thrownByStore.outcome, { cancelled: false, failureReason: 'The git revision export failed: pool exploded' });
    assert.equal(thrownByStore.files, null);

    const cancelledStore = await runExport({ store: async () => { throw new Error('git-export-cancelled'); } });
    assert.deepEqual(cancelledStore.outcome, {
        cancelled: true,
        failureReason: 'The git analysis was cancelled before enough revisions completed.',
    });
    assert.equal(cancelledStore.files, null);

    const destination = makeDestination();
    const listing = await runGitRevisionExport({
        gitService: {
            listReferences: async () => { throw new Error('not a repository'); },
            listTimelineSources: async () => [],
            dispose: () => undefined,
        },
        prepareRevisionStore: async () => { throw new Error('unreachable'); },
        readWorkingCopyPayload: async () => [],
    }, { targetPath: '/repo', targetType: 'directory', destinationPath: destination });
    assert.deepEqual(listing, { cancelled: false, failureReason: 'The git timeline could not be listed for the export: not a repository' });
    assert.equal(fs.existsSync(path.join(destination, 'git-revisions')), false);
});

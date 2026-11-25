const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGitRevisionExport } = require('../../out/code_analysis/export/gitRevisionExportCore.js');

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

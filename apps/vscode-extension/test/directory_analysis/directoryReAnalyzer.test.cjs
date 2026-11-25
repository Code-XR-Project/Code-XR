const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

// Characterization of DirectoryReAnalyzer.applyIncrementalChanges (ROADMAP
// W4-T15, hotspots-ts/CPLX-16'): the boolean it returns, what it writes to
// data.json for both formats (the XR array and the LivePanel object), which
// hash-tracker calls it makes, when it emits the update event, notifies the
// clients and shows the status-bar count. Runs the real class from out/ with
// its Python runner and SSE notification stubbed.

const MODULE = 'code_analysis/engine/watchers/directoryReAnalyzer.js';

function entry(filePath, extra = {}) {
    return { filePath, fileName: path.basename(filePath), status: 'success', totalLines: 10, codeLines: 8, language: 'Python', ...extra };
}

async function apply({ data, changeSet, options, reanalysis = (files) => files.map((file) => entry(file, { fresh: true })), noDataJson = false, noSavedPath = false }) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-reanalyzer-')));
    const dataJsonPath = path.join(root, 'data.json');
    if (!noDataJson) {
        fs.writeFileSync(dataJsonPath, JSON.stringify(data));
    }
    const statusMessages = [];
    const fake = createFakeVscode({ overrides: { window: { setStatusBarMessage: (text, timeout) => { statusMessages.push([text, timeout]); } } } });
    const calls = [];
    try {
        return await withFakeVscode(fake, async ({ requireOut }) => {
            const { DirectoryReAnalyzer } = requireOut(MODULE);
            // The instance the analyzer already loaded (requireOut would load a fresh copy).
            const { analysisUpdateEvents } = require(path.join(projectRoot, 'out', 'code_analysis', 'historical', 'analysisUpdateEvents.js'));
            const events = [];
            const off = analysisUpdateEvents.on((event) => events.push({ sessionId: event.sessionId, targetPath: event.targetPath }));
            const analyzer = Object.create(DirectoryReAnalyzer.prototype);
            analyzer.executePython = {
                executeFileReanalysis: async (files) => {
                    calls.push(['reanalyze', files.map((file) => path.basename(file))]);
                    return reanalysis(files);
                },
            };
            analyzer.sendSSENotification = async (session) => { calls.push(['sse', session.id]); };
            const hashTracker = {
                untrackFile: (file) => calls.push(['untrack', path.basename(file)]),
                trackNewFile: async (file, hash) => calls.push(['track', path.basename(file), hash === '' ? 'empty' : 'hash']),
            };
            const session = { id: 's1', targetPath: root, savedFilesPath: noSavedPath ? undefined : root, analysisMode: 'XR' };
            const resolved = (file) => path.join(root, file);
            const resolvedChangeSet = {
                removedFiles: changeSet.removedFiles && changeSet.removedFiles.map(resolved),
                updatedResults: changeSet.updatedResults && changeSet.updatedResults.map((item) => ({ ...item, filePath: resolved(item.filePath) })),
                addedFiles: changeSet.addedFiles && changeSet.addedFiles.map(resolved),
            };
            const toRelative = (value) => JSON.parse(JSON.stringify(value).split(JSON.stringify(root + path.sep).slice(1, -1)).join(''));
            // the stored data uses absolute paths too
            if (!noDataJson) {
                const stored = JSON.parse(fs.readFileSync(dataJsonPath, 'utf8'));
                const absolutize = (item) => ({ ...item, filePath: resolved(item.filePath) });
                fs.writeFileSync(dataJsonPath, JSON.stringify(Array.isArray(stored) ? stored.map(absolutize) : { ...stored, files: (stored.files || []).map(absolutize) }));
            }
            const changed = await analyzer.applyIncrementalChanges(session, resolvedChangeSet, hashTracker, options);
            off();
            const written = fs.existsSync(dataJsonPath) ? toRelative(JSON.parse(fs.readFileSync(dataJsonPath, 'utf8'))) : undefined;
            const leftovers = fs.readdirSync(root).filter((name) => name !== 'data.json');
            return { changed, written, calls, events, statusMessages, leftovers };
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

const XR_DATA = [entry('a.py'), entry('b.py'), entry('c.py')];

test('XR: remove, update and add in one change set, in that order', async () => {
    const outcome = await apply({
        data: XR_DATA,
        changeSet: { removedFiles: ['a.py', 'zzz.py'], updatedResults: [entry('b.py', { totalLines: 99 })], addedFiles: ['c.py', 'd.py'] },
    });
    assert.equal(outcome.changed, true);
    assert.deepEqual(outcome.written, [
        entry('c.py'),
        entry('b.py', { totalLines: 99 }),
        entry('d.py', { fresh: true }),
    ]);
    assert.deepEqual(outcome.calls, [
        ['untrack', 'a.py'],
        ['untrack', 'zzz.py'],
        // c.py is already in data.json, so only d.py is analysed and tracked
        ['reanalyze', ['d.py']],
        ['track', 'd.py', 'empty'],
        ['sse', 's1'],
    ]);
    assert.deepEqual(outcome.events, [{ sessionId: 's1', targetPath: outcome.events[0].targetPath }]);
    // the count is the length of the change set, not of what actually changed
    assert.deepEqual(outcome.statusMessages, [['$(check) CodeXR re-analysis updated 5 file(s)', 2000]]);
    assert.deepEqual(outcome.leftovers, []);
});

test('notifyClients: false skips only the client notification', async () => {
    const outcome = await apply({ data: XR_DATA, changeSet: { removedFiles: ['a.py'] }, options: { notifyClients: false } });
    assert.equal(outcome.changed, true);
    assert.deepEqual(outcome.calls, [['untrack', 'a.py']]);
    assert.equal(outcome.events.length, 1);
    assert.equal(outcome.statusMessages.length, 1);
});

test('nothing to change: false, data.json untouched, no event, no notification', async () => {
    for (const changeSet of [{}, { removedFiles: [], updatedResults: [], addedFiles: [] }, { removedFiles: ['missing.py'] }, { addedFiles: ['a.py'] }]) {
        const outcome = await apply({ data: XR_DATA, changeSet });
        assert.equal(outcome.changed, false, JSON.stringify(changeSet));
        assert.deepEqual(outcome.written, XR_DATA);
        assert.deepEqual(outcome.events, []);
        assert.deepEqual(outcome.statusMessages, []);
        assert.equal(outcome.calls.some(([kind]) => kind === 'sse' || kind === 'reanalyze'), false);
    }
});

test('a failed or missing re-analysis result becomes an empty entry for the added file', async () => {
    const outcome = await apply({
        data: XR_DATA,
        changeSet: { addedFiles: ['d.py', 'e.py'] },
        reanalysis: (files) => [{ success: false, filePath: files[0] }],
    });
    assert.equal(outcome.changed, true);
    const added = outcome.written.slice(3);
    assert.deepEqual(added.map((item) => [item.fileName, item.status, item.relativePath]), [['d.py', 'empty', 'd.py'], ['e.py', 'empty', 'e.py']]);

    const thrown = await apply({ data: XR_DATA, changeSet: { addedFiles: ['d.py'] }, reanalysis: () => { throw new Error('python down'); } });
    assert.equal(thrown.changed, true);
    assert.equal(thrown.written[3].status, 'empty');

    // a single object result is wrapped
    const single = await apply({ data: XR_DATA, changeSet: { addedFiles: ['d.py'] }, reanalysis: (files) => entry(files[0], { single: true }) });
    assert.equal(single.written[3].single, true);
});

test('LivePanel: the summary is recomputed and stamped after a change', async () => {
    const data = {
        files: [entry('a.py'), entry('b.py', { status: 'error' })],
        summary: { keep: 'me', totalFiles: 0 },
    };
    const outcome = await apply({ data, changeSet: { updatedResults: [entry('a.py', { totalLines: 30, functionCount: 2, maxComplexity: 4 })] } });
    assert.equal(outcome.changed, true);
    const { analyzedAt, ...summary } = outcome.written.summary;
    assert.match(analyzedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(summary, {
        keep: 'me',
        totalFiles: 2,
        totalFilesAnalyzed: 1,
        totalFilesNotAnalyzed: 1,
        totalLines: 30,
        totalLinesOfCode: 8,
        totalComments: 0,
        totalBlankLines: 0,
        totalFunctions: 2,
        totalClasses: 0,
        averageComplexity: 4,
        languages: { Python: 1 },
    });
    assert.deepEqual(outcome.written.files.map((item) => item.fileName), ['b.py', 'a.py']);

    const noSummary = await apply({ data: { files: [entry('a.py')] }, changeSet: { removedFiles: ['a.py'] } });
    assert.equal(noSummary.changed, true);
    assert.equal(noSummary.written.summary.totalFiles, 0);
    assert.equal(typeof noSummary.written.summary.analyzedAt, 'string');
});

test('missing saved path, missing data.json or unreadable JSON: false and nothing written', async () => {
    assert.equal((await apply({ data: XR_DATA, changeSet: { removedFiles: ['a.py'] }, noSavedPath: true })).changed, false);
    const noFile = await apply({ data: XR_DATA, changeSet: { removedFiles: ['a.py'] }, noDataJson: true });
    assert.equal(noFile.changed, false);
    assert.equal(noFile.written, undefined);
});

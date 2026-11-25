/**
 * Behavioural characterization of the two Git-history services and their
 * collaboration bridges (W5-01, hist TEST-01').
 *
 *   src/code_analysis/historical/historicalComparisonService.ts
 *   src/code_analysis/historical/projectEvolutionService.ts
 *   src/servers/runtime/analysis/historicalComparisonBridge.ts
 *   src/servers/runtime/analysis/projectEvolutionBridge.ts
 *
 * Until this suite the four files were pinned only by regexes over their own
 * text, which blocks every behaviour-neutral reshaping. Everything here runs
 * the compiled code from out/ under the fake vscode, against a real temporary
 * Git repository, with three seams replaced: the session registry (a stub
 * session), the Python analyzer (ExecutePython.prototype.executeAnalysis, a
 * recorder that returns a payload derived from what it was asked to analyze)
 * and the dimension-mapping storage. The source catalogue is injected through
 * the public constructor parameter unless a test is about the owned one.
 *
 * What it pins: the constructor throw matrix by analysis mode, availability,
 * the busy codes, the missing-target policy (historical throws and does not
 * cache; evolution caches missingTarget and records a per-frame exclusion),
 * the exact output of the directory and file decorators of both services,
 * cache isolation measured by analyzer call counts, the artifacts written,
 * that dispose disposes an owned catalogue only, and the bridge messages.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode, fakeExtensionContext } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

const HISTORICAL_MODULE = 'code_analysis/historical/historicalComparisonService.js';
const EVOLUTION_MODULE = 'code_analysis/historical/projectEvolutionService.js';
const HISTORICAL_BRIDGE_MODULE = 'servers/runtime/analysis/historicalComparisonBridge.js';
const EVOLUTION_BRIDGE_MODULE = 'servers/runtime/analysis/projectEvolutionBridge.js';

// ------------------------------------------------------------------ fixture repo

function runGit(cwd, args, env = {}) {
    return childProcess.execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

/**
 * repo/app/main.js, repo/app/util/helper.js        C1  (2024-01-01)
 * + repo/app/feature.js                             C2  (2024-02-01)
 * ~ repo/app/feature.js                             C3  (2024-03-01)
 */
function createFixtureRepository() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-git-services-'));
    const repo = path.join(root, 'repo');
    const app = path.join(repo, 'app');
    fs.mkdirSync(path.join(app, 'util'), { recursive: true });
    runGit(repo, ['init', '--quiet']);
    runGit(repo, ['config', 'user.name', 'CodeXR Tests']);
    runGit(repo, ['config', 'user.email', 'codexr-tests@example.invalid']);
    runGit(repo, ['config', 'commit.gpgsign', 'false']);
    const commit = (message, date) => {
        runGit(repo, ['add', '.']);
        runGit(repo, ['commit', '--quiet', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
        return runGit(repo, ['rev-parse', 'HEAD']);
    };
    fs.writeFileSync(path.join(app, 'main.js'), 'export const main = 1;\n');
    fs.writeFileSync(path.join(app, 'util', 'helper.js'), 'export const helper = 1;\nexport const two = 2;\n');
    const c1 = commit('first', '2024-01-01T10:00:00Z');
    fs.writeFileSync(path.join(app, 'feature.js'), 'export function run(a) { return a; }\n');
    const c2 = commit('second', '2024-02-01T10:00:00Z');
    fs.writeFileSync(path.join(app, 'feature.js'), 'export function run(a) { return a + 1; }\n');
    const c3 = commit('third', '2024-03-01T10:00:00Z');
    return { root, repo, app, feature: path.join(app, 'feature.js'), shas: { c1, c2, c3 } };
}

const fixture = createFixtureRepository();
test.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

// ------------------------------------------------------------------ harness

function walkFiles(directory) {
    const out = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            out.push(...walkFiles(full));
        } else {
            out.push(full);
        }
    }
    return out;
}

/** The analyzer stand-in: records every call and answers from the materialized target. */
function createAnalyzer() {
    const analyzer = {
        calls: [],
        respond: null,
        async run(session) {
            analyzer.calls.push({
                id: session.id,
                targetPath: session.targetPath,
                targetName: session.targetName,
                status: session.status,
                metadata: session.metadata,
            });
            if (analyzer.respond) {
                return analyzer.respond(session);
            }
            if (session.targetType === 'directory') {
                return walkFiles(session.targetPath).map((file) => ({
                    filePath: file,
                    fileName: path.basename(file),
                    totalLines: fs.readFileSync(file, 'utf8').split('\n').length - 1,
                }));
            }
            return [
                { functionName: 'run', parameters: 1, ccn: 2 },
                { functionName: 'run', parameters: 1, ccn: 1 },
                { functionName: '  Spaced  ', parameters: 0, ccn: 1 },
                { name: 'NamedOnly', ccn: 1 },
            ];
        },
    };
    return analyzer;
}

function createCatalog() {
    const catalog = {
        filterCalls: [],
        exclusions: [],
        disposed: 0,
        async filterSources(options) {
            catalog.filterCalls.push({
                repositoryRoot: options.repositoryRoot,
                targetRelativePath: options.targetRelativePath,
                ids: options.sources.map((source) => source.id),
            });
            return {
                sources: options.sources,
                eligibility: { scannedSourceCount: options.sources.length, usableSourceCount: options.sources.length, excludedSources: [] },
            };
        },
        recordDeterministicExclusion(source, code, reason) {
            const exclusion = {
                id: source.id,
                label: source.label,
                ...(source.kind === 'gitRef' ? { commitSha: source.commitSha } : {}),
                code,
                stage: 'analysis',
                reason,
            };
            catalog.exclusions.push(exclusion);
            return exclusion;
        },
        async dispose() {
            catalog.disposed += 1;
        },
    };
    return catalog;
}

function makeSession(overrides = {}) {
    const staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-git-services-static-'));
    return {
        id: 'sess-1',
        analysisMode: 'XR',
        targetType: 'directory',
        targetPath: fixture.app,
        targetName: 'app',
        isDeep: true,
        savedFilesPath: staticRoot,
        status: 'ready',
        ...overrides,
        staticRoot,
    };
}

function writeWorkingCopy(session, payload) {
    fs.writeFileSync(path.join(session.savedFilesPath, 'data.json'), JSON.stringify(payload));
}

/**
 * Loads the services with the three seams replaced, and hands the test what it
 * needs. Every out/ module loaded here is evicted afterwards (withFakeVscode).
 */
async function withServices(options, body) {
    const fake = createFakeVscode();
    const context = fakeExtensionContext();
    const analyzer = createAnalyzer();
    const sessions = new Map((options.sessions || []).map((session) => [session.id, session]));
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            const { UnifiedSessionRegistry } = requireOut('code_analysis/engine/core/sessionRegistry.js');
            UnifiedSessionRegistry.getInstance = () => ({ getSession: (id) => sessions.get(id) });
            const { ExecutePython } = requireOut('code_analysis/engine/utils/executePython.js');
            ExecutePython.prototype.executeAnalysis = function stubbedAnalysis(session) {
                return analyzer.run(session);
            };
            const { AnalysisConfigurationStorage } = requireOut('code_analysis/configuration/analysisConfigurationStorage.js');
            AnalysisConfigurationStorage.getInstance = () => ({
                getDimensionMappingFile: async () => ({ height: 'ccn', area: '', color: 7 }),
                getDimensionMappingDirectory: async () => ({ height: 'totalLines', width: 'totalLines', color: '' }),
            });
            const { GitRepositoryService } = requireOut('code_analysis/historical/gitRepositoryService.js');
            const materialized = [];
            const originalMaterialize = GitRepositoryService.prototype.materialize;
            GitRepositoryService.prototype.materialize = function countedMaterialize(source) {
                materialized.push(source.kind === 'gitRef' ? source.commitSha : source.id);
                return originalMaterialize.call(this, source);
            };
            const eligibility = requireOut('code_analysis/historical/gitAnalysisEligibility.js');
            const { HistoricalComparisonService } = requireOut(HISTORICAL_MODULE);
            const { ProjectEvolutionService } = requireOut(EVOLUTION_MODULE);
            await body({
                HistoricalComparisonService,
                ProjectEvolutionService,
                GitAnalysisSourceCatalog: eligibility.GitAnalysisSourceCatalog,
                GitAnalysisSourceError: eligibility.GitAnalysisSourceError,
                context,
                analyzer,
                materialized,
                requireOut,
            });
        });
    } finally {
        context.cleanup();
        for (const session of options.sessions || []) {
            fs.rmSync(session.staticRoot, { recursive: true, force: true });
        }
    }
}

async function sourcesBySha(service) {
    const references = await service.getReferences();
    const bySha = {};
    for (const source of references.sources) {
        if (source.kind === 'gitRef' && source.refType === 'commit') {
            bySha[source.commitSha] = source;
        }
    }
    return { references, bySha };
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function posix(value) {
    return value.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '');
}

// ------------------------------------------------------------------ construction and availability

test('constructor throw matrix: historical admits XR and LivePanel, evolution XR only', async () => {
    const xr = makeSession({ id: 'xr', analysisMode: 'XR' });
    const livePanel = makeSession({ id: 'lp', analysisMode: 'LivePanel' });
    const dom = makeSession({ id: 'dom', analysisMode: 'DOM' });
    await withServices({ sessions: [xr, livePanel, dom] }, async ({ HistoricalComparisonService, ProjectEvolutionService, context }) => {
        const outcome = (Service, id) => {
            try {
                new Service(context, id, xr.staticRoot, createCatalog());
                return 'ok';
            } catch (error) {
                return error.message;
            }
        };
        assert.deepEqual(
            ['xr', 'lp', 'dom', 'missing'].map((id) => outcome(HistoricalComparisonService, id)),
            ['ok', 'ok', 'historical-comparison-session-unavailable', 'historical-comparison-session-unavailable'],
        );
        assert.deepEqual(
            ['xr', 'lp', 'dom', 'missing'].map((id) => outcome(ProjectEvolutionService, id)),
            ['ok', 'project-evolution-session-unavailable', 'project-evolution-session-unavailable', 'project-evolution-session-unavailable'],
        );
    });
});

test('availability is the Git service answer with each mode\'s own reason', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-not-a-repo-'));
    const inRepo = makeSession({ id: 'in' });
    const notRepo = makeSession({ id: 'out', targetPath: outside });
    try {
        await withServices({ sessions: [inRepo, notRepo] }, async ({ HistoricalComparisonService, ProjectEvolutionService, context }) => {
            const answers = [];
            for (const Service of [HistoricalComparisonService, ProjectEvolutionService]) {
                for (const session of [inRepo, notRepo]) {
                    const service = new Service(context, session.id, session.staticRoot, createCatalog());
                    answers.push(await service.getAvailability());
                    await service.dispose();
                }
            }
            assert.deepEqual(answers, [
                { enabled: true, reason: null },
                { enabled: false, reason: 'The analyzed target is not inside a local Git repository.' },
                { enabled: true, reason: null },
                { enabled: false, reason: 'Project evolution requires a local Git repository.' },
            ]);
        });
    } finally {
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------------ historical comparison

test('historical getReferences runs the Git listing through the catalogue and reports the last successful request', async () => {
    const session = makeSession();
    writeWorkingCopy(session, [{ filePath: 'main.js', totalLines: 1 }]);
    await withServices({ sessions: [session] }, async ({ HistoricalComparisonService, context }) => {
        const catalog = createCatalog();
        const service = new HistoricalComparisonService(context, session.id, session.staticRoot, catalog);
        const { references, bySha } = await sourcesBySha(service);
        // realpathSync.native: on Windows os.tmpdir() can be an 8.3 short path
        // (RUNNER~1) while Git reports the long one; only the native call expands it.
        assert.equal(posix(fs.realpathSync.native(references.repositoryRoot)), posix(fs.realpathSync.native(fixture.repo)));
        assert.equal(references.targetRelativePath, 'app');
        assert.equal(references.activeRequest, null);
        assert.deepEqual(references.eligibility, { scannedSourceCount: references.sources.length, usableSourceCount: references.sources.length, excludedSources: [] });
        assert.equal(catalog.filterCalls.length, 1);
        assert.equal(catalog.filterCalls[0].targetRelativePath, 'app');
        assert.deepEqual(catalog.filterCalls[0].ids, references.sources.map((source) => source.id));
        assert.ok(references.sources.some((source) => source.id === 'working-copy'));
        assert.ok(!('suggestedSourceIds' in references));

        const request = { leftSourceId: bySha[fixture.shas.c1].id, rightSourceId: 'working-copy' };
        await service.compare(request);
        const after = await service.getReferences();
        assert.deepEqual(after.activeRequest, request);
        assert.notEqual(after.activeRequest, request, 'activeRequest is a copy');
        assert.equal(service.hasLiveSource(), true);
        await service.dispose();
    });
});

test('historical compare (directory): decorated payloads, delta, artifacts and the per-service analyzer cache', async () => {
    const session = makeSession();
    writeWorkingCopy(session, [
        { filePath: path.join(fixture.app, 'main.js'), fileName: 'main.js', totalLines: 1 },
        { filePath: path.join(fixture.app, 'util', 'helper.js'), fileName: 'helper.js', totalLines: 5 },
        { filePath: path.join(fixture.app, 'feature.js'), fileName: 'feature.js', totalLines: 1 },
    ]);
    await withServices({ sessions: [session] }, async ({ HistoricalComparisonService, context, analyzer, materialized }) => {
        const service = new HistoricalComparisonService(context, session.id, session.staticRoot, createCatalog());
        const { bySha } = await sourcesBySha(service);
        const left = bySha[fixture.shas.c1];
        const progress = [];
        const result = await service.compare(
            { leftSourceId: left.id, rightSourceId: 'working-copy' },
            (entry) => progress.push(entry),
        );

        // The analyzer ran once, on the private snapshot of C1, never on the live tree.
        assert.equal(analyzer.calls.length, 1);
        const call = analyzer.calls[0];
        assert.equal(call.id, `sess-1-comparison-${fixture.shas.c1.slice(0, 8)}`);
        assert.equal(call.status, 'analyzing');
        assert.equal(call.targetName, 'app');
        assert.deepEqual(call.metadata, { comparisonSource: { ...left } });
        assert.ok(
            posix(call.targetPath).startsWith(posix(path.join(context.storageUri.fsPath, 'historical-comparisons', 'sess-1', 'snapshots'))),
            call.targetPath,
        );
        assert.deepEqual(materialized, [fixture.shas.c1]);

        const target = posix(fixture.app);
        assert.deepEqual(result.left.source, left);
        assert.equal(result.right.source.id, 'working-copy');
        assert.equal(result.revision, 1);
        assert.equal(result.mode, 'historical-compare');
        assert.deepEqual(
            { url: result.left.url, itemCount: result.left.itemCount, missingTarget: result.left.missingTarget, warnings: result.left.warnings },
            { url: '/comparison/revision-1-left.json', itemCount: 2, missingTarget: false, warnings: [] },
        );
        assert.deepEqual(
            { url: result.right.url, itemCount: result.right.itemCount, missingTarget: result.right.missingTarget, warnings: result.right.warnings },
            { url: '/comparison/revision-1-right.json', itemCount: 3, missingTarget: false, warnings: [] },
        );
        assert.deepEqual(result.delta, {
            added: 1,
            removed: 0,
            modified: 1,
            unchanged: 1,
            metrics: [{ metric: 'totalLines', left: 3, right: 7, delta: 4 }],
        });

        const comparisonDirectory = path.join(session.staticRoot, 'comparison');
        assert.deepEqual(fs.readdirSync(comparisonDirectory).sort(), ['revision-1-left.json', 'revision-1-right.json', 'revision-1.json']);
        const leftPayload = readJson(path.join(comparisonDirectory, 'revision-1-left.json'));
        assert.deepEqual(leftPayload.map(({ filePath, relativePath, comparisonKey, fileName, totalLines }) => ({ filePath, relativePath, comparisonKey, fileName, totalLines })), [
            { filePath: `${target}/main.js`, relativePath: 'main.js', comparisonKey: 'file:main.js', fileName: 'main.js', totalLines: 1 },
            { filePath: `${target}/util/helper.js`, relativePath: 'util/helper.js', comparisonKey: 'file:util/helper.js', fileName: 'helper.js', totalLines: 2 },
        ]);
        const rightPayload = readJson(path.join(comparisonDirectory, 'revision-1-right.json'));
        assert.deepEqual(rightPayload.map((entry) => entry.comparisonKey), ['file:main.js', 'file:util/helper.js', 'file:feature.js']);
        assert.deepEqual(readJson(path.join(comparisonDirectory, 'revision-1.json')), JSON.parse(JSON.stringify(result)));

        assert.deepEqual(progress.map((entry) => entry.message), [
            'Resolving Git references...',
            `Analyzing ${left.label}...`,
            `Analyzing ${result.right.source.label}...`,
            'Historical comparison ready.',
        ]);
        assert.deepEqual(progress.at(-1), { state: 'ready', message: 'Historical comparison ready.', revision: 1 });

        // Second run: same commit, cached analysis (no analyzer call, no
        // materialization); the working copy is re-read every time.
        const second = await service.compare({ leftSourceId: left.id, rightSourceId: 'working-copy' });
        assert.equal(second.revision, 2);
        assert.equal(analyzer.calls.length, 1);
        assert.deepEqual(materialized, [fixture.shas.c1]);

        // A second service instance keeps its own cache.
        const other = new HistoricalComparisonService(context, session.id, session.staticRoot, createCatalog());
        await other.getReferences();
        await other.compare({ leftSourceId: left.id, rightSourceId: 'working-copy' });
        assert.equal(analyzer.calls.length, 2);
        await Promise.all([service.dispose(), other.dispose()]);
    });
});

test('historical compare (file): function rows keyed per signature with an ordinal, trimmed name, unknown fallback', async () => {
    const session = makeSession({ id: 'sess-file', targetType: 'file', targetPath: fixture.feature, targetName: 'feature.js' });
    await withServices({ sessions: [session] }, async ({ HistoricalComparisonService, context }) => {
        const service = new HistoricalComparisonService(context, session.id, session.staticRoot, createCatalog());
        const { bySha } = await sourcesBySha(service);
        const result = await service.compare({ leftSourceId: bySha[fixture.shas.c2].id, rightSourceId: bySha[fixture.shas.c3].id });
        const leftPayload = readJson(path.join(session.staticRoot, 'comparison', 'revision-1-left.json'));
        assert.deepEqual(leftPayload, [
            { functionName: 'run', parameters: 1, ccn: 2, filePath: 'feature.js', comparisonKey: 'function:feature.js:run#1:1' },
            { functionName: 'run', parameters: 1, ccn: 1, filePath: 'feature.js', comparisonKey: 'function:feature.js:run#1:2' },
            { functionName: '  Spaced  ', parameters: 0, ccn: 1, filePath: 'feature.js', comparisonKey: 'function:feature.js:spaced#0:1' },
            { name: 'NamedOnly', ccn: 1, filePath: 'feature.js', comparisonKey: 'function:feature.js:unknown#0:1' },
        ]);
        assert.deepEqual(result.delta, {
            added: 0,
            removed: 0,
            modified: 0,
            unchanged: 4,
            metrics: [{ metric: 'ccn', left: 5, right: 5, delta: 0 }],
        });
        await service.dispose();
    });
});

test('historical missing-target policy: a revision without the target throws, is excluded, and is not cached', async () => {
    const session = makeSession({ id: 'sess-file', targetType: 'file', targetPath: fixture.feature, targetName: 'feature.js' });
    await withServices({ sessions: [session] }, async ({ HistoricalComparisonService, GitAnalysisSourceError, context, analyzer, materialized }) => {
        const catalog = createCatalog();
        const service = new HistoricalComparisonService(context, session.id, session.staticRoot, catalog);
        const { bySha } = await sourcesBySha(service);
        const missing = bySha[fixture.shas.c1];
        const request = { leftSourceId: missing.id, rightSourceId: bySha[fixture.shas.c2].id };
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await assert.rejects(service.compare(request), (error) => {
                assert.ok(error instanceof GitAnalysisSourceError);
                assert.equal(error.code, 'comparison-source-no-data');
                assert.equal(error.message, `"${missing.label}" was removed from Git analyses: The analyzed target does not exist in this revision.`);
                assert.deepEqual(error.exclusions, [{
                    id: missing.id,
                    label: missing.label,
                    commitSha: fixture.shas.c1,
                    code: 'target-missing',
                    stage: 'analysis',
                    reason: 'The analyzed target does not exist in this revision.',
                }]);
                return true;
            });
        }
        assert.equal(catalog.exclusions.length, 2);
        assert.deepEqual(materialized, [fixture.shas.c1, fixture.shas.c1], 'not cached: materialized again');
        assert.equal(analyzer.calls.length, 0);
        assert.equal(service.isBusy(), false);
        assert.equal((await service.getReferences()).activeRequest, null);
        await service.dispose();
    });
});

test('precondition: historical analyzeSource never yields missingTarget, on either side, so the comparison needs no guard of its own', async () => {
    // Dataflow (W5-04): analyzeSource returns from three places only - the
    // working copy, a cache hit and a fresh analysis - and all three carry
    // missingTarget: false; the one missing-target path throws. A
    // missingTarget check after both sides were analyzed can never fire.
    const session = makeSession({ id: 'sess-file', targetType: 'file', targetPath: fixture.feature, targetName: 'feature.js' });
    writeWorkingCopy(session, [{ functionName: 'live', parameters: 0 }]);
    await withServices({ sessions: [session] }, async ({ HistoricalComparisonService, GitAnalysisSourceError, context, analyzer }) => {
        const service = new HistoricalComparisonService(context, session.id, session.staticRoot, createCatalog());
        const { bySha } = await sourcesBySha(service);
        const missing = bySha[fixture.shas.c1].id;
        for (const request of [
            { leftSourceId: bySha[fixture.shas.c2].id, rightSourceId: missing },
            { leftSourceId: 'working-copy', rightSourceId: missing },
        ]) {
            await assert.rejects(service.compare(request), (error) => {
                assert.ok(error instanceof GitAnalysisSourceError);
                assert.equal(error.code, 'comparison-source-no-data');
                assert.deepEqual(error.exclusions.map((entry) => entry.code), ['target-missing']);
                return true;
            });
        }
        // Fresh, cached and working-copy sides all report missingTarget: false.
        for (let run = 0; run < 2; run += 1) {
            const result = await service.compare({ leftSourceId: bySha[fixture.shas.c2].id, rightSourceId: 'working-copy' });
            assert.equal(result.left.missingTarget, false);
            assert.equal(result.right.missingTarget, false);
        }
        assert.equal(analyzer.calls.length, 1, 'C2 analyzed once, by the rejected first request, then served from the cache');
        await service.dispose();
    });
});

test('historical unusable payloads: each failure becomes the same exclusion error, other analyzer errors pass through', async () => {
    const session = makeSession();
    await withServices({ sessions: [session] }, async ({ HistoricalComparisonService, GitAnalysisSourceError, context, analyzer }) => {
        const service = new HistoricalComparisonService(context, session.id, session.staticRoot, createCatalog());
        const { bySha } = await sourcesBySha(service);
        const c1 = bySha[fixture.shas.c1];
        const c2 = bySha[fixture.shas.c2];

        const outcome = async (request) => {
            try {
                await service.compare(request);
                return 'ok';
            } catch (error) {
                return error instanceof GitAnalysisSourceError
                    ? `${error.code} | ${error.exclusions.map((entry) => `${entry.code}: ${entry.reason}`).join(', ')}`
                    : `Error: ${error.message}`;
            }
        };
        assert.equal(await outcome({ leftSourceId: c1.id, rightSourceId: c1.id }), 'Error: comparison-sources-must-differ');
        assert.equal(await outcome({ leftSourceId: '', rightSourceId: c1.id }), 'Error: comparison-sources-must-differ');
        // No data.json for the working copy yet.
        assert.equal(
            await outcome({ leftSourceId: c1.id, rightSourceId: 'working-copy' }).then((value) => value),
            'comparison-source-no-data | invalid-payload: The working copy data.json is missing or unreadable.',
        );
        writeWorkingCopy(session, { not: 'an array' });
        analyzer.respond = () => [];
        assert.equal(
            await outcome({ leftSourceId: c2.id, rightSourceId: 'working-copy' }),
            'comparison-source-no-data | no-analyzable-content: The analysis produced no data records.',
        );
        analyzer.respond = () => {
            throw new Error('JSON markers not found in output');
        };
        assert.equal(
            await outcome({ leftSourceId: bySha[fixture.shas.c3].id, rightSourceId: 'working-copy' }),
            'comparison-source-no-data | invalid-payload: The analyzer did not produce a readable JSON payload.',
        );
        analyzer.respond = () => {
            throw new Error('python exploded');
        };
        assert.equal(await outcome({ leftSourceId: bySha[fixture.shas.c3].id, rightSourceId: 'working-copy' }), 'Error: python exploded');
        analyzer.respond = () => [{ filePath: 'main.js' }];
        assert.equal(
            await outcome({ leftSourceId: bySha[fixture.shas.c3].id, rightSourceId: 'working-copy' }),
            'comparison-source-no-data | invalid-payload: The analysis did not produce a JSON array.',
        );
        await service.dispose();
    });
});

test('busy codes: one job per service; a second start is refused until the first settles', async () => {
    const session = makeSession();
    writeWorkingCopy(session, [{ filePath: 'main.js', totalLines: 1 }]);
    await withServices({ sessions: [session] }, async ({ HistoricalComparisonService, ProjectEvolutionService, context, analyzer }) => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        analyzer.respond = async () => {
            await gate;
            return [{ filePath: 'main.js', totalLines: 1 }];
        };
        const historical = new HistoricalComparisonService(context, session.id, session.staticRoot, createCatalog());
        const evolution = new ProjectEvolutionService(context, session.id, session.staticRoot, createCatalog());
        const { bySha } = await sourcesBySha(historical);
        const evolutionRefs = await evolution.getReferences();
        assert.equal(historical.isBusy(), false);
        assert.equal(evolution.isBusy(), false);

        const first = historical.compare({ leftSourceId: bySha[fixture.shas.c1].id, rightSourceId: 'working-copy' });
        const movie = evolution.generate({ mode: 'manual', sourceIds: [evolutionRefs.sources.find((s) => s.kind === 'gitRef' && s.commitSha === fixture.shas.c2 && s.refType === 'commit').id, 'working-copy'] }, () => {});
        assert.equal(historical.isBusy(), true);
        assert.equal(evolution.isBusy(), true);
        await assert.rejects(historical.compare({ leftSourceId: 'a', rightSourceId: 'b' }), /^Error: comparison-busy$/);
        await assert.rejects(evolution.generate({ mode: 'auto' }, () => {}), /^Error: project-evolution-busy$/);
        release();
        await first;
        await movie;
        assert.equal(historical.isBusy(), false);
        assert.equal(evolution.isBusy(), false);
        await Promise.all([historical.dispose(), evolution.dispose()]);
    });
});

test('historical refreshActiveComparison re-runs only a comparison with a live side', async () => {
    const session = makeSession();
    writeWorkingCopy(session, [{ filePath: 'main.js', totalLines: 1 }]);
    await withServices({ sessions: [session] }, async ({ HistoricalComparisonService, context }) => {
        const service = new HistoricalComparisonService(context, session.id, session.staticRoot, createCatalog());
        const { bySha } = await sourcesBySha(service);
        assert.equal(await service.refreshActiveComparison(), null);
        await service.compare({ leftSourceId: bySha[fixture.shas.c1].id, rightSourceId: bySha[fixture.shas.c2].id });
        assert.equal(service.hasLiveSource(), false);
        assert.equal(await service.refreshActiveComparison(), null);
        await service.compare({ leftSourceId: 'working-copy', rightSourceId: bySha[fixture.shas.c2].id });
        const refreshed = await service.refreshActiveComparison();
        assert.equal(refreshed.revision, 3);
        await service.dispose();
    });
});

// ------------------------------------------------------------------ project evolution

test('evolution generate (file): missing target cached and excluded per frame, plain function keys, artifacts and the frame bridge', async () => {
    const session = makeSession({ id: 'sess-file', targetType: 'file', targetPath: fixture.feature, targetName: 'feature.js' });
    await withServices({ sessions: [session] }, async ({ ProjectEvolutionService, context, analyzer, materialized }) => {
        writeWorkingCopy(session, [{ functionName: 'Live', parameters: 0 }]);
        const catalog = createCatalog();
        const service = new ProjectEvolutionService(context, session.id, session.staticRoot, catalog);
        const references = await service.getReferences();
        const commit = (sha) => references.sources.find((source) => source.kind === 'gitRef' && source.refType === 'commit' && source.commitSha === sha);
        const ids = [commit(fixture.shas.c1).id, commit(fixture.shas.c2).id, commit(fixture.shas.c3).id, 'working-copy'];
        const progress = [];
        const result = await service.generate({ mode: 'manual', sourceIds: ids }, (entry) => progress.push(entry));

        assert.equal(result.revision, 1);
        assert.equal(result.mode, 'project-evolution');
        assert.deepEqual(result.frames.map((frame) => [frame.index, frame.label, frame.url, frame.itemCount, frame.missingTarget, frame.date]), [
            [0, commit(fixture.shas.c2).label, '/evolution/revision-1/data1.json', 4, false, '2024-02-01'],
            [1, commit(fixture.shas.c3).label, '/evolution/revision-1/data2.json', 4, false, '2024-03-01'],
            [2, result.frames[2].source.label, '/evolution/revision-1/data3.json', 1, false, ''],
        ]);
        assert.equal(result.manifestUrl, '/evolution/revision-1/manifest.json');
        assert.equal(result.bridgeUrl, '/evolution/revision-1/data.json');
        assert.deepEqual(result.excludedSources, [{
            id: commit(fixture.shas.c1).id,
            label: commit(fixture.shas.c1).label,
            commitSha: fixture.shas.c1,
            code: 'target-missing',
            stage: 'analysis',
            reason: 'The analyzed target does not exist in this revision.',
        }]);

        const directory = path.join(session.staticRoot, 'evolution', 'revision-1');
        assert.deepEqual(fs.readdirSync(directory).sort(), ['data.json', 'data1.json', 'data2.json', 'data3.json', 'manifest.json']);
        assert.deepEqual(readJson(path.join(directory, 'data1.json')), [
            { functionName: 'run', parameters: 1, ccn: 2, evolutionKey: 'function:run' },
            { functionName: 'run', parameters: 1, ccn: 1, evolutionKey: 'function:run' },
            { functionName: '  Spaced  ', parameters: 0, ccn: 1, evolutionKey: 'function:  spaced  ' },
            { name: 'NamedOnly', ccn: 1, evolutionKey: 'function:namedonly' },
        ]);
        assert.deepEqual(readJson(path.join(directory, 'data3.json')), [{ functionName: 'Live', parameters: 0, evolutionKey: 'function:live' }]);
        assert.deepEqual(readJson(path.join(directory, 'data.json')), readJson(path.join(directory, 'data1.json')));
        assert.deepEqual(readJson(path.join(directory, 'manifest.json')), JSON.parse(JSON.stringify(result)));

        assert.equal(progress[0].message, 'Resolving project timeline...');
        assert.equal(progress[1].message, 'Analyzing 4 project revisions with 4 workers...');
        assert.ok(progress.some((entry) => entry.message === `Discarded ${commit(fixture.shas.c1).label}: The analyzed target does not exist in this revision.`));
        assert.deepEqual(progress.at(-1), {
            state: 'ready',
            message: 'Project evolution ready. 1 revision(s) were discarded because they had no usable data.',
            revision: 1,
            frameCount: 3,
        });

        assert.equal(analyzer.calls.length, 2);
        assert.deepEqual(analyzer.calls.map((call) => call.id).sort(), [
            `sess-file-evolution-${fixture.shas.c2.slice(0, 8)}`,
            `sess-file-evolution-${fixture.shas.c3.slice(0, 8)}`,
        ].sort());
        assert.ok(analyzer.calls.every((call) => 'projectEvolutionSource' in call.metadata));
        assert.ok(analyzer.calls.every((call) => posix(call.targetPath).startsWith(posix(path.join(context.storageUri.fsPath, 'project-evolution', 'sess-file', 'snapshots')))));
        assert.deepEqual([...materialized].sort(), [fixture.shas.c1, fixture.shas.c2, fixture.shas.c3].sort());

        // The frame bridge copies dataN.json over data.json for the current revision only.
        assert.deepEqual(await service.applyFrameToBridge(1, 1), { revision: 1, frameIndex: 1, bridgeUrl: '/evolution/revision-1/data.json' });
        assert.deepEqual(readJson(path.join(directory, 'data.json')), readJson(path.join(directory, 'data2.json')));
        await assert.rejects(service.applyFrameToBridge(2, 0), /^Error: project-evolution-invalid-revision$/);
        await assert.rejects(service.applyFrameToBridge(1, -1), /^Error: project-evolution-invalid-frame$/);

        // Second run: every commit (including the missing one) is cached.
        const second = await service.generate({ mode: 'manual', sourceIds: ids }, () => {});
        assert.equal(second.revision, 2);
        assert.equal(analyzer.calls.length, 2);
        assert.equal(materialized.length, 3);
        assert.equal(second.excludedSources.length, 1);
        assert.deepEqual((await service.getReferences()).activeRequest, { mode: 'manual', sourceIds: ids });

        // Clearing removes the current revision folder and the cache.
        await service.clearGeneratedMovie();
        assert.equal(fs.existsSync(path.join(session.staticRoot, 'evolution', 'revision-2')), false);
        assert.equal(fs.existsSync(path.join(session.staticRoot, 'evolution', 'revision-1')), true);
        assert.equal((await service.getReferences()).activeRequest, null);
        await service.generate({ mode: 'manual', sourceIds: ids }, () => {});
        assert.equal(analyzer.calls.length, 4, 'the cache was cleared');
        await service.dispose();
    });
});

test('precondition: every non-missing payload evolution analyzes is already a usable record list', async () => {
    // Dataflow (W5-07): analyzeSource returns a missing target, or
    // decorate(requireUsablePayload(...)); the decorators map record for
    // record and only add fields, so a frame always keeps every record the
    // analyzer produced and a second validation can never reject it.
    const session = makeSession();
    await withServices({ sessions: [session] }, async ({ ProjectEvolutionService, context, analyzer }) => {
        analyzer.respond = () => [{ filePath: 'a.js', m: 1 }, { filePath: 'b.js', m: 2 }, { filePath: 'b.js', m: 3 }];
        const service = new ProjectEvolutionService(context, session.id, session.staticRoot, createCatalog());
        const references = await service.getReferences();
        const commitId = (sha) => references.sources.find((s) => s.kind === 'gitRef' && s.refType === 'commit' && s.commitSha === sha).id;
        const result = await service.generate({ mode: 'manual', sourceIds: [commitId(fixture.shas.c1), commitId(fixture.shas.c2)] }, () => {});
        assert.deepEqual(result.frames.map((frame) => frame.itemCount), [3, 3]);
        assert.deepEqual(result.excludedSources, []);
        await service.dispose();
    });
});

test('evolution decorates directory frames like historical, with evolutionKey; the decorator edge cases are pinned on both', async () => {
    const session = makeSession();
    await withServices({ sessions: [session] }, async ({ HistoricalComparisonService, ProjectEvolutionService, context, analyzer }) => {
        analyzer.respond = (analyzed) => [
            { filePath: path.join(analyzed.targetPath, 'deep', 'inside.js'), m: 1 },
            { filePath: './x//y/', m: 1 },
            { relativePath: 'a\\b', m: 1 },
            { fileName: 'only-name.js', m: 1 },
            { m: 1 },
            { filePath: './//', m: 1 },
            { filePath: path.join(os.tmpdir(), 'elsewhere', 'outside.js'), m: 1 },
            { filePath: analyzed.targetPath, m: 1 },
        ];
        const expectedRelative = ['deep/inside.js', 'x/y', 'a/b', 'only-name.js', 'unknown', 'unknown', 'outside.js', ''];
        const target = posix(fixture.app);

        const historical = new HistoricalComparisonService(context, session.id, session.staticRoot, createCatalog());
        const { bySha } = await sourcesBySha(historical);
        await historical.compare({ leftSourceId: bySha[fixture.shas.c1].id, rightSourceId: bySha[fixture.shas.c2].id });
        const comparisonRows = readJson(path.join(session.staticRoot, 'comparison', 'revision-1-left.json'));
        assert.deepEqual(comparisonRows.map((row) => row.relativePath), expectedRelative);
        assert.deepEqual(comparisonRows.map((row) => row.filePath), expectedRelative.map((relative) => `${target}/${relative}`));
        assert.deepEqual(comparisonRows.map((row) => row.comparisonKey), expectedRelative.map((relative) => `file:${relative.toLocaleLowerCase()}`));
        assert.ok(comparisonRows.every((row) => row.m === 1 && !('evolutionKey' in row)));

        const evolution = new ProjectEvolutionService(context, session.id, session.staticRoot, createCatalog());
        const references = await evolution.getReferences();
        const commitId = (sha) => references.sources.find((s) => s.kind === 'gitRef' && s.refType === 'commit' && s.commitSha === sha).id;
        await evolution.generate({ mode: 'manual', sourceIds: [commitId(fixture.shas.c1), commitId(fixture.shas.c2)] }, () => {});
        const frameRows = readJson(path.join(session.staticRoot, 'evolution', 'revision-1', 'data1.json'));
        assert.deepEqual(frameRows.map((row) => row.relativePath), expectedRelative);
        assert.deepEqual(frameRows.map((row) => row.filePath), expectedRelative.map((relative) => `${target}/${relative}`));
        assert.deepEqual(frameRows.map((row) => row.evolutionKey), expectedRelative.map((relative) => `file:${relative.toLocaleLowerCase()}`));
        assert.ok(frameRows.every((row) => !('comparisonKey' in row)));
        await Promise.all([historical.dispose(), evolution.dispose()]);
    });
});

test('evolution references: timeline merged into the listing, suggested frames, maxFrames, and the catalogue sees the merge', async () => {
    const session = makeSession();
    writeWorkingCopy(session, [{ filePath: 'main.js', totalLines: 1 }]);
    await withServices({ sessions: [session] }, async ({ ProjectEvolutionService, context }) => {
        const catalog = createCatalog();
        const service = new ProjectEvolutionService(context, session.id, session.staticRoot, catalog);
        const references = await service.getReferences();
        assert.equal(references.maxFrames, 24);
        assert.equal(references.activeRequest, null);
        assert.equal(references.targetRelativePath, 'app');
        assert.deepEqual(catalog.filterCalls.map((call) => call.targetRelativePath), ['app']);
        const shaOf = (id) => references.sources.find((source) => source.id === id)?.commitSha || id;
        assert.deepEqual(references.suggestedSourceIds.map(shaOf), [fixture.shas.c1, fixture.shas.c2, fixture.shas.c3, 'working-copy']);
        await service.dispose();
    });
});

test('evolution with fewer than two usable revisions fails with the insufficient-data error and every exclusion', async () => {
    const session = makeSession({ id: 'sess-file', targetType: 'file', targetPath: fixture.feature, targetName: 'feature.js' });
    await withServices({ sessions: [session] }, async ({ ProjectEvolutionService, GitAnalysisSourceError, context, analyzer }) => {
        const service = new ProjectEvolutionService(context, session.id, session.staticRoot, createCatalog());
        const references = await service.getReferences();
        const commitId = (sha) => references.sources.find((s) => s.kind === 'gitRef' && s.refType === 'commit' && s.commitSha === sha).id;
        analyzer.respond = () => {
            throw new Error('python exploded');
        };
        await assert.rejects(
            service.generate({ mode: 'manual', sourceIds: [commitId(fixture.shas.c1), commitId(fixture.shas.c2), 'working-copy'] }, () => {}),
            (error) => {
                assert.ok(error instanceof GitAnalysisSourceError);
                assert.equal(error.code, 'project-evolution-insufficient-data');
                assert.equal(error.message, 'Project evolution needs at least two revisions with data; 0 remain after analysis.');
                assert.deepEqual(error.exclusions.map((entry) => [entry.code, entry.stage, entry.reason]), [
                    ['target-missing', 'analysis', 'The analyzed target does not exist in this revision.'],
                    ['analysis-failed', 'analysis', 'python exploded'],
                    ['invalid-payload', 'analysis', 'The working copy data.json is missing or unreadable.'],
                ]);
                return true;
            },
        );
        await assert.rejects(
            service.generate({ mode: 'manual', sourceIds: ['working-copy'] }, () => {}),
            /^GitAnalysisSourceError: Project evolution needs at least two revisions with data; 1 remain after filtering\.$/,
        );
        await service.dispose();
    });
});

// ------------------------------------------------------------------ dispose

test('dispose disposes an owned catalogue only, and removes the private snapshots', async () => {
    const session = makeSession();
    await withServices({ sessions: [session] }, async ({ HistoricalComparisonService, ProjectEvolutionService, GitAnalysisSourceCatalog, context }) => {
        let ownedDisposals = 0;
        const originalDispose = GitAnalysisSourceCatalog.prototype.dispose;
        GitAnalysisSourceCatalog.prototype.dispose = async function countedDispose() {
            ownedDisposals += 1;
            return originalDispose.call(this);
        };
        for (const [Service, folder] of [[HistoricalComparisonService, 'historical-comparisons'], [ProjectEvolutionService, 'project-evolution']]) {
            const shared = createCatalog();
            const withShared = new Service(context, session.id, session.staticRoot, shared);
            const snapshots = path.join(context.storageUri.fsPath, folder, session.id, 'snapshots');
            fs.mkdirSync(snapshots, { recursive: true });
            await withShared.dispose();
            assert.equal(shared.disposed, 0, 'an injected catalogue belongs to the host');
            assert.equal(fs.existsSync(snapshots), false);

            const owning = new Service(context, session.id, session.staticRoot);
            const before = ownedDisposals;
            await owning.dispose();
            assert.equal(ownedDisposals, before + 1, 'an owned catalogue is disposed with its service');
        }
    });
});

// ------------------------------------------------------------------ bridges

function createMessageContext() {
    const context = {
        roomId: 'room-1',
        log: [],
        send(message) {
            context.log.push(['send', message]);
        },
        broadcast(message) {
            context.log.push(['broadcast', message]);
        },
        upsertSharedEntity(entity) {
            context.log.push(['upsert', entity]);
        },
        removeSharedEntity(kind, id) {
            context.log.push(['remove', kind, id]);
        },
    };
    return context;
}

function createHost(services) {
    const host = {
        sessionId: 'sess-1',
        hasSession: true,
        view: { mode: 'single', viewRevision: 1 },
        calls: [],
        historicalComparisonService: services.historical || null,
        projectEvolutionService: services.evolution || null,
        getAnalysisViewState() {
            return host.view;
        },
        changeAnalysisViewMode(mode, controllerView) {
            host.calls.push(['change', mode, controllerView]);
            host.view = { mode, viewRevision: host.view.viewRevision + 1 };
            return host.view;
        },
        updateAnalysisViewIfCurrent(mode, revision, controllerView) {
            host.calls.push(['update', mode, revision, controllerView]);
        },
        notifyLivePanelHistoricalProgress(progress) {
            host.calls.push(['sse-progress', progress]);
        },
        notifyLivePanelHistoricalUpdated(revision) {
            host.calls.push(['sse-updated', revision]);
        },
    };
    return host;
}

function fakeService(overrides = {}) {
    return {
        busy: false,
        isBusy() {
            return this.busy;
        },
        async getReferences() {
            return { kind: 'references', from: this.name };
        },
        ...overrides,
    };
}

async function settle() {
    for (let index = 0; index < 10; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

async function withBridges(body) {
    const fake = createFakeVscode();
    await withFakeVscode(fake, async ({ requireOut }) => {
        const coordinatorModule = requireOut('code_analysis/refresh/analysisRefreshCoordinator.js');
        const coordinatorCalls = [];
        const coordinator = coordinatorModule.analysisRefreshCoordinator;
        coordinator.setRefreshEnabled = (...args) => coordinatorCalls.push(['setRefreshEnabled', ...args]);
        coordinator.setSnapshotAvailable = (...args) => coordinatorCalls.push(['setSnapshotAvailable', ...args]);
        coordinator.refreshMode = async (...args) => {
            coordinatorCalls.push(['refreshMode', ...args]);
        };
        const { GitAnalysisSourceError } = requireOut('code_analysis/historical/gitAnalysisEligibility.js');
        const { HistoricalComparisonBridge } = requireOut(HISTORICAL_BRIDGE_MODULE);
        const { ProjectEvolutionBridge } = requireOut(EVOLUTION_BRIDGE_MODULE);
        await body({ HistoricalComparisonBridge, ProjectEvolutionBridge, GitAnalysisSourceError, coordinatorCalls });
    });
}

test('bridges: without their service every handler declines the message', async () => {
    await withBridges(async ({ HistoricalComparisonBridge, ProjectEvolutionBridge }) => {
        const host = createHost({});
        const historical = new HistoricalComparisonBridge(host);
        const evolution = new ProjectEvolutionBridge(host);
        const messageContext = createMessageContext();
        assert.equal(await historical.handleHistoricalComparisonReferencesMessage(messageContext), false);
        assert.equal(historical.handleHistoricalComparisonStartMessage(messageContext, { payload: {} }), false);
        assert.equal(await evolution.handleProjectEvolutionReferencesMessage(messageContext), false);
        assert.equal(await evolution.handleProjectEvolutionClearMessage(messageContext), false);
        assert.equal(await evolution.handleProjectEvolutionApplyFrameMessage(messageContext, { payload: {} }), false);
        assert.equal(evolution.handleProjectEvolutionStartMessage(messageContext, { payload: {} }), false);
        assert.deepEqual(messageContext.log, []);
    });
});

test('bridges: references requests answer the requester, and a failure is a references-unavailable error', async () => {
    await withBridges(async ({ HistoricalComparisonBridge, ProjectEvolutionBridge }) => {
        const okHost = createHost({ historical: fakeService({ name: 'historical' }), evolution: fakeService({ name: 'evolution' }) });
        const failing = async () => {
            throw new Error('git is gone');
        };
        const failHost = createHost({
            historical: fakeService({ getReferences: failing }),
            evolution: fakeService({ getReferences: async () => {
                throw 'plain string';
            } }),
        });
        const log = [];
        for (const host of [okHost, failHost]) {
            const messageContext = createMessageContext();
            assert.equal(await new HistoricalComparisonBridge(host).handleHistoricalComparisonReferencesMessage(messageContext), true);
            assert.equal(await new ProjectEvolutionBridge(host).handleProjectEvolutionReferencesMessage(messageContext), true);
            log.push(...messageContext.log);
        }
        assert.deepEqual(log, [
            ['send', { type: 'historical-comparison-references', payload: { kind: 'references', from: 'historical' } }],
            ['send', { type: 'project-evolution-references', payload: { kind: 'references', from: 'evolution' } }],
            ['send', { type: 'historical-comparison-error', payload: { code: 'references-unavailable', message: 'git is gone' } }],
            ['send', { type: 'project-evolution-error', payload: { code: 'references-unavailable', message: 'plain string' } }],
        ]);
    });
});

test('bridges: a busy service refuses the start with its own code', async () => {
    await withBridges(async ({ HistoricalComparisonBridge, ProjectEvolutionBridge, coordinatorCalls }) => {
        const host = createHost({ historical: fakeService({ busy: true }), evolution: fakeService({ busy: true }) });
        const messageContext = createMessageContext();
        assert.equal(new HistoricalComparisonBridge(host).handleHistoricalComparisonStartMessage(messageContext, { payload: {} }), true);
        assert.equal(new ProjectEvolutionBridge(host).handleProjectEvolutionStartMessage(messageContext, { payload: {} }), true);
        assert.deepEqual(messageContext.log, [
            ['send', { type: 'historical-comparison-error', payload: { code: 'comparison-busy', message: 'Another historical comparison is already running.' } }],
            ['send', { type: 'project-evolution-error', payload: { code: 'project-evolution-busy', message: 'Another project evolution analysis is already running.' } }],
        ]);
        assert.deepEqual(coordinatorCalls, []);
        assert.deepEqual(host.calls, []);
    });
});

test('historical bridge start: switches the view, broadcasts progress, shares the result, moves to the mapping view', async () => {
    await withBridges(async ({ HistoricalComparisonBridge, coordinatorCalls }) => {
        const requests = [];
        const host = createHost({
            historical: fakeService({
                async compare(request, onProgress) {
                    requests.push(request);
                    onProgress({ state: 'analyzing', message: 'step' });
                    return { revision: 7 };
                },
            }),
        });
        const messageContext = createMessageContext();
        assert.equal(new HistoricalComparisonBridge(host).handleHistoricalComparisonStartMessage(messageContext, {
            payload: { leftSourceId: 'working-copy', rightSourceId: 42 },
        }), true);
        await settle();
        assert.deepEqual(requests, [{ leftSourceId: 'working-copy', rightSourceId: '42' }]);
        assert.deepEqual(host.calls, [
            ['change', 'historical-compare', 'historical.selection'],
            ['update', 'historical-compare', 2, 'historical.mapping'],
        ]);
        assert.deepEqual(coordinatorCalls, [
            ['setRefreshEnabled', 'sess-1', 'historical-compare', true],
            ['refreshMode', 'sess-1', 'historical-compare'],
            ['setSnapshotAvailable', 'sess-1', 'historical-compare', true],
        ]);
        assert.deepEqual(messageContext.log, [
            ['broadcast', { type: 'historical-comparison-progress', payload: { state: 'analyzing', message: 'step' } }],
            ['upsert', { entityKind: 'historical-comparison', entityId: 'main', mode: 'historical-compare', result: { revision: 7 } }],
        ]);
    });
});

test('evolution bridge start: request normalization, view, progress, shared result', async () => {
    await withBridges(async ({ ProjectEvolutionBridge, coordinatorCalls }) => {
        const requests = [];
        const host = createHost({
            evolution: fakeService({
                async generate(request, onProgress) {
                    requests.push(request);
                    onProgress({ state: 'analyzing', message: 'frame' });
                    return { revision: 3 };
                },
            }),
        });
        host.view = { mode: 'project-evolution', viewRevision: 9 };
        const messageContext = createMessageContext();
        const bridge = new ProjectEvolutionBridge(host);
        bridge.handleProjectEvolutionStartMessage(messageContext, {
            payload: { mode: 'range', startSourceId: 's', endSourceId: 5, sourceIds: ['a', 0, '', 'b'], maxFrames: '12' },
        });
        bridge.handleProjectEvolutionStartMessage(createMessageContext(), { payload: { mode: 'weird', maxFrames: 'x' } });
        await settle();
        assert.deepEqual(requests, [
            { mode: 'range', startSourceId: 's', endSourceId: undefined, sourceIds: ['a', '0', 'b'], maxFrames: 12 },
            { mode: 'auto', startSourceId: undefined, endSourceId: undefined, sourceIds: undefined, maxFrames: undefined },
        ]);
        assert.deepEqual(host.calls, [
            ['update', 'project-evolution', 9, 'project-evolution'],
            ['update', 'project-evolution', 9, 'project-evolution'],
        ]);
        assert.deepEqual(coordinatorCalls.slice(0, 1), [['setRefreshEnabled', 'sess-1', 'project-evolution', false]]);
        assert.deepEqual(messageContext.log, [
            ['broadcast', { type: 'project-evolution-progress', payload: { state: 'analyzing', message: 'frame' } }],
            ['upsert', { entityKind: 'project-evolution', entityId: 'main', mode: 'project-evolution', result: { revision: 3 } }],
        ]);
    });
});

test('bridges: start failures re-broadcast both reference lists for source errors, then the error payload', async () => {
    await withBridges(async ({ HistoricalComparisonBridge, ProjectEvolutionBridge, GitAnalysisSourceError }) => {
        const failures = [
            new GitAnalysisSourceError('comparison-source-no-data', 'removed', []),
            new Error('plain failure'),
            'not an error',
        ];
        const transcripts = [];
        for (const failure of failures) {
            for (const kind of ['historical', 'evolution']) {
                const reject = async () => {
                    throw failure;
                };
                const host = createHost({
                    historical: fakeService({ name: 'historical', compare: reject }),
                    evolution: fakeService({ name: 'evolution', generate: reject }),
                });
                const messageContext = createMessageContext();
                if (kind === 'historical') {
                    new HistoricalComparisonBridge(host).handleHistoricalComparisonStartMessage(messageContext, { payload: {} });
                } else {
                    new ProjectEvolutionBridge(host).handleProjectEvolutionStartMessage(messageContext, { payload: {} });
                }
                await settle();
                transcripts.push(messageContext.log);
            }
        }
        const references = [
            ['broadcast', { type: 'historical-comparison-references', payload: { kind: 'references', from: 'historical' } }],
            ['broadcast', { type: 'project-evolution-references', payload: { kind: 'references', from: 'evolution' } }],
        ];
        assert.deepEqual(transcripts, [
            [...references, ['broadcast', { type: 'historical-comparison-error', payload: { code: 'comparison-source-no-data', message: 'removed' } }]],
            [...references, ['broadcast', { type: 'project-evolution-error', payload: { code: 'comparison-source-no-data', message: 'removed' } }]],
            [['broadcast', { type: 'historical-comparison-error', payload: { code: 'plain failure', message: 'plain failure' } }]],
            [['broadcast', { type: 'project-evolution-error', payload: { code: 'plain failure', message: 'plain failure' } }]],
            [['broadcast', { type: 'historical-comparison-error', payload: { code: 'comparison-failed', message: 'not an error' } }]],
            [['broadcast', { type: 'project-evolution-error', payload: { code: 'project-evolution-failed', message: 'not an error' } }]],
        ]);
    });
});

test('bridges: a source error re-broadcasts only the reference lists whose service exists', async () => {
    await withBridges(async ({ HistoricalComparisonBridge, GitAnalysisSourceError }) => {
        const host = createHost({
            historical: fakeService({
                name: 'historical',
                compare: async () => {
                    throw new GitAnalysisSourceError('comparison-source-no-data', 'gone', []);
                },
            }),
        });
        const messageContext = createMessageContext();
        new HistoricalComparisonBridge(host).handleHistoricalComparisonStartMessage(messageContext, { payload: {} });
        await settle();
        assert.deepEqual(messageContext.log.map(([, message]) => message.type), [
            'historical-comparison-references',
            'historical-comparison-error',
        ]);
    });
});

test('evolution bridge: a cleared movie is silent; clear and apply-frame report their own outcomes', async () => {
    await withBridges(async ({ ProjectEvolutionBridge, coordinatorCalls }) => {
        const host = createHost({
            evolution: fakeService({
                async generate() {
                    throw new Error('project-evolution-cleared');
                },
                async clearGeneratedMovie() {},
                async applyFrameToBridge(revision, frameIndex) {
                    if (frameIndex < 0) {
                        throw new Error('project-evolution-invalid-frame');
                    }
                    return { revision, frameIndex, bridgeUrl: 'u' };
                },
            }),
        });
        const bridge = new ProjectEvolutionBridge(host);
        const started = createMessageContext();
        bridge.handleProjectEvolutionStartMessage(started, { payload: {} });
        await settle();
        assert.deepEqual(started.log, []);

        // Apply-frame is ignored outside the evolution view, answered inside it.
        const outside = createMessageContext();
        host.view = { mode: 'single', viewRevision: 1 };
        assert.equal(await bridge.handleProjectEvolutionApplyFrameMessage(outside, { payload: { revision: 1, frameIndex: 0 } }), true);
        assert.deepEqual(outside.log, []);
        host.view = { mode: 'project-evolution', viewRevision: 4 };
        const applied = createMessageContext();
        await bridge.handleProjectEvolutionApplyFrameMessage(applied, { payload: { revision: '2', frameIndex: 1, requestId: 'r1' } });
        await bridge.handleProjectEvolutionApplyFrameMessage(applied, { payload: { revision: 2, frameIndex: -1, requestId: 7 } });
        assert.deepEqual(applied.log, [
            ['broadcast', { type: 'project-evolution-frame-applied', payload: { revision: 2, frameIndex: 1, bridgeUrl: 'u', requestId: 'r1' } }],
            ['broadcast', { type: 'project-evolution-error', payload: { code: 'project-evolution-invalid-frame', message: 'project-evolution-invalid-frame' } }],
        ]);

        coordinatorCalls.length = 0;
        host.calls.length = 0;
        const cleared = createMessageContext();
        assert.equal(await bridge.handleProjectEvolutionClearMessage(cleared), true);
        assert.deepEqual(cleared.log, [
            ['remove', 'project-evolution', 'main'],
            ['broadcast', { type: 'project-evolution-cleared', payload: { message: 'Project evolution movie cleared.' } }],
        ]);
        assert.deepEqual(coordinatorCalls, [['setSnapshotAvailable', 'sess-1', 'project-evolution', false]]);
        assert.deepEqual(host.calls, [['update', 'project-evolution', 4, 'project-evolution']]);
    });
});

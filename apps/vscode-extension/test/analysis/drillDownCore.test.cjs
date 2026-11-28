/**
 * #333 drill-down, the shared core (src/core/drilldown/) and its server
 * bridge: paths and crumbs, the history, the per-file hash cache, and the
 * service end to end with a fake analyzer over real files, so a jump is
 * proved to send Python only the files with no result or a changed hash.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const out = (...parts) => require(path.join(projectRoot, 'out', 'core', ...parts));

const paths = out('drilldown', 'drillDownPaths.js');
const { DrillHistory } = out('drilldown', 'drillDownHistory.js');
const { DrillFileCache } = out('drilldown', 'drillDownFileCache.js');
const { DrillDownService, DrillRequestError } = out('drilldown', 'drillDownService.js');
const { DRILL_DOWN_MESSAGES } = out('drilldown', 'drillDownModels.js');

const realIo = {
    stat: async (file) => {
        try {
            const stat = await fs.promises.stat(file);
            return { size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
            return null;
        }
    },
    hash: async (file) => crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex'),
};

function makeProject() {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-drill-')));
    const write = (relative, text) => {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        return file;
    };
    write('src/a.ts', 'export const a = 1;\n');
    write('src/b.ts', 'export const b = 2;\n');
    write('src/util/c.ts', 'export const c = 3;\n');
    write('docs/readme.ts', 'export {};\n');
    return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function listFiles(folder, deep) {
    const files = [];
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) {
            if (deep && entry.name !== 'drilldown') {
                files.push(...listFiles(full, deep));
            }
        } else if (entry.name.endsWith('.ts')) {
            files.push(full);
        }
    }
    return files.sort();
}

function fakeAnalyzer() {
    const calls = { files: [], functions: [] };
    return {
        calls,
        listFolderFiles: async (folder, deep) => listFiles(folder, deep),
        analyzeFiles: async (files) => {
            calls.files.push([...files]);
            return files.map((file) => ({ filePath: file, fileName: path.basename(file), functionCount: 1, totalLines: 1 }));
        },
        analyzeFunctions: async (file) => {
            calls.functions.push(file);
            return [{ functionName: 'f', filePath: file, lineStart: 1, treePath: `${path.basename(file)}/f` }];
        },
        io: realIo,
    };
}

function makeService(project, overrides = {}) {
    const analyzer = overrides.analyzer ?? fakeAnalyzer();
    const published = [];
    const modes = [];
    const staticRoot = path.join(project.root, '.static');
    const service = new DrillDownService({
        targetPath: project.root,
        targetType: 'directory',
        isDeep: true,
        staticRoot,
        workspaceFolders: [project.root],
        analyzer,
        readSessionSeed: overrides.readSessionSeed,
        resolveChart: async (kind) => ({ chartId: 'boats', mapping: { kind } }),
        publish: (entity) => published.push(entity),
        activate: (mode) => { modes.push(mode); },
        loadingDelayMs: overrides.loadingDelayMs ?? 10000,
        caseInsensitivePaths: false,
    });
    return { service, analyzer, published, modes, staticRoot, last: () => published.at(-1) };
}

// ── paths ────────────────────────────────────────────────────────────

test('the boundary root is the deepest workspace folder holding the target, else the target folder', () => {
    const ws = path.join(path.sep, 'w', 'proj');
    assert.equal(paths.resolveBoundaryRoot(path.join(ws, 'src'), 'directory', [path.join(path.sep, 'w'), ws]), ws);
    assert.equal(paths.resolveBoundaryRoot(path.join(path.sep, 'x', 'lib'), 'directory', [ws]), path.join(path.sep, 'x', 'lib'));
    assert.equal(paths.resolveBoundaryRoot(path.join(path.sep, 'x', 'a.ts'), 'file', []), path.join(path.sep, 'x'));
});

test('scene paths resolve absolute first, then relative, and never escape the root', () => {
    const root = path.join(path.sep, 'w', 'proj');
    assert.equal(paths.resolveScenePath(root, `${root}/src/a.ts`.replace(/\\/g, '/')), path.join(root, 'src', 'a.ts'));
    assert.equal(paths.resolveScenePath(root, 'src/util'), path.join(root, 'src', 'util'));
    assert.equal(paths.resolveScenePath(root, '../etc/passwd'), null);
    assert.equal(paths.resolveScenePath(root, '/etc/passwd'), null);
    assert.equal(paths.toRelative(root, path.join(root, 'src', 'a.ts')), 'src/a.ts');
    assert.equal(paths.toRelative(root, root), '');
});

test('crumbs run from the root to the target, marking home', () => {
    const crumbs = paths.buildCrumbs({ kind: 'file', relativePath: 'src/util/c.ts' }, { kind: 'directory', relativePath: '' }, 'proj');
    assert.deepEqual(crumbs.map((c) => [c.label, c.relativePath, c.kind, c.home]), [
        ['proj', '', 'directory', true],
        ['src', 'src', 'directory', false],
        ['util', 'src/util', 'directory', false],
        ['c.ts', 'src/util/c.ts', 'file', false],
    ]);
});

// ── history ──────────────────────────────────────────────────────────

test('the history keeps home first, truncates the forward stack and restores a snapshot', () => {
    const history = new DrillHistory({ kind: 'directory', relativePath: '' });
    assert.equal(history.atHome, true);
    assert.equal(history.canBack, false);
    history.push({ kind: 'directory', relativePath: 'src' });
    history.push({ kind: 'file', relativePath: 'src/a.ts' });
    history.push({ kind: 'file', relativePath: 'src/a.ts' });
    assert.equal(history.length, 3, 'pushing the current target again is ignored');
    const snapshot = history.snapshot();
    assert.deepEqual(history.back(), { kind: 'directory', relativePath: 'src' });
    assert.equal(history.canForward, true);
    history.push({ kind: 'directory', relativePath: 'docs' });
    assert.equal(history.canForward, false, 'a new jump drops the forward stack');
    history.goHome();
    assert.equal(history.atHome, true);
    assert.equal(history.canBack, true, 'home is a move, so Back returns to the drilled target');
    history.reset(snapshot);
    assert.deepEqual(history.current, { kind: 'file', relativePath: 'src/a.ts' });
});

// ── file cache ───────────────────────────────────────────────────────

test('the file cache reuses unchanged files, hashes touched ones, and flags edited ones', async () => {
    const project = makeProject();
    try {
        const cache = new DrillFileCache(realIo);
        const a = path.join(project.root, 'src', 'a.ts');
        const b = path.join(project.root, 'src', 'b.ts');
        await cache.store([{ filePath: a, value: 'A' }, { filePath: b, value: 'B' }]);
        let report = await cache.check([a, b, path.join(project.root, 'src', 'new.ts')]);
        assert.deepEqual([...report.reused.keys()], [a, b]);
        assert.deepEqual(report.missing.length, 1, 'a file that does not exist is missing, not stale');

        const later = new Date(Date.now() + 5000);
        fs.utimesSync(a, later, later);
        fs.writeFileSync(b, 'export const b = 22;\n');
        report = await cache.check([a, b]);
        assert.deepEqual([...report.reused.keys()], [a], 'a touch without an edit keeps its value');
        assert.deepEqual(report.stale, [b], 'an edited file is analysed again');
    } finally {
        project.cleanup();
    }
});

test('seeding never overwrites an entry with the same hash, and a seed without a hash is checked by hash', async () => {
    const project = makeProject();
    try {
        const cache = new DrillFileCache(realIo);
        const a = path.join(project.root, 'src', 'a.ts');
        const hash = await realIo.hash(a);
        assert.equal(cache.seed([{ filePath: a, value: 'seed', hash }]), 1);
        assert.equal(cache.seed([{ filePath: a, value: 'other', hash }]), 0);
        assert.equal(cache.get(a), 'seed');
        const report = await cache.check([a]);
        assert.equal(report.reused.get(a), 'seed');
    } finally {
        project.cleanup();
    }
});

// ── service ──────────────────────────────────────────────────────────

test('a folder jump analyses only the files the session has not analysed, and a second jump none', async () => {
    const project = makeProject();
    try {
        const a = path.join(project.root, 'src', 'a.ts');
        const seedRows = [{ filePath: a, fileName: 'a.ts', functionCount: 9, totalLines: 9 }];
        const seedHashes = [{ filePath: a, hash: await realIo.hash(a) }];
        const { service, analyzer, last, modes, staticRoot } = makeService(project, {
            readSessionSeed: () => ({ rows: seedRows, hashes: seedHashes }),
        });

        await service.open(path.join(project.root, 'src'), 'directory');
        assert.deepEqual(analyzer.calls.files, [[path.join(project.root, 'src', 'b.ts'), path.join(project.root, 'src', 'util', 'c.ts')]]);
        let entity = last();
        assert.equal(entity.status, 'ready');
        assert.equal(entity.analyzedCount, 2);
        assert.equal(entity.reusedCount, 1);
        assert.equal(entity.source, 'analysis');
        assert.equal(entity.treeField, 'drillPath', 'the drilled city starts at the folder');
        assert.deepEqual(entity.crumbs.map((c) => c.relativePath), ['', 'src']);
        assert.deepEqual(modes, ['drill-down']);
        const rows = JSON.parse(fs.readFileSync(path.join(staticRoot, entity.datasetUrl), 'utf8'));
        assert.deepEqual(rows.map((r) => r.relativePath), ['a.ts', 'b.ts', 'util/c.ts'], 'relativePath is re-rooted at the folder');
        assert.deepEqual(rows.map((r) => r.drillPath), ['src/a.ts', 'src/b.ts', 'src/util/c.ts'], 'the folder is the top district');
        assert.equal(rows[0].functionCount, 9, 'the session row is reused as it is');

        await service.open(path.join(project.root, 'src', 'util'), 'directory');
        entity = last();
        assert.equal(analyzer.calls.files.length, 1, 'every file of the sub-folder is cached already');
        assert.equal(entity.source, 'cache');
        assert.equal(entity.analyzedCount, 0);
        assert.equal(entity.canBack, true);
    } finally {
        project.cleanup();
    }
});

test('an edited file is analysed again after the session reports a change', async () => {
    const project = makeProject();
    try {
        const { service, analyzer, last } = makeService(project);
        await service.open('src', 'directory');
        assert.equal(analyzer.calls.files.length, 1);
        project.write('src/b.ts', 'export const b = 200;\n');
        await service.handleSourcesChanged();
        assert.deepEqual(analyzer.calls.files.at(-1), [path.join(project.root, 'src', 'b.ts')]);
        assert.equal(last().analyzedCount, 1);
    } finally {
        project.cleanup();
    }
});

test('a file jump uses the function cache by hash, and back, forward and home walk the history', async () => {
    const project = makeProject();
    try {
        const { service, analyzer, last, modes } = makeService(project);
        const file = path.join(project.root, 'src', 'a.ts');
        await service.open(path.join(project.root, 'src'), 'directory');
        await service.open(file, 'file');
        assert.equal(last().treeField, 'treePath');
        assert.deepEqual(analyzer.calls.functions, [file]);

        await service.back();
        assert.equal(last().target.relativePath, 'src');
        await service.forward();
        assert.equal(last().target.relativePath, 'src/a.ts');
        assert.deepEqual(analyzer.calls.functions, [file], 'the unchanged file came from the cache');
        assert.equal(last().source, 'cache');

        await service.goHome();
        assert.equal(last().atHome, true);
        assert.equal(modes.at(-1), 'single');
        await service.goto('src/a.ts', 'file');
        assert.equal(last().target.relativePath, 'src/a.ts');
    } finally {
        project.cleanup();
    }
});

test('a refused jump leaves the history as it was and names the reason', async () => {
    const project = makeProject();
    try {
        const { service, last } = makeService(project);
        await service.open('src', 'directory');
        await assert.rejects(service.open('../outside', 'directory'), DrillRequestError);
        await assert.rejects(service.open('src/a.ts', 'directory'), /is not a folder/);
        await assert.rejects(service.open('src/gone.ts', 'file'), /no longer exists/);
        assert.equal(service.current.relativePath, 'src');

        const failing = makeService(project, { analyzer: { ...fakeAnalyzer(), analyzeFunctions: async () => { throw new Error('boom'); } } });
        await assert.rejects(failing.service.open('src/a.ts', 'file'), /Could not analyse src\/a.ts: boom/);
        assert.equal(failing.last().status, 'error');
        assert.equal(failing.service.current.relativePath, '', 'the failed target was taken off the history');
        assert.equal(last().status, 'ready');
    } finally {
        project.cleanup();
    }
});

test('a slow jump publishes the loading state; the classic analysis picked from the menu becomes home', async () => {
    const project = makeProject();
    try {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const analyzer = { ...fakeAnalyzer(), analyzeFiles: async (files) => { await gate; return files.map((f) => ({ filePath: f, fileName: path.basename(f) })); } };
        const { service, published, last } = makeService(project, { analyzer, loadingDelayMs: 5 });
        const jump = service.open('src', 'directory');
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(last().status, 'loading');
        assert.deepEqual(last().pending, { kind: 'directory', relativePath: 'src' });
        release();
        await jump;
        assert.equal(last().status, 'ready');
        assert.ok(published.some((e) => e.status === 'loading'));

        service.noteHomeShown();
        assert.equal(last().atHome, true);
        assert.equal(last().canBack, true);
    } finally {
        project.cleanup();
    }
});

// ── bridge and host entry ───────────────────────────────────────────

test('the bridge routes the drilldown messages and answers a refusal to the requester only', async () => {
    const { DrillDownBridge } = out('server', 'analysis', 'drillDownBridge.js');
    const calls = [];
    const service = {
        open: async (p, kind) => { calls.push(['open', p, kind]); },
        goto: async (p, kind) => { calls.push(['goto', p, kind]); },
        back: async () => { calls.push(['back']); },
        forward: async () => { calls.push(['forward']); },
        goHome: async () => { throw new DrillRequestError('nope'); },
        publishCurrent: () => { calls.push(['state']); },
    };
    const sent = [];
    const context = { send: (message) => sent.push(message) };
    const bridge = new DrillDownBridge(() => service);
    assert.equal(await bridge.handleMessage(context, { type: DRILL_DOWN_MESSAGES.open, payload: { path: '/p/src', kind: 'file' } }), true);
    await bridge.handleMessage(context, { type: DRILL_DOWN_MESSAGES.goto, payload: { relativePath: 'src', kind: 'weird' } });
    await bridge.handleMessage(context, { type: DRILL_DOWN_MESSAGES.back });
    await bridge.handleMessage(context, { type: DRILL_DOWN_MESSAGES.state });
    assert.deepEqual(calls, [['open', '/p/src', 'file'], ['goto', 'src', 'directory'], ['back'], ['state']]);
    assert.equal(await bridge.handleMessage(context, { type: 'toString' }), false);
    await bridge.handleMessage(context, { type: DRILL_DOWN_MESSAGES.home });
    assert.deepEqual(sent, [{ type: DRILL_DOWN_MESSAGES.error, payload: { message: 'nope' } }]);

    const absent = new DrillDownBridge(() => null);
    await absent.handleMessage(context, { type: DRILL_DOWN_MESSAGES.back });
    assert.match(sent.at(-1).payload.message, /not available/);
});

test('the host entry asks only the running scenes that cover the target', () => {
    const { drillKindOf, drillDownInScenes } = out('server', 'analysis', 'sceneDrillDown.js');
    const { getActiveServerRegistry } = out('server', 'registry', 'activeServerRegistry.js');
    const project = makeProject();
    const registry = getActiveServerRegistry();
    const original = registry.getServersByStatus;
    try {
        assert.equal(drillKindOf(path.join(project.root, 'src')), 'directory');
        assert.equal(drillKindOf(path.join(project.root, 'src', 'a.ts')), 'file');
        assert.equal(drillKindOf(path.join(project.root, 'nope')), null);
        const asked = [];
        registry.getServersByStatus = () => [
            { id: 's1', serverInstance: { drillDownInScene: (p, kind) => { asked.push(['s1', kind]); return true; } } },
            { id: 's2', serverInstance: { drillDownInScene: () => false } },
            { id: 's3', serverInstance: {} },
        ];
        assert.equal(drillDownInScenes(path.join(project.root, 'src', 'a.ts')), 1);
        assert.deepEqual(asked, [['s1', 'file']]);
        assert.equal(drillDownInScenes(path.join(project.root, 'src'), ['s2']), 0);
        assert.equal(drillDownInScenes(path.join(project.root, 'missing')), 0);
    } finally {
        registry.getServersByStatus = original;
        project.cleanup();
    }
});

test('the wiring makes home current only when the room really leaves the drilled view', async () => {
    const { wireDrillDown, releaseDrillDown } = out('server', 'analysis', 'drillDownHostWiring.js');
    const { analysisRefreshCoordinator } = out('analysis', 'refresh', 'analysisRefreshCoordinator.js');
    const project = makeProject();
    const sessionId = `drill-wiring-${Date.now()}`;
    const disposables = [];
    const published = [];
    try {
        const slot = wireDrillDown({
            enabled: true,
            session: { targetType: 'directory', targetPath: project.root, isDeep: true, savedFilesPath: project.root, filesToHash: [] },
            sessionId,
            staticRoot: path.join(project.root, '.static'),
            context: {},
            publish: (entity) => published.push(entity),
            // What the host does: the table switch goes through the coordinator.
            activate: (mode) => { analysisRefreshCoordinator.changeActiveMode(sessionId, mode); },
            disposables,
            analyzer: fakeAnalyzer(),
            readSessionSeed: () => null,
            resolveChart: async () => ({ chartId: 'boats', mapping: {} }),
            workspaceFolders: [project.root],
        });
        analysisRefreshCoordinator.changeActiveMode(sessionId, 'single');
        await slot.service.open('src', 'directory');
        await slot.service.open('src/a.ts', 'file');
        await slot.service.back();
        assert.equal(slot.service.current.relativePath, 'src', 'a snapshot published by a jump is not a move home');

        analysisRefreshCoordinator.changeActiveMode(sessionId, 'single');
        assert.equal(published.at(-1).atHome, true, 'the Analyses menu took the room home');
        assert.equal(published.at(-1).canBack, true);
        await slot.service.back();
        assert.equal(slot.service.current.relativePath, 'src');
        releaseDrillDown(slot);
    } finally {
        disposables.forEach((dispose) => dispose());
        analysisRefreshCoordinator.disposeSession(sessionId);
        project.cleanup();
    }
});

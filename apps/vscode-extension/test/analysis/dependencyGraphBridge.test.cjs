/**
 * Behavioural characterization of the dependency-graph room bridge
 * (src/core/server/analysis/dependencyGraphBridge.ts), written before
 * ROADMAP T29 (hoisted vocabularies and sanitizeDependencyScope) and T30 (the
 * start-message defaults table) reshaped it. Until this suite the two
 * handlers were pinned only by regexes over their own text.
 *
 * It runs the compiled bridge from out/ under the fake vscode, with a
 * recording host, room and message context, and the refresh coordinator's
 * two entry points replaced by recorders.
 *
 * What it pins:
 *   - settings: every accepted and every rejected value of the six
 *     vocabularies, the String() coercion they apply, the relation-filter
 *     and mapping filters, and a table of hostile scopes (absolute paths,
 *     `..` segments, backslashes, the 1024-character limit, wrong kinds);
 *   - start: the three refusals, the exact entity written for an empty room
 *     (the defaults table, compared with deepEqual), the per-field fallbacks
 *     from an existing entity, and when a refresh is requested.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

const BRIDGE_MODULE = 'core/server/analysis/dependencyGraphBridge.js';

function createMessageContext() {
    const context = {
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
    };
    return context;
}

function createService(overrides = {}) {
    return {
        availability: { enabled: true, reason: null },
        busy: false,
        initialScope: { kind: 'directory', relativePath: '' },
        getAvailability() {
            return this.availability;
        },
        isBusy() {
            return this.busy;
        },
        getInitialScope() {
            return this.initialScope;
        },
        ...overrides,
    };
}

function createHost(service) {
    const host = {
        sessionId: 'sess-1',
        analysisMode: 'XR',
        dependencyGraphService: service,
        calls: [],
        setDependencyRefreshHandler(handler) {
            host.refreshHandler = handler;
        },
        async activateAnalysisViewMode(mode, controllerView) {
            host.calls.push(['activate', mode, controllerView]);
        },
        notifyLivePanelDependencyUpdated(revision) {
            host.calls.push(['live', revision]);
        },
    };
    return host;
}

function createRoomHooks(existingEntity) {
    return {
        getRoom() {
            return {
                getServerEntity(roomId, kind, id) {
                    assert.deepEqual([roomId, kind, id], ['room-1', 'dependency-graph', 'main']);
                    return existingEntity;
                },
            };
        },
        getRoomId() {
            return 'room-1';
        },
    };
}

async function withBridge(body) {
    const fake = createFakeVscode();
    await withFakeVscode(fake, async ({ requireOut }) => {
        const coordinatorModule = requireOut('core/analysis/refresh/analysisRefreshCoordinator.js');
        const coordinatorCalls = [];
        const coordinator = coordinatorModule.analysisRefreshCoordinator;
        coordinator.setSnapshotAvailable = (...args) => coordinatorCalls.push(['setSnapshotAvailable', ...args]);
        coordinator.requestRefresh = (...args) => coordinatorCalls.push(['requestRefresh', ...args]);
        const { DependencyGraphBridge } = requireOut(BRIDGE_MODULE);
        await body({ DependencyGraphBridge, coordinatorCalls });
    });
}

// ------------------------------------------------------------------ settings

function settingsEntity(DependencyGraphBridge, payload, existingEntity) {
    const bridge = new DependencyGraphBridge(createHost(createService()), createRoomHooks(existingEntity));
    const messageContext = createMessageContext();
    assert.equal(bridge.handleDependencyGraphSettingsMessage(messageContext, { type: 'dependency-graph-settings', payload }), true);
    assert.equal(messageContext.log.length, 1);
    assert.equal(messageContext.log[0][0], 'upsert');
    return messageContext.log[0][1];
}

test('settings: an absent or empty payload writes only the entity key', async () => {
    await withBridge(async ({ DependencyGraphBridge }) => {
        const key = { entityKind: 'dependency-graph', entityId: 'main' };
        assert.deepEqual(settingsEntity(DependencyGraphBridge, undefined), key);
        assert.deepEqual(settingsEntity(DependencyGraphBridge, {}), key);
        assert.deepEqual(settingsEntity(DependencyGraphBridge, { relationFilters: {}, mapping: {} }), key);
    });
});

test('settings: every vocabulary value is accepted, in a stable key order', async () => {
    await withBridge(async ({ DependencyGraphBridge }) => {
        const vocabularies = {
            layout: ['force-3d', 'hierarchical', 'metric-space'],
            edgeEncoding: ['relation-type', 'intensity-color', 'intensity-width', 'intensity-combined'],
            flowSize: ['s', 'm', 'l', 'xl'],
            flowSpeed: ['x05', 'x1', 'x2', 'x3'],
        };
        for (const [field, values] of Object.entries(vocabularies)) {
            for (const value of values) {
                assert.deepEqual(
                    settingsEntity(DependencyGraphBridge, { [field]: value }),
                    { entityKind: 'dependency-graph', entityId: 'main', [field]: value },
                    `${field}=${value}`,
                );
            }
        }
        const everything = settingsEntity(DependencyGraphBridge, {
            scope: { kind: 'file', relativePath: 'src/a.ts' },
            mapping: { size: 'cycleSize' },
            relationFilters: { call: true },
            flowSpeed: 'x3',
            flowSize: 'xl',
            edgeEncoding: 'intensity-width',
            showExternal: false,
            layout: 'metric-space',
        }, { fileDatasetUrl: '/dependencies/dependency-scope-3.json', fileDatasetPath: 'src/a.ts' });
        assert.deepEqual(Object.keys(everything), [
            'entityKind', 'entityId', 'layout', 'showExternal', 'edgeEncoding', 'flowSize', 'flowSpeed',
            'relationFilters', 'mapping', 'scope', 'datasetUrl',
        ]);
        assert.deepEqual(everything.scope, { kind: 'file', relativePath: 'src/a.ts' });
        assert.equal(everything.datasetUrl, '/dependencies/dependency-scope-3.json');
    });
});

test('settings: values outside the vocabularies are dropped; membership is tested on String(value)', async () => {
    await withBridge(async ({ DependencyGraphBridge }) => {
        const key = { entityKind: 'dependency-graph', entityId: 'main' };
        for (const payload of [
            { layout: 'circle' },
            { layout: 'FORCE-3D' },
            { edgeEncoding: 'intensity' },
            { flowSize: 'xxl' },
            { flowSpeed: 'x4' },
            { flowSpeed: 1 },
            { showExternal: 'true' },
            { showExternal: 1 },
        ]) {
            assert.deepEqual(settingsEntity(DependencyGraphBridge, payload), key, JSON.stringify(payload));
        }
        // String() coercion: a one-element array passes the check and is stored as-is.
        assert.deepEqual(settingsEntity(DependencyGraphBridge, { layout: ['hierarchical'] }), { ...key, layout: ['hierarchical'] });
        assert.deepEqual(settingsEntity(DependencyGraphBridge, { showExternal: true }), { ...key, showExternal: true });
    });
});

test('settings: relation filters keep known booleans only; mapping keeps known metric values under any key', async () => {
    await withBridge(async ({ DependencyGraphBridge }) => {
        const entity = settingsEntity(DependencyGraphBridge, {
            relationFilters: {
                import: true,
                include: false,
                require: 'yes',
                inheritance: 1,
                implementation: true,
                call: false,
                contains: true,
                unknown: true,
            },
            mapping: {
                size: 'degree',
                height: 'fanIn',
                color: 'language',
                x: 'fanOut',
                z: 'nope',
                extra: 'totalLines',
                list: ['relationCount'],
                cycles: 'cycleSize',
            },
        });
        assert.deepEqual(entity.relationFilters, {
            import: true,
            include: false,
            implementation: true,
            call: false,
            contains: true,
        });
        assert.deepEqual(entity.mapping, {
            size: 'degree',
            height: 'fanIn',
            color: 'language',
            x: 'fanOut',
            extra: 'totalLines',
            list: ['relationCount'],
            cycles: 'cycleSize',
        });
        // Only rejected entries: both objects are omitted entirely.
        const rejected = settingsEntity(DependencyGraphBridge, {
            relationFilters: { unknown: true, import: 'true' },
            mapping: { size: 'loc' },
        });
        assert.equal('relationFilters' in rejected, false);
        assert.equal('mapping' in rejected, false);
    });
});

test('settings: hostile scopes are refused, safe ones are normalized to forward slashes', async () => {
    await withBridge(async ({ DependencyGraphBridge }) => {
        // The room holds a dataset for every safe path, so only the sanitizer decides here.
        const scopeOf = (scope) => settingsEntity(DependencyGraphBridge, { scope }, {
            fileDatasetUrl: '/f.json',
            fileDatasetPath: String(scope?.relativePath ?? '').replace(/\\/g, '/'),
        }).scope;
        const table = [
            // [scope, expected]
            [{ kind: 'directory', relativePath: '' }, { kind: 'directory', relativePath: '' }],
            [{ kind: 'file', relativePath: 'src/app.ts' }, { kind: 'file', relativePath: 'src/app.ts' }],
            [{ kind: 'file', relativePath: 'src\\nested\\app.ts' }, { kind: 'file', relativePath: 'src/nested/app.ts' }],
            [{ kind: 'directory', relativePath: '..hidden/dir' }, { kind: 'directory', relativePath: '..hidden/dir' }],
            [{ kind: 'directory', relativePath: 'a/b..' }, { kind: 'directory', relativePath: 'a/b..' }],
            [{ kind: 'directory', relativePath: 'C:\\outside' }, { kind: 'directory', relativePath: 'C:/outside' }],
            [{ kind: 'file', relativePath: 'x'.repeat(1024) }, { kind: 'file', relativePath: 'x'.repeat(1024) }],
            [{ kind: 'file', relativePath: 'src/a.ts', extra: 'dropped' }, { kind: 'file', relativePath: 'src/a.ts' }],
            [{ kind: 'file', relativePath: 'x'.repeat(1025) }, undefined],
            [{ kind: 'file', relativePath: '/etc/passwd' }, undefined],
            [{ kind: 'file', relativePath: '\\etc\\passwd' }, undefined],
            [{ kind: 'file', relativePath: '../outside.ts' }, undefined],
            [{ kind: 'file', relativePath: 'src/../../outside.ts' }, undefined],
            [{ kind: 'file', relativePath: 'src\\..\\outside.ts' }, undefined],
            [{ kind: 'directory', relativePath: '..' }, undefined],
            [{ kind: 'symbol', relativePath: 'src/a.ts' }, undefined],
            [{ kind: 'file' }, undefined],
            [{ kind: 'file', relativePath: 42 }, undefined],
            [{ relativePath: 'src/a.ts' }, undefined],
            ['src/a.ts', undefined],
            [null, undefined],
        ];
        for (const [scope, expected] of table) {
            assert.deepEqual(scopeOf(scope), expected, JSON.stringify(scope)?.slice(0, 80));
        }
    });
});

test('settings (S13 DEPGRAPH-4): a scope enters the room only with the dataset that draws it', async () => {
    await withBridge(async ({ DependencyGraphBridge }) => {
        const room = {
            projectDatasetUrl: '/dependencies/dependency-graph-4.json',
            fileDatasetUrl: '/dependencies/dependency-scope-5.json',
            fileDatasetPath: 'core/a.ts',
        };
        const up = settingsEntity(DependencyGraphBridge, { scope: { kind: 'directory', relativePath: 'core' } }, room);
        assert.deepEqual(up.scope, { kind: 'directory', relativePath: 'core' });
        assert.equal(up.datasetUrl, room.projectDatasetUrl);
        const sameFile = settingsEntity(DependencyGraphBridge, { scope: { kind: 'file', relativePath: 'core/a.ts' } }, room);
        assert.equal(sameFile.datasetUrl, room.fileDatasetUrl);
        const otherFile = settingsEntity(DependencyGraphBridge, { scope: { kind: 'file', relativePath: 'core/b.ts' } }, room);
        assert.equal(otherFile.scope, undefined, 'no dataset for that file: the client asks for it instead');
        assert.equal(otherFile.datasetUrl, undefined);
    });
});

// ------------------------------------------------------------------ start

const DEFAULT_START_ENTITY = {
    entityKind: 'dependency-graph',
    entityId: 'main',
    mode: 'dependency-graph',
    status: 'analyzing',
    message: 'Scanning project dependencies...',
    layout: 'force-3d',
    showExternal: false,
    edgeEncoding: 'relation-type',
    flowSize: 'm',
    flowSpeed: 'x1',
    relationFilters: {
        import: true,
        include: true,
        require: true,
        inheritance: true,
        implementation: true,
        call: false,
        contains: true,
    },
    mapping: {
        size: 'degree',
        height: 'fanIn',
        color: 'language',
        x: 'fanOut',
        z: 'fanIn',
    },
    scope: { kind: 'directory', relativePath: '' },
};

async function runStart(DependencyGraphBridge, { service, existing, payload }) {
    const host = createHost(service);
    const bridge = new DependencyGraphBridge(host, createRoomHooks(existing));
    const messageContext = createMessageContext();
    const handled = await bridge.handleDependencyGraphStartMessage(messageContext, { type: 'dependency-graph-start', payload });
    return { handled, host, log: messageContext.log };
}

test('start: no service, an unavailable service and a busy service each answer with an error and stop', async () => {
    await withBridge(async ({ DependencyGraphBridge, coordinatorCalls }) => {
        const noService = await runStart(DependencyGraphBridge, { service: null });
        assert.equal(noService.handled, true);
        assert.deepEqual(noService.log, [['send', {
            type: 'dependency-graph-error',
            payload: { message: 'Dependency analysis is not attached to this analysis server.' },
        }]]);

        const unavailable = await runStart(DependencyGraphBridge, {
            service: createService({ availability: { enabled: false, reason: 'Not a directory analysis.' } }),
        });
        assert.deepEqual(unavailable.log, [['send', {
            type: 'dependency-graph-error',
            payload: { message: 'Not a directory analysis.' },
        }]]);

        const busy = await runStart(DependencyGraphBridge, { service: createService({ busy: true }) });
        assert.deepEqual(busy.log, [['send', {
            type: 'dependency-graph-error',
            payload: { message: 'A dependency analysis is already running.' },
        }]]);
        assert.deepEqual(coordinatorCalls, []);
        assert.deepEqual([...noService.host.calls, ...unavailable.host.calls, ...busy.host.calls], []);
    });
});

test('start: an empty room gets the full defaults table, a view switch and a refresh request', async () => {
    await withBridge(async ({ DependencyGraphBridge, coordinatorCalls }) => {
        const service = createService();
        const { handled, host, log } = await runStart(DependencyGraphBridge, { service, existing: undefined });
        assert.equal(handled, true);
        assert.deepEqual(log, [['upsert', DEFAULT_START_ENTITY]]);
        assert.deepEqual(Object.keys(log[0][1]), Object.keys(DEFAULT_START_ENTITY));
        // The scope is a copy of the initial scope, never the service's own object.
        assert.notEqual(log[0][1].scope, service.initialScope);
        assert.deepEqual(host.calls, [['activate', 'dependency-graph', 'dependency.settings']]);
        assert.deepEqual(coordinatorCalls, [
            ['setSnapshotAvailable', 'sess-1', 'dependency-graph', false],
            ['requestRefresh', 'sess-1', 'dependency-graph'],
        ]);
    });
});

test('start: two empty-room starts never share the default objects', async () => {
    await withBridge(async ({ DependencyGraphBridge }) => {
        const first = await runStart(DependencyGraphBridge, { service: createService() });
        first.log[0][1].relationFilters.call = true;
        first.log[0][1].mapping.size = 'fanOut';
        const second = await runStart(DependencyGraphBridge, { service: createService() });
        assert.deepEqual(second.log[0][1], DEFAULT_START_ENTITY);
    });
});

test('start: an existing entity keeps its own values, falsy ones fall back field by field', async () => {
    await withBridge(async ({ DependencyGraphBridge, coordinatorCalls }) => {
        const existing = {
            datasetUrl: '/dependencies/dependency-graph-3.json',
            layout: 'hierarchical',
            showExternal: true,
            edgeEncoding: 'intensity-color',
            flowSize: 'xl',
            flowSpeed: 'x3',
            relationFilters: { call: true },
            mapping: { size: 'fanOut' },
            scope: { kind: 'file', relativePath: 'src/a.ts' },
        };
        const restored = await runStart(DependencyGraphBridge, { service: createService(), existing });
        assert.deepEqual(restored.log, [['upsert', {
            entityKind: 'dependency-graph',
            entityId: 'main',
            mode: 'dependency-graph',
            status: 'ready',
            message: 'Restoring dependency graph...',
            layout: 'hierarchical',
            showExternal: true,
            edgeEncoding: 'intensity-color',
            flowSize: 'xl',
            flowSpeed: 'x3',
            relationFilters: { call: true },
            mapping: { size: 'fanOut' },
            scope: { kind: 'file', relativePath: 'src/a.ts' },
        }]]);
        // The existing objects are passed through by reference.
        assert.equal(restored.log[0][1].mapping, existing.mapping);
        assert.equal(restored.log[0][1].scope, existing.scope);
        assert.deepEqual(coordinatorCalls, [['setSnapshotAvailable', 'sess-1', 'dependency-graph', true]]);

        coordinatorCalls.length = 0;
        const falsy = await runStart(DependencyGraphBridge, {
            service: createService(),
            existing: {
                datasetUrl: '',
                layout: '',
                showExternal: 'yes',
                edgeEncoding: null,
                flowSize: 0,
                flowSpeed: undefined,
                relationFilters: null,
                mapping: '',
                scope: null,
            },
        });
        assert.deepEqual(falsy.log, [['upsert', DEFAULT_START_ENTITY]]);
        assert.deepEqual(coordinatorCalls, [
            ['setSnapshotAvailable', 'sess-1', 'dependency-graph', false],
            ['requestRefresh', 'sess-1', 'dependency-graph'],
        ]);
        // showExternal keeps an existing false (it is a typeof test, not a ||).
        const keepsFalse = await runStart(DependencyGraphBridge, { service: createService(), existing: { showExternal: false } });
        assert.equal(keepsFalse.log[0][1].showExternal, false);
    });
});

test('start: forceFull re-analyzes over a cached dataset', async () => {
    await withBridge(async ({ DependencyGraphBridge, coordinatorCalls }) => {
        const { log } = await runStart(DependencyGraphBridge, {
            service: createService(),
            existing: { datasetUrl: '/dependencies/dependency-graph-1.json' },
            payload: { forceFull: true },
        });
        assert.equal(log[0][1].status, 'analyzing');
        assert.equal(log[0][1].message, 'Scanning project dependencies...');
        assert.deepEqual(coordinatorCalls, [
            ['setSnapshotAvailable', 'sess-1', 'dependency-graph', true],
            ['requestRefresh', 'sess-1', 'dependency-graph'],
        ]);
        coordinatorCalls.length = 0;
        // Only a literal true forces it.
        await runStart(DependencyGraphBridge, {
            service: createService(),
            existing: { datasetUrl: '/dependencies/dependency-graph-1.json' },
            payload: { forceFull: 'true' },
        });
        assert.deepEqual(coordinatorCalls, [['setSnapshotAvailable', 'sess-1', 'dependency-graph', true]]);
    });
});

/**
 * Characterization of AnalysisMessageRouter's analysis-mode-activate
 * handler (W5-09 precondition): for every mode and snapshot state, which
 * snapshot is probed, what the refresh coordinator is told, and which
 * controller view the host enters (or the fallback to the selection menu).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

async function withRouter(snapshots, body) {
    await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
        const { analysisRefreshCoordinator } = requireOut('code_analysis/refresh/analysisRefreshCoordinator.js');
        const calls = [];
        analysisRefreshCoordinator.setSnapshotAvailable = (...args) => calls.push(['setSnapshotAvailable', ...args]);
        const { AnalysisMessageRouter } = requireOut('core/server/analysis/analysisMessageRouter.js');
        const host = {
            sessionId: 'session-1',
            historicalComparisonService: undefined,
            projectEvolutionService: undefined,
            changeAnalysisViewMode: (...args) => calls.push(['change', ...args]),
            activateAnalysisViewMode: async (...args) => {
                calls.push(['activate', ...args]);
            },
        };
        const probes = [];
        const room = {
            getRoomId: () => 'room-1',
            getRoom: () => ({
                getServerEntity: (roomId, entityKind, entityId) => {
                    probes.push([roomId, entityKind, entityId]);
                    return snapshots[entityKind];
                },
            }),
        };
        const router = new AnalysisMessageRouter(host, {}, {}, {}, room);
        const activate = (mode) => router.handleCollaborationMessage(
            { roomId: 'room-1' },
            { type: 'analysis-mode-activate', payload: { mode } },
        );
        await body({ activate, calls, probes });
    });
}

test('router: single enters single.mapping without probing any snapshot', async () => {
    await withRouter({}, async ({ activate, calls, probes }) => {
        assert.equal(await activate('single'), true);
        assert.deepEqual(probes, []);
        assert.deepEqual(calls, [['activate', 'single', 'single.mapping']]);
    });
});

test('router: unknown or missing modes are consumed and do nothing', async () => {
    await withRouter({}, async ({ activate, calls, probes }) => {
        for (const mode of ['selection', 'constructor', '', undefined]) {
            assert.equal(await activate(mode), true);
        }
        assert.deepEqual(probes, []);
        assert.deepEqual(calls, []);
    });
});

test('router: an empty room keeps the historical and evolution shells, and sends the dependency graph back to the menu', async () => {
    await withRouter({}, async ({ activate, calls, probes }) => {
        await activate('historical-compare');
        await activate('project-evolution');
        await activate('dependency-graph');
        assert.deepEqual(probes, [
            ['room-1', 'historical-comparison', 'main'],
            ['room-1', 'project-evolution', 'main'],
            ['room-1', 'dependency-graph', 'main'],
        ]);
        assert.deepEqual(calls, [
            ['setSnapshotAvailable', 'session-1', 'historical-compare', false],
            ['activate', 'historical-compare', 'historical.selection'],
            ['setSnapshotAvailable', 'session-1', 'project-evolution', false],
            ['activate', 'project-evolution', 'project-evolution'],
            ['setSnapshotAvailable', 'session-1', 'dependency-graph', false],
            ['change', 'selection', 'visualization-menu'],
        ]);
    });
});

test('router: a cached snapshot is available by result (git modes) or a datasetUrl string (dependency graph)', async () => {
    await withRouter({
        'historical-comparison': { result: {} },
        'project-evolution': { result: {} },
        'dependency-graph': { datasetUrl: '/deps/graph.json' },
    }, async ({ activate, calls }) => {
        await activate('historical-compare');
        await activate('project-evolution');
        await activate('dependency-graph');
        assert.deepEqual(calls, [
            ['setSnapshotAvailable', 'session-1', 'historical-compare', true],
            ['activate', 'historical-compare', 'historical.mapping'],
            ['setSnapshotAvailable', 'session-1', 'project-evolution', true],
            ['activate', 'project-evolution', 'project-evolution'],
            ['setSnapshotAvailable', 'session-1', 'dependency-graph', true],
            ['activate', 'dependency-graph', 'dependency.settings'],
        ]);
    });
});

test('router: the wrong snapshot field does not count as available', async () => {
    await withRouter({
        'historical-comparison': { datasetUrl: '/x.json' },
        'project-evolution': { result: null },
        'dependency-graph': { result: {}, datasetUrl: 42 },
    }, async ({ activate, calls }) => {
        await activate('historical-compare');
        await activate('project-evolution');
        await activate('dependency-graph');
        assert.deepEqual(calls.filter(([kind]) => kind === 'setSnapshotAvailable').map((call) => call[3]), [false, false, false]);
        assert.deepEqual(calls.filter(([kind]) => kind !== 'setSnapshotAvailable'), [
            ['activate', 'historical-compare', 'historical.selection'],
            ['activate', 'project-evolution', 'project-evolution'],
            ['change', 'selection', 'visualization-menu'],
        ]);
    });
});

test('router: no room means no snapshot, so the dependency graph falls back to the menu', async () => {
    await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
        const { analysisRefreshCoordinator } = requireOut('code_analysis/refresh/analysisRefreshCoordinator.js');
        const calls = [];
        analysisRefreshCoordinator.setSnapshotAvailable = (...args) => calls.push(['setSnapshotAvailable', ...args]);
        const { AnalysisMessageRouter } = requireOut('core/server/analysis/analysisMessageRouter.js');
        const host = {
            sessionId: 's',
            changeAnalysisViewMode: (...args) => calls.push(['change', ...args]),
            activateAnalysisViewMode: async (...args) => calls.push(['activate', ...args]),
        };
        const router = new AnalysisMessageRouter(host, {}, {}, {}, { getRoom: () => null, getRoomId: () => 'r' });
        await router.handleCollaborationMessage({}, { type: 'analysis-mode-activate', payload: { mode: 'dependency-graph' } });
        assert.deepEqual(calls, [['setSnapshotAvailable', 's', 'dependency-graph', false], ['change', 'selection', 'visualization-menu']]);
    });
});

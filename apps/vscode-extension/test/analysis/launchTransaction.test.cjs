'use strict';

/**
 * The unified launcher (S5, issue #77), executed from out/ under the fake
 * vscode:
 *
 * - `targetKey`: one identity per target whatever spelled its path
 *   (LAUNCHER-17), for every platform from any platform;
 * - the session registry reserves a target before its first await, so two
 *   concurrent launches of one file yield one session (LAUNCHER-2);
 * - `LaunchControl`: teardown newest first, exactly once; a step that lands
 *   after the launch is gone is undone at once; the deadline aborts;
 * - `executeLaunchPipeline` as a transaction: a server failure starts no
 *   watcher and shows one error; a Close while analysing starts nothing and
 *   shows nothing; a watcher failure stops the server it started; a timeout
 *   rolls back and reports it (LAUNCHER-5/7/10);
 * - `resolveLauncher` and the storage folders cleanup sweeps (LAUNCHER-14).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFakeVscode, withFakeVscode, fakeExtensionContext } = require('../helpers/fakeVscode.cjs');

function silenceConsole() {
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const original = methods.map((method) => console[method]);
    methods.forEach((method) => {
        console[method] = () => {};
    });
    return () => methods.forEach((method, index) => {
        console[method] = original[index];
    });
}

async function withOut(body) {
    const fake = createFakeVscode();
    const context = fakeExtensionContext();
    const restoreConsole = silenceConsole();
    try {
        await withFakeVscode(fake, async ({ requireOut }) => body({ requireOut, fake, context }));
    } finally {
        restoreConsole();
        context.cleanup();
    }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── targetKey ────────────────────────────────────────────────────────

test('targetKey folds case on Windows and macOS, keeps it on Linux, and drops trailing separators', async () => {
    await withOut(async ({ requireOut }) => {
        const { targetKey, launchKey } = requireOut('core/analysis/launch/targetKey.js');

        assert.equal(targetKey('C:\\Proj\\A.ts', 'win32'), targetKey('c:\\proj\\a.ts', 'win32'));
        assert.equal(targetKey('C:\\Proj\\src\\', 'win32'), 'c:\\proj\\src');
        assert.equal(targetKey('C:/Proj/src/', 'win32'), 'c:\\proj\\src');
        assert.equal(targetKey('C:\\', 'win32'), 'c:\\', 'a drive root keeps its separator');

        assert.equal(targetKey('/Users/Ana/Proj/A.ts', 'darwin'), '/users/ana/proj/a.ts');
        assert.equal(targetKey('/Users/Ana/Proj/', 'darwin'), '/users/ana/proj');

        assert.equal(targetKey('/home/ana/Proj/A.ts', 'linux'), '/home/ana/Proj/A.ts');
        assert.notEqual(targetKey('/home/ana/A.ts', 'linux'), targetKey('/home/ana/a.ts', 'linux'));
        assert.equal(targetKey('/home/ana/proj///', 'linux'), '/home/ana/proj');
        assert.equal(targetKey('/home/ana/./proj/../proj', 'linux'), '/home/ana/proj');
        assert.equal(targetKey('/', 'linux'), '/');

        assert.equal(
            launchKey('XR', 'C:\\Proj\\A.ts', 'file', false, 'win32'),
            launchKey('XR', 'c:\\proj\\a.ts', 'file', false, 'win32'),
        );
        assert.notEqual(
            launchKey('XR', '/p/a.ts', 'file', false, 'linux'),
            launchKey('XR', '/p/a.ts', 'file', true, 'linux'),
        );
    });
});

// ── Session registry: reservation before the first await ────────────

test('two concurrent launches of one target create one session; the second is a duplicate', async () => {
    await withOut(async ({ requireOut, context }) => {
        const workRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-launch-tx-')));
        try {
            const target = path.join(workRoot, 'a.ts');
            fs.writeFileSync(target, 'export const a = 1;\n');
            const { UnifiedSessionRegistry } = requireOut('core/analysis/session/sessionRegistry.js');
            const registry = UnifiedSessionRegistry.getInstance(context);

            const request = { targetPath: target, analysisMode: 'XR', targetType: 'file', context };
            const [first, second] = await Promise.all([
                registry.createSession(request),
                registry.createSession({ ...request, targetPath: `${target}${path.sep}` }),
            ]);
            assert.deepEqual([first.kind, second.kind], ['created', 'duplicate']);
            assert.equal(second.existing.id, first.session.id);
            assert.equal(registry.getSessionsByTargetPath(target).length, 1);
        } finally {
            fs.rmSync(workRoot, { recursive: true, force: true });
        }
    });
});

// ── LaunchControl ────────────────────────────────────────────────────

test('LaunchControl undoes steps newest first, exactly once', async () => {
    await withOut(async ({ requireOut }) => {
        const { LaunchControl } = requireOut('core/analysis/launch/launchControl.js');
        const control = LaunchControl.createForTesting();
        const undone = [];
        const signal = control.begin('s1', 0);
        control.push('s1', 'server', () => undone.push('server'));
        control.push('s1', 'watcher', () => undone.push('watcher'));

        assert.deepEqual(await control.abort('s1', 'failed'), ['watcher', 'server']);
        assert.equal(signal.aborted, true);
        assert.equal(signal.reason, 'failed');
        assert.deepEqual(await control.abort('s1', 'failed'), [], 'a second abort undoes nothing');
        assert.deepEqual(await control.close('s1'), []);
        assert.deepEqual(undone, ['watcher', 'server']);
        assert.equal(control.has('s1'), false);
    });
});

test('a step pushed after the launch is gone is undone at once; a failing teardown does not stop the rest', async () => {
    await withOut(async ({ requireOut }) => {
        const { LaunchControl } = requireOut('core/analysis/launch/launchControl.js');
        const control = LaunchControl.createForTesting();
        const undone = [];
        control.begin('s1', 0);
        control.push('s1', 'first', () => undone.push('first'));
        control.push('s1', 'broken', () => {
            throw new Error('teardown failed');
        });
        assert.deepEqual(await control.close('s1'), ['first']);

        control.push('s1', 'late-server', () => undone.push('late-server'));
        await tick();
        assert.deepEqual(undone, ['first', 'late-server']);
    });
});

test('the deadline aborts the launch with reason "timeout"; settle() cancels it', async () => {
    await withOut(async ({ requireOut }) => {
        const { LaunchControl, LaunchAbortedError } = requireOut('core/analysis/launch/launchControl.js');
        const control = LaunchControl.createForTesting();
        const undone = [];

        const timed = control.begin('slow', 20);
        control.push('slow', 'server', () => undone.push('server'));
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(timed.aborted, true);
        assert.equal(timed.reason, 'timeout');
        assert.deepEqual(undone, ['server']);

        const settled = control.begin('fast', 20);
        control.settle('fast');
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(settled.aborted, false);
        assert.equal(control.has('fast'), true);

        // Between steps, an aborted launch throws a LaunchAbortedError carrying its reason.
        control.begin('stopped', 0);
        const record = control.signal('stopped');
        const controller = { signal: record };
        assert.equal(controller.signal.aborted, false);
        control.throwIfAborted('stopped');
        await control.close('fast');
        await control.close('stopped');
        assert.equal(record.aborted, true);
        assert.equal(new LaunchAbortedError('timeout').message, 'The analysis took too long and was stopped.');
    });
});

test('beginning a session twice supersedes the first launch', async () => {
    await withOut(async ({ requireOut }) => {
        const { LaunchControl } = requireOut('core/analysis/launch/launchControl.js');
        const control = LaunchControl.createForTesting();
        const undone = [];
        const first = control.begin('s1', 0);
        control.push('s1', 'old-server', () => undone.push('old-server'));
        const second = control.begin('s1', 0);
        await tick();
        assert.equal(first.aborted, true);
        assert.equal(first.reason, 'superseded');
        assert.equal(second.aborted, false);
        assert.deepEqual(undone, ['old-server']);
        await control.close('s1');
    });
});

// ── executeLaunchPipeline as a transaction ──────────────────────────

async function withPipeline(body) {
    await withOut(async ({ requireOut, fake, context }) => {
        const events = [];
        const statuses = [];
        const behaviour = {
            server: async () => ({ success: true, sessionServerInfo: { serverId: 'srv-1', port: 3100, serverUrl: 'http://localhost:3100' } }),
        };

        const { UnifiedSessionRegistry } = requireOut('core/analysis/session/sessionRegistry.js');
        UnifiedSessionRegistry.getInstance = () => ({
            updateSessionStatus(id, status) {
                statuses.push(status);
                return true;
            },
            registerSessionPort() {
                return true;
            },
        });
        const { SaveFiles } = requireOut('core/analysis/utils/saveFiles.js');
        SaveFiles.prototype.saveFilesToStorage = async () => '/saved/path';
        const { ServerLaunchOrchestrator } = requireOut('core/analysis/session-servers/serverLaunchOrchestrator.js');
        ServerLaunchOrchestrator.prototype.launchServerForSession = async () => {
            events.push('server:start');
            return behaviour.server();
        };
        const liveServers = new Set();
        const registryModule = requireOut('core/server/registry/activeServerRegistry.js');
        registryModule.getActiveServerRegistry = () => ({ getServer: (id) => (liveServers.has(id) ? { id } : undefined) });
        const { ServerControl } = requireOut('core/server/serverControl.js');
        ServerControl.stopServer = async (id) => {
            events.push(`server:stop:${id}`);
            liveServers.delete(id);
            return true;
        };
        const { SessionWatcherManager } = requireOut('core/analysis/watchers/sessionWatcherManager.js');
        SessionWatcherManager.prototype.stopWatchingSession = async () => {
            events.push('watcher:stop');
        };
        const { LaunchControl } = requireOut('core/analysis/launch/launchControl.js');
        const { executeLaunchPipeline } = requireOut('core/analysis/launchers/launchPipeline.js');

        const control = LaunchControl.createForTesting();
        const session = {
            id: 'session-1',
            targetPath: '/tmp/a.ts',
            outputDirectory: 'a_XR_file_session-1',
            requiredFiles: new Map(),
        };
        const config = (overrides = {}) => ({
            logPrefix: 'TEST',
            folderName: 'fileAnalysis',
            progress: { process: 10, save: 20, watcherOrServer: 30, serverOrWatcher: 40, done: 100 },
            processRequirements: async () => {
                events.push('process');
                return { loadedFiles: new Map([['index.html', '<html></html>']]) };
            },
            startWatcher: async () => {
                events.push('watcher:start');
                return 'watcher-1';
            },
            ...overrides,
        });
        const errors = () => fake.messages.filter((m) => m.kind === 'error').map((m) => m.message);
        const markServerLive = () => liveServers.add('srv-1');
        await body({ executeLaunchPipeline, control, session, context, config, events, statuses, behaviour, errors, markServerLive });
    });
}

test('a successful launch starts the server before the watcher and ends monitoring', async () => {
    await withPipeline(async ({ executeLaunchPipeline, control, session, context, config, events, statuses, errors, markServerLive }) => {
        let served = null;
        await executeLaunchPipeline(session, context, config({
            startWatcher: async () => {
                markServerLive();
                events.push('watcher:start');
                return 'watcher-1';
            },
            onSuccess: (port, url) => {
                served = { port, url };
            },
        }), { control, timeoutMs: 0 });

        assert.deepEqual(events, ['process', 'server:start', 'watcher:start']);
        assert.equal(statuses.at(-1), 'monitoring');
        assert.deepEqual(served, { port: 3100, url: 'http://localhost:3100' });
        assert.deepEqual(errors(), []);

        // Closing the finished analysis undoes both steps, watcher first.
        assert.deepEqual(await control.close(session.id), ['watcher', 'server']);
        assert.deepEqual(events.slice(3), ['watcher:stop', 'server:stop:srv-1']);
    });
});

test('a server that cannot start leaves no watcher behind and shows exactly one error', async () => {
    await withPipeline(async ({ executeLaunchPipeline, control, session, context, config, events, statuses, behaviour, errors }) => {
        behaviour.server = async () => ({ success: false, error: 'No free port' });
        await executeLaunchPipeline(session, context, config(), { control, timeoutMs: 0 });

        assert.deepEqual(events, ['process', 'server:start']);
        assert.equal(statuses.at(-1), 'error');
        assert.deepEqual(errors(), ['Failed to start analysis: No free port']);
        assert.equal(control.has(session.id), false);
    });
});

test('a watcher failure stops the server the launch started', async () => {
    await withPipeline(async ({ executeLaunchPipeline, control, session, context, config, events, errors, markServerLive }) => {
        await assert.rejects(executeLaunchPipeline(session, context, config({
            rethrowErrors: true,
            startWatcher: async () => {
                markServerLive();
                throw new Error('watch failed');
            },
        }), { control, timeoutMs: 0 }), /watch failed/);

        assert.deepEqual(events, ['process', 'server:start', 'server:stop:srv-1']);
        assert.deepEqual(errors(), ['Failed to start analysis: watch failed']);
    });
});

test('closing while the analysis runs starts no server, no watcher and shows no error', async () => {
    await withPipeline(async ({ executeLaunchPipeline, control, session, context, config, events, errors }) => {
        let release;
        const launch = executeLaunchPipeline(session, context, config({
            processRequirements: () => new Promise((resolve) => {
                events.push('process');
                release = () => resolve({ loadedFiles: new Map() });
            }),
        }), { control, timeoutMs: 0 });
        await tick();
        await control.close(session.id);
        await launch;
        release();
        await tick();

        assert.deepEqual(events, ['process']);
        assert.deepEqual(errors(), []);
    });
});

test('a launch past its deadline is rolled back and reported as a timeout', async () => {
    await withPipeline(async ({ executeLaunchPipeline, control, session, context, config, events, statuses, errors }) => {
        await executeLaunchPipeline(session, context, config({
            processRequirements: () => new Promise(() => {
                events.push('process');
            }),
        }), { control, timeoutMs: 30 });

        assert.deepEqual(events, ['process']);
        assert.equal(statuses.at(-1), 'error');
        assert.deepEqual(errors(), ['Failed to start analysis: The analysis took too long and was stopped.']);
    });
});

test('the launch signal reaches code running below the pipeline', async () => {
    await withOut(async ({ requireOut }) => {
        const { runWithLaunchSignal, currentLaunchSignal } = requireOut('core/analysis/launch/launchControl.js');
        const controller = new AbortController();
        assert.equal(currentLaunchSignal(), undefined);
        const seen = await runWithLaunchSignal(controller.signal, async () => {
            await tick();
            return currentLaunchSignal();
        });
        assert.equal(seen, controller.signal);
    });
});

// ── Launch kinds, storage folders, analysis-type tables ─────────────

test('resolveLauncher dispatches every supported kind and refuses the rest by name', async () => {
    await withOut(async ({ requireOut }) => {
        const { resolveLauncher, LAUNCH_KINDS } = requireOut('core/analysis/launch/launchKinds.js');
        for (const kind of ['XR', 'LivePanel']) {
            assert.equal(typeof resolveLauncher(kind, 'file'), 'function');
            assert.equal(typeof resolveLauncher(kind, 'directory'), 'function');
        }
        assert.equal(typeof resolveLauncher('VisualizeDOM', 'file'), 'function');
        assert.throws(() => resolveLauncher('VisualizeDOM', 'directory'), /DOM visualization analysis only supports file targets, not directory/);
        assert.throws(() => resolveLauncher('Hologram', 'file'), /Unknown analysis mode: Hologram/);
        assert.throws(() => resolveLauncher('constructor', 'file'), /Unknown analysis mode/);
        assert.deepEqual(Object.keys(LAUNCH_KINDS), ['XR', 'LivePanel', 'VisualizeDOM']);
    });
});

test('cleanup sweeps every folder the launchers write, plus the legacy root', async () => {
    await withOut(async ({ requireOut }) => {
        const { ANALYSIS_STORAGE_FOLDERS, getSweptStorageFolders } = requireOut('core/analysis/launch/storageFolders.js');
        assert.deepEqual(getSweptStorageFolders(), ['fileAnalysis', 'directoryAnalysis', 'visualizeDOMAnalysis', 'analysis', 'historical-comparisons']);

        // Every folder name a launcher passes to the pipeline is swept.
        const launcherSources = ['launcherXRAnalysis.ts', 'launcherLivePanel.ts', 'launcherVisualizeDOM.ts']
            .map((name) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'analysis', 'launchers', name), 'utf8'))
            .join('\n');
        const used = [...launcherSources.matchAll(/ANALYSIS_STORAGE_FOLDERS\.(\w+)/g)].map((m) => ANALYSIS_STORAGE_FOLDERS[m[1]]);
        assert.ok(used.length >= 3);
        assert.equal(/folderName:\s*['"]/.test(launcherSources), false, 'no launcher spells a folder name by hand');
        for (const folder of used) {
            assert.ok(getSweptStorageFolders().includes(folder), folder);
        }
    });
});

test('the host tables derived from the analysis types are unchanged', async () => {
    await withOut(async ({ requireOut }) => {
        const { ANALYSIS_CONTROLLER_VIEW_BY_MODE, defaultControllerView } = requireOut('core/analysis/refresh/analysisViewModes.js');
        assert.deepEqual({ ...ANALYSIS_CONTROLLER_VIEW_BY_MODE }, {
            selection: 'visualization-menu',
            single: 'single.mapping',
            'dependency-graph': 'dependency.settings',
            'historical-compare': 'historical.selection',
            'project-evolution': 'project-evolution',
            'agent-flow': 'agent-flow',
        });
        assert.equal(defaultControllerView('constructor'), 'single.mapping');

        const { getServerFeaturesForSurface, ANALYSIS_TYPES } = requireOut('core/analysis/launch/analysisTypes.js');
        assert.deepEqual([...getServerFeaturesForSurface('XR')].sort(), ['agentFlow', 'dependencyGraph', 'historicalComparison', 'projectEvolution']);
        assert.deepEqual([...getServerFeaturesForSurface('LivePanel')].sort(), ['dependencyGraph', 'historicalComparison']);
        assert.deepEqual([...getServerFeaturesForSurface('VisualizeDOM')], []);
        assert.deepEqual([...getServerFeaturesForSurface(undefined)], []);

        const probes = Object.fromEntries(ANALYSIS_TYPES.filter((t) => t.snapshotProbe).map((t) => [t.id, t.snapshotProbe.entityKind]));
        assert.deepEqual(probes, {
            'dependency-graph': 'dependency-graph',
            'historical-compare': 'historical-comparison',
            'project-evolution': 'project-evolution',
            'agent-flow': 'agent-flow',
        });
        const flow = ANALYSIS_TYPES.find((t) => t.id === 'agent-flow').snapshotProbe;
        assert.equal(flow.isAvailable({ datasetUrl: '/agent-flow/agent-flow-1.json' }), true);
        assert.equal(flow.isAvailable({ datasetUrl: null }), false);
        const dep = ANALYSIS_TYPES.find((t) => t.id === 'dependency-graph').snapshotProbe;
        assert.equal(dep.isAvailable({ datasetUrl: '/d.json' }), true);
        assert.equal(dep.isAvailable({}), false);
        assert.equal(dep.isAvailable(null), false);
    });
});

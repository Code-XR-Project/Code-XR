/**
 * Behavioural characterization of the processRequirements / startWatcher
 * closures the LivePanel and XR launchers hand to executeLaunchPipeline,
 * written before ROADMAP T38 replaced the four duplicated pairs with
 * per-file helpers (the DOM launcher's swallowing startWatcher is not part
 * of it and is not exercised here).
 *
 * It runs the compiled launchers from out/ under the fake vscode with
 * executeLaunchPipeline replaced by a recorder, so each test can call the
 * closures directly. FileRequirementProcessor.processRequirements and
 * SessionWatcherManager.startWatchingSession are recorders too.
 *
 * What it pins: which arguments each closure passes (the LivePanel ones add
 * the configured view theme), that their results come back unchanged, that
 * a failure rejects (never swallowed, never a synchronous throw), and that
 * each call builds a fresh processor and watcher manager.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode, fakeExtensionContext } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

const LAUNCHERS = [
    { module: 'code_analysis/engine/launchers/launcherLivePanel.js', className: 'LauncherLivePanel', withTheme: true, methods: ['launchFileLivePanelAnalysis', 'launchDirectoryLivePanelAnalysis'] },
    { module: 'code_analysis/engine/launchers/launcherXRAnalysis.js', className: 'LauncherXRAnalysis', withTheme: false, methods: ['launchFileXRAnalysis', 'launchDirectoryXRAnalysis'] },
];

async function withLaunchers(body) {
    const fake = createFakeVscode();
    const context = fakeExtensionContext();
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            const calls = [];
            const pipeline = requireOut('code_analysis/engine/launchers/launchPipeline.js');
            const configs = [];
            pipeline.executeLaunchPipeline = async (session, launchContext, config) => {
                configs.push(config);
            };
            const { UnifiedSessionRegistry } = requireOut('code_analysis/engine/core/sessionRegistry.js');
            UnifiedSessionRegistry.getInstance = () => ({ updateSessionStatus() {} });
            const { AnalysisConfigurationStorage } = requireOut('code_analysis/configuration/analysisConfigurationStorage.js');
            AnalysisConfigurationStorage.getInstance = () => ({
                async getViewTheme() {
                    calls.push(['getViewTheme']);
                    return 'dark';
                },
            });
            const { FileRequirementProcessor } = requireOut('code_analysis/engine/processors/FileRequirementProcessor.js');
            const behaviour = { processResult: { processed: true }, watchResult: 'watcher-1', fail: null };
            let processorInstances = 0;
            FileRequirementProcessor.prototype.processRequirements = async function recordProcess(...args) {
                processorInstances += this.__seen ? 0 : 1;
                this.__seen = true;
                calls.push(['processRequirements', ...args]);
                if (behaviour.fail === 'process') {
                    throw new Error('process failed');
                }
                return behaviour.processResult;
            };
            const { SessionWatcherManager } = requireOut('code_analysis/engine/watchers/sessionWatcherManager.js');
            let watcherInstances = 0;
            SessionWatcherManager.prototype.startWatchingSession = async function recordWatch(...args) {
                watcherInstances += this.__seen ? 0 : 1;
                this.__seen = true;
                calls.push(['startWatchingSession', ...args]);
                if (behaviour.fail === 'watch') {
                    throw new Error('watch failed');
                }
                return behaviour.watchResult;
            };
            const loaded = LAUNCHERS.map((entry) => ({ ...entry, Launcher: requireOut(entry.module)[entry.className] }));
            await body({
                context,
                loaded,
                calls,
                configs,
                behaviour,
                instances: () => ({ processors: processorInstances, watchers: watcherInstances }),
            });
        });
    } finally {
        context.cleanup();
    }
}

function makeSession() {
    return { id: 'session-1', targetName: 'a.ts', targetPath: '/tmp/a.ts', hash256: 'f'.repeat(64), filesToHash: [] };
}

test('each launcher passes the session (and the LivePanel ones the view theme) and returns the results unchanged', async () => {
    await withLaunchers(async ({ context, loaded, calls, configs, behaviour, instances }) => {
        for (const { Launcher, methods, withTheme } of loaded) {
            for (const method of methods) {
                configs.length = 0;
                calls.length = 0;
                const session = makeSession();
                await Launcher[method](session, context);
                assert.equal(configs.length, 1, method);
                const config = configs[0];

                const processed = await config.processRequirements();
                assert.equal(processed, behaviour.processResult, method);
                const watched = await config.startWatcher('/saved/path');
                assert.equal(watched, behaviour.watchResult, method);

                const expectedProcess = withTheme ? ['processRequirements', session, 'dark'] : ['processRequirements', session];
                assert.deepEqual(calls, [
                    ...(withTheme ? [['getViewTheme']] : []),
                    expectedProcess,
                    ['startWatchingSession', session],
                ], method);
                assert.equal(calls[calls.length - 1][1], session, `${method}: the very session object`);
            }
        }
        // A fresh processor and watcher manager per call.
        assert.deepEqual(instances(), { processors: 4, watchers: 4 });
    });
});

test('failures reject the closure promise instead of being swallowed', async () => {
    await withLaunchers(async ({ context, loaded, configs, behaviour }) => {
        for (const { Launcher, methods } of loaded) {
            for (const method of methods) {
                configs.length = 0;
                await Launcher[method](makeSession(), context);
                const config = configs[0];

                behaviour.fail = 'process';
                const processing = config.processRequirements();
                assert.ok(processing instanceof Promise, `${method}: processRequirements returns a promise`);
                await assert.rejects(processing, /^Error: process failed$/);

                behaviour.fail = 'watch';
                const watching = config.startWatcher('/saved/path');
                assert.ok(watching instanceof Promise, `${method}: startWatcher returns a promise`);
                await assert.rejects(watching, /^Error: watch failed$/);
                behaviour.fail = null;
            }
        }
    });
});

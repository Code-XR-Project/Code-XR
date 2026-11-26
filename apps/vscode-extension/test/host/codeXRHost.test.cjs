'use strict';

// #13 step 1: the CodeXRHost seam and its VS Code adapter. The adapter must
// forward each member to the VS Code call the core makes directly today, so
// that moving a core module onto the host changes nothing a user can see.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createFakeVscode, fakeExtensionContext, withFakeVscode, ExtensionMode } = require('../helpers/fakeVscode.cjs');
const { measure } = require('../tooling/folderDependencies.cjs');

test('core/host never reaches vscode, directly or through an import', () => {
    const free = new Set(measure().vscodeFree);
    for (const file of ['core/host/codeXRHost.ts', 'core/host/hostRegistry.ts']) {
        assert.ok(free.has(file), `${file} reaches vscode`);
    }
});

test('the host registry stores one host, refuses early reads and resets for tests', () => {
    const registry = require(path.join(__dirname, '..', '..', 'out', 'core', 'host', 'hostRegistry.js'));
    registry.resetHostForTests();
    try {
        assert.equal(registry.hasHost(), false);
        assert.throws(() => registry.getHost(), /not initialized/);
        const first = { name: 'first' };
        registry.initializeHost(first);
        registry.initializeHost({ name: 'second' });
        assert.equal(registry.getHost(), first, 'a second initialize is ignored');
        assert.equal(registry.hasHost(), true);
    } finally {
        registry.resetHostForTests();
    }
});

function withHost(options, callback) {
    const fake = createFakeVscode(options.fake);
    const context = fakeExtensionContext(options.context);
    return withFakeVscode(fake, async ({ requireOut }) => {
        try {
            const { createVSCodeHost } = requireOut('app/host/vscodeHost.js');
            return await callback({ host: createVSCodeHost(context), fake, context });
        } finally {
            context.cleanup();
        }
    });
}

test('paths come from the extension context as plain strings', () => withHost({}, ({ host, context }) => {
    assert.equal(host.paths.installRoot, context.extensionPath);
    assert.equal(host.paths.globalStorageDir, context.globalStorageUri.fsPath);
    assert.equal(host.paths.workspaceStorageDir, context.storageUri.fsPath);
    assert.equal(host.paths.mode, 'test');
    assert.equal(host.globalState, context.globalState);
}));

for (const [mode, expected] of [[ExtensionMode.Production, 'production'], [ExtensionMode.Development, 'development'], [ExtensionMode.Test, 'test']]) {
    test(`ExtensionMode ${mode} maps to host mode "${expected}"`, () => withHost({ context: { extensionMode: mode } }, ({ host }) => {
        assert.equal(host.paths.mode, expected);
    }));
}

test('notify forwards to the matching show*Message and returns the clicked action', () => withHost({}, async ({ host, fake }) => {
    fake.queueAnswer('Retry');
    assert.equal(await host.notifier.notify('error', 'It failed', 'Retry', 'Cancel'), 'Retry');
    await host.notifier.notify('info', 'Done');
    await host.notifier.notify('warning', 'Careful', 'OK');
    assert.deepEqual(fake.messages, [
        { kind: 'error', message: 'It failed', items: ['Retry', 'Cancel'] },
        { kind: 'info', message: 'Done', items: [] },
        { kind: 'warning', message: 'Careful', items: ['OK'] },
    ]);
}));

test('confirm is a modal warning by default and is never answered for the person', () => withHost({}, async ({ host, fake }) => {
    const answer = await host.notifier.confirm('Download cloudflared?', { detail: 'About 30 MB', actions: ['Download'] });
    assert.equal(answer, undefined, 'with nobody answering, consent is not given');
    assert.deepEqual(fake.messages, [{ kind: 'warning', message: 'Download cloudflared?', items: ['Download'] }]);
}));

test('withProgress runs the task with a progress reporter and a cancellation token', () => withHost({}, async ({ host, fake }) => {
    const result = await host.withProgress({ title: 'Analysing' }, async (progress, cancellation) => {
        progress.report({ message: 'half', increment: 50 });
        assert.equal(cancellation.isCancellationRequested, false);
        assert.equal(typeof cancellation.onCancellationRequested, 'function');
        return 42;
    });
    assert.equal(result, 42);
    assert.deepEqual(fake.progressReports, [{ title: 'Analysing', report: { message: 'half', increment: 50 } }]);
}));

test('prompt, clipboard and openExternal forward to VS Code', () => withHost({}, async ({ host, fake }) => {
    fake.queueAnswer('token');
    assert.equal(await host.prompt({ prompt: 'Token', password: true }), 'token');
    assert.deepEqual(fake.dialogs, [{ kind: 'inputBox', options: { prompt: 'Token', password: true } }]);
    await host.clipboardWrite('https://127.0.0.1:8443');
    assert.equal(fake.clipboard, 'https://127.0.0.1:8443');
    assert.equal(await host.openExternal('https://example.com/a'), true);
    assert.equal(String(fake.openedExternal[0]), 'https://example.com/a');
}));

test('workspaceFolders lists folder paths, or none', () => withHost({}, ({ host, fake }) => {
    assert.deepEqual(host.workspaceFolders(), []);
    fake.vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/work/a' } }, { uri: { fsPath: '/work/b' } }];
    assert.deepEqual(host.workspaceFolders(), ['/work/a', '/work/b']);
}));

test('each signal fires the VS Code command the core fires today', () => withHost({}, ({ host, fake }) => {
    host.signal({ kind: 'refresh', view: 'servers' });
    host.signal({ kind: 'refresh', view: 'activeServers' });
    host.signal({ kind: 'state', key: 'pythonEnv.uiLocked', value: true });
    host.signal({ kind: 'state', key: 'pythonEnv.retryAvailable', value: false });
    host.signal({ kind: 'revealSidebar' });
    host.signal({ kind: 'openServerSettings' });
    assert.deepEqual(fake.executedCommands, [
        { id: 'codexr.servers.refresh', args: [] },
        { id: 'codeXR.activeServers.refreshServers', args: [] },
        { id: 'setContext', args: ['codeXR.pythonEnv.uiLocked', true] },
        { id: 'setContext', args: ['codeXR.pythonEnv.retryAvailable', false] },
        { id: 'workbench.view.extension.codeXRView', args: [] },
        { id: 'codexr.server.configure', args: [] },
    ]);
}));

// #13 step 6: core modules reach the host through getHost(). In tests every
// withFakeVscode scope provides one over the same fake (fakeVscode.cjs).

test('the test fallback builds the host on first use; an earlier initializeHost wins; reset clears it', () => {
    const registry = require(path.join(__dirname, '..', '..', 'out', 'core', 'host', 'hostRegistry.js'));
    registry.resetHostForTests();
    try {
        let built = 0;
        registry.setHostFallbackForTests(() => ({ name: `fallback-${++built}` }));
        assert.equal(built, 0, 'nothing is built before getHost()');
        assert.equal(registry.getHost().name, 'fallback-1');
        assert.equal(registry.getHost().name, 'fallback-1', 'built once, then kept');

        registry.resetHostForTests();
        registry.setHostFallbackForTests(() => ({ name: 'fallback' }));
        registry.initializeHost({ name: 'activated' });
        assert.equal(registry.getHost().name, 'activated');

        registry.resetHostForTests();
        assert.throws(() => registry.getHost(), /not initialized/, 'reset also drops the fallback');
    } finally {
        registry.resetHostForTests();
    }
});

test('inside withFakeVscode, a core notification lands in fake.messages, and the host does not outlive the scope', async () => {
    const fake = createFakeVscode();
    const context = fakeExtensionContext();
    try {
        await withFakeVscode(fake, async () => {
            fake.hostContext = context;
            // The scope's own instance (requireOut would load a fresh one without the fallback),
            // the same one a core module gets from its import.
            const { getHost } = require(path.join(__dirname, '..', '..', 'out', 'core', 'host', 'hostRegistry.js'));
            assert.equal(getHost().paths.globalStorageDir, context.globalStorageUri.fsPath, 'built from fake.hostContext');
            await getHost().notifier.notify('error', 'Failed to start analysis: boom');
        });
    } finally {
        context.cleanup();
    }
    assert.deepEqual(fake.messages.map(({ kind, message }) => [kind, message]), [['error', 'Failed to start analysis: boom']]);

    const registry = require(path.join(__dirname, '..', '..', 'out', 'core', 'host', 'hostRegistry.js'));
    registry.resetHostForTests();
    assert.throws(() => registry.getHost(), /not initialized/, 'outside a scope there is no host');
});

// The modules whose notifications already go through the host (step 6, smallest first).
const NOTIFYING_THROUGH_HOST = [
    'src/core/analysis/launchers/launchPipeline.ts',
    'src/core/analysis/launchers/launcherXRAnalysis.ts',
    'src/core/analysis/parsers/fileXRParser.ts',
    'src/core/analysis/analysisOrchestrator.ts',
    'src/core/analysis/watchers/fileWatcherOrchestrator.ts',
    'src/core/server/serverControl.ts',
    'src/core/server/httpsCustomServer.ts',
    'src/core/server/httpsDefaultServer.ts',
];

test('modules moved to host notifications call no vscode.window message API', () => {
    const fs = require('node:fs');
    for (const file of NOTIFYING_THROUGH_HOST) {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
        assert.match(source, /getHost\(\)/, `${file}: canary, the host is used`);
        assert.match(source, /notifier\.(notify|confirm)\(/, `${file}: canary, the host notifier is called`);
        assert.doesNotMatch(source, /vscode\.window\.(show(Information|Warning|Error)Message|setStatusBarMessage)/, `${file} still calls vscode.window`);
    }
});

// Inventory risk 8: the cloudflared download consent now goes through
// host.notifier.confirm. It must stay a modal question nobody answers by
// default, and declining must neither download nor remember anything.
test('cloudflared consent: a modal info question through the host; declining downloads nothing and stores nothing', async () => {
    const supported = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'].includes(`${process.platform}-${process.arch}`);
    if (!supported) {
        return;
    }
    const fake = createFakeVscode();
    const context = fakeExtensionContext();
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            fake.hostContext = context;
            const { CloudflaredBinaryManager } = requireOut('core/remote-access/cloudflaredBinaryManager.js');
            const manager = new CloudflaredBinaryManager(context);
            assert.equal(await manager.resolveBinary(true), null, 'no answer means no binary');
        });
    } finally {
        process.env.PATH = savedPath;
        context.cleanup();
    }
    assert.equal(fake.messages.length, 1);
    assert.equal(fake.messages[0].kind, 'info');
    assert.match(fake.messages[0].message, /^CodeXR needs cloudflared /);
    assert.deepEqual(fake.messages[0].items, ['Download cloudflared']);
    assert.equal(fake.progressReports.length, 0, 'nothing was downloaded');
    assert.deepEqual(context.globalState.keys(), [], 'declining is not remembered');
});

test('confirm takes a severity for its icon; with no actions it is a modal message to dismiss', () => withHost({}, async ({ host, fake }) => {
    await host.notifier.confirm('How to accept the certificate', { modal: true, severity: 'info', actions: [] });
    await host.notifier.confirm('Broken', { severity: 'error', actions: ['Retry'] });
    assert.deepEqual(fake.messages, [
        { kind: 'info', message: 'How to accept the certificate', items: [] },
        { kind: 'error', message: 'Broken', items: ['Retry'] },
    ]);
}));

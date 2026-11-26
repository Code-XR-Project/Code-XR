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

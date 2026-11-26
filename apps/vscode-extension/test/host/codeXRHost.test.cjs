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
    'src/core/python-env/venvManager.ts',
    'src/core/remote-access/remoteAccessManager.ts',
];

// Modules that only used vscode.window for progress or the status line; no notifier canary applies.
const PROGRESS_OR_STATUS_THROUGH_HOST = [
    'src/core/analysis/python/executePython.ts',
    'src/core/analysis/watchers/directoryReAnalyzer.ts',
];

test('modules moved to host notifications call no vscode.window message API', () => {
    const fs = require('node:fs');
    for (const file of NOTIFYING_THROUGH_HOST) {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
        assert.match(source, /getHost\(\)/, `${file}: canary, the host is used`);
        assert.match(source, /notifier\.(notify|confirm)\(/, `${file}: canary, the host notifier is called`);
        assert.doesNotMatch(source, /vscode\.window\.(show(Information|Warning|Error)Message|setStatusBarMessage|showInputBox|withProgress)/, `${file} still calls vscode.window`);
        assert.doesNotMatch(source, /vscode\.(env|commands)\./, `${file} still calls vscode.env or vscode.commands`);
    }
});

// Inventory risk 8: the cloudflared download consent now goes through
// host.notifier.confirm. It must stay a modal question nobody answers by
// default, and declining must neither download nor remember anything.
test('cloudflared consent: a modal info question through the host; declining downloads nothing and stores nothing', async (t) => {
    // The platforms with a pinned automatic download (ASSETS in cloudflaredBinaryManager.ts);
    // elsewhere (macOS: Homebrew) there is no consent to ask.
    if (!['win32-x64', 'linux-x64', 'linux-arm64'].includes(`${process.platform}-${process.arch}`)) {
        t.skip(`no automatic cloudflared download on ${process.platform}-${process.arch}`);
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

test('createStatusIndicator is a left status-bar item, keeping the priority it is given', () => {
    const created = [];
    const item = { text: '', tooltip: undefined, show() {}, hide() {}, dispose() {} };
    return withHost({
        fake: {
            overrides: {
                window: {
                    createStatusBarItem: (...args) => {
                        created.push(args);
                        return item;
                    },
                },
            },
        },
    }, ({ host, fake }) => {
        const indicator = host.notifier.createStatusIndicator({ priority: 100 });
        host.notifier.createStatusIndicator();
        indicator.text = '$(clock) Analyzing a.ts in 3s';
        indicator.tooltip = 'Waiting';
        const left = fake.vscode.StatusBarAlignment.Left;
        assert.deepEqual(created, [[left, 100], [left]]);
        assert.equal(item.text, '$(clock) Analyzing a.ts in 3s');
        assert.equal(item.tooltip, 'Waiting');
    });
});

test('progress and status-line modules go through the host, not vscode.window', () => {
    const fs = require('node:fs');
    for (const file of PROGRESS_OR_STATUS_THROUGH_HOST) {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
        assert.match(source, /getHost\(\)\.(withProgress|notifier\.status)\(/, `${file}: canary`);
        assert.doesNotMatch(source, /vscode\.(window|env|commands)\./, `${file} still calls vscode directly`);
    }
});

test('the re-analysis countdown uses a host status indicator, not vscode.window', () => {
    const fs = require('node:fs');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/core/analysis/watchers/debounceManager.ts'), 'utf8');
    assert.match(source, /getHost\(\)\.notifier\.createStatusIndicator\(\{ priority: 100 \}\)/, 'canary');
    assert.doesNotMatch(source, /vscode\.window\./);
});

// Inventory risk 8, second consent: deleting the Python environment.
test('deleting the Python environment asks through the host; no answer deletes nothing', async () => {
    const fake = createFakeVscode();
    const context = fakeExtensionContext();
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            fake.hostContext = context;
            const { VenvManager } = requireOut('core/python-env/venvManager.js');
            await new VenvManager(context).deleteEnvironment();
        });
    } finally {
        context.cleanup();
    }
    assert.deepEqual(fake.messages.map(({ kind, items }) => [kind, items]), [['warning', ['Delete Environment']]]);
    assert.match(fake.messages[0].message, /^Are you sure you want to delete the Python virtual environment\?/);
    assert.equal(fake.progressReports.length, 0, 'nothing was removed');
});

test('a failing signal command is logged, never left as an unhandled rejection', () => withHost({
    fake: { overrides: { commands: { executeCommand: () => Promise.reject(new Error('no such command')) } } },
}, async ({ host }) => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        host.signal({ kind: 'state', key: 'pythonEnv.uiLocked', value: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
}));

test('prompt maps title, validate and keepOpen onto the VS Code input box, and sets nothing it was not given', () => withHost({}, async ({ host, fake }) => {
    const validate = (input) => /^\d{6}$/.test(input) ? undefined : 'Enter exactly six digits.';
    await host.prompt({ title: 'Pairing code', prompt: 'Code', placeHolder: '000000', validate, keepOpen: true });
    const options = fake.dialogs[0].options;
    assert.deepEqual(Object.keys(options).sort(), ['ignoreFocusOut', 'placeHolder', 'prompt', 'title', 'validateInput']);
    assert.equal(options.ignoreFocusOut, true);
    assert.equal(options.validateInput, validate);
}));

// #13 steps 6-7 end state: the core reaches the person and the editor only
// through the host. What may still name vscode is type positions
// (ExtensionContext, step 9) and workspace.fs (step 8).
test('no file under src/core calls vscode.window, vscode.env, vscode.commands or the workspace folders directly', () => {
    const fs = require('node:fs');
    const root = path.join(__dirname, '..', '..', 'src', 'core');
    const offenders = [];
    let scanned = 0;
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.ts')) {
                scanned += 1;
                const source = fs.readFileSync(full, 'utf8');
                if (/vscode\.(window|env|commands)\.|vscode\.workspace\.workspaceFolders/.test(source)) {
                    offenders.push(path.relative(root, full));
                }
            }
        }
    };
    walk(root);
    assert.ok(scanned > 100, `canary: scanned ${scanned} files`);
    assert.deepEqual(offenders, []);
});

/**
 * Behavioural characterization of the Active Analyses command handlers
 * (src/code_analysis/views/subsections/active_analyses/commands/activeAnalysesCommands.ts),
 * executed from out/ under the fake vscode.
 *
 * What it pins, so that reshaping the handlers cannot change what a user sees:
 *  - the session-resolution prelude every handler opens with: no argument ->
 *    "No analysis selected"; an id the registry does not know -> "Analysis
 *    session not found"; in that order, and nothing else happens;
 *  - every argument shape extractSessionId accepts;
 *  - the four close outcomes (cleanup x removal) and the cancelled close.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode, fakeExtensionContext } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

const MODULE = 'code_analysis/views/subsections/active_analyses/commands/activeAnalysesCommands.js';

const COMMANDS = {
    showActions: 'codeXR.analysis.activeAnalyses.showActions',
    showDetails: 'codeXR.analysis.activeAnalyses.showDetails',
    close: 'codeXR.analysis.activeAnalyses.close',
    viewInBrowser: 'codeXR.analysis.activeAnalyses.viewInBrowser',
    exportFolder: 'codeXR.analysis.activeAnalyses.exportFolder',
};

function createRegistry(sessions, { removeResult = true } = {}) {
    const calls = [];
    return {
        calls,
        getSession(id) {
            calls.push(['getSession', id]);
            return sessions[id];
        },
        removeSession(id) {
            calls.push(['removeSession', id]);
            return removeResult;
        },
    };
}

function createWatcher(cleanupResult = true) {
    const calls = [];
    return {
        calls,
        async triggerManualCleanup(id) {
            calls.push(id);
            return cleanupResult;
        },
    };
}

/** Runs `body(run)` where run(commandName, arg) invokes the registered callback. */
async function withCommands(fake, registry, watcher, body) {
    await withFakeVscode(fake, async ({ requireOut }) => {
        const { ActiveAnalysesCommands } = requireOut(MODULE);
        const commands = ActiveAnalysesCommands.getInstance(registry, watcher, fakeExtensionContext());
        const byId = new Map(commands.getCommandRegistrations().map((entry) => [entry.commandId, entry.callback]));
        await body((name, arg) => byId.get(COMMANDS[name])(arg));
    });
}

function messageTexts(fake) {
    return fake.messages.map(({ kind, message }) => `${kind}: ${message}`);
}

for (const name of Object.keys(COMMANDS)) {
    test(`${name}: no selection reports "No analysis selected" and never touches the registry`, async () => {
        const fake = createFakeVscode();
        const registry = createRegistry({});
        const watcher = createWatcher();
        await withCommands(fake, registry, watcher, async (run) => {
            await run(name, undefined);
            await run(name, {});
        });
        assert.deepEqual(messageTexts(fake), ['error: No analysis selected', 'error: No analysis selected']);
        assert.deepEqual(registry.calls, []);
        assert.deepEqual(watcher.calls, []);
        assert.deepEqual(fake.dialogs, []);
    });

    test(`${name}: an unknown session id reports "Analysis session not found" and stops there`, async () => {
        const fake = createFakeVscode();
        const registry = createRegistry({});
        const watcher = createWatcher();
        await withCommands(fake, registry, watcher, async (run) => {
            await run(name, 'missing-session');
        });
        assert.deepEqual(messageTexts(fake), ['error: Analysis session not found']);
        assert.deepEqual(registry.calls, [['getSession', 'missing-session']]);
        assert.deepEqual(watcher.calls, []);
        assert.deepEqual(fake.dialogs, []);
        assert.deepEqual(fake.executedCommands, []);
    });
}

test('every argument shape the tree, the palette and the quick pick pass resolves to the same session id', async () => {
    const shapes = [
        'sess-1',
        { session: { id: 'sess-1' } },
        { sessionId: 'sess-1' },
        { id: 'sess-1' },
        { originalAnalysisItem: { sessionId: 'sess-1' } },
        { originalAnalysisItem: { id: 'sess-1' } },
        { originalAnalysisItem: { session: { id: 'sess-1' } } },
    ];
    const fake = createFakeVscode();
    const registry = createRegistry({});
    await withCommands(fake, registry, createWatcher(), async (run) => {
        for (const shape of shapes) {
            await run('showDetails', shape);
        }
    });
    assert.deepEqual(registry.calls, shapes.map(() => ['getSession', 'sess-1']));
    assert.deepEqual(messageTexts(fake), shapes.map(() => 'error: Analysis session not found'));
});

test('viewInBrowser opens the server URL of a resolved session, or says it has none', async () => {
    const fake = createFakeVscode();
    const registry = createRegistry({
        withUrl: { id: 'withUrl', serverUrl: 'http://localhost:4100/' },
        withPort: { id: 'withPort', assignedPort: 4200 },
        none: { id: 'none' },
    });
    await withCommands(fake, registry, createWatcher(), async (run) => {
        await run('viewInBrowser', 'withUrl');
        await run('viewInBrowser', 'withPort');
        await run('viewInBrowser', 'none');
    });
    assert.deepEqual(fake.openedExternal.map((uri) => uri.toString()), [
        'http://localhost:4100/',
        'http://localhost:4200/',
    ]);
    assert.deepEqual(messageTexts(fake), ['error: No server URL available for this analysis']);
});

test('exportFolder on a session without an output folder says so before any dialog', async () => {
    const fake = createFakeVscode();
    const registry = createRegistry({
        sess: { id: 'sess', savedFilesPath: path.join(os.tmpdir(), 'codexr-no-such-folder-' + process.pid) },
    });
    await withCommands(fake, registry, createWatcher(), async (run) => {
        await run('exportFolder', 'sess');
    });
    assert.deepEqual(messageTexts(fake), ['error: No analysis output folder is available to export']);
    assert.deepEqual(fake.dialogs, []);
});

test('showActions offers only the actions a resolved session supports', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-actions-'));
    try {
        const fake = createFakeVscode();
        const registry = createRegistry({
            full: { id: 'full', targetPath: '/repo/project', serverUrl: 'http://localhost:1', savedFilesPath: folder, status: 'running' },
            bare: { id: 'bare', targetName: 'lonely.py', status: 'closed' },
        });
        await withCommands(fake, registry, createWatcher(), async (run) => {
            await run('showActions', 'full');
            await run('showActions', 'bare');
        });
        assert.deepEqual(fake.dialogs.map(({ options }) => options.items.map((item) => item.action)), [
            ['details', 'browser', 'export', 'close'],
            ['details'],
        ]);
        assert.deepEqual(fake.dialogs.map(({ options }) => options.options.title), [
            'Active Analysis Actions - project',
            'Active Analysis Actions - lonely.py',
        ]);
        assert.deepEqual(fake.messages, []);
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
});

const CLOSE_OUTCOMES = [
    { cleanup: true, removed: true, expected: 'info: Analysis closed successfully' },
    {
        cleanup: false,
        removed: true,
        expected: 'warning: Analysis was removed from Active Analyses, but server or watcher cleanup may not have completed fully.',
    },
    {
        cleanup: true,
        removed: false,
        expected: 'warning: Analysis resources were cleaned up, but the session entry could not be removed from Active Analyses.',
    },
    { cleanup: false, removed: false, expected: 'error: Failed to close the analysis session cleanly' },
];

for (const { cleanup, removed, expected } of CLOSE_OUTCOMES) {
    test(`closeOutcome: cleanup ${cleanup} and removal ${removed} -> ${expected.split(':')[0]}`, async () => {
        const fake = createFakeVscode();
        const registry = createRegistry({
            sess: { id: 'sess', targetPath: '/repo/app', targetType: 'directory', analysisMode: 'XR', status: 'running' },
        }, { removeResult: removed });
        const watcher = createWatcher(cleanup);
        fake.queueAnswer('Close Analysis');
        await withCommands(fake, registry, watcher, async (run) => {
            await run('close', { sessionId: 'sess' });
        });
        const [confirmation, outcome, ...rest] = fake.messages;
        assert.equal(confirmation.kind, 'warning');
        assert.equal(confirmation.message, 'Close analysis for "app"?');
        assert.deepEqual(confirmation.items, ['Close Analysis', 'Cancel']);
        assert.equal(`${outcome.kind}: ${outcome.message}`, expected);
        assert.deepEqual(rest, []);
        // Cleanup runs before removal, on the resolved id, then the tree refreshes.
        assert.deepEqual(watcher.calls, ['sess']);
        assert.deepEqual(registry.calls, [['getSession', 'sess'], ['removeSession', 'sess']]);
        assert.deepEqual(fake.executedCommands.map(({ id }) => id), ['codeXR.analysis.activeAnalyses.refresh']);
    });
}

test('closeOutcome: declining the confirmation closes nothing', async () => {
    const fake = createFakeVscode();
    const registry = createRegistry({ sess: { id: 'sess', targetPath: '/repo/app' } });
    const watcher = createWatcher();
    fake.queueAnswer('Cancel');
    await withCommands(fake, registry, watcher, async (run) => {
        await run('close', 'sess');
    });
    assert.equal(fake.messages.length, 1);
    assert.deepEqual(watcher.calls, []);
    assert.deepEqual(registry.calls, [['getSession', 'sess']]);
    assert.deepEqual(fake.executedCommands, []);
});

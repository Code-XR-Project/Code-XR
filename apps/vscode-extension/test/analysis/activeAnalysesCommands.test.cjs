/**
 * Behavioural characterization of the Active Analyses command handlers
 * (src/features/analysis/sections/active-analyses/activeAnalysesCommands.ts),
 * executed from out/ under the fake vscode.
 *
 * What it pins, so that reshaping the handlers cannot change what a user sees:
 *  - the session-resolution prelude every handler opens with: no argument ->
 *    "No analysis selected"; an id the registry does not know -> "Analysis
 *    session not found"; in that order, and nothing else happens;
 *  - every argument shape extractSessionId accepts;
 *  - the four close outcomes (cleanup x removal) and the cancelled close;
 *  - the Export Analysis Folder wizard: the order of its dialogs, their
 *    texts, and where each dismissal or failure stops it (W5-10).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { createFakeVscode, withFakeVscode, fakeExtensionContext } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

const MODULE = 'features/analysis/sections/active-analyses/activeAnalysesCommands.js';

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

// ------------------------------------------------------------------------
// The Export Analysis Folder wizard (W5-10, the precondition for W5-11).
// Every dialog and message lands in ONE ordered log, so the order of the
// steps is pinned positionally: modes, Git preflight, history range, N,
// performance, the modal 'Continue Export' confirmation and only then the
// destination picker. Each step's dismissal ends the wizard right there.

const GIT_EXPORTER_MODULE = 'core/export/gitRevisionExporter.js';
const GIT_OPTIONS_MODULE = 'core/export/gitExportOptions.js';

/**
 * Answers are consumed FIFO by every dialog and message; a function answer
 * is called with the dialog's items (a pick) and returns the chosen value.
 */
function createWizardFake(answers) {
    const log = [];
    const queue = [...answers];
    const next = (items) => {
        const answer = queue.length > 0 ? queue.shift() : undefined;
        return Promise.resolve(typeof answer === 'function' ? answer(items) : answer);
    };
    const message = (kind) => (text, ...rest) => {
        log.push({ step: kind, text, options: rest.find((entry) => entry && typeof entry === 'object'), items: rest.filter((entry) => typeof entry === 'string') });
        return next();
    };
    const fake = createFakeVscode({
        overrides: {
            window: {
                showQuickPick: (items, options) => {
                    log.push({ step: 'quickPick', title: options.title, placeHolder: options.placeHolder, canPickMany: !!options.canPickMany, items });
                    return next(items);
                },
                showInputBox: (options) => {
                    log.push({ step: 'inputBox', title: options.title, prompt: options.prompt, value: options.value, validateInput: options.validateInput });
                    return next();
                },
                showOpenDialog: (options) => {
                    log.push({ step: 'openDialog', openLabel: options.openLabel, title: options.title });
                    return next();
                },
                showInformationMessage: message('info'),
                showWarningMessage: message('warning'),
                showErrorMessage: message('error'),
            },
        },
    });
    return { fake, log };
}

async function runExportWizard({ answers, inspect, session }) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-export-wizard-'));
    const { fake, log } = createWizardFake(answers);
    const inspected = [];
    let plans;
    try {
        const registry = createRegistry({ sess: { id: 'sess', analysisMode: 'XR', savedFilesPath: folder, ...session } });
        await withFakeVscode(fake, async ({ requireOut }) => {
            const exporter = requireOut(GIT_EXPORTER_MODULE);
            exporter.inspectGitRevisionExport = async (context, inspectedSession) => {
                inspected.push(inspectedSession.id);
                return inspect();
            };
            const { calculateGitExportWorkerPlan } = requireOut(GIT_OPTIONS_MODULE);
            plans = {
                balanced: calculateGitExportWorkerPlan('balanced').workerCount,
                maximum: calculateGitExportWorkerPlan('maximum').workerCount,
            };
            const { ActiveAnalysesCommands } = requireOut(MODULE);
            const commands = ActiveAnalysesCommands.getInstance(registry, createWatcher(), fakeExtensionContext());
            const exportFolder = commands.getCommandRegistrations().find((entry) => entry.commandId === COMMANDS.exportFolder);
            await exportFolder.callback('sess');
        });
        return { log, inspected, plans, folder };
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
}

const allModes = (items) => items;
const pick = (label) => (items) => items.find((item) => item.label.startsWith(label));

test('export wizard: the steps run in a fixed order and Continue Export comes right before the destination picker', async () => {
    const { log, inspected, plans } = await runExportWizard({
        inspect: () => ({ commitCount: 1234 }),
        answers: [allModes, pick('Only the latest N commits'), '7', pick('Maximum speed'), 'Continue Export', undefined],
    });
    assert.deepEqual(log.map((entry) => entry.step), ['quickPick', 'quickPick', 'inputBox', 'quickPick', 'warning', 'openDialog']);
    const [modes, scope, count, performance, confirmation, destination] = log;

    assert.equal(modes.title, 'Export Analysis Folder: choose the analyses to include');
    assert.equal(modes.canPickMany, true);
    assert.deepEqual(modes.items.map((item) => item.modeId), ['normal', 'dependency-graph', 'historical', 'evolution']);

    assert.equal(scope.title, 'Export Git timeline: choose history range');
    assert.equal(scope.placeHolder, `${(1234).toLocaleString()} commits on the checked-out branch. Other branches, stashes and notes are not exported.`);
    assert.deepEqual(scope.items.map((item) => item.label), [
        `Entire history of the checked-out branch — ${(1234).toLocaleString()} commits`,
        'Only the latest N commits…',
    ]);
    assert.deepEqual(scope.items.map((item) => item.scope), [{ kind: 'all' }, { kind: 'latest', count: 1 }]);

    assert.equal(count.title, 'Export Git timeline: number of latest commits');
    assert.equal(count.value, '100');
    assert.equal(count.validateInput('7'), undefined);
    for (const bad of ['0', '1235', '2.5', 'many']) {
        assert.equal(count.validateInput(bad), 'Enter a whole number between 1 and 1234.');
    }

    assert.equal(performance.title, 'Export Git timeline: choose performance');
    assert.deepEqual(performance.items.map((item) => [item.label, item.profile]), [
        [`Balanced — ${plans.balanced} workers`, 'balanced'],
        [`Maximum speed — ${plans.maximum} workers`, 'maximum'],
    ]);

    assert.equal(confirmation.text, 'Historical comparison and Project evolution will export 7 Git commits'
        + ` plus the working copy using ${plans.maximum} persistent workers. `
        + 'Unchanged Git files are analyzed once and shared across revisions.');
    assert.deepEqual(confirmation.options, { modal: true });
    assert.deepEqual(confirmation.items, ['Continue Export']);

    assert.equal(destination.openLabel, 'Select Export Destination');
    assert.deepEqual(inspected, ['sess']);
});

test('export wizard: the entire history skips the count box and confirms the whole commit count', async () => {
    const { log, plans } = await runExportWizard({
        inspect: () => ({ commitCount: 3 }),
        answers: [
            (items) => items.filter((item) => item.modeId !== 'evolution'),
            pick('Entire history of the checked-out branch'),
            pick('Balanced'),
            'Continue Export',
            undefined,
        ],
    });
    assert.deepEqual(log.map((entry) => entry.step), ['quickPick', 'quickPick', 'quickPick', 'warning', 'openDialog']);
    assert.equal(log[3].text, `Historical comparison will export 3 Git commits plus the working copy using ${plans.balanced} persistent workers. `
        + 'Unchanged Git files are analyzed once and shared across revisions.');
});

test('export wizard: without a git mode it goes straight from the modes to the destination', async () => {
    const { log, inspected } = await runExportWizard({
        inspect: () => assert.fail('no preflight without a git mode'),
        answers: [(items) => items.filter((item) => item.modeId === 'normal'), undefined],
    });
    assert.deepEqual(log.map((entry) => entry.step), ['quickPick', 'openDialog']);
    assert.deepEqual(inspected, []);
});

test('export wizard: dismissing any step ends the wizard there, with no message', async () => {
    const steps = [
        { answers: [undefined], expected: ['quickPick'] },
        { answers: [allModes, undefined], expected: ['quickPick', 'quickPick'] },
        { answers: [allModes, pick('Only the latest'), undefined], expected: ['quickPick', 'quickPick', 'inputBox'] },
        { answers: [allModes, pick('Entire'), undefined], expected: ['quickPick', 'quickPick', 'quickPick'] },
        { answers: [allModes, pick('Entire'), pick('Balanced'), undefined], expected: ['quickPick', 'quickPick', 'quickPick', 'warning'] },
        { answers: [allModes, pick('Entire'), pick('Balanced'), 'Something else'], expected: ['quickPick', 'quickPick', 'quickPick', 'warning'] },
    ];
    for (const { answers, expected } of steps) {
        const { log } = await runExportWizard({ inspect: () => ({ commitCount: 10 }), answers });
        assert.deepEqual(log.map((entry) => entry.step), expected);
    }
});

test('export wizard: no commits, or a failing preflight, is an error before any further dialog', async () => {
    const empty = await runExportWizard({ inspect: () => ({ commitCount: 0 }), answers: [allModes] });
    assert.deepEqual(empty.log.map((entry) => [entry.step, entry.text]), [
        ['quickPick', undefined],
        ['error', 'Historical comparison and Project evolution need at least one Git commit to export.'],
    ]);
    const failing = await runExportWizard({
        inspect: () => {
            throw new Error('not a repository');
        },
        answers: [allModes],
    });
    assert.deepEqual(failing.log.map((entry) => [entry.step, entry.text]), [
        ['quickPick', undefined],
        ['error', 'The Git timeline cannot be exported: not a repository'],
    ]);
});

test('export wizard: an existing destination folder is refused after the picker, before any export work', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-export-parent-'));
    try {
        fs.mkdirSync(path.join(parent, 'already-here'));
        const { log } = await runExportWizard({
            session: { outputDirectory: 'already-here' },
            inspect: () => assert.fail('no preflight without a git mode'),
            answers: [(items) => items.filter((item) => item.modeId === 'normal'), [{ fsPath: parent }]],
        });
        assert.deepEqual(log.map((entry) => [entry.step, entry.text]), [
            ['quickPick', undefined],
            ['openDialog', undefined],
            ['warning', `The destination folder already exists: ${path.join(parent, 'already-here')}. Choose a different location or remove the existing folder first.`],
        ]);
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

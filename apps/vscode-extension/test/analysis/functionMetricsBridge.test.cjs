const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeVscode, withFakeVscode, fakeExtensionContext } = require('../helpers/fakeVscode.cjs');

// #173/#178: the extension half of the metric checks and lenses shared with the
// Code-XR IDE. The pure logic is tested in apps/ide (test/problems.test.ts,
// test/functionMetricsTracker.test.ts) against these same core sources.

test('a launched analysis reaches every listener, and a throwing one breaks nothing', async () => {
    await withFakeVscode(createFakeVscode(), ({ requireOut }) => {
        const { onAnalysisLaunched, notifyAnalysisLaunched } = requireOut('core/analysis/analysisEvents.js');
        const seen = [];
        const errors = [];
        const first = onAnalysisLaunched(() => { throw new Error('boom'); });
        const second = onAnalysisLaunched((event) => seen.push(event.targetPath));
        const event = { targetPath: '/p', targetType: 'directory', analysisMode: 'XR', isDeep: true };
        notifyAnalysisLaunched(event, (error) => errors.push(error.message));
        assert.deepEqual(seen, ['/p']);
        assert.deepEqual(errors, ['boom']);
        first.dispose();
        second.dispose();
        notifyAnalysisLaunched(event, () => assert.fail('no listener left'));
        assert.deepEqual(seen, ['/p']);
    });
});

test('the functions mode: a folder runs deep, a file relative to its root, and a failed run rejects', async () => {
    await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
        const { ExecutePython } = requireOut('core/analysis/python/executePython.js');
        const runs = [];
        const executor = new ExecutePython(fakeExtensionContext());
        executor.executePythonScript = async (script, args) => {
            runs.push([script, ...args]);
            return args.includes('/broken.py') ? { success: false, error: 'no lizard' } : [];
        };
        await executor.executeFunctionMetrics('/p', 'directory', '/p');
        await executor.executeFunctionMetrics('/p/a.py', 'file', '/p');
        await assert.rejects(executor.executeFunctionMetrics('/broken.py', 'file', '/p'), /no lizard/);
        assert.deepEqual(runs.slice(0, 2), [
            ['main.py', '--mode', 'functions', '--type', 'directory', '--target', '/p', '--deep'],
            ['main.py', '--mode', 'functions', '--type', 'file', '--target', '/p/a.py', '--project-root', '/p'],
        ]);
    });
});

test('in VS Code: warnings in Problems, a lens per function, out of date while unsaved, the setting off', async () => {
    class Range { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } }
    class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
    class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
    const diagnostics = new Map();
    let provider;
    const listeners = {};
    const on = (name) => (listener) => { listeners[name] = listener; return { dispose() {} }; };
    const fake = createFakeVscode({
        config: { 'codeXR.problems.metrics.maxComplexity': 10 },
        overrides: {
            Range, CodeLens, Diagnostic,
            RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
            DiagnosticSeverity: { Error: 0, Warning: 1 },
            OverviewRulerLane: { Left: 1 },
            languages: {
                createDiagnosticCollection: () => ({ clear: () => diagnostics.clear(), set: (uri, list) => diagnostics.set(uri.fsPath, list), dispose() {} }),
                registerCodeLensProvider: (_selector, value) => { provider = value; return { dispose() {} }; },
            },
            window: { createTextEditorDecorationType: () => ({ dispose() {} }), visibleTextEditors: [], onDidChangeVisibleTextEditors: on('editors') },
            workspace: {
                createFileSystemWatcher: () => ({ onDidChange: on('disk'), dispose() {} }),
                onDidSaveTextDocument: on('save'),
                onDidChangeTextDocument: on('edit'),
            },
        },
    });
    await withFakeVscode(fake, async ({ requireOut }) => {
        const vscode = fake.vscode;
        const { ExecutePython } = requireOut('core/analysis/python/executePython.js');
        ExecutePython.prototype.executeFunctionMetrics = async () => [
            { relativePath: 'src/a.py', functions: [{ functionName: 'route', lineStart: 3, lineEnd: 30, lineCount: 22, complexity: 18, parameters: 7 }] },
        ];
        // requireOut loads a fresh copy: the event module first, so the feature binds to this one.
        const { notifyAnalysisLaunched } = requireOut('core/analysis/analysisEvents.js');
        const { registerMetricsInEditor } = requireOut('features/metrics-in-editor/metricsInEditor.js');
        const context = fakeExtensionContext();
        registerMetricsInEditor(context);
        // A resolved root: on Windows the fake Uri.file turns '/p' into 'D:\\p', as VS Code would.
        const root = require('node:path').resolve('/p');
        notifyAnalysisLaunched({ targetPath: root, targetType: 'directory', analysisMode: 'XR', isDeep: true }, assert.fail);
        await new Promise((done) => setTimeout(done, 10));

        const file = require('node:path').join(root, 'src', 'a.py');
        assert.deepEqual([...diagnostics.get(file)].map((d) => [d.message, d.source, d.code, d.range.start.line]), [
            ["'route' has a cyclomatic complexity of 18 (limit 10).", 'Code-XR', 'complexity', 2],
            ["'route' takes 7 parameters (limit 5).", 'Code-XR', 'parameters', 2],
        ]);
        const document = { uri: vscode.Uri.file(file), isDirty: false, lineCount: 40 };
        assert.deepEqual(provider.provideCodeLenses(document).map((lens) => [lens.range.start.line, lens.command.title]), [
            [2, '$(warning) CCN 18 > 10 · NLOC 22 · 7 params > 5'],
        ]);
        assert.match(provider.provideCodeLenses({ ...document, isDirty: true })[0].command.title, /out of date/);
        assert.deepEqual(provider.provideCodeLenses({ ...document, uri: vscode.Uri.file('/elsewhere/a.py') }), []);

        await vscode.workspace.getConfiguration('codeXR.problems.metrics').update('showInEditor', false);
        assert.deepEqual(provider.provideCodeLenses(document), []);
        context.subscriptions.forEach((item) => item.dispose());
    });
});

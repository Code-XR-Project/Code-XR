const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const {
    createFakeVscode,
    fakeExtensionContext,
    withFakeVscode,
    ExtensionMode,
} = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));

// Characterization of what ExecutePython returns, throws and reports for every
// analysis entry point (ROADMAP W4-T01..T06, hotspots-ts/CPLX-05/06). Each case
// runs the real class against a real child process: node stands in for the
// venv interpreter and each backend script is a node script that records its
// argv, then writes a fixed stdout and exits with a fixed code. What is pinned
// is the observable contract: the resolved value, the error message, the
// argv the backend received and the ordered progress.report() calls.

const MARKERS = (json) => `log line\n=== JSON_START ===\n${json}\n=== JSON_END ===\n`;

function writeScript(extensionPath, scriptName, stdout, exitCode) {
    const scriptPath = path.join(extensionPath, 'dist', 'code_analysis', 'python', ...scriptName.split('/'));
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    const argvFile = path.join(extensionPath, 'argv.json');
    fs.writeFileSync(scriptPath, [
        `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
        `process.stdout.write(${JSON.stringify(stdout)});`,
        `process.exitCode = ${exitCode};`,
    ].join('\n'));
}

/**
 * Runs `call(executor)` with a fake backend.
 * `backend` is `{ script, stdout, exitCode }`; `python` overrides the
 * interpreter path (undefined -> node).
 */
async function run(call, backend = {}, { python, silentConsole = true } = {}) {
    const extensionPath = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-exec-')));
    if (backend.script) {
        writeScript(extensionPath, backend.script, backend.stdout ?? '', backend.exitCode ?? 0);
    }
    const fake = createFakeVscode();
    const context = fakeExtensionContext({ extensionPath, extensionMode: ExtensionMode.Production });
    const silence = silentConsole ? muteConsole() : { restore() {} };
    try {
        return await withFakeVscode(fake, async ({ requireOut }) => {
            const { ExecutePython } = requireOut('core/analysis/python/executePython.js');
            const executor = new ExecutePython(context);
            const interpreter = typeof python === 'function' ? python(extensionPath) : process.execPath;
            executor.venvManager = { getPythonExecutablePath: () => interpreter };
            let outcome;
            try {
                outcome = { result: await call(executor, extensionPath) };
            } catch (error) {
                outcome = { error: error instanceof Error ? error.message : String(error) };
            }
            const argvFile = path.join(extensionPath, 'argv.json');
            const argv = fs.existsSync(argvFile) ? JSON.parse(fs.readFileSync(argvFile, 'utf8')) : undefined;
            return {
                ...outcome,
                argv: argv && argv.map((arg) => arg.split(extensionPath).join('<ext>')),
                reports: fake.progressReports.map((entry) => entry.report),
                titles: [...new Set(fake.progressReports.map((entry) => entry.title))],
            };
        });
    } finally {
        silence.restore();
        context.cleanup();
        fs.rmSync(extensionPath, { recursive: true, force: true });
    }
}

function muteConsole() {
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    return { restore: () => Object.assign(console, original) };
}

const session = (analysisMode, targetType, extra = {}) => (executor, extensionPath) => executor.executeAnalysis({
    analysisMode,
    targetType,
    targetPath: path.join(extensionPath, 'target'),
    ...extra,
}, extra.options);

const MAIN = 'main.py';

// ---------------------------------------------------------------- LivePanel

test('LivePanel file: argv, result between the markers, reports', async () => {
    const outcome = await run(session('LivePanel', 'file'), { script: MAIN, stdout: MARKERS('{"files":[1]}') });
    assert.deepEqual(outcome, {
        result: { files: [1] },
        argv: ['--mode', 'livePanel', '--type', 'file', '--target', '<ext>' + path.sep + 'target'],
        reports: [
            { increment: 0, message: 'Starting LivePanel analysis...' },
            { message: 'File analysis completed!' },
        ],
        titles: ['Code-XR Analysis'],
    });
});

test('LivePanel directory: --deep only when isDeep, the preparing report first', async () => {
    const shallow = await run(session('LivePanel', 'directory'), { script: MAIN, stdout: MARKERS('{"a":1}') });
    assert.deepEqual(shallow.argv, ['--mode', 'livePanel', '--type', 'directory', '--target', '<ext>' + path.sep + 'target']);
    assert.deepEqual(shallow.result, { a: 1 });
    assert.deepEqual(shallow.reports, [
        { increment: 0, message: 'Starting LivePanel analysis...' },
        { message: 'Preparing directory analysis...' },
        { message: 'Directory analysis completed!' },
    ]);

    const deep = await run(session('LivePanel', 'directory', { isDeep: true }), { script: MAIN, stdout: MARKERS('[]') });
    assert.deepEqual(deep.argv.slice(-1), ['--deep']);
    assert.deepEqual(deep.result, []);
});

test('LivePanel failures: success:false, null result, unparseable output, non-zero exit', async () => {
    const cases = [
        [MARKERS('{"success":false,"error":"boom"}'), 0, 'File analysis failed: boom'],
        [MARKERS('{"success":false}'), 0, 'File analysis failed: Unknown error'],
        [MARKERS('null'), 0, 'File analysis failed: Unknown error'],
        [MARKERS('0'), 0, 'File analysis failed: Unknown error'],
        ['not json at all', 0, 'File analysis failed: JSON markers not found in Python output'],
        ['', 0, 'File analysis failed: JSON markers not found in Python output'],
        [MARKERS('{}'), 4, 'File analysis failed: Python script failed with exit code 4'],
    ];
    for (const [stdout, exitCode, message] of cases) {
        const outcome = await run(session('LivePanel', 'file'), { script: MAIN, stdout, exitCode });
        assert.equal(outcome.error, message, JSON.stringify(stdout));
        assert.deepEqual(outcome.reports, [
            { increment: 0, message: 'Starting LivePanel analysis...' },
            { increment: 0, message: 'Analysis failed' },
        ]);
    }
    const directory = await run(session('LivePanel', 'directory'), { script: MAIN, stdout: MARKERS('{"success":false,"error":"x"}') });
    assert.equal(directory.error, 'Directory analysis failed: x');
});

test('parsePythonOutput: markers win, bare JSON is the fallback, invalid JSON inside markers is a SyntaxError', async () => {
    const bare = await run(session('LivePanel', 'file'), { script: MAIN, stdout: '  \n{"bare":true}\n ' });
    assert.deepEqual(bare.result, { bare: true });

    const both = await run(session('LivePanel', 'file'), { script: MAIN, stdout: '{"outside":1}\n' + MARKERS('{"inside":1}') });
    assert.deepEqual(both.result, { inside: 1 });

    const broken = await run(session('LivePanel', 'file'), { script: MAIN, stdout: MARKERS('{broken') });
    assert.match(broken.error, /^File analysis failed: /);
    assert.doesNotMatch(broken.error, /JSON markers not found/);

    // Only the start marker: the whole output is tried as JSON and fails.
    const half = await run(session('LivePanel', 'file'), { script: MAIN, stdout: '=== JSON_START ===\n{"a":1}\n' });
    assert.equal(half.error, 'File analysis failed: JSON markers not found in Python output');
});

test('silent analyses report nothing and never open a progress notification', async () => {
    const outcome = await run(session('LivePanel', 'file', { options: { silent: true } }), { script: MAIN, stdout: MARKERS('{"ok":1}') });
    assert.deepEqual(outcome.result, { ok: 1 });
    assert.deepEqual(outcome.reports, []);
});

// ---------------------------------------------------------------------- XR

test('XR file and directory: argv and reports on the success path', async () => {
    const file = await run(session('XR', 'file'), { script: MAIN, stdout: MARKERS('[{"functionName":"f"}]') });
    assert.deepEqual(file, {
        result: [{ functionName: 'f' }],
        argv: ['--mode', 'xr', '--type', 'file', '--target', '<ext>' + path.sep + 'target'],
        reports: [
            { increment: 0, message: 'Starting XR analysis...' },
            { message: 'Starting XR analysis...' },
            { message: 'XR analysis completed!' },
        ],
        titles: ['Code-XR Analysis'],
    });

    const directory = await run(session('XR', 'directory'), { script: MAIN, stdout: MARKERS('{"files":[]}') });
    assert.deepEqual(directory.argv, ['--mode', 'xr', '--type', 'directory', '--target', '<ext>' + path.sep + 'target']);
    assert.deepEqual(directory.result, { files: [] });
    assert.deepEqual(directory.reports, [
        { increment: 0, message: 'Starting XR analysis...' },
        { message: 'Preparing XR directory analysis...' },
        { message: 'Starting XR analysis...' },
        { message: 'XR analysis completed!' },
    ]);

    const deep = await run(session('XR', 'directory', { isDeep: true }), { script: MAIN, stdout: MARKERS('[]') });
    assert.deepEqual(deep.argv.slice(-1), ['--deep']);
    assert.deepEqual(deep.reports.map((report) => report.message), [
        'Starting XR analysis...',
        'Preparing deep XR analysis...',
        'Starting XR analysis...',
        'XR analysis completed!',
    ]);

    // isDeep on a file target adds nothing.
    const deepFile = await run(session('XR', 'file', { isDeep: true }), { script: MAIN, stdout: MARKERS('[]') });
    assert.equal(deepFile.argv.includes('--deep'), false);
});

test('XR failures: the "unable to parse" message whenever stdout is non-empty but has no parseable JSON', async () => {
    const cases = [
        ['not json', 0, 'XR analysis failed: Unable to parse result - JSON markers not found in Python output'],
        ['  \n ', 0, 'XR analysis failed: Unable to parse result - JSON markers not found in Python output'],
        ['=== JSON_START ===\n[1]\n', 0, 'XR analysis failed: Unable to parse result - JSON markers not found in Python output'],
        // Empty stdout carries an empty rawOutput, so it takes the generic message.
        ['', 0, 'XR analysis failed: JSON markers not found in Python output'],
        [MARKERS('{"success":false,"error":"boom"}'), 0, 'XR analysis failed: boom'],
        [MARKERS('null'), 0, 'XR analysis failed: Unknown error'],
        [MARKERS('false'), 0, 'XR analysis failed: Unknown error'],
        [MARKERS('[]'), 2, 'XR analysis failed: Python script failed with exit code 2'],
    ];
    for (const [stdout, exitCode, message] of cases) {
        const outcome = await run(session('XR', 'file'), { script: MAIN, stdout, exitCode });
        assert.equal(outcome.error, message, JSON.stringify(stdout));
        assert.deepEqual(outcome.reports, [
            { increment: 0, message: 'Starting XR analysis...' },
            { message: 'Starting XR analysis...' },
            { increment: 0, message: 'Analysis failed' },
        ], JSON.stringify(stdout));
    }

    const broken = await run(session('XR', 'file'), { script: MAIN, stdout: MARKERS('{broken') });
    assert.match(broken.error, /^XR analysis failed: /);
    assert.doesNotMatch(broken.error, /Unable to parse result|JSON markers not found/);
});

test('XR: a bare-JSON stdout and a non-array object both resolve as they are', async () => {
    const bare = await run(session('XR', 'file'), { script: MAIN, stdout: '[{"functionName":"g"}]' });
    assert.deepEqual(bare.result, [{ functionName: 'g' }]);
    const object = await run(session('XR', 'file'), { script: MAIN, stdout: MARKERS('{"success":true,"x":1}') });
    assert.deepEqual(object.result, { success: true, x: 1 });
});

// --------------------------------------------------------------- DOM / misc

test('VisualizeDOM file: the target is the only argument; an error field fails the run', async () => {
    const script = 'html/html_dom_parser.py';
    const ok = await run(session('VisualizeDOM', 'file'), { script, stdout: MARKERS('{"htmlContent":"<p>"}') });
    assert.deepEqual(ok.argv, ['<ext>' + path.sep + 'target']);
    assert.deepEqual(ok.result, { htmlContent: '<p>' });
    assert.deepEqual(ok.reports, [
        { increment: 0, message: 'Starting VisualizeDOM analysis...' },
        { message: 'Parsing HTML DOM...' },
        { message: 'HTML DOM analysis completed!' },
    ]);

    const failed = await run(session('VisualizeDOM', 'file'), { script, stdout: MARKERS('{"error":"bad html"}') });
    assert.equal(failed.error, 'HTML DOM analysis failed: bad html');
    const nothing = await run(session('VisualizeDOM', 'file'), { script, stdout: MARKERS('null') });
    assert.equal(nothing.error, 'HTML DOM analysis failed: Unknown error');
    // success:false without an error field is NOT a failure here.
    const flagged = await run(session('VisualizeDOM', 'file'), { script, stdout: MARKERS('{"success":false}') });
    assert.deepEqual(flagged.result, { success: false });
});

test('unknown mode/target combinations throw before spawning', async () => {
    const outcome = await run(session('VisualizeDOM', 'directory'));
    assert.equal(outcome.error, 'Unknown analysis combination: VisualizeDOM + directory');
    assert.deepEqual(outcome.reports, [
        { increment: 0, message: 'Starting VisualizeDOM analysis...' },
        { increment: 0, message: 'Analysis failed' },
    ]);
    const unknown = await run(session('Other', 'file'));
    assert.equal(unknown.error, 'Unknown analysis combination: Other + file');
});

test('file re-analysis wraps a single object, keeps arrays, and throws on success:false', async () => {
    const script = 'summaryFiles/file_reanalysis_coordinator.py';
    const call = (executor) => executor.executeFileReanalysis(['a.py', 'b.py']);
    const array = await run(call, { script, stdout: MARKERS('[{"f":1}]') });
    assert.deepEqual(array.argv, ['a.py', 'b.py']);
    assert.deepEqual(array.result, [{ f: 1 }]);
    assert.deepEqual(array.reports, []);
    assert.deepEqual((await run(call, { script, stdout: MARKERS('{"f":2}') })).result, [{ f: 2 }]);
    assert.equal((await run(call, { script, stdout: MARKERS('{"success":false,"error":"e"}') })).error, 'File re-analysis failed: e');
    assert.equal((await run(call, { script, stdout: MARKERS('null') })).error, 'File re-analysis failed: Unknown error');
    assert.equal((await run(call, { script, stdout: 'x', exitCode: 1 })).error, 'File re-analysis failed: Python script failed with exit code 1');
});

test('schema and dependency entry points return the raw outcome, failures included', async () => {
    const schema = await run((executor) => executor.executeXRFieldSchema('directory'), { script: MAIN, stdout: MARKERS('{"fields":[]}') });
    assert.deepEqual(schema.argv, ['--mode', 'schema', '--type', 'directory']);
    assert.deepEqual(schema.result, { fields: [] });

    const deps = await run(
        (executor) => executor.executeDependencyAnalysis('T', 'directory', true, 'C', 'R', 'P'),
        { script: MAIN, stdout: 'garbage' },
    );
    assert.deepEqual(deps.argv, ['--mode', 'dependencies', '--type', 'directory', '--target', 'T', '--deep', '--cache', 'C', '--dependency-refresh', 'R', '--project-root', 'P']);
    assert.deepEqual(deps.result, { success: false, error: 'JSON markers not found in Python output', rawOutput: 'garbage' });

    const minimal = await run(
        (executor) => executor.executeDependencyAnalysis('T', 'file', false),
        { script: MAIN, stdout: 'err', exitCode: 3 },
    );
    assert.deepEqual(minimal.argv, ['--mode', 'dependencies', '--type', 'file', '--target', 'T']);
    assert.deepEqual(minimal.result, { success: false, error: 'Python script failed with exit code 3', stderr: '', stdout: 'err' });
});

test('interpreter and script resolution failures', async () => {
    const call = (executor) => executor.executeXRFieldSchema('file');

    const noPython = await run(call, { script: MAIN }, { python: () => undefined });
    assert.equal(noPython.error, 'Python executable not found in virtual environment');

    const missingPython = await run(call, { script: MAIN }, { python: (ext) => path.join(ext, 'no-python') });
    assert.match(missingPython.error, /^Python executable does not exist: .*no-python$/);

    const noScript = await run(call, {});
    assert.match(noScript.error, /^Python script does not exist: .*main\.py$/);

    // An interpreter path that exists but cannot be spawned resolves a failure object.
    const unspawnable = await run(call, { script: MAIN }, { python: (ext) => path.join(ext, 'dist') });
    assert.equal(unspawnable.result.success, false);
    assert.match(unspawnable.result.error, /^Failed to start Python process: Error: spawn /);
    assert.equal(unspawnable.result.rawOutput, '');
});

test('precondition of the collapsed XR recovery: stdout that fails trimmed cannot parse untrimmed', async () => {
    // parsePythonOutput parses stdout.trim(); the old XR recovery re-parsed the
    // untrimmed stdout. JSON.parse tolerates only JSON whitespace around a value
    // and trim() strips a superset of it, so the second parse can never succeed.
    const samples = ['', ' ', '\n\t\r ', 'x', '[1', '﻿[1', ' {"a":1} ', '\v1', '=== JSON_START ===\n[1]'];
    for (const sample of samples) {
        let trimmedParses = true;
        try { JSON.parse(sample.trim()); } catch { trimmedParses = false; }
        if (!trimmedParses) {
            assert.throws(() => JSON.parse(sample), SyntaxError, JSON.stringify(sample));
        }
    }
    // Wrappers that trim() removes but JSON.parse would reject resolve through the first parse.
    const bom = await run(session('XR', 'file'), { script: MAIN, stdout: '﻿[{"functionName":"h"}] ' });
    assert.deepEqual(bom.result, [{ functionName: 'h' }]);
});

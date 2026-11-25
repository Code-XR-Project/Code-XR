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

// Characterization of how ExecutePython reads the Python backend's stderr
// (ROADMAP W4-L03, hotspots-ts/CPLX-02). The backend reports progress as one
// JSON object per stderr line; anything else is free text. What reaches the
// user is the sequence of progress.report() calls on the analysis
// notification, so that is what this pins, end to end, through the real
// executeAnalysis -> executePythonScript path and a real child process.
//
// The "Python executable" is node itself and main.py is a node script that
// replays a fixed stderr transcript, then prints a result between the JSON
// markers on stdout.

const STDERR_TRANSCRIPT = [
    // progress with total > 0: a report with an increment of 100/total
    '{"progress":{"current":1,"total":4,"percentage":25,"fileName":"src/pkg/a.py","message":"Analyzing","operation":"lizard","estimatedTime":"3s"}}',
    // the fileName fallbacks (file, then current_file) and a name without '/'
    '{"progress":{"current":2,"total":4,"percentage":50,"file":"b.py"}}',
    '{"progress":{"current":3,"total":4,"percentage":75,"current_file":"dir/c.py"}}',
    // percentage 0 -> increment 0; a Windows path is not split on '\\'
    '{"progress":{"current":0,"total":4,"percentage":0,"fileName":"C:\\\\x\\\\d.py"}}',
    // total 0 -> no report at all
    '{"progress":{"current":1,"total":0,"percentage":10,"fileName":"e.py"}}',
    // info reports its text; debug, warning and error report nothing
    '{"info":"Loading metrics"}',
    '{"debug":"internal detail"}',
    '{"warning":"slow file"}',
    '{"error":"bad file"}',
    // JSON without a known key, and JSON scalars: nothing
    '{"other":1}',
    '42',
    // `null` parses, then `null.progress` throws: it is treated as free text
    'null',
    // free text: "Analyzing"/"Processing" and "Progress:"/"%" report the line
    'Analyzing module x',
    'Processing batch 2',
    'Progress: 3 of 9',
    'done 50%',
    // other free text reports nothing
    'Traceback ERROR here',
    'Warning: deprecated',
    'plain chatter',
    // blank and whitespace-only lines are skipped
    '',
    '   ',
];

const EXPECTED_REPORTS = [
    { increment: 0, message: 'Starting LivePanel analysis...' },
    { message: '1/4 (25%) - a.py', increment: 25 },
    { message: '2/4 (50%) - b.py', increment: 25 },
    { message: '3/4 (75%) - c.py', increment: 25 },
    { message: '0/4 (0%) - C:\\x\\d.py', increment: 0 },
    { message: 'Loading metrics' },
    { message: 'Analyzing module x' },
    { message: 'Processing batch 2' },
    { message: 'Progress: 3 of 9' },
    { message: 'done 50%' },
    { message: 'File analysis completed!' },
];

function writeFakeBackend(extensionPath, stderrLines, exitCode) {
    const scriptDirectory = path.join(extensionPath, 'dist', 'code_analysis', 'python');
    fs.mkdirSync(scriptDirectory, { recursive: true });
    const script = [
        `const lines = ${JSON.stringify(stderrLines)};`,
        "process.stderr.write(lines.join('\\n') + '\\n');",
        "process.stdout.write('noise\\n=== JSON_START ===\\n' + JSON.stringify({ files: [1, 2], summary: {} }) + '\\n=== JSON_END ===\\n');",
        `process.exitCode = ${exitCode};`,
    ].join('\n');
    fs.writeFileSync(path.join(scriptDirectory, 'main.py'), script);
}

async function runFileAnalysis(stderrLines, exitCode = 0) {
    const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-stderr-'));
    writeFakeBackend(extensionPath, stderrLines, exitCode);
    const fake = createFakeVscode();
    const context = fakeExtensionContext({ extensionPath, extensionMode: ExtensionMode.Production });
    const silence = muteConsole();
    try {
        return await withFakeVscode(fake, async ({ requireOut }) => {
            const { ExecutePython } = requireOut('core/analysis/python/executePython.js');
            const executor = new ExecutePython(context);
            // The venv is not under test: node stands in for its interpreter.
            executor.venvManager = { getPythonExecutablePath: () => process.execPath };
            let outcome;
            try {
                outcome = { result: await executor.executeAnalysis({
                    analysisMode: 'LivePanel',
                    targetType: 'file',
                    targetPath: path.join(extensionPath, 'target.py'),
                }) };
            } catch (error) {
                outcome = { error };
            }
            return { ...outcome, reports: fake.progressReports.map((entry) => entry.report) };
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

test('stderr progress, info and free-text lines become notification reports, in order; the rest reports nothing', async () => {
    const { result, error, reports } = await runFileAnalysis(STDERR_TRANSCRIPT);

    assert.equal(error, undefined);
    assert.deepEqual(result, { files: [1, 2], summary: {} }, 'stdout between the markers is the result');
    assert.deepEqual(reports, EXPECTED_REPORTS);
});

test('stderr is split on newlines inside one chunk, and a non-zero exit still reports the lines it read', async () => {
    const { error, reports } = await runFileAnalysis(['Analyzing one\nAnalyzing two', '{"info":"three"}'], 3);

    assert.match(String(error && error.message), /File analysis failed: Python script failed with exit code 3/);
    assert.deepEqual(reports.map((report) => report.message), [
        'Starting LivePanel analysis...',
        'Analyzing one',
        'Analyzing two',
        'three',
        'Analysis failed',
    ]);
});

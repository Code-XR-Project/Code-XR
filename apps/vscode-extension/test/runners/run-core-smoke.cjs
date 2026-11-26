'use strict';

/**
 * #13 acceptance criterion: "a minimal script (no VS Code) runs one analysis
 * through the core with a stub host".
 *
 * Loads the compiled core from out/ (npm run compile-tests) with `vscode` made
 * unresolvable, registers a stub CodeXRHost, and runs a LivePanel file
 * analysis of a backend fixture through ExecutePython, the same class the
 * extension uses. The interpreter is the venv `npm run test:analysis` builds
 * (backend/artifacts/analysis-test-venv), linked into a throwaway global
 * storage where VenvManager looks for its environment. Nothing is downloaded.
 *
 *   node apps/vscode-extension/test/runners/run-core-smoke.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');

const projectRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(projectRoot, '..', '..');
const out = (...parts) => path.join(projectRoot, 'out', ...parts);
const isWindows = process.platform === 'win32';
const analysisVenv = path.join(repoRoot, 'backend', 'artifacts', 'analysis-test-venv');
const fixture = path.join(repoRoot, 'backend', 'manual_test', 'python_metrics.py');

// 1. The core must load without VS Code: any require('vscode') fails loudly.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') {
        throw new Error(`The core required 'vscode' (from ${rest[0] && rest[0].filename}). #13 requires a vscode-free core.`);
    }
    return originalResolve.call(this, request, ...rest);
};

function fail(message) {
    console.error(`core smoke: ${message}`);
    process.exit(1);
}

if (!fs.existsSync(out('core', 'host', 'hostRegistry.js'))) {
    fail('out/ is missing. Run `npm run compile-tests` first.');
}
const venvPython = path.join(analysisVenv, isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python');
if (!fs.existsSync(venvPython)) {
    fail('no analysis venv. Run `npm run test:analysis` first (it builds backend/artifacts/analysis-test-venv).');
}

// 2. A throwaway global storage, with the venv where VenvManager expects it.
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-core-smoke-'));
fs.mkdirSync(path.join(storage, 'python-env'), { recursive: true });
fs.symlinkSync(analysisVenv, path.join(storage, 'python-env', 'venv'), isWindows ? 'junction' : 'dir');

// 3. A stub host: no UI, never answers a consent question, records notifications.
const state = new Map();
const notifications = [];
const globalState = {
    get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
    update: async (key, value) => { state.set(key, value); },
};
const stubHost = {
    paths: { installRoot: projectRoot, globalStorageDir: storage, workspaceStorageDir: undefined, mode: 'development' },
    globalState,
    notifier: {
        notify: async (severity, message) => { notifications.push([severity, message]); return undefined; },
        confirm: async () => undefined,
        status: () => ({ dispose() {} }),
        createStatusIndicator: () => ({ text: '', show() {}, hide() {}, dispose() {} }),
    },
    withProgress: (_options, task) => task(
        { report() {} },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    ),
    prompt: async () => undefined,
    clipboardWrite: async () => {},
    openExternal: async () => false,
    workspaceFolders: () => [],
    signal: () => {},
};

async function main() {
    require(out('core', 'host', 'hostRegistry.js')).initializeHost(stubHost);
    const { ExecutePython } = require(out('core', 'analysis', 'python', 'executePython.js'));
    const { EXTENSION_MODE } = require(out('core', 'host', 'hostPaths.js'));

    // What the core reads from its start-up context (CoreContext); development
    // mode runs the backend from <repo>/backend/src, as F5 does.
    const context = {
        extensionPath: projectRoot,
        extensionMode: EXTENSION_MODE.Development,
        globalStorageUri: { fsPath: storage },
        storageUri: undefined,
        globalState,
    };
    const session = { analysisMode: 'LivePanel', targetType: 'file', targetPath: fixture };

    // Not silent on purpose: the run goes through host.withProgress.
    const result = await new ExecutePython(context).executeAnalysis(session);

    assert.ok(result && typeof result === 'object', 'the analysis returned no object');
    const text = JSON.stringify(result);
    assert.ok(text.includes('python_metrics.py'), 'the result does not name the analysed file');
    assert.match(text, /complexity/i, 'the result carries no complexity metric');
    assert.deepEqual(notifications.filter(([severity]) => severity === 'error'), [], 'the core reported an error');

    const loadedCore = Object.keys(require.cache).filter((file) => file.startsWith(out('core'))).length;
    console.log(`core smoke: OK. LivePanel analysis of ${path.basename(fixture)} through ${loadedCore} core modules, no vscode, stub host.`);
}

main()
    .catch((error) => fail(error && error.stack ? error.stack : String(error)))
    .finally(() => fs.rmSync(storage, { recursive: true, force: true }));

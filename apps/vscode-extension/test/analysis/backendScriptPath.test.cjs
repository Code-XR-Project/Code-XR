const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFakeVscode, withFakeVscode, ExtensionMode } = require('../helpers/fakeVscode.cjs');

/**
 * executePython and the Git export resolve Python backend scripts through
 * backendScriptPath. Before the monorepo move the development fallback sat
 * inside the extension folder; now it is <extensionPath>/../../backend/src. In
 * an installed extension (~/.vscode/extensions/<id>-<version>) that is the
 * user's HOME, so outside ExtensionMode.Development a missing dist copy must
 * resolve to the dist path itself (and fail as "not found"), never to a file
 * outside the extension.
 */

const SCRIPT = 'main.py';
const WORKER = path.join('export', 'git_export_analysis_worker.py');

function makeInstalledLayout() {
    // <home>/.vscode/extensions/amontesl.code-xr-9.9.9 with a planted
    // <home>/backend/src/main.py: exactly what ../.. would reach.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-backend-path-'));
    const extensionPath = path.join(home, '.vscode', 'extensions', 'amontesl.code-xr-9.9.9');
    fs.mkdirSync(extensionPath, { recursive: true });
    const planted = path.join(home, 'backend', 'src');
    fs.mkdirSync(path.join(planted, 'export'), { recursive: true });
    fs.writeFileSync(path.join(planted, SCRIPT), '# planted\n');
    fs.writeFileSync(path.join(planted, WORKER), '# planted\n');
    return { home, extensionPath };
}

// Since #13 step 2 the helper takes host paths; callers holding an
// ExtensionContext convert it with hostPathsFromContext, as here.
function hostPaths(extensionPath, extensionMode) {
    const { hostPathsFromContext } = require('../../out/core/host/hostPaths.js');
    const storage = { fsPath: path.join(os.tmpdir(), 'codexr-unused-storage') };
    return hostPathsFromContext({ extensionPath, extensionMode, globalStorageUri: storage, storageUri: storage });
}

function withHelper(callback) {
    return withFakeVscode(createFakeVscode(), ({ requireOut }) =>
        callback(requireOut('core/host/backendScriptPath.js')));
}

test('the shipped dist copy wins in every mode', () => {
    withHelper(({ resolveBackendScriptPath }) => {
        const extensionPath = path.join(os.tmpdir(), 'codexr-ext');
        const distPath = path.join(extensionPath, 'dist', 'code_analysis', 'python', SCRIPT);
        for (const mode of [ExtensionMode.Production, ExtensionMode.Development, ExtensionMode.Test]) {
            const resolved = resolveBackendScriptPath(hostPaths(extensionPath, mode), SCRIPT, (candidate) => candidate === distPath);
            assert.equal(resolved, distPath);
        }
    });
});

test('outside Development a missing dist copy never resolves outside the extension', () => {
    const { home, extensionPath } = makeInstalledLayout();
    try {
        withHelper(({ resolveBackendScriptPath, getBackendScriptCandidates }) => {
            for (const mode of [ExtensionMode.Production, ExtensionMode.Test]) {
                for (const script of [SCRIPT, WORKER]) {
                    const context = hostPaths(extensionPath, mode);
                    const resolved = resolveBackendScriptPath(context, script);
                    assert.equal(resolved, path.join(extensionPath, 'dist', 'code_analysis', 'python', script));
                    assert.ok(resolved.startsWith(extensionPath + path.sep), `${resolved} escapes ${extensionPath}`);
                    assert.equal(getBackendScriptCandidates(context, script).developmentPath, undefined);
                }
            }
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('in Development a missing dist copy falls back to <repo>/backend/src', () => {
    withHelper(({ resolveBackendScriptPath }) => {
        const repo = path.join(os.tmpdir(), 'codexr-repo');
        const extensionPath = path.join(repo, 'apps', 'vscode-extension');
        const context = hostPaths(extensionPath, ExtensionMode.Development);
        assert.equal(
            resolveBackendScriptPath(context, WORKER, () => false),
            path.join(repo, 'backend', 'src', WORKER),
        );
    });
});

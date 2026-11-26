'use strict';

// #13 step 2: the vscode-free bridge from an ExtensionContext to HostPaths,
// and the single privateStorageRoot rule that replaced five copies.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ExtensionMode } = require('../helpers/fakeVscode.cjs');
const { measure } = require('../tooling/folderDependencies.cjs');

const out = path.join(__dirname, '..', '..', 'out', 'core', 'host', 'hostPaths.js');
const {
    EXTENSION_MODE,
    hostModeFromExtensionMode,
    hostPathsFromContext,
    privateStorageRoot,
} = require(out);

// The modules #13 step 2 moved off vscode: each must stay that way.
const MIGRATED = [
    'core/host/hostPaths.ts',
    'core/host/backendScriptPath.ts',
    'core/charts/settings/settingsFile.ts',
    'core/server/generatedHttpsCertificateManager.ts',
    'core/python-env/pythonEnvStorage.ts',
    'core/analysis/utils/themeUtils.ts',
    // step 5: the visualization settings read globalState through GlobalStateContext
    'core/charts/settings/settingsStorage.ts',
    'core/charts/settings/settingsAccessors.ts',
    'core/charts/getVisualizationConfiguration.ts',
    // step 6: consent and progress through the host, storage through GlobalStateContext
    'core/remote-access/cloudflaredBinaryManager.ts',
    'core/python-env/venvManager.ts',
    'core/python-env/pythonEnvUiState.ts',
];

test('the modules migrated in #13 steps 2, 5 and 6 never reach vscode', () => {
    const free = new Set(measure().vscodeFree);
    for (const file of MIGRATED) {
        assert.ok(free.has(file), `${file} reaches vscode`);
    }
});

test('EXTENSION_MODE matches vscode.ExtensionMode in the installed typings', () => {
    const typings = fs.readFileSync(require.resolve('@types/vscode/index.d.ts'), 'utf8');
    const block = typings.slice(typings.indexOf('export enum ExtensionMode'));
    for (const [name, value] of Object.entries(EXTENSION_MODE)) {
        assert.match(block.slice(0, 1500), new RegExp(`\\b${name} = ${value},`), `${name} = ${value}`);
    }
    assert.deepEqual({ ...EXTENSION_MODE }, { ...ExtensionMode }, 'the fake agrees too');
});

test('every ExtensionMode maps to a host mode, unknown values to production', () => {
    assert.equal(hostModeFromExtensionMode(EXTENSION_MODE.Production), 'production');
    assert.equal(hostModeFromExtensionMode(EXTENSION_MODE.Development), 'development');
    assert.equal(hostModeFromExtensionMode(EXTENSION_MODE.Test), 'test');
    assert.equal(hostModeFromExtensionMode(99), 'production');
});

test('hostPathsFromContext reads the four context fields as plain strings', () => {
    const paths = hostPathsFromContext({
        extensionPath: '/ext',
        extensionMode: EXTENSION_MODE.Development,
        globalStorageUri: { fsPath: '/global' },
        storageUri: { fsPath: '/workspace' },
    });
    assert.deepEqual(paths, { installRoot: '/ext', globalStorageDir: '/global', workspaceStorageDir: '/workspace', mode: 'development' });
    const noFolder = hostPathsFromContext({ extensionPath: '/ext', extensionMode: 1, globalStorageUri: { fsPath: '/global' } });
    assert.equal(noFolder.workspaceStorageDir, undefined);
});

test('privateStorageRoot keeps the old `storageUri?.fsPath || globalStorageUri.fsPath` rule exactly', () => {
    // The five call sites it replaced, written out as they were.
    const old = (context) => context.storageUri?.fsPath || context.globalStorageUri.fsPath;
    const cases = [
        { globalStorageUri: { fsPath: '/global' }, storageUri: { fsPath: '/workspace' } },
        { globalStorageUri: { fsPath: '/global' }, storageUri: undefined },
        { globalStorageUri: { fsPath: '/global' } },
        // An empty fsPath falls back too: `||`, not `??`.
        { globalStorageUri: { fsPath: '/global' }, storageUri: { fsPath: '' } },
    ];
    for (const context of cases) {
        const paths = hostPathsFromContext({ extensionPath: '/ext', extensionMode: 1, ...context });
        assert.equal(privateStorageRoot(paths), old(context));
    }
});

test('no core file computes the private storage root by hand any more', () => {
    const src = path.join(__dirname, '..', '..', 'src');
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.ts') && /storageUri\?\.fsPath \|\| [\w.]*globalStorageUri\.fsPath/.test(fs.readFileSync(full, 'utf8'))) {
                offenders.push(path.relative(src, full));
            }
        }
    };
    walk(src);
    const canary = fs.readFileSync(path.join(src, 'core', 'host', 'hostPaths.ts'), 'utf8');
    assert.match(canary, /storageUri\?\.fsPath \|\| context\.globalStorageUri\.fsPath/, 'canary: the pattern still matches the documented original');
    assert.deepEqual(offenders.filter((file) => file !== path.join('core', 'host', 'hostPaths.ts')), []);
});

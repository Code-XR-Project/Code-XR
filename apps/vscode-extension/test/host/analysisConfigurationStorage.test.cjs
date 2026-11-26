'use strict';

// #13 step 8: the analysis configuration is read and written with Node fs
// instead of vscode.workspace.fs. Same folder, same file name, same JSON
// shape, so a configuration saved by an earlier version is still read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { measure } = require('../tooling/folderDependencies.cjs');

const compiled = path.join(__dirname, '..', '..', 'out', 'core', 'analysis', 'configuration', 'analysisConfigurationStorage.js');

function freshStorage(globalStorageDir) {
    delete require.cache[compiled];
    const { AnalysisConfigurationStorage } = require(compiled);
    return AnalysisConfigurationStorage.initialize({ globalStorageUri: { fsPath: globalStorageDir } });
}

function withTempDir(callback) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-config-storage-'));
    return Promise.resolve(callback(dir)).finally(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        delete require.cache[compiled];
    });
}

test('the configuration storage never reaches vscode', () => {
    assert.ok(new Set(measure().vscodeFree).has('core/analysis/configuration/analysisConfigurationStorage.ts'));
});

test('with no file, defaults are returned and written to <globalStorage>/codexr_analysis/configuration_analysis.json', () => withTempDir(async (dir) => {
    const storage = freshStorage(dir);
    assert.equal(await storage.configurationExists(), false);
    const config = await storage.loadConfiguration();
    const file = path.join(dir, 'codexr_analysis', 'configuration_analysis.json');
    assert.equal(storage.getConfigurationFilePath(), file);
    assert.equal(await storage.configurationExists(), true);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.metadata.version, '1.0.0');
    assert.deepEqual(written.configuration, JSON.parse(JSON.stringify(config)), 'the defaults, as JSON keeps them');
}));

test('a file written by an earlier version is read and merged over the defaults', () => withTempDir(async (dir) => {
    const first = freshStorage(dir);
    const defaults = await first.loadConfiguration();
    const file = first.getConfigurationFilePath();
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = Object.keys(defaults).find((name) => typeof defaults[name] === 'string');
    assert.ok(key, 'canary: the defaults have a string setting to change');
    stored.configuration[key] = `${defaults[key]}-changed`;
    fs.writeFileSync(file, JSON.stringify(stored), 'utf8');

    const second = freshStorage(dir);
    const loaded = await second.loadConfiguration();
    assert.equal(loaded[key], `${defaults[key]}-changed`);
    assert.equal(await second.debugGetConfigurationFileContent(), JSON.stringify(stored));
}));

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const executePythonSource = fs.readFileSync(path.join(projectRoot, 'src', 'core', 'analysis', 'python', 'executePython.ts'), 'utf8');
// executePython and the Git export resolve backend scripts through this helper.
const backendScriptPathSource = fs.readFileSync(path.join(projectRoot, 'src', 'core', 'analysis', 'python', 'backendScriptPath.ts'), 'utf8');
const pythonPathSources = executePythonSource + backendScriptPathSource;
const webpackConfigSource = fs.readFileSync(path.join(projectRoot, 'webpack.config.js'), 'utf8');

test('executePython resolves runtime scripts from code_analysis paths', () => {
    assert.match(executePythonSource, /resolveBackendScriptPath\(this\.context, scriptName\)/);
    assert.match(pythonPathSources, /'dist', 'code_analysis', 'python'/);
    // Development fallback: the backend sources live at <repo>/backend/src.
    assert.match(pythonPathSources, /'\.\.', '\.\.', 'backend', 'src'/);
    assert.equal(pythonPathSources.includes("'dist', 'analysis', 'python'"), false);
    assert.equal(pythonPathSources.includes("'src', 'analysis', 'python'"), false);
});

test('webpack copies Python assets from <repo>/backend/src into dist/code_analysis/python', () => {
    assert.match(webpackConfigSource, /context: path\.resolve\(__dirname, '\.\.', '\.\.', 'backend'\),\s*from: 'src',/);
    assert.match(webpackConfigSource, /to: 'code_analysis\/python'/);
    assert.equal(webpackConfigSource.includes('src/analysis/python'), false);
});

test('Python analysis uses the Lizard analyzer directly', () => {
    const fileEngineSource = fs.readFileSync(
        path.join(projectRoot, '..', '..', 'backend', 'src', 'utils', 'file_analysis_engine.py'),
        'utf8',
    );
    assert.match(fileEngineSource, /from lizard_analyzer import analyze_file as analyze_with_lizard/);
    assert.match(fileEngineSource, /lizard_data = analyze_with_lizard\(file_path\)/);
});

test('analysis configuration uses the active storage module and no legacy storage shims', () => {
    const legacyStoragePath = path.join(projectRoot, 'src', 'utils', 'analysisSettingsStorage.ts');
    const emptyStoragePath = path.join(projectRoot, 'src', 'core', 'analysis', 'storage');
    const activeStoragePath = path.join(projectRoot, 'src', 'core', 'analysis', 'configuration', 'analysisConfigurationStorage.ts');

    assert.equal(fs.existsSync(legacyStoragePath), false);
    assert.equal(fs.existsSync(emptyStoragePath), false);
    assert.ok(fs.existsSync(activeStoragePath));
});

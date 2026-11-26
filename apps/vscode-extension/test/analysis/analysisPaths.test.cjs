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
    assert.match(executePythonSource, /const paths = hostPathsFromContext\(this\.context\);/);
    assert.match(executePythonSource, /resolveBackendScriptPath\(paths, scriptName\)/);
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

test('Python analysis uses Code-XR\'s own metrics analyzer, not lizard', () => {
    const backendSrc = path.join(projectRoot, '..', '..', 'backend', 'src');
    const fileEngineSource = fs.readFileSync(path.join(backendSrc, 'utils', 'file_analysis_engine.py'), 'utf8');
    assert.match(fileEngineSource, /from code_metrics_analyzer import analyze_file as analyze_function_metrics/);
    assert.match(fileEngineSource, /metrics_data = analyze_function_metrics\(file_path\)/);

    const importsLizard = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.py') && /^\s*(import|from)\s+lizard\b/m.test(fs.readFileSync(full, 'utf8'))) {
                importsLizard.push(path.relative(backendSrc, full));
            }
        }
    };
    walk(backendSrc);
    assert.deepEqual(importsLizard, [], 'the shipped backend must not import lizard (epic #140)');
});

test('analysis configuration uses the active storage module and no legacy storage shims', () => {
    const legacyStoragePath = path.join(projectRoot, 'src', 'utils', 'analysisSettingsStorage.ts');
    const emptyStoragePath = path.join(projectRoot, 'src', 'core', 'analysis', 'storage');
    const activeStoragePath = path.join(projectRoot, 'src', 'core', 'analysis', 'configuration', 'analysisConfigurationStorage.ts');

    assert.equal(fs.existsSync(legacyStoragePath), false);
    assert.equal(fs.existsSync(emptyStoragePath), false);
    assert.ok(fs.existsSync(activeStoragePath));
});

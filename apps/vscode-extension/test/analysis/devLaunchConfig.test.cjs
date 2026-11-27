const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
// .vscode/ lives at the monorepo root, which is the folder developers open;
// the extension itself is the npm workspace at apps/vscode-extension.
const repoRoot = path.resolve(projectRoot, '..', '..');
const EXTENSION_DIR = 'apps/vscode-extension';

function readJson(...segments) {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, ...segments), 'utf8'));
}

function readRepoJson(...segments) {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, ...segments), 'utf8'));
}

test('default F5 launch uses an isolated extension development copy', () => {
    const launch = readRepoJson('.vscode', 'launch.json');
    const defaultConfig = launch.configurations.find(config => config.name === 'Run CodeXR Extension');

    assert.ok(defaultConfig);
    assert.deepEqual(defaultConfig.args, [
        '--extensionDevelopmentPath=${workspaceFolder}/apps/vscode-extension/.vscode-test/dev-extension',
        '--user-data-dir=${workspaceFolder}/apps/vscode-extension/.vscode-test/user-data',
        '--extensions-dir=${workspaceFolder}/apps/vscode-extension/.vscode-test/extensions',
    ]);
    assert.equal(defaultConfig.preLaunchTask, 'CodeXR: compile:dev-host');
    assert.deepEqual(defaultConfig.outFiles, [
        '${workspaceFolder}/apps/vscode-extension/.vscode-test/dev-extension/dist/**/*.js',
    ]);
});

test('development host task compiles and prepares the isolated extension copy', () => {
    const packageJson = readJson('package.json');
    const tasks = readRepoJson('.vscode', 'tasks.json');
    const task = tasks.tasks.find(item => item.label === 'CodeXR: compile:dev-host');

    assert.match(packageJson.scripts['compile:dev-host'], /npm run compile && node scripts\/prepare-dev-extension\.mjs/);
    assert.ok(task);
    assert.equal(task.type, 'npm');
    assert.equal(task.script, 'compile:dev-host');
    assert.equal(task.path, EXTENSION_DIR, 'the npm task must run inside the extension workspace');
    assert.deepEqual(task.problemMatcher, []);
});

test('workspace direct launch remains available as an explicit fallback', () => {
    const launch = readRepoJson('.vscode', 'launch.json');
    const directConfig = launch.configurations.find(config => config.name === 'Run CodeXR Extension (workspace direct)');

    assert.ok(directConfig);
    assert.deepEqual(directConfig.args, [
        '--extensionDevelopmentPath=${workspaceFolder}/apps/vscode-extension',
    ]);
    assert.equal(directConfig.preLaunchTask, 'CodeXR: compile');
});

test('debug launch tasks avoid generated npm labels that VS Code can fail to resolve', () => {
    const launch = readRepoJson('.vscode', 'launch.json');
    const tasks = readRepoJson('.vscode', 'tasks.json');
    const launchText = JSON.stringify(launch);
    const tasksText = JSON.stringify(tasks);

    assert.doesNotMatch(launchText, /npm: compile/);
    assert.doesNotMatch(tasksText, /"label":"npm: compile/);
    assert.ok(tasks.tasks.find(item => item.label === 'CodeXR: compile' && item.type === 'npm' && item.script === 'compile'));
});

test('tsconfig avoids deprecated downlevelIteration compiler option', () => {
    const tsconfig = fs.readFileSync(path.join(projectRoot, 'tsconfig.json'), 'utf8');

    assert.doesNotMatch(tsconfig, /"downlevelIteration"/);
    assert.doesNotMatch(tsconfig, /"ignoreDeprecations"/);
});

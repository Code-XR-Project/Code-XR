const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const emojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const textExtensions = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.cjs',
    '.mjs',
    '.json',
    '.md',
    '.html',
    '.css',
    '.py',
    '.txt',
    '.svg',
]);

function readProjectFile(...segments) {
    return fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');
}

function collectTextFiles(root) {
    const files = [];
    const start = path.join(projectRoot, root);
    // A root that moved would make every policy below pass on zero files.
    assert.ok(fs.existsSync(start), `${root} does not exist: retarget this policy to where it moved`);
    const stack = [start];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                // .claude/worktrees holds whole checkouts made by agent sessions
                // (git-ignored): scanning them would police other branches.
                const isAgentWorktrees = entry.name === 'worktrees' && path.basename(current) === '.claude';
                if (!isAgentWorktrees && !['node_modules', '.git', 'artifacts', 'dist', 'out'].includes(entry.name)) {
                    stack.push(fullPath);
                }
                continue;
            }
            if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
                files.push(fullPath);
            }
        }
    }
    return files;
}

// Root-level text of the monorepo (outside apps/vscode-extension): the
// root README and package.json, the shared docs and ADRs, CI, and the
// placeholders of the IDE and the shared packages.
function monorepoTextFiles() {
    return [
        path.join(projectRoot, '..', '..', 'README.md'),
        path.join(projectRoot, '..', '..', 'package.json'),
        ...collectTextFiles('../../docs'),
        ...collectTextFiles('../../adr'),
        ...collectTextFiles('../../.github'),
        ...collectTextFiles('../../apps/ide'),
        ...collectTextFiles('../../packages'),
    ];
}

test('auto-analysis delay defaults to RealTime and selector labels are plain text', () => {
    const model = readProjectFile('src', 'core', 'analysis', 'configuration', 'analysisConfiguration.ts');
    const profile = readProjectFile(
        'src',
        'features',
        'analysis',
        'sections',
        'settings',
        'profile-configuration',
        'profileConfiguration.ts',
    );
    const commands = readProjectFile(
        'src',
        'features',
        'analysis',
        'sections',
        'settings',
        'auto-analysis-delay',
        'autoAnalysisDelayCommands.ts',
    );

    assert.match(model, /autoAnalysisDelay:\s*\{\s*type: 'RealTime'/);
    assert.match(profile, /autoAnalysisDelay:\s*\{\s*type: 'RealTime'/);
    for (const label of ['Real Time (0s)', '1 Second', '3 Seconds', '5 Seconds', '10 Seconds', 'Custom Value...']) {
        assert.match(commands, new RegExp(`label: '${label.replace(/[()]/g, '\\$&')}'`));
    }
    assert.doesNotMatch(commands, emojiPattern);
});

test('XR mapping UI is always injected and no longer has an enabled config flag', () => {
    const fileParser = readProjectFile('src', 'core', 'analysis', 'parsers', 'fileXRParser.ts');
    const directoryParser = readProjectFile('src', 'core', 'analysis', 'parsers', 'directoryXRParser.ts');
    const storage = readProjectFile('src', 'core', 'analysis', 'configuration', 'analysisConfigurationStorage.ts');
    const model = readProjectFile('src', 'core', 'analysis', 'configuration', 'analysisConfiguration.ts');
    const templateProcessor = readProjectFile('src', 'core', 'charts', 'processing', 'templateProcessor.ts');

    assert.match(fileParser, /babiaUiVisibleByDefault: babiaUiConfig\.visibleByDefault/);
    assert.match(directoryParser, /babiaUiVisibleByDefault: babiaUiConfig\.visibleByDefault/);
    const oldInjectionFlag = ['babia', 'Ui', 'Enabled'].join('');
    const oldConfigRead = ['babia', 'Ui', 'Config.enabled'].join('');
    const oldGetter = ['getXR', 'Babia', 'Ui', 'Enabled'].join('');
    const oldSetter = ['setXR', 'Babia', 'Ui', 'Enabled'].join('');

    assert.equal(fileParser.includes(oldInjectionFlag), false);
    assert.equal(fileParser.includes(oldConfigRead), false);
    assert.equal(directoryParser.includes(oldInjectionFlag), false);
    assert.equal(directoryParser.includes(oldConfigRead), false);
    assert.equal(storage.includes(oldGetter), false);
    assert.equal(storage.includes(oldSetter), false);
    assert.doesNotMatch(model, /enabled: boolean|enabled: true/);
    assert.equal(templateProcessor.includes(oldInjectionFlag), false);
    assert.doesNotMatch(templateProcessor, /const enabled =/);
});

test('plugin text sources do not contain emoji characters', () => {
    const files = [
        path.join(projectRoot, 'package.json'),
        ...collectTextFiles('src'),
        // The Python backend used to sit under src/; it is now <repo>/backend.
        ...collectTextFiles('../../backend'),
        ...collectTextFiles('templates'),
        ...collectTextFiles('docs'),
        ...collectTextFiles('test'),
        // Text the monorepo move put outside this package.
        ...monorepoTextFiles(),
    ];
    const offenders = files.filter((filePath) => emojiPattern.test(fs.readFileSync(filePath, 'utf8')));
    assert.deepEqual(offenders.map((filePath) => path.relative(projectRoot, filePath)), []);
});

test('plugin text sources contain no NUL bytes', () => {
    // A single raw NUL makes ripgrep (and git) classify the whole file as
    // binary and skip it silently, so every repo-wide search, dead-code proof
    // and lint sweep goes blind to it. Spell the character as an escape.
    // .claude/ is covered too: the audit of this very problem quoted the byte
    // verbatim and made its own 275 KB evidence file invisible to grep.
    const files = [
        ...collectTextFiles('src'),
        ...collectTextFiles('templates'),
        ...collectTextFiles('test'),
        ...collectTextFiles('scripts'),
        ...collectTextFiles('docs'),
        ...collectTextFiles('../../backend'),
        // .claude/ is shared by the whole monorepo and lives at its root.
        ...collectTextFiles('../../.claude'),
        ...monorepoTextFiles(),
    ];
    const offenders = files.filter((filePath) => fs.readFileSync(filePath).includes(0));
    assert.deepEqual(offenders.map((filePath) => path.relative(projectRoot, filePath)), []);
});

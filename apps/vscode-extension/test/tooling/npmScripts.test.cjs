const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Every npm script points at something that exists: a file it runs with node,
// a config it passes with -p / -c, another script it calls with `npm run`, or
// the workspace script a root mirror delegates to. A script whose target was
// moved or deleted otherwise fails only when somebody happens to run it.
const projectRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(projectRoot, '..', '..');

const packages = {
    root: { dir: repoRoot, manifest: JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) },
    'code-xr': { dir: projectRoot, manifest: JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) },
};
// The Code-XR IDE workspace (epic #11): its scripts and the root ide:* mirrors
// are checked the same way.
const ideDir = path.join(repoRoot, 'apps', 'ide');
packages['code-xr-ide'] = { dir: ideDir, manifest: JSON.parse(fs.readFileSync(path.join(ideDir, 'package.json'), 'utf8')) };

/** The `&&`-separated commands of a script, each split into words. */
function commandsOf(script) {
    return script.split('&&').map((command) => command.trim().split(/\s+/).filter(Boolean));
}

/** Whatever a command references: files, scripts, workspace scripts. */
function targetsOf(words) {
    const targets = [];
    if (words[0] === 'node' && words[1] && !words[1].startsWith('-')) {
        targets.push({ kind: 'file', value: words[1] });
    }
    for (let index = 0; index < words.length - 1; index += 1) {
        if (['-p', '-c', '--project', '--config'].includes(words[index]) && !words[index + 1].startsWith('-')) {
            targets.push({ kind: 'file', value: words[index + 1] });
        }
    }
    if (words[0] === 'npm' && words[1] === 'run' && words[2]) {
        const workspace = words.find((word) => word.startsWith('--workspace='));
        targets.push(workspace
            ? { kind: 'workspace-script', value: words[2], workspace: workspace.slice('--workspace='.length) }
            : { kind: 'script', value: words[2] });
    }
    return targets;
}

test('every npm script target exists, in the root manifest and the extension workspace', () => {
    const problems = [];
    let checked = 0;

    for (const [name, { dir, manifest }] of Object.entries(packages)) {
        for (const [scriptName, script] of Object.entries(manifest.scripts)) {
            for (const target of commandsOf(script).flatMap(targetsOf)) {
                checked += 1;
                const where = `${name} "${scriptName}"`;
                if (target.kind === 'file' && !fs.existsSync(path.resolve(dir, target.value))) {
                    problems.push(`${where}: ${target.value} does not exist`);
                }
                if (target.kind === 'script' && !(target.value in manifest.scripts)) {
                    problems.push(`${where}: npm run ${target.value} names no script`);
                }
                if (target.kind === 'workspace-script') {
                    const workspace = packages[target.workspace];
                    if (!workspace) {
                        problems.push(`${where}: unknown workspace ${target.workspace}`);
                    } else if (!(target.value in workspace.manifest.scripts)) {
                        problems.push(`${where}: workspace ${target.workspace} has no "${target.value}" script`);
                    }
                }
            }
        }
    }

    assert.ok(checked > 40, `canary: the parser found script targets (${checked})`);
    assert.deepEqual(problems, []);
});

test('every extension script is mirrored at the root, under the same name', () => {
    // README.md promises that `npm run <script>` works from either folder.
    // vscode:prepublish is the one exception: vsce runs it inside the workspace.
    // A root script may run more after the mirror (the root `test` also runs
    // the IDE gate), but it must start with it.
    const rootScripts = packages.root.manifest.scripts;
    const missing = Object.keys(packages['code-xr'].manifest.scripts)
        .filter((name) => name !== 'vscode:prepublish')
        .filter((name) => {
            const mirror = `npm run ${name} --workspace=code-xr`;
            const root = rootScripts[name] ?? '';
            return root !== mirror && !root.startsWith(`${mirror} && `);
        });

    assert.deepEqual(missing, []);
});

test('every test:* script is documented in DEVELOPMENT.md and test/README.md', () => {
    // A runnable suite nobody knows about protects nothing.
    const development = fs.readFileSync(path.join(repoRoot, '.claude', 'docs', 'DEVELOPMENT.md'), 'utf8');
    const testReadme = fs.readFileSync(path.join(projectRoot, 'test', 'README.md'), 'utf8');
    const testScripts = [...new Set(Object.values(packages)
        .flatMap(({ manifest }) => Object.keys(manifest.scripts))
        .filter((name) => name === 'test' || name.startsWith('test:')))];
    const mentions = (text, name) => text.includes(`npm run ${name}`) || text.includes(`\`${name}\``);

    assert.ok(testScripts.length >= 10, 'canary: the test scripts were found');
    assert.deepEqual(testScripts.filter((name) => !mentions(development, name)), [], 'missing from .claude/docs/DEVELOPMENT.md');
    assert.deepEqual(
        testScripts.filter((name) => name !== 'test:backend' && !mentions(testReadme, name)),
        [],
        'missing from test/README.md (test:backend is the root alias of test:python)',
    );
});

test('test/README.md names every directory of the suite', () => {
    const testReadme = fs.readFileSync(path.join(projectRoot, 'test', 'README.md'), 'utf8');
    const directories = fs.readdirSync(path.join(projectRoot, 'test'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

    assert.ok(directories.includes('tooling'), 'canary');
    assert.deepEqual(directories.filter((name) => !testReadme.includes(`test/${name}`)), []);
});

test('the target parser reads the script shapes this repository uses', () => {
    assert.deepEqual(commandsOf('node a.cjs --x && npm run b').flatMap(targetsOf), [
        { kind: 'file', value: 'a.cjs' },
        { kind: 'script', value: 'b' },
    ]);
    assert.deepEqual(targetsOf(['node', 'tsc.js', '--noEmit', '-p', 'tsconfig.check.json']), [
        { kind: 'file', value: 'tsc.js' },
        { kind: 'file', value: 'tsconfig.check.json' },
    ]);
    assert.deepEqual(targetsOf(['npm', 'run', 'lint', '--workspace=code-xr']), [
        { kind: 'workspace-script', value: 'lint', workspace: 'code-xr' },
    ]);
    // `node -e "..."` runs inline code, not a file.
    assert.deepEqual(targetsOf(['node', '-e', '"require(\'fs\')"']), []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { projectRoot, collectFiles, readSource } = require('../helpers/sourceText.cjs');
const { createFakeVscode, fakeExtensionContext, withFakeVscode, ExtensionMode } = require('../helpers/fakeVscode.cjs');
const { collectSurface } = require('../baseline/featureSurface.cjs');

/**
 * An installed extension is the VSIX unzipped: whatever the `files` allowlist
 * let in, plus what webpack wrote into dist/. Every runtime lookup is
 * `context.extensionPath` joined with literal segments, so a path that is in
 * the repository but not in that layout works from a checkout and from F5 and
 * fails only for users. The usual failure is silent (an empty examples tree,
 * a scene without its runtime, a page without its icon).
 *
 * This suite rebuilds the packaged layout WITHOUT building or packaging:
 *  - outside dist/, with vsce's own `listFiles` over the manifest, which is
 *    the function `vsce package` collects files with;
 *  - inside dist/, from the bundle name and the CopyPlugin patterns of
 *    webpack.config.js, evaluated over the source trees they copy.
 * Then it checks every extension-relative path the source spells, and runs the
 * compiled resolvers against a materialized copy of that layout.
 *
 * The same checks run against a REAL package: unzip a VSIX and point
 * CODEXR_VSIX_EXTENSION_ROOT at its `extension/` folder. The model is then
 * replaced by the files that are actually in it.
 */

const packageJson = JSON.parse(readSource('package.json'));
const webpackConfig = require(path.join(projectRoot, 'webpack.config.js'));

// ---------------------------------------------------------------- the layout

function walk(directory) {
    if (!fs.existsSync(directory)) {
        return [];
    }
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(entryPath) : [entryPath];
    });
}

/**
 * The CopyPlugin ignore globs this config uses. Any other shape throws rather
 * than being read as "ignores nothing", which would ship files in the model
 * that webpack leaves out.
 */
function compileIgnore(globs) {
    const tests = (globs || []).map((glob) => {
        const extension = /^\*\*\/\*(\.[\w]+)$/.exec(glob);
        if (extension) {
            return (relative) => relative.endsWith(extension[1]);
        }
        const directory = /^\*\*\/([\w.-]+)\/\*\*$/.exec(glob);
        if (directory) {
            return (relative) => relative.split('/').slice(0, -1).includes(directory[1]);
        }
        throw new Error(`CopyPlugin ignore glob "${glob}" is a shape this suite does not evaluate; teach compileIgnore it.`);
    });
    return (relative) => tests.some((ignored) => ignored(relative));
}

function copyPatterns() {
    const copyPlugins = webpackConfig.plugins.filter((plugin) => Array.isArray(plugin.patterns));
    assert.equal(copyPlugins.length, 1, 'webpack.config.js no longer has exactly one CopyPlugin: re-read how dist/ is filled');
    return copyPlugins[0].patterns;
}

/** packaged path (posix, relative to the extension root) -> absolute source path on disk */
async function packagedLayout() {
    const unzipped = process.env.CODEXR_VSIX_EXTENSION_ROOT;
    if (unzipped) {
        return new Map(walk(unzipped).map((file) => [path.relative(unzipped, file).split(path.sep).join('/'), file]));
    }

    const vsce = require('@vscode/vsce');
    const listed = await vsce.listFiles({ cwd: projectRoot, packageManager: vsce.PackageManager.None });
    const layout = new Map();

    for (const file of listed) {
        const posixPath = file.split(path.sep).join('/');
        // dist/ on disk is whatever the last local build left; model it instead.
        if (!posixPath.startsWith('dist/')) {
            layout.set(posixPath, path.join(projectRoot, ...posixPath.split('/')));
        }
    }

    assert.ok(
        packageJson.files.includes('dist/**/*'),
        'the allowlist no longer ships dist/: the bundle and the Python backend are not in the VSIX',
    );
    layout.set(`dist/${webpackConfig.output.filename}`, path.join(projectRoot, 'src', 'extension.ts'));

    for (const pattern of copyPatterns()) {
        const context = pattern.context || projectRoot;
        const sourceRoot = path.resolve(context, pattern.from);
        const ignored = compileIgnore(pattern.globOptions && pattern.globOptions.ignore);
        for (const file of walk(sourceRoot)) {
            const relative = path.relative(sourceRoot, file).split(path.sep).join('/');
            if (!ignored(relative)) {
                layout.set(`dist/${pattern.to}/${relative}`, file);
            }
        }
    }

    return layout;
}

function resolvesIn(layout, posixPath) {
    return layout.has(posixPath) || [...layout.keys()].some((file) => file.startsWith(`${posixPath}/`));
}

function materialize(layout) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-packaged-layout-'));
    for (const [posixPath, source] of layout) {
        const target = path.join(root, ...posixPath.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
    }
    return root;
}

// ---------------------------------------------------------------- references in the code

const PACKAGED_ROOTS = ['templates', 'examples', 'resources', 'dist'];

/**
 * Extension-relative paths as the code spells them: a chain of quoted
 * segments handed to path.join / Uri.joinPath or kept in a SEGMENTS array
 * (`'templates', 'xr', 'sse', 'live_sse_fileXR.js'`), or one quoted literal
 * (`'templates/utils/color-picker.html'`). `resolveTemplatePath(root, …)`
 * (src/platform/templatePaths.ts) reads as a chain that starts with 'templates'.
 * A chain that ends in an expression
 * names its directory. A chain whose first segment follows another quoted
 * string is a list of names (`'node_modules', 'dist', 'build'`), not a path.
 */
function extractPackagedReferences(source) {
    const text = source.replace(/\bresolveTemplatePath\(([^,()]+),/g, "resolveTemplatePath($1, 'templates',");
    const references = [];
    const roots = PACKAGED_ROOTS.join('|');
    const chainStart = new RegExp(String.raw`(['"])(${roots})\1`, 'g');
    const chainNext = /\s*,\s*(?:(['"])([^'"\n]+)\1|([A-Za-z_$`.]))/y;

    for (let start = chainStart.exec(text); start !== null; start = chainStart.exec(text)) {
        if (/['"]\s*,\s*$/.test(text.slice(Math.max(0, start.index - 200), start.index))) {
            continue;
        }
        const segments = [start[2]];
        let computedTail = false;
        chainNext.lastIndex = chainStart.lastIndex;
        for (let next = chainNext.exec(text); next !== null; next = chainNext.exec(text)) {
            if (next[3] !== undefined) {
                computedTail = true;
                break;
            }
            segments.push(next[2]);
        }
        if (segments.length > 1 || computedTail) {
            references.push(segments.join('/'));
        }
    }

    for (const literal of text.matchAll(new RegExp(String.raw`(['"])((?:${roots})\/[\w./-]+)\1`, 'g'))) {
        references.push(literal[2]);
    }

    return references;
}

function collectSourceReferences() {
    const references = new Map();
    for (const file of collectFiles('src', { extensions: ['.ts'] })) {
        for (const reference of extractPackagedReferences(readSource(file))) {
            if (!references.has(reference)) {
                references.set(reference, new Set());
            }
            references.get(reference).add(file);
        }
    }
    return references;
}

function silenceConsole() {
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    return () => Object.assign(console, original);
}

// ---------------------------------------------------------------- tests

test('every extension-relative path the source spells is in the packaged layout', async () => {
    const layout = await packagedLayout();
    const references = collectSourceReferences();

    // Canaries: each packaged root is reached from the source, so an extractor
    // that stopped reading the code's spelling cannot pass by finding nothing.
    for (const root of ['templates/', 'examples/', 'resources/', 'dist/code_analysis/python']) {
        assert.ok(
            [...references.keys()].some((reference) => reference.startsWith(root)),
            `no source reference starts with ${root}: the extractor no longer reads the code`,
        );
    }

    const missing = [...references]
        .filter(([reference]) => !resolvesIn(layout, reference))
        .map(([reference, files]) => `${reference} (spelled in ${[...files].sort().join(', ')})`);
    assert.deepEqual(missing, [], `paths an installed extension will not have:\n  ${missing.join('\n  ')}`);
});

test('every Python entry point the extension spawns is in the packaged dist/code_analysis/python', async () => {
    const layout = await packagedLayout();
    const { pythonEntryPoints } = await collectSurface();
    assert.ok(pythonEntryPoints.length > 0, 'no Python entry point was found: the probe is looking at the wrong files');

    const missing = pythonEntryPoints
        .map((entry) => entry.split(' | ')[0])
        .filter((script) => !layout.has(`dist/code_analysis/python/${script}`));
    assert.deepEqual(missing, []);
});

test('the compiled resolvers find what they need in a materialized packaged layout', async () => {
    const layout = await packagedLayout();
    const extensionRoot = materialize(layout);
    const context = fakeExtensionContext({ extensionPath: extensionRoot, extensionMode: ExtensionMode.Production });
    const restoreConsole = silenceConsole();

    try {
        const { pythonEntryPoints } = await collectSurface();
        const result = await withFakeVscode(createFakeVscode(), async ({ requireOut }) => {
            const { resolveBackendScriptPath } = requireOut('core/host/backendScriptPath.js');
            const { hostPathsFromContext } = requireOut('core/host/hostPaths.js');
            const paths = hostPathsFromContext(context);
            const scripts = pythonEntryPoints.map((entry) => resolveBackendScriptPath(paths, entry.split(' | ')[0]));

            const { assertCodeXrCommonRuntimeSourceExists } = requireOut(
                'core/analysis/scene-assets/commonComponentAsset.js',
            );
            const commonRuntime = assertCodeXrCommonRuntimeSourceExists(extensionRoot);

            const { ExampleLauncher } = requireOut('features/examples/services/exampleLauncher.js');
            const examples = await new ExampleLauncher(context).scanExamples();

            const { SaveFiles } = requireOut('core/analysis/utils/saveFiles.js');
            const outputDirectory = await new SaveFiles().saveFilesToStorage(
                new Map([['index.html', '<!doctype html>']]),
                'fileAnalysis',
                'packaged-layout',
                context,
            );

            return { scripts, commonRuntime, examples, outputDirectory };
        });
        restoreConsole();

        for (const script of result.scripts) {
            assert.ok(script.startsWith(extensionRoot), `${script} resolved outside the installed extension`);
            assert.ok(fs.existsSync(script), `${script} is not in the packaged layout`);
        }
        assert.ok(fs.existsSync(result.commonRuntime));
        assert.deepEqual(result.examples.errors, []);
        assert.ok(result.examples.validCount > 0, 'the installed extension lists no chart examples');
        assert.ok(
            fs.existsSync(path.join(result.outputDirectory, 'favicon.ico')),
            'a saved analysis folder has no favicon.ico in the installed extension',
        );
    } finally {
        restoreConsole();
        context.cleanup();
        fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
});

test('the reference extractor reads path chains and skips lists of names', () => {
    assert.deepEqual(
        extractPackagedReferences([
            "path.join(context.extensionPath, 'templates', 'xr', 'sse', 'live_sse_fileXR.js');",
            "const SEGMENTS = [\n    'templates',\n    'components',\n    NAME,\n] as const;",
            "const TEMPLATE_PATH = 'templates/utils/color-picker.html';",
            "const EXCLUDED = [\n    'node_modules',\n    'dist',\n    'build',\n];",
            "if (name === 'examples') {}",
            "resolveTemplatePath(context.extensionPath, 'xr', 'file', 'xr-visualization.html');",
            "resolveTemplatePath(\n    extensionPath,\n    'components',\n    asset.folder,\n);",
        ].join('\n')),
        [
            'templates/xr/sse/live_sse_fileXR.js',
            'templates/components',
            'templates/xr/file/xr-visualization.html',
            'templates/components',
            'templates/utils/color-picker.html',
        ],
    );
    assert.throws(() => compileIgnore(['**/*.{ts,js}']), /does not evaluate/);
    assert.equal(compileIgnore(['**/__pycache__/**'])('pkg/__pycache__/a.pyc'), true);
    assert.equal(compileIgnore(['**/*.ts'])('main.py'), false);
});

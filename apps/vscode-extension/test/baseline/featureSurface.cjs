'use strict';

/**
 * Collects the user-visible surface of the extension, section by section, so
 * featureBaseline.test.cjs can compare it with the committed snapshot
 * (featureBaseline.snapshot.json). Every section is a sorted list of strings.
 *
 * The surface is what a user can see, invoke or rely on: the manifest
 * (commands, menus, views, settings, shipped files), the commands registered
 * at runtime, the chart types, the in-scene analysis modes, the browser
 * runtimes and examples that ship, the language contract, the Python CLI the
 * extension drives, and the persisted state keys an upgrade must keep.
 *
 *   node test/baseline/featureSurface.cjs            print the current surface
 *   node test/baseline/featureSurface.cjs --write    rewrite the snapshot; refuses
 *        to drop an entry that is not in authorizedRemovals.cjs unless
 *        --allow "<reason>" is given (the reason goes into the commit message)
 *
 * Needs the compiled tests (npm run compile-tests) for the runtime sections.
 */

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(projectRoot, '..', '..');
const snapshotPath = path.join(__dirname, 'featureBaseline.snapshot.json');

const sorted = (values) => [...new Set(values)].sort();

function readText(absolutePath) {
    return fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n');
}

function listFiles(root, base = root) {
    const files = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFiles(fullPath, base));
        } else if (entry.isFile()) {
            files.push(path.relative(base, fullPath).split(path.sep).join('/'));
        }
    }
    return files;
}

function collectManifest() {
    const manifest = JSON.parse(readText(path.join(projectRoot, 'package.json')));
    const contributes = manifest.contributes || {};
    const menus = [];
    for (const [menuId, entries] of Object.entries(contributes.menus || {})) {
        for (const entry of entries) {
            const target = entry.command || `submenu:${entry.submenu}`;
            menus.push(`${menuId} | ${target} | ${entry.group || ''} | ${entry.when || ''}`);
        }
    }
    const views = [];
    for (const [containerId, list] of Object.entries(contributes.views || {})) {
        for (const view of list) {
            views.push(`${containerId} | ${view.id} | ${view.name || ''}`);
        }
    }
    const containers = [];
    for (const [location, list] of Object.entries(contributes.viewsContainers || {})) {
        for (const container of list) {
            containers.push(`${location} | ${container.id} | ${container.title || ''}`);
        }
    }
    const properties = (contributes.configuration && contributes.configuration.properties) || {};
    return {
        contributedCommands: sorted((contributes.commands || []).map((c) => `${c.command} | ${c.title}`)),
        menus: sorted(menus),
        submenus: sorted((contributes.submenus || []).map((s) => `${s.id} | ${s.label || ''}`)),
        viewContainers: sorted(containers),
        views: sorted(views),
        settings: sorted(Object.entries(properties).map(([key, spec]) => `${key} | ${spec.type} | ${JSON.stringify(spec.default)}`)),
        keybindings: sorted((contributes.keybindings || []).map((k) => `${k.command} | ${k.key}`)),
        shippedFiles: sorted(manifest.files || []),
        npmScripts: sorted(Object.keys(manifest.scripts || {})),
        engines: sorted(Object.entries(manifest.engines || {}).map(([name, range]) => `${name} ${range}`)),
    };
}

/** Runs the real registerAllCommands under the fake vscode, like commandContributions.test.cjs. */
async function collectRuntime() {
    const { createFakeVscode, fakeExtensionContext, withFakeVscode } = require(path.join(projectRoot, 'test', 'helpers', 'fakeVscode.cjs'));
    const fake = createFakeVscode();
    const context = fakeExtensionContext();
    const consoleLog = console.log;
    console.log = () => {};
    let chartTypes = [];
    try {
        await withFakeVscode(fake, async ({ requireOut }) => {
            requireOut('commands/index.js').registerAllCommands(context);
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            chartTypes = requireOut('core/charts/templateCharts.js').chartTemplates
                .map((chart) => `${chart.id} | ${chart.name}`);
        });
    } finally {
        console.log = consoleLog;
        context.cleanup();
    }
    return {
        registeredCommands: sorted(fake.registeredCommands.keys()),
        chartTypes: sorted(chartTypes),
    };
}

function collectSourceContracts() {
    // In-scene analysis modes the XR controller can switch to.
    const refresh = readText(path.join(projectRoot, 'src', 'core', 'analysis', 'refresh', 'analysisRefreshCoordinator.ts'));
    const modeUnion = refresh.match(/export type AnalysisRefreshMode\s*=([^;]+);/);
    if (!modeUnion) {
        throw new Error('AnalysisRefreshMode not found: retarget featureSurface.cjs to where it moved');
    }
    const analysisModes = [...modeUnion[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

    // Language contract of the Python engine (metric languages + DOM-only HTML).
    const contract = readText(path.join(repoRoot, 'backend', 'src', 'utils', 'metric_language_contract.py'));
    const languages = [...contract.matchAll(/\("([^"]+)",\s*\[([^\]]*)\]\)/g)]
        .map((m) => `${m[1]} | ${[...m[2].matchAll(/"([^"]+)"/g)].map((e) => e[1]).join(' ')}`);
    const domOnly = contract.match(/DOM_ONLY_LANGUAGE_EXTENSION_MAP[^{]*\{([^}]*)\}/);
    if (languages.length === 0 || !domOnly) {
        throw new Error('language contract not found: retarget featureSurface.cjs');
    }
    for (const m of domOnly[1].matchAll(/"([^"]+)":\s*\[([^\]]*)\]/g)) {
        languages.push(`${m[1]} (DOM only) | ${[...m[2].matchAll(/"([^"]+)"/g)].map((e) => e[1]).join(' ')}`);
    }

    // The Python CLI the extension drives (main.py).
    const main = readText(path.join(repoRoot, 'backend', 'src', 'main.py'));
    const pythonCli = [];
    for (const m of main.matchAll(/add_argument\('(--[a-z-]+)'([^\n]*)/g)) {
        pythonCli.push(`flag:${m[1]}`);
        const choices = m[2].match(/choices=\[([^\]]*)\]/);
        if (choices) {
            const kind = m[1].replace(/^--/, '');
            for (const c of choices[1].matchAll(/'([^']+)'/g)) {
                pythonCli.push(`${kind}:${c[1]}`);
            }
        }
    }
    return { analysisModes: sorted(analysisModes), languages: sorted(languages), pythonCli: sorted(pythonCli) };
}

/** Python entry points the extension spawns directly (executePython.ts, gitRevisionExporter.ts). */
function collectPythonEntryPoints() {
    const sources = [
        path.join(projectRoot, 'src', 'core', 'analysis', 'python', 'executePython.ts'),
        path.join(projectRoot, 'src', 'core', 'export', 'gitRevisionExporter.ts'),
    ].map(readText).join('\n');
    const scripts = [...sources.matchAll(/['"]([A-Za-z_/]+\.py)['"]/g)].map((m) => m[1]);
    // Also path.join('dir', 'script.py') spellings.
    for (const m of sources.matchAll(/path\.join\(((?:\s*'[A-Za-z_]+',)+\s*'[A-Za-z_]+\.py')\)/g)) {
        scripts.push([...m[1].matchAll(/'([^']+)'/g)].map((part) => part[1]).join('/'));
    }
    // A bare file name that is the tail of a joined path is the same script.
    const unique = scripts.filter((script) => !scripts.some((other) => other !== script && other.endsWith(`/${script}`)));
    return sorted(unique.map((script) => {
        const exists = fs.existsSync(path.join(repoRoot, 'backend', 'src', script));
        return `${script} | ${exists ? 'present' : 'MISSING'}`;
    }));
}

// Persisted keys and storage folders users already have on disk (feature-baseline.md section 0.2).
const PERSISTED_LITERALS = [
    'codeXR.analysis.lastKind',
    'codeXR.analysis.xrFieldSchemaCache.v1',
    'codeXR.analysis.filesByLanguage.summaryCache',
    'visualizeDataState',
    'visualizationSettings',
    'codexr.cloudflaredDownloadConsented',
    'server-settings.json',
    'server-certs',
    'codexr_analysis',
    'visualization-configuration',
    'collaboration',
    'python-env',
    'remote-access',
    'visualize-data',
    'codeXR.pythonEnv.uiLocked',
    'codeXR.pythonEnv.retryAvailable',
];

function collectPersistedState() {
    const srcRoot = path.join(projectRoot, 'src');
    const text = listFiles(srcRoot)
        .filter((file) => file.endsWith('.ts'))
        .map((file) => readText(path.join(srcRoot, file)))
        .join('\n');
    return sorted(PERSISTED_LITERALS.map((literal) => {
        const quoted = [`'${literal}`, `"${literal}`, `\`${literal}`].some((q) => text.includes(q));
        return `${literal} | ${quoted ? 'present' : 'MISSING'}`;
    }));
}

async function collectSurface() {
    const runtime = await collectRuntime();
    return {
        ...collectManifest(),
        ...runtime,
        ...collectSourceContracts(),
        pythonEntryPoints: collectPythonEntryPoints(),
        persistedState: collectPersistedState(),
        // Everything under templates/ and examples/ ships in the VSIX and is
        // served to the browser: the XR scenes, runtimes, LivePanel, guide.
        templateFiles: sorted(listFiles(path.join(projectRoot, 'templates'))),
        exampleFiles: sorted(listFiles(path.join(projectRoot, 'examples'))),
    };
}

/** Compares two surfaces. Returns { section: { missing, added } } for every section that differs. */
function diffSurface(expected, actual) {
    const report = {};
    for (const section of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
        const before = new Set(expected[section] || []);
        const after = new Set(actual[section] || []);
        const missing = [...before].filter((entry) => !after.has(entry)).sort();
        const added = [...after].filter((entry) => !before.has(entry)).sort();
        if (missing.length > 0 || added.length > 0) {
            report[section] = { missing, added };
        }
    }
    return report;
}

/** Entries that vanished and are not authorized removals. */
function unauthorizedRemovals(report, authorized) {
    const result = {};
    for (const [section, { missing }] of Object.entries(report)) {
        const allowed = new Set(authorized[section] || []);
        const lost = missing.filter((entry) => !allowed.has(entry));
        if (lost.length > 0) {
            result[section] = lost;
        }
    }
    return result;
}

module.exports = { collectSurface, diffSurface, unauthorizedRemovals, snapshotPath };

if (require.main === module) {
    (async () => {
        const surface = await collectSurface();
        const args = process.argv.slice(2);
        if (!args.includes('--write')) {
            process.stdout.write(`${JSON.stringify(surface, null, 2)}\n`);
            return;
        }
        const { AUTHORIZED_REMOVALS } = require('./authorizedRemovals.cjs');
        if (fs.existsSync(snapshotPath)) {
            const previous = JSON.parse(readText(snapshotPath));
            const lost = unauthorizedRemovals(diffSurface(previous, surface), AUTHORIZED_REMOVALS);
            const allowIndex = args.indexOf('--allow');
            if (Object.keys(lost).length > 0 && (allowIndex === -1 || !args[allowIndex + 1])) {
                process.stderr.write(`Refusing to drop entries that are not authorized removals:\n${JSON.stringify(lost, null, 2)}\n`
                    + 'Restore them, add them to authorizedRemovals.cjs with the maintainer\'s ok, '
                    + 'or pass --allow "<reason>" for a pure rename and say so in the commit message.\n');
                process.exitCode = 1;
                return;
            }
        }
        // The snapshot stays the pre-cleanup baseline: an authorized removal is
        // kept in it, so the register keeps naming entries the baseline had.
        const written = { ...surface };
        if (fs.existsSync(snapshotPath)) {
            const previous = JSON.parse(readText(snapshotPath));
            for (const [section, entries] of Object.entries(AUTHORIZED_REMOVALS)) {
                const kept = (previous[section] || []).filter((entry) => entries.includes(entry));
                written[section] = sorted([...(written[section] || []), ...kept]);
            }
        }
        fs.writeFileSync(snapshotPath, `${JSON.stringify(written, null, 2)}\n`);
        process.stdout.write(`wrote ${path.relative(projectRoot, snapshotPath)}\n`);
    })().catch((error) => {
        process.stderr.write(`${error.stack || error}\n`);
        process.exitCode = 1;
    });
}

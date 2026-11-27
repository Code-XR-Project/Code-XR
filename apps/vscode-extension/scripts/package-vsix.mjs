import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, '..');
const packageJson = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf8'));
const outputDir = resolve(workspaceRoot, 'artifacts');
const outputPath = resolve(outputDir, `code-xr-${packageJson.version}.vsix`);
// Resolved through Node rather than a fixed path: in the npm workspace the
// dependency is hoisted to <repo>/node_modules, not this package's folder.
const vsceEntrypoint = resolve(dirname(createRequire(import.meta.url).resolve('@vscode/vsce/package.json')), 'vsce');
const nodeCommand = process.execPath;
const staleDistCertsPath = resolve(workspaceRoot, 'dist', 'certs');

if (Array.isArray(packageJson.files) && packageJson.files.includes('certs/**/*')) {
    console.error('VSIX packaging is blocked because package.json still includes certs/**/* in the published files list.');
    process.exit(1);
}

if (existsSync(staleDistCertsPath)) {
    rmSync(staleDistCertsPath, { recursive: true, force: true });
    console.log(`Removed stale dist certificate directory before packaging: ${staleDistCertsPath}`);
}

// `npm run package:vsix` builds before it gets here, so a missing bundle means
// the build failed or this script was started on its own. This used to be a
// unit-test assertion, which made `npm test` depend on a webpack build it never
// declared; the check belongs where it actually gates a package.
const extensionBundlePath = resolve(workspaceRoot, 'dist', 'extension.js');
if (!existsSync(extensionBundlePath)) {
    console.error(`VSIX packaging is blocked because ${extensionBundlePath} does not exist. Run "npm run package" first.`);
    process.exit(1);
}

// Source maps are a dev-build aid (webpack keeps emitting them for F5), but
// they are dead weight in the shipped package — the extension.js.map alone is
// ~3.5 MB — and vsce's `files` allowlist does not support negated patterns.
// Strip them from dist right before packaging; the next `npm run compile`
// regenerates them.
function removeSourceMaps(dir) {
    let removed = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            removed += removeSourceMaps(entryPath);
        } else if (entry.name.endsWith('.map')) {
            rmSync(entryPath, { force: true });
            removed += 1;
        }
    }
    return removed;
}
const distPath = resolve(workspaceRoot, 'dist');
if (existsSync(distPath)) {
    const removedMaps = removeSourceMaps(distPath);
    if (removedMaps > 0) {
        console.log(`Removed ${removedMaps} source map(s) from dist before packaging.`);
    }
}

// vsce rewrites the README's relative links against the repository root, but
// this package lives in a subfolder of the monorepo. Point it at the folder so
// links such as docs/... keep resolving on the Marketplace.
const repositoryUrl = String(packageJson.repository?.url ?? '').replace(/\.git$/, '');
const packageSubpath = relative(resolve(workspaceRoot, '..', '..'), workspaceRoot).split(sep).join('/');
const linkBaseArgs = repositoryUrl
    ? [
        '--baseContentUrl', `${repositoryUrl}/blob/HEAD/${packageSubpath}`,
        '--baseImagesUrl', `${repositoryUrl}/raw/HEAD/${packageSubpath}`,
    ]
    : [];

mkdirSync(outputDir, { recursive: true });

const child = spawn(
    nodeCommand,
    // --no-dependencies: webpack bundles every runtime dependency into dist/,
    // and in the npm workspace vsce would otherwise pull the hoisted
    // <repo>/node_modules into the VSIX.
    [vsceEntrypoint, 'package', '--no-dependencies', ...linkBaseArgs, '--out', outputPath],
    {
        cwd: workspaceRoot,
        stdio: 'inherit',
        shell: false,
        // vsce's vscode:prepublish hook re-runs webpack AFTER the .map sweep
        // above — this tells that rebuild to emit no source maps at all.
        env: { ...process.env, CODEXR_NO_SOURCEMAPS: '1' },
    },
);

child.on('exit', (code) => {
    if (code === 0) {
        console.log(`VSIX package created at ${outputPath}`);
        process.exit(0);
    }

    process.exit(code ?? 1);
});

child.on('error', (error) => {
    console.error(`Failed to start VSIX packaging via ${vsceEntrypoint}:`, error);
    process.exit(1);
});

// Declarations of the Code-XR core for the IDE's type check (#15).
//
// The IDE bundles the core straight from apps/vscode-extension/src/core
// through the `@codexr/core/*` alias (viteConfigs.mjs). The core is written
// for the extension's compiler options, not the IDE's stricter ones, so the
// IDE never type-checks core sources: it checks against .d.ts files that this
// script emits from those same sources with the extension's own settings.
//
// The entry points are every `@codexr/core/...` import found under src/, so
// the set follows the code. `types` leaves out `vscode`: a core module that
// still reached it would fail here, which keeps the IDE on the vscode-free
// part of the core.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { IDE_ROOT } from './viteConfigs.mjs';

const EXTENSION = path.resolve(IDE_ROOT, '..', 'vscode-extension');
const CORE_SRC = path.join(EXTENSION, 'src', 'core');
const OUT = path.join(IDE_ROOT, '.core-types');
const IMPORT = /from\s+['"]@codexr\/core\/([^'"]+)['"]/g;

function* sourceFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { yield* sourceFiles(full); } else if (entry.name.endsWith('.ts')) { yield full; }
    }
}

const entries = new Set();
for (const file of sourceFiles(path.join(IDE_ROOT, 'src'))) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) {
        const target = path.join(CORE_SRC, `${match[1].replace(/\.ts$/, '')}.ts`);
        if (!fs.existsSync(target)) {
            throw new Error(`${path.relative(IDE_ROOT, file)} imports @codexr/core/${match[1]}, which does not exist.`);
        }
        entries.add(target);
    }
}

fs.rmSync(OUT, { recursive: true, force: true });
if (entries.size === 0) {
    process.exit(0);
}
const config = path.join(IDE_ROOT, '.core-types.tsconfig.json');
fs.writeFileSync(config, JSON.stringify({
    extends: path.join(EXTENSION, 'tsconfig.json'),
    compilerOptions: {
        declaration: true,
        emitDeclarationOnly: true,
        noEmit: false,
        sourceMap: false,
        incremental: false,
        rootDir: path.join(EXTENSION, 'src'),
        outDir: OUT,
        types: ['node'],
    },
    files: [...entries].sort(),
    include: [],
}, null, 2));
const tsc = path.resolve(IDE_ROOT, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
const result = spawnSync(process.execPath, [tsc, '-p', config], { stdio: 'inherit' });
fs.rmSync(config, { force: true });
if (result.status !== 0) {
    console.error('[code-xr-ide] the core modules the IDE imports do not compile without vscode (see above).');
    process.exit(result.status ?? 1);
}

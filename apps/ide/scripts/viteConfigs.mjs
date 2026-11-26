// Vite configurations for the three Electron targets, shared by build.mjs
// and dev.mjs so development and production bundle the same way.
//
//   out/main/index.cjs      main process   (Node, CommonJS)
//   out/preload/index.cjs   preload        (sandboxed: may only require 'electron')
//   out/renderer/           renderer       (browser, served from codexr://app/)
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IDE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = path.join(IDE_ROOT, 'out');
/**
 * The extension's vscode-free core (#13), bundled into the main process from
 * source. Type-checked through declarations: see scripts/coreTypes.mjs.
 */
export const CORE_SRC = path.resolve(IDE_ROOT, '..', 'vscode-extension', 'src', 'core');

const NODE_EXTERNALS = ['electron', /^electron\//, ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
/**
 * Native modules cannot be bundled: they load their compiled `.node` file
 * from their own package folder at run time. node-pty (#137, the terminal)
 * stays a plain `require('node-pty')` of the main process, resolved from
 * node_modules; it uses N-API, so the same binary loads in Node and Electron.
 */
const MAIN_NATIVE_EXTERNALS = ['node-pty'];

/** @param {'main' | 'preload'} target @param {{ dev?: boolean }} [opts] */
export function nodeTargetConfig(target, opts = {}) {
    return {
        configFile: false,
        root: IDE_ROOT,
        logLevel: 'warn',
        mode: opts.dev ? 'development' : 'production',
        build: {
            outDir: path.join(OUT_DIR, target),
            emptyOutDir: true,
            target: 'node22',
            minify: false,
            sourcemap: opts.dev ? 'inline' : false,
            ssr: path.join(IDE_ROOT, 'src', target, 'index.ts'),
            rolldownOptions: {
                // A sandboxed preload cannot load local files: everything but
                // electron itself must be bundled in. The main process follows
                // the same rule so out/ is self-contained, native modules aside.
                external: target === 'main' ? [...NODE_EXTERNALS, ...MAIN_NATIVE_EXTERNALS] : NODE_EXTERNALS,
                output: { format: 'cjs', entryFileNames: 'index.cjs' },
            },
        },
        ssr: { noExternal: true },
        resolve: { alias: [{ find: /^@codexr\/core\//, replacement: `${CORE_SRC}/` }] },
    };
}

/** @param {{ dev?: boolean }} [opts] */
export function rendererConfig(opts = {}) {
    return {
        configFile: false,
        root: path.join(IDE_ROOT, 'src', 'renderer'),
        base: './',
        logLevel: opts.dev ? 'info' : 'warn',
        mode: opts.dev ? 'development' : 'production',
        build: {
            outDir: path.join(OUT_DIR, 'renderer'),
            emptyOutDir: true,
            target: 'chrome140',
            sourcemap: false,
        },
        server: { host: '127.0.0.1', port: 5174, strictPort: false },
    };
}

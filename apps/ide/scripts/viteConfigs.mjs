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

const NODE_EXTERNALS = ['electron', /^electron\//, ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

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
                // the same rule so out/ is self-contained.
                external: NODE_EXTERNALS,
                output: { format: 'cjs', entryFileNames: 'index.cjs' },
            },
        },
        ssr: { noExternal: true },
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

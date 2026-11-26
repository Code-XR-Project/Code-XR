// Development loop: Vite dev server with hot reload for the renderer, and a
// rebuild + restart of Electron whenever the main or preload code changes.
// Usage: npm run ide:dev (from the repository root)
import { spawn } from 'node:child_process';
import { build, createServer } from 'vite';
import { IDE_ROOT, nodeTargetConfig, rendererConfig } from './viteConfigs.mjs';
import { electronBinary, launchFlags } from './electronBinary.mjs';

const server = await createServer(rendererConfig({ dev: true }));
await server.listen();
const devUrl = server.resolvedUrls?.local[0];
if (!devUrl) {
    throw new Error('The Vite dev server did not report a URL.');
}
server.printUrls();

/** @type {import('node:child_process').ChildProcess | null} */
let electron = null;
let quitting = false;

function startElectron() {
    electron = spawn(electronBinary(), [...launchFlags(), IDE_ROOT], {
        stdio: 'inherit',
        env: { ...process.env, CODEXR_IDE_DEV_SERVER_URL: devUrl },
    });
    electron.on('exit', (code) => {
        // Closing the window ends the dev session; a restart kills the old
        // process first and clears `electron`, so it does not end it.
        if (electron && !quitting) {
            quitting = true;
            void server.close().then(() => process.exit(code ?? 0));
        }
    });
}

function restartElectron() {
    const previous = electron;
    electron = null;
    if (previous && previous.exitCode === null) {
        previous.removeAllListeners('exit');
        previous.kill();
    }
    startElectron();
}

// Watch main and preload; restart Electron after each successful rebuild.
const pending = new Set(['main', 'preload']);
for (const target of /** @type {const} */ (['main', 'preload'])) {
    const config = nodeTargetConfig(target, { dev: true });
    config.build.watch = {};
    const watcher = /** @type {import('vite').Rollup.RollupWatcher} */ (await build(config));
    watcher.on('event', (event) => {
        if (event.code === 'ERROR') {
            console.error(`[code-xr-ide] ${target} build failed:`, event.error);
        }
        if (event.code === 'END') {
            pending.delete(target);
            if (pending.size === 0) {
                restartElectron();
            }
        }
        if ('result' in event && event.result) {
            event.result.close();
        }
    });
}

process.on('SIGINT', () => {
    quitting = true;
    electron?.kill();
    void server.close().then(() => process.exit(0));
});

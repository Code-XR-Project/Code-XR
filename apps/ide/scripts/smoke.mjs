// Launches the built IDE with --codexr-smoke and checks its verdict.
// Usage: npm run ide:smoke (builds first). On Linux CI it runs under xvfb-run.
import { spawn } from 'node:child_process';
import { IDE_ROOT } from './viteConfigs.mjs';
import { electronBinary, launchFlags } from './electronBinary.mjs';

const PREFIX = 'CODEXR_SMOKE_RESULT ';
// The terminal step waits for a shell to start, which a cold Windows runner can take a while to do.
const TIMEOUT_MS = 120_000;

const child = spawn(electronBinary(), [...launchFlags(), IDE_ROOT, '--codexr-smoke', `--folder=${IDE_ROOT}`], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, CODEXR_IDE_DEV_SERVER_URL: '' },
});

let stdout = '';
child.stdout.on('data', (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
});

const timer = setTimeout(() => {
    console.error(`[smoke] no result after ${TIMEOUT_MS / 1000}s, killing Electron.`);
    child.kill();
}, TIMEOUT_MS);

child.on('exit', (code) => {
    clearTimeout(timer);
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith(PREFIX));
    if (!line) {
        console.error(`[smoke] FAILED: Electron exited with ${code} and printed no result.`);
        process.exit(1);
    }
    const result = JSON.parse(line.slice(PREFIX.length));
    if (result.ok && code === 0) {
        console.log(`[smoke] OK on ${result.platform}: window opened, renderer sandboxed, CSP and navigation guards active, IPC answered, explorer listed the folder and refused to leave it, Monaco opened a file with no CSP violation, the terminal (${result.terminal?.profile}) ran echo and drew its output.`);
        process.exit(0);
    }
    console.error(`[smoke] FAILED on ${result.platform}:\n - ${result.failures.join('\n - ')}`);
    process.exit(1);
});

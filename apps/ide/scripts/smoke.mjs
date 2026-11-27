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
        console.log(`[smoke] OK on ${result.platform}: window opened, renderer sandboxed, CSP and navigation guards active, IPC answered, explorer listed the folder and refused to leave it, Monaco opened a file, F1 opened the command palette, quick open found a file, the Search view found a symbol, the status bar showed the editor position, the layout resized, toggled and saved, zen mode answered its chord, preview tabs replaced each other and the tab menu closed them, the Settings view changed the editor font, the Output panel showed the logs, the Problems panel opened, file icons loaded from the app, no CSP violation, the terminal (${result.terminal?.profile}) ran echo and drew its output, found it with Ctrl/Cmd+F and opened a file link at its line.`);
        process.exit(0);
    }
    const reasons = [...result.failures];
    if (code !== 0) {
        reasons.push(`Electron exited with code ${code}${result.ok ? ' although every check passed' : ''}`);
    }
    console.error(`[smoke] FAILED on ${result.platform}:\n - ${reasons.join('\n - ')}`);
    process.exit(1);
});

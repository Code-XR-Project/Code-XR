// #262: the Code-XR VS Code extension, installed from its .vsix, runs inside
// the built IDE. Launches the IDE with Playwright on a throw-away profile and
// folder, installs the package through the real install path (only the file
// dialog is answered by the script), then checks that the Code-XR activity
// bar container shows its tree, and that no vscode API the extension used at
// start-up is missing from the host.
//
// Usage: node scripts/vsixE2e.mjs <path to code-xr-<version>.vsix>
// (after `node scripts/build.mjs`; on Linux CI under xvfb-run).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { IDE_ROOT } from './viteConfigs.mjs';
import { electronBinary, launchFlags } from './electronBinary.mjs';

const vsix = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (!vsix || !fs.existsSync(vsix)) {
    console.error(`[vsix-e2e] no .vsix at '${process.argv[2] ?? ''}'.`);
    process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-vsix-e2e-profile-'));
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-vsix-e2e-folder-'));
fs.writeFileSync(path.join(folder, 'main.py'), 'def add(a, b):\n    return a + b\n');

const failures = [];
const app = await _electron.launch({
    executablePath: electronBinary(),
    args: [...launchFlags(), IDE_ROOT, `--folder=${folder}`],
    // XDG_CONFIG_HOME isolates the profile on Linux; APPDATA on Windows; macOS uses HOME.
    env: { ...process.env, CODEXR_IDE_DEV_SERVER_URL: '', XDG_CONFIG_HOME: profile, APPDATA: profile, HOME: process.platform === 'darwin' ? profile : process.env.HOME },
    timeout: 60_000,
});
try {
    // Native questions: install the package (yes); the IDE's own Python environment (no, it is not what this checks).
    await app.evaluate(({ dialog }, file) => {
        dialog.showMessageBox = async (first, second) => {
            const options = second ?? first;
            const python = /python|virtual environment/i.test(`${options.message ?? ''} ${options.detail ?? ''}`);
            return { response: python ? options.cancelId ?? 1 : 0, checkboxChecked: false };
        };
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, vsix);
    const win = await app.firstWindow();
    await win.waitForSelector('[data-testid="welcome"]', { timeout: 60_000 });
    // Extensions with code run in a trusted folder only (Restricted Mode keeps them off).
    await win.evaluate(() => window.codexr.workspace.setTrust('folder'));

    const installed = await win.evaluate(() => window.codexr.extensions.installVsix());
    if (!installed.ok) {
        throw new Error(`install failed: ${installed.error}`);
    }
    console.log(`[vsix-e2e] installed ${installed.extension.id} ${installed.extension.version}`);

    const item = await win.waitForSelector('.activity-item[data-view="ext:codexr"]', { timeout: 30_000 });
    await item.click();
    let rows = [];
    for (let attempt = 0; attempt < 60 && rows.length === 0; attempt++) {
        await wait(500);
        rows = await win.$$eval('[data-testid="ext-tree-codexrTree"] .ext-tree-row', (elements) => elements.map((row) => row.getAttribute('aria-label') ?? ''));
    }
    console.log(`[vsix-e2e] tree: ${rows.join(' | ')}`);
    for (const section of ['SERVERS', 'ANALYSIS']) {
        if (!rows.some((row) => row.startsWith(section))) {
            failures.push(`the Code-XR tree has no ${section} section`);
        }
    }

    const lines = await win.evaluate(() => window.codexr.output.lines('extensions'));
    const activated = lines.some((line) => line.includes('[amontesl.code-xr] Activated'));
    if (!activated) {
        failures.push('the extension did not activate');
    }
    const missing = lines.filter((line) => line.includes('which the Code-XR IDE does not implement yet'));
    for (const line of missing) {
        failures.push(`missing API: ${line.replace(/^.*uses /, '')}`);
    }
    const failed = lines.filter((line) => /Activation of .* failed|failed to activate/i.test(line));
    failures.push(...failed);
} catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
} finally {
    await app.close().catch(() => undefined);
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(folder, { recursive: true, force: true });
}

if (failures.length > 0) {
    console.error(`[vsix-e2e] FAILED:\n- ${failures.join('\n- ')}`);
    process.exit(1);
}
console.log('[vsix-e2e] OK: the Code-XR extension installed from its .vsix, activated, and its tree view shows in the IDE.');

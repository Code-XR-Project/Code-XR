import { app, dialog, net, shell, type BrowserWindow } from 'electron';
import { log } from '../log.ts';
import { pickUpdate, RELEASES_API, type AvailableUpdate } from './updateRelease.ts';

/**
 * Checking for a newer Code-XR IDE (#20). An update check is a network call,
 * so it only happens when the person asks for it: Help > Check for Updates…,
 * or at start-up once they turned on `update.checkOnStartup` (off by default).
 *
 * It reads the repository's public GitHub releases and nothing else: no
 * identifier is sent, nothing is downloaded or installed. A newer release is
 * offered as a link to its page, where the person downloads the installer.
 */
const TIMEOUT_MS = 10_000;

async function fetchReleases(): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await net.fetch(RELEASES_API, { signal: controller.signal, headers: { accept: 'application/vnd.github+json' } });
        if (!response.ok) {
            throw new Error(`GitHub answered ${response.status}`);
        }
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

async function show(win: BrowserWindow | undefined, options: Electron.MessageBoxOptions): Promise<number> {
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return response;
}

/**
 * `manual`: the person picked Help > Check for Updates…, so every outcome
 * is answered (up to date, or why the check failed). The start-up check
 * speaks only when there is an update.
 */
export async function checkForUpdates(win: BrowserWindow | undefined, options: { readonly manual: boolean }): Promise<void> {
    let update: AvailableUpdate | null;
    try {
        update = pickUpdate(await fetchReleases(), app.getVersion());
    } catch (error) {
        log.warn(`Update check failed: ${String(error)}`);
        if (options.manual) {
            await show(win, { type: 'warning', title: 'Check for Updates', message: 'Could not check for updates.', detail: String(error), noLink: true });
        }
        return;
    }
    if (!update) {
        log.info(`Update check: ${app.getVersion()} is the latest Code-XR IDE.`);
        if (options.manual) {
            await show(win, { type: 'info', title: 'Check for Updates', message: `Code-XR IDE ${app.getVersion()} is the latest version.`, noLink: true });
        }
        return;
    }
    const choice = await show(win, {
        type: 'info',
        title: 'Update available',
        message: `Code-XR IDE ${update.version} is available.`,
        detail: `You have ${app.getVersion()}. The release page has the installer for your system.`,
        buttons: ['Open the release page', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
    });
    if (choice === 0) {
        await shell.openExternal(update.url);
    }
}

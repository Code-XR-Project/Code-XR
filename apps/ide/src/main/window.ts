import { BrowserWindow, nativeTheme } from 'electron';
import { assertSecureWebPreferences, secureWebPreferences } from './security.ts';

export interface MainWindowOptions {
    readonly preloadPath: string;
    readonly url: string;
    /** Smoke runs keep the window hidden: they only need it to load. */
    readonly show: boolean;
}

export async function createMainWindow(options: MainWindowOptions): Promise<BrowserWindow> {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 640,
        minHeight: 400,
        title: 'Code-XR',
        show: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1319' : '#ffffff',
        webPreferences: secureWebPreferences(options.preloadPath),
    });

    // Startup assertion: what the window actually runs with, not what was
    // asked for. If anything weakens these the IDE refuses to start.
    assertSecureWebPreferences(effectiveWebPreferences(win));

    if (options.show) {
        win.once('ready-to-show', () => win.show());
    }
    await win.loadURL(options.url);
    return win;
}

/**
 * `webContents.getLastWebPreferences()` exists at runtime (Electron uses it in
 * its own tests) but is missing from electron.d.ts. If a future Electron drops
 * it, this returns null and the assertion fails closed: the IDE does not start.
 */
function effectiveWebPreferences(win: BrowserWindow): Record<string, unknown> | null {
    const contents = win.webContents as unknown as { getLastWebPreferences?: () => Record<string, unknown> | null };
    return typeof contents.getLastWebPreferences === 'function' ? contents.getLastWebPreferences() : null;
}

import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'node:path';
import { applyProcessHardening } from './hardening.ts';
import { registerAppSchemeAsPrivileged, serveRenderer } from './appProtocol.ts';
import { registerIpcHandlers } from './ipc.ts';
import { startCore } from './core/coreRuntime.ts';
import { installApplicationMenu } from './menu.ts';
import { createMainWindow } from './window.ts';
import { runSmoke, SMOKE_FLAG, SMOKE_RESULT_PREFIX } from './smoke.ts';
import { APP_ORIGIN, trustedOrigins } from './security.ts';
import { log } from './log.ts';
import { IPC_EVENTS } from '../shared/api.ts';
import { folderArgument } from './workspace/workspacePath.ts';
import { initRecentFolders, openRecentFolder, recentFolderList, setWorkspace } from './workspace/workspaceWindows.ts';
import { chooseStartupFolder } from './workspace/startupFolder.ts';
import { createTerminalHost, type TerminalHost } from './terminal/terminalHost.ts';

// Layout of the build output (see scripts/build.mjs): out/main/index.cjs is
// this file, next to out/preload/index.cjs and out/renderer/.
const OUT_DIR = path.resolve(__dirname, '..');
const PRELOAD_PATH = path.join(OUT_DIR, 'preload', 'index.cjs');
const RENDERER_DIR = path.join(OUT_DIR, 'renderer');

// The dev server is honoured only from an unpackaged build, so an installed
// IDE can never be pointed at another origin through the environment.
const devServerUrl = app.isPackaged ? undefined : process.env.CODEXR_IDE_DEV_SERVER_URL || undefined;
const devServerOrigin = devServerUrl ? new URL(devServerUrl).origin : undefined;
const isDevelopment = devServerUrl !== undefined;
const isSmoke = process.argv.includes(SMOKE_FLAG);

const origins = trustedOrigins(devServerOrigin);

registerAppSchemeAsPrivileged();
applyProcessHardening(origins, devServerOrigin);

if (!isSmoke && !app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const [win] = BrowserWindow.getAllWindows();
        if (win) {
            if (win.isMinimized()) { win.restore(); }
            win.focus();
        }
    });
    app.whenReady().then(start).catch((error: unknown) => {
        log.error('Startup failed.', error);
        app.exit(1);
    });
}

// #137: every pty dies with the app. `app.exit` (the smoke run) skips
// will-quit, so that path kills them itself.
let terminals: TerminalHost | null = null;
app.on('will-quit', () => void terminals?.killAll());

async function start(): Promise<void> {
    nativeTheme.themeSource = 'system';
    if (!isDevelopment) {
        serveRenderer(RENDERER_DIR);
    }
    const terminalHost = createTerminalHost({ isSmoke });
    terminals = terminalHost;
    registerIpcHandlers(origins, isDevelopment, startCore({ isSmoke }), terminalHost);
    installApplicationMenu(isDevelopment);
    if (!isSmoke) {
        await initRecentFolders(path.join(app.getPath('userData'), 'recent-folders.json'), (list) => installApplicationMenu(isDevelopment, list))
            .catch((error: unknown) => log.warn(`Recent folders unavailable: ${String(error)}`));
    }

    const win = await openMainWindow();
    log.info(`Window loaded from ${win.webContents.getURL()}${isDevelopment ? ' (dev server)' : ''}.`);

    const startup = chooseStartupFolder(folderArgument(process.argv), recentFolderList(), isSmoke);
    if (startup.kind !== 'none') {
        try {
            // #151: the last folder goes through the recent list, which drops it if it is gone.
            const info = startup.kind === 'argument'
                ? await setWorkspace(win.webContents, startup.folder)
                : await openRecentFolder(win.webContents, startup.folder);
            win.webContents.send(IPC_EVENTS.workspaceChanged, info);
        } catch (error) {
            log.warn(`Could not reopen ${startup.folder}: ${String(error)}`);
        }
    }

    if (isSmoke) {
        const result = await runSmoke(win, origins);
        process.stdout.write(`${SMOKE_RESULT_PREFIX}${JSON.stringify(result)}\n`);
        await terminalHost.killAll();
        app.exit(result.ok ? 0 : 1);
        return;
    }

    app.on('activate', () => {
        // macOS: re-open a window when the dock icon is clicked and none is open.
        if (BrowserWindow.getAllWindows().length === 0) {
            void openMainWindow();
        }
    });
}

function openMainWindow(): Promise<BrowserWindow> {
    return createMainWindow({
        preloadPath: PRELOAD_PATH,
        url: devServerUrl ?? `${APP_ORIGIN}/index.html`,
        show: !isSmoke,
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

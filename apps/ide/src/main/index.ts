import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'node:path';
import { applyProcessHardening } from './hardening.ts';
import { registerAppSchemeAsPrivileged, serveRenderer } from './appProtocol.ts';
import { registerIpcHandlers } from './ipc.ts';
import { fileStorage, memoryStorage, SettingsService } from './settings/settingsService.ts';
import { KeybindingsService } from './settings/keybindingsService.ts';
import { KEYBINDINGS_FILE_NAME } from '../shared/keybindings.ts';
import { applyColorTheme } from './settings/theme.ts';
import { OutputService } from './outputPanel/outputService.ts';
import { COLOR_THEME_SETTING } from '../shared/settings.ts';
import { startCore, type CoreServices } from './core/coreRuntime.ts';
import { installApplicationMenu, setAboutDependencies } from './menu.ts';
import { checkForUpdates } from './updates/updateCheck.ts';
import { canRepair, describeDependencies, formatDependencies } from './dependencies/dependencyReport.ts';
import { createMainWindow } from './window.ts';
import { runSmoke, SMOKE_FLAG, SMOKE_RESULT_PREFIX } from './smoke.ts';
import { initWorkspaceTrust } from './trust/workspaceTrust.ts';
import { JsonKeyValueStore } from './core/jsonStore.ts';
import { APP_ORIGIN, trustedOrigins } from './security.ts';
import { log } from './log.ts';
import { IPC_EVENTS } from '../shared/api.ts';
import { folderArgument } from './workspace/workspacePath.ts';
import { initRecentFolders, openRecentFolder, recentFolderList, setWorkspace } from './workspace/workspaceWindows.ts';
import { chooseStartupFolder } from './workspace/startupFolder.ts';
import { createTerminalHost, type TerminalHost } from './terminal/terminalHost.ts';
import { startAgents, type AgentServices } from './agents/agentsRuntime.ts';
import { startAgentSessions, type AgentSessionsRuntime } from './agentSessions/agentSessionsRuntime.ts';
import { setScenePreloadPath } from './analysis/sceneView.ts';
import { appIconPath } from './appIcon.ts';
import { createLspHost, type LspHost } from './lsp/lspHost.ts';
import { stopAllDebugSessions } from './debug/debugHost.ts';

// Layout of the build output (see scripts/build.mjs): out/main/index.cjs is
// this file, next to out/preload/index.cjs and out/renderer/.
const OUT_DIR = path.resolve(__dirname, '..');
const PRELOAD_PATH = path.join(OUT_DIR, 'preload', 'index.cjs');
/** #16: the scene view's own preload (only `CodeXRHostBridge.openInEditor`). */
const SCENE_PRELOAD_PATH = path.join(OUT_DIR, 'scenePreload', 'index.cjs');
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
// A12: MCP server processes likewise.
let agentServices: AgentServices | null = null;
// AF1: coding agents (one process per chat) likewise; their chats are written first.
let agentSessions: AgentSessionsRuntime | null = null;
// #21: so do the language servers.
let languageServers: LspHost | null = null;
app.on('will-quit', () => {
    void terminals?.killAll();
    void agentServices?.mcp.closeAll();
    void agentSessions?.service.stopAll();
    void languageServers?.stopAll();
    // #180: debug sessions end their adapter and their program.
    void stopAllDebugSessions();
});

async function start(): Promise<void> {
    // #174: the Output panel collects from the first line on.
    const output = new OutputService();
    output.install();
    nativeTheme.themeSource = 'system';
    if (!isDevelopment) {
        serveRenderer(RENDERER_DIR);
    }
    const terminalHost = createTerminalHost({ isSmoke });
    terminals = terminalHost;
    setScenePreloadPath(SCENE_PRELOAD_PATH);
    // macOS shows the dock icon, not the window's: the Code-XR logo there too.
    app.dock?.setIcon(appIconPath());
    const core = startCore({ isSmoke });
    setAboutDependencies({
        async describe() {
            const [python, parsers, cloudflared] = await Promise.all([core.python.status(), core.python.parsersStatus(), core.cloudflared.status()]);
            return { text: formatDependencies(describeDependencies(python, parsers, cloudflared)), repairable: canRepair(python, cloudflared) };
        },
        repair: () => void installDependencies(core),
    });
    // #18: the user's settings; the smoke run keeps its own in memory.
    const settings = new SettingsService(isSmoke ? memoryStorage() : fileStorage(path.join(app.getPath('userData'), 'settings.json')));
    // #18, part 3: the user's keybindings, likewise in memory for the smoke run.
    const keybindingsFile = path.join(app.getPath('userData'), KEYBINDINGS_FILE_NAME);
    const keybindings = isSmoke ? new KeybindingsService(memoryStorage(), null) : new KeybindingsService(fileStorage(keybindingsFile), keybindingsFile);
    agentServices = startAgents({ isSmoke, commandRunner: terminalHost.commandRunner });
    // The smoke run may never start an agent: the service refuses to spawn there.
    agentSessions = startAgentSessions({ isSmoke, terminal: terminalHost, profiles: agentServices.profiles, analysisOutput: (contents) => core.analysis.outputDirectory(contents) });
    // #177: workspace trust decisions, in the user-data folder (in memory for the smoke run).
    const trustFile = isSmoke ? null : new JsonKeyValueStore(path.join(app.getPath('userData'), 'workspace-trust.json'));
    let smokeTrust: unknown = [];
    initWorkspaceTrust({
        load: () => (trustFile ? trustFile.get('folders') : smokeTrust),
        save: async (decisions) => {
            if (trustFile) {
                await trustFile.update('folders', decisions);
            } else {
                smokeTrust = decisions;
            }
        },
    });
    const lsp = createLspHost();
    languageServers = lsp;
    registerIpcHandlers(origins, isDevelopment, core, terminalHost, settings, keybindings, output, agentServices, lsp, agentSessions);
    // #171: the stored theme, before the first window paints.
    applyColorTheme((await settings.snapshot(null)).effective[COLOR_THEME_SETTING]);
    installApplicationMenu(isDevelopment);
    if (!isSmoke) {
        await initRecentFolders(path.join(app.getPath('userData'), 'recent-folders.json'), (list) => installApplicationMenu(isDevelopment, list))
            .catch((error: unknown) => log.warn(`Recent folders unavailable: ${String(error)}`));
    }

    const win = await openMainWindow();
    log.info(`Window loaded from ${win.webContents.getURL()}${isDevelopment ? ' (dev server)' : ''}.`);
    // #20: an update check is a network call, so it runs unasked only once the person turned it on.
    if (!isSmoke && (await settings.snapshot(null)).effective['update.checkOnStartup'] === true) {
        void checkForUpdates(win, { manual: false });
    }

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

    // #154: the IDE installs its own analysis dependencies, with progress in the
    // window's notifications, never in the smoke run (it must download nothing).
    if (!isSmoke) {
        void installDependencies(core);
    }

    if (isSmoke) {
        const result = await runSmoke(win, origins);
        process.stdout.write(`${SMOKE_RESULT_PREFIX}${JSON.stringify(result)}\n`);
        await terminalHost.killAll();
        await lsp.stopAll();
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

/**
 * #154/#160: the IDE installs what it needs with no question: the Python
 * environment, then cloudflared, one download at a time. Never throws.
 */
async function installDependencies(core: CoreServices): Promise<void> {
    await core.python.ensureReady().catch((error: unknown) => log.error('Could not set up the Python environment.', error));
    await core.cloudflared.ensureInstalled();
}

import { app, BrowserWindow, clipboard, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import type { CoreServices } from './core/coreRuntime.ts';
import { ALLOWED_IPC_CHANNELS, AUTO_START_MODES, FILE_ANALYSIS_KINDS, IPC_CHANNELS, IPC_EVENTS, PROJECT_ANALYSIS_KINDS, SCENE_ADDRESSES, type FileAnalysisKind, type ProjectAnalysisKind, type AppInfo, type AutoStartMode, type SceneAddress } from '../shared/api.ts';
import type { TerminalHost } from './terminal/terminalHost.ts';
import type { AgentServices } from './agents/agentsRuntime.ts';
import { registerAgentHandlers } from './agents/agentsIpc.ts';
import { registerGitHandlers } from './git/gitIpc.ts';
import type { LspHost } from './lsp/lspHost.ts';
import { registerLspHandlers } from './lsp/lspIpc.ts';
import { registerTaskHandlers } from './tasks/taskHost.ts';
import type { ExtensionsService } from './extensions/extensionsService.ts';
import { registerDebugHandlers } from './debug/debugHost.ts';
import { reportUnsaved } from './unsavedGuard.ts';
import { isOpenableExternalLink, isTrustedIpcCall } from './security.ts';
import { log } from './log.ts';
import { setSceneBounds, windowOfScene } from './analysis/sceneView.ts';
import { SCENE_OPEN_IN_EDITOR_CHANNEL, toSceneEditorTarget } from '../shared/sceneBridge.ts';
import { sanitizeBounds } from './analysis/sceneUrl.ts';
import { currentWorkspaceInfo, openRecentFolder, pickAndOpenFolder, recentFolderList, workspaceOf, workspaceOrNull } from './workspace/workspaceWindows.ts';
import type { SettingsService } from './settings/settingsService.ts';
import type { KeybindingsService } from './settings/keybindingsService.ts';
import type { OutputService } from './outputPanel/outputService.ts';
import { setMenuAccelerators } from './menu.ts';
import { applyColorTheme, previewColorTheme } from './settings/theme.ts';
import { COLOR_THEME_SETTING } from '../shared/settings.ts';
import { cancelSearch, replaceInFiles, startSearch } from './workspace/searchService.ts';
import { setWorkspaceTrust, trustInfoOf } from './trust/workspaceTrust.ts';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/**
 * Registers the main-process side of `window.codexr`. Every handler goes
 * through `handle`, which refuses calls from frames outside the trusted
 * origins, so a handler never has to check its caller itself.
 */
export function registerIpcHandlers(origins: ReadonlySet<string>, isDevelopment: boolean, core: CoreServices, terminal: TerminalHost, settings: SettingsService, keybindings: KeybindingsService, output: OutputService, agents: AgentServices, lsp: LspHost, extensions: ExtensionsService): void {
    const registered = new Set<string>();
    const handle = (channel: string, handler: Handler): void => {
        if (!ALLOWED_IPC_CHANNELS.has(channel)) {
            throw new Error(`IPC channel ${channel} is not in IPC_CHANNELS.`);
        }
        ipcMain.handle(channel, (event, ...args) => {
            if (!isTrustedIpcCall(channel, event.senderFrame?.url, ALLOWED_IPC_CHANNELS, origins)) {
                log.warn(`Refused IPC ${channel} from ${event.senderFrame?.url ?? 'an unknown frame'}`);
                throw new Error('Refused.');
            }
            return handler(event, ...args);
        });
        registered.add(channel);
    };

    handle(IPC_CHANNELS.appGetInfo, (): AppInfo => ({
        name: 'Code-XR IDE',
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        versions: {
            electron: process.versions.electron ?? '',
            chrome: process.versions.chrome ?? '',
            node: process.versions.node,
        },
        isDevelopment,
    }));

    // #14: the folder open in the calling window. Paths are workspace-relative
    // and validated by Workspace; a window only ever reaches its own folder.
    handle(IPC_CHANNELS.workspaceOpenFolder, (event) => pickAndOpenFolder(event.sender));
    handle(IPC_CHANNELS.workspaceCurrent, (event) => currentWorkspaceInfo(event.sender));
    handle(IPC_CHANNELS.workspaceListDirectory, (event, path) => workspaceOf(event.sender).listDirectory(path));
    handle(IPC_CHANNELS.workspaceListFiles, (event) => workspaceOf(event.sender).listFiles());
    // #165: search runs in the background; its results arrive as events.
    handle(IPC_CHANNELS.workspaceSearch, (event, searchId, query) => {
        void startSearch(event.sender, workspaceOf(event.sender), searchId, query);
    });
    handle(IPC_CHANNELS.workspaceCancelSearch, (event, searchId) => cancelSearch(event.sender, searchId));
    handle(IPC_CHANNELS.workspaceReplaceInFiles, (event, query, replacement, paths) =>
        replaceInFiles(workspaceOf(event.sender), query, replacement, paths));
    handle(IPC_CHANNELS.workspaceReadFile, (event, path) => workspaceOf(event.sender).readFile(path));
    handle(IPC_CHANNELS.workspaceWriteFile, async (event, path, text, expectedMtimeMs) => {
        const workspace = workspaceOf(event.sender);
        const result = await workspace.writeFile(path, text, expectedMtimeMs);
        // #173: a saved file is measured again for the Problems panel (when an analysis measured its folder).
        core.metrics.fileSaved(event.sender, workspace.root, String(path), workspace.displayPath(path, 'absolute'));
        return result;
    });
    handle(IPC_CHANNELS.workspaceSetWatched, (event, entries) => {
        const sender = event.sender;
        const workspace = workspaceOf(sender);
        workspace.setWatched(entries, (paths) => {
            if (!sender.isDestroyed()) {
                sender.send(IPC_EVENTS.workspaceFilesChanged, paths);
            }
            // #178: a measured file changed on disk (another program, a git checkout): its lenses are measured again.
            for (const path of paths) {
                if (core.metrics.knows(sender, workspace.root, path)) {
                    core.metrics.fileSaved(sender, workspace.root, path, workspace.displayPath(path, 'absolute'));
                }
            }
        });
    });
    handle(IPC_CHANNELS.workspaceReportUnsaved, (event, count) => reportUnsaved(event.sender, count));
    handle(IPC_CHANNELS.workspaceCreateEntry, (event, parent, name, kind) => workspaceOf(event.sender).createEntry(parent, name, kind));
    handle(IPC_CHANNELS.workspaceRename, (event, path, newName) => workspaceOf(event.sender).rename(path, newName));
    // #18: settings. A change to the user's settings reaches every window; a folder's, its own window.
    handle(IPC_CHANNELS.settingsGet, (event) => settings.snapshot(workspaceOrNull(event.sender)));
    handle(IPC_CHANNELS.settingsUpdate, async (event, scope, key, value) => {
        const report = await settings.update(workspaceOrNull(event.sender), scope, key, value);
        if (key === COLOR_THEME_SETTING) {
            applyColorTheme(report.effective[COLOR_THEME_SETTING]);
        }
        for (const win of BrowserWindow.getAllWindows()) {
            const contents = win.webContents;
            if (contents.isDestroyed()) { continue; }
            if (contents === event.sender) {
                contents.send(IPC_EVENTS.settingsChanged, report);
            } else if (scope === 'user') {
                contents.send(IPC_EVENTS.settingsChanged, await settings.snapshot(workspaceOrNull(contents)));
            }
        }
        return report;
    });
    // #171: the theme picker previews before the choice is stored.
    handle(IPC_CHANNELS.settingsPreviewTheme, (_event, theme) => previewColorTheme(theme));
    handle(IPC_CHANNELS.settingsFolderFile, (event) => settings.ensureFolderFile(workspaceOf(event.sender)));
    // #18, part 3: the user's keybindings are one file for every window, so every window hears a change.
    // #174: the Output panel.
    handle(IPC_CHANNELS.outputLines, (_event, channel) => output.lines(channel));
    handle(IPC_CHANNELS.outputClear, (_event, channel) => output.clear(channel));
    handle(IPC_CHANNELS.keybindingsGet, () => keybindings.snapshot());
    handle(IPC_CHANNELS.keybindingsUpdate, async (_event, entries) => {
        const report = await keybindings.update(entries);
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.webContents.isDestroyed()) {
                win.webContents.send(IPC_EVENTS.keybindingsChanged, report);
            }
        }
        return report;
    });
    handle(IPC_CHANNELS.keybindingsSetMenu, (_event, accelerators) => setMenuAccelerators(accelerators));
    // #167: the path is checked against the folder before anything reaches the clipboard.
    handle(IPC_CHANNELS.workspaceCopyPath, (event, path, kind) => {
        clipboard.writeText(workspaceOf(event.sender).displayPath(path, kind));
    });
    // #179: the Markdown preview's images and links; the path and the URL are checked here.
    // #177: the trust of the window's own folder; the choice is checked in workspaceTrust.ts.
    handle(IPC_CHANNELS.workspaceTrust, (event) => trustInfoOf(event.sender));
    handle(IPC_CHANNELS.workspaceSetTrust, (event, choice) => setWorkspaceTrust(event.sender, choice));
    handle(IPC_CHANNELS.workspaceReadImage, (event, path) => workspaceOf(event.sender).readImage(path));
    handle(IPC_CHANNELS.workspaceReadDocument, (event, path) => workspaceOf(event.sender).readDocument(path));
    handle(IPC_CHANNELS.workspaceOpenExternalLink, async (_event, url) => {
        if (!isOpenableExternalLink(url)) {
            throw new Error('Only http, https and mailto links open outside the IDE.');
        }
        await shell.openExternal(url);
    });
    handle(IPC_CHANNELS.workspaceTrash, (event, path) => workspaceOf(event.sender).trash(path, (absolute) => shell.trashItem(absolute)));
    handle(IPC_CHANNELS.workspaceRecentFolders, () => recentFolderList());
    handle(IPC_CHANNELS.workspaceOpenRecent, (event, folder) => openRecentFolder(event.sender, folder));

    // #15: the Python environment. #154: set-up asks nothing; the IDE installs its own dependencies.
    handle(IPC_CHANNELS.problemsFunctionMetrics, (event) => core.metrics.snapshot(event.sender));
    // #172: the outline of a file no analysis measured asks the backend for that file alone.
    handle(IPC_CHANNELS.problemsFileFunctions, (event, path) => {
        const workspace = workspaceOf(event.sender);
        return core.metrics.fileFunctions(event.sender, workspace.root, String(path), workspace.displayPath(path, 'absolute'));
    });
    handle(IPC_CHANNELS.pythonStatus, () => core.python.status());
    handle(IPC_CHANNELS.pythonSetUp, () => core.python.setUp());
    handle(IPC_CHANNELS.pythonRemove, () => core.python.remove());

    // #16: analyses, and the scene view beside the code.
    handle(IPC_CHANNELS.analysisAnalyseProject, (event, kind, options) => {
        const win = ownerOf(event);
        if (!(PROJECT_ANALYSIS_KINDS as readonly unknown[]).includes(kind)) {
            throw new Error(`Unknown analysis kind: ${String(kind)}`);
        }
        const auto = typeof options === 'object' && options !== null && (options as { auto?: unknown }).auto === true;
        return core.analysis.analyseProject(win, currentWorkspaceInfo(event.sender)?.root, kind as ProjectAnalysisKind, { auto });
    });
    handle(IPC_CHANNELS.analysisAnalyseFile, (event, kind, relativePath) => {
        const win = ownerOf(event);
        if (!(FILE_ANALYSIS_KINDS as readonly unknown[]).includes(kind)) {
            throw new Error(`Unknown analysis kind: ${String(kind)}`);
        }
        return core.analysis.analyseFile(win, currentWorkspaceInfo(event.sender)?.root, kind as FileAnalysisKind, relativePath);
    });
    handle(IPC_CHANNELS.analysisGetAutoStart, () => core.analysis.autoStart());
    handle(IPC_CHANNELS.analysisSetAutoStart, (_event, mode) => {
        if (!(AUTO_START_MODES as readonly unknown[]).includes(mode)) {
            throw new Error(`Unknown auto-start mode: ${String(mode)}`);
        }
        return core.analysis.setAutoStart(mode as AutoStartMode);
    });
    // #16: the one message an analysis page may send, from the scene view's
    // own preload. It is not a `window.codexr` channel: the sender must be a
    // scene view's main frame, and the main process resolves and checks the
    // path before the window's renderer opens anything.
    ipcMain.on(SCENE_OPEN_IN_EDITOR_CHANNEL, (event, value) => {
        const win = windowOfScene(event.sender);
        const target = toSceneEditorTarget(value);
        if (!win || win.isDestroyed() || !target || event.senderFrame !== event.sender.mainFrame) {
            return;
        }
        const request = core.analysis.openFromScene(win, currentWorkspaceInfo(win.webContents)?.root, target);
        if (request) {
            win.webContents.send(IPC_EVENTS.analysisOpenInEditor, request);
            win.focus();
            win.webContents.focus();
        }
    });
    handle(IPC_CHANNELS.analysisSetSceneBounds, (event, bounds) => setSceneBounds(ownerOf(event), sanitizeBounds(bounds)));
    handle(IPC_CHANNELS.analysisCloseScene, (event) => core.analysis.closeScene(ownerOf(event)));
    // #155: sharing acts on the calling window's scene only; no server id or URL comes from the page.
    handle(IPC_CHANNELS.analysisShareScene, (event) => core.analysis.shareScene(ownerOf(event)));
    handle(IPC_CHANNELS.analysisStopSharingScene, (event) => core.analysis.stopSharingScene(ownerOf(event)));
    handle(IPC_CHANNELS.analysisCopySceneAddress, (event, which) => {
        if (!(SCENE_ADDRESSES as readonly unknown[]).includes(which)) {
            throw new Error(`Unknown scene address: ${String(which)}`);
        }
        core.analysis.copySceneAddress(ownerOf(event), which as SceneAddress);
    });
    // #178: a workspace path only, resolved inside the calling window's folder.
    handle(IPC_CHANNELS.analysisRevealInScene, (event, path) => core.analysis.revealInScene(event.sender, workspaceOf(event.sender).displayPath(path, 'absolute')));
    // #19: XR acts on the calling window's scene only, like sharing.
    handle(IPC_CHANNELS.analysisEnterXr, (event) => core.analysis.enterXr(ownerOf(event)));
    handle(IPC_CHANNELS.analysisOpenSceneInBrowser, (event) => core.analysis.openSceneInBrowser(ownerOf(event), (url) => shell.openExternal(url)));
    handle(IPC_CHANNELS.analysisHeadsetLink, (event) => core.analysis.headsetLink(ownerOf(event)));
    // #137: the terminal. Profiles are addressed by id only; a terminal only by
    // the window that created it (TerminalService checks the owner).
    handle(IPC_CHANNELS.terminalProfiles, () => terminal.profiles());
    handle(IPC_CHANNELS.terminalSetDefaultProfile, (_event, id) => terminal.setDefaultProfile(id));
    handle(IPC_CHANNELS.terminalAddCustomProfile, (event, args) => terminal.addCustomProfile(event.sender, args));
    handle(IPC_CHANNELS.terminalRemoveCustomProfile, (_event, id) => terminal.removeCustomProfile(id));
    handle(IPC_CHANNELS.terminalCreate, (event, profileId, cols, rows) => terminal.create(event.sender, profileId, cols, rows));
    handle(IPC_CHANNELS.terminalInput, (event, id, data) => terminal.input(event.sender, id, data));
    handle(IPC_CHANNELS.terminalResize, (event, id, cols, rows) => terminal.resize(event.sender, id, cols, rows));
    handle(IPC_CHANNELS.terminalKill, (event, id) => terminal.kill(event.sender, id));

    // The AI agent hub (agents/agentsIpc.ts).
    registerAgentHandlers(handle, agents, (contents) => core.analysis.outputDirectory(contents));
    // #17: Source Control (git/gitIpc.ts).
    registerGitHandlers(handle);
    // #21: language servers (lsp/lspIpc.ts).
    registerLspHandlers(handle, lsp);
    // #176: tasks and Run Current File (tasks/taskHost.ts), in trusted folders only.
    registerTaskHandlers(handle, terminal, settings);
    // #251: VS Code extensions (extensions/extensionsService.ts).
    extensions.register(handle);
    // #180: the debugger (debug/debugHost.ts), in trusted folders only.
    registerDebugHandlers(handle, settings, () => core.python);

    // Every channel in the contract must have a handler: a missing one would
    // only surface as a rejected promise in the renderer.
    for (const channel of ALLOWED_IPC_CHANNELS) {
        if (!registered.has(channel)) {
            throw new Error(`IPC channel ${channel} has no handler.`);
        }
    }
}

function ownerOf(event: IpcMainInvokeEvent): BrowserWindow {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
        throw new Error('The request came from no window.');
    }
    return win;
}

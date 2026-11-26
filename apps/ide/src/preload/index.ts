import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ColorTheme, SettingScope, SettingValue } from '../shared/settings.ts';
import type { UserKeybinding } from '../shared/keybindings.ts';
import type { OutputChannelId } from '../shared/output.ts';
import { IDE_COMMANDS, IPC_CHANNELS, IPC_EVENTS, type AnalysisKind, type AutoStartMode, type CodeXRApi, type HostNotification, type IdeCommand, type KeybindingsReport, type OutputAppended, type ProgressEvent, type PythonEnvStatus, type SceneAddress, type SceneBounds, type SceneInfo, type SceneShareEvent, type SearchDoneEvent, type SearchFileEvent, type SearchQuery, type SettingsReport, type TerminalDataEvent, type TerminalExitEvent, type Unsubscribe, type WatchedEntry, type WorkspaceInfo } from '../shared/api.ts';
import { AGENT_IPC_CHANNELS, AGENT_IPC_EVENTS, type AgentChatEvent, type AgentProfileInput, type ApprovalDecision, type EditReviewResult, type ChatAttachment, type ProviderInput } from '../shared/agents.ts';

const KNOWN_COMMANDS: ReadonlySet<string> = new Set(IDE_COMMANDS);

/**
 * The only bridge between the sandboxed renderer and the rest of the IDE.
 *
 * It exposes a frozen, typed object as `window.codexr`. It never exposes
 * `ipcRenderer` itself, a generic `invoke(channel)` or any Node API: each
 * member maps to exactly one allow-listed channel, so the renderer cannot
 * reach a channel that is not in `IPC_CHANNELS`. Event subscriptions hand the
 * listener the payload only, never the Electron event (which carries `sender`).
 *
 * Sandboxed preloads may only require('electron'); everything else this file
 * imports is bundled into it by scripts/build.mjs.
 */
/** Subscribes to a main-to-renderer event, handing the listener the payload only. */
function subscribe<T>(event: string, listener: (payload: T) => void): Unsubscribe {
    const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload);
    ipcRenderer.on(event, wrapped);
    return () => {
        ipcRenderer.removeListener(event, wrapped);
    };
}

const api: CodeXRApi = Object.freeze({
    // The AI agent hub: a stored API key never comes back through here.
    agents: Object.freeze({
        secretStore: () => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsSecretStore),
        listProviders: () => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsListProviders),
        saveProvider: (input: ProviderInput, id?: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsSaveProvider, input, id),
        removeProvider: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsRemoveProvider, id),
        testProvider: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsTestProvider, id),
        listAgents: () => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsListAgents),
        saveAgent: (input: AgentProfileInput, id?: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsSaveAgent, input, id),
        removeAgent: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsRemoveAgent, id),
        listSessions: () => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsListSessions),
        getSession: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsGetSession, id),
        createSession: (agentId: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsCreateSession, agentId),
        renameSession: (id: string, title: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsRenameSession, id, title),
        deleteSession: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsDeleteSession, id),
        exportSession: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsExportSession, id),
        send: (sessionId: string, text: string, attachments?: readonly ChatAttachment[]) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsSend, sessionId, text, attachments ?? []),
        stop: (sessionId: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsStop, sessionId),
        onChat: (listener: (event: AgentChatEvent) => void) => subscribe(AGENT_IPC_EVENTS.agentsChat, listener),
        tools: () => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsTools),
        approve: (requestId: string, decision: ApprovalDecision) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsApprove, requestId, decision),
        resolveReview: (requestId: string, result: EditReviewResult) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsResolveReview, requestId, result),
    }),
    app: Object.freeze({
        getInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appGetInfo),
        onNotification: (listener: (notification: HostNotification) => void) => subscribe(IPC_EVENTS.hostNotification, listener),
        onProgress: (listener: (progress: ProgressEvent) => void) => subscribe(IPC_EVENTS.progress, listener),
    }),
    python: Object.freeze({
        status: () => ipcRenderer.invoke(IPC_CHANNELS.pythonStatus),
        setUp: () => ipcRenderer.invoke(IPC_CHANNELS.pythonSetUp),
        remove: () => ipcRenderer.invoke(IPC_CHANNELS.pythonRemove),
        onDidChangeStatus: (listener: (status: PythonEnvStatus) => void) => subscribe(IPC_EVENTS.pythonStatusChanged, listener),
    }),
    analysis: Object.freeze({
        analyseProject: (kind: AnalysisKind, options?: { readonly auto?: boolean }) =>
            ipcRenderer.invoke(IPC_CHANNELS.analysisAnalyseProject, kind, { auto: options?.auto === true }),
        autoStart: () => ipcRenderer.invoke(IPC_CHANNELS.analysisGetAutoStart),
        setAutoStart: (mode: AutoStartMode) => ipcRenderer.invoke(IPC_CHANNELS.analysisSetAutoStart, mode),
        setSceneBounds: (bounds: SceneBounds | null) => ipcRenderer.invoke(IPC_CHANNELS.analysisSetSceneBounds, bounds),
        closeScene: () => ipcRenderer.invoke(IPC_CHANNELS.analysisCloseScene),
        onDidOpenScene: (listener: (scene: SceneInfo) => void) => subscribe(IPC_EVENTS.analysisSceneOpened, listener),
        // #155: no server id crosses the bridge; main acts on the calling window's scene.
        shareScene: () => ipcRenderer.invoke(IPC_CHANNELS.analysisShareScene),
        stopSharingScene: () => ipcRenderer.invoke(IPC_CHANNELS.analysisStopSharingScene),
        copySceneAddress: (which: SceneAddress) => ipcRenderer.invoke(IPC_CHANNELS.analysisCopySceneAddress, which),
        onDidChangeSceneShare: (listener: (event: SceneShareEvent) => void) => subscribe(IPC_EVENTS.analysisSceneShareChanged, listener),
    }),
    workspace: Object.freeze({
        openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenFolder),
        current: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceCurrent),
        listDirectory: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceListDirectory, path),
        listFiles: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceListFiles),
        search: (searchId: number, query: SearchQuery) => ipcRenderer.invoke(IPC_CHANNELS.workspaceSearch, searchId, query),
        cancelSearch: (searchId: number) => ipcRenderer.invoke(IPC_CHANNELS.workspaceCancelSearch, searchId),
        onSearchResult: (listener: (event: SearchFileEvent) => void) => subscribe(IPC_EVENTS.workspaceSearchResult, listener),
        onSearchDone: (listener: (event: SearchDoneEvent) => void) => subscribe(IPC_EVENTS.workspaceSearchDone, listener),
        replaceInFiles: (query: SearchQuery, replacement: string, paths: readonly string[]) =>
            ipcRenderer.invoke(IPC_CHANNELS.workspaceReplaceInFiles, query, replacement, paths),
        readFile: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceReadFile, path),
        writeFile: (path: string, text: string, expectedMtimeMs?: number) =>
            ipcRenderer.invoke(IPC_CHANNELS.workspaceWriteFile, path, text, expectedMtimeMs),
        setWatched: (entries: readonly WatchedEntry[]) => ipcRenderer.invoke(IPC_CHANNELS.workspaceSetWatched, entries),
        onDidChangeFiles: (listener: (paths: readonly string[]) => void) => {
            const wrapped = (_event: IpcRendererEvent, paths: readonly string[]): void => listener(paths);
            ipcRenderer.on(IPC_EVENTS.workspaceFilesChanged, wrapped);
            return () => {
                ipcRenderer.removeListener(IPC_EVENTS.workspaceFilesChanged, wrapped);
            };
        },
        reportUnsaved: (count: number) => ipcRenderer.invoke(IPC_CHANNELS.workspaceReportUnsaved, count),
        createEntry: (parent: string, name: string, kind: 'file' | 'directory') =>
            ipcRenderer.invoke(IPC_CHANNELS.workspaceCreateEntry, parent, name, kind),
        rename: (path: string, newName: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceRename, path, newName),
        copyPath: (path: string, kind: 'absolute' | 'relative') => ipcRenderer.invoke(IPC_CHANNELS.workspaceCopyPath, path, kind),
        trash: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceTrash, path),
        recentFolders: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceRecentFolders),
        openRecent: (folder: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenRecent, folder),
        onDidChange: (listener: (workspace: WorkspaceInfo | null) => void) => {
            const wrapped = (_event: IpcRendererEvent, workspace: WorkspaceInfo | null): void => listener(workspace);
            ipcRenderer.on(IPC_EVENTS.workspaceChanged, wrapped);
            return () => {
                ipcRenderer.removeListener(IPC_EVENTS.workspaceChanged, wrapped);
            };
        },
    }),
    // #137: only profile ids cross this bridge, never an executable path or a pty handle.
    terminal: Object.freeze({
        profiles: () => ipcRenderer.invoke(IPC_CHANNELS.terminalProfiles),
        setDefaultProfile: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.terminalSetDefaultProfile, profileId),
        addCustomProfile: (args: string) => ipcRenderer.invoke(IPC_CHANNELS.terminalAddCustomProfile, args),
        removeCustomProfile: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.terminalRemoveCustomProfile, profileId),
        create: (profileId: string | null, cols: number, rows: number) => ipcRenderer.invoke(IPC_CHANNELS.terminalCreate, profileId, cols, rows),
        input: (id: number, data: string) => ipcRenderer.invoke(IPC_CHANNELS.terminalInput, id, data),
        resize: (id: number, cols: number, rows: number) => ipcRenderer.invoke(IPC_CHANNELS.terminalResize, id, cols, rows),
        kill: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.terminalKill, id),
        onData: (listener: (event: TerminalDataEvent) => void) => subscribe(IPC_EVENTS.terminalData, listener),
        onExit: (listener: (event: TerminalExitEvent) => void) => subscribe(IPC_EVENTS.terminalExit, listener),
    }),
    settings: Object.freeze({
        get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
        update: (scope: SettingScope, key: string, value: SettingValue | null) => ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, scope, key, value),
        folderFile: () => ipcRenderer.invoke(IPC_CHANNELS.settingsFolderFile),
        previewTheme: (theme: ColorTheme | null) => ipcRenderer.invoke(IPC_CHANNELS.settingsPreviewTheme, theme),
        onDidChange: (listener: (report: SettingsReport) => void) => subscribe(IPC_EVENTS.settingsChanged, listener),
    }),
    output: Object.freeze({
        lines: (channel: OutputChannelId) => ipcRenderer.invoke(IPC_CHANNELS.outputLines, channel),
        clear: (channel: OutputChannelId) => ipcRenderer.invoke(IPC_CHANNELS.outputClear, channel),
        onAppended: (listener: (event: OutputAppended) => void) => subscribe(IPC_EVENTS.outputAppended, listener),
    }),
    keybindings: Object.freeze({
        get: () => ipcRenderer.invoke(IPC_CHANNELS.keybindingsGet),
        update: (entries: readonly UserKeybinding[]) => ipcRenderer.invoke(IPC_CHANNELS.keybindingsUpdate, entries),
        setMenuAccelerators: (accelerators: Readonly<Record<string, string | null>>) => ipcRenderer.invoke(IPC_CHANNELS.keybindingsSetMenu, accelerators),
        onDidChange: (listener: (report: KeybindingsReport) => void) => subscribe(IPC_EVENTS.keybindingsChanged, listener),
    }),
    commands: Object.freeze({
        onCommand: (listener: (command: IdeCommand) => void) => {
            const wrapped = (_event: IpcRendererEvent, command: unknown): void => {
                if (typeof command === 'string' && KNOWN_COMMANDS.has(command)) {
                    listener(command as IdeCommand);
                }
            };
            ipcRenderer.on(IPC_EVENTS.command, wrapped);
            return () => {
                ipcRenderer.removeListener(IPC_EVENTS.command, wrapped);
            };
        },
    }),
});

contextBridge.exposeInMainWorld('codexr', api);

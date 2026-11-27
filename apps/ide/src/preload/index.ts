import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ColorTheme, SettingScope, SettingValue } from '../shared/settings.ts';
import type { UserKeybinding } from '../shared/keybindings.ts';
import type { OutputChannelId } from '../shared/output.ts';
import type { FunctionMetricsSnapshot } from '../shared/problems.ts';
import { IDE_COMMANDS, IPC_CHANNELS, IPC_EVENTS, type AutoStartMode, type FileAnalysisKind, type ProjectAnalysisKind, type CodeXRApi, type HostNotification, type IdeCommand, type KeybindingsReport, type OutputAppended, type ProgressEvent, type PythonEnvStatus, type SceneAddress, type SceneBounds, type SceneFilesEvent, type SceneInfo, type SceneOpenInEditorEvent, type SceneShareEvent, type SearchDoneEvent, type SearchFileEvent, type SearchQuery, type SettingsReport, type TerminalDataEvent, type TerminalExitEvent, type Unsubscribe, type WatchedEntry, type WorkspaceInfo, type WorkspaceTrustInfo } from '../shared/api.ts';
import { GIT_IPC_CHANNELS, GIT_IPC_EVENTS } from '../shared/git.ts';
import { AGENT_IPC_CHANNELS, AGENT_IPC_EVENTS, type AgentChatEvent, type AgentProfileInput, type ApprovalDecision, type EditReviewResult, type ChatAttachment, type McpServerInput, type ModelPrice, type BudgetSettings, type ProviderInput } from '../shared/agents.ts';
import { AGENT_SESSION_CHANNELS, AGENT_SESSION_EVENTS, type AcpAgentDefinition, type AgentSessionMessage, type PromptAttachment } from '../shared/agentSession.ts';
import { TASK_IPC_CHANNELS, TASK_IPC_EVENTS, type TaskFinished } from '../shared/tasks.ts';
import { DEBUG_IPC_CHANNELS, DEBUG_IPC_EVENTS, type DebugEvent, type DebugStepKind } from '../shared/debug.ts';
import { LSP_IPC_CHANNELS, LSP_IPC_EVENTS, type LspDiagnosticsEvent, type LspLanguage, type LspRequestMethod } from '../shared/lsp.ts';

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
        cancelRun: (sessionId: string, runId: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsCancelRun, sessionId, runId),
        listMcpServers: () => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsListMcpServers),
        saveMcpServer: (input: McpServerInput, id?: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsSaveMcpServer, input, id),
        removeMcpServer: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsRemoveMcpServer, id),
        refreshMcpServer: (id: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsRefreshMcpServer, id),
        usage: () => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsUsage),
        savePrices: (prices: readonly ModelPrice[]) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsSavePrices, prices),
        saveBudget: (budget: BudgetSettings) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.agentsSaveBudget, budget),
    }),
    // AF1: chats with coding agents over ACP; main validates every argument and runs the agents.
    agentSessions: Object.freeze({
        listAgents: () => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.listAgents),
        probeAgent: (ref: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.probeAgent, ref),
        saveCustomAgent: (input: Omit<AcpAgentDefinition, 'id' | 'preset'>, id?: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.saveCustomAgent, input, id),
        removeCustomAgent: (id: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.removeCustomAgent, id),
        login: (ref: string, methodId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.login, ref, methodId),
        listProjects: () => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.listProjects),
        get: (sessionId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.get, sessionId),
        create: (agentRef: string, options?: { readonly worktree?: boolean }) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.create, agentRef, { worktree: options?.worktree === true }),
        prompt: (sessionId: string, text: string, attachments?: readonly PromptAttachment[]) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.prompt, sessionId, text, attachments ?? []),
        cancel: (sessionId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.cancel, sessionId),
        respondPermission: (sessionId: string, requestId: string, optionId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.respondPermission, sessionId, requestId, optionId),
        setMode: (sessionId: string, modeId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.setMode, sessionId, modeId),
        setConfigOption: (sessionId: string, optionId: string, valueId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.setConfigOption, sessionId, optionId, valueId),
        rename: (sessionId: string, title: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.rename, sessionId, title),
        remove: (sessionId: string, options?: { readonly removeWorktree?: boolean }) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.remove, sessionId, { removeWorktree: options?.removeWorktree === true }),
        markRead: (sessionId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.markRead, sessionId),
        // AF5/AF6: review and checkpoints; paths are workspace-relative and checked in main.
        changes: (sessionId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.changes, sessionId),
        changeDiff: (sessionId: string, path: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.changeDiff, sessionId, path),
        keepChanges: (sessionId: string, paths: readonly string[] | 'all') => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.keepChanges, sessionId, paths),
        undoChanges: (sessionId: string, paths: readonly string[] | 'all') => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.undoChanges, sessionId, paths),
        previewRestore: (sessionId: string, checkpointId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.previewRestore, sessionId, checkpointId),
        restoreCheckpoint: (sessionId: string, checkpointId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.restoreCheckpoint, sessionId, checkpointId),
        // AF12: a chat's worktree is named by the chat id only; main looks up its path.
        worktreeAvailability: () => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.worktreeAvailability),
        worktreeStatus: (sessionId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.worktreeStatus, sessionId),
        worktreeCommit: (sessionId: string, message: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.worktreeCommit, sessionId, message),
        worktreeMerge: (sessionId: string, strategy: 'merge' | 'squash') => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.worktreeMerge, sessionId, strategy),
        worktreeDiscard: (sessionId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.worktreeDiscard, sessionId),
        describeInstall: (presetId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.describeInstall, presetId),
        install: (presetId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.install, presetId),
        uninstall: (presetId: string) => ipcRenderer.invoke(AGENT_SESSION_CHANNELS.uninstall, presetId),
        onMessage: (listener: (message: AgentSessionMessage) => void) => subscribe(AGENT_SESSION_EVENTS.message, listener),
    }),
    // #17: only workspace-relative paths and branch names cross; main validates each one.
    git: Object.freeze({
        status: () => ipcRenderer.invoke(GIT_IPC_CHANNELS.gitStatus),
        stage: (paths: readonly string[]) => ipcRenderer.invoke(GIT_IPC_CHANNELS.gitStage, paths),
        unstage: (paths: readonly string[]) => ipcRenderer.invoke(GIT_IPC_CHANNELS.gitUnstage, paths),
        discard: (path: string) => ipcRenderer.invoke(GIT_IPC_CHANNELS.gitDiscard, path),
        commit: (message: string) => ipcRenderer.invoke(GIT_IPC_CHANNELS.gitCommit, message),
        branches: () => ipcRenderer.invoke(GIT_IPC_CHANNELS.gitBranches),
        switchBranch: (name: string) => ipcRenderer.invoke(GIT_IPC_CHANNELS.gitSwitchBranch, name),
        createBranch: (name: string) => ipcRenderer.invoke(GIT_IPC_CHANNELS.gitCreateBranch, name),
        headContent: (path: string) => ipcRenderer.invoke(GIT_IPC_CHANNELS.gitHeadContent, path),
        baseline: (path: string) => ipcRenderer.invoke(GIT_IPC_CHANNELS.gitBaseline, path),
        blame: (path: string, contents: string) => ipcRenderer.invoke(GIT_IPC_CHANNELS.gitBlame, path, contents),
        onDidChange: (listener: () => void) => subscribe(GIT_IPC_EVENTS.gitChanged, () => listener()),
    }),
    // #176: a task by the id main listed, a file by its workspace path; never a command line.
    tasks: Object.freeze({
        list: () => ipcRenderer.invoke(TASK_IPC_CHANNELS.tasksList),
        run: (taskId: string, cols: number, rows: number) => ipcRenderer.invoke(TASK_IPC_CHANNELS.tasksRun, taskId, cols, rows),
        runFile: (path: string, cols: number, rows: number) => ipcRenderer.invoke(TASK_IPC_CHANNELS.tasksRunFile, path, cols, rows),
        configure: () => ipcRenderer.invoke(TASK_IPC_CHANNELS.tasksConfigure),
        onFinished: (listener: (event: TaskFinished) => void) => subscribe(TASK_IPC_EVENTS.tasksFinished, listener),
    }),
    // #180: a configuration by name, a file by its workspace path; never a command line.
    debug: Object.freeze({
        configurations: () => ipcRenderer.invoke(DEBUG_IPC_CHANNELS.debugConfigurations),
        start: (name: string | null, activeFile: string | null) => ipcRenderer.invoke(DEBUG_IPC_CHANNELS.debugStart, name, activeFile),
        installAdapter: (adapter: 'debugpy') => ipcRenderer.invoke(DEBUG_IPC_CHANNELS.debugInstallAdapter, adapter),
        stop: () => ipcRenderer.invoke(DEBUG_IPC_CHANNELS.debugStop),
        restart: () => ipcRenderer.invoke(DEBUG_IPC_CHANNELS.debugRestart),
        step: (kind: DebugStepKind, threadId: number | null) => ipcRenderer.invoke(DEBUG_IPC_CHANNELS.debugStep, kind, threadId),
        stackTrace: (threadId: number) => ipcRenderer.invoke(DEBUG_IPC_CHANNELS.debugStackTrace, threadId),
        scopes: (frameId: number) => ipcRenderer.invoke(DEBUG_IPC_CHANNELS.debugScopes, frameId),
        variables: (variablesReference: number) => ipcRenderer.invoke(DEBUG_IPC_CHANNELS.debugVariables, variablesReference),
        evaluate: (expression: string, frameId: number | null, context: 'watch' | 'repl' | 'hover') =>
            ipcRenderer.invoke(DEBUG_IPC_CHANNELS.debugEvaluate, expression, frameId, context),
        setBreakpoints: (path: string, lines: readonly number[]) => ipcRenderer.invoke(DEBUG_IPC_CHANNELS.debugSetBreakpoints, path, [...lines]),
        configure: () => ipcRenderer.invoke(DEBUG_IPC_CHANNELS.debugConfigure),
        onEvent: (listener: (event: DebugEvent) => void) => subscribe(DEBUG_IPC_EVENTS.debugEvent, listener),
    }),
    // #21: documents by Monaco URI and allow-listed requests; never a server, a path or a command line.
    lsp: Object.freeze({
        didOpen: (uri: string, languageId: LspLanguage, version: number, text: string) => ipcRenderer.invoke(LSP_IPC_CHANNELS.lspDidOpen, uri, languageId, version, text),
        didChange: (uri: string, version: number, text: string) => ipcRenderer.invoke(LSP_IPC_CHANNELS.lspDidChange, uri, version, text),
        didClose: (uri: string) => ipcRenderer.invoke(LSP_IPC_CHANNELS.lspDidClose, uri),
        request: (method: LspRequestMethod, params: unknown) => ipcRenderer.invoke(LSP_IPC_CHANNELS.lspRequest, method, params),
        onDiagnostics: (listener: (event: LspDiagnosticsEvent) => void) => subscribe(LSP_IPC_EVENTS.lspDiagnostics, listener),
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
        analyseProject: (kind: ProjectAnalysisKind, options?: { readonly auto?: boolean }) =>
            ipcRenderer.invoke(IPC_CHANNELS.analysisAnalyseProject, kind, { auto: options?.auto === true }),
        analyseFile: (kind: FileAnalysisKind, path: string) => ipcRenderer.invoke(IPC_CHANNELS.analysisAnalyseFile, kind, path),
        autoStart: () => ipcRenderer.invoke(IPC_CHANNELS.analysisGetAutoStart),
        setAutoStart: (mode: AutoStartMode) => ipcRenderer.invoke(IPC_CHANNELS.analysisSetAutoStart, mode),
        setSceneBounds: (bounds: SceneBounds | null) => ipcRenderer.invoke(IPC_CHANNELS.analysisSetSceneBounds, bounds),
        closeScene: () => ipcRenderer.invoke(IPC_CHANNELS.analysisCloseScene),
        onDidOpenScene: (listener: (scene: SceneInfo) => void) => subscribe(IPC_EVENTS.analysisSceneOpened, listener),
        onDidChangeSceneFiles: (listener: (event: SceneFilesEvent) => void) => subscribe(IPC_EVENTS.analysisSceneFilesChanged, listener),
        onDidRequestOpenInEditor: (listener: (event: SceneOpenInEditorEvent) => void) => subscribe(IPC_EVENTS.analysisOpenInEditor, listener),
        // #155: no server id crosses the bridge; main acts on the calling window's scene.
        shareScene: () => ipcRenderer.invoke(IPC_CHANNELS.analysisShareScene),
        stopSharingScene: () => ipcRenderer.invoke(IPC_CHANNELS.analysisStopSharingScene),
        copySceneAddress: (which: SceneAddress) => ipcRenderer.invoke(IPC_CHANNELS.analysisCopySceneAddress, which),
        revealInScene: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.analysisRevealInScene, path),
        enterXr: () => ipcRenderer.invoke(IPC_CHANNELS.analysisEnterXr),
        openSceneInBrowser: () => ipcRenderer.invoke(IPC_CHANNELS.analysisOpenSceneInBrowser),
        headsetLink: () => ipcRenderer.invoke(IPC_CHANNELS.analysisHeadsetLink),
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
        readImage: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceReadImage, path),
        readDocument: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceReadDocument, path),
        trust: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceTrust),
        setTrust: (choice: 'folder' | 'parent' | 'restrict') => ipcRenderer.invoke(IPC_CHANNELS.workspaceSetTrust, choice),
        onDidChangeTrust: (listener: (trust: WorkspaceTrustInfo) => void) => subscribe(IPC_EVENTS.workspaceTrustChanged, listener),
        openExternalLink: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenExternalLink, url),
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
    problems: Object.freeze({
        functionMetrics: () => ipcRenderer.invoke(IPC_CHANNELS.problemsFunctionMetrics),
        fileFunctions: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.problemsFileFunctions, path),
        onMetricsChanged: (listener: (snapshot: FunctionMetricsSnapshot | null) => void) => subscribe(IPC_EVENTS.metricsChanged, listener),
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

import { app, BrowserWindow, dialog, net, webContents, type WebContents } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_SESSION_EVENTS, type InstallDescription } from '../../shared/agentSession.ts';
import { JsonKeyValueStore } from '../core/jsonStore.ts';
import { log } from '../log.ts';
import type { AgentProfiles } from '../agents/agentProfiles.ts';
import type { TerminalHost } from '../terminal/terminalHost.ts';
import { terminalEnvironment } from '../terminal/terminalService.ts';
import { isWorkspaceTrusted } from '../trust/workspaceTrust.ts';
import { addFolderChangeListener, currentWorkspaceInfo } from '../workspace/workspaceWindows.ts';
import { AgentCatalog } from './agentCatalog.ts';
import { KeyVault } from '../agents/keyVault.ts';
import { electronCipher } from '../agents/electronCipher.ts';
import { AgentInstaller, consentDetail } from './agentInstaller.ts';
import { AgentSessionService, type WindowPort } from './agentSessionService.ts';
import { SessionStore } from './sessionStore.ts';
import { codexrMcpServerSpec } from './codexrMcpSpec.ts';
import { SessionChanges } from '../checkpoints/sessionChanges.ts';
import { toTurnMetricDeltaView } from '../analysis/metricDelta.ts';
import type { AnalysisService } from '../analysis/analysisService.ts';
import type { FileMetrics } from '../agents/tools/analysisQueries.ts';

/**
 * AF1: builds the agent-first chat service and wires it into Electron: the
 * user-data folders, the window of each call (`WindowPort`), workspace trust,
 * the integrated terminal for terminal logins, and the end of windows and of
 * the app. The smoke run keeps its data in a throwaway folder and may not
 * start any agent process.
 */
export interface AgentSessionsRuntime {
    readonly service: AgentSessionService;
    /** The window of an IPC call, as the service addresses it. */
    portOf(contents: WebContents): WindowPort;
    /** Asks the person, in a native dialog the page cannot answer, to confirm a custom agent's command line. */
    confirmCustomAgent(contents: WebContents, commandLine: string): Promise<boolean>;
    /** AF2: the consent to download and install an adapter, in a native dialog showing exactly what. */
    confirmInstall(contents: WebContents, description: InstallDescription): Promise<boolean>;
    /** AF2: the confirmation to remove an adapter the IDE installed. */
    confirmUninstall(contents: WebContents, packageName: string, version: string): Promise<boolean>;
}

const MAX_REGISTRY_RESPONSE = 32 * 1024 * 1024;

/**
 * AF2: one registry GET through Chromium's network stack (`net.fetch`), so the
 * system's proxy and certificate settings apply as they do in the browser.
 */
async function fetchRegistryJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await net.fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`.trim());
        }
        const text = await response.text();
        if (text.length > MAX_REGISTRY_RESPONSE) {
            throw new Error('The registry answer is too large.');
        }
        return JSON.parse(text) as unknown;
    } finally {
        clearTimeout(timer);
    }
}

async function ask(contents: WebContents, options: Electron.MessageBoxOptions): Promise<number> {
    const owner = BrowserWindow.fromWebContents(contents);
    const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
    return response;
}

export interface AgentSessionsRuntimeOptions {
    readonly isSmoke: boolean;
    readonly terminal: TerminalHost;
    readonly profiles: AgentProfiles;
    /** AF10: the static folder of a window's Code-XR analysis, handed to the agents' Code-XR MCP server. */
    readonly analysisOutput?: (contents: WebContents) => string | null;
    /** AF9: the window's live analysis, measured before and after each turn. */
    readonly analysis?: Pick<AnalysisService, 'sceneMetrics' | 'turnMetricDelta'>;
}

/** How long the metric delta waits for the scene to catch up with a turn's edits. */
const METRIC_DELTA_TIMEOUT_MS = 30_000;

export function startAgentSessions(options: AgentSessionsRuntimeOptions): AgentSessionsRuntime {
    const userData = options.isSmoke ? path.join(os.tmpdir(), `codexr-ide-smoke-agent-sessions-${process.pid}`) : app.getPath('userData');
    const dir = path.join(userData, 'agent-sessions');
    const packagesDir = path.join(userData, 'agent-packages');
    const catalog = new AgentCatalog({
        packagesDir,
        store: new JsonKeyValueStore(path.join(dir, 'agents.json')),
        env: process.env,
        platform: process.platform,
        execPath: process.execPath,
        builtinProfiles: () => options.profiles.list(),
        // #297: API keys given to one agent, encrypted by the OS secret store like the built-in agent's keys.
        secrets: new KeyVault(path.join(dir, 'agent-keys.json'), electronCipher()),
    });

    const ports = new Map<number, WindowPort>();
    const portOf = (contents: WebContents): WindowPort => {
        let port = ports.get(contents.id);
        if (!port) {
            const id = contents.id;
            port = {
                id,
                send: (message) => {
                    if (!contents.isDestroyed()) {
                        contents.send(AGENT_SESSION_EVENTS.message, message);
                    }
                },
                isDestroyed: () => contents.isDestroyed(),
            };
            ports.set(id, port);
            // A window's agents stop with it: closed, crashed or reloaded (a reloaded page lost its chat views).
            contents.once('destroyed', () => {
                ports.delete(id);
                service.windowClosed(id);
            });
            contents.on('render-process-gone', () => service.windowClosed(id));
        }
        return port;
    };
    const contentsOf = (port: WindowPort): WebContents | null => {
        const contents = webContents.fromId(port.id);
        return contents && !contents.isDestroyed() ? contents : null;
    };

    // AF5/AF6: snapshots in shadow repositories outside every project, review bases per chat.
    const changes = new SessionChanges({
        storageDir: path.join(userData, 'checkpoints'),
        bases: new JsonKeyValueStore(path.join(dir, 'review.json')),
    });
    /** The window that has `root` open (the chat's owner for the analysis). */
    const windowOf = (root: string): WebContents | null =>
        webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && currentWorkspaceInfo(contents)?.root === root) ?? null;
    /** AF9: per chat, the scene's metrics and the checkpoint taken when its running turn started. */
    const turnStarts = new Map<string, { readonly metrics: FileMetrics[] | null; readonly checkpointId: string | null }>();

    const measureTurn = async (sessionId: string, root: string, turnId: string): Promise<void> => {
        const start = turnStarts.get(sessionId);
        turnStarts.delete(sessionId);
        const owner = windowOf(root);
        if (!start?.metrics || !start.checkpointId || !owner || !options.analysis) {
            return;
        }
        const changed = await changes.changedSince(root, start.checkpointId);
        if (changed.length === 0) {
            return;
        }
        const { report } = await options.analysis.turnMetricDelta(owner, start.metrics, changed, { timeoutMs: METRIC_DELTA_TIMEOUT_MS });
        const view = toTurnMetricDeltaView(report);
        if (view) {
            service.attachMetricDelta(sessionId, turnId, view);
        }
    };

    const service: AgentSessionService = new AgentSessionService({
        review: changes,
        beforePrompt: async (sessionId, root) => {
            const checkpoint = await changes.beforePrompt(sessionId, root);
            const owner = options.analysis ? windowOf(root) : null;
            const metrics = owner && options.analysis ? await options.analysis.sceneMetrics(owner).catch(() => null) : null;
            turnStarts.set(sessionId, { metrics, checkpointId: checkpoint?.checkpointId ?? null });
            return checkpoint;
        },
        afterTurn: async (sessionId, root, turnId) => {
            // The delta waits for the scene to refresh: it never holds the chat up.
            void measureTurn(sessionId, root, turnId).catch((error: unknown) => log.warn(`[agent] Could not measure the turn: ${String(error)}`));
            return changes.afterTurn(sessionId, root);
        },
        catalog,
        // The smoke run may not download anything: no installer, so every install call is refused.
        ...(options.isSmoke ? {} : { installer: new AgentInstaller({ packagesDir, fetchJson: fetchRegistryJson, env: process.env, platform: process.platform, arch: process.arch }) }),
        store: new SessionStore(dir),
        decisions: new JsonKeyValueStore(path.join(dir, 'permissions.json')),
        rootOf: (port) => {
            const contents = contentsOf(port);
            return contents ? (currentWorkspaceInfo(contents)?.root ?? null) : null;
        },
        isTrusted: (port) => {
            const contents = contentsOf(port);
            return contents ? isWorkspaceTrusted(contents) : false;
        },
        // The main process holds no editor buffers (they live in the renderer's Monaco
        // models), so agents read the saved file; unsaved edits stay the person's own.
        readText: (file) => fs.promises.readFile(file, 'utf8'),
        // Written straight to disk: the explorer's and the editor's file watchers
        // reload clean tabs and mark edited ones as changed on disk.
        writeText: async (file, content) => {
            await fs.promises.mkdir(path.dirname(file), { recursive: true });
            await fs.promises.writeFile(file, content, 'utf8');
        },
        openTerminal: async (port, request) => {
            const contents = contentsOf(port);
            if (!contents) {
                throw new Error('The window closed.');
            }
            let markExited: (code: number) => void = () => undefined;
            const exited = new Promise<number>((resolve) => {
                markExited = resolve;
            });
            // #297: the login program itself runs in the terminal, with no shell between:
            // nothing is typed into the person's shell, so no quoting or start-up race.
            const created = await options.terminal.runProgram(
                contents,
                {
                    file: request.command,
                    args: request.args,
                    env: { ...terminalEnvironment(process.env), ...request.env },
                    name: request.title,
                },
                request.cwd,
                request.cols,
                request.rows,
                { onExit: (_id, exitCode) => markExited(exitCode) },
            );
            return { terminal: { terminal: created, title: request.title, command: [request.command, ...request.args].join(' ') }, exited };
        },
        // AF10: every chat gets the Code-XR MCP server, so the agent can query the
        // project's metrics, hotspots, dependencies and evolution itself.
        mcpServers: (root) => {
            if (!root) {
                return [];
            }
            const owner = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && currentWorkspaceInfo(contents)?.root === root);
            const analysisDir = owner ? (options.analysisOutput?.(owner) ?? null) : null;
            return [codexrMcpServerSpec({ execPath: process.execPath, appPath: app.getAppPath(), root, analysisDir, isPackaged: app.isPackaged })];
        },
        // AF12: chats started in a worktree get it here, outside every project.
        worktreeStorageDir: path.join(userData, 'worktrees'),
        spawnAllowed: !options.isSmoke,
        probeDir: path.join(dir, 'probe'),
        homeDir: os.homedir(),
        terminalEnv: { ...terminalEnvironment(process.env), CI: '1', NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat' },
        log: (line) => log.info(`[agent] ${line}`),
    });

    // A window that opens another folder stops the agents of its previous folder's chats.
    addFolderChangeListener((contents, root) => service.folderChanged(contents.id, root));

    return {
        service,
        portOf,
        async confirmInstall(contents, description) {
            const update = description.installedVersion !== null;
            const response = await ask(contents, {
                type: 'question',
                title: update ? `Update ${description.agentName}` : `Install ${description.agentName}`,
                message: update
                    ? `Update ${description.agentName} from ${description.installedVersion ?? '?'} to ${description.version}?`
                    : `Download and install ${description.agentName} (${description.packageName}@${description.version})?`,
                detail: consentDetail(description),
                buttons: [update ? 'Update' : 'Install', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
            });
            return response === 0;
        },
        async confirmUninstall(contents, packageName, version) {
            const response = await ask(contents, {
                type: 'warning',
                title: 'Remove coding agent',
                message: `Remove ${packageName}@${version}?`,
                detail: `It is deleted from ${packagesDir}. Your sign-in, settings and chats are kept; you can install it again at any time.`,
                buttons: ['Remove', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
            });
            return response === 0;
        },
        async confirmCustomAgent(contents, commandLine) {
            const owner = BrowserWindow.fromWebContents(contents);
            const confirm: Electron.MessageBoxOptions = {
                type: 'warning',
                title: 'Add coding agent',
                message: 'Save this coding agent?',
                detail: `Chats with it will start this command in your project folder, with your permissions:\n\n${commandLine}\n\nOnly add agents you trust.`,
                buttons: ['Save Agent', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
            };
            const { response } = owner ? await dialog.showMessageBox(owner, confirm) : await dialog.showMessageBox(confirm);
            return response === 0;
        },
    };
}

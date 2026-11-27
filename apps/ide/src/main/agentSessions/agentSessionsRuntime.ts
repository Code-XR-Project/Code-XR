import { app, BrowserWindow, dialog, webContents, type WebContents } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_SESSION_EVENTS } from '../../shared/agentSession.ts';
import { shellCommand, shellKind } from '../../shared/tasks.ts';
import { JsonKeyValueStore } from '../core/jsonStore.ts';
import { log } from '../log.ts';
import type { AgentProfiles } from '../agents/agentProfiles.ts';
import type { TerminalHost } from '../terminal/terminalHost.ts';
import { terminalEnvironment } from '../terminal/terminalService.ts';
import { isWorkspaceTrusted } from '../trust/workspaceTrust.ts';
import { addFolderChangeListener, currentWorkspaceInfo } from '../workspace/workspaceWindows.ts';
import { AgentCatalog } from './agentCatalog.ts';
import { AgentSessionService, type WindowPort } from './agentSessionService.ts';
import { loginCommandLine } from './agentTerminals.ts';
import { SessionStore } from './sessionStore.ts';

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
}

export function startAgentSessions(options: { readonly isSmoke: boolean; readonly terminal: TerminalHost; readonly profiles: AgentProfiles }): AgentSessionsRuntime {
    const userData = options.isSmoke ? path.join(os.tmpdir(), `codexr-ide-smoke-agent-sessions-${process.pid}`) : app.getPath('userData');
    const dir = path.join(userData, 'agent-sessions');
    const catalog = new AgentCatalog({
        packagesDir: path.join(userData, 'agent-packages'),
        store: new JsonKeyValueStore(path.join(dir, 'agents.json')),
        env: process.env,
        platform: process.platform,
        execPath: process.execPath,
        builtinProfiles: () => options.profiles.list(),
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

    const service: AgentSessionService = new AgentSessionService({
        catalog,
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
            const shell = await options.terminal.defaultShellPath();
            const kind = shellKind(shell);
            const line = loginCommandLine(kind, shellCommand(shell, [request.command, ...request.args]), request.env, terminalEnvironment(process.env));
            let markExited: (code: number) => void = () => undefined;
            const exited = new Promise<number>((resolve) => {
                markExited = resolve;
            });
            const created = await options.terminal.runCommand(contents, line, request.cwd, 100, 30, { onExit: (_id, exitCode) => markExited(exitCode) });
            return { terminal: { terminalId: created.id, title: request.title, cwd: created.cwd }, exited };
        },
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

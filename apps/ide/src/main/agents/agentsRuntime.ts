import { app, BrowserWindow, dialog } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { JsonKeyValueStore } from '../core/jsonStore.ts';
import { AgentChat } from './agentChat.ts';
import { AgentProfiles } from './agentProfiles.ts';
import { ChatSessions } from './chatSessions.ts';
import { electronCipher } from './electronCipher.ts';
import { KeyVault } from './keyVault.ts';
import { McpRegistry } from './mcp/mcpRegistry.ts';
import { terminalEnvironment } from '../terminal/terminalService.ts';
import { ProviderRegistry } from './providerRegistry.ts';
import type { CommandRunner } from './tools/commandTool.ts';
import { ToolCatalog } from './tools/toolCatalog.ts';

export interface AgentServices {
    readonly providers: ProviderRegistry;
    readonly profiles: AgentProfiles;
    readonly sessions: ChatSessions;
    readonly chat: AgentChat;
    readonly tools: ToolCatalog;
    readonly mcp: McpRegistry;
}

/**
 * Builds the agent hub's services. Nothing here touches the network: a
 * provider is only called when the person tests it or chats with it. The
 * smoke run uses a throwaway folder so it never reads or writes real keys.
 */
export function startAgents(options: { readonly isSmoke: boolean; readonly commandRunner: CommandRunner | null }): AgentServices {
    const dir = options.isSmoke
        ? path.join(os.tmpdir(), `codexr-ide-smoke-agents-${process.pid}`)
        : path.join(app.getPath('userData'), 'agents');
    const store = new JsonKeyValueStore(path.join(dir, 'providers.json'));
    const vault = new KeyVault(path.join(dir, 'keys.json'), electronCipher());
    const providers = new ProviderRegistry(store, vault);
    const profiles = new AgentProfiles(new JsonKeyValueStore(path.join(dir, 'agents.json')));
    const sessions = new ChatSessions(path.join(dir, 'sessions'));
    const tools = ToolCatalog.standard(options.commandRunner);
    const mcp = new McpRegistry({
        store: new JsonKeyValueStore(path.join(dir, 'mcp.json')),
        vault,
        cwd: os.homedir(),
        env: terminalEnvironment(process.env),
        confirmCommand: options.isSmoke ? () => Promise.resolve(false) : confirmCommand,
    });
    tools.addSource(() => mcp.tools());
    return { providers, profiles, sessions, tools, mcp, chat: new AgentChat(providers, profiles, sessions, tools) };
}

/** A native dialog, outside the renderer's reach: a local MCP server runs with the person's permissions. */
async function confirmCommand(server: { readonly name: string; readonly commandLine: string }): Promise<boolean> {
    const options: Electron.MessageBoxOptions = {
        type: 'warning',
        buttons: ['Allow this command', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Add MCP server',
        message: `Run the MCP server "${server.name}"?`,
        detail: `Code-XR IDE will start this command on your computer, with your permissions, when an agent uses one of its tools (each call still asks first):\n\n${server.commandLine}\n\nOnly add servers you trust.`,
    };
    const parent = BrowserWindow.getFocusedWindow();
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return response === 0;
}

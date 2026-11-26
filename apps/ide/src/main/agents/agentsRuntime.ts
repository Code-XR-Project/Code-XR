import { app } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { JsonKeyValueStore } from '../core/jsonStore.ts';
import { AgentChat } from './agentChat.ts';
import { AgentProfiles } from './agentProfiles.ts';
import { ChatSessions } from './chatSessions.ts';
import { electronCipher } from './electronCipher.ts';
import { KeyVault } from './keyVault.ts';
import { ProviderRegistry } from './providerRegistry.ts';
import { ToolCatalog } from './tools/toolCatalog.ts';

export interface AgentServices {
    readonly providers: ProviderRegistry;
    readonly profiles: AgentProfiles;
    readonly sessions: ChatSessions;
    readonly chat: AgentChat;
    readonly tools: ToolCatalog;
}

/**
 * Builds the agent hub's services. Nothing here touches the network: a
 * provider is only called when the person tests it or chats with it. The
 * smoke run uses a throwaway folder so it never reads or writes real keys.
 */
export function startAgents(options: { readonly isSmoke: boolean }): AgentServices {
    const dir = options.isSmoke
        ? path.join(os.tmpdir(), `codexr-ide-smoke-agents-${process.pid}`)
        : path.join(app.getPath('userData'), 'agents');
    const store = new JsonKeyValueStore(path.join(dir, 'providers.json'));
    const vault = new KeyVault(path.join(dir, 'keys.json'), electronCipher());
    const providers = new ProviderRegistry(store, vault);
    const profiles = new AgentProfiles(new JsonKeyValueStore(path.join(dir, 'agents.json')));
    const sessions = new ChatSessions(path.join(dir, 'sessions'));
    const tools = new ToolCatalog();
    return { providers, profiles, sessions, tools, chat: new AgentChat(providers, profiles, sessions, tools) };
}

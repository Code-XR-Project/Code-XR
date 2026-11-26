import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { AGENT_IPC_CHANNELS, AGENT_IPC_EVENTS, type AgentChatEvent } from '../../shared/agents.ts';
import { currentWorkspaceInfo, workspaceOrNull } from '../workspace/workspaceWindows.ts';
import type { AgentServices } from './agentsRuntime.ts';

type Handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

/**
 * The main-process side of `window.codexr.agents`, registered through ipc.ts's
 * `handle` so the same trusted-frame check applies. Every argument is
 * validated by the services: the renderer is not trusted to send well-formed
 * data. Chats belong to the folder open in the calling window.
 */
export function registerAgentHandlers(handle: Handle, agents: AgentServices): void {
    const { providers, profiles, sessions, chat, tools } = agents;
    const folderOf = (event: IpcMainInvokeEvent): string | null => currentWorkspaceInfo(event.sender)?.root ?? null;

    handle(AGENT_IPC_CHANNELS.agentsSecretStore, () => providers.secretStore());
    handle(AGENT_IPC_CHANNELS.agentsListProviders, () => providers.list());
    handle(AGENT_IPC_CHANNELS.agentsSaveProvider, (_event, input, id) => providers.save(input, id));
    handle(AGENT_IPC_CHANNELS.agentsRemoveProvider, async (_event, id) => {
        await providers.remove(id);
        await profiles.unbindProvider(String(id));
    });
    handle(AGENT_IPC_CHANNELS.agentsTestProvider, (_event, id) => providers.test(id));

    handle(AGENT_IPC_CHANNELS.agentsListAgents, () => profiles.list());
    handle(AGENT_IPC_CHANNELS.agentsSaveAgent, (_event, input, id) => profiles.save(input, id));
    handle(AGENT_IPC_CHANNELS.agentsRemoveAgent, (_event, id) => profiles.remove(id));

    handle(AGENT_IPC_CHANNELS.agentsListSessions, (event) => sessions.list(folderOf(event)));
    handle(AGENT_IPC_CHANNELS.agentsGetSession, (event, id) => chat.get(folderOf(event), id));
    handle(AGENT_IPC_CHANNELS.agentsCreateSession, (event, agentId) => chat.create(folderOf(event), agentId));
    handle(AGENT_IPC_CHANNELS.agentsRenameSession, (event, id, title) => sessions.rename(folderOf(event), String(id), title));
    handle(AGENT_IPC_CHANNELS.agentsDeleteSession, (event, id) => chat.delete(folderOf(event), id));
    handle(AGENT_IPC_CHANNELS.agentsExportSession, (event, id) => chat.export(folderOf(event), id));
    handle(AGENT_IPC_CHANNELS.agentsSend, (event, id, text, attachments) => chat.send(folderOf(event), id, text, attachments, {
        workspace: workspaceOrNull(event.sender),
        emit: sender(event.sender),
    }));
    handle(AGENT_IPC_CHANNELS.agentsStop, (_event, id) => chat.stop(id));
    handle(AGENT_IPC_CHANNELS.agentsTools, () => tools.list());
    handle(AGENT_IPC_CHANNELS.agentsApprove, (_event, requestId, decision) => chat.approve(requestId, decision));
    handle(AGENT_IPC_CHANNELS.agentsResolveReview, (_event, requestId, result) => chat.resolveReview(requestId, result));
}

/** Streams chat events to the window that asked; a closed window just stops receiving them. */
function sender(contents: WebContents): (event: AgentChatEvent) => void {
    return (event) => {
        if (!contents.isDestroyed()) {
            contents.send(AGENT_IPC_EVENTS.agentsChat, event);
        }
    };
}

import type { IpcMainInvokeEvent } from 'electron';
import { AGENT_IPC_CHANNELS } from '../../shared/agents.ts';
import type { ProviderRegistry } from './providerRegistry.ts';

type Handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

/**
 * The main-process side of `window.codexr.agents`, registered through ipc.ts's
 * `handle` so the same trusted-frame check applies. Every argument is
 * validated by the registry: the renderer is not trusted to send well-formed data.
 */
export function registerAgentHandlers(handle: Handle, providers: ProviderRegistry): void {
    handle(AGENT_IPC_CHANNELS.agentsSecretStore, () => providers.secretStore());
    handle(AGENT_IPC_CHANNELS.agentsListProviders, () => providers.list());
    handle(AGENT_IPC_CHANNELS.agentsSaveProvider, (_event, input, id) => providers.save(input, id));
    handle(AGENT_IPC_CHANNELS.agentsRemoveProvider, (_event, id) => providers.remove(id));
    handle(AGENT_IPC_CHANNELS.agentsTestProvider, (_event, id) => providers.test(id));
}

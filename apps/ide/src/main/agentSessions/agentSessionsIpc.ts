import type { IpcMainInvokeEvent } from 'electron';
import { AGENT_SESSION_CHANNELS } from '../../shared/agentSession.ts';
import type { AgentSessionsRuntime } from './agentSessionsRuntime.ts';

type Handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

/**
 * AF1: the main-process side of `window.codexr.agentSessions`, registered
 * through ipc.ts's `handle` so the trusted-frame check applies. The renderer
 * is not trusted: every argument goes to the service as `unknown` and is
 * validated there, and the calling window (never an id the page sends) decides
 * which folder a chat belongs to. Only the documented members are returned.
 */
export function registerAgentSessionHandlers(handle: Handle, runtime: AgentSessionsRuntime): void {
    const { service, portOf } = runtime;
    const C = AGENT_SESSION_CHANNELS;
    handle(C.listAgents, (event) => service.listAgents(portOf(event.sender)));
    handle(C.probeAgent, (event, ref) => service.probeAgent(portOf(event.sender), ref));
    handle(C.saveCustomAgent, (event, input, id) => service.saveCustomAgent(portOf(event.sender), input, id, (line) => runtime.confirmCustomAgent(event.sender, line)));
    handle(C.removeCustomAgent, (event, id) => service.removeCustomAgent(portOf(event.sender), id));
    handle(C.login, (event, ref, methodId) => service.login(portOf(event.sender), ref, methodId));
    handle(C.listProjects, (event) => service.listProjects(portOf(event.sender)));
    handle(C.get, (event, id) => service.get(portOf(event.sender), id));
    handle(C.create, (event, ref) => service.create(portOf(event.sender), ref));
    handle(C.prompt, (event, id, text, attachments) => service.prompt(portOf(event.sender), id, text, attachments));
    handle(C.cancel, (event, id) => service.cancel(portOf(event.sender), id));
    handle(C.respondPermission, (event, id, requestId, optionId) => service.respondPermission(portOf(event.sender), id, requestId, optionId));
    handle(C.setMode, (event, id, modeId) => service.setMode(portOf(event.sender), id, modeId));
    handle(C.setConfigOption, (event, id, optionId, valueId) => service.setConfigOption(portOf(event.sender), id, optionId, valueId));
    handle(C.rename, (event, id, title) => service.rename(portOf(event.sender), id, title));
    handle(C.remove, (event, id) => service.remove(portOf(event.sender), id));
    handle(C.markRead, (event, id) => service.markRead(portOf(event.sender), id));
    handle(C.changes, (event, id) => service.changes(portOf(event.sender), id));
    handle(C.changeDiff, (event, id, filePath) => service.changeDiff(portOf(event.sender), id, filePath));
    handle(C.keepChanges, (event, id, paths) => service.keepChanges(portOf(event.sender), id, paths));
    handle(C.undoChanges, (event, id, paths) => service.undoChanges(portOf(event.sender), id, paths));
    handle(C.previewRestore, (event, id, checkpointId) => service.previewRestore(portOf(event.sender), id, checkpointId));
    handle(C.restoreCheckpoint, (event, id, checkpointId) => service.restoreCheckpoint(portOf(event.sender), id, checkpointId));
    // AF2: the registry is read only on request; installing and removing ask natively first.
    handle(C.describeInstall, (event, presetId) => service.describeInstall(portOf(event.sender), presetId));
    handle(C.install, (event, presetId) => service.installAgent(portOf(event.sender), presetId, (description) => runtime.confirmInstall(event.sender, description)));
    handle(C.uninstall, (event, presetId) => service.uninstallAgent(portOf(event.sender), presetId, (packageName, version) => runtime.confirmUninstall(event.sender, packageName, version)));
}

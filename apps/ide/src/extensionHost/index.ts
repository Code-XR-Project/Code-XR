import { HOST_METHODS, RpcEndpoint, type HostInitData, type RpcMessage } from '../shared/extensionHostProtocol.ts';
import { ExtensionHost } from './host.ts';

/**
 * Entry point of the extension host process (#259). The main process forks
 * it with Electron's own Node (`ELECTRON_RUN_AS_NODE`) and talks to it over
 * the IPC channel Node sets up for a forked child. Without that channel (run
 * by hand) there is nothing to do.
 */

if (typeof process.send !== 'function') {
    console.error('The Code-XR extension host must be started by the IDE.');
    process.exit(1);
}

const send = (message: RpcMessage): void => {
    process.send?.(message);
};
const rpc = new RpcEndpoint(send);
const host = new ExtensionHost(rpc);

rpc.handle(HOST_METHODS.init, (data) => host.init(data as HostInitData));
rpc.handle(HOST_METHODS.activateByEvent, (event) => host.activateByEvent(String(event)));
rpc.handle(HOST_METHODS.executeCommand, (id, args) => host.executeFromWorkbench(String(id), Array.isArray(args) ? args : []));
rpc.handle(HOST_METHODS.registeredCommands, () => [...host.commands.keys()]);
rpc.handle(HOST_METHODS.configurationChanged, (values) => host.configurationChanged((values ?? {}) as Record<string, unknown>));
rpc.handle(HOST_METHODS.trustChanged, (trusted) => host.trustChanged(trusted === true));
rpc.handle(HOST_METHODS.shutdown, async () => {
    await host.shutdown();
    setTimeout(() => process.exit(0), 50);
});

process.on('message', (message) => rpc.receive(message));
// The IDE went away without saying goodbye: deactivate what can be and leave.
process.on('disconnect', () => {
    void host.shutdown().finally(() => process.exit(0));
});
// An extension's stray rejection or exception must not take every other extension down.
process.on('unhandledRejection', (reason) => {
    host.log({ level: 'error', extensionId: null, message: `Unhandled promise rejection in an extension: ${reason instanceof Error && reason.stack ? reason.stack : String(reason)}` });
});
process.on('uncaughtException', (error) => {
    host.log({ level: 'error', extensionId: null, message: `Uncaught exception in an extension: ${error.stack ?? error.message}` });
});

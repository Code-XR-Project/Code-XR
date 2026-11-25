import * as vscode from 'vscode';
import { ServerActionHandlers } from '../views/handleServerActions';
import { ExtensionCommandRegistration } from '../../../platform/commands/commandRegistry';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('ACTIVE_SERVER');

/** A command whose only argument is a server, as a tree item or a bare id. */
interface ServerIdCommand {
    id: string;
    description: string;
    action: ServerIdAction;
    errorMessage: string;
}

type ServerIdAction =
    | 'openInBrowser'
    | 'openInPanel'
    | 'copyUrl'
    | 'copyLanUrl'
    | 'startRemoteAccess'
    | 'copyRemoteInvitation'
    | 'stopRemoteAccess'
    | 'showRemoteStatus'
    | 'stopServer'
    | 'showServerDetails'
    | 'regeneratePairingCode';

/** In registration order, between showActions and showParticipantDetails. */
const SERVER_ID_COMMANDS: readonly ServerIdCommand[] = [
    { id: 'codeXR.activeServers.openInBrowser', description: 'Open active server in browser', action: 'openInBrowser', errorMessage: 'Failed to open active server in browser' },
    { id: 'codeXR.activeServers.openInPanel', description: 'Open active server in panel', action: 'openInPanel', errorMessage: 'Failed to open active server in panel' },
    { id: 'codeXR.activeServers.copyUrl', description: 'Copy active server URL', action: 'copyUrl', errorMessage: 'Failed to copy active server URL' },
    { id: 'codeXR.activeServers.copyLanUrl', description: 'Copy active server LAN URL', action: 'copyLanUrl', errorMessage: 'Failed to copy active server LAN URL' },
    { id: 'codeXR.activeServers.startRemoteAccess', description: 'Start remote access', action: 'startRemoteAccess', errorMessage: 'Failed to start remote access' },
    { id: 'codeXR.activeServers.copyRemoteInvitation', description: 'Copy remote invitation', action: 'copyRemoteInvitation', errorMessage: 'Failed to copy remote invitation' },
    { id: 'codeXR.activeServers.stopRemoteAccess', description: 'Stop remote access', action: 'stopRemoteAccess', errorMessage: 'Failed to stop remote access' },
    { id: 'codeXR.activeServers.showRemoteStatus', description: 'Show remote access status', action: 'showRemoteStatus', errorMessage: 'Failed to show remote access status' },
    { id: 'codeXR.activeServers.stopServer', description: 'Stop active server', action: 'stopServer', errorMessage: 'Failed to stop active server' },
    { id: 'codeXR.activeServers.showDetails', description: 'Show active server details', action: 'showServerDetails', errorMessage: 'Failed to show active server details' },
    { id: 'codeXR.activeServers.regeneratePairingCode', description: 'Generate a new pairing code', action: 'regeneratePairingCode', errorMessage: 'Failed to generate a new pairing code' },
];

/**
 * Active Servers Commands
 * Command declarations for active servers functionality.
 */
export class ActiveServersCommands {
    private static treeDataProvider: { refresh(): void } | undefined;

    public static getCommandRegistrations(treeDataProvider?: { refresh(): void }): ExtensionCommandRegistration[] {
        this.treeDataProvider = treeDataProvider;

        return [
            {
                id: 'codeXR.activeServers.showActions',
                module: 'ACTIVE_SERVER',
                description: 'Show server actions',
                handler: async (serverId: string) => {
                    await ServerActionHandlers.showServerActions(serverId);
                },
                errorMessage: 'Failed to show server actions'
            },
            ...SERVER_ID_COMMANDS.map((command) => this.serverIdCommand(command)),
            {
                id: 'codeXR.activeServers.showParticipantDetails',
                module: 'ACTIVE_SERVER',
                description: 'Show connected participant details',
                handler: async (serverId: string, peerId: string) => {
                    await ServerActionHandlers.showParticipantDetails(serverId, peerId);
                },
                errorMessage: 'Failed to show participant details'
            },
            {
                id: 'codeXR.activeServers.removeParticipant',
                module: 'ACTIVE_SERVER',
                description: 'Remove a participant from the session',
                handler: async (target: unknown, peerIdArgument?: string) => {
                    // Invoked either from the details modal (serverId, peerId)
                    // or from the tree context menu (the participant row).
                    const participantTarget = typeof target === 'string' && peerIdArgument
                        ? { serverId: target, peerId: peerIdArgument }
                        : this.extractParticipantFromTreeItem(target);
                    if (!participantTarget) {
                        // Never fail silently: an unresolvable target used to
                        // look exactly like a command that did nothing.
                        void vscode.window.showWarningMessage(
                            'Could not tell which participant to remove. Refresh the view and try again.',
                        );
                        return;
                    }
                    await ServerActionHandlers.removeParticipant(
                        participantTarget.serverId,
                        participantTarget.peerId,
                    );
                },
                errorMessage: 'Failed to remove the participant',
            },
            {
                id: 'codeXR.activeServers.stopAllServers',
                module: 'ACTIVE_SERVER',
                description: 'Stop all active servers',
                handler: async () => {
                    await ServerActionHandlers.stopAllServers();
                },
                errorMessage: 'Failed to stop all active servers'
            },
            {
                id: 'codeXR.activeServers.refreshServers',
                module: 'ACTIVE_SERVER',
                description: 'Refresh active servers',
                handler: async () => {
                    if (this.treeDataProvider?.refresh) {
                        logger.debug('Refreshing unified tree view');
                        this.treeDataProvider.refresh();
                        return;
                    }

                    logger.debug('Using fallback refresh handler');
                    await vscode.commands.executeCommand('codexr.tree.refresh');
                },
                errorMessage: 'Failed to refresh active servers'
            },
            {
                id: 'codeXR.activeServers.openView',
                module: 'ACTIVE_SERVER',
                description: 'Open active servers view',
                handler: async () => {
                    await vscode.commands.executeCommand('codexrTree.focus');
                },
                errorMessage: 'Failed to open active servers view'
            }
        ];
    }

    /** The registration of a table row: resolve the server id, then run the action (nothing when unresolvable). */
    private static serverIdCommand(command: ServerIdCommand): ExtensionCommandRegistration {
        return {
            id: command.id,
            module: 'ACTIVE_SERVER',
            description: command.description,
            handler: async (treeItem: unknown) => {
                const serverId = this.extractServerIdFromTreeItem(treeItem);
                if (serverId) {
                    await ServerActionHandlers[command.action](serverId);
                }
            },
            errorMessage: command.errorMessage,
        };
    }

    private static extractParticipantFromTreeItem(
        treeItem: unknown,
    ): { serverId: string; peerId: string } | null {
        if (typeof treeItem !== 'object' || treeItem === null) {
            return null;
        }
        const item = treeItem as {
            activeServer?: { id?: string };
            server?: { id?: string };
            participant?: { peerId?: string };
        };
        const serverId = item.activeServer?.id || item.server?.id;
        const peerId = item.participant?.peerId;
        if (!serverId || !peerId) {
            logger.error('Could not extract participant from tree item:', treeItem);
            return null;
        }
        return { serverId, peerId };
    }

    private static extractServerIdFromTreeItem(treeItem: unknown): string | null {
        if (typeof treeItem === 'object' && treeItem !== null && 'server' in treeItem) {
            const server = (treeItem as { server?: { id?: string } }).server;
            if (server?.id) {
                logger.debug(() => `Extracted server ID from tree item: ${server.id}`);
                return server.id;
            }
        }

        if (typeof treeItem === 'string') {
            logger.debug(() => `Using direct server ID: ${treeItem}`);
            return treeItem;
        }

        logger.error('Could not extract server ID from tree item:', treeItem);
        return null;
    }
}

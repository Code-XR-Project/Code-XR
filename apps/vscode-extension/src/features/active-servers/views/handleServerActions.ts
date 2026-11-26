import * as vscode from 'vscode';
import { ActiveServer } from '../../../core/server/registry/activeServerModel';
import { getActiveServerRegistry } from '../../../core/server/registry/activeServerRegistry';
import { ServerControl } from '../../../core/server/serverControl';
import { openServerInBrowser, openServerInPanel } from '../services/serverOpenActions';
import { withServer } from '../services/withServer';
import { showHeadsetQrPanel } from '../services/headsetQrPanel';
import { NetworkUtils } from '../../../core/server/networkUtils';
import { RemoteAccessManager } from '../../../core/remote-access/remoteAccessManager';
import { ServerSettingsManager } from '../../../core/server/serverSettingsManager';
import { COLLABORATION_AVATARS } from '../../../core/collaboration/collaborationProfile';
import { ConnectedParticipantSummary } from '../../../core/collaboration/connectedParticipant';
import type { PairingRequestSummary } from '../../../core/remote-access/remoteSessionAuthority';
import { formatDetailSections, formatDuration } from '../../../platform/ui/detailDialog';
import {
    formatPendingRequests,
    formatRemoteStatus,
    formatServerDetails,
    getServerLabel,
} from './serverDetailsFormat';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('ACTIVE_SERVER');

/** Minimal shape needed to hand out pairing codes; kept structural so the
 *  handler does not depend on the concrete server runtime class. */
interface PairingAuthority {
    listPendingPairingRequests(): PairingRequestSummary[];
    regeneratePairingCode(requestId: string): { code: string; expiresAt: number };
}

/** Minimal shape of a server runtime that hosts collaboration participants. */
interface ParticipantHostRuntime {
    getConnectedParticipants?: () => ConnectedParticipantSummary[];
    removeParticipant?: (peerId: string) => { removed: boolean; sessionRevoked: boolean };
}

const REMOVE_PARTICIPANT_ACTION = 'Remove from Session';

/**
 * Server Action Handlers
 * Handle user interactions with active servers
 */
export class ServerActionHandlers {

    /**
     * Show server actions quick pick
     */
    public static async showServerActions(serverId: string): Promise<void> {
        logger.debug(() => `Showing actions for server ${serverId}`);
        
        return withServer(serverId, async (server) => {
            const actions = this.getAvailableActions(server);
        
            const selectedAction = await vscode.window.showQuickPick(actions, {
                placeHolder: `Actions for ${server.url}`,
                title: `Server Actions - localhost:${server.port}`
            });

            if (selectedAction) {
                await this.executeAction(selectedAction.action, server);
            }
        });
    }

    /**
     * Open server in browser
     */
    public static async openInBrowser(serverId: string): Promise<void> {
        return openServerInBrowser(serverId);
    }

    /**
     * Open server in lateral panel
     */
    public static async openInPanel(serverId: string): Promise<void> {
        return openServerInPanel(serverId);
    }

    /**
     * Copy server URL to clipboard
     */
    public static async copyUrl(serverId: string): Promise<void> {
        logger.debug(() => `Copying URL for server ${serverId}`);
        
        return withServer(serverId, async (server) => {
            try {
                // Extract port and protocol from server URL
                const portMatch = server.url.match(/:(\d+)/);
                const port = portMatch ? parseInt(portMatch[1]) : null;
                const protocol = server.url.startsWith('https') ? 'https' : 'http';
            
                const localIP = NetworkUtils.getLocalIPAddress();
                const hasNetworkAccess = localIP !== 'localhost' && port;
            
                if (hasNetworkAccess) {
                    // Show options for localhost vs network URL
                    const networkUrl = `${protocol}://${localIP}:${port}`;
                    const choice = await vscode.window.showQuickPick([
                        {
                            label: 'Local URL',
                            description: server.url,
                            detail: 'For use on this computer only'
                        },
                        {
                            label: 'Network URL', 
                            description: networkUrl,
                            detail: 'For access from other devices on the network'
                        }
                    ], {
                        placeHolder: 'Choose URL type to copy'
                    });
                
                    if (!choice) {
                        return; // User cancelled
                    }
                
                    const urlToCopy = choice.label.includes('Network') ? networkUrl : server.url;
                    await vscode.env.clipboard.writeText(urlToCopy);
                    logger.debug(() => `Copied ${urlToCopy} to clipboard`);
                    void vscode.window.showInformationMessage(`Copied ${choice.label.includes('Network') ? 'Network' : 'Local'} URL to clipboard`);
                } else {
                    // Fallback to original behavior if no network access available
                    await vscode.env.clipboard.writeText(server.url);
                    logger.debug(() => `Copied ${server.url} to clipboard`);
                    void vscode.window.showInformationMessage(`Copied ${server.url} to clipboard`);
                }
            } catch (error) {
                logger.error(`Error copying URL to clipboard:`, error);
                void vscode.window.showErrorMessage('Failed to copy URL to clipboard');
            }
        });
    }

    public static async copyLanUrl(serverId: string): Promise<void> {
        const server = getActiveServerRegistry().getServer(serverId);
        if (!server) {
            void vscode.window.showErrorMessage(`Server not found: ${serverId}`);
            return;
        }
        const protocol = server.url.startsWith('https') ? 'https' : 'http';
        const lanUrl = NetworkUtils.getPrimaryExternalUrl(server.port, protocol);
        await vscode.env.clipboard.writeText(lanUrl);
        void vscode.window.showInformationMessage(`Network address copied: ${lanUrl}`);
    }

    /** #19: the address a standalone headset opens to join this server's scene, and its QR code. */
    public static async showHeadsetQr(serverId: string): Promise<void> {
        return withServer(serverId, async (server) => showHeadsetQrPanel(server));
    }

    public static async startRemoteAccess(serverId: string): Promise<void> {
        const manager = this.requireRemoteManager();
        const state = await manager.startSharing(serverId);
        if (state.status === 'shared' && state.invitationUrl) {
            await vscode.env.clipboard.writeText(state.invitationUrl);
            void vscode.window.showInformationMessage(
                'Server shared through Cloudflare. The invitation link has been copied to the clipboard.',
            );
        }
    }

    public static async copyRemoteInvitation(serverId: string): Promise<void> {
        const manager = this.requireRemoteManager();
        await manager.copyInvitation(serverId);
    }

    public static async stopRemoteAccess(serverId: string): Promise<void> {
        const manager = this.requireRemoteManager();
        await manager.stopSharing(serverId);
    }

    /**
     * Show a modal with the details of one connected participant
     */
    public static async showParticipantDetails(serverId: string, peerId: string): Promise<void> {
        const participant = this.findConnectedParticipant(serverId, peerId);

        if (!participant) {
            void vscode.window.showInformationMessage('This participant is no longer connected.');
            return;
        }

        const avatar = COLLABORATION_AVATARS.find((candidate) => candidate.id === participant.avatarId);
        const connectedAt = new Date(participant.connectedAt);
        const connectedFor = Number.isNaN(connectedAt.getTime())
            ? participant.connectedAt
            : `${connectedAt.toLocaleTimeString()} · ${formatDuration(Date.now() - connectedAt.getTime())} ago`;

        const detail = formatDetailSections([
            [
                ['Name', participant.displayName],
                ['Role', participant.role === 'host' ? 'Host' : 'Guest'],
                ['Avatar', avatar?.label || participant.avatarId],
            ],
            [
                ['Client', participant.clientKind === 'codexr' ? 'CodeXR' : 'Browser'],
                ['Connection', participant.connectionScope === 'remote' ? 'Remote (cross-network)' : 'Local network'],
                ['IP address', participant.remoteAddress],
                ['Connected', connectedFor],
            ],
        ]);

        // The host cannot remove themselves, so their own row keeps only Close.
        const actions = participant.role === 'host' ? [] : [REMOVE_PARTICIPANT_ACTION];
        const choice = await vscode.window.showInformationMessage(
            `Participant — ${participant.displayName}`,
            { modal: true, detail },
            ...actions,
        );

        if (choice === REMOVE_PARTICIPANT_ACTION) {
            await this.removeParticipant(serverId, peerId);
        }
    }

    /**
     * Disconnect a participant from the session, after confirmation. A remote
     * guest also loses their session, so they need a new invitation to return.
     */
    public static async removeParticipant(serverId: string, peerId: string): Promise<void> {
        const participant = this.findConnectedParticipant(serverId, peerId);
        if (!participant) {
            void vscode.window.showInformationMessage('This participant is no longer connected.');
            return;
        }
        if (participant.role === 'host') {
            void vscode.window.showWarningMessage('The host of the session cannot be removed.');
            return;
        }

        const isRemote = participant.connectionScope === 'remote';
        const consequence = isRemote
            ? 'Their remote session will be revoked: they will need a new invitation and pairing code to join again.'
            : 'They are on the local network, so they can open the server address again unless you stop the server.';
        const confirmation = await vscode.window.showWarningMessage(
            `Remove ${participant.displayName} from the session?`,
            { modal: true, detail: `${consequence}\n\nThey will see a message explaining they were removed.` },
            'Remove',
        );
        if (confirmation !== 'Remove') {
            return;
        }

        const runtime = this.getParticipantHostRuntime(serverId);
        if (typeof runtime?.removeParticipant !== 'function') {
            void vscode.window.showWarningMessage('This server does not support removing participants.');
            return;
        }

        const outcome = runtime.removeParticipant(peerId);
        if (!outcome.removed) {
            void vscode.window.showInformationMessage(
                `${participant.displayName} had already left the session.`,
            );
            return;
        }

        void vscode.window.showInformationMessage(
            outcome.sessionRevoked
                ? `${participant.displayName} was removed. Their remote session was revoked.`
                : `${participant.displayName} was removed from the session.`,
        );
    }

    /** The remote access manager, or the error every remote action has always thrown without one. */
    private static requireRemoteManager(): RemoteAccessManager {
        const manager = RemoteAccessManager.getInstance();
        if (!manager) {
            throw new Error('The remote access manager is not initialized.');
        }
        return manager;
    }

    private static getParticipantHostRuntime(serverId: string): ParticipantHostRuntime | undefined {
        const server = getActiveServerRegistry().getServer(serverId);
        return server?.serverInstance as ParticipantHostRuntime | undefined;
    }

    private static findConnectedParticipant(
        serverId: string,
        peerId: string,
    ): ConnectedParticipantSummary | undefined {
        const runtime = this.getParticipantHostRuntime(serverId);
        const participants = typeof runtime?.getConnectedParticipants === 'function'
            ? runtime.getConnectedParticipants()
            : [];
        return participants.find((candidate) => candidate.peerId === peerId);
    }

    /**
     * Issue a new pairing code for a waiting guest, invalidating the old one
     */
    public static async regeneratePairingCode(serverId: string): Promise<void> {
        const server = getActiveServerRegistry().getServer(serverId);
        const runtime = server?.serverInstance as
            | { getRemoteSessionAuthority?: () => PairingAuthority }
            | undefined;
        const authority = typeof runtime?.getRemoteSessionAuthority === 'function'
            ? runtime.getRemoteSessionAuthority()
            : undefined;

        if (!authority) {
            void vscode.window.showWarningMessage('This server does not support remote access.');
            return;
        }

        const pending = authority.listPendingPairingRequests();
        if (pending.length === 0) {
            void vscode.window.showInformationMessage('Nobody is waiting to connect right now.');
            return;
        }

        let requestId = pending[0].requestId;
        if (pending.length > 1) {
            const selection = await vscode.window.showQuickPick(
                pending.map((request) => ({
                    label: request.displayName,
                    description: request.remoteAddress,
                    detail: request.codeValid
                        ? 'Waiting for the code'
                        : 'Their code was invalidated by a failed attempt',
                    requestId: request.requestId,
                })),
                { title: 'Generate new pairing code', placeHolder: 'Who is trying to connect?' },
            );
            if (!selection) {
                return;
            }
            requestId = selection.requestId;
        }

        // The authority emits a pairing-request event, which drives the toast
        // that shows the new code to the host.
        authority.regeneratePairingCode(requestId);
    }

    public static async showRemoteStatus(serverId: string): Promise<void> {
        const server = getActiveServerRegistry().getServer(serverId);
        const state = server?.remoteAccess;
        const title = server
            ? `Cross-network connection — ${getServerLabel(server)}`
            : 'Cross-network connection';

        const detail = state
            ? formatDetailSections([
                [
                    ['Status', formatRemoteStatus(state, false)],
                    ['Pending', state.status === 'shared'
                        ? formatPendingRequests(state.pendingRequests)
                        : undefined],
                ],
                [
                    ['Invitation', state.invitationUrl],
                    ['Public URL', state.publicUrl],
                ],
                [
                    ['Error', state.error],
                ],
            ])
            : formatDetailSections([[['Status', 'Not shared']]]);

        await vscode.window.showInformationMessage(title, { modal: true, detail });
    }

    /**
     * Stop server
     */
    public static async stopServer(serverId: string): Promise<void> {
        logger.debug(() => `Stopping server ${serverId}`);
        
        return withServer(serverId, async (server) => {
            const response = await vscode.window.showWarningMessage(
                `Stop server ${server.url}?`,
                'Stop',
                'Cancel'
            );

            if (response === 'Stop') {
                try {
                    await RemoteAccessManager.getInstance()?.stopSharing(serverId, false);
                    logger.debug(() => `Stopping server ${serverId} (${server.url})`);
                    const success = await ServerControl.stopServer(serverId);
                
                    if (success) {
                        logger.debug(() => `Successfully stopped server ${serverId}`);
                        void vscode.window.showInformationMessage(`Stopped server ${server.url}`);
                    
                        // Refresh the tree view
                        void vscode.commands.executeCommand('codeXR.activeServers.refreshServers');
                    } else {
                        logger.error(`Failed to stop server ${serverId}`);
                        void vscode.window.showErrorMessage(`Failed to stop server ${server.url}`);
                    }
                } catch (error) {
                    logger.error(`Error stopping server ${serverId}:`, error);
                    void vscode.window.showErrorMessage(
                        `Error stopping server: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            } else {
                logger.debug(() => `User cancelled stopping server ${serverId}`);
            }
        });
    }

    /**
     * Show detailed server information
     */
    public static async showServerDetails(serverId: string): Promise<void> {
        logger.debug(() => `Showing details for server ${serverId}`);
        
        return withServer(serverId, async (server) => {
            const details = formatServerDetails(server);

            logger.debug(() => `Displaying detailed information for server ${serverId}`);
            await vscode.window.showInformationMessage(
                `Server Information — ${getServerLabel(server)}`,
                { modal: true, detail: details }
            );
        });
    }

    /**
     * Stop all servers
     */
    public static async stopAllServers(): Promise<void> {
        logger.debug('Stopping all servers');

        // Count what "Stop all" will actually stop: the running servers. The
        // prompt used to count every entry, whatever its status.
        const registry = getActiveServerRegistry();
        const runningCount = registry.getServersByStatus('running').length;

        if (runningCount === 0) {
            void vscode.window.showInformationMessage('No servers are currently running');
            return;
        }

        const response = await vscode.window.showWarningMessage(
            `Stop all ${runningCount} server(s)?`,
            'Stop All',
            'Cancel'
        );

        if (response === 'Stop All') {
            try {
                await RemoteAccessManager.getInstance()?.stopAll();
                logger.debug(() => `Stopping ${runningCount} servers`);
                const { requested, stopped } = await ServerControl.stopAllServers();

                if (stopped === requested) {
                    logger.debug('Successfully stopped all servers');
                    void vscode.window.showInformationMessage(`Stopped ${stopped} server(s)`);
                } else {
                    logger.error(`Stopped ${stopped} of ${requested} servers`);
                    void vscode.window.showWarningMessage(
                        `Stopped ${stopped} of ${requested} server(s). The others were removed from the list but did not shut down cleanly; see the CodeXR output.`
                    );
                }

                // Refresh the tree view
                void vscode.commands.executeCommand('codeXR.activeServers.refreshServers');
            } catch (error) {
                logger.error('Error stopping all servers:', error);
                void vscode.window.showErrorMessage(
                    `Error stopping servers: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        } else {
            logger.debug('User cancelled stopping all servers');
        }
    }

    /**
     * Refresh servers display
     */
    public static async refreshServers(): Promise<void> {
        logger.debug('Refreshing servers display');
        void vscode.commands.executeCommand('codeXR.activeServers.refreshServers');
    }

    /**
     * Get available actions for a server based on its type
     * @private
     */
    private static getAvailableActions(server: ActiveServer): Array<{
        label: string;
        description: string;
        action: string;
    }> {
        const isHttp = server.certMode === 'http';

        const actions = [
            {
                label: 'Open in Browser',
                description: 'Open server in external browser',
                action: 'openInBrowser'
            }
        ];

        if (this.isRemoteAccessRelevant(server)) {
            this.appendRemoteActions(actions, server);
        }

        // Add lateral panel option only for HTTP servers
        if (isHttp) {
            actions.push({
                label: 'Open in Panel',
                description: 'Open server in VS Code lateral panel',
                action: 'openInPanel'
            });
        }

        actions.push(
            {
                label: 'Copy URL',
                description: 'Copy server URL to clipboard',
                action: 'copyUrl'
            },
            {
                label: 'Server Info',
                description: 'Show detailed server information',
                action: 'showDetails'
            },
            {
                label: 'Stop Server',
                description: 'Stop this server',
                action: 'stopServer'
            }
        );

        return actions;
    }

    /**
     * Mirror of the tree rule: remote entries appear only when the global
     * cross-network setting is enabled, or a tunnel is already active.
     */
    private static isRemoteAccessRelevant(server: ActiveServer): boolean {
        const status = server.remoteAccess?.status || 'stopped';
        if (status !== 'stopped') {
            return true;
        }
        try {
            return ServerSettingsManager.getInstance().getServerSettings().remoteAccess.enabled;
        } catch {
            return false;
        }
    }

    /**
     * Append the remote-access QuickPick entries for the server's tunnel state
     */
    private static appendRemoteActions(
        actions: Array<{ label: string; description: string; action: string }>,
        server: ActiveServer,
    ): void {
        if (server.remoteAccess?.status === 'shared' || server.remoteAccess?.status === 'starting') {
            actions.push(
                {
                    label: 'Copy remote invitation',
                    description: 'Copy the protected temporary link',
                    action: 'copyRemoteInvitation',
                },
                {
                    label: 'Remote status',
                    description: 'View pending requests and tunnel status',
                    action: 'remoteStatus',
                },
                {
                    label: 'Stop remote connection',
                    description: 'Close the tunnel and revoke the remote sessions',
                    action: 'stopRemoteAccess',
                },
            );
        } else {
            actions.push({
                label: 'Start remote connection',
                description: 'Publish temporarily through a Cloudflare Quick Tunnel',
                action: 'startRemoteAccess',
            });
            if (server.remoteAccess?.status === 'error') {
                actions.push({
                    label: 'View remote error',
                    description: server.remoteAccess.error || 'Tunnel error',
                    action: 'remoteStatus',
                });
            }
        }
    }

    /**
     * Execute an action on a server
     * @private
     */
    private static async executeAction(action: string, server: ActiveServer): Promise<void> {
        logger.debug(() => `Executing action '${action}' on server ${server.id}`);
        
        switch (action) {
            case 'openInBrowser':
                await this.openInBrowser(server.id);
                break;
            case 'openInPanel':
                await this.openInPanel(server.id);
                break;
            case 'copyUrl':
                await this.copyUrl(server.id);
                break;
            case 'showDetails':
                await this.showServerDetails(server.id);
                break;
            case 'startRemoteAccess':
                await this.startRemoteAccess(server.id);
                break;
            case 'copyRemoteInvitation':
                await this.copyRemoteInvitation(server.id);
                break;
            case 'remoteStatus':
                await this.showRemoteStatus(server.id);
                break;
            case 'stopRemoteAccess':
                await this.stopRemoteAccess(server.id);
                break;
            case 'stopServer':
                await this.stopServer(server.id);
                break;
            default:
                logger.error(`Unknown action: ${action}`);
                void vscode.window.showErrorMessage(`Unknown action: ${action}`);
        }
    }
}

import * as vscode from 'vscode';
import { ActiveServer } from '../../core/server/registry/activeServerModel';
import { getActiveServerRegistry } from '../../core/server/registry/activeServerRegistry';
import { getLogger } from '../../platform/logging/sink';

const logger = getLogger('ACTIVE_SERVER');

/**
 * Run an action on a registered server. An unknown id is logged and reported
 * with the same toast every server action has always shown, and the action
 * does not run.
 */
export async function withServer(
    serverId: string,
    action: (server: ActiveServer) => Promise<void>,
): Promise<void> {
    const registry = getActiveServerRegistry();
    const server = registry.getServer(serverId);

    if (!server) {
        logger.error(`Server ${serverId} not found`);
        void vscode.window.showErrorMessage(`Server not found: ${serverId}`);
        return;
    }

    return action(server);
}

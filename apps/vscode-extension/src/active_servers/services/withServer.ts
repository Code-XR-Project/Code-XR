import * as vscode from 'vscode';
import { ActiveServer } from '../model/activeServerModel';
import { getActiveServerRegistry } from '../registry/activeServerRegistry';

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
        console.error(`ACTIVE_SERVER: Server ${serverId} not found`);
        vscode.window.showErrorMessage(`Server not found: ${serverId}`);
        return;
    }

    return action(server);
}

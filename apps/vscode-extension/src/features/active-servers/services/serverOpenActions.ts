import * as vscode from 'vscode';
import { withServer } from './withServer';
import { PreviewRenderer } from './previewRenderer';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('ACTIVE_SERVER');

/*
 * Opening a registered server, in the browser or in the lateral panel. Shared
 * by the server actions of the tree and by the launch notifications, so the
 * launcher does not have to import a view module to open what it launched.
 */

/**
 * Open server in browser
 */
export async function openServerInBrowser(serverId: string): Promise<void> {
    logger.debug(() => `Opening server ${serverId} in browser`);
    
    return withServer(serverId, async (server) => {
        try {
            const browserUrl = typeof server.serverInstance?.createAuthenticatedBrowserUrl === 'function'
                ? server.serverInstance.createAuthenticatedBrowserUrl(server.url)
                : server.url;
            await PreviewRenderer.openPreview(browserUrl, server.htmlFile || '', 'browser');
            logger.debug(() => `Opened ${server.url} in browser`);
            void vscode.window.showInformationMessage(`Opened ${server.url} in browser`);
        } catch (error) {
            logger.error(`Error opening ${server.url} in browser:`, error);
            void vscode.window.showErrorMessage(
                `Failed to open in browser: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    });
}

/**
 * Open server in lateral panel
 */
export async function openServerInPanel(serverId: string): Promise<void> {
    logger.debug(() => `Opening server ${serverId} in lateral panel`);
    
    return withServer(serverId, async (server) => {
        // Check for HTTPS + lateral panel conflict
        if (server.certMode !== 'http') {
            logger.debug(() => `HTTPS server ${serverId} cannot be opened in lateral panel - cert mode: ${server.certMode}`);
        
            const response = await vscode.window.showWarningMessage(
                'HTTPS content cannot be displayed in VS Code panels due to security restrictions. The content will not load properly.',
                'Open in Browser Instead',
                'Cancel'
            );
        
            if (response === 'Open in Browser Instead') {
                logger.debug(() => `Redirecting server ${serverId} to browser due to HTTPS incompatibility`);
                return openServerInBrowser(serverId);
            } else {
                logger.debug(() => `User cancelled opening HTTPS server ${serverId} in panel`);
                return; // User cancelled
            }
        }

        try {
            logger.debug(() => `Opening HTTP server ${serverId} (${server.url}) in lateral panel`);
            const panelUrl = typeof server.serverInstance?.createAuthenticatedBrowserUrl === 'function'
                ? server.serverInstance.createAuthenticatedBrowserUrl(server.url)
                : server.url;
            await PreviewRenderer.openPreview(panelUrl, server.htmlFile || '', 'lateralPanel', serverId);
            logger.debug(() => `Successfully opened ${server.url} in lateral panel`);
            void vscode.window.showInformationMessage(`Opened ${server.url} in VS Code panel`);
        } catch (error) {
            logger.error(`Error opening ${server.url} in panel:`, error);
            void vscode.window.showErrorMessage(
                `Failed to open in panel: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    });
}

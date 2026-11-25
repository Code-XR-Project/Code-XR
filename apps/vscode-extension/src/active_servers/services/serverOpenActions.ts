import * as vscode from 'vscode';
import { withServer } from './withServer';
import { PreviewRenderer } from '../../servers/runtime/previewRenderer';

/*
 * Opening a registered server, in the browser or in the lateral panel. Shared
 * by the server actions of the tree and by the launch notifications, so the
 * launcher does not have to import a view module to open what it launched.
 */

/**
 * Open server in browser
 */
export async function openServerInBrowser(serverId: string): Promise<void> {
    console.log(`ACTIVE_SERVER: Opening server ${serverId} in browser`);
    
    return withServer(serverId, async (server) => {
        try {
            const browserUrl = typeof server.serverInstance?.createAuthenticatedBrowserUrl === 'function'
                ? server.serverInstance.createAuthenticatedBrowserUrl(server.url)
                : server.url;
            await PreviewRenderer.openPreview(browserUrl, server.htmlFile || '', 'browser');
            console.log(`ACTIVE_SERVER: Opened ${server.url} in browser`);
            vscode.window.showInformationMessage(`Opened ${server.url} in browser`);
        } catch (error) {
            console.error(`ACTIVE_SERVER: Error opening ${server.url} in browser:`, error);
            vscode.window.showErrorMessage(
                `Failed to open in browser: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    });
}

/**
 * Open server in lateral panel
 */
export async function openServerInPanel(serverId: string): Promise<void> {
    console.log(`ACTIVE_SERVER: Opening server ${serverId} in lateral panel`);
    
    return withServer(serverId, async (server) => {
        // Check for HTTPS + lateral panel conflict
        if (server.certMode !== 'http') {
            console.log(`ACTIVE_SERVER: HTTPS server ${serverId} cannot be opened in lateral panel - cert mode: ${server.certMode}`);
        
            const response = await vscode.window.showWarningMessage(
                'HTTPS content cannot be displayed in VS Code panels due to security restrictions. The content will not load properly.',
                'Open in Browser Instead',
                'Cancel'
            );
        
            if (response === 'Open in Browser Instead') {
                console.log(`ACTIVE_SERVER: Redirecting server ${serverId} to browser due to HTTPS incompatibility`);
                return openServerInBrowser(serverId);
            } else {
                console.log(`ACTIVE_SERVER: User cancelled opening HTTPS server ${serverId} in panel`);
                return; // User cancelled
            }
        }

        try {
            console.log(`ACTIVE_SERVER: Opening HTTP server ${serverId} (${server.url}) in lateral panel`);
            const panelUrl = typeof server.serverInstance?.createAuthenticatedBrowserUrl === 'function'
                ? server.serverInstance.createAuthenticatedBrowserUrl(server.url)
                : server.url;
            await PreviewRenderer.openPreview(panelUrl, server.htmlFile || '', 'lateralPanel', serverId);
            console.log(`ACTIVE_SERVER: Successfully opened ${server.url} in lateral panel`);
            vscode.window.showInformationMessage(`Opened ${server.url} in VS Code panel`);
        } catch (error) {
            console.error(`ACTIVE_SERVER: Error opening ${server.url} in panel:`, error);
            vscode.window.showErrorMessage(
                `Failed to open in panel: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    });
}

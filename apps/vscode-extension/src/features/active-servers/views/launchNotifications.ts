import * as vscode from 'vscode';
import type { ServerSettings } from '../../../core/server/serverSettingsManager';
import type { LaunchMode } from '../../../core/server/registry/activeServerModel';
import { openServerInBrowser, openServerInPanel } from '../services/serverOpenActions';
import { NetworkUtils } from '../../../core/server/networkUtils';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('SERVER');

/*
 * What the user sees around a MultiServerLauncher launch: the HTTPS-to-HTTP
 * override warning for the lateral panel, the busy-port notice, the
 * auto-open (or the "Open Now" / "Copy Network URL" toast when auto-open is
 * off) and the retry toast when auto-open fails.
 * Kept out of servers/runtime/ so the launcher holds no UI.
 */

/**
 * HTTPS was overridden to HTTP because the lateral panel cannot show HTTPS
 * content: say so, and offer to switch the open mode to the browser.
 */
export function warnHttpsOverriddenForPanel(): void {
    // Show non-blocking warning to user with actionable information
    void vscode.window.showWarningMessage(
        'Launching in HTTP mode due to VS Code limitations: lateral panel views do not support HTTPS content. Use browser mode to preserve HTTPS.',
        'Change to Browser Mode'
    ).then(action => {
        if (action === 'Change to Browser Mode') {
            // Open the configuration to change open mode
            void vscode.commands.executeCommand('codexr.server.config.openMode');
        }
    });
}

/**
 * Tell the user the configured port was busy and which one is used instead.
 */
export function notifyPortChanged(requestedPort: number, finalPort: number): void {
    void vscode.window.showInformationMessage(
        `Port ${requestedPort} was busy, launching server on port ${finalPort} instead.`
    );
}

/**
 * Handle auto-opening based on configuration
 */
export async function handleAutoOpening(
    settings: ServerSettings, 
    serverUrl: string, 
    _htmlFile: string | undefined, 
    launchMode: LaunchMode, 
    activeServerId: string
): Promise<void> {
    const isAutoOpenEnabled = settings.launch.autoOpen;
    
    logger.debug(() => `Auto-open configuration: enabled=${isAutoOpenEnabled}, mode=${launchMode}`);
    
    if (!isAutoOpenEnabled) {
        logger.debug('Auto-open is disabled, showing success notification only');
        
        // Extract port from serverUrl to generate network URLs
        const portMatch = serverUrl.match(/:(\d+)/);
        const port = portMatch ? parseInt(portMatch[1]) : null;
        const protocol = serverUrl.startsWith('https') ? 'https' : 'http';
        
        let notificationMessage = `Server launched successfully on ${serverUrl}`;
        
        // Add network access information if port is available
        if (port) {
            const localIP = NetworkUtils.getLocalIPAddress();
            if (localIP !== 'localhost') {
                const networkUrl = `${protocol}://${localIP}:${port}`;
                notificationMessage = `Server launched successfully! Network: ${networkUrl} Local: ${serverUrl}`;
                logger.debug(() => `Network access URL: ${networkUrl}`);
            }
        }
        
        void vscode.window.showInformationMessage(
            notificationMessage,
            'Open Now', 'Copy Network URL'
        ).then(action => {
            if (action === 'Open Now') {
                // Use the active server action handler to respect the configured mode
                if (launchMode === 'browser') {
                    void openLaunchedServerInBrowser(activeServerId);
                } else {
                    void openLaunchedServerInPanel(activeServerId);
                }
            } else if (action === 'Copy Network URL' && port) {
                const localIP = NetworkUtils.getLocalIPAddress();
                if (localIP !== 'localhost') {
                    const networkUrl = `${protocol}://${localIP}:${port}`;
                    void vscode.env.clipboard.writeText(networkUrl);
                    void vscode.window.showInformationMessage('Network URL copied to clipboard');
                }
            }
        });
        return;
    }
    
    logger.debug(() => `Auto-opening server in ${launchMode} mode`);
    
    try {
        // Auto-open using the configured launch mode
        if (launchMode === 'browser') {
            await openLaunchedServerInBrowser(activeServerId);
        } else {
            await openLaunchedServerInPanel(activeServerId);
        }
    } catch (error) {
        logger.error('Error during auto-opening:', error);
        void vscode.window.showWarningMessage(
            `Server launched but failed to auto-open: ${error instanceof Error ? error.message : String(error)}`,
            'Open Manually'
        ).then(action => {
            if (action === 'Open Manually') {
                if (launchMode === 'browser') {
                    void openLaunchedServerInBrowser(activeServerId);
                } else {
                    void openLaunchedServerInPanel(activeServerId);
                }
            }
        });
    }
}

// 1.3.0: the toast callbacks above start these two helpers with `void`, but
// they log and rethrow, so a failed open there is an unhandled rejection;
// await and report it instead. The "Copy Network URL" action likewise
// confirms the copy without awaiting clipboard.writeText.
/**
 * Open server in browser using shared handler
 */
async function openLaunchedServerInBrowser(activeServerId: string): Promise<void> {
    logger.debug(() => `Opening server ${activeServerId} in browser via shared handler`);
    try {
        await openServerInBrowser(activeServerId);
    } catch (error) {
        logger.error(`Failed to open server in browser: ${error}`);
        throw error;
    }
}

/**
 * Open server in lateral panel using shared handler
 */
async function openLaunchedServerInPanel(activeServerId: string): Promise<void> {
    logger.debug(() => `Opening server ${activeServerId} in lateral panel via shared handler`);
    try {
        await openServerInPanel(activeServerId);
    } catch (error) {
        logger.error(`Failed to open server in lateral panel: ${error}`);
        throw error;
    }
}

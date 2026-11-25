import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { handleHttpModeClick, handlePortClick, handleAutoOpenClick, handleOpenModeClick } from '../views/interactions/handleConfigurationClicks';
import { MultiServerLauncher } from '../../core/server/multiServerLauncher';
import { ServerSettingsManager, ServerSettings } from '../../core/server/serverSettingsManager';
import { CloudflaredBinaryManager } from '../../core/remote-access/cloudflaredBinaryManager';
import { RemoteAccessManager } from '../../core/remote-access/remoteAccessManager';
import { getLogger } from '../../platform/logging/sink';

const logger = getLogger('SERVER');

/**
 * Current server configuration state (legacy)
 */
export interface LegacyServerConfig {
    mode: string;
    description: string;
}

let currentServerConfig: LegacyServerConfig = {
    mode: 'HTTPS (generated local certificates)',
    description: 'HTTPS with generated local certificates'
};

// Global multi-server launcher instance
let multiServerLauncher: MultiServerLauncher | null = null;

// Extension context (set during command registration)
let extensionContext: vscode.ExtensionContext | null = null;

/**
 * The single "no extension context yet" refusal: shows the toast and narrows
 * the module-level context for the caller when it is set.
 */
function requireExtensionContext(
    context: vscode.ExtensionContext | null
): context is vscode.ExtensionContext {
    if (!context) {
        void vscode.window.showErrorMessage('SERVER: Extension context not available');
        return false;
    }
    return true;
}

/**
 * Opens server configuration panel
 */
export async function configureServer(): Promise<void> {
    logger.debug('Server configuration triggered');
    
    const options = [
        'HTTPS (generated local certificates)',
        'HTTPS (custom certificates)',
        'HTTP (development only)'
    ];
    
    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select server mode',
        canPickMany: false
    });
    
    if (selected) {
        currentServerConfig.mode = selected;
        switch (selected) {
            case 'HTTPS (generated local certificates)':
                currentServerConfig.description = 'HTTPS with generated local certificates';
                break;
            case 'HTTPS (custom certificates)':
                currentServerConfig.description = 'HTTPS with custom certificates';
                break;
            case 'HTTP (development only)':
                currentServerConfig.description = 'HTTP for development only';
                break;
        }
        
        logger.debug(() => `Configuration changed to ${currentServerConfig.mode}`);
        void vscode.window.showInformationMessage(`SERVER: Configuration updated to ${currentServerConfig.mode}`);
        
        // Refresh the tree view
        void vscode.commands.executeCommand('codexr.servers.refresh');
    }
}

/**
 * Starts the local server with current configuration
 * Main entry point for the "Start Local Server" command
 */
export async function startLocalServer(): Promise<void> {
    logger.debug('Start Local Server command triggered');
    
    try {
        // Step 1: Prompt user to select an HTML file
        const selectedFile = await promptForHtmlFile();
        if (!selectedFile) {
            logger.debug('No file selected, operation cancelled');
            return;
        }
        
        logger.debug(() => `Selected HTML file: ${selectedFile}`);
        
        // Step 2: Get extension context and initialize multi-server launcher
        if (!requireExtensionContext(extensionContext)) {
            return;
        }
        
        if (!multiServerLauncher) {
            multiServerLauncher = new MultiServerLauncher(extensionContext);
        }
        
        // Step 3: Get current server configuration
        const settingsManager = ServerSettingsManager.getInstance(extensionContext);
        await settingsManager.ensureInitialized();
        const settings = settingsManager.getServerSettings();
        
        logger.debug('Current configuration:', {
            mode: settings.mode,
            defaultPort: settings.defaultPort,
            autoOpen: settings.launch.autoOpen,
            openMode: settings.launch.openMode
        });
        
        // Step 4: Validate HTTPS custom certificates if needed
        if (settings.mode === 'HTTPS' && settings.https.certSource === 'custom') {
            const isValid = await validateCustomCertificates(settings);
            if (!isValid) {
                return; // Error message already shown in validation function
            }
        }
        
        // Step 5: Support multiple servers - show current status
        const runningCount = multiServerLauncher.getRunningServerCount();
        if (runningCount > 0) {
            logger.debug(() => `${runningCount} server(s) already running, launching additional server with dynamic port allocation`);
            void vscode.window.showInformationMessage(
                `Launching additional server (${runningCount} servers already running)`
            );
        }
        
        // Step 6: Launch the server with the selected HTML file using multi-server launcher
        logger.debug('Launching server...');
        const result = await multiServerLauncher.launchServer(selectedFile);
        
        if (!result.success) {
            logger.error('Failed to launch server:', result.error);
            void vscode.window.showErrorMessage(`Failed to start server: ${result.error}`);
            return;
        }
        
        logger.debug(() => `Server launched successfully at ${result.serverUrl} (Server ID: ${result.serverId})`);
        
        // Provide detailed messages based on port allocation and HTTPS override
        if (result.portChanged && result.httpsOverridden) {
            void vscode.window.showInformationMessage(
                `Server started at ${result.serverUrl} (Port changed from ${result.originalPort} to ${result.port}, HTTP mode - HTTPS overridden for lateral panel compatibility)`
            );
        } else if (result.portChanged) {
            void vscode.window.showInformationMessage(
                `Server started at ${result.serverUrl} (Port changed from ${result.originalPort} to ${result.port})`
            );
        } else if (result.httpsOverridden) {
            void vscode.window.showInformationMessage(
                `Server started at ${result.serverUrl} (HTTP mode - HTTPS overridden for lateral panel compatibility)`
            );
        } else {
            void vscode.window.showInformationMessage(`Server started at ${result.serverUrl}`);
        }
        
        // Refresh the tree view to show server status
        void vscode.commands.executeCommand('codexr.servers.refresh');
        
    } catch (error) {
        logger.error('Error in startLocalServer:', error);
        void vscode.window.showErrorMessage(`Failed to start server: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Configuration interaction handlers
 */
export async function configureHttpMode(): Promise<void> {
    await handleHttpModeClick();
}

export async function configurePort(): Promise<void> {
    await handlePortClick();
}

export async function toggleAutoOpen(): Promise<void> {
    await handleAutoOpenClick();
}

export async function configureOpenMode(): Promise<void> {
    await handleOpenModeClick();
}

export async function configureRemoteAccess(): Promise<void> {
    if (!requireExtensionContext(extensionContext)) {
        return;
    }
    const settingsManager = ServerSettingsManager.getInstance(extensionContext);
    await settingsManager.ensureInitialized();
    const current = settingsManager.getServerSettings().remoteAccess.enabled;
    const selection = await vscode.window.showQuickPick([
        {
            label: 'Disabled',
            description: 'Servers are only reachable on the local network.',
            enabled: false,
        },
        {
            label: 'Enabled',
            description: 'Allows explicitly sharing servers through a Cloudflare Quick Tunnel.',
            enabled: true,
        },
    ], {
        title: 'Cross-network connections',
        placeHolder: current ? 'Currently enabled' : 'Currently disabled',
    });
    if (!selection) {
        return;
    }
    await settingsManager.updateServerSettings({
        remoteAccess: {
            enabled: selection.enabled,
            provider: 'cloudflare-quick',
        },
    });
    if (selection.enabled) {
        // Fire and forget: each tunnel can take up to 30 s to publish, and the
        // registry updates repaint the tree as servers move starting → shared.
        void RemoteAccessManager.getInstance()?.startAllEligible();
    } else {
        await RemoteAccessManager.getInstance()?.stopAll();
        // An explicit disable uninstalls the component CodeXR downloaded for
        // this: nothing lingers in global storage once cross-network is off.
        // A system-wide cloudflared on PATH is never touched — it is not
        // CodeXR's to remove.
        await new CloudflaredBinaryManager(extensionContext).uninstallManagedBinary();
    }
}

/**
 * Reset server configuration to default values
 */
export async function resetToDefault(): Promise<void> {
    logger.debug('Resetting server configuration to defaults');
    
    const confirm = await vscode.window.showWarningMessage(
        'This will reset all server configuration to default values. Are you sure?',
        { modal: true },
        'Reset to Default',
        'Cancel'
    );
    
    if (confirm !== 'Reset to Default') {
        return;
    }
    
    try {
        if (!requireExtensionContext(extensionContext)) {
            return;
        }
        
        const settingsManager = ServerSettingsManager.getInstance(extensionContext);
        await settingsManager.resetSettings();
        
        logger.debug('Configuration reset to defaults successfully');
        void vscode.window.showInformationMessage('Server configuration reset to default values');
        
        // Refresh the tree view to show updated configuration
        void vscode.commands.executeCommand('codexr.servers.refresh');
        
    } catch (error) {
        logger.error('Error resetting configuration to defaults:', error);
        void vscode.window.showErrorMessage(
            `Failed to reset configuration: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Set the extension context (called during command registration)
 */
export function setExtensionContext(context: vscode.ExtensionContext): void {
    extensionContext = context;
}

/**
 * Helper Functions for Server Launching
 */

/**
 * Prompts user to select an HTML file from the file system
 * @returns Promise<string | undefined> - Path to selected file or undefined if cancelled
 */
async function promptForHtmlFile(): Promise<string | undefined> {
    logger.debug('Prompting user to select HTML file');
    
    const options: vscode.OpenDialogOptions = {
        canSelectMany: false,
        openLabel: 'Select HTML File',
        filters: {
            'HTML Files': ['html', 'htm'],
            'All Files': ['*']
        },
        title: 'Select HTML file to serve'
    };
    
    const fileUri = await vscode.window.showOpenDialog(options);
    
    if (fileUri?.[0]) {
        const filePath = fileUri[0].fsPath;
        logger.debug(() => `User selected file: ${filePath}`);
        
        // Validate that the file exists and is readable
        try {
            await fs.promises.access(filePath, fs.constants.R_OK);
            return filePath;
        } catch (error) {
            logger.error(`Cannot read selected file: ${error}`);
            void vscode.window.showErrorMessage(`Cannot read the selected file: ${path.basename(filePath)}`);
            return undefined;
        }
    }
    
    return undefined;
}

/**
 * Validates custom HTTPS certificates exist and are readable
 * @param settings - Server settings containing certificate paths
 * @returns Promise<boolean> - True if certificates are valid
 */
async function validateCustomCertificates(settings: ServerSettings): Promise<boolean> {
    logger.debug('Validating custom certificates');
    
    const certPath = settings.https.certPath;
    const keyPath = settings.https.keyPath;
    
    if (!certPath || !keyPath) {
        logger.debug('Custom certificate paths not configured');
        void vscode.window.showErrorMessage(
            'Custom certificates are not configured. Please configure certificate paths in server settings.',
            'Configure'
        ).then(action => {
            if (action === 'Configure') {
                void vscode.commands.executeCommand('codexr.server.configure');
            }
        });
        return false;
    }
    
    // Check if certificate file exists
    if (!fs.existsSync(certPath)) {
        logger.debug(() => `Certificate file not found: ${certPath}`);
        void vscode.window.showErrorMessage(
            `Certificate file not found: ${path.basename(certPath)}`,
            'Configure'
        ).then(action => {
            if (action === 'Configure') {
                void vscode.commands.executeCommand('codexr.server.configure');
            }
        });
        return false;
    }
    
    // Check if key file exists
    if (!fs.existsSync(keyPath)) {
        logger.debug(() => `Private key file not found: ${keyPath}`);
        void vscode.window.showErrorMessage(
            `Private key file not found: ${path.basename(keyPath)}`,
            'Configure'
        ).then(action => {
            if (action === 'Configure') {
                void vscode.commands.executeCommand('codexr.server.configure');
            }
        });
        return false;
    }
    
    // Check if files are readable
    try {
        await fs.promises.access(certPath, fs.constants.R_OK);
        await fs.promises.access(keyPath, fs.constants.R_OK);
        logger.debug('Custom certificates validated successfully');
        return true;
    } catch (error) {
        logger.error(`Cannot read certificate files: ${error}`);
        void vscode.window.showErrorMessage('Cannot read certificate files. Check file permissions.');
        return false;
    }
}

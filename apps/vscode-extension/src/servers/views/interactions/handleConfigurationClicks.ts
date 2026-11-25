import * as vscode from 'vscode';
import { ensureServerConfigReady, updateServerConfig, getServerConfig } from '../items/configurationItems';
import { getLogger } from '../../../core/logging/sink';

const logger = getLogger('SERVER');

/**
 * Handle HTTP Mode configuration click
 */
export async function handleHttpModeClick(): Promise<void> {
    logger.debug('HTTP Mode configuration clicked');
    
    const options = [
        'HTTP',
        'HTTPS (generated local certificates)',
        'HTTPS (custom certificates)'
    ];
    
    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select HTTP mode',
        canPickMany: false
    });
    
    if (selected) {
        // Handle HTTP mode selection with confirmation dialog
        if (selected === 'HTTP') {
            const confirmed = await vscode.window.showWarningMessage(
                'HTTP is not secure and XR features like VR will not work. Are you sure you want to proceed?',
                { modal: true },
                'Yes',
                'No'
            );
            
            if (confirmed !== 'Yes') {
                logger.debug('HTTP mode selection cancelled by user');
                return;
            }
            
            logger.debug('HTTP mode confirmed by user');
        }
        
        // Handle HTTPS with custom certificates
        if (selected === 'HTTPS (custom certificates)') {
            logger.debug('HTTPS custom certificates selected, opening file pickers');
            
            // First: Select certificate file (cert.pem)
            const certFileUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'Certificate files': ['pem', 'crt', 'cert']
                },
                openLabel: 'Select Certificate File (cert.pem)'
            });
            
            if (!certFileUri || certFileUri.length === 0) {
                logger.debug('Certificate file selection cancelled');
                return;
            }
            
            const certPath = certFileUri[0].fsPath;
            logger.debug(() => `Certificate file selected: ${certPath}`);
            
            // Second: Select private key file (key.pem)
            const keyFileUri = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'Key files': ['pem', 'key']
                },
                openLabel: 'Select Private Key File (key.pem)'
            });
            
            if (!keyFileUri || keyFileUri.length === 0) {
                logger.debug('Private key file selection cancelled');
                return;
            }
            
            const keyPath = keyFileUri[0].fsPath;
            logger.debug(() => `Private key file selected: ${keyPath}`);
            logger.debug(() => `Custom certificate configuration - Cert: ${certPath}, Key: ${keyPath}`);
            
            // Store the custom certificate configuration in a single update
            await updateServerConfig({ 
                httpMode: selected,
                customCertPath: certPath,
                customKeyPath: keyPath
            });
            
            logger.debug(() => `HTTP mode changed to ${selected} with custom certificates`);
            void vscode.window.showInformationMessage(`SERVER: HTTPS mode updated with custom certificates`);
        } else {
            // Handle HTTP and HTTPS with generated local certificates
            await updateServerConfig({ httpMode: selected });
            logger.debug(() => `HTTP mode changed to ${selected}`);
            void vscode.window.showInformationMessage(`SERVER: HTTP mode updated to ${selected}`);
        }
    }
}

/**
 * Handle Default Port configuration click
 */
export async function handlePortClick(): Promise<void> {
    logger.debug('Port configuration clicked');
    
    const input = await vscode.window.showInputBox({
        prompt: 'Enter port number (3000-8080)',
        placeHolder: '3000',
        validateInput: (value: string) => {
            const num = parseInt(value);
            if (isNaN(num)) {
                return 'Please enter a valid number';
            }
            if (num < 3000 || num > 8080) {
                return 'Port must be between 3000 and 8080';
            }
            return null;
        }
    });
    
    if (input) {
        const port = parseInt(input);
        await updateServerConfig({ port });
        logger.debug(() => `Port changed to ${port}`);
        void vscode.window.showInformationMessage(`SERVER: Port updated to ${port}`);
    }
}

/**
 * Handle Auto-Open toggle click
 */
export async function handleAutoOpenClick(): Promise<void> {
    logger.debug('Auto-Open toggle clicked');

    await ensureServerConfigReady();
    const currentConfig = getServerConfig();
    const newValue = !currentConfig.autoOpen;
    
    await updateServerConfig({ autoOpen: newValue });
    logger.debug(() => `Auto-Open toggled to ${newValue ? 'Yes' : 'No'}`);
    
    const message = newValue ? 'Auto-Open enabled' : 'Auto-Open disabled';
    void vscode.window.showInformationMessage(`SERVER: ${message}`);
}

/**
 * Handle Open Mode configuration click
 */
export async function handleOpenModeClick(): Promise<void> {
    logger.debug('Open Mode configuration clicked');

    await ensureServerConfigReady();
    const currentConfig = getServerConfig();
    const newMode = currentConfig.openMode === 'Browser' ? 'Lateral Panel' : 'Browser';
    
    await updateServerConfig({ openMode: newMode });
    logger.debug(() => `Open Mode changed to ${newMode}`);
    void vscode.window.showInformationMessage(`SERVER: Open Mode set to ${newMode}`);
}


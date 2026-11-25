import * as vscode from 'vscode';
import { BabiaExampleTreeItem } from '../items/babiaExampleItems';
import { ExampleLauncher } from '../../../babia_examples/runtime/exampleLauncher';
import { getLogger } from '../../../core/logging/sink';

const logger = getLogger('BABIA_EXAMPLES_MODULAR');

/**
 * Handler for Babia Examples section interactions
 */
export class BabiaExampleClickHandler {
    private exampleLauncher: ExampleLauncher;

    constructor(context: vscode.ExtensionContext) {
        this.exampleLauncher = new ExampleLauncher(context);
    }

    /**
     * Handle clicks on Babia example items
     */
    async handleBabiaExampleClick(item: BabiaExampleTreeItem): Promise<void> {
        logger.debug(() => `Handling click on example item: ${item.label} (type: ${item.babiaItemType})`);

        switch (item.babiaItemType) {
            case 'example-item':
                await this.handleExampleItemClick(item);
                break;
                
            case 'no-examples':
            case 'loading':
            case 'error':
                // No action needed for informational items
                logger.debug(() => `Clicked on informational item: ${item.babiaItemType}`);
                break;
                
            default:
                logger.warn(`Unknown example item type: ${item.babiaItemType}`);
        }
    }

    /**
     * Handle click on individual example item
     */
    private async handleExampleItemClick(item: BabiaExampleTreeItem): Promise<void> {
        if (!item.babiaExample) {
            logger.error('No example data in example item');
            return;
        }

        if (!item.babiaExample.isValid) {
            logger.warn('Attempted to launch invalid example');
            void vscode.window.showWarningMessage(`Example "${item.babiaExample.name}" is invalid and cannot be launched.`);
            return;
        }

        logger.debug(`Launching example: ${item.babiaExample.id}`);
        
        try {
            // Use the example launcher to handle the launch
            await this.exampleLauncher.launchExample(item.babiaExample);
            
            void vscode.window.showInformationMessage(`Example "${item.babiaExample.name}" launched successfully!`);
            
        } catch (error) {
            logger.error(`Error launching example ${item.babiaExample.id}:`, error);
            void vscode.window.showErrorMessage(`Failed to launch example "${item.babiaExample.name}": ${error}`);
        }
    }

    /**
     * Handle right-click context menu actions
     */
    async handleContextMenuAction(action: string, item: BabiaExampleTreeItem): Promise<void> {
        logger.debug(() => `Handling context menu action: ${action} on item: ${item.label}`);

        switch (action) {
            case 'refresh':
                logger.debug('Refreshing examples view');
                // Refresh will be triggered by the provider
                break;
                
            case 'launchExample':
                if (item.babiaExample && item.babiaExample.isValid) {
                    logger.debug(`Launching example from context menu: ${item.babiaExample.id}`);
                    await this.handleExampleItemClick(item);
                }
                break;
                
            case 'openInBrowser':
                if (item.babiaExample && item.babiaExample.isValid) {
                    logger.debug(`Opening example in browser: ${item.babiaExample.id}`);
                    await this.launchExampleInBrowser(item.babiaExample);
                }
                break;
                
            case 'openInPanel':
                if (item.babiaExample && item.babiaExample.isValid) {
                    logger.debug(`Opening example in panel: ${item.babiaExample.id}`);
                    await this.launchExampleInPanel(item.babiaExample);
                }
                break;
                
            case 'showDetails':
                if (item.babiaExample) {
                    logger.debug(`Showing example details: ${item.babiaExample.id}`);
                    await this.showExampleDetails(item.babiaExample);
                }
                break;
                
            default:
                logger.warn(`Unknown context menu action: ${action}`);
        }
    }

    /**
     * Launch example specifically in browser
     */
    private async launchExampleInBrowser(example: any): Promise<void> {
        try {
            // For now, use the default launcher - future enhancement could support launch mode selection
            await this.exampleLauncher.launchExample(example);
            void vscode.window.showInformationMessage(`Example "${example.name}" launched! (Uses current user configuration for launch mode)`);
        } catch (error) {
            logger.error(`Error launching example:`, error);
            void vscode.window.showErrorMessage(`Failed to launch example: ${error}`);
        }
    }

    /**
     * Launch example specifically in panel
     */
    private async launchExampleInPanel(example: any): Promise<void> {
        try {
            // For now, use the default launcher - future enhancement could support launch mode selection
            await this.exampleLauncher.launchExample(example);
            void vscode.window.showInformationMessage(`Example "${example.name}" launched! (Uses current user configuration for launch mode)`);
        } catch (error) {
            logger.error(`Error launching example:`, error);
            void vscode.window.showErrorMessage(`Failed to launch example: ${error}`);
        }
    }

    /**
     * Show detailed information about an example
     */
    private async showExampleDetails(example: any): Promise<void> {
        const details = `Example Details:
        
Name: ${example.name}
Category: ${example.category}
File: ${example.htmlFilePath}
Directory: ${example.directory}
Valid: ${example.isValid ? 'Yes' : 'No'}
${example.description ? `Description: ${example.description}` : ''}`;

        void vscode.window.showInformationMessage(details, { modal: true });
    }
}

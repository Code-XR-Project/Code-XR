import * as vscode from 'vscode';
import { VisualizeDataModularTreeItem } from '../items/visualizeDataItems';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('VISUALIZE_DATA_MODULAR');

/**
 * Handler for Visualize Data section interactions
 */
export class VisualizeDataClickHandler {
    constructor(_context: vscode.ExtensionContext) {}

    /**
     * Handle clicks on visualize data items
     */
    async handleVisualizeDataClick(item: VisualizeDataModularTreeItem): Promise<void> {
        logger.debug(() => `Handling click on visualize data item: ${item.label} (type: ${item.visualizeDataItemType})`);

        // For most visualize data items, the command is already attached to the tree item
        // and will be executed automatically by VS Code
        switch (item.visualizeDataItemType) {
            case 'chart-type':
                logger.debug('Chart type selection clicked');
                // Command: 'codeXR.visualizeData.chartType' is already attached
                break;
                
            case 'select-json':
                logger.debug('Select JSON file clicked');
                // Command: 'codeXR.visualizeData.selectJson' is already attached
                break;
                
            case 'dimension-mapping':
                logger.debug('Dimension mapping clicked');
                // This is a collapsible item, no direct action needed
                break;
                
            case 'dimension-item':
                logger.debug('Dimension item clicked');
                // Command varies per dimension item and is already attached
                break;
                
            case 'launch-visualization':
                logger.debug('Launch visualization clicked');
                // Command: 'codeXR.visualizeData.launchVisualization' is already attached
                break;
                
            case 'browse-visualizations':
                logger.debug('Browse visualizations clicked');
                // This is a collapsible item, no direct action needed
                break;
                
            case 'stored-visualization':
                logger.debug('Stored visualization clicked');
                // Command varies per stored visualization and is already attached
                break;
                
            case 'error':
                logger.debug('Error item clicked - no action');
                break;
                
            default:
                logger.warn(`Unknown visualize data item type: ${item.visualizeDataItemType}`);
        }
    }

    /**
     * Handle right-click context menu actions
     */
    async handleContextMenuAction(action: string, item: VisualizeDataModularTreeItem): Promise<void> {
        logger.debug(() => `Handling context menu action: ${action} on item: ${item.label}`);

        switch (action) {
            case 'refresh':
                logger.debug('Refreshing visualize data view');
                // Refresh will be triggered by the provider
                break;
                
            case 'reset':
                await this.handleResetAction(item);
                break;
                
            case 'configure':
                await this.handleConfigureAction(item);
                break;
                
            case 'launch':
                await this.handleLaunchAction(item);
                break;
                
            case 'details':
                await this.handleShowDetails(item);
                break;
                
            default:
                logger.warn(`Unknown context menu action: ${action}`);
        }
    }

    /**
     * Handle reset action
     */
    private async handleResetAction(item: VisualizeDataModularTreeItem): Promise<void> {
        logger.debug(() => `Handling reset action for: ${item.label}`);
        
        switch (item.visualizeDataItemType) {
            case 'chart-type':
                // Reset chart type selection
                await vscode.commands.executeCommand('codeXR.visualizeData.resetChartType');
                break;
                
            case 'select-json':
                // Reset JSON file selection
                await vscode.commands.executeCommand('codeXR.visualizeData.resetJsonFile');
                break;
                
            case 'dimension-mapping':
                // Reset all dimension mappings
                await vscode.commands.executeCommand('codeXR.visualizeData.resetDimensions');
                break;
                
            default:
                void vscode.window.showInformationMessage(`Reset not available for ${item.label}`);
        }
    }

    /**
     * Handle configure action
     */
    private async handleConfigureAction(item: VisualizeDataModularTreeItem): Promise<void> {
        logger.debug(() => `Handling configure action for: ${item.label}`);
        
        switch (item.visualizeDataItemType) {
            case 'chart-type':
                await vscode.commands.executeCommand('codeXR.visualizeData.chartType');
                break;
                
            case 'select-json':
                await vscode.commands.executeCommand('codeXR.visualizeData.selectJson');
                break;
                
            case 'dimension-item':
                // Execute the dimension item's command if available
                if (item.command) {
                    await vscode.commands.executeCommand(item.command.command, ...(item.command.arguments ?? []));
                }
                break;
                
            default:
                void vscode.window.showInformationMessage(`Configuration not available for ${item.label}`);
        }
    }

    /**
     * Handle launch action
     */
    private async handleLaunchAction(item: VisualizeDataModularTreeItem): Promise<void> {
        logger.debug(() => `Handling launch action for: ${item.label}`);
        
        if (item.visualizeDataItemType === 'stored-visualization' && item.command) {
            // Launch stored visualization
            await vscode.commands.executeCommand(item.command.command, ...(item.command.arguments ?? []));
        } else {
            // Launch current visualization configuration
            await vscode.commands.executeCommand('codeXR.visualizeData.launchVisualization');
        }
    }

    /**
     * Show details about the item
     */
    private async handleShowDetails(item: VisualizeDataModularTreeItem): Promise<void> {
        logger.debug(() => `Showing details for: ${item.label}`);
        
        let details = `Visualize Data Item Details:

Name: ${item.label}
Type: ${item.visualizeDataItemType}
Description: ${item.description || 'No description available'}
Tooltip: ${item.tooltip || 'No tooltip available'}`;

        if (item.command) {
            details += `\nCommand: ${item.command.command}`;
        }

        if (item.contextValue) {
            details += `\nContext: ${item.contextValue}`;
        }

        void vscode.window.showInformationMessage(details, { modal: true });
    }
}

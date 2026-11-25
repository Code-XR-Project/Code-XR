import * as vscode from 'vscode';
import { BaseSectionProvider } from '../common/baseInterfaces';
import { ServerTreeItem, ServerItemFactory } from './items/serverItems';
import { ServerSettingsManager } from '../../servers/storage/serverSettingsManager';

/**
 * Servers section provider for the modular tree view architecture
 */
export class ServersSectionProvider extends BaseSectionProvider<ServerTreeItem> {
    constructor(context: vscode.ExtensionContext) {
        super(context);
        console.log('SERVERS: Servers section provider initialized');
    }

    getSectionName(): string {
        return 'SERVERS';
    }

    getSectionItem(): ServerTreeItem {
        console.log('SERVERS: Creating main SERVERS section item');
        
        return new ServerTreeItem(
            'SERVERS',
            vscode.TreeItemCollapsibleState.Expanded,
            'config-group',
            undefined,
            new vscode.ThemeIcon('server-environment'),
            'Server configuration and launch options'
        );
    }

    /**
     * Get children for the servers section
     */
    async getChildren(element?: ServerTreeItem): Promise<ServerTreeItem[]> {
        if (!element) {
            // Return main section children
            console.log('SERVERS: Loading main servers section children');
            return this.getMainSectionChildren();
        }

        // Handle sub-items based on type
        switch (element.serverItemType) {
            case 'config-group':
                if (element.label === 'Server Configuration') {
                    return this.getConfigurationChildren();
                }
                break;
            default:
                return [];
        }

        return [];
    }

    /**
     * Get main section children
     */
    private getMainSectionChildren(): ServerTreeItem[] {
        console.log('SERVERS: Creating main section children');
        
        // Get current server configuration for the start server option
        const port = this.getServerPort();
        const httpMode = this.getHttpMode();
        
        return [
            ServerItemFactory.createConfigurationGroup(),
            ServerItemFactory.createStartServerOption(port, httpMode)
        ];
    }

    /**
     * Get configuration children
     */
    private getConfigurationChildren(): ServerTreeItem[] {
        console.log('SERVERS: Creating configuration children');
        return ServerItemFactory.createConfigurationOptions();
    }

    /**
     * Get current server port from configuration
     */
    private getServerPort(): number {
        const config = ServerSettingsManager.getInstance().getLegacyConfig();
        return config.port;
    }

    /**
     * Get current HTTP mode from configuration
     */
    private getHttpMode(): string {
        const config = ServerSettingsManager.getInstance().getLegacyConfig();
        return config.httpMode;
    }
}

/**
 * Learn More Items
 * Tree view items for the Learn More section
 */

import * as vscode from 'vscode';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('LEARN_MORE');

/**
 * Base class for Learn More modular tree items
 */
export class LearnMoreModularTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly learnMoreItemType: string,
        public readonly command?: vscode.Command,
        public readonly iconPath?: vscode.ThemeIcon | vscode.Uri,
        public readonly tooltip?: string,
        public readonly description?: string,
        public readonly contextValue?: string
    ) {
        super(label, collapsibleState);
        this.command = command;
        this.iconPath = iconPath;
        this.tooltip = tooltip;
        this.description = description;
        this.contextValue = contextValue;
    }
}

/**
 * Factory for creating Learn More tree items
 */
export class LearnMoreModularItemFactory {
    
    /**
     * Create learn more section items
     */
    static createLearnMoreItems(_context: vscode.ExtensionContext): LearnMoreModularTreeItem[] {
        logger.debug('Creating learn more items');
        
        const items: LearnMoreModularTreeItem[] = [];
        
        // Main "Learn More" action item
        const learnMoreItem = new LearnMoreModularTreeItem(
            'Open Documentation Website',
            vscode.TreeItemCollapsibleState.None,
            'action',
            {
                command: 'codeXR.learnMore',
                title: 'Learn More',
                arguments: []
            },
            new vscode.ThemeIcon('globe', new vscode.ThemeColor('charts.foreground')),
            'Visit the official Code-XR documentation website for tutorials, guides, and examples',
            'Official docs & tutorials',
            'learnMoreAction'
        );
        
        items.push(learnMoreItem);

        const authorItem = new LearnMoreModularTreeItem(
            'Meet the Creator',
            vscode.TreeItemCollapsibleState.None,
            'action',
            {
                command: 'codeXR.openAuthorWebsite',
                title: 'Open Author Website',
                arguments: []
            },
            new vscode.ThemeIcon('account', new vscode.ThemeColor('charts.foreground')),
            'Visit the personal website of Adrián Montes Linares, the author of Code-XR',
            'About the author',
            'learnMoreAuthorAction'
        );

        items.push(authorItem);

        const supportItem = new LearnMoreModularTreeItem(
            'Support Code-XR (Buy Me a Coffee)',
            vscode.TreeItemCollapsibleState.None,
            'action',
            {
                command: 'codeXR.supportDeveloper',
                title: 'Support Developer',
                arguments: []
            },
            new vscode.ThemeIcon('heart', new vscode.ThemeColor('charts.foreground')),
            'Support Code-XR development on Buy Me a Coffee',
            'Help sustain development',
            'learnMoreSupportAction'
        );

        items.push(supportItem);
        
        return items;
    }
}

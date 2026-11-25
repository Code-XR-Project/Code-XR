/**
 * Learn More Section Provider
 * Manages the Learn More section for CodeXR tutorials and documentation
 */

import * as vscode from 'vscode';
import { BaseSectionProvider } from '../../../platform/tree/baseInterfaces';
import { LearnMoreModularTreeItem, LearnMoreModularItemFactory } from './learnMoreItems';
import { LearnMoreClickHandler } from './handleLearnMoreClicks';
import { getLogger } from '../../../platform/logging/sink';

const logger = getLogger('LEARN_MORE');

/**
 * Learn More section provider - provides access to CodeXR learning resources
 */
export class LearnMoreSectionProvider extends BaseSectionProvider<LearnMoreModularTreeItem> {
    private clickHandler: LearnMoreClickHandler;

    constructor(context: vscode.ExtensionContext) {
        super(context);
        logger.debug('Initializing Learn More section provider');
        this.clickHandler = new LearnMoreClickHandler(context);
    }

    getSectionName(): string {
        return 'learnMore';
    }

    getSectionItem(): LearnMoreModularTreeItem {
        return new LearnMoreModularTreeItem(
            'LEARN MORE & SUPPORT',
            vscode.TreeItemCollapsibleState.Collapsed,
            'section',
            undefined,
            new vscode.ThemeIcon('book', new vscode.ThemeColor('charts.foreground')),
            'Access CodeXR documentation, tutorials, examples, and support options',
            'Docs, tutorials & support',
            'learnMoreSection'
        );
    }

    async getChildren(element?: LearnMoreModularTreeItem): Promise<LearnMoreModularTreeItem[]> {
        if (!element) {
            logger.debug('Loading learn more section children');
            return LearnMoreModularItemFactory.createLearnMoreItems(this.context);
        }
        return [];
    }

    handleItemClick(item: LearnMoreModularTreeItem): void {
        logger.debug('Item clicked:', item.label);
        this.clickHandler.handleClick(item);
    }
}

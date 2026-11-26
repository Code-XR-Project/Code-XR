import * as vscode from 'vscode';
import { BaseSectionProvider } from '../../../platform/tree/baseInterfaces';
import { AI_AGENTS_TOOLTIP, AiAgentsTreeItem, createComingSoonItem } from './aiAgentsItems';

/** The AI AGENTS section: a "coming soon" placeholder in 1.2.1. */
export class AiAgentsSectionProvider extends BaseSectionProvider<AiAgentsTreeItem> {
    getSectionName(): string {
        return 'aiAgents';
    }

    getSectionItem(): AiAgentsTreeItem {
        return new AiAgentsTreeItem(
            'AI AGENTS',
            vscode.TreeItemCollapsibleState.Collapsed,
            'coming-soon',
            undefined,
            new vscode.ThemeIcon('sparkle'),
            AI_AGENTS_TOOLTIP,
            'Coming soon',
            'aiAgentsSection',
        );
    }

    async getChildren(element?: AiAgentsTreeItem): Promise<AiAgentsTreeItem[]> {
        return element ? [] : [createComingSoonItem()];
    }
}

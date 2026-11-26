import * as vscode from 'vscode';

/**
 * Rows of the AI AGENTS section. In 1.2.1 the section is a placeholder that
 * only says the feature is coming (epic #189, stories #214-#216): it offers
 * no command and makes no network call.
 */
export type AiAgentsItemType = 'coming-soon';

/** The positional arguments ModularTreeDataProvider's section adapter passes. */
type AiAgentsItemArgs = [
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    aiAgentsItemType: AiAgentsItemType,
    command?: vscode.Command,
    iconPath?: vscode.ThemeIcon | vscode.Uri,
    tooltip?: string,
    description?: string,
    contextValue?: string,
];

export class AiAgentsTreeItem extends vscode.TreeItem {
    public readonly aiAgentsItemType: AiAgentsItemType;

    constructor(...[label, collapsibleState, aiAgentsItemType, command, iconPath, tooltip, description, contextValue]: AiAgentsItemArgs) {
        super(label, collapsibleState);
        this.aiAgentsItemType = aiAgentsItemType;
        this.command = command;
        this.iconPath = iconPath;
        this.tooltip = tooltip ?? label;
        this.description = description;
        this.contextValue = contextValue;
    }
}

export const AI_AGENTS_TOOLTIP = 'Chat with AI agents about your code and its Code-XR analyses, with your own provider keys. Coming soon.';

/** The section's only row. */
export function createComingSoonItem(): AiAgentsTreeItem {
    return new AiAgentsTreeItem(
        'AI agents are coming soon',
        vscode.TreeItemCollapsibleState.None,
        'coming-soon',
        undefined,
        new vscode.ThemeIcon('sparkle'),
        AI_AGENTS_TOOLTIP,
        undefined,
        'codeXR.aiAgents.comingSoon',
    );
}

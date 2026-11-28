import * as vscode from 'vscode';

/**
 * Rows of the AI AGENTS section. Agent Flow (epic #319) lives here: watch an
 * agent session of the workspace (Claude Code, Codex) as the fifth analysis
 * type in XR. Chatting with agents from the extension is still coming
 * (epic #189, stories #214-#216). No row makes a network call: the sessions
 * are read from the local agents' own history files.
 */
export type AiAgentsItemType = 'coming-soon' | 'agent-flow-watch' | 'agent-flow-session' | 'agent-flow-empty';

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

export const AI_AGENTS_TOOLTIP = 'Watch your AI coding agents (Claude Code, Codex) work on the XR analysis table with Agent Flow. Chatting with agents from the extension is coming soon.';

const CHAT_COMING_SOON_TOOLTIP = 'Chat with AI agents about your code and its Code-XR analyses, with your own provider keys. Coming soon.';

/** "Watch an agent in XR": the Agent Flow entry point. */
export function createWatchAgentFlowItem(): AiAgentsTreeItem {
    return new AiAgentsTreeItem(
        'Watch an agent in XR',
        vscode.TreeItemCollapsibleState.None,
        'agent-flow-watch',
        { command: 'codeXR.agentFlow.watch', title: 'Watch an agent in XR' },
        new vscode.ThemeIcon('pulse'),
        'Agent Flow: pick a Claude Code or Codex session of this workspace and watch it on the XR analysis table, live while it runs.',
        'Agent Flow',
        'codeXR.aiAgents.agentFlow.watch',
    );
}

/** One recent agent session of the workspace. */
export function createAgentSessionItem(session: { id: string; label: string; agent: string; live: boolean }, age: string): AiAgentsTreeItem {
    return new AiAgentsTreeItem(
        session.label,
        vscode.TreeItemCollapsibleState.None,
        'agent-flow-session',
        { command: 'codeXR.agentFlow.watch', title: 'Watch in XR', arguments: [session.id] },
        new vscode.ThemeIcon(session.live ? 'debug-start' : 'history'),
        `${session.agent} session, ${age}${session.live ? ' (running)' : ''}. Click to watch it in XR.`,
        session.live ? `${session.agent} - live` : `${session.agent} - ${age}`,
        'codeXR.aiAgents.agentFlow.session',
    );
}

/** Shown when the workspace has no agent session yet. */
export function createNoAgentSessionsItem(): AiAgentsTreeItem {
    return new AiAgentsTreeItem(
        'No agent sessions in this workspace yet',
        vscode.TreeItemCollapsibleState.None,
        'agent-flow-empty',
        undefined,
        new vscode.ThemeIcon('info'),
        'Run Claude Code or Codex in this folder: its sessions appear here and can be watched in XR.',
        undefined,
        'codeXR.aiAgents.agentFlow.empty',
    );
}

/** Chatting with agents from the extension is still to come. */
export function createComingSoonItem(): AiAgentsTreeItem {
    return new AiAgentsTreeItem(
        'Chat with AI agents: coming soon',
        vscode.TreeItemCollapsibleState.None,
        'coming-soon',
        undefined,
        new vscode.ThemeIcon('sparkle'),
        CHAT_COMING_SOON_TOOLTIP,
        undefined,
        'codeXR.aiAgents.comingSoon',
    );
}

import * as vscode from 'vscode';
import { BaseSectionProvider } from '../../../platform/tree/baseInterfaces';
import {
    AI_AGENTS_TOOLTIP,
    AiAgentsTreeItem,
    createAgentSessionItem,
    createComingSoonItem,
    createNoAgentSessionsItem,
    createWatchAgentFlowItem,
} from './aiAgentsItems';
import { describeAge, listWorkspaceAgentSessions } from '../commands/agentFlowCommands';

/** Recent sessions listed under the entry point; the quick pick offers all of them. */
const RECENT_SESSIONS = 5;

/** The AI AGENTS section: Agent Flow (watch an agent in XR) and the coming chat. */
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
            'Agent Flow',
            'aiAgentsSection',
        );
    }

    async getChildren(element?: AiAgentsTreeItem): Promise<AiAgentsTreeItem[]> {
        if (element) {
            return [];
        }
        let sessions: ReturnType<typeof listWorkspaceAgentSessions> = [];
        try {
            sessions = listWorkspaceAgentSessions();
        } catch {
            sessions = [];
        }
        const now = Date.now();
        return [
            createWatchAgentFlowItem(),
            ...(sessions.length > 0
                ? sessions.slice(0, RECENT_SESSIONS).map((session) => createAgentSessionItem(session, describeAge(session.updatedAt, now)))
                : [createNoAgentSessionsItem()]),
            createComingSoonItem(),
        ];
    }
}

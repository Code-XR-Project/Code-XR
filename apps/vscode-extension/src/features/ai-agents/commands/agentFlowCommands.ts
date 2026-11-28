import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionCommandRegistration } from '../../../platform/commands/commandRegistry';
import { listAgentTraceSources, summarizeSource } from '../../../core/agent-flow/agentTraceSources';
import { hasAgentFlowScene, openAgentFlowInScenes, waitForAgentFlowScene } from '../../../core/agent-flow/agentFlowService';
import type { AgentTraceSourceSummary } from '../../../core/agent-flow/agentFlowModels';

/** How long "Watch in XR" waits for the project XR analysis it started. */
const SCENE_WAIT_MS = 4 * 60 * 1000;

export const AGENT_FLOW_WATCH_COMMAND = 'codeXR.agentFlow.watch';

/** The workspace folder Agent Flow looks at: the first one (the project analysis' target). */
export function agentFlowWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function listWorkspaceAgentSessions(): AgentTraceSourceSummary[] {
    const root = agentFlowWorkspaceRoot();
    return root ? listAgentTraceSources(root).map(summarizeSource) : [];
}

export function describeAge(updatedAt: number, now = Date.now()): string {
    const minutes = Math.max(0, Math.round((now - updatedAt) / 60000));
    if (minutes < 1) { return 'just now'; }
    if (minutes < 60) { return `${minutes} min ago`; }
    const hours = Math.round(minutes / 60);
    if (hours < 48) { return `${hours} h ago`; }
    return `${Math.round(hours / 24)} days ago`;
}

async function pickSession(sessions: AgentTraceSourceSummary[]): Promise<AgentTraceSourceSummary | undefined> {
    const picked = await vscode.window.showQuickPick(
        sessions.map((session) => ({
            label: session.label,
            description: `${session.agent}${session.live ? ' - live' : ''}`,
            detail: describeAge(session.updatedAt),
            session,
        })),
        { title: 'Watch an agent in XR', placeHolder: 'Pick the agent session to show on the analysis table' },
    );
    return picked?.session;
}

/**
 * "Watch agent flow in XR": pick an agent session of the workspace (Claude
 * Code or Codex, live or finished), make sure the project has an XR scene
 * (starting the project analysis when it has none), open the session there
 * and switch the scene to the Agent Flow analysis. The scene logic is the
 * shared core service; this is only the VS Code adapter.
 */
export async function watchAgentFlow(sourceId?: string): Promise<void> {
    const root = agentFlowWorkspaceRoot();
    if (!root) {
        void vscode.window.showWarningMessage('Open a folder first: Agent Flow shows the agent sessions of the workspace folder.');
        return;
    }
    const sessions = listWorkspaceAgentSessions();
    if (sessions.length === 0) {
        void vscode.window.showInformationMessage(
            `No agent sessions were found for ${path.basename(root)}. Code-XR looks for Claude Code transcripts in ~/.claude/projects and Codex sessions in ~/.codex/sessions whose working folder is this workspace.`,
        );
        return;
    }
    const session = sourceId ? sessions.find((candidate) => candidate.id === sourceId) : await pickSession(sessions);
    if (!session) {
        return;
    }
    if (!hasAgentFlowScene(root)) {
        await vscode.commands.executeCommand('codeXR.analysis.analyzeProjectXR');
        const ready = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Code-XR: waiting for the project XR scene...' },
            () => waitForAgentFlowScene(root, SCENE_WAIT_MS),
        );
        if (!ready) {
            void vscode.window.showWarningMessage('The project XR scene did not start, so the agent session could not be shown. Run "Code-XR: Analyze Project (XR)" and try again.');
            return;
        }
    }
    const reached = openAgentFlowInScenes(root, session.id);
    if (reached === 0) {
        void vscode.window.showWarningMessage('That agent session is no longer available.');
        return;
    }
    void vscode.window.showInformationMessage(`Agent Flow: showing "${session.label}" on the analysis table.`);
}

export function getAgentFlowCommandRegistrations(): ExtensionCommandRegistration[] {
    return [{
        id: AGENT_FLOW_WATCH_COMMAND,
        module: 'AI_AGENTS',
        description: 'Show an agent session (Claude Code, Codex) as the Agent Flow analysis in XR',
        handler: (sourceId?: unknown) => watchAgentFlow(typeof sourceId === 'string' ? sourceId : undefined),
        errorMessage: 'Agent Flow could not be opened',
    }];
}

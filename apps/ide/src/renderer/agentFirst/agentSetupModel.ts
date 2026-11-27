import type { AgentView, InstallDescription, InstallProgress } from '../../shared/agentSession.ts';

/**
 * Pure helpers of setting agents up: the install actions of the agents list
 * (AF2, #267) and the first-run guide (AF13, #278). No DOM.
 */

export type SetupAction = 'install' | 'update' | 'remove' | 'login' | 'check';

/** What an agent row offers: install a missing preset; update or remove one the IDE installed; sign in and check. */
export function setupActions(agent: AgentView): SetupAction[] {
    if (agent.kind !== 'acp') {
        return [];
    }
    if (agent.availability === 'missing') {
        return agent.preset ? ['install'] : [];
    }
    const actions: SetupAction[] = [];
    if (agent.availability === 'needs-login' || (agent.authMethods?.length ?? 0) > 0) {
        actions.push('login');
    }
    actions.push('check');
    if (agent.preset && agent.installedVersion) {
        actions.push('update', 'remove');
    }
    return actions;
}

/** "3.4 MB". */
export function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit] ?? 'GB'}`;
}

/** The rows of the inline description shown before the native consent dialog. */
export function describeRows(description: InstallDescription): [string, string][] {
    const rows: [string, string][] = [
        ['Package', `${description.packageName}@${description.version}`],
        ['Licence', description.license ?? 'Not stated'],
        ['Size', description.unpackedSize === null
            ? 'Unknown'
            : `${formatSize(description.unpackedSize)}${description.dependenciesSize !== null ? ` + at least ${formatSize(description.dependenciesSize)} of dependencies` : ''}`],
        ['Source', description.repository ?? description.registry],
    ];
    if (description.published) {
        rows.push(['Published', description.published.slice(0, 10)]);
    }
    if (description.nativeBinaries.length > 0) {
        rows.push(['Native binaries', description.nativeBinaries.map((binary) => `${binary.name}${binary.size !== null ? ` (${formatSize(binary.size)})` : ''}`).join('; ')]);
    }
    rows.push(['Install scripts', description.installScripts.length ? description.installScripts.join(', ') : 'None declared']);
    rows.push(['Runs', description.command]);
    return rows;
}

/** True when the installed version is already the one the registry offers. */
export function isUpToDate(description: InstallDescription): boolean {
    return description.installedVersion !== null && description.installedVersion === description.version;
}

/** The progress notification of an install or removal. */
export function progressTitle(progress: Pick<InstallProgress, 'action'>, agentName: string): string {
    return progress.action === 'install' ? `Installing ${agentName}` : `Removing ${agentName}`;
}

// ---- First run (AF13) -------------------------------------------------------

export const ONBOARDED_KEY = 'codexr.agentFirst.onboarded';

export type StepState = 'done' | 'current' | 'todo';

export interface OnboardingInput {
    readonly hasFolder: boolean;
    readonly agents: readonly AgentView[];
    /** The agent the person picked in the guide, if any. */
    readonly chosen: string | null;
    readonly hasChat: boolean;
}

export interface OnboardingStep {
    readonly id: 'folder' | 'agent' | 'chat';
    readonly title: string;
    readonly state: StepState;
    readonly text: string;
}

/** An ACP agent a chat can start with (signed in or not yet known). */
export function isUsable(agent: AgentView): boolean {
    return agent.kind === 'acp' && (agent.availability === 'ready' || agent.availability === 'available');
}

/** The agent the guide starts a chat with: the chosen one if usable, else the first ready, else the first usable. */
export function guideAgent(input: Pick<OnboardingInput, 'agents' | 'chosen'>): AgentView | null {
    const usable = input.agents.filter(isUsable);
    return usable.find((agent) => agent.ref === input.chosen) ?? usable.find((agent) => agent.availability === 'ready') ?? usable[0] ?? null;
}

/** The three steps and where the person is: each done step reflects real state, the first open one is current. */
export function onboardingSteps(input: OnboardingInput): OnboardingStep[] {
    const agent = guideAgent(input);
    const needsLogin = input.agents.some((candidate) => candidate.kind === 'acp' && candidate.availability === 'needs-login');
    const installed = input.agents.some((candidate) => candidate.kind === 'acp' && candidate.availability !== 'missing');
    const done = { folder: input.hasFolder, agent: agent !== null, chat: input.hasChat };
    const steps: Omit<OnboardingStep, 'state'>[] = [
        {
            id: 'folder',
            title: 'Open a project folder',
            text: done.folder ? 'A folder is open. Agents work inside it, and only once you trust it.' : 'Agents read and change the files of the folder you open, nothing outside it.',
        },
        {
            id: 'agent',
            title: 'Pick a coding agent',
            text: agent
                ? `${agent.name} is ${agent.availability === 'ready' ? 'ready' : 'installed'}.`
                : needsLogin
                    ? 'Sign in to an agent with its own login: your subscription or API key stays with the vendor\'s tool.'
                    : installed
                        ? 'Check an agent to see whether it is ready.'
                        : 'Install Claude Code, Codex or Gemini CLI. Nothing is downloaded until you confirm.',
        },
        {
            id: 'chat',
            title: 'Start your first chat',
            text: done.chat ? 'You have a chat. Open it from the Chats view.' : 'Ask the agent to explain, fix or build something in this project.',
        },
    ];
    let current = false;
    return steps.map((step) => {
        if (done[step.id]) {
            return { ...step, state: 'done' };
        }
        if (!current) {
            current = true;
            return { ...step, state: 'current' };
        }
        return { ...step, state: 'todo' };
    });
}

/** Whether the guide opens on its own: never once onboarded, and never for someone who already chatted. */
export function shouldShowOnboarding(onboarded: string | null, hasChat: boolean): boolean {
    return onboarded !== 'true' && !hasChat;
}

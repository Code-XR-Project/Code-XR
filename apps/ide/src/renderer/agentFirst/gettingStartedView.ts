import type { AgentView } from '../../shared/agentSession.ts';
import { el } from '../dom.ts';
import { agentActions, type AgentSetupDeps } from './agentSetup.ts';
import { availabilityLabel } from './sessionsModel.ts';
import { guideAgent, isUsable, onboardingSteps, type OnboardingStep } from './agentSetupModel.ts';

/**
 * The first-run guide (AF13, #278): from an empty window to a first chat in
 * three steps (open a folder, pick an agent and install it or sign in, start
 * the chat), each drawn from the real state of the window and redrawn when it
 * changes. Shown in the editor area on the first run, skippable, and opened
 * again with "Chat: Show Getting Started".
 */

export interface GettingStartedDeps {
    readonly setup: AgentSetupDeps;
    hasFolder(): boolean;
    hasChat(): boolean;
    agents(): readonly AgentView[];
    openFolder(): void;
    /** Starts the first chat with an agent; the guide is done. */
    startChat(agentRef: string): Promise<void>;
    /** Skip: the guide does not open on its own again. */
    skip(): void;
}

export interface GettingStartedView {
    readonly element: HTMLElement;
    /** Redraws from the current state (folder, agents, chats). */
    render(): void;
}

const MARK: Record<OnboardingStep['state'], string> = { done: 'Done', current: 'Next', todo: 'Then' };

export function createGettingStartedView(deps: GettingStartedDeps): GettingStartedView {
    let chosen: string | null = null;
    const steps = el('ol', { className: 'af-guide-steps' });
    const skip = el('button', { className: 'af-link-button af-guide-skip', text: 'Skip', attrs: { type: 'button', title: 'Close the guide; reopen it with Chat: Show Getting Started', 'data-testid': 'af-guide-skip' } });
    skip.addEventListener('click', () => deps.skip());
    const element = el('section', { className: 'af-guide', attrs: { 'data-testid': 'af-guide', 'aria-labelledby': 'af-guide-title' } }, [
        el('header', { className: 'af-guide-head' }, [
            el('div', {}, [
                el('h2', { className: 'af-guide-title', text: 'Get started', attrs: { id: 'af-guide-title' } }),
                el('p', { className: 'muted af-guide-lead', text: 'Three steps to your first chat with a coding agent on your project.' }),
            ]),
            skip,
        ]),
        steps,
    ]);

    function folderBody(step: OnboardingStep): HTMLElement[] {
        if (step.state === 'done') {
            return [];
        }
        const open = el('button', { className: 'primary-button af-small-button', text: 'Open Folder...', attrs: { type: 'button', 'data-testid': 'af-guide-open-folder' } });
        open.addEventListener('click', () => deps.openFolder());
        return [el('div', { className: 'af-guide-actions' }, [open])];
    }

    function agentBody(): HTMLElement[] {
        const agents = deps.agents().filter((agent) => agent.kind === 'acp' && agent.preset);
        if (agents.length === 0) {
            return [el('p', { className: 'muted', text: 'Looking for agents...' })];
        }
        const selected = guideAgent({ agents: deps.agents(), chosen })?.ref ?? null;
        return [el('ul', { className: 'af-guide-agents' }, agents.map((agent) => {
            const radio = el('input', { attrs: { type: 'radio', name: 'af-guide-agent', value: agent.ref, 'aria-label': `Use ${agent.name}` } });
            radio.checked = agent.ref === selected;
            radio.disabled = !isUsable(agent);
            radio.addEventListener('change', () => {
                chosen = agent.ref;
                render();
            });
            return el('li', { className: 'af-guide-agent', attrs: { 'data-availability': agent.availability, 'data-ref': agent.ref } }, [
                el('label', { className: 'af-guide-agent-main' }, [
                    radio,
                    el('span', { className: 'af-agent-name', text: agent.name }),
                    el('span', { className: 'af-badge', attrs: { 'data-availability': agent.availability }, text: availabilityLabel(agent) }),
                ]),
                ...(agent.detail && agent.availability !== 'available' && agent.availability !== 'ready' ? [el('p', { className: 'muted af-agent-detail', text: agent.detail })] : []),
                agentActions(agent, deps.setup),
            ]);
        }))];
    }

    function chatBody(step: OnboardingStep): HTMLElement[] {
        const agent = guideAgent({ agents: deps.agents(), chosen });
        const start = el('button', { className: 'primary-button af-small-button', text: agent ? `Start a chat with ${agent.name}` : 'Start a chat', attrs: { type: 'button', 'data-testid': 'af-guide-start' } });
        start.disabled = !agent || !deps.hasFolder();
        start.title = !deps.hasFolder() ? 'Open a folder first' : !agent ? 'Install or sign in to an agent first' : '';
        start.addEventListener('click', () => {
            if (agent) {
                start.disabled = true;
                deps.startChat(agent.ref).finally(() => {
                    start.disabled = false;
                });
            }
        });
        return step.state === 'done' && deps.hasChat() ? [] : [el('div', { className: 'af-guide-actions' }, [start])];
    }

    function render(): void {
        const all = onboardingSteps({ hasFolder: deps.hasFolder(), agents: deps.agents(), chosen, hasChat: deps.hasChat() });
        steps.replaceChildren(...all.map((step, index) => el('li', { className: 'af-guide-step', attrs: { 'data-state': step.state, 'data-step': step.id } }, [
            el('span', { className: 'af-guide-number', text: String(index + 1), attrs: { 'aria-hidden': 'true' } }),
            el('div', { className: 'af-guide-body' }, [
                el('h3', { className: 'af-guide-step-title' }, [
                    el('span', { text: step.title }),
                    el('span', { className: 'af-guide-state', text: MARK[step.state] }),
                ]),
                el('p', { className: 'muted af-guide-text', text: step.text }),
                ...(step.id === 'folder' ? folderBody(step) : step.id === 'agent' ? agentBody() : chatBody(step)),
            ]),
        ])));
    }

    render();
    return { element, render };
}

import type { ApprovalDecision, ApprovalRequest, ToolRunView } from '../../shared/agents.ts';
import { el } from '../dom.ts';

/**
 * The tool side of a chat answer (A7): one line per tool the agent used, and
 * the approval card a risky tool waits on. Text only, like the rest of the chat.
 */

const STATUS_LABEL: Readonly<Record<ToolRunView['status'], string>> = {
    running: 'Running',
    done: 'Done',
    error: 'Failed',
    denied: 'Denied',
};

/** What a tool line can do beyond showing itself. */
export interface ToolRunActions {
    /** A10: shows the XR scene the analysis tools read from. */
    showScene?(): void;
}

const ANALYSIS_TOOL = /^get_(metrics|hotspots|dependencies|evolution)$/;

export function renderToolRun(run: ToolRunView, actions: ToolRunActions = {}): HTMLElement {
    const head = el('summary', { className: 'chat-tool-head' }, [
        el('span', { className: `chat-tool-status is-${run.status}`, text: STATUS_LABEL[run.status], attrs: { 'aria-label': `Status: ${STATUS_LABEL[run.status]}` } }),
        el('code', { className: 'chat-tool-name', text: run.name }),
        el('span', { className: 'chat-tool-summary', text: run.summary }),
    ]);
    const details = el('details', { className: 'chat-tool', attrs: { 'data-tool-run': run.id } }, [head]);
    if (run.result) {
        details.append(el('pre', { className: 'chat-tool-result', text: run.result }));
    }
    if (actions.showScene && run.status === 'done' && ANALYSIS_TOOL.test(run.name)) {
        const show = el('button', { className: 'link-button small chat-tool-action', text: 'Open in XR', attrs: { type: 'button', title: 'Show the XR scene these numbers come from' } });
        show.addEventListener('click', (event) => {
            event.preventDefault();
            actions.showScene?.();
        });
        head.append(show);
    }
    return details;
}

/** Puts `run` in `list`, replacing the earlier state of the same call. */
export function upsertToolRun(list: HTMLElement, run: ToolRunView, actions: ToolRunActions = {}): void {
    const next = renderToolRun(run, actions);
    const existing = [...list.children].find((child) => (child as HTMLElement).dataset['toolRun'] === run.id);
    if (existing) {
        next.toggleAttribute('open', existing.hasAttribute('open'));
        existing.replaceWith(next);
    } else {
        list.append(next);
    }
}

export function renderToolRuns(runs: readonly ToolRunView[], actions: ToolRunActions = {}): HTMLElement {
    const list = el('div', { className: 'chat-tools', attrs: { 'aria-label': 'Tools used' } });
    for (const run of runs) {
        list.append(renderToolRun(run, actions));
    }
    return list;
}

/**
 * The card a risky tool waits on: what will happen, and three answers. It
 * removes itself once answered; the answer arrives back as a tool run update.
 */
export function renderApproval(request: ApprovalRequest, decide: (decision: ApprovalDecision) => Promise<void>): HTMLElement {
    const button = (label: string, decision: ApprovalDecision, className: string): HTMLButtonElement => {
        const node = el('button', { className, text: label, attrs: { type: 'button', 'data-decision': decision } });
        node.addEventListener('click', () => {
            for (const other of card.querySelectorAll('button')) {
                other.disabled = true;
            }
            decide(decision).finally(() => card.remove());
        });
        return node;
    };
    const card = el('div', { className: 'chat-approval', attrs: { role: 'group', 'aria-label': `Approve ${request.title}`, 'data-testid': 'agents-approval' } }, [
        el('p', { className: 'chat-approval-title', text: `The agent wants to ${request.title.toLowerCase()}` }),
        el('pre', { className: 'chat-approval-detail', text: request.detail }),
        el('div', { className: 'env-actions' }, [
            button('Allow once', 'once', 'primary-button'),
            button('Always for this agent', 'always', 'secondary-button'),
            button('Deny', 'deny', 'secondary-button'),
        ]),
    ]);
    return card;
}

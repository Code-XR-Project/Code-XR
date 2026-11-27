import type { AgentSessionMessage, AgentSessionsApi, AgentView, ProjectSessions, SessionSummary } from '../../shared/agentSession.ts';
import type { TerminalCreated } from '../../shared/api.ts';
import { el, icon } from '../dom.ts';
import { attentionCounts, availabilityLabel, defaultAgent, filterProjects, shortTime, statusLabel } from './sessionsModel.ts';
import { agentActions, type AgentSetupDeps } from './agentSetup.ts';
import { branchLabel, branchTitle, parseWorktreeChoice } from './worktreeModel.ts';

/**
 * The left column of the agent-first workbench (AF7, #272): the person's
 * projects and, under each, its chats with what they are doing (working,
 * waiting for an approval, done and not read, failed). Above them, the
 * Agent / Classic switch (AF4) and New chat with its agent picker; below, the
 * agents the IDE can run and whether each is installed and signed in (AF1,
 * AF2). Everything goes through `window.codexr.agentSessions`.
 */

export interface SessionsViewDeps {
    readonly api: AgentSessionsApi;
    /** Opens a chat of the window's own folder. */
    openChat(sessionId: string): void;
    /** Opens a chat of another project: the window switches folder first. */
    openChatInProject(root: string, sessionId: string): void;
    /** Opens another project (from the recent list). */
    openProject(root: string): void;
    /** The chat open in the active tab, highlighted in the list. */
    activeChat(): string | null;
    onStatus(message: string): void;
    /** AF4: the current layout mode and how to change it. */
    mode(): 'agent' | 'classic';
    setMode(mode: 'agent' | 'classic'): void;
    /** Called when the attention counts change (for the status bar). */
    onAttention?(counts: { running: number; waiting: number; unread: number }): void;
    /** #297: runs an agent's terminal sign-in in a terminal of its own. */
    runInTerminal?(label: string, start: (cols: number, rows: number) => Promise<TerminalCreated>): Promise<number | null>;
    /** Shows the Agents view, where the IDE's own agents chat (epic #189). */
    openBuiltinAgents?(): void;
    /** A chat was deleted: its tab closes. */
    onRemoved?(sessionId: string): void;
    /** Sections shown under the agents list (the project instructions of AF11). */
    readonly extraSections?: readonly HTMLElement[];
}

export interface SessionsView {
    refresh(): Promise<void>;
    handle(message: AgentSessionMessage): void;
    /** "New chat" with the default agent, or the given one. */
    newChat(agentRef?: string): Promise<void>;
    /** Redraws the highlight of the active chat. */
    setActive(sessionId: string | null): void;
    agents(): readonly AgentView[];
    /** Reloads the agents list (and starts each installed one once to check it, when `probe`). */
    refreshAgents(probe?: boolean): Promise<void>;
    /** Called whenever the agents list changes (the first-run guide follows it). */
    onAgentsChange(listener: (agents: readonly AgentView[]) => void): void;
    focusSearch(): void;
}

const LAST_AGENT_KEY = 'codexr.agentFirst.lastAgent';
/** AF12: the last state of "Separate worktree". */
const WORKTREE_CHOICE_KEY = 'codexr.agentFirst.separateWorktree';
const ICONS = {
    plus: 'M12 5v14M5 12h14',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
    refresh: 'M20 12a8 8 0 1 1-3-6.2M20 4v5h-5',
    folder: 'M3 6h7l2 2h9v11H3z',
    chevron: 'M9 6l6 6-6 6',
} as const;

export function createSessionsView(container: HTMLElement, deps: SessionsViewDeps): SessionsView {
    let projects: readonly ProjectSessions[] = [];
    let agents: readonly AgentView[] = [];
    let query = '';
    let active: string | null = null;
    const collapsed = new Set<string>();
    let refreshTimer = 0;

    const lastAgent = (): string | null => {
        try {
            return localStorage.getItem(LAST_AGENT_KEY);
        } catch {
            return null;
        }
    };
    const rememberAgent = (ref: string): void => {
        try {
            localStorage.setItem(LAST_AGENT_KEY, ref);
        } catch {
            // Storage is a convenience only.
        }
    };

    const storedWorktreeChoice = (): boolean => {
        try {
            return parseWorktreeChoice(localStorage.getItem(WORKTREE_CHOICE_KEY));
        } catch {
            return false;
        }
    };
    const rememberWorktreeChoice = (on: boolean): void => {
        try {
            localStorage.setItem(WORKTREE_CHOICE_KEY, on ? '1' : '0');
        } catch {
            // Storage is a convenience only.
        }
    };

    // ---- Mode switch (AF4) -------------------------------------------------
    const agentModeButton = el('button', { className: 'af-mode-button', text: 'Agent', attrs: { type: 'button', 'data-mode': 'agent', title: 'Agent layout: chats, work area and live analysis (Ctrl+Alt+M)' } });
    const classicModeButton = el('button', { className: 'af-mode-button', text: 'Classic', attrs: { type: 'button', 'data-mode': 'classic', title: 'Classic layout: the VS Code-like workbench (Ctrl+Alt+M)' } });
    const modeSwitch = el('div', { className: 'af-mode-switch', attrs: { role: 'group', 'aria-label': 'Layout', 'data-testid': 'af-mode-switch' } }, [agentModeButton, classicModeButton]);
    for (const button of [agentModeButton, classicModeButton]) {
        button.addEventListener('click', () => {
            deps.setMode(button.dataset['mode'] as 'agent' | 'classic');
            renderMode();
        });
    }
    function renderMode(): void {
        const mode = deps.mode();
        for (const button of [agentModeButton, classicModeButton]) {
            const on = button.dataset['mode'] === mode;
            button.classList.toggle('is-active', on);
            button.setAttribute('aria-pressed', String(on));
        }
    }

    // ---- New chat ----------------------------------------------------------
    const agentSelect = el('select', { className: 'af-select af-new-agent', attrs: { 'aria-label': 'Agent for a new chat', 'data-testid': 'af-new-agent' } });
    const newChatButton = el('button', { className: 'primary-button af-new-chat', attrs: { type: 'button', 'data-testid': 'af-new-chat' } }, [icon(ICONS.plus), el('span', { text: 'New chat' })]);
    newChatButton.addEventListener('click', () => void newChat(agentSelect.value || undefined));

    // AF12: "Separate worktree", offered only when the window's folder can have one; the choice is remembered.
    const worktreeBox = el('input', { attrs: { type: 'checkbox', 'data-testid': 'af-new-worktree' } });
    worktreeBox.checked = storedWorktreeChoice();
    worktreeBox.addEventListener('change', () => rememberWorktreeChoice(worktreeBox.checked));
    const worktreeOption = el('label', {
        className: 'af-new-worktree',
        attrs: { hidden: '', title: 'Run the new chat\'s agent in its own git worktree and branch, outside the project, so several agents can work in parallel. Merge or discard its work from the chat\'s Worktree bar.' },
    }, [worktreeBox, el('span', { text: 'Separate worktree' })]);
    /** The folder the availability was read for, so it is read again only when the folder changes. */
    let worktreeRoot: string | null | undefined;
    let worktreeAvailable = false;
    async function refreshWorktreeAvailability(root: string | null): Promise<void> {
        if (root === worktreeRoot) {
            return;
        }
        worktreeRoot = root;
        const availability = root ? await deps.api.worktreeAvailability().catch(() => ({ ok: false, message: null })) : { ok: false, message: null };
        if (worktreeRoot !== root) {
            return;
        }
        worktreeAvailable = availability.ok;
        worktreeOption.hidden = !availability.ok;
    }
    // Trust or the repository (a first commit) may change while the folder stays: read it again on focus.
    window.addEventListener('focus', () => {
        const root = worktreeRoot;
        worktreeRoot = undefined;
        void refreshWorktreeAvailability(root ?? null);
    });

    const search = el('input', { className: 'agents-input af-search', attrs: { type: 'search', placeholder: 'Search chats', 'aria-label': 'Search chats', 'data-testid': 'af-search' } });
    search.addEventListener('input', () => {
        query = search.value;
        renderProjects();
    });

    // ---- Lists -------------------------------------------------------------
    const projectList = el('div', { className: 'af-projects', attrs: { 'data-testid': 'af-projects' } });
    const agentList = el('ul', { className: 'af-agent-list', attrs: { 'data-testid': 'af-agents' } });
    const agentsRefresh = iconButton('Check the agents again', ICONS.refresh, () => void refreshAgents(true));
    const agentsSection = el('details', { className: 'af-agents', attrs: { open: '' } }, [
        el('summary', { className: 'af-section-title' }, [el('span', { text: 'Agents' }), agentsRefresh]),
        agentList,
        el('p', { className: 'muted af-agents-note', text: 'Claude Code, Codex and Gemini CLI run with their own sign-in: your subscription or API key stays with the vendor\'s tool, and Code-XR never sees its tokens.' }),
    ]);

    container.replaceChildren(el('div', { className: 'af-sessions' }, [
        modeSwitch,
        el('div', { className: 'af-new-row' }, [newChatButton, agentSelect]),
        worktreeOption,
        search,
        el('h3', { className: 'af-section-title', text: 'Projects' }),
        projectList,
        agentsSection,
        ...(deps.extraSections ?? []),
    ]));
    renderMode();

    const agentListeners: ((list: readonly AgentView[]) => void)[] = [];
    const setupDeps: AgentSetupDeps = {
        api: deps.api,
        onStatus: deps.onStatus,
        ...(deps.runInTerminal ? { runInTerminal: deps.runInTerminal } : {}),
        refresh: (probe) => refreshAgents(probe),
        replace: (view) => {
            agents = agents.map((other) => (other.ref === view.ref ? view : other));
            renderAgents();
        },
    };

    function iconButton(label: string, path: string, onClick: () => void): HTMLButtonElement {
        const button = el('button', { className: 'icon-button', attrs: { type: 'button', title: label, 'aria-label': label } }, [icon(path)]);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    function renderAgents(): void {
        const chosen = agentSelect.value || defaultAgent(agents, lastAgent())?.ref || '';
        // The IDE's own agents (epic #189) keep their chat in the Agents view for now.
        agentSelect.replaceChildren(...agents.filter((agent) => agent.kind === 'acp').map((agent) => {
            const option = el('option', { text: agent.availability === 'missing' ? `${agent.name} (not installed)` : agent.name, attrs: { value: agent.ref } });
            option.disabled = agent.availability === 'missing';
            option.selected = agent.ref === chosen;
            return option;
        }));
        newChatButton.disabled = !agents.some((agent) => agent.kind === 'acp' && agent.availability !== 'missing');
        const builtins = agents.filter((agent) => agent.kind === 'builtin');
        const builtinRow: HTMLElement[] = [];
        if (builtins.length > 0) {
            const open = el('button', { className: 'secondary-button af-small-button', text: 'Open', attrs: { type: 'button', title: 'Chat with these agents in the Agents view' } });
            open.addEventListener('click', () => deps.openBuiltinAgents?.());
            builtinRow.push(el('li', { className: 'af-agent', attrs: { 'data-availability': 'available', 'data-ref': 'builtin' } }, [
                el('div', { className: 'af-agent-main' }, [el('span', { className: 'af-agent-name', text: 'IDE agents' }), el('span', { className: 'af-badge', text: String(builtins.length) })]),
                el('p', { className: 'muted af-agent-detail', text: `${builtins.map((agent) => agent.name).join(', ')}: the IDE's own agents, with a provider and API key set up in the Agents view.` }),
                ...(deps.openBuiltinAgents ? [el('span', { className: 'af-agent-actions' }, [open])] : []),
            ]));
        }
        agentList.replaceChildren(...agents.filter((agent) => agent.kind === 'acp').map((agent) => el('li', { className: 'af-agent', attrs: { 'data-availability': agent.availability, 'data-ref': agent.ref } }, [
            el('div', { className: 'af-agent-main' }, [
                el('span', { className: 'af-agent-name', text: agent.name }),
                ...(agent.installedVersion ? [el('span', { className: 'af-agent-version muted', text: agent.installedVersion, attrs: { title: 'Installed by Code-XR IDE' } })] : []),
                el('span', { className: 'af-badge', attrs: { 'data-availability': agent.availability }, text: availabilityLabel(agent) }),
            ]),
            el('p', { className: 'muted af-agent-detail', text: agent.detail ?? agent.description }),
            agentActions(agent, setupDeps),
        ])), ...builtinRow);
        for (const listener of agentListeners) {
            listener(agents);
        }
    }

    function renderProjects(): void {
        const now = Date.now();
        const shown = filterProjects(projects, query);
        if (shown.length === 0) {
            projectList.replaceChildren(el('p', { className: 'muted side-note', text: query ? 'No chat matches.' : 'No chats yet. Open a folder and start a new chat.' }));
            return;
        }
        projectList.replaceChildren(...shown.map((project) => {
            const isCollapsed = collapsed.has(project.root) && !query;
            const head = el('button', { className: `af-project-head${project.current ? ' is-current' : ''}`, attrs: { type: 'button', 'aria-expanded': String(!isCollapsed), title: project.root } }, [
                icon(ICONS.chevron, 'af-project-chevron'),
                icon(ICONS.folder, 'af-project-icon'),
                el('span', { className: 'af-project-name', text: project.name }),
                el('span', { className: 'af-project-count muted', text: String(project.sessions.length) }),
            ]);
            head.addEventListener('click', () => {
                if (collapsed.has(project.root)) {
                    collapsed.delete(project.root);
                } else {
                    collapsed.add(project.root);
                }
                renderProjects();
            });
            const children: HTMLElement[] = [head];
            if (!project.current) {
                const open = el('button', { className: 'af-link-button af-project-open', text: 'Open project', attrs: { type: 'button' } });
                open.addEventListener('click', () => deps.openProject(project.root));
                children.push(open);
            }
            if (!isCollapsed) {
                children.push(el('ul', { className: 'af-session-list' }, project.sessions.map((session) => sessionRow(project, session, now))));
            }
            return el('section', { className: 'af-project', attrs: { 'data-root': project.root, 'data-current': String(project.current) } }, children);
        }));
    }

    function sessionRow(project: ProjectSessions, session: SessionSummary, now: number): HTMLElement {
        const row = el('li', {
            className: `af-session${session.id === active ? ' is-active' : ''}${session.unread ? ' is-unread' : ''}`,
            attrs: { tabindex: '0', role: 'button', 'data-session': session.id, 'data-status': session.status, 'data-testid': 'af-session', title: `${session.title} (${statusLabel(session)})` },
        }, [
            el('span', { className: 'af-dot', attrs: { 'data-status': session.status, 'data-unread': String(session.unread), 'aria-label': statusLabel(session) } }),
            el('span', { className: 'af-session-main' }, [
                el('span', { className: 'af-session-title', text: session.title }),
                el('span', { className: 'af-session-sub muted', text: [session.agentName, statusLabel(session), shortTime(session.updatedAt, now)].filter(Boolean).join(' · ') }),
            ]),
            ...(session.worktree ? [el('span', { className: `af-badge af-branch${session.worktree.removed ? ' is-removed' : ''}`, text: branchLabel(session.worktree), attrs: { title: branchTitle(session.worktree), 'data-testid': 'af-session-branch' } })] : []),
            ...(session.pendingChanges > 0 ? [el('span', { className: 'af-badge af-pending', text: String(session.pendingChanges), attrs: { title: `${session.pendingChanges} changed file(s) to review` } })] : []),
            el('span', { className: 'af-session-actions' }, [
                iconButton('Rename', ICONS.edit, () => rename(session)),
                iconButton('Delete', ICONS.trash, () => remove(session)),
            ]),
        ]);
        const open = (): void => {
            if (project.current) {
                deps.openChat(session.id);
            } else {
                deps.openChatInProject(project.root, session.id);
            }
        };
        row.addEventListener('click', open);
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open();
            } else if (event.key === 'F2') {
                event.preventDefault();
                rename(session);
            } else if (event.key === 'Delete') {
                event.preventDefault();
                remove(session);
            }
        });
        return row;
    }

    function rename(session: SessionSummary): void {
        const row = projectList.querySelector<HTMLElement>(`[data-session="${CSS.escape(session.id)}"] .af-session-title`);
        if (!row) {
            return;
        }
        const field = el('input', { className: 'agents-input af-rename', attrs: { value: session.title, 'aria-label': 'Chat title' } });
        row.replaceWith(field);
        field.focus();
        field.select();
        let done = false;
        const finish = (save: boolean): void => {
            if (done) {
                return;
            }
            done = true;
            const title = field.value.trim();
            if (save && title && title !== session.title) {
                deps.api.rename(session.id, title).then(() => refresh()).catch((error: unknown) => deps.onStatus(errorText(error)));
            } else {
                renderProjects();
            }
        };
        field.addEventListener('click', (event) => event.stopPropagation());
        field.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
                finish(true);
            } else if (event.key === 'Escape') {
                finish(false);
            }
        });
        field.addEventListener('blur', () => finish(true));
    }

    function remove(session: SessionSummary): void {
        // A native confirm would block the window; ask inline instead.
        const row = projectList.querySelector<HTMLElement>(`[data-session="${CSS.escape(session.id)}"]`);
        if (!row) {
            return;
        }
        const yes = el('button', { className: 'secondary-button is-danger af-small-button', text: 'Delete', attrs: { type: 'button' } });
        const no = el('button', { className: 'secondary-button af-small-button', text: 'Cancel', attrs: { type: 'button' } });
        // AF12: a chat with a live worktree asks whether its worktree and branch go too (on by default).
        const hasWorktree = !!session.worktree && !session.worktree.removed;
        const alsoWorktree = el('input', { attrs: { type: 'checkbox', 'data-testid': 'af-delete-worktree' } });
        alsoWorktree.checked = true;
        const confirm = el('li', { className: `af-confirm${hasWorktree ? ' has-worktree' : ''}` }, [
            el('span', { text: `Delete "${session.title}"?` }),
            ...(hasWorktree && session.worktree ? [el('label', { className: 'af-confirm-worktree', attrs: { title: `Remove the worktree folder and delete the branch ${session.worktree.branch}. Unchecked, both are kept.` } }, [alsoWorktree, el('span', { text: `Also remove its worktree and branch ${branchLabel(session.worktree)}` })])] : []),
            yes,
            no,
        ]);
        row.replaceWith(confirm);
        yes.focus();
        yes.addEventListener('click', () => {
            deps.api.remove(session.id, { removeWorktree: hasWorktree && alsoWorktree.checked }).then(() => {
                deps.onRemoved?.(session.id);
                return refresh();
            }).catch((error: unknown) => deps.onStatus(errorText(error)));
        });
        no.addEventListener('click', () => renderProjects());
    }

    async function refreshAgents(probe = false): Promise<void> {
        agents = await deps.api.listAgents();
        renderAgents();
        if (probe) {
            for (const agent of agents.filter((candidate) => candidate.kind === 'acp' && candidate.availability !== 'missing')) {
                deps.api.probeAgent(agent.ref).then((view) => {
                    agents = agents.map((other) => (other.ref === view.ref ? view : other));
                    renderAgents();
                }).catch(() => undefined);
            }
        }
    }

    async function refresh(): Promise<void> {
        projects = await deps.api.listProjects();
        renderProjects();
        void refreshWorktreeAvailability(projects.find((project) => project.current)?.root ?? null);
        deps.onAttention?.(attentionCounts(projects));
    }

    function refreshSoon(): void {
        if (refreshTimer) {
            return;
        }
        refreshTimer = window.setTimeout(() => {
            refreshTimer = 0;
            refresh().catch(() => undefined);
        }, 250);
    }

    async function newChat(agentRef?: string): Promise<void> {
        const ref = agentRef ?? defaultAgent(agents, lastAgent())?.ref;
        if (!ref) {
            deps.onStatus('No agent is installed yet. See the Agents section of the chats column.');
            return;
        }
        rememberAgent(ref);
        try {
            const session = await deps.api.create(ref, { worktree: worktreeAvailable && worktreeBox.checked });
            await refresh();
            deps.openChat(session.id);
        } catch (error) {
            deps.onStatus(errorText(error));
        }
    }

    refreshAgents().catch((error: unknown) => deps.onStatus(`Agents unavailable: ${errorText(error)}`));
    refresh().catch((error: unknown) => deps.onStatus(`Chats unavailable: ${errorText(error)}`));

    return {
        refresh,
        handle(message: AgentSessionMessage): void {
            if (message.kind === 'agents-changed') {
                refreshAgents().catch(() => undefined);
                return;
            }
            if (message.kind === 'sessions-changed') {
                refreshSoon();
                return;
            }
            if (message.kind === 'install-progress') {
                return;
            }
            const type = message.event.type;
            if (type === 'status' || type === 'turn-end' || type === 'title' || type === 'permission' || type === 'permission-resolved' || type === 'pending-changes' || type === 'user' || type === 'read') {
                refreshSoon();
            }
        },
        newChat,
        setActive(sessionId: string | null): void {
            active = sessionId;
            for (const row of projectList.querySelectorAll<HTMLElement>('.af-session')) {
                row.classList.toggle('is-active', row.dataset['session'] === sessionId);
            }
            renderMode();
        },
        agents: () => agents,
        refreshAgents,
        onAgentsChange(listener): void {
            agentListeners.push(listener);
        },
        focusSearch(): void {
            search.focus();
        },
    };
}

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

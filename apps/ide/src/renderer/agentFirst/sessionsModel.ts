import type { AgentView, ProjectSessions, SessionStatus, SessionSummary } from '../../shared/agentSession.ts';

/**
 * Pure helpers of the sessions sidebar (AF7, #272): filtering chats by a
 * search, the label and order of statuses, short relative times. No DOM.
 */

/** The projects whose name or chats match the query; a matching project keeps all its chats. */
export function filterProjects(projects: readonly ProjectSessions[], query: string): ProjectSessions[] {
    const needle = query.trim().toLowerCase();
    if (!needle) {
        return [...projects];
    }
    const result: ProjectSessions[] = [];
    for (const project of projects) {
        if (project.name.toLowerCase().includes(needle)) {
            result.push(project);
            continue;
        }
        const sessions = project.sessions.filter((session) => session.title.toLowerCase().includes(needle) || session.agentName.toLowerCase().includes(needle));
        if (sessions.length > 0) {
            result.push({ ...project, sessions });
        }
    }
    return result;
}

/** What the status dot means, for its tooltip and screen readers. */
export function statusLabel(session: Pick<SessionSummary, 'status' | 'unread'>): string {
    const base: Record<SessionStatus, string> = {
        idle: 'Done',
        running: 'Working',
        awaiting: 'Needs your approval',
        error: 'Failed',
    };
    return session.unread && session.status === 'idle' ? 'Done, not read yet' : base[session.status];
}

/** "now", "5 min", "3 h", "2 d", or a date for older chats. */
export function shortTime(iso: string, nowMs: number): string {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) {
        return '';
    }
    const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
    if (seconds < 60) {
        return 'now';
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)} min`;
    }
    if (seconds < 86_400) {
        return `${Math.floor(seconds / 3600)} h`;
    }
    if (seconds < 7 * 86_400) {
        return `${Math.floor(seconds / 86_400)} d`;
    }
    return new Date(then).toISOString().slice(0, 10);
}

/** How many chats across all projects are working, and how many wait for the person. */
export function attentionCounts(projects: readonly ProjectSessions[]): { readonly running: number; readonly waiting: number; readonly unread: number } {
    let running = 0;
    let waiting = 0;
    let unread = 0;
    for (const project of projects) {
        for (const session of project.sessions) {
            if (session.status === 'running') {
                running += 1;
            } else if (session.status === 'awaiting') {
                waiting += 1;
            }
            if (session.unread) {
                unread += 1;
            }
        }
    }
    return { running, waiting, unread };
}

/** The agent a new chat uses by default: the last one used if still usable, else the first usable one. */
export function defaultAgent(agents: readonly AgentView[], lastUsed: string | null): AgentView | null {
    const usable = agents.filter((agent) => agent.kind === 'acp' && agent.availability !== 'missing');
    return usable.find((agent) => agent.ref === lastUsed) ?? usable.find((agent) => agent.kind === 'acp') ?? usable[0] ?? null;
}

/** A short description of an agent's state for the agents list. */
export function availabilityLabel(agent: AgentView): string {
    switch (agent.availability) {
        case 'missing':
            return 'Not installed';
        case 'available':
            return 'Installed';
        case 'ready':
            return 'Ready';
        case 'needs-login':
            return 'Needs login';
        case 'error':
            return 'Error';
    }
}

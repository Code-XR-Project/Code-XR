import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { summarize, type AgentSessionState, type ProjectSessions, type SessionSummary, type SessionWorktree } from '../../shared/agentSession.ts';

/**
 * AF1/AF7: the chats, on disk. One JSON file per chat under
 * `<dir>/<project key>/<id>.json`, where the project key is the first 24 hex
 * characters of the SHA-256 of the project folder (folder names can hold any
 * character and any length), plus `projects.json`, the index of projects
 * with their name and last use. Every write goes through a temporary file and
 * a rename, so a crash never leaves a chat half written. Writes of one chat
 * are debounced while the agent streams; `flush` writes at once.
 *
 * A chat read back from disk was not running any more: whatever state it was
 * saved in, it comes back idle (or in error), with no permission waiting.
 */

export const MAX_PROJECTS = 15;
const DEFAULT_DEBOUNCE_MS = 400;
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

interface ProjectEntry {
    readonly root: string;
    readonly name: string;
    readonly lastUsed: string;
}

export function projectKey(root: string): string {
    return createHash('sha256').update(root).digest('hex').slice(0, 24);
}

export function isSessionId(value: unknown): value is string {
    return typeof value === 'string' && SESSION_ID.test(value);
}

async function writeAtomic(file: string, text: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.promises.writeFile(temporary, text, 'utf8');
    await fs.promises.rename(temporary, file);
}

/** A stored chat as it should look once loaded: nothing can still be running. */
export function settled(state: AgentSessionState): AgentSessionState {
    if (state.status !== 'running' && state.status !== 'awaiting' && !state.items.some((item) => item.kind === 'permission' && item.outcome === undefined)) {
        return state;
    }
    return {
        ...state,
        status: state.status === 'error' ? 'error' : 'idle',
        items: state.items.map((item) => (item.kind === 'permission' && item.outcome === undefined ? { ...item, outcome: 'cancelled' } : item)),
    };
}

function isState(value: unknown): value is AgentSessionState {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const state = value as Partial<AgentSessionState>;
    return isSessionId(state.id) && typeof state.title === 'string' && typeof state.agentRef === 'string' && Array.isArray(state.items) && typeof state.updatedAt === 'string';
}

/** AF12: a stored worktree record, or undefined when it is missing or malformed. */
function worktreeOf(value: unknown): SessionWorktree | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const record = value as Partial<Record<keyof SessionWorktree, unknown>>;
    const { branch, path: top, cwd, baseCommit, repoRoot } = record;
    if (typeof branch !== 'string' || typeof top !== 'string' || typeof cwd !== 'string' || typeof baseCommit !== 'string' || typeof repoRoot !== 'string') {
        return undefined;
    }
    return { branch, path: top, cwd, baseCommit, repoRoot, ...(record.removed === true ? { removed: true } : {}) };
}

/** Fills fields an older file may lack, so the reducer never meets `undefined`. */
function normalize(state: AgentSessionState): AgentSessionState {
    const { worktree: storedWorktree, historyPending: _history, ...rest } = state;
    const worktree = worktreeOf(storedWorktree);
    return settled({
        ...rest,
        ...(worktree ? { worktree } : {}),
        agentName: typeof state.agentName === 'string' ? state.agentName : state.agentRef,
        workspaceRoot: typeof state.workspaceRoot === 'string' ? state.workspaceRoot : null,
        createdAt: typeof state.createdAt === 'string' ? state.createdAt : state.updatedAt,
        unread: state.unread === true,
        pendingChanges: typeof state.pendingChanges === 'number' ? state.pendingChanges : 0,
        plan: Array.isArray(state.plan) ? state.plan : [],
        commands: Array.isArray(state.commands) ? state.commands : [],
        modes: state.modes ?? null,
        configOptions: Array.isArray(state.configOptions) ? state.configOptions : [],
        usage: state.usage ?? null,
        agentSessionId: typeof state.agentSessionId === 'string' ? state.agentSessionId : null,
        ...(state.historyPending === true ? { historyPending: true } : {}),
    });
}

export class SessionStore {
    private readonly dir: string;
    private readonly debounceMs: number;
    private readonly pending = new Map<string, { state: AgentSessionState; timer: ReturnType<typeof setTimeout> }>();
    private writing: Promise<void> = Promise.resolve();
    private projectsCache: ProjectEntry[] | null = null;

    constructor(dir: string, options: { readonly debounceMs?: number } = {}) {
        this.dir = dir;
        this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    }

    private fileOf(root: string, id: string): string {
        return path.join(this.dir, projectKey(root), `${id}.json`);
    }

    /** Saves a chat, at most once per debounce period while it keeps changing. */
    save(state: AgentSessionState): void {
        if (!state.workspaceRoot || !isSessionId(state.id)) {
            return;
        }
        const existing = this.pending.get(state.id);
        if (existing) {
            existing.state = state;
            return;
        }
        const timer = setTimeout(() => void this.flush(state.id), this.debounceMs);
        timer.unref?.();
        this.pending.set(state.id, { state, timer });
    }

    /** Writes a chat now (and any debounced write of it). */
    async saveNow(state: AgentSessionState): Promise<void> {
        const existing = this.pending.get(state.id);
        if (existing) {
            clearTimeout(existing.timer);
            this.pending.delete(state.id);
        }
        await this.write(state);
    }

    /** Writes a chat's debounced change now; every chat when `id` is omitted. */
    async flush(id?: string): Promise<void> {
        const ids = id === undefined ? [...this.pending.keys()] : [id];
        const writes: Promise<void>[] = [];
        for (const key of ids) {
            const entry = this.pending.get(key);
            if (!entry) {
                continue;
            }
            clearTimeout(entry.timer);
            this.pending.delete(key);
            writes.push(this.write(entry.state));
        }
        await Promise.all(writes);
        await this.writing;
    }

    private write(state: AgentSessionState): Promise<void> {
        const root = state.workspaceRoot;
        if (!root) {
            return Promise.resolve();
        }
        const text = `${JSON.stringify(state)}\n`;
        this.writing = this.writing.catch(() => undefined).then(async () => {
            await writeAtomic(this.fileOf(root, state.id), text);
            await this.touchProject(root, state.updatedAt);
        });
        return this.writing;
    }

    async load(root: string, id: string): Promise<AgentSessionState | null> {
        if (!isSessionId(id)) {
            return null;
        }
        const pending = this.pending.get(id);
        if (pending && pending.state.workspaceRoot === root) {
            return pending.state;
        }
        try {
            const parsed: unknown = JSON.parse(await fs.promises.readFile(this.fileOf(root, id), 'utf8'));
            return isState(parsed) ? normalize({ ...parsed, workspaceRoot: root }) : null;
        } catch {
            return null;
        }
    }

    /** Finds a chat in any known project, `preferredRoot` first. */
    async find(id: string, preferredRoot: string | null): Promise<AgentSessionState | null> {
        const roots = (await this.projects()).map((project) => project.root);
        const ordered = preferredRoot ? [preferredRoot, ...roots.filter((root) => root !== preferredRoot)] : roots;
        for (const root of ordered) {
            const state = await this.load(root, id);
            if (state) {
                return state;
            }
        }
        return null;
    }

    async remove(root: string, id: string): Promise<void> {
        const pending = this.pending.get(id);
        if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
        }
        await this.writing.catch(() => undefined);
        await fs.promises.rm(this.fileOf(root, id), { force: true });
    }

    /** The chats of one project, newest first. */
    async list(root: string): Promise<SessionSummary[]> {
        let names: string[];
        try {
            names = await fs.promises.readdir(path.join(this.dir, projectKey(root)));
        } catch {
            names = [];
        }
        const ids = new Set(names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).filter(isSessionId));
        for (const entry of this.pending.values()) {
            if (entry.state.workspaceRoot === root) {
                ids.add(entry.state.id);
            }
        }
        const states = await Promise.all([...ids].map((id) => this.load(root, id)));
        return states
            .filter((state): state is AgentSessionState => state !== null)
            .map(summarize)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    /** Recent projects and their chats: `currentRoot` first, then the others by last use, at most `MAX_PROJECTS`. */
    async listProjects(currentRoot: string | null, overrides?: (summary: SessionSummary) => SessionSummary): Promise<ProjectSessions[]> {
        await this.writing.catch(() => undefined);
        const known = await this.projects();
        const others = known.filter((project) => project.root !== currentRoot).sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
        const roots: { root: string; name: string; current: boolean }[] = [];
        if (currentRoot) {
            roots.push({ root: currentRoot, name: path.basename(currentRoot) || currentRoot, current: true });
        }
        for (const project of others) {
            roots.push({ root: project.root, name: project.name, current: false });
        }
        const result: ProjectSessions[] = [];
        for (const project of roots.slice(0, MAX_PROJECTS)) {
            const sessions = await this.list(project.root);
            if (!project.current && sessions.length === 0) {
                continue;
            }
            result.push({ ...project, sessions: overrides ? sessions.map(overrides) : sessions });
        }
        return result;
    }

    private async projects(): Promise<ProjectEntry[]> {
        if (this.projectsCache) {
            return this.projectsCache;
        }
        try {
            const parsed: unknown = JSON.parse(await fs.promises.readFile(path.join(this.dir, 'projects.json'), 'utf8'));
            this.projectsCache = Array.isArray(parsed)
                ? parsed.filter((entry): entry is ProjectEntry => !!entry && typeof entry === 'object' && typeof (entry as ProjectEntry).root === 'string' && typeof (entry as ProjectEntry).name === 'string' && typeof (entry as ProjectEntry).lastUsed === 'string')
                : [];
        } catch {
            this.projectsCache = [];
        }
        return this.projectsCache;
    }

    private async touchProject(root: string, at: string): Promise<void> {
        const projects = await this.projects();
        const existing = projects.find((project) => project.root === root);
        if (existing && existing.lastUsed >= at) {
            return;
        }
        const next = [{ root, name: path.basename(root) || root, lastUsed: at }, ...projects.filter((project) => project.root !== root)]
            .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
            .slice(0, 100);
        this.projectsCache = next;
        await writeAtomic(path.join(this.dir, 'projects.json'), `${JSON.stringify(next, null, 2)}\n`);
    }
}

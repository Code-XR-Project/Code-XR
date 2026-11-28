/**
 * Agent Flow (#319, AG7): every IDE chat is a live trace source of the XR
 * scene's fifth analysis. The rules (what an ACP tool kind means on the table,
 * how a dataset is built) live in the shared core; this file only turns the
 * chat's session events into trace events and registers one source per chat
 * for the project the chat belongs to, so the scene's picker lists it and
 * "Watch in XR" can open it.
 *
 * A chat that works in a worktree (AF12) reports paths under the worktree; they
 * are rewritten onto the project folder, where the analysis has its buildings.
 */
import path from 'node:path';
import { AcpSessionEventMapper, type AcpSessionEventLike } from '@codexr/core/agent-flow/acpSessionEvents';
import type { AgentTraceEvent } from '@codexr/core/agent-flow/agentFlowModels';
import { PushAgentTraceSource, registerLiveAgentTraceSource } from '@codexr/core/agent-flow/agentTraceSources';
import { openAgentFlowInScenes } from '@codexr/core/agent-flow/agentFlowService';
import type { AgentSessionState, SessionEvent, TranscriptItem } from '../../shared/agentSession.ts';

/** What the session service tells the feed about the chat an event belongs to. */
export interface AgentFlowChatInfo {
    readonly state: AgentSessionState;
    /** The project folder of the chat. */
    readonly root: string;
    /** Where the agent works: the project, or the chat's worktree. */
    readonly workRoot: string;
}

/** The trace source id of a chat, as the scene's picker and `watch` know it. */
export function agentFlowSourceId(sessionId: string): string {
    return `ide-chat:${sessionId}`;
}

interface ChatFeed {
    readonly source: PushAgentTraceSource;
    readonly mapper: AcpSessionEventMapper;
    readonly unregister: () => void;
    root: string;
}

/** Events that carry nothing Agent Flow draws: they never reach the mapper. */
const IGNORED = new Set<SessionEvent['type']>([
    'assistant-chunk', 'thought-chunk', 'permission', 'permission-resolved', 'plan', 'commands', 'modes', 'config',
    'usage', 'notice', 'agent-session', 'history', 'pending-changes', 'worktree', 'read',
]);

function parseTime(value: string | undefined, fallback: number): number {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
}

/** Moves a path the agent reported under its worktree onto the project folder. */
export function rebasePath(candidate: string, workRoot: string, root: string): string {
    if (workRoot === root || !path.isAbsolute(candidate)) {
        return candidate;
    }
    const relative = path.relative(workRoot, candidate);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        return candidate;
    }
    return path.join(root, relative);
}

function rebaseEvents(events: AgentTraceEvent[], workRoot: string, root: string): AgentTraceEvent[] {
    if (workRoot === root) {
        return events;
    }
    const move = (value: string) => rebasePath(value, workRoot, root);
    return events.map((event) => {
        if (event.type === 'step') {
            return {
                ...event,
                ...(event.locations ? { locations: event.locations.map((loc) => ({ ...loc, path: move(loc.path) })) } : {}),
                ...(event.created ? { created: event.created.map(move) } : {}),
                ...(event.deleted ? { deleted: event.deleted.map(move) } : {}),
            };
        }
        if (event.type === 'metric-delta') {
            return { ...event, files: event.files.map((file) => ({ ...file, path: move(file.path) })) };
        }
        return event;
    });
}

/** The stored transcript as the session events that built it, for a chat seen for the first time. */
export function transcriptAsEvents(items: readonly TranscriptItem[]): { readonly event: AcpSessionEventLike; readonly at?: string }[] {
    const out: { event: AcpSessionEventLike; at?: string }[] = [];
    for (const item of items) {
        if (item.kind === 'user') {
            out.push({ event: { type: 'user', text: item.text }, at: item.at });
        } else if (item.kind === 'tool') {
            out.push({
                event: {
                    type: 'tool', id: item.id, title: item.title, toolKind: item.toolKind, status: item.status,
                    locations: item.locations, content: item.content, ...(item.rawInput !== undefined ? { rawInput: item.rawInput } : {}),
                },
            });
        } else if (item.kind === 'turn-end') {
            if (item.metricDelta) {
                out.push({ event: { type: 'metric-delta', delta: item.metricDelta }, at: item.at });
            }
            out.push({ event: { type: 'turn-end', stopReason: item.stopReason }, at: item.at });
        }
    }
    return out;
}

/**
 * One trace source per chat, created the first time the chat emits an event
 * (seeded from what the chat already holds), and dropped with `forget` or
 * `dispose`.
 */
export class AgentFlowFeed {
    private readonly chats = new Map<string, ChatFeed>();

    private readonly now: () => number;

    constructor(now: () => number = Date.now) {
        this.now = now;
    }

    /** Called by the session service for every event of every chat. */
    onEvent(info: AgentFlowChatInfo, event: SessionEvent): void {
        if (IGNORED.has(event.type)) {
            return;
        }
        const known = this.chats.get(info.state.id)?.root === info.root;
        const chat = this.chatFor(info);
        if (!known) {
            // A chat seen for the first time is seeded from its transcript, which
            // already holds this event: mapping it again would draw it twice.
            return;
        }
        if (event.type === 'title') {
            chat.source.setLabel(event.title);
            return;
        }
        if (event.type === 'status') {
            chat.source.setLive(event.status !== 'error');
            return;
        }
        const at = event.type === 'user' || event.type === 'turn-end' ? parseTime(event.at, this.now()) : this.now();
        chat.source.push(rebaseEvents(chat.mapper.map(event, at), info.workRoot, info.root));
    }

    /** Opens the chat on the table of every XR scene of its project; how many scenes it reached. */
    watch(info: AgentFlowChatInfo): number {
        this.chatFor(info);
        return openAgentFlowInScenes(info.root, agentFlowSourceId(info.state.id));
    }

    /** The chat was deleted: its source leaves the scene's picker. */
    forget(sessionId: string): void {
        const chat = this.chats.get(sessionId);
        if (chat) {
            chat.unregister();
            this.chats.delete(sessionId);
        }
    }

    dispose(): void {
        for (const id of [...this.chats.keys()]) {
            this.forget(id);
        }
    }

    private chatFor(info: AgentFlowChatInfo): ChatFeed {
        const existing = this.chats.get(info.state.id);
        if (existing && existing.root === info.root) {
            return existing;
        }
        if (existing) {
            this.forget(info.state.id);
        }
        const source = new PushAgentTraceSource(agentFlowSourceId(info.state.id), 'ide-acp', info.state.agentName, info.state.title);
        const mapper = new AcpSessionEventMapper();
        const seed: AgentTraceEvent[] = [];
        let clock = parseTime(info.state.createdAt, this.now());
        for (const entry of transcriptAsEvents(info.state.items)) {
            clock = parseTime(entry.at, clock);
            seed.push(...mapper.map(entry.event, clock));
        }
        source.push(rebaseEvents(seed, info.workRoot, info.root));
        source.setLive(info.state.status !== 'error');
        const chat: ChatFeed = { source, mapper, unregister: registerLiveAgentTraceSource(info.root, source), root: info.root };
        this.chats.set(info.state.id, chat);
        return chat;
    }
}

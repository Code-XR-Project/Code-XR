import type { AgentChatEvent, ChatMessageView, ChatSession } from '../../shared/agents.ts';
import type { AgentProfiles } from './agentProfiles.ts';
import { sessionToMarkdown, summaryOf, titleFrom, type ChatSessions, type StoredSession } from './chatSessions.ts';
import type { ProviderRegistry } from './providerRegistry.ts';
import { ProviderError, type ChatMessage } from './providers/types.ts';

/**
 * Roughly 100k tokens of history (4 characters a token): what the smallest
 * mainstream context windows hold with room for the answer. Older messages
 * beyond it are left out of the request (never deleted) and the answer says so.
 */
export const HISTORY_BUDGET_CHARS = 400_000;
const MAX_MESSAGE_CHARS = 100_000;

/** Picks the most recent messages that fit the budget; always keeps the last one. */
export function fitHistory(messages: readonly ChatMessageView[], budget = HISTORY_BUDGET_CHARS): { readonly kept: readonly ChatMessageView[]; readonly trimmed: number } {
    let used = 0;
    let start = messages.length;
    while (start > 0) {
        const size = (messages[start - 1]?.content.length ?? 0) + 20;
        if (start < messages.length && used + size > budget) {
            break;
        }
        used += size;
        start -= 1;
    }
    // A provider rejects a history that opens with an assistant turn.
    while (start < messages.length - 1 && messages[start]?.role !== 'user') {
        start += 1;
    }
    return { kept: messages.slice(start), trimmed: start };
}

/**
 * Chats with agents (A3-A5): sends the history to the agent's provider,
 * streams the answer to the window and stores both turns. One answer at a
 * time per chat; Stop aborts the HTTP request and keeps what arrived.
 */
export class AgentChat {
    private readonly providers: ProviderRegistry;
    private readonly profiles: AgentProfiles;
    private readonly sessions: ChatSessions;
    private readonly running = new Map<string, AbortController>();

    constructor(providers: ProviderRegistry, profiles: AgentProfiles, sessions: ChatSessions) {
        this.providers = providers;
        this.profiles = profiles;
        this.sessions = sessions;
    }

    async get(workspaceRoot: string | null, id: unknown): Promise<ChatSession> {
        const session = await this.sessions.get(workspaceRoot, asId(id));
        return this.view(session);
    }

    async create(workspaceRoot: string | null, agentId: unknown): Promise<ChatSession> {
        if (typeof agentId !== 'string' || !(await this.profiles.get(agentId))) {
            throw new Error('Unknown agent.');
        }
        return this.view(await this.sessions.create(workspaceRoot, agentId));
    }

    async delete(workspaceRoot: string | null, id: unknown): Promise<void> {
        const sessionId = asId(id);
        this.running.get(sessionId)?.abort();
        await this.sessions.delete(workspaceRoot, sessionId);
    }

    async export(workspaceRoot: string | null, id: unknown): Promise<string> {
        const session = await this.sessions.get(workspaceRoot, asId(id));
        const agent = await this.profiles.get(session.agentId);
        return sessionToMarkdown(session, agent?.name ?? 'Agent');
    }

    stop(id: unknown): void {
        if (typeof id === 'string') {
            this.running.get(id)?.abort();
        }
    }

    /** Stops every answer: the window closed or the IDE quits. */
    stopAll(): void {
        for (const controller of this.running.values()) {
            controller.abort();
        }
    }

    async send(workspaceRoot: string | null, id: unknown, text: unknown, emit: (event: AgentChatEvent) => void): Promise<void> {
        const sessionId = asId(id);
        if (typeof text !== 'string' || !text.trim()) {
            throw new Error('Type a message first.');
        }
        if (text.length > MAX_MESSAGE_CHARS) {
            throw new Error(`The message is too long (${text.length} characters; at most ${MAX_MESSAGE_CHARS}).`);
        }
        if (this.running.has(sessionId)) {
            throw new Error('This chat is still answering. Stop it first.');
        }
        const controller = new AbortController();
        this.running.set(sessionId, controller);
        try {
            let session = await this.sessions.get(workspaceRoot, sessionId);
            const userMessage: ChatMessageView = { role: 'user', content: text, at: new Date().toISOString() };
            session = {
                ...session,
                title: session.messages.length === 0 ? titleFrom(text) : session.title,
                messages: [...session.messages, userMessage],
                updatedAt: userMessage.at,
            };
            await this.sessions.write(workspaceRoot, session);

            const answer = await this.answer(session, controller.signal, emit);
            session = { ...session, messages: [...session.messages, answer], updatedAt: answer.at };
            await this.sessions.write(workspaceRoot, session);
            emit({ sessionId, type: 'end', message: answer });
        } finally {
            this.running.delete(sessionId);
        }
    }

    /** Streams one answer. Failures become an assistant turn with `error`, so the chat records them. */
    private async answer(session: StoredSession, signal: AbortSignal, emit: (event: AgentChatEvent) => void): Promise<ChatMessageView> {
        let content = '';
        let model = '';
        const failed = (error: string): ChatMessageView => ({ role: 'assistant', content, at: new Date().toISOString(), error, ...(model ? { model } : {}) });
        const agent = await this.profiles.get(session.agentId);
        if (!agent) {
            return failed('The agent of this chat was deleted. Start a new chat.');
        }
        if (!agent.providerId || !this.providers.list().some((provider) => provider.id === agent.providerId)) {
            return failed(`${agent.name} has no provider. Edit the agent and pick one.`);
        }
        if (!agent.model) {
            return failed(`${agent.name} has no model. Edit the agent and pick one.`);
        }
        model = agent.model;
        const { kept, trimmed } = fitHistory(session.messages);
        emit({ sessionId: session.id, type: 'start', model, trimmed });
        const messages: ChatMessage[] = kept.map((message) => ({ role: message.role, content: message.content || '(no answer)' }));
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        try {
            const adapter = this.providers.adapterFor(agent.providerId);
            const request = {
                model,
                messages,
                ...(agent.instructions ? { system: agent.instructions } : {}),
                ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
            };
            for await (const event of adapter.stream(request, signal)) {
                if (event.type === 'text') {
                    content += event.text;
                    emit({ sessionId: session.id, type: 'delta', text: event.text });
                } else if (event.type === 'usage') {
                    usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
                }
            }
        } catch (error) {
            if (signal.aborted || (error instanceof ProviderError && error.kind === 'aborted')) {
                return { role: 'assistant', content, at: new Date().toISOString(), stopped: true, model, ...(usage ? { usage } : {}) };
            }
            return failed(error instanceof Error ? error.message : String(error));
        }
        return { role: 'assistant', content, at: new Date().toISOString(), model, ...(usage ? { usage } : {}) };
    }

    private view(session: StoredSession): ChatSession {
        return { ...summaryOf(session), messages: session.messages, running: this.running.has(session.id) };
    }
}

function asId(id: unknown): string {
    if (typeof id !== 'string') {
        throw new Error('Unknown chat.');
    }
    return id;
}

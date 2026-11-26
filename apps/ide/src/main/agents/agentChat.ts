import { randomUUID } from 'node:crypto';
import type { AgentChatEvent, AgentProfile, ApprovalDecision, ChatAttachment, ChatMessageView, ChatSession, ToolRunView } from '../../shared/agents.ts';
import type { AgentProfiles } from './agentProfiles.ts';
import { buildAttachmentContext } from './attachments.ts';
import { sessionToMarkdown, summaryOf, titleFrom, type ChatSessions, type StoredSession } from './chatSessions.ts';
import type { ProviderRegistry } from './providerRegistry.ts';
import { parseArguments } from './providers/anthropic.ts';
import { ProviderError, type ChatMessage, type ToolCall } from './providers/types.ts';
import type { ToolCatalog } from './tools/toolCatalog.ts';
import { clip, type AgentTool, type ToolWorkspace } from './tools/toolTypes.ts';

/**
 * Roughly 100k tokens of history (4 characters a token): what the smallest
 * mainstream context windows hold with room for the answer. Older messages
 * beyond it are left out of the request (never deleted) and the answer says so.
 */
export const HISTORY_BUDGET_CHARS = 400_000;
const MAX_MESSAGE_CHARS = 100_000;
/** Model calls per answer when it keeps asking for tools (A7). */
export const MAX_TOOL_STEPS = 12;
const RESULT_PREVIEW_CHARS = 2_000;

/** Picks the most recent messages that fit the budget; always keeps the last one. */
export function fitHistory(messages: readonly ChatMessageView[], budget = HISTORY_BUDGET_CHARS): { readonly kept: readonly ChatMessageView[]; readonly trimmed: number } {
    let used = 0;
    let start = messages.length;
    while (start > 0) {
        const message = messages[start - 1];
        const size = (message?.content.length ?? 0) + (message?.context?.length ?? 0) + 20;
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

/** What a chat needs from the window it runs in. */
export interface ChatWindow {
    readonly workspace: ToolWorkspace | null;
    emit(event: AgentChatEvent): void;
}

interface PendingApproval {
    readonly sessionId: string;
    resolve(decision: ApprovalDecision): void;
}

/**
 * Chats with agents (A3-A7): sends the history to the agent's provider,
 * streams the answer to the window, runs the tools the model asks for (asking
 * the person first for anything but reading) and stores both turns. One answer
 * at a time per chat; Stop aborts the HTTP request, denies a pending approval
 * and keeps what arrived.
 */
export class AgentChat {
    private readonly providers: ProviderRegistry;
    private readonly profiles: AgentProfiles;
    private readonly sessions: ChatSessions;
    private readonly tools: ToolCatalog;
    private readonly running = new Map<string, AbortController>();
    private readonly approvals = new Map<string, PendingApproval>();

    constructor(providers: ProviderRegistry, profiles: AgentProfiles, sessions: ChatSessions, tools: ToolCatalog) {
        this.providers = providers;
        this.profiles = profiles;
        this.sessions = sessions;
        this.tools = tools;
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
        this.stop(sessionId);
        await this.sessions.delete(workspaceRoot, sessionId);
    }

    async export(workspaceRoot: string | null, id: unknown): Promise<string> {
        const session = await this.sessions.get(workspaceRoot, asId(id));
        const agent = await this.profiles.get(session.agentId);
        return sessionToMarkdown(session, agent?.name ?? 'Agent');
    }

    stop(id: unknown): void {
        if (typeof id !== 'string') {
            return;
        }
        this.running.get(id)?.abort();
        for (const [requestId, pending] of this.approvals) {
            if (pending.sessionId === id) {
                this.approvals.delete(requestId);
                pending.resolve('deny');
            }
        }
    }

    /** Answers an approval card; an unknown or stale id is ignored. */
    approve(requestId: unknown, decision: unknown): void {
        if (typeof requestId !== 'string' || (decision !== 'once' && decision !== 'always' && decision !== 'deny')) {
            throw new Error('Invalid approval.');
        }
        const pending = this.approvals.get(requestId);
        if (pending) {
            this.approvals.delete(requestId);
            pending.resolve(decision);
        }
    }

    async send(workspaceRoot: string | null, id: unknown, text: unknown, attachments: unknown, window: ChatWindow): Promise<void> {
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
            const context = await buildAttachmentContext(window.workspace, attachments as readonly ChatAttachment[] | undefined);
            let session = await this.sessions.get(workspaceRoot, sessionId);
            const userMessage: ChatMessageView = {
                role: 'user',
                content: text,
                at: new Date().toISOString(),
                ...(context.labels.length > 0 ? { attachments: context.labels, context: context.text } : {}),
            };
            session = {
                ...session,
                title: session.messages.length === 0 ? titleFrom(text) : session.title,
                messages: [...session.messages, userMessage],
                updatedAt: userMessage.at,
            };
            await this.sessions.write(workspaceRoot, session);

            const answer = await this.answer(session, controller.signal, window);
            session = { ...session, messages: [...session.messages, answer], updatedAt: answer.at };
            await this.sessions.write(workspaceRoot, session);
            window.emit({ sessionId, type: 'end', message: answer });
        } finally {
            this.running.delete(sessionId);
        }
    }

    /** Streams one answer, looping through tool calls. Failures become an assistant turn with `error`. */
    private async answer(session: StoredSession, signal: AbortSignal, window: ChatWindow): Promise<ChatMessageView> {
        let content = '';
        let model = '';
        const runs: ToolRunView[] = [];
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        const finish = (extra: Partial<ChatMessageView>): ChatMessageView => ({
            role: 'assistant',
            content,
            at: new Date().toISOString(),
            ...(model ? { model } : {}),
            ...(usage ? { usage } : {}),
            ...(runs.length > 0 ? { toolRuns: runs } : {}),
            ...extra,
        });
        let agent = await this.profiles.get(session.agentId);
        if (!agent) {
            return finish({ error: 'The agent of this chat was deleted. Start a new chat.' });
        }
        if (!agent.providerId || !this.providers.list().some((provider) => provider.id === agent?.providerId)) {
            return finish({ error: `${agent.name} has no provider. Edit the agent and pick one.` });
        }
        if (!agent.model) {
            return finish({ error: `${agent.name} has no model. Edit the agent and pick one.` });
        }
        model = agent.model;
        const tools = this.tools.forAgent(agent.tools);
        const { kept, trimmed } = fitHistory(session.messages);
        window.emit({ sessionId: session.id, type: 'start', model, trimmed });
        const messages: ChatMessage[] = kept.map((message) => ({
            role: message.role,
            content: `${message.context ?? ''}${message.content || '(no answer)'}`,
        }));
        try {
            const adapter = this.providers.adapterFor(agent.providerId);
            for (let step = 0; ; step += 1) {
                const request = {
                    model,
                    messages,
                    ...(agent.instructions ? { system: agent.instructions } : {}),
                    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
                    ...(tools.length > 0 ? { tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) } : {}),
                };
                let stepText = '';
                const calls: ToolCall[] = [];
                for await (const event of adapter.stream(request, signal)) {
                    if (event.type === 'text') {
                        if (stepText === '' && content !== '') {
                            content += '\n\n';
                            window.emit({ sessionId: session.id, type: 'delta', text: '\n\n' });
                        }
                        stepText += event.text;
                        content += event.text;
                        window.emit({ sessionId: session.id, type: 'delta', text: event.text });
                    } else if (event.type === 'tool-call') {
                        calls.push(event.call);
                    } else if (event.type === 'usage') {
                        usage = { inputTokens: (usage?.inputTokens ?? 0) + event.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + event.outputTokens };
                    }
                }
                if (calls.length === 0) {
                    return finish({});
                }
                if (step + 1 >= MAX_TOOL_STEPS) {
                    return finish({ error: `Stopped after ${MAX_TOOL_STEPS} rounds of tool calls. Ask the agent to continue if needed.` });
                }
                messages.push({ role: 'assistant', content: stepText, toolCalls: calls });
                for (const call of calls) {
                    const result = await this.runTool(agent, call, tools, session.id, signal, window, runs);
                    messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: result.text, ...(result.isError ? { isError: true } : {}) });
                    if (result.agent) {
                        agent = result.agent;
                    }
                }
            }
        } catch (error) {
            if (signal.aborted || (error instanceof ProviderError && error.kind === 'aborted')) {
                return finish({ stopped: true });
            }
            return finish({ error: error instanceof Error ? error.message : String(error) });
        }
    }

    /** Runs one tool call: checks it is allowed, asks first when it is risky, reports progress. */
    private async runTool(
        agent: AgentProfile,
        call: ToolCall,
        tools: readonly AgentTool[],
        sessionId: string,
        signal: AbortSignal,
        window: ChatWindow,
        runs: ToolRunView[],
    ): Promise<{ text: string; isError: boolean; agent?: AgentProfile }> {
        const tool = tools.find((candidate) => candidate.name === call.name);
        const args = parseArguments(call.arguments);
        const report = (run: ToolRunView): void => {
            const index = runs.findIndex((existing) => existing.id === run.id);
            if (index >= 0) {
                runs[index] = run;
            } else {
                runs.push(run);
            }
            window.emit({ sessionId, type: 'tool', run });
        };
        if (!tool) {
            report({ id: call.id, name: call.name, summary: call.name, status: 'error', result: 'This agent may not use that tool.' });
            return { text: `The tool "${call.name}" is not available to this agent.`, isError: true };
        }
        let summary = tool.name;
        let detail = '';
        try {
            const preview = tool.preview(args);
            summary = preview.summary;
            detail = preview.detail ?? preview.summary;
        } catch {
            // The run below reports the bad arguments.
        }
        let updatedAgent: AgentProfile | undefined;
        if (tool.risk !== 'read' && !(agent.alwaysAllow ?? []).includes(tool.name)) {
            report({ id: call.id, name: tool.name, summary, status: 'running', result: 'Waiting for your approval…' });
            const decision = await this.ask(sessionId, tool, detail, window);
            if (decision === 'deny' || signal.aborted) {
                report({ id: call.id, name: tool.name, summary, status: 'denied' });
                return { text: 'The person denied this action. Do not retry it; ask them or try another approach.', isError: true };
            }
            if (decision === 'always') {
                const { id, ...input } = agent;
                updatedAgent = await this.profiles.save({ ...input, alwaysAllow: [...(agent.alwaysAllow ?? []), tool.name] }, id);
            }
        }
        report({ id: call.id, name: tool.name, summary, status: 'running' });
        try {
            const text = await tool.run(args, { workspace: window.workspace, signal });
            report({ id: call.id, name: tool.name, summary, status: 'done', result: clip(text, RESULT_PREVIEW_CHARS) });
            return { text, isError: false, ...(updatedAgent ? { agent: updatedAgent } : {}) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            report({ id: call.id, name: tool.name, summary, status: 'error', result: message });
            return { text: `Error: ${message}`, isError: true, ...(updatedAgent ? { agent: updatedAgent } : {}) };
        }
    }

    private ask(sessionId: string, tool: AgentTool, detail: string, window: ChatWindow): Promise<ApprovalDecision> {
        return new Promise((resolve) => {
            const id = randomUUID();
            this.approvals.set(id, { sessionId, resolve });
            window.emit({ sessionId, type: 'approval', request: { id, sessionId, tool: tool.name, title: tool.title, detail } });
        });
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

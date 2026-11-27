import { randomUUID } from 'node:crypto';
import type { AgentChatEvent, AgentProfile, ApprovalDecision, ChatAttachment, ChatMessageView, ChatSession, EditReviewResult, SubAgentView, TokenUsage, ToolRunView } from '../../shared/agents.ts';
import type { AgentProfiles } from './agentProfiles.ts';
import { buildAttachmentContext } from './attachments.ts';
import { sessionToMarkdown, summaryOf, titleFrom, type ChatSessions, type StoredSession } from './chatSessions.ts';
import type { ProviderRegistry } from './providerRegistry.ts';
import { parseArguments } from './providers/anthropic.ts';
import { ProviderError, type ChatMessage, type ToolCall } from './providers/types.ts';
import type { ToolCatalog } from './tools/toolCatalog.ts';
import { clip, type AgentTool, type ToolWorkspace } from './tools/toolTypes.ts';
import type { UsageLedger } from './usageLedger.ts';
import { addUsage } from '../../shared/usageFormat.ts';

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
    /** The static folder of the window's Code-XR analysis (A10). */
    analysisOutput?(): string | null;
    emit(event: AgentChatEvent): void;
}

type Usage = TokenUsage;


/** Sub-agents a supervisor runs at once unless its profile says otherwise (A11). */
export const DEFAULT_MAX_PARALLEL = 3;

interface LoopOptions {
    readonly agent: AgentProfile;
    readonly messages: readonly ChatMessage[];
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly window: ChatWindow;
    /** 0 for the chat's agent, 1 for its sub-agents (which cannot delegate). */
    readonly depth: number;
    onText(text: string): void;
    report(run: ToolRunView): void;
}

interface LoopResult {
    readonly content: string;
    readonly usage?: Usage;
    readonly stopped?: boolean;
    readonly error?: string;
}

interface ToolOutcome {
    readonly text: string;
    readonly isError: boolean;
    readonly agent?: AgentProfile;
    /** Tokens a sub-agent spent (A11), added to the answer's usage. */
    readonly usage?: Usage;
}

function upsert(runs: ToolRunView[], run: ToolRunView): void {
    const index = runs.findIndex((existing) => existing.id === run.id);
    if (index >= 0) {
        runs[index] = run;
    } else {
        runs.push(run);
    }
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function runPool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next];
            next += 1;
            if (item !== undefined) {
                await work(item);
            }
        }
    });
    await Promise.all(lanes);
}

interface PendingReview {
    readonly sessionId: string;
    resolve(result: EditReviewResult): void;
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
    private readonly ledger: UsageLedger | null;
    private readonly running = new Map<string, AbortController>();
    private readonly approvals = new Map<string, PendingApproval>();
    private readonly reviews = new Map<string, PendingReview>();
    /** Running sub-agents (A11), by `<sessionId>:<tool call id>`. */
    private readonly children = new Map<string, AbortController>();

    constructor(providers: ProviderRegistry, profiles: AgentProfiles, sessions: ChatSessions, tools: ToolCatalog, ledger: UsageLedger | null = null) {
        this.providers = providers;
        this.profiles = profiles;
        this.sessions = sessions;
        this.tools = tools;
        this.ledger = ledger;
    }

    private providerLabel(agent: AgentProfile): string {
        return this.providers.list().find((provider) => provider.id === agent.providerId)?.label ?? agent.providerId;
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
        for (const [requestId, pending] of this.reviews) {
            if (pending.sessionId === id) {
                this.reviews.delete(requestId);
                pending.resolve({ outcome: 'rejected', accepted: 0, total: 0, message: 'The person stopped the answer.' });
            }
        }
    }

    /** Reports what the person did with a proposed edit; an unknown id is ignored. */
    resolveReview(requestId: unknown, raw: unknown): void {
        if (typeof requestId !== 'string' || !raw || typeof raw !== 'object') {
            throw new Error('Invalid review result.');
        }
        const record = raw as Record<string, unknown>;
        const outcome = record['outcome'];
        if (outcome !== 'applied' && outcome !== 'rejected' && outcome !== 'failed') {
            throw new Error('Invalid review result.');
        }
        const count = (key: string): number => (typeof record[key] === 'number' && Number.isFinite(record[key]) ? Math.max(0, Math.trunc(record[key])) : 0);
        const message = typeof record['message'] === 'string' ? record['message'].slice(0, 2000) : undefined;
        const pending = this.reviews.get(requestId);
        if (pending) {
            this.reviews.delete(requestId);
            pending.resolve({ outcome, accepted: count('accepted'), total: count('total'), ...(message ? { message } : {}) });
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
        const runs: ToolRunView[] = [];
        const at = (): string => new Date().toISOString();
        const failed = (error: string): ChatMessageView => ({ role: 'assistant', content: '', at: at(), error });
        const agent = await this.profiles.get(session.agentId);
        if (!agent) {
            return failed('The agent of this chat was deleted. Start a new chat.');
        }
        const problem = this.setupProblem(agent);
        if (problem) {
            return failed(problem);
        }
        const { kept, trimmed } = fitHistory(session.messages);
        window.emit({ sessionId: session.id, type: 'start', model: agent.model, trimmed });
        const result = await this.loop({
            agent,
            messages: kept.map((message) => ({ role: message.role, content: `${message.context ?? ''}${message.content || '(no answer)'}` })),
            sessionId: session.id,
            signal,
            window,
            depth: 0,
            onText: (text) => window.emit({ sessionId: session.id, type: 'delta', text }),
            report: (run) => {
                upsert(runs, run);
                window.emit({ sessionId: session.id, type: 'tool', run });
            },
        });
        return {
            role: 'assistant',
            content: result.content,
            at: at(),
            model: agent.model,
            provider: this.providerLabel(agent),
            ...(result.usage ? { usage: result.usage } : {}),
            ...(runs.length > 0 ? { toolRuns: runs } : {}),
            ...(result.stopped ? { stopped: true } : {}),
            ...(result.error ? { error: result.error } : {}),
        };
    }

    /** Why `agent` cannot answer yet, or null. */
    private setupProblem(agent: AgentProfile): string | null {
        if (!agent.providerId || !this.providers.list().some((provider) => provider.id === agent.providerId)) {
            return `${agent.name} has no provider. Edit the agent and pick one.`;
        }
        return agent.model ? null : `${agent.name} has no model. Edit the agent and pick one.`;
    }

    /**
     * The model/tool loop shared by an answer and a sub-agent (A11): streams
     * text to `onText`, runs the tools the model asks for (delegate_task calls
     * of one turn in parallel, the rest in order) and reports each run.
     */
    private async loop(options: LoopOptions): Promise<LoopResult> {
        let agent = options.agent;
        const { signal } = options;
        let content = '';
        let usage: Usage | undefined;
        const add = (extra: Usage | undefined): void => {
            if (extra) {
                usage = addUsage(usage, extra);
            }
        };
        const tools = this.tools.forAgent(agent.tools).filter((tool) => options.depth === 0 || tool.name !== 'delegate_task');
        const messages = [...options.messages];
        try {
            const adapter = this.providers.adapterFor(agent.providerId);
            for (let step = 0; ; step += 1) {
                const request = {
                    model: agent.model,
                    messages,
                    ...(agent.instructions ? { system: agent.instructions } : {}),
                    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
                    ...(tools.length > 0 ? { tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) } : {}),
                };
                // A13: a spent budget set to stop refuses the call before it is made.
                this.ledger?.assertWithinBudget();
                let stepText = '';
                let stepUsage: { inputTokens: number; outputTokens: number; cost?: number } | undefined;
                const calls: ToolCall[] = [];
                for await (const event of adapter.stream(request, signal)) {
                    if (event.type === 'text') {
                        if (stepText === '' && content !== '') {
                            content += '\n\n';
                            options.onText('\n\n');
                        }
                        stepText += event.text;
                        content += event.text;
                        options.onText(event.text);
                    } else if (event.type === 'tool-call') {
                        calls.push(event.call);
                    } else if (event.type === 'usage') {
                        stepUsage = event;
                    }
                }
                if (stepUsage) {
                    const call = { inputTokens: stepUsage.inputTokens, outputTokens: stepUsage.outputTokens, ...(stepUsage.cost !== undefined ? { reportedCost: stepUsage.cost } : {}) };
                    add(this.ledger ? await this.ledger.record({ agent: agent.name, provider: this.providerLabel(agent), model: agent.model, ...call }) : call);
                }
                if (calls.length === 0) {
                    return { content, ...(usage ? { usage } : {}) };
                }
                if (step + 1 >= MAX_TOOL_STEPS) {
                    return { content, ...(usage ? { usage } : {}), error: `Stopped after ${MAX_TOOL_STEPS} rounds of tool calls. Ask the agent to continue if needed.` };
                }
                messages.push({ role: 'assistant', content: stepText, toolCalls: calls });
                const results = new Map<string, ToolOutcome>();
                // Sub-agents of one turn run together, up to the supervisor's limit.
                const delegations = calls.filter((call) => call.name === 'delegate_task');
                await runPool(delegations, Math.min(8, Math.max(1, agent.maxParallel ?? DEFAULT_MAX_PARALLEL)), async (call) => {
                    results.set(call.id, await this.runTool(agent, call, tools, options));
                });
                for (const call of calls.filter((candidate) => candidate.name !== 'delegate_task')) {
                    results.set(call.id, await this.runTool(agent, call, tools, options));
                }
                for (const call of calls) {
                    const result = results.get(call.id) ?? { text: 'Error: the tool did not run.', isError: true };
                    messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: result.text, ...(result.isError ? { isError: true } : {}) });
                    add(result.usage);
                    if (result.agent) {
                        agent = result.agent;
                    }
                }
            }
        } catch (error) {
            if (signal.aborted || (error instanceof ProviderError && error.kind === 'aborted')) {
                return { content, ...(usage ? { usage } : {}), stopped: true };
            }
            return { content, ...(usage ? { usage } : {}), error: error instanceof Error ? error.message : String(error) };
        }
    }

    /** Runs one tool call: checks it is allowed, asks first when it is risky, reports progress. */
    private async runTool(agent: AgentProfile, call: ToolCall, tools: readonly AgentTool[], options: LoopOptions): Promise<ToolOutcome> {
        const { sessionId, signal, window, report } = options;
        const tool = tools.find((candidate) => candidate.name === call.name);
        const args = parseArguments(call.arguments);
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
        if (tool.risk !== 'read' && !tool.reviewsItself && !(agent.alwaysAllow ?? []).includes(tool.name)) {
            report({ id: call.id, name: tool.name, summary, status: 'running', result: 'Waiting for your approval…' });
            const decision = await this.ask(sessionId, tool, detail, window, options.depth > 0 ? agent.name : undefined);
            if (decision === 'deny' || signal.aborted) {
                report({ id: call.id, name: tool.name, summary, status: 'denied' });
                return { text: 'The person denied this action. Do not retry it; ask them or try another approach.', isError: true };
            }
            if (decision === 'always') {
                const { id, ...input } = agent;
                updatedAgent = await this.profiles.save({ ...input, alwaysAllow: [...(agent.alwaysAllow ?? []), tool.name] }, id);
            }
        }
        const withAgent = updatedAgent ? { agent: updatedAgent } : {};
        if (tool.name === 'delegate_task') {
            return { ...(await this.runChild(call, summary, args, options)), ...withAgent };
        }
        report({ id: call.id, name: tool.name, summary, status: 'running', ...(tool.reviewsItself ? { result: 'Waiting for your review…' } : {}) });
        try {
            let lastProgress = 0;
            const text = await tool.run(args, {
                workspace: window.workspace,
                signal,
                ...(window.analysisOutput ? { analysisOutput: window.analysisOutput } : {}),
                progress: (output) => {
                    const now = Date.now();
                    if (now - lastProgress >= 200) {
                        lastProgress = now;
                        report({ id: call.id, name: tool.name, summary, status: 'running', result: output });
                    }
                },
                reviewEdit: (request) => new Promise((resolve) => {
                    const id = randomUUID();
                    this.reviews.set(id, { sessionId, resolve });
                    window.emit({ sessionId, type: 'review', request: { ...request, id, sessionId } });
                }),
            });
            report({ id: call.id, name: tool.name, summary, status: 'done', result: clip(text, RESULT_PREVIEW_CHARS) });
            return { text, isError: false, ...withAgent };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            report({ id: call.id, name: tool.name, summary, status: 'error', result: message });
            return { text: `Error: ${message}`, isError: true, ...withAgent };
        }
    }

    /**
     * A11: runs a delegate_task call as a sub-agent with its own profile and a
     * clean context (only the task). Its progress is reported as the call's
     * `child`; it can be cancelled alone (`cancelRun`) or with the whole answer.
     */
    private async runChild(call: ToolCall, summary: string, args: Record<string, unknown>, options: LoopOptions): Promise<ToolOutcome> {
        const { report } = options;
        const fail = (message: string): ToolOutcome => {
            report({ id: call.id, name: 'delegate_task', summary, status: 'error', result: message });
            return { text: `Error: ${message}`, isError: true };
        };
        const name = typeof args['agent'] === 'string' ? args['agent'].trim() : '';
        const task = typeof args['task'] === 'string' ? args['task'].trim() : '';
        if (!task || task.length > 50_000) {
            return fail('The task must be 1 to 50,000 characters.');
        }
        const profiles = await this.profiles.list();
        const child = profiles.find((profile) => profile.name.toLowerCase() === name.toLowerCase());
        if (!child) {
            return fail(`There is no agent named "${name}". Available: ${profiles.map((profile) => profile.name).join(', ')}.`);
        }
        const problem = this.setupProblem(child);
        if (problem) {
            return fail(problem);
        }
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        options.signal.addEventListener('abort', abort, { once: true });
        const key = `${options.sessionId}:${call.id}`;
        this.children.set(key, controller);
        const runs: ToolRunView[] = [];
        let text = '';
        let last = 0;
        const view = (status: SubAgentView['status'], usage?: Usage): SubAgentView => ({ agent: child.name, model: child.model, task, status, text, runs: [...runs], ...(usage ? { usage } : {}) });
        const publish = (status: ToolRunView['status'], childStatus: SubAgentView['status'], usage?: Usage, force = false): void => {
            const now = Date.now();
            if (force || now - last >= 150) {
                last = now;
                report({ id: call.id, name: 'delegate_task', summary, status, child: view(childStatus, usage) });
            }
        };
        publish('running', 'running', undefined, true);
        try {
            const result = await this.loop({
                agent: child,
                messages: [{ role: 'user', content: task }],
                sessionId: options.sessionId,
                signal: controller.signal,
                window: options.window,
                depth: options.depth + 1,
                onText: (delta) => {
                    text += delta;
                    publish('running', 'running');
                },
                report: (run) => {
                    upsert(runs, run);
                    publish('running', 'running', undefined, true);
                },
            });
            if (result.stopped) {
                publish('error', 'stopped', result.usage, true);
                return { text: `${child.name} was stopped before finishing.${text ? ` Partial answer:\n${text}` : ''}`, isError: true, ...(result.usage ? { usage: result.usage } : {}) };
            }
            if (result.error) {
                publish('error', 'error', result.usage, true);
                return { text: `${child.name} failed: ${result.error}${text ? `\nPartial answer:\n${text}` : ''}`, isError: true, ...(result.usage ? { usage: result.usage } : {}) };
            }
            publish('done', 'done', result.usage, true);
            return { text: `${child.name} answered:\n${clip(result.content)}`, isError: false, ...(result.usage ? { usage: result.usage } : {}) };
        } finally {
            options.signal.removeEventListener('abort', abort);
            this.children.delete(key);
        }
    }

    /** Cancels one running sub-agent (A11); the supervisor gets a "stopped" result and carries on. */
    cancelRun(sessionId: unknown, runId: unknown): void {
        if (typeof sessionId !== 'string' || typeof runId !== 'string') {
            throw new Error('Invalid run.');
        }
        this.children.get(`${sessionId}:${runId}`)?.abort();
    }

    private ask(sessionId: string, tool: AgentTool, detail: string, window: ChatWindow, agentName?: string): Promise<ApprovalDecision> {
        return new Promise((resolve) => {
            const id = randomUUID();
            this.approvals.set(id, { sessionId, resolve });
            window.emit({ sessionId, type: 'approval', request: { id, sessionId, tool: tool.name, title: tool.title, detail, ...(agentName ? { agent: agentName } : {}) } });
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

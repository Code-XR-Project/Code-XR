/**
 * Agent Client Protocol chats (the Code-XR IDE's agents: Claude Code, Codex,
 * Gemini, local models) as agent trace events. The IDE already reduces every
 * ACP `session/update` to its own session events; this maps the structural
 * subset Agent Flow needs, so the IDE side stays a thin adapter and the rules
 * (what an ACP tool kind means on the table) live once, next to the dataset.
 *
 * The input types are structural on purpose: core cannot import the IDE.
 */
import type { AgentStepKind, AgentStepStatus, AgentTraceEvent, AgentTraceLocation } from './agentFlowModels';
import { classifyShellCommand } from './shellCommandClassifier';

export type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type AcpToolContent =
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'diff'; readonly path: string; readonly oldText: string | null; readonly newText: string }
    | { readonly type: 'terminal'; readonly terminalId: string; readonly output?: string; readonly exitCode?: number | null };

/** The IDE session events Agent Flow reads (a subset of `SessionEvent`). */
export type AcpSessionEventLike =
    | { readonly type: 'user'; readonly text: string; readonly at?: string }
    | {
        readonly type: 'tool';
        readonly id: string;
        readonly title?: string;
        readonly toolKind?: AcpToolKind;
        readonly status?: AcpToolStatus;
        readonly locations?: readonly { readonly path: string; readonly line?: number }[];
        readonly content?: readonly AcpToolContent[];
        readonly rawInput?: string;
    }
    | { readonly type: 'terminal-output'; readonly terminalId: string; readonly exitCode?: number | null }
    /** The agent asks the person before a tool runs; resolved by `permission-resolved`. */
    | { readonly type: 'permission'; readonly id: string; readonly toolCallId?: string; readonly title: string }
    | { readonly type: 'permission-resolved'; readonly id: string; readonly outcome: string }
    | { readonly type: 'turn-end'; readonly stopReason?: string; readonly at?: string }
    | {
        readonly type: 'metric-delta';
        readonly delta: {
            readonly files: readonly {
                readonly path: string;
                readonly changes: readonly { readonly metric: string; readonly before: number | null; readonly after: number | null }[];
            }[];
        };
    }
    | { readonly type: string };

export function acpKindToStep(kind: AcpToolKind | undefined): AgentStepKind {
    switch (kind) {
        case 'read': return 'read';
        case 'edit': case 'delete': case 'move': return 'write';
        case 'search': return 'search';
        case 'execute': return 'execute';
        case 'think': case 'switch_mode': return 'think';
        case 'fetch': return 'fetch';
        default: return 'other';
    }
}

function acpStatus(status: AcpToolStatus | undefined): AgentStepStatus | undefined {
    switch (status) {
        case 'pending': return 'pending';
        case 'in_progress': return 'running';
        case 'completed': return 'done';
        case 'failed': return 'failed';
        default: return undefined;
    }
}

function lineCount(text: string | null | undefined): number {
    return text ? text.split(/\r?\n/).length : 0;
}

function parseRawCommand(rawInput: string | undefined): string | undefined {
    if (!rawInput) { return undefined; }
    try {
        const parsed = JSON.parse(rawInput) as Record<string, unknown>;
        const command = parsed.command ?? parsed.cmd;
        if (Array.isArray(command)) { return command.map(String).join(' '); }
        return typeof command === 'string' ? command : undefined;
    } catch {
        return undefined;
    }
}

const DELTA_CODE_LINES = new Set(['codeLines', 'code lines', 'loc']);
const DELTA_COMPLEXITY = new Set(['cyclomaticComplexityNumber', 'complexity', 'maxComplexity']);

function change(changes: readonly { metric: string; before: number | null; after: number | null }[], names: Set<string>): number | undefined {
    const hit = changes.find((entry) => names.has(entry.metric));
    if (!hit) { return undefined; }
    return (hit.after ?? 0) - (hit.before ?? 0);
}

/**
 * Stateful mapper for one chat: remembers each tool's kind so an update that
 * omits it keeps the step's verb, and which terminal belongs to which tool.
 */
export class AcpSessionEventMapper {
    private readonly kinds = new Map<string, AgentStepKind>();
    private readonly terminals = new Map<string, string>();
    /** Where each tool works, so a permission asked for it waits at the same building. */
    private readonly locations = new Map<string, AgentTraceLocation[]>();
    private turnOpen = false;

    public map(event: AcpSessionEventLike, at: number): AgentTraceEvent[] {
        switch (event.type) {
            case 'user': {
                const user = event as Extract<AcpSessionEventLike, { type: 'user' }>;
                const out: AgentTraceEvent[] = [];
                if (this.turnOpen) { out.push({ type: 'turn-end', at }); }
                this.turnOpen = true;
                out.push({ type: 'turn-start', at, prompt: user.text.replace(/\s+/g, ' ').trim().slice(0, 160) });
                return out;
            }
            case 'tool':
                return [this.tool(event as Extract<AcpSessionEventLike, { type: 'tool' }>, at)];
            case 'terminal-output': {
                const output = event as Extract<AcpSessionEventLike, { type: 'terminal-output' }>;
                const toolId = this.terminals.get(output.terminalId);
                if (!toolId || output.exitCode === undefined || output.exitCode === null) { return []; }
                return [{
                    type: 'step', at, id: toolId, kind: 'execute', exitCode: output.exitCode,
                    status: output.exitCode === 0 ? 'done' : 'failed',
                }];
            }
            case 'permission': {
                const ask = event as Extract<AcpSessionEventLike, { type: 'permission' }>;
                const step: Extract<AgentTraceEvent, { type: 'step' }> = {
                    type: 'step', at, id: `permission:${ask.id}`, kind: 'wait', tool: 'permission', title: ask.title, status: 'running',
                };
                const locations = ask.toolCallId ? this.locations.get(ask.toolCallId) : undefined;
                if (locations && locations.length > 0) { step.locations = locations; }
                return [step];
            }
            case 'permission-resolved': {
                const done = event as Extract<AcpSessionEventLike, { type: 'permission-resolved' }>;
                const rejected = /reject|deny|cancel/i.test(done.outcome);
                return [{ type: 'step', at, id: `permission:${done.id}`, kind: 'wait', status: rejected ? 'failed' : 'done' }];
            }
            case 'turn-end': {
                const end = event as Extract<AcpSessionEventLike, { type: 'turn-end' }>;
                this.turnOpen = false;
                return [{ type: 'turn-end', at, ...(end.stopReason ? { stopReason: end.stopReason } : {}) }];
            }
            case 'metric-delta': {
                const delta = (event as Extract<AcpSessionEventLike, { type: 'metric-delta' }>).delta;
                return [{
                    type: 'metric-delta',
                    at,
                    files: delta.files.map((file) => ({
                        path: file.path,
                        codeLines: change(file.changes, DELTA_CODE_LINES),
                        complexity: change(file.changes, DELTA_COMPLEXITY),
                    })),
                }];
            }
            default:
                return [];
        }
    }

    private tool(event: Extract<AcpSessionEventLike, { type: 'tool' }>, at: number): AgentTraceEvent {
        let kind = event.toolKind ? acpKindToStep(event.toolKind) : (this.kinds.get(event.id) ?? 'other');
        const locations: AgentTraceLocation[] = (event.locations ?? []).map((loc) => (loc.line ? { path: loc.path, line: loc.line } : { path: loc.path }));
        const created: string[] = [];
        const deleted: string[] = [];
        let added: number | undefined;
        let removed: number | undefined;
        for (const content of event.content ?? []) {
            if (content.type === 'diff') {
                if (!locations.some((loc) => loc.path === content.path)) { locations.push({ path: content.path }); }
                if (content.oldText === null) { created.push(content.path); }
                added = (added ?? 0) + lineCount(content.newText);
                removed = (removed ?? 0) + lineCount(content.oldText);
                if (kind === 'other') { kind = 'write'; }
            } else if (content.type === 'terminal') {
                this.terminals.set(content.terminalId, event.id);
            }
        }
        if (event.toolKind === 'delete') {
            deleted.push(...locations.map((loc) => loc.path));
        }
        const command = kind === 'execute' ? parseRawCommand(event.rawInput) : undefined;
        if (command) {
            const classified = classifyShellCommand(command);
            if (classified.kind !== 'execute') {
                kind = classified.kind;
                for (const path of classified.paths) { locations.push({ path }); }
            }
        }
        this.kinds.set(event.id, kind);
        if (locations.length > 0) { this.locations.set(event.id, locations); }
        const step: Extract<AgentTraceEvent, { type: 'step' }> = { type: 'step', at, id: event.id, kind };
        const status = acpStatus(event.status);
        if (status) { step.status = status; }
        if (event.title) { step.title = event.title; }
        if (event.toolKind) { step.tool = event.toolKind; }
        if (locations.length > 0) { step.locations = locations; }
        if (created.length > 0) { step.created = created; }
        if (deleted.length > 0) { step.deleted = deleted; }
        if (added !== undefined) { step.added = added; }
        if (removed !== undefined) { step.removed = removed; }
        if (command) { step.command = command; }
        return step;
    }
}

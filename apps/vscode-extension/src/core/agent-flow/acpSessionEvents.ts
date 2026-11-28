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

type StepEvent = Extract<AgentTraceEvent, { type: 'step' }>;
type AcpEventOf<T extends string> = Extract<AcpSessionEventLike, { type: T }>;

function metricDeltaEvent(event: AcpEventOf<'metric-delta'>, at: number): AgentTraceEvent {
    return {
        type: 'metric-delta',
        at,
        files: event.delta.files.map((file) => ({
            path: file.path,
            codeLines: change(file.changes, DELTA_CODE_LINES),
            complexity: change(file.changes, DELTA_COMPLEXITY),
        })),
    };
}

function permissionResolvedEvent(done: AcpEventOf<'permission-resolved'>, at: number): AgentTraceEvent {
    const rejected = /reject|deny|cancel/i.test(done.outcome);
    return { type: 'step', at, id: `permission:${done.id}`, kind: 'wait', status: rejected ? 'failed' : 'done' };
}

/** What a tool's content says: the files a diff names or creates, its line counts. */
interface ToolContentSummary {
    kind: AgentStepKind;
    created: string[];
    added?: number;
    removed?: number;
}

/** The optional fields of a tool step, set only when known (in this order). */
interface ToolStepFields {
    status?: AgentStepStatus;
    title?: string;
    tool?: string;
    locations: AgentTraceLocation[];
    created: string[];
    deleted: string[];
    added?: number;
    removed?: number;
    command?: string;
}

function toolStep(id: string, kind: AgentStepKind, at: number, fields: ToolStepFields): StepEvent {
    const step: StepEvent = { type: 'step', at, id, kind };
    if (fields.status) { step.status = fields.status; }
    if (fields.title) { step.title = fields.title; }
    if (fields.tool) { step.tool = fields.tool; }
    if (fields.locations.length > 0) { step.locations = fields.locations; }
    if (fields.created.length > 0) { step.created = fields.created; }
    if (fields.deleted.length > 0) { step.deleted = fields.deleted; }
    if (fields.added !== undefined) { step.added = fields.added; }
    if (fields.removed !== undefined) { step.removed = fields.removed; }
    if (fields.command) { step.command = fields.command; }
    return step;
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
            case 'user': return this.user(event as AcpEventOf<'user'>, at);
            case 'tool': return [this.tool(event as AcpEventOf<'tool'>, at)];
            case 'terminal-output': return this.terminalOutput(event as AcpEventOf<'terminal-output'>, at);
            case 'permission': return [this.permission(event as AcpEventOf<'permission'>, at)];
            case 'permission-resolved': return [permissionResolvedEvent(event as AcpEventOf<'permission-resolved'>, at)];
            case 'turn-end': return [this.turnEnd(event as AcpEventOf<'turn-end'>, at)];
            case 'metric-delta': return [metricDeltaEvent(event as AcpEventOf<'metric-delta'>, at)];
            default: return [];
        }
    }

    private user(user: AcpEventOf<'user'>, at: number): AgentTraceEvent[] {
        const out: AgentTraceEvent[] = [];
        if (this.turnOpen) { out.push({ type: 'turn-end', at }); }
        this.turnOpen = true;
        out.push({ type: 'turn-start', at, prompt: user.text.replace(/\s+/g, ' ').trim().slice(0, 160) });
        return out;
    }

    private terminalOutput(output: AcpEventOf<'terminal-output'>, at: number): AgentTraceEvent[] {
        const toolId = this.terminals.get(output.terminalId);
        if (!toolId || output.exitCode === undefined || output.exitCode === null) { return []; }
        return [{
            type: 'step', at, id: toolId, kind: 'execute', exitCode: output.exitCode,
            status: output.exitCode === 0 ? 'done' : 'failed',
        }];
    }

    private permission(ask: AcpEventOf<'permission'>, at: number): AgentTraceEvent {
        const step: StepEvent = {
            type: 'step', at, id: `permission:${ask.id}`, kind: 'wait', tool: 'permission', title: ask.title, status: 'running',
        };
        const locations = ask.toolCallId ? this.locations.get(ask.toolCallId) : undefined;
        if (locations && locations.length > 0) { step.locations = locations; }
        return step;
    }

    private turnEnd(end: AcpEventOf<'turn-end'>, at: number): AgentTraceEvent {
        this.turnOpen = false;
        return { type: 'turn-end', at, ...(end.stopReason ? { stopReason: end.stopReason } : {}) };
    }

    /** Reads the tool's diffs into `locations` and remembers which terminal it runs. */
    private readContent(event: AcpEventOf<'tool'>, initialKind: AgentStepKind, locations: AgentTraceLocation[]): ToolContentSummary {
        const summary: ToolContentSummary = { kind: initialKind, created: [] };
        for (const content of event.content ?? []) {
            if (content.type === 'diff') {
                if (!locations.some((loc) => loc.path === content.path)) { locations.push({ path: content.path }); }
                if (content.oldText === null) { summary.created.push(content.path); }
                summary.added = (summary.added ?? 0) + lineCount(content.newText);
                summary.removed = (summary.removed ?? 0) + lineCount(content.oldText);
                if (summary.kind === 'other') { summary.kind = 'write'; }
            } else if (content.type === 'terminal') {
                this.terminals.set(content.terminalId, event.id);
            }
        }
        return summary;
    }

    private tool(event: AcpEventOf<'tool'>, at: number): AgentTraceEvent {
        const initialKind = event.toolKind ? acpKindToStep(event.toolKind) : (this.kinds.get(event.id) ?? 'other');
        const locations: AgentTraceLocation[] = (event.locations ?? []).map((loc) => (loc.line ? { path: loc.path, line: loc.line } : { path: loc.path }));
        const content = this.readContent(event, initialKind, locations);
        let kind = content.kind;
        const deleted: string[] = event.toolKind === 'delete' ? locations.map((loc) => loc.path) : [];
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
        return toolStep(event.id, kind, at, {
            status: acpStatus(event.status),
            title: event.title,
            tool: event.toolKind,
            locations,
            created: content.created,
            deleted,
            added: content.added,
            removed: content.removed,
            command,
        });
    }
}

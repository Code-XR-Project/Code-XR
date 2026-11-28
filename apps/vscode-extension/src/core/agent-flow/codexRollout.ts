/**
 * OpenAI Codex CLI session rollouts (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)
 * as agent trace events. Codex works through a shell and `apply_patch`, so the
 * shell commands are classified (cat/sed -n -> read, rg/find -> search) and the
 * patch headers name the files it edits, creates and deletes. Pure: no fs.
 */
import type { AgentTraceEvent, AgentTraceLocation } from './agentFlowModels';
import { classifyShellCommand, parseApplyPatch, unwrapShell } from './shellCommandClassifier';

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseJson(value: unknown): Json | null {
    if (typeof value !== 'string') {
        return asObject(value);
    }
    try {
        return asObject(JSON.parse(value));
    } catch {
        return null;
    }
}

function commandText(command: unknown): string | undefined {
    if (Array.isArray(command)) {
        return unwrapShell(command.map(String));
    }
    return str(command);
}

const SYNTHETIC_PREFIXES = ['<environment_context>', '<user_instructions>', '<permissions', '# AGENTS.md', '<turn_aborted>'];
const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);
const ENVELOPE_TYPES = new Set(['session_meta', 'turn_context', 'event_msg']);
const TURN_END_EVENTS = new Set(['task_complete', 'turn_complete', 'turn_aborted']);

type StepEvent = Extract<AgentTraceEvent, { type: 'step' }>;
type CallKind = 'execute' | 'write' | 'read' | 'search';

function userText(item: Json): string {
    return (Array.isArray(item.content) ? item.content : [])
        .map((part) => str(asObject(part)?.text) ?? '')
        .join(' ')
        .trim();
}

/** A call's arguments: a custom tool's raw input, a local shell's action, or the JSON arguments. */
function callArguments(kind: string, item: Json): Json {
    if (kind === 'custom_tool_call') { return { input: item.input }; }
    if (kind === 'local_shell_call') { return asObject(item.action) ?? {}; }
    return parseJson(item.arguments) ?? {};
}

/** A call's exit code, from the output's metadata or the output itself. */
function outputExitCode(output: Json | null): number | undefined {
    const metadata = asObject(output?.metadata);
    const code = metadata?.exit_code ?? output?.exit_code;
    return typeof code === 'number' ? code : undefined;
}

function shortTitle(command: string): string {
    return command.length > 80 ? `${command.slice(0, 77)}...` : command;
}

/** An apply_patch call's patch: its own body, or one embedded in a shell command. */
function patchOf(name: string, args: Json, command: string | undefined): string | undefined {
    const patchBody = name === 'apply_patch'
        ? str(args.input) ?? str(args.patch)
        : undefined;
    const embeddedPatch = !patchBody && command?.includes('*** Begin Patch') ? command : undefined;
    return patchBody ?? embeddedPatch;
}

function patchStep(id: string, at: number, patch: string): StepEvent {
    const parsed = parseApplyPatch(patch);
    const touched = [...parsed.updated, ...parsed.added, ...parsed.deleted];
    const names = touched.map((p) => p.replace(/^.*[/\\]/, '')).join(', ');
    return {
        type: 'step', at, id, kind: 'write', tool: 'apply_patch', status: 'running',
        title: `apply_patch ${names}`.trim(),
        locations: touched.map((path) => ({ path })),
        created: parsed.added,
        deleted: parsed.deleted,
        added: parsed.plus,
        removed: parsed.minus,
    };
}

export class CodexRolloutParser {
    private readonly calls = new Map<string, CallKind>();
    private turnOpen = false;
    private lastAt = 0;
    public sessionId: string | null = null;
    public cwd: string | null = null;

    public pushLine(line: string): AgentTraceEvent[] {
        const trimmed = line.trim();
        if (!trimmed) {
            return [];
        }
        const entry = parseJson(trimmed);
        return entry ? this.pushEntry(entry) : [];
    }

    public pushEntry(entry: Json): AgentTraceEvent[] {
        const parsed = Date.parse(String(entry.timestamp ?? ''));
        const at = Number.isFinite(parsed) ? parsed : this.lastAt;
        this.lastAt = at;
        // Current rollouts wrap each item as {timestamp, type, payload}; early ones wrote items bare.
        const type = str(entry.type);
        const payload = asObject(entry.payload);
        if (payload && type && ENVELOPE_TYPES.has(type)) {
            return this.envelopeEvents(type, payload, at);
        }
        const item = type === 'response_item' ? payload : entry;
        return item ? this.responseItem(item, at) : [];
    }

    /** Session metadata, turn context and event messages: only a turn's end yields an event. */
    private envelopeEvents(type: string, payload: Json, at: number): AgentTraceEvent[] {
        if (type === 'session_meta') {
            this.sessionId ??= str(payload.id) ?? null;
        }
        if (type !== 'event_msg') {
            this.cwd ??= str(payload.cwd) ?? null;
            return [];
        }
        const kind = str(payload.type);
        if (kind && TURN_END_EVENTS.has(kind) && this.turnOpen) {
            this.turnOpen = false;
            return [{ type: 'turn-end', at, stopReason: kind === 'turn_aborted' ? 'cancelled' : 'end_turn' }];
        }
        return [];
    }

    private openTurnIfNeeded(at: number, events: AgentTraceEvent[]): void {
        if (!this.turnOpen) {
            this.turnOpen = true;
            events.push({ type: 'turn-start', at, prompt: '' });
        }
    }

    private responseItem(item: Json, at: number): AgentTraceEvent[] {
        const kind = str(item.type);
        if (kind === 'message' && item.role === 'user') {
            return this.userMessage(item, at);
        }
        if (kind && CALL_TYPES.has(kind)) {
            return this.call(kind, item, at);
        }
        if (kind && OUTPUT_TYPES.has(kind)) {
            return this.callOutput(item, at);
        }
        return [];
    }

    private userMessage(item: Json, at: number): AgentTraceEvent[] {
        const text = userText(item);
        if (!text || SYNTHETIC_PREFIXES.some((prefix) => text.startsWith(prefix))) {
            return [];
        }
        const events: AgentTraceEvent[] = [];
        if (this.turnOpen) {
            events.push({ type: 'turn-end', at });
        }
        this.turnOpen = true;
        events.push({ type: 'turn-start', at, prompt: text.replace(/\s+/g, ' ').slice(0, 160) });
        return events;
    }

    private call(kind: string, item: Json, at: number): AgentTraceEvent[] {
        const id = str(item.call_id) ?? str(item.id);
        if (!id) {
            return [];
        }
        const events: AgentTraceEvent[] = [];
        this.openTurnIfNeeded(at, events);
        const name = str(item.name) ?? (kind === 'local_shell_call' ? 'shell' : 'tool');
        events.push(this.callStep(id, name, callArguments(kind, item), at));
        return events;
    }

    private callOutput(item: Json, at: number): AgentTraceEvent[] {
        const id = str(item.call_id);
        const stepKind = id ? this.calls.get(id) : undefined;
        if (!id || !stepKind) {
            return [];
        }
        this.calls.delete(id);
        const exitCode = outputExitCode(parseJson(item.output));
        const failed = exitCode !== undefined ? exitCode !== 0 : /^(error|failed)/i.test(String(item.output ?? ''));
        const step: StepEvent = {
            type: 'step', at, id, kind: stepKind, status: failed ? 'failed' : 'done',
        };
        if (exitCode !== undefined) { step.exitCode = exitCode; }
        return [step];
    }

    private callStep(id: string, name: string, args: Json, at: number): AgentTraceEvent {
        const command = commandText(args.command) ?? commandText(args.cmd);
        const patch = patchOf(name, args, command);
        if (patch) {
            this.calls.set(id, 'write');
            return patchStep(id, at, patch);
        }
        if (command) {
            const classified = classifyShellCommand(command);
            const locations: AgentTraceLocation[] = classified.paths.map((path) => ({ path }));
            this.calls.set(id, classified.kind === 'read' || classified.kind === 'search' ? classified.kind : 'execute');
            return {
                type: 'step', at, id, kind: classified.kind, tool: name, status: 'running',
                title: shortTitle(command),
                command,
                ...(locations.length > 0 ? { locations } : {}),
            };
        }
        this.calls.set(id, 'execute');
        return { type: 'step', at, id, kind: name.startsWith('mcp') ? 'fetch' : 'other', tool: name, status: 'running', title: name };
    }
}

export function parseCodexRollout(text: string): { events: AgentTraceEvent[]; sessionId: string | null; cwd: string | null } {
    const parser = new CodexRolloutParser();
    const events: AgentTraceEvent[] = [];
    for (const line of text.split(/\r?\n/)) {
        events.push(...parser.pushLine(line));
    }
    return { events, sessionId: parser.sessionId, cwd: parser.cwd };
}

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

export class CodexRolloutParser {
    private readonly calls = new Map<string, 'execute' | 'write' | 'read' | 'search'>();
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
        if (type === 'session_meta' && payload) {
            this.sessionId ??= str(payload.id) ?? null;
            this.cwd ??= str(payload.cwd) ?? null;
            return [];
        }
        if (type === 'turn_context' && payload) {
            this.cwd ??= str(payload.cwd) ?? null;
            return [];
        }
        if (type === 'event_msg' && payload) {
            const kind = str(payload.type);
            if ((kind === 'task_complete' || kind === 'turn_complete' || kind === 'turn_aborted') && this.turnOpen) {
                this.turnOpen = false;
                return [{ type: 'turn-end', at, stopReason: kind === 'turn_aborted' ? 'cancelled' : 'end_turn' }];
            }
            return [];
        }
        const item = type === 'response_item' ? payload : entry;
        return item ? this.responseItem(item, at) : [];
    }

    private openTurnIfNeeded(at: number, events: AgentTraceEvent[]): void {
        if (!this.turnOpen) {
            this.turnOpen = true;
            events.push({ type: 'turn-start', at, prompt: '' });
        }
    }

    private responseItem(item: Json, at: number): AgentTraceEvent[] {
        const events: AgentTraceEvent[] = [];
        const kind = str(item.type);
        if (kind === 'message' && item.role === 'user') {
            const text = (Array.isArray(item.content) ? item.content : [])
                .map((part) => str(asObject(part)?.text) ?? '')
                .join(' ')
                .trim();
            if (!text || SYNTHETIC_PREFIXES.some((prefix) => text.startsWith(prefix))) {
                return [];
            }
            if (this.turnOpen) {
                events.push({ type: 'turn-end', at });
            }
            this.turnOpen = true;
            events.push({ type: 'turn-start', at, prompt: text.replace(/\s+/g, ' ').slice(0, 160) });
            return events;
        }
        if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
            const id = str(item.call_id) ?? str(item.id);
            if (!id) {
                return [];
            }
            this.openTurnIfNeeded(at, events);
            const name = str(item.name) ?? (kind === 'local_shell_call' ? 'shell' : 'tool');
            const args = kind === 'custom_tool_call'
                ? { input: item.input }
                : kind === 'local_shell_call'
                    ? (asObject(item.action) ?? {})
                    : (parseJson(item.arguments) ?? {});
            events.push(this.callStep(id, name, args, at));
            return events;
        }
        if (kind === 'function_call_output' || kind === 'custom_tool_call_output' || kind === 'local_shell_call_output') {
            const id = str(item.call_id);
            const stepKind = id ? this.calls.get(id) : undefined;
            if (!id || !stepKind) {
                return [];
            }
            this.calls.delete(id);
            const output = parseJson(item.output);
            const metadata = asObject(output?.metadata);
            const code = metadata?.exit_code ?? output?.exit_code;
            const exitCode = typeof code === 'number' ? code : undefined;
            const failed = exitCode !== undefined ? exitCode !== 0 : /^(error|failed)/i.test(String(item.output ?? ''));
            const step: Extract<AgentTraceEvent, { type: 'step' }> = {
                type: 'step', at, id, kind: stepKind, status: failed ? 'failed' : 'done',
            };
            if (exitCode !== undefined) { step.exitCode = exitCode; }
            return [step];
        }
        return [];
    }

    private callStep(id: string, name: string, args: Json, at: number): AgentTraceEvent {
        const patchBody = name === 'apply_patch'
            ? str(args.input) ?? str(args.patch)
            : undefined;
        const command = commandText(args.command) ?? commandText(args.cmd);
        const embeddedPatch = !patchBody && command && command.includes('*** Begin Patch') ? command : undefined;
        const patch = patchBody ?? embeddedPatch;
        if (patch) {
            const parsed = parseApplyPatch(patch);
            const touched = [...parsed.updated, ...parsed.added, ...parsed.deleted];
            this.calls.set(id, 'write');
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
        if (command) {
            const classified = classifyShellCommand(command);
            const locations: AgentTraceLocation[] = classified.paths.map((path) => ({ path }));
            this.calls.set(id, classified.kind === 'read' || classified.kind === 'search' ? classified.kind : 'execute');
            return {
                type: 'step', at, id, kind: classified.kind, tool: name, status: 'running',
                title: command.length > 80 ? `${command.slice(0, 77)}...` : command,
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

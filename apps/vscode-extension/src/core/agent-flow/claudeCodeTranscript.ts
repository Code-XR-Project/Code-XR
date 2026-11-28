/**
 * Claude Code session transcripts (`~/.claude/projects/<encoded cwd>/<id>.jsonl`)
 * as agent trace events. Claude Code writes one JSON object per line while it
 * works, so a follower can feed lines as they land and the scene moves live,
 * whether Claude Code runs in the IDE, in a VS Code terminal or anywhere else.
 *
 * Only the structure is read: tool names, file paths, commands, exit status
 * and the first characters of each prompt (the turn label). Pure: no fs.
 */
import { MAIN_ACTOR_ID, type AgentStepKind, type AgentTraceEvent, type AgentTraceLocation } from './agentFlowModels';
import { classifyShellCommand } from './shellCommandClassifier';

const PROMPT_LABEL_MAX = 160;

interface ToolUse {
    name: string;
    kind: AgentStepKind;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timeOf(entry: Json, fallback: number): number {
    const parsed = Date.parse(String(entry.timestamp ?? ''));
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function claudeToolKind(name: string): AgentStepKind {
    const tool = name.toLowerCase();
    if (name.startsWith('mcp__')) { return 'fetch'; }
    switch (tool) {
        case 'read': case 'notebookread': return 'read';
        case 'edit': case 'multiedit': case 'write': case 'notebookedit': return 'write';
        case 'grep': case 'glob': case 'ls': case 'toolsearch': return 'search';
        case 'bash': case 'bashoutput': case 'killshell': case 'powershell': return 'execute';
        case 'webfetch': case 'websearch': return 'fetch';
        case 'task': case 'agent': return 'delegate';
        case 'todowrite': case 'exitplanmode': return 'think';
        default: return 'other';
    }
}

function promptText(content: unknown): string | null {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return null;
    }
    if (content.some((block) => asObject(block)?.type === 'tool_result')) {
        return null;
    }
    const text = content.map((block) => str(asObject(block)?.text) ?? '').join(' ').trim();
    return text || null;
}

function isSyntheticPrompt(text: string): boolean {
    const trimmed = text.trimStart();
    return trimmed.startsWith('<local-command')
        || trimmed.startsWith('<command-')
        || trimmed.startsWith('<system-reminder>')
        || trimmed.startsWith('Caveat: The messages below')
        || trimmed.startsWith('[Request interrupted');
}

function linesOf(value: unknown): number {
    return typeof value === 'string' && value.length > 0 ? value.split(/\r?\n/).length : 0;
}

/**
 * Incremental parser: feed it raw lines, get events back. Keeps the open tool
 * calls so a later tool_result completes the step it belongs to.
 */
export interface ClaudeCodeParserOptions {
    /**
     * Set for a sub-agent's own transcript (`<session>/subagents/agent-<id>.jsonl`):
     * every step is that actor's (the id of the Agent/Task call that spawned it),
     * and its prompts and turn ends are not the person's.
     */
    actor?: string;
    actorLabel?: string;
}

export class ClaudeCodeTranscriptParser {
    private readonly tools = new Map<string, ToolUse>();
    private turnOpen = false;
    private lastAt = 0;
    private readonly actor: string | undefined;
    private readonly actorLabel: string | undefined;
    /** Sub-agent ids (`agentId`) -> the Agent/Task call that spawned them, from the call's result. */
    private readonly agentCalls = new Map<string, string>();
    public sessionId: string | null = null;
    public cwd: string | null = null;

    constructor(options: ClaudeCodeParserOptions = {}) {
        this.actor = options.actor;
        this.actorLabel = options.actorLabel;
    }

    /** Who ran an entry's steps: this transcript's actor, the sub-agent a side-chain line names, or the main agent. */
    private actorOf(entry: Json): string | undefined {
        if (this.actor) { return this.actor; }
        if (entry.isSidechain !== true) { return undefined; }
        const agentId = str(entry.agentId);
        return agentId ? (this.agentCalls.get(agentId) ?? `agent:${agentId}`) : 'subagent';
    }

    public pushLine(line: string): AgentTraceEvent[] {
        const trimmed = line.trim();
        if (!trimmed) {
            return [];
        }
        let entry: Json | null;
        try {
            entry = asObject(JSON.parse(trimmed));
        } catch {
            return [];
        }
        return entry ? this.pushEntry(entry) : [];
    }

    public pushEntry(entry: Json): AgentTraceEvent[] {
        const at = timeOf(entry, this.lastAt);
        this.lastAt = at;
        this.sessionId ??= str(entry.sessionId) ?? null;
        this.cwd ??= str(entry.cwd) ?? null;
        const message = asObject(entry.message);
        if (!message) {
            return [];
        }
        const subagent = entry.isSidechain === true || this.actor !== undefined;
        const events = entry.type === 'user'
            ? this.userEntry(entry, message, at, subagent)
            : entry.type === 'assistant' ? this.assistantEntry(message, at, subagent) : [];
        const actor = this.actorOf(entry);
        if (actor && actor !== MAIN_ACTOR_ID) {
            for (const event of events) {
                if (event.type === 'step') {
                    event.actor = actor;
                    if (this.actorLabel) { event.actorLabel = this.actorLabel; }
                }
            }
        }
        return events;
    }

    private userEntry(entry: Json, message: Json, at: number, subagent: boolean): AgentTraceEvent[] {
        const events: AgentTraceEvent[] = [];
        const text = promptText(message.content);
        if (text !== null) {
            if (entry.isMeta === true || subagent || isSyntheticPrompt(text)) {
                return [];
            }
            if (this.turnOpen) {
                events.push({ type: 'turn-end', at });
            }
            this.turnOpen = true;
            events.push({ type: 'turn-start', at, prompt: text.replace(/\s+/g, ' ').trim().slice(0, PROMPT_LABEL_MAX) });
            return events;
        }
        const result = asObject(entry.toolUseResult);
        for (const raw of Array.isArray(message.content) ? message.content : []) {
            const block = asObject(raw);
            if (block?.type !== 'tool_result') {
                continue;
            }
            const id = str(block.tool_use_id);
            const tool = id ? this.tools.get(id) : undefined;
            if (!id || !tool) {
                continue;
            }
            const failed = block.is_error === true;
            const update: Extract<AgentTraceEvent, { type: 'step' }> = {
                type: 'step', at, id, kind: tool.kind, tool: tool.name, status: failed ? 'failed' : 'done', subagent,
            };
            if (result && tool.kind === 'search') {
                const hits = Array.isArray(result.filenames) ? result.filenames.filter((f): f is string => typeof f === 'string') : [];
                if (hits.length > 0) {
                    update.locations = hits.slice(0, 200).map((path) => ({ path }));
                }
            }
            if (result && tool.kind === 'delegate' && str(result.agentId)) {
                this.agentCalls.set(String(result.agentId), id);
            }
            if (result && tool.name === 'Write' && result.type === 'create' && str(result.filePath)) {
                update.created = [String(result.filePath)];
            }
            if (result && tool.kind === 'execute') {
                const code = result.exitCode ?? result.returnCode;
                if (typeof code === 'number') {
                    update.exitCode = code;
                    if (code !== 0) { update.status = 'failed'; }
                } else if (result.interrupted === true) {
                    update.status = 'failed';
                }
            }
            events.push(update);
            this.tools.delete(id);
        }
        return events;
    }

    private assistantEntry(message: Json, at: number, subagent: boolean): AgentTraceEvent[] {
        const events: AgentTraceEvent[] = [];
        if (!this.turnOpen && !subagent) {
            // A transcript picked up mid-session (or resumed): open an unnamed turn.
            this.turnOpen = true;
            events.push({ type: 'turn-start', at, prompt: '' });
        }
        for (const raw of Array.isArray(message.content) ? message.content : []) {
            const block = asObject(raw);
            if (block?.type !== 'tool_use') {
                continue;
            }
            const id = str(block.id);
            const name = str(block.name) ?? 'tool';
            if (!id) {
                continue;
            }
            const input = asObject(block.input) ?? {};
            events.push(this.toolStep(id, name, input, at, subagent));
        }
        if (message.stop_reason === 'end_turn' && !subagent && this.turnOpen) {
            this.turnOpen = false;
            events.push({ type: 'turn-end', at, stopReason: 'end_turn' });
        }
        return events;
    }

    private toolStep(id: string, name: string, input: Json, at: number, subagent: boolean): AgentTraceEvent {
        let kind = claudeToolKind(name);
        const locations: AgentTraceLocation[] = [];
        const filePath = str(input.file_path) ?? str(input.notebook_path);
        let title = name;
        let command: string | undefined;
        let added: number | undefined;
        let removed: number | undefined;
        if (filePath) {
            const line = typeof input.offset === 'number' ? input.offset : undefined;
            locations.push(line ? { path: filePath, line } : { path: filePath });
            title = `${name} ${filePath.replace(/^.*[/\\]/, '')}`;
        }
        if (name === 'Edit') {
            added = linesOf(input.new_string);
            removed = linesOf(input.old_string);
        } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
            added = 0; removed = 0;
            for (const edit of input.edits) {
                added += linesOf(asObject(edit)?.new_string);
                removed += linesOf(asObject(edit)?.old_string);
            }
        } else if (name === 'Write') {
            added = linesOf(input.content);
        }
        if (kind === 'search') {
            const pattern = str(input.pattern) ?? str(input.query) ?? '';
            const scope = str(input.path);
            if (scope) { locations.push({ path: scope }); }
            title = `${name} ${pattern}`.trim();
        }
        if (kind === 'execute') {
            command = str(input.command);
            if (command) {
                const classified = classifyShellCommand(command);
                if (classified.kind !== 'execute') {
                    kind = classified.kind;
                    for (const path of classified.paths) { locations.push({ path }); }
                }
                title = command.length > 80 ? `${command.slice(0, 77)}...` : command;
            }
        }
        if ((kind === 'think' || kind === 'delegate') && str(input.description)) {
            title = `${name}: ${String(input.description)}`;
        }
        this.tools.set(id, { name, kind });
        const step: Extract<AgentTraceEvent, { type: 'step' }> = {
            type: 'step', at, id, kind, tool: name, title, status: 'running', subagent,
        };
        if (kind === 'delegate') {
            const label = str(input.description) ?? str(input.subagent_type);
            step.spawns = label ? { id, label } : { id };
        }
        if (locations.length > 0) { step.locations = locations; }
        if (command) { step.command = command; }
        if (added !== undefined) { step.added = added; }
        if (removed !== undefined) { step.removed = removed; }
        return step;
    }
}

/** Parses a whole transcript. */
export function parseClaudeCodeTranscript(text: string): { events: AgentTraceEvent[]; sessionId: string | null; cwd: string | null } {
    const parser = new ClaudeCodeTranscriptParser();
    const events: AgentTraceEvent[] = [];
    for (const line of text.split(/\r?\n/)) {
        events.push(...parser.pushLine(line));
    }
    return { events, sessionId: parser.sessionId, cwd: parser.cwd };
}

/**
 * Claude Code's folder name for a working directory: every character that is
 * not a letter or digit becomes `-` (`/home/a/Code-XR` -> `-home-a-Code-XR`,
 * `C:\Users\A\x` -> `C--Users-A-x`).
 */
export function encodeClaudeProjectDir(cwd: string): string {
    return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

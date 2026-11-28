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

/** Claude Code tool names (lower-cased) and the verb each one is on the table. */
const CLAUDE_TOOL_KINDS = new Map<string, AgentStepKind>([
    ['read', 'read'], ['notebookread', 'read'],
    ['edit', 'write'], ['multiedit', 'write'], ['write', 'write'], ['notebookedit', 'write'],
    ['grep', 'search'], ['glob', 'search'], ['ls', 'search'], ['toolsearch', 'search'],
    ['bash', 'execute'], ['bashoutput', 'execute'], ['killshell', 'execute'], ['powershell', 'execute'],
    ['webfetch', 'fetch'], ['websearch', 'fetch'],
    ['task', 'delegate'], ['agent', 'delegate'],
    ['todowrite', 'think'], ['exitplanmode', 'think'],
]);

export function claudeToolKind(name: string): AgentStepKind {
    if (name.startsWith('mcp__')) { return 'fetch'; }
    return CLAUDE_TOOL_KINDS.get(name.toLowerCase()) ?? 'other';
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

type StepEvent = Extract<AgentTraceEvent, { type: 'step' }>;

/** The content blocks of a message that have the given type. */
function blocksOf(message: Json, type: string): Json[] {
    const blocks: Json[] = [];
    for (const raw of Array.isArray(message.content) ? message.content : []) {
        const block = asObject(raw);
        if (block?.type === type) { blocks.push(block); }
    }
    return blocks;
}

/** A search's hits, as the result lists them (at most 200). */
function searchHits(result: Json): AgentTraceLocation[] {
    const hits = Array.isArray(result.filenames) ? result.filenames.filter((f): f is string => typeof f === 'string') : [];
    return hits.slice(0, 200).map((path) => ({ path }));
}

/** An execute step's exit status: a non-zero code or an interruption fails it. */
function applyExecuteResult(update: StepEvent, result: Json): void {
    const code = result.exitCode ?? result.returnCode;
    if (typeof code === 'number') {
        update.exitCode = code;
        if (code !== 0) { update.status = 'failed'; }
    } else if (result.interrupted === true) {
        update.status = 'failed';
    }
}

/** What a tool_result adds to its step, from the entry's `toolUseResult`. */
function applyToolResult(update: StepEvent, tool: ToolUse, result: Json): void {
    if (tool.kind === 'search') {
        const hits = searchHits(result);
        if (hits.length > 0) { update.locations = hits; }
    }
    if (tool.name === 'Write' && result.type === 'create' && str(result.filePath)) {
        update.created = [String(result.filePath)];
    }
    if (tool.kind === 'execute') { applyExecuteResult(update, result); }
}

/** Lines an Edit, MultiEdit or Write adds and removes, when the input says. */
function editLineCounts(name: string, input: Json): { added?: number; removed?: number } {
    if (name === 'Edit') {
        return { added: linesOf(input.new_string), removed: linesOf(input.old_string) };
    }
    if (name === 'MultiEdit' && Array.isArray(input.edits)) {
        let added = 0;
        let removed = 0;
        for (const edit of input.edits) {
            added += linesOf(asObject(edit)?.new_string);
            removed += linesOf(asObject(edit)?.old_string);
        }
        return { added, removed };
    }
    if (name === 'Write') {
        return { added: linesOf(input.content) };
    }
    return {};
}

/** A tool call as the step starts: its verb, the files it names, its label. */
interface ToolCallShape {
    kind: AgentStepKind;
    locations: AgentTraceLocation[];
    title: string;
    command?: string;
}

/** A shell command: its own label, and a read or search verb when it is one. */
function applyCommand(shape: ToolCallShape, command: string): void {
    shape.command = command;
    const classified = classifyShellCommand(command);
    if (classified.kind !== 'execute') {
        shape.kind = classified.kind;
        for (const path of classified.paths) { shape.locations.push({ path }); }
    }
    shape.title = command.length > 80 ? `${command.slice(0, 77)}...` : command;
}

/** The file a Read, Edit or Write names, and its label. */
function applyFilePath(shape: ToolCallShape, name: string, input: Json): void {
    const filePath = str(input.file_path) ?? str(input.notebook_path);
    if (!filePath) { return; }
    const line = typeof input.offset === 'number' ? input.offset : undefined;
    shape.locations.push(line ? { path: filePath, line } : { path: filePath });
    shape.title = `${name} ${filePath.replace(/^.*[/\\]/, '')}`;
}

/** A search: its scope folder and its pattern as the label. */
function applySearch(shape: ToolCallShape, name: string, input: Json): void {
    const pattern = str(input.pattern) ?? str(input.query) ?? '';
    const scope = str(input.path);
    if (scope) { shape.locations.push({ path: scope }); }
    shape.title = `${name} ${pattern}`.trim();
}

function toolCallShape(name: string, input: Json): ToolCallShape {
    const shape: ToolCallShape = { kind: claudeToolKind(name), locations: [], title: name };
    applyFilePath(shape, name, input);
    if (shape.kind === 'search') { applySearch(shape, name, input); }
    const command = shape.kind === 'execute' ? str(input.command) : undefined;
    if (command) { applyCommand(shape, command); }
    if ((shape.kind === 'think' || shape.kind === 'delegate') && str(input.description)) {
        shape.title = `${name}: ${String(input.description)}`;
    }
    return shape;
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
        const events = this.entryEvents(entry, message, at, subagent);
        const actor = this.actorOf(entry);
        if (actor && actor !== MAIN_ACTOR_ID) {
            this.assignActor(events, actor);
        }
        return events;
    }

    private entryEvents(entry: Json, message: Json, at: number, subagent: boolean): AgentTraceEvent[] {
        if (entry.type === 'user') { return this.userEntry(entry, message, at, subagent); }
        if (entry.type === 'assistant') { return this.assistantEntry(message, at, subagent); }
        return [];
    }

    private assignActor(events: AgentTraceEvent[], actor: string): void {
        for (const event of events) {
            if (event.type === 'step') {
                event.actor = actor;
                if (this.actorLabel) { event.actorLabel = this.actorLabel; }
            }
        }
    }

    private userEntry(entry: Json, message: Json, at: number, subagent: boolean): AgentTraceEvent[] {
        const text = promptText(message.content);
        if (text !== null) {
            return this.promptEntry(entry, text, at, subagent);
        }
        const result = asObject(entry.toolUseResult);
        const events: AgentTraceEvent[] = [];
        for (const block of blocksOf(message, 'tool_result')) {
            const update = this.toolResult(block, result, at, subagent);
            if (update) { events.push(update); }
        }
        return events;
    }

    /** A prompt the person typed opens a turn (closing the open one); anything else is skipped. */
    private promptEntry(entry: Json, text: string, at: number, subagent: boolean): AgentTraceEvent[] {
        if (entry.isMeta === true || subagent || isSyntheticPrompt(text)) {
            return [];
        }
        const events: AgentTraceEvent[] = [];
        if (this.turnOpen) {
            events.push({ type: 'turn-end', at });
        }
        this.turnOpen = true;
        events.push({ type: 'turn-start', at, prompt: text.replace(/\s+/g, ' ').trim().slice(0, PROMPT_LABEL_MAX) });
        return events;
    }

    /** A tool_result completes the open call it belongs to; null when none is open. */
    private toolResult(block: Json, result: Json | null, at: number, subagent: boolean): StepEvent | null {
        const id = str(block.tool_use_id);
        const tool = id ? this.tools.get(id) : undefined;
        if (!id || !tool) {
            return null;
        }
        const failed = block.is_error === true;
        const update: StepEvent = {
            type: 'step', at, id, kind: tool.kind, tool: tool.name, status: failed ? 'failed' : 'done', subagent,
        };
        if (result) {
            if (tool.kind === 'delegate' && str(result.agentId)) {
                this.agentCalls.set(String(result.agentId), id);
            }
            applyToolResult(update, tool, result);
        }
        this.tools.delete(id);
        return update;
    }

    private assistantEntry(message: Json, at: number, subagent: boolean): AgentTraceEvent[] {
        const events: AgentTraceEvent[] = [];
        if (!this.turnOpen && !subagent) {
            // A transcript picked up mid-session (or resumed): open an unnamed turn.
            this.turnOpen = true;
            events.push({ type: 'turn-start', at, prompt: '' });
        }
        for (const block of blocksOf(message, 'tool_use')) {
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
        const { kind, locations, title, command } = toolCallShape(name, input);
        const { added, removed } = editLineCounts(name, input);
        this.tools.set(id, { name, kind });
        const step: StepEvent = {
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

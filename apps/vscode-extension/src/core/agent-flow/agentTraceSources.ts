/**
 * Where agent sessions come from, for one analysed folder:
 *
 * - **Live sources** a host registers (the Code-XR IDE registers one per ACP
 *   chat and pushes its events as they happen);
 * - **Claude Code transcripts** in `~/.claude/projects/<encoded cwd>/*.jsonl`;
 * - **Codex rollouts** in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 *
 * Transcript sources are followed by polling the file size and parsing only
 * the appended bytes, so a session running in a terminal next to the scene
 * moves the scene as it works. Plain Node (fs, os, path): no vscode, no
 * Electron, shared by both hosts. Reads only the local user's own agent
 * history and never sends it anywhere.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentTraceEvent, AgentTraceSourceKind, AgentTraceSourceSummary } from './agentFlowModels';
import { ClaudeCodeTranscriptParser, encodeClaudeProjectDir } from './claudeCodeTranscript';
import { CodexRolloutParser } from './codexRollout';

/** A session that can be opened and followed. */
export interface AgentTraceSource {
    readonly id: string;
    readonly kind: AgentTraceSourceKind;
    readonly agent: string;
    label(): string;
    updatedAt(): number;
    /** True while the session can still grow (a running chat, a transcript written recently). */
    isLive(): boolean;
    /**
     * Starts delivering events: everything so far, then appended ones.
     * Returns the stop function.
     */
    follow(onEvents: (events: AgentTraceEvent[]) => void): () => void;
}

/** A transcript written in the last few minutes is treated as a running session. */
export const LIVE_WINDOW_MS = 3 * 60 * 1000;
const POLL_MS = 900;
const MAX_LIST = 25;
/** Lines of a transcript read to find its cwd / first prompt when listing. */
const PEEK_BYTES = 64 * 1024;

// ---- Live sources registered by a host ------------------------------------

type Listener = () => void;
const liveSources = new Map<string, { root: string; source: AgentTraceSource }>();
const listeners = new Set<Listener>();

function sameRoot(a: string, b: string): boolean {
    const norm = (value: string) => {
        const resolved = path.resolve(value).replace(/[\\/]+$/, '');
        return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
    };
    return norm(a) === norm(b);
}

/** True when `child` is `root` or inside it. */
export function isWithinRoot(root: string, child: string): boolean {
    const rel = path.relative(path.resolve(root), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Registers a live source for a root; returns the unregister function. */
export function registerLiveAgentTraceSource(root: string, source: AgentTraceSource): () => void {
    liveSources.set(source.id, { root, source });
    listeners.forEach((listener) => listener());
    return () => {
        if (liveSources.get(source.id)?.source === source) {
            liveSources.delete(source.id);
            listeners.forEach((listener) => listener());
        }
    };
}

/** Called when live sources come and go (the scene's picker refreshes). */
export function onLiveAgentTraceSourcesChanged(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * A push-driven live source: the host calls `push(events)` as its agent works;
 * followers get the backlog first, then every push.
 */
export class PushAgentTraceSource implements AgentTraceSource {
    private readonly events: AgentTraceEvent[] = [];
    private readonly followers = new Set<(events: AgentTraceEvent[]) => void>();
    private updated = Date.now();
    private title: string;
    private live = true;
    public readonly id: string;
    public readonly kind: AgentTraceSourceKind;
    public readonly agent: string;

    // Plain assignments (no parameter properties): the IDE loads core with Node's type stripping.
    constructor(id: string, kind: AgentTraceSourceKind, agent: string, title: string) {
        this.id = id;
        this.kind = kind;
        this.agent = agent;
        this.title = title;
    }

    public label(): string { return this.title; }
    public setLabel(title: string): void { this.title = title; }
    public updatedAt(): number { return this.updated; }
    public isLive(): boolean { return this.live; }
    public setLive(live: boolean): void { this.live = live; }

    public push(events: AgentTraceEvent[]): void {
        if (events.length === 0) { return; }
        this.events.push(...events);
        this.updated = Date.now();
        for (const follower of this.followers) { follower(events); }
    }

    public follow(onEvents: (events: AgentTraceEvent[]) => void): () => void {
        if (this.events.length > 0) { onEvents([...this.events]); }
        this.followers.add(onEvents);
        return () => { this.followers.delete(onEvents); };
    }
}

// ---- Transcript files -------------------------------------------------------

interface LineParser {
    pushLine(line: string): AgentTraceEvent[];
}

/** Another transcript of the same session (a sub-agent's), followed with its own parser. */
interface Companion {
    file: string;
    createParser: () => LineParser;
}

/**
 * Claude Code writes each sub-agent's transcript to
 * `<session>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` naming
 * the Agent/Task call that spawned it (`toolUseId`) and its `description`.
 */
export function claudeSubagentTranscripts(sessionFile: string): Companion[] {
    const dir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
    let names: string[];
    try {
        names = fs.readdirSync(dir).filter((name) => /^agent-[\w-]+\.jsonl$/.test(name)).sort();
    } catch {
        return [];
    }
    return names.map((name) => {
        const file = path.join(dir, name);
        const agentId = name.slice('agent-'.length, -'.jsonl'.length);
        let actor = `agent:${agentId}`;
        let label: string | undefined;
        try {
            const meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8')) as Record<string, unknown>;
            if (typeof meta.toolUseId === 'string' && meta.toolUseId) { actor = meta.toolUseId; }
            if (typeof meta.description === 'string' && meta.description) { label = meta.description; }
        } catch {
            // No meta yet: the side-chain lines still name the agent.
        }
        return { file, createParser: () => new ClaudeCodeTranscriptParser(label ? { actor, actorLabel: label } : { actor }) };
    });
}

/** Follows a JSONL file: reads it whole, then only what is appended. */
export class JsonlFileAgentTraceSource implements AgentTraceSource {
    public readonly id: string;
    public readonly kind: AgentTraceSourceKind;
    public readonly agent: string;
    private readonly file: string;
    private readonly title: string;
    private readonly createParser: () => LineParser;
    private readonly pollMs: number;
    private readonly companions: (() => Companion[]) | undefined;

    constructor(id: string, kind: AgentTraceSourceKind, agent: string, file: string, title: string, createParser: () => LineParser, pollMs = POLL_MS, companions?: () => Companion[]) {
        this.companions = companions;
        this.id = id;
        this.kind = kind;
        this.agent = agent;
        this.file = file;
        this.title = title;
        this.createParser = createParser;
        this.pollMs = pollMs;
    }

    public label(): string { return this.title; }

    public updatedAt(): number {
        try { return fs.statSync(this.file).mtimeMs; } catch { return 0; }
    }

    public isLive(): boolean {
        return Date.now() - this.updatedAt() < LIVE_WINDOW_MS;
    }

    public follow(onEvents: (events: AgentTraceEvent[]) => void): () => void {
        const tails = new Map<string, JsonlTail>([[this.file, new JsonlTail(this.file, this.createParser())]]);
        let stopped = false;
        let reading = false;
        const readMore = () => {
            if (stopped || reading) { return; }
            reading = true;
            try {
                // Sub-agents write transcripts of their own next to the session's: follow each as it appears.
                for (const companion of this.companions?.() ?? []) {
                    if (!tails.has(companion.file)) { tails.set(companion.file, new JsonlTail(companion.file, companion.createParser())); }
                }
                const events: AgentTraceEvent[] = [];
                for (const tail of tails.values()) { events.push(...tail.read()); }
                if (events.length > 0) { onEvents(events); }
            } finally {
                reading = false;
            }
        };
        readMore();
        const timer = setInterval(readMore, this.pollMs);
        timer.unref?.();
        return () => { stopped = true; clearInterval(timer); };
    }
}

/** Reads a JSONL file whole, then only what is appended. */
class JsonlTail {
    private offset = 0;
    private remainder = '';
    private readonly file: string;
    private readonly parser: LineParser;

    constructor(file: string, parser: LineParser) {
        this.file = file;
        this.parser = parser;
    }

    public read(): AgentTraceEvent[] {
        const events: AgentTraceEvent[] = [];
        try {
            const size = fs.statSync(this.file).size;
            if (size < this.offset) { this.offset = 0; this.remainder = ''; } // truncated / rewritten
            if (size === this.offset) { return events; }
            const fd = fs.openSync(this.file, 'r');
            try {
                const buffer = Buffer.alloc(size - this.offset);
                fs.readSync(fd, buffer, 0, buffer.length, this.offset);
                this.offset = size;
                const lines = (this.remainder + buffer.toString('utf8')).split('\n');
                this.remainder = lines.pop() ?? '';
                for (const line of lines) { events.push(...this.parser.pushLine(line)); }
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            // The file vanished or is locked for a moment: try again on the next tick.
        }
        return events;
    }
}


function readHead(file: string): string {
    try {
        const fd = fs.openSync(file, 'r');
        try {
            const buffer = Buffer.alloc(PEEK_BYTES);
            const read = fs.readSync(fd, buffer, 0, PEEK_BYTES, 0);
            return buffer.subarray(0, read).toString('utf8');
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return '';
    }
}

function firstPrompt(events: AgentTraceEvent[]): string {
    for (const event of events) {
        if (event.type === 'turn-start' && event.prompt) { return event.prompt; }
    }
    return '';
}

function titleFrom(prompt: string, fallback: string): string {
    if (!prompt) { return fallback; }
    return prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
}

/** Peeks a transcript: its cwd and first prompt. */
function peek(file: string, createParser: () => ClaudeCodeTranscriptParser | CodexRolloutParser): { cwd: string | null; prompt: string } {
    const parser = createParser();
    const events: AgentTraceEvent[] = [];
    for (const line of readHead(file).split('\n')) { events.push(...parser.pushLine(line)); }
    return { cwd: parser.cwd, prompt: firstPrompt(events) };
}

function listJsonl(dir: string): string[] {
    try {
        return fs.readdirSync(dir)
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => path.join(dir, name));
    } catch {
        return [];
    }
}

function newestFirst(files: string[], limit: number): string[] {
    return files
        .map((file) => ({ file, mtime: (() => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } })() }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit)
        .map((entry) => entry.file);
}

export interface DiscoveryOptions {
    /** Defaults to os.homedir(); tests point it at a fixture. */
    home?: string;
    claudeConfigDir?: string;
    codexHome?: string;
    limit?: number;
}

/** Claude Code sessions whose working directory is the root or a folder inside it. */
export function discoverClaudeCodeSessions(root: string, options: DiscoveryOptions = {}): AgentTraceSource[] {
    const home = options.home ?? os.homedir();
    const configDir = options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
    const projectsDir = path.join(configDir, 'projects');
    const encodedRoot = encodeClaudeProjectDir(path.resolve(root));
    let dirs: string[];
    try {
        dirs = fs.readdirSync(projectsDir)
            .filter((name) => name === encodedRoot || name.startsWith(`${encodedRoot}-`))
            .map((name) => path.join(projectsDir, name));
    } catch {
        return [];
    }
    const files = newestFirst(dirs.flatMap(listJsonl), options.limit ?? MAX_LIST);
    const sources: AgentTraceSource[] = [];
    for (const file of files) {
        const { cwd, prompt } = peek(file, () => new ClaudeCodeTranscriptParser());
        // The encoded name is lossy (`a-b` and `a/b` collide): confirm with the recorded cwd.
        if (cwd && !isWithinRoot(root, cwd)) { continue; }
        const id = `claude-code:${path.basename(file, '.jsonl')}`;
        sources.push(new JsonlFileAgentTraceSource(
            id, 'claude-code', 'Claude Code', file, titleFrom(prompt, 'Claude Code session'),
            () => new ClaudeCodeTranscriptParser(), POLL_MS, () => claudeSubagentTranscripts(file),
        ));
    }
    return sources;
}

/** Codex sessions recorded with the root (or a folder inside it) as their cwd. */
export function discoverCodexSessions(root: string, options: DiscoveryOptions = {}): AgentTraceSource[] {
    const home = options.home ?? os.homedir();
    const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex');
    const sessionsDir = path.join(codexHome, 'sessions');
    // Newest days first: YYYY/MM/DD folders.
    const days: string[] = [];
    const sortedDirs = (dir: string) => {
        try { return fs.readdirSync(dir).filter((name) => /^\d+$/.test(name)).sort().reverse().map((name) => path.join(dir, name)); } catch { return []; }
    };
    for (const year of sortedDirs(sessionsDir)) {
        for (const month of sortedDirs(year)) {
            days.push(...sortedDirs(month));
            if (days.length >= 60) { break; }
        }
        if (days.length >= 60) { break; }
    }
    const candidates = newestFirst(days.flatMap(listJsonl), 200);
    const sources: AgentTraceSource[] = [];
    for (const file of candidates) {
        if (sources.length >= (options.limit ?? MAX_LIST)) { break; }
        const { cwd, prompt } = peek(file, () => new CodexRolloutParser());
        if (!cwd || !isWithinRoot(root, cwd)) { continue; }
        const id = `codex:${path.basename(file, '.jsonl')}`;
        sources.push(new JsonlFileAgentTraceSource(id, 'codex', 'Codex', file, titleFrom(prompt, 'Codex session'), () => new CodexRolloutParser()));
    }
    return sources;
}

/** Every source for a root: live ones first, then transcripts, newest first. */
export function listAgentTraceSources(root: string, options: DiscoveryOptions = {}): AgentTraceSource[] {
    const live = [...liveSources.values()].filter((entry) => sameRoot(entry.root, root) || isWithinRoot(root, entry.root)).map((entry) => entry.source);
    const files = [...discoverClaudeCodeSessions(root, options), ...discoverCodexSessions(root, options)]
        .sort((a, b) => b.updatedAt() - a.updatedAt());
    return [...live.sort((a, b) => b.updatedAt() - a.updatedAt()), ...files];
}

export function summarizeSource(source: AgentTraceSource): AgentTraceSourceSummary {
    return { id: source.id, kind: source.kind, agent: source.agent, label: source.label(), updatedAt: source.updatedAt(), live: source.isLive() };
}

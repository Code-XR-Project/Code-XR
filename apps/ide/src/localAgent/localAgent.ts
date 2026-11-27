import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { agent, methods, type AgentApp, type AgentContext, type ContentBlock, type McpServer, type SessionConfigOption, type SessionUpdate, type ToolCallContent, type ToolKind } from '@agentclientprotocol/sdk';
import { buildSystemPrompt, applyEdit, globToRegExp, intArg, isWorkspaceTool, numberLines, SKIPPED_DIRECTORIES, stringArg, WORKSPACE_TOOL_KINDS, WORKSPACE_TOOLS } from '@codexr/local-models/tools.ts';
import { runAgentTurn, type ChatMessage, type ModelClient, type ToolCall, type ToolDefinition, type ToolHost, type ToolResult } from '@codexr/local-models/agentLoop.ts';
import type { LocalServerId } from '@codexr/local-models/servers.ts';

/**
 * #312: the local-model agent. An ACP *agent* that the IDE ships and starts
 * like any other (out/localAgent/index.cjs, one process per chat): it drives a
 * model served by Ollama, LM Studio, llama.cpp, vLLM... over the OpenAI
 * Chat Completions protocol and runs the shared tool loop of
 * packages/local-models.
 *
 * Reads, writes and commands go through the ACP client (`fs/*`,
 * `terminal/*`), so the IDE's review, checkpoints and worktrees see them
 * exactly as they see Claude Code's. Listing and searching read the disk
 * directly, inside the session's folder only, because ACP has no request for
 * them. Changes and commands ask first (`session/request_permission`) unless
 * the person chose "Accept edits" or "Always allow" for the chat.
 *
 * Everything that touches the network or another process is injected
 * (`LocalAgentDeps`), so the tests drive this agent in process against a
 * fake model and the real ACP client of the IDE.
 */

export interface LocalAgentConfig {
    /** The agent's name as the person gave it ("Qwen on Ollama"). */
    readonly name: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly serverId?: LocalServerId;
    readonly temperature?: number;
}

/** One MCP server connected for a session (the Code-XR analysis, AF10). */
export interface McpLink {
    readonly name: string;
    readonly tools: readonly { readonly name: string; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>> }[];
    callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
    close(): Promise<void>;
}

export interface LocalAgentDeps {
    readonly client: ModelClient;
    /** The models the server offers now (for the model picker); may fail. */
    listModels(): Promise<readonly string[]>;
    /** Connects one MCP server the client handed in `session/new`; null when it cannot. */
    connectMcp?(server: McpServer, cwd: string): Promise<McpLink | null>;
    readonly platform?: NodeJS.Platform;
    readonly log?: (line: string) => void;
}

type Mode = 'ask' | 'accept-edits';

interface Session {
    readonly id: string;
    readonly cwd: string;
    readonly history: ChatMessage[];
    model: string;
    models: readonly string[];
    mode: Mode;
    readonly alwaysAllow: Set<'edit' | 'execute' | 'mcp'>;
    readonly toolsEnabled: { value: boolean };
    abort: AbortController | null;
    readonly mcp: McpLink[];
    readonly instructions: string;
}

const MODES = [
    { id: 'ask', name: 'Ask', description: 'Asks before changing files or running commands.' },
    { id: 'accept-edits', name: 'Accept edits', description: 'Changes files without asking (you still review them in Changes); asks before commands.' },
];

const MAX_INSTRUCTIONS = 16_000;
const MAX_WALK_ENTRIES = 50_000;
const MAX_FIND_RESULTS = 300;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 1000;
const OUTPUT_BYTE_LIMIT = 64_000;

/** An MCP tool's name as the model sees it: `server__tool`, within OpenAI's 64-character rule. */
export function mcpToolName(server: string, tool: string): string {
    const clean = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_');
    return `${clean(server)}__${clean(tool)}`.slice(0, 64);
}

const TOOL_VERBS: Readonly<Record<string, string>> = { read_file: 'Read', list_directory: 'List', find_files: 'Find', search_text: 'Search', write_file: 'Write', edit_file: 'Edit', run_command: 'Run' };

/** A tool call's title: the verb, plus what it works on when no file location shows it already. */
export function toolTitle(name: string, target: string): string {
    const verb = TOOL_VERBS[name] ?? name;
    if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
        return verb;
    }
    if (name === 'list_directory') {
        return target ? `List ${target}` : 'List the project folder';
    }
    return target ? `${verb} ${target.slice(0, 120)}` : verb;
}

/** The text of a prompt: text blocks, embedded files and links, as one user message. */
export function promptText(blocks: readonly ContentBlock[]): string {
    const parts: string[] = [];
    for (const block of blocks) {
        if (block.type === 'text') {
            parts.push(block.text);
        } else if (block.type === 'resource') {
            const resource = block.resource;
            if ('text' in resource && typeof resource.text === 'string') {
                parts.push(`\n<file uri="${resource.uri}">\n${resource.text}\n</file>`);
            }
        } else if (block.type === 'resource_link') {
            parts.push(`\n(Attached: ${block.uri})`);
        } else if (block.type === 'image') {
            parts.push('\n(An image was attached; this agent cannot see images.)');
        }
    }
    return parts.join('\n').trim();
}

async function readInstructions(cwd: string): Promise<string> {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        try {
            const text = await fs.promises.readFile(path.join(cwd, name), 'utf8');
            return text.trim().slice(0, MAX_INSTRUCTIONS);
        } catch {
            // Try the next one.
        }
    }
    return '';
}

/** `candidate` resolved against `root`, refused when it leaves it. */
export function resolveInside(root: string, candidate: string): string {
    const absolute = path.resolve(root, candidate || '.');
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`${candidate} is outside the project folder.`);
    }
    return absolute;
}

function toPosix(relative: string): string {
    return relative.split(path.sep).join('/');
}

/** Every file under `root` (relative, `/`-separated), skipping dependency and VCS folders. */
async function walk(root: string, start: string, signal: AbortSignal, visit: (relative: string, absolute: string) => Promise<boolean> | boolean): Promise<void> {
    const queue = [start];
    let seen = 0;
    while (queue.length > 0) {
        const dir = queue.shift() as string;
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (signal.aborted || ++seen > MAX_WALK_ENTRIES) {
                return;
            }
            const absolute = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRECTORIES.has(entry.name)) {
                    queue.push(absolute);
                }
            } else if (entry.isFile()) {
                if ((await visit(toPosix(path.relative(root, absolute)), absolute)) === false) {
                    return;
                }
            }
        }
    }
}

function modelOption(session: Session): SessionConfigOption {
    const values = session.models.includes(session.model) ? session.models : [session.model, ...session.models];
    return {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        description: 'The model of your local server this chat uses.',
        currentValue: session.model,
        options: values.map((value) => ({ value, name: value })),
    };
}

/** Builds the ACP agent app. `index.ts` connects it to stdio; tests connect it in process. */
export function createLocalAgent(config: LocalAgentConfig, deps: LocalAgentDeps): AgentApp {
    const sessions = new Map<string, Session>();
    const platform = deps.platform ?? process.platform;
    const log = deps.log ?? (() => undefined);
    let toolCounter = 0;

    const notify = (ctx: AgentContext, sessionId: string, update: SessionUpdate): Promise<void> => ctx.notify(methods.client.session.update, { sessionId, update });

    const requireSession = (sessionId: string): Session => {
        const session = sessions.get(sessionId);
        if (!session) {
            throw new Error('Unknown session.');
        }
        return session;
    };

    /** The server's models; a server that does not answer fails the session, with how to start it. */
    async function refreshModels(session: Session): Promise<void> {
        session.models = [...(await deps.listModels())];
    }

    async function connectServers(session: Session, servers: readonly McpServer[]): Promise<void> {
        if (!deps.connectMcp) {
            return;
        }
        for (const server of servers) {
            try {
                const link = await deps.connectMcp(server, session.cwd);
                if (link) {
                    session.mcp.push(link);
                }
            } catch (error) {
                log(`MCP server ${server.name} is not available: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /** Asks the person; true when allowed. "Always" is remembered for the chat. */
    async function permit(ctx: AgentContext, session: Session, scope: 'edit' | 'execute' | 'mcp', toolCallId: string, title: string, kind: ToolKind, content: ToolCallContent[]): Promise<boolean> {
        if (session.alwaysAllow.has(scope) || (scope === 'edit' && session.mode === 'accept-edits')) {
            return true;
        }
        const response = await ctx.request(methods.client.session.requestPermission, {
            sessionId: session.id,
            toolCall: { toolCallId, title, kind, status: 'pending', content },
            options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'always', name: scope === 'execute' ? 'Always allow commands in this chat' : scope === 'edit' ? 'Always allow edits in this chat' : 'Always allow this in this chat', kind: 'allow_always' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
        });
        if (response.outcome.outcome !== 'selected') {
            return false;
        }
        if (response.outcome.optionId === 'always') {
            session.alwaysAllow.add(scope);
            return true;
        }
        return response.outcome.optionId === 'allow';
    }

    function toolHost(ctx: AgentContext, session: Session): ToolHost {
        const mcpTools = new Map<string, { link: McpLink; tool: string }>();
        const extra: ToolDefinition[] = [];
        for (const link of session.mcp) {
            for (const tool of link.tools) {
                const name = mcpToolName(link.name, tool.name);
                if (!mcpTools.has(name)) {
                    mcpTools.set(name, { link, tool: tool.name });
                    extra.push({ name, description: tool.description || tool.name, parameters: tool.inputSchema });
                }
            }
        }
        const readFile = async (absolute: string): Promise<string> => (await ctx.request(methods.client.fs.readTextFile, { sessionId: session.id, path: absolute })).content;
        const tryRead = async (absolute: string): Promise<string | null> => {
            try {
                return await readFile(absolute);
            } catch {
                return null;
            }
        };

        async function runWorkspace(call: ToolCall, args: Record<string, unknown>, signal: AbortSignal, toolCallId: string): Promise<ToolResult & { content: string; ui?: ToolCallContent[] }> {
            const cwd = session.cwd;
            switch (call.name) {
                case 'read_file': {
                    const file = resolveInside(cwd, stringArg(args, 'path'));
                    const text = await readFile(file);
                    return { content: numberLines(text, intArg(args, 'offset', 1, 1, Number.MAX_SAFE_INTEGER), intArg(args, 'limit', 400, 1, 4000)) || '(empty file)' };
                }
                case 'list_directory': {
                    const dir = resolveInside(cwd, stringArg(args, 'path', { optional: true }));
                    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
                    const lines = entries.slice(0, MAX_LIST_ENTRIES).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
                    return { content: (lines.join('\n') || '(empty folder)') + (entries.length > MAX_LIST_ENTRIES ? `\n[${entries.length - MAX_LIST_ENTRIES} more]` : '') };
                }
                case 'find_files': {
                    const regex = globToRegExp(stringArg(args, 'pattern'));
                    const found: string[] = [];
                    await walk(cwd, cwd, signal, (relative) => {
                        if (regex.test(relative)) {
                            found.push(relative);
                        }
                        return found.length < MAX_FIND_RESULTS;
                    });
                    return { content: found.length ? found.join('\n') + (found.length >= MAX_FIND_RESULTS ? '\n[more results left out: narrow the pattern]' : '') : 'No file matches.' };
                }
                case 'search_text': {
                    const query = stringArg(args, 'query');
                    let matcher: RegExp;
                    try {
                        matcher = args['regex'] === true ? new RegExp(query, 'i') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                    } catch {
                        throw new Error('The query is not a valid regular expression.');
                    }
                    const start = resolveInside(cwd, stringArg(args, 'path', { optional: true }));
                    const matches: string[] = [];
                    await walk(cwd, start, signal, async (relative, absolute) => {
                        const stat = await fs.promises.stat(absolute).catch(() => null);
                        if (!stat || stat.size > MAX_SEARCH_FILE_BYTES) {
                            return true;
                        }
                        const buffer = await fs.promises.readFile(absolute).catch(() => null);
                        if (!buffer || buffer.subarray(0, 8000).includes(0)) {
                            return true;
                        }
                        const lines = buffer.toString('utf8').split(/\r?\n/);
                        for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
                            const line = lines[i] ?? '';
                            if (matcher.test(line)) {
                                matches.push(`${relative}:${i + 1}: ${line.trim().slice(0, 300)}`);
                            }
                        }
                        return matches.length < MAX_SEARCH_MATCHES;
                    });
                    return { content: matches.length ? matches.join('\n') + (matches.length >= MAX_SEARCH_MATCHES ? '\n[more matches left out: narrow the query]' : '') : 'No match.' };
                }
                case 'write_file':
                case 'edit_file': {
                    const relativePath = stringArg(args, 'path');
                    const file = resolveInside(cwd, relativePath);
                    const previous = await tryRead(file);
                    let next: string;
                    if (call.name === 'write_file') {
                        next = stringArg(args, 'content', { allowEmpty: true });
                    } else {
                        if (previous === null) {
                            throw new Error(`${relativePath} does not exist. Use write_file to create it.`);
                        }
                        next = applyEdit(previous, stringArg(args, 'old_string', { allowEmpty: true }), stringArg(args, 'new_string', { allowEmpty: true }), args['replace_all'] === true);
                    }
                    const diff: ToolCallContent[] = [{ type: 'diff', path: file, oldText: previous, newText: next }];
                    if (!(await permit(ctx, session, 'edit', toolCallId, `${previous === null ? 'Create' : 'Edit'} ${relativePath}`, 'edit', diff))) {
                        return { content: 'The user rejected this change. Ask what they want instead.', isError: true, ui: diff };
                    }
                    await ctx.request(methods.client.fs.writeTextFile, { sessionId: session.id, path: file, content: next });
                    return { content: `${previous === null ? 'Created' : 'Updated'} ${relativePath}.`, ui: diff };
                }
                case 'run_command': {
                    const command = stringArg(args, 'command');
                    const seconds = intArg(args, 'timeout_seconds', 120, 1, 600);
                    if (!(await permit(ctx, session, 'execute', toolCallId, `Run ${command.slice(0, 120)}`, 'execute', [{ type: 'content', content: { type: 'text', text: command } }]))) {
                        return { content: 'The user rejected this command.', isError: true };
                    }
                    const terminal = await ctx.createTerminal({ sessionId: session.id, command, args: [], cwd, outputByteLimit: OUTPUT_BYTE_LIMIT });
                    try {
                        await notify(ctx, session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', content: [{ type: 'terminal', terminalId: terminal.id }] });
                        let timer: ReturnType<typeof setTimeout> | undefined;
                        const outcome = await Promise.race([
                            terminal.waitForExit().then((exit) => ({ exit })),
                            new Promise<{ exit: null; why: string }>((resolve) => {
                                timer = setTimeout(() => resolve({ exit: null, why: `timed out after ${seconds}s` }), seconds * 1000);
                                signal.addEventListener('abort', () => resolve({ exit: null, why: 'stopped by the user' }), { once: true });
                            }),
                        ]);
                        clearTimeout(timer);
                        if (outcome.exit === null) {
                            await terminal.kill().catch(() => undefined);
                        }
                        const output = await terminal.currentOutput();
                        const status = outcome.exit === null ? `The command was stopped (${(outcome as { why: string }).why}).` : `Exit code: ${outcome.exit.exitCode ?? `signal ${outcome.exit.signal ?? 'unknown'}`}`;
                        return { content: `${status}\n${output.truncated ? '[output truncated to its end]\n' : ''}${output.output || '(no output)'}`, ...(outcome.exit?.exitCode === 0 ? {} : { isError: true }), ui: [{ type: 'terminal', terminalId: terminal.id }] };
                    } finally {
                        await terminal.release().catch(() => undefined);
                    }
                }
                default:
                    throw new Error(`Unknown tool ${call.name}.`);
            }
        }

        return {
            definitions: () => [...WORKSPACE_TOOLS, ...extra],
            async run(call, args, signal) {
                const toolCallId = `local-${++toolCounter}`;
                const workspace = isWorkspaceTool(call.name);
                const kind: ToolKind = workspace ? WORKSPACE_TOOL_KINDS[call.name as keyof typeof WORKSPACE_TOOL_KINDS] : 'fetch';
                const target = typeof args['path'] === 'string' ? args['path'] : typeof args['pattern'] === 'string' ? args['pattern'] : typeof args['query'] === 'string' ? args['query'] : typeof args['command'] === 'string' ? args['command'] : '';
                const title = workspace ? toolTitle(call.name, String(target)) : call.name.replace('__', ': ');
                const locations = typeof args['path'] === 'string' && call.name !== 'search_text' ? (() => {
                    try {
                        return [{ path: resolveInside(session.cwd, args['path'] as string) }];
                    } catch {
                        return [];
                    }
                })() : [];
                await notify(ctx, session.id, { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'in_progress', rawInput: args, ...(locations.length ? { locations } : {}) });
                try {
                    let result: ToolResult & { ui?: ToolCallContent[] };
                    if (workspace) {
                        result = await runWorkspace(call, args, signal, toolCallId);
                    } else {
                        const target = mcpTools.get(call.name);
                        if (!target) {
                            throw new Error(`Unknown tool ${call.name}. Use one of the tools you were given.`);
                        }
                        // The Code-XR analysis only reads; any other server's tool asks first.
                        if (target.link.name !== 'code-xr' && !(await permit(ctx, session, 'mcp', toolCallId, title, 'other', []))) {
                            result = { content: 'The user rejected this tool call.', isError: true };
                        } else {
                            result = { content: await target.link.callTool(target.tool, args, signal) };
                        }
                    }
                    await notify(ctx, session.id, {
                        sessionUpdate: 'tool_call_update',
                        toolCallId,
                        status: result.isError ? 'failed' : 'completed',
                        ...(result.ui ? { content: result.ui } : result.isError ? { content: [{ type: 'content', content: { type: 'text', text: result.content.slice(0, 2000) } }] } : {}),
                    });
                    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    await notify(ctx, session.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message.slice(0, 2000) } }] });
                    return { content: message, isError: true };
                }
            },
        };
    }

    return agent({ name: 'code-xr-local-agent' })
        .onRequest(methods.agent.initialize, () => ({
            protocolVersion: 1,
            agentInfo: { name: 'code-xr-local-agent', title: config.name, version: '0.1.0' },
            agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: true, image: false, audio: false }, mcpCapabilities: { http: false, sse: false } },
            authMethods: [],
        }))
        .onRequest(methods.agent.session.new, async ({ params }) => {
            const id = randomUUID();
            const session: Session = {
                id,
                cwd: params.cwd,
                history: [],
                model: config.model,
                models: [],
                mode: 'ask',
                alwaysAllow: new Set(),
                toolsEnabled: { value: true },
                abort: null,
                mcp: [],
                instructions: await readInstructions(params.cwd),
            };
            await Promise.all([refreshModels(session), connectServers(session, params.mcpServers ?? [])]);
            sessions.set(id, session);
            return {
                sessionId: id,
                modes: { currentModeId: session.mode, availableModes: MODES },
                configOptions: [modelOption(session)],
            };
        })
        .onRequest(methods.agent.session.setMode, ({ params }) => {
            const session = requireSession(params.sessionId);
            if (params.modeId !== 'ask' && params.modeId !== 'accept-edits') {
                throw new Error('Unknown mode.');
            }
            session.mode = params.modeId;
            return {};
        })
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
            const session = requireSession(params.sessionId);
            if (params.configId !== 'model' || typeof params.value !== 'string' || !params.value.trim()) {
                throw new Error('Unknown option.');
            }
            session.model = params.value;
            // Another model may well call tools: try again.
            session.toolsEnabled.value = true;
            return { configOptions: [modelOption(session)] };
        })
        .onNotification(methods.agent.session.cancel, ({ params }) => {
            sessions.get(params.sessionId)?.abort?.abort();
        })
        .onRequest(methods.agent.session.prompt, async ({ params, client: ctx }) => {
            const session = requireSession(params.sessionId);
            session.abort?.abort();
            const controller = new AbortController();
            session.abort = controller;
            session.history.push({ role: 'user', content: promptText(params.prompt) });
            const tools = toolHost(ctx, session);
            try {
                const stop = await runAgentTurn({
                    client: deps.client,
                    model: session.model,
                    system: buildSystemPrompt({
                        agentName: config.name,
                        model: session.model,
                        cwd: session.cwd,
                        platform: platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux',
                        toolsEnabled: session.toolsEnabled.value,
                        extraTools: tools.definitions().map((tool) => tool.name),
                        ...(session.instructions ? { projectInstructions: session.instructions } : {}),
                    }),
                    history: session.history,
                    tools,
                    toolsEnabled: session.toolsEnabled,
                    signal: controller.signal,
                    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
                    events: {
                        onText: (text) => notify(ctx, session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }),
                        onToolsUnsupported: () => notify(ctx, session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `_${session.model} cannot call tools on this server, so it answers without reading or changing files. Pick a model with tool support (for example qwen2.5-coder or llama3.1) for agent work._\n\n` } }),
                    },
                });
                return { stopReason: stop };
            } finally {
                if (session.abort === controller) {
                    session.abort = null;
                }
            }
        });
}

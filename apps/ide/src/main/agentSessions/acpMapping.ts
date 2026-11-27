import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
    AuthMethod,
    AvailableCommand,
    ContentBlock,
    SessionConfigOption,
    SessionModeState,
    SessionUpdate,
    StopReason,
    ToolCallContent,
    ToolCallLocation,
    ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type {
    AuthMethodView,
    ConfigOptionView,
    ModeView,
    PlanEntryView,
    SessionEvent,
    SlashCommandView,
    ToolContentView,
    ToolKind,
    ToolStatus,
    TranscriptItem,
} from '../../shared/agentSession.ts';

/**
 * AF1: the pure translation between the Agent Client Protocol (v1) and the
 * IDE's transcript model (`shared/agentSession.ts`). Every `session/update`
 * kind the agent may send becomes zero or more `SessionEvent`s; unknown kinds
 * and content the chat cannot show are dropped rather than thrown on, so a
 * newer agent never breaks an older IDE. No I/O here: the connection and the
 * service feed it, and the unit tests drive it directly.
 */

/** What a terminal the IDE runs for an agent holds right now (so a tool card shows it at once). */
export interface TerminalSnapshot {
    readonly output: string;
    readonly exitCode: number | null;
    readonly truncated: boolean;
}

export interface MappingContext {
    /** A fresh id for notices. */
    newId(): string;
    /** The output so far of a terminal the IDE runs for this session. */
    terminal?(terminalId: string): TerminalSnapshot | undefined;
}

const TOOL_KINDS: ReadonlySet<string> = new Set<ToolKind>(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
const TOOL_STATUSES: ReadonlySet<string> = new Set<ToolStatus>(['pending', 'in_progress', 'completed', 'failed']);
const MAX_RAW_INPUT = 8000;

export function toolKindOf(value: unknown): ToolKind {
    return typeof value === 'string' && TOOL_KINDS.has(value) ? (value as ToolKind) : 'other';
}

function toolStatusOf(value: unknown): ToolStatus | undefined {
    return typeof value === 'string' && TOOL_STATUSES.has(value) ? (value as ToolStatus) : undefined;
}

/** A content block as chat text: text as is, links as Markdown links, anything else as a short placeholder. */
export function contentBlockText(block: ContentBlock): string {
    switch (block.type) {
        case 'text':
            return block.text;
        case 'resource_link':
            return `[${block.title ?? block.name}](${block.uri})`;
        case 'resource':
            return 'text' in block.resource ? block.resource.text : `[${block.resource.uri}]`;
        case 'image':
            return '[image]';
        case 'audio':
            return '[audio]';
        default:
            return '';
    }
}

export function mapToolContent(content: readonly ToolCallContent[], ctx: MappingContext): ToolContentView[] {
    const views: ToolContentView[] = [];
    for (const item of content) {
        if (item.type === 'content') {
            const text = contentBlockText(item.content);
            if (text) {
                views.push({ type: 'text', text });
            }
        } else if (item.type === 'diff') {
            views.push({ type: 'diff', path: item.path, oldText: item.oldText ?? null, newText: item.newText });
        } else if (item.type === 'terminal') {
            const snapshot = ctx.terminal?.(item.terminalId);
            views.push({
                type: 'terminal',
                terminalId: item.terminalId,
                output: snapshot?.output ?? '',
                exitCode: snapshot?.exitCode ?? null,
                ...(snapshot?.truncated ? { truncated: true } : {}),
            });
        }
    }
    return views;
}

function mapLocations(locations: readonly ToolCallLocation[]): { path: string; line?: number }[] {
    return locations.map((location) => (typeof location.line === 'number' ? { path: location.path, line: location.line } : { path: location.path }));
}

/** The tool's raw input as compact JSON for the expanded card, capped. */
export function rawInputText(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    let text: string;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        return undefined;
    }
    return text.length > MAX_RAW_INPUT ? `${text.slice(0, MAX_RAW_INPUT)}...` : text;
}

/** A `tool_call` or `tool_call_update` (also the `toolCall` of a permission request) as a `tool` event. */
export function toolEvent(update: ToolCallUpdate, ctx: MappingContext, isNew: boolean): Extract<SessionEvent, { type: 'tool' }> {
    const status = toolStatusOf(update.status);
    const rawInput = rawInputText(update.rawInput);
    return {
        type: 'tool',
        id: update.toolCallId,
        ...(typeof update.title === 'string' && update.title ? { title: update.title } : {}),
        ...(update.kind ? { toolKind: toolKindOf(update.kind) } : isNew ? { toolKind: 'other' as const } : {}),
        ...(status ? { status } : isNew ? { status: 'pending' as const } : {}),
        ...(update.locations ? { locations: mapLocations(update.locations) } : {}),
        ...(update.content ? { content: mapToolContent(update.content, ctx) } : {}),
        ...(rawInput !== undefined ? { rawInput } : {}),
    };
}

export function mapCommands(commands: readonly AvailableCommand[]): SlashCommandView[] {
    return commands.map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.input && typeof command.input.hint === 'string' ? { hint: command.input.hint } : {}),
    }));
}

export function mapModes(modes: SessionModeState): { current: string; available: ModeView[] } {
    return {
        current: modes.currentModeId,
        available: modes.availableModes.map((mode) => ({ id: mode.id, name: mode.name, ...(mode.description ? { description: mode.description } : {}) })),
    };
}

/** Config options the chat shows as pickers. A boolean option becomes an On / Off choice (`true` / `false`). */
export function mapConfigOptions(options: readonly SessionConfigOption[]): ConfigOptionView[] {
    const views: ConfigOptionView[] = [];
    for (const option of options) {
        const base = { id: option.id, name: option.name, ...(option.category ? { category: option.category } : {}) };
        if (option.type === 'boolean') {
            views.push({ ...base, current: String(option.currentValue), values: [{ id: 'true', name: 'On' }, { id: 'false', name: 'Off' }] });
            continue;
        }
        if (option.type !== 'select') {
            continue;
        }
        const values: { id: string; name: string; description?: string }[] = [];
        for (const entry of option.options) {
            const group = 'group' in entry ? entry.options : [entry];
            for (const value of group) {
                values.push({ id: value.value, name: value.name, ...(value.description ? { description: value.description } : {}) });
            }
        }
        views.push({ ...base, current: option.currentValue, values });
    }
    return views;
}

function noticeLevel(severity: string): 'info' | 'warning' | 'error' {
    return severity === 'warning' || severity === 'error' ? severity : 'info';
}

/** One `session/update` as the events that change the transcript. */
export function mapSessionUpdate(update: SessionUpdate, ctx: MappingContext): SessionEvent[] {
    switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
            const text = contentBlockText(update.content);
            return text ? [{ type: 'assistant-chunk', text }] : [];
        }
        case 'agent_thought_chunk': {
            const text = contentBlockText(update.content);
            return text ? [{ type: 'thought-chunk', text }] : [];
        }
        case 'tool_call':
            return [toolEvent(update, ctx, true)];
        case 'tool_call_update':
            return [toolEvent(update, ctx, false)];
        case 'plan':
            return [{ type: 'plan', entries: update.entries.map((entry): PlanEntryView => ({ content: entry.content, priority: entry.priority, status: entry.status })) }];
        case 'available_commands_update':
            return [{ type: 'commands', commands: mapCommands(update.availableCommands) }];
        case 'current_mode_update':
            return [{ type: 'modes', current: update.currentModeId }];
        case 'config_option_update':
            return [{ type: 'config', options: mapConfigOptions(update.configOptions) }];
        case 'session_info_update':
            return typeof update.title === 'string' && update.title.trim() ? [{ type: 'title', title: update.title.trim() }] : [];
        case 'usage_update':
            return [{ type: 'usage', used: update.used, size: update.size }];
        case 'notice': {
            const text = update.description ? `${update.title}: ${update.description}` : update.title;
            return [{ type: 'notice', id: ctx.newId(), level: noticeLevel(update.severity), text }];
        }
        default:
            // user_message_chunk (the IDE records the person's messages itself), plan_update and
            // subagent updates (capabilities the IDE does not advertise), compaction, and any kind
            // a newer protocol adds.
            return [];
    }
}

type StopReasonView = Extract<TranscriptItem, { kind: 'turn-end' }>['stopReason'];
const STOP_REASONS: ReadonlySet<string> = new Set<StopReason>(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);

export function stopReasonOf(value: unknown): StopReasonView {
    return typeof value === 'string' && STOP_REASONS.has(value) ? (value as StopReasonView) : 'end_turn';
}

// ---- Authentication ---------------------------------------------------------

/** A login method as the agent advertised it, with what the IDE needs to run it. */
export interface AuthMethodSpec {
    readonly view: AuthMethodView;
    /** Terminal methods: the arguments to run the agent's own command with. */
    readonly args?: readonly string[];
    /** Terminal methods: a different command to run (the `terminal-auth` hint). */
    readonly command?: string;
    readonly env?: Readonly<Record<string, string>>;
}

function stringArray(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    return Object.fromEntries(entries);
}

/**
 * #297: the environment variables an agent reads its provider's key from.
 * Codex reads `CODEX_API_KEY` before `OPENAI_API_KEY`, so both are set.
 */
export const API_KEY_ENV: Readonly<Record<string, readonly string[]>> = {
    openai: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    google: ['GEMINI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
};

/**
 * The agent's `authMethods`: `type: "terminal"` (or a `terminal-auth` hint in
 * `_meta`) runs the agent's own login in a terminal, an environment-variable
 * method needs a key in the agent's environment, anything else is handled by
 * the agent itself through `authenticate`.
 */
export function mapAuthMethods(methods: readonly AuthMethod[] | readonly unknown[] | undefined): AuthMethodSpec[] {
    const specs: AuthMethodSpec[] = [];
    for (const raw of methods ?? []) {
        if (!raw || typeof raw !== 'object') {
            continue;
        }
        const method = raw as Record<string, unknown>;
        if (typeof method['id'] !== 'string' || typeof method['name'] !== 'string') {
            continue;
        }
        const meta = method['_meta'] && typeof method['_meta'] === 'object' ? (method['_meta'] as Record<string, unknown>) : {};
        const hint = meta['terminal-auth'] && typeof meta['terminal-auth'] === 'object' ? (meta['terminal-auth'] as Record<string, unknown>) : null;
        const declared = method['type'];
        // #297: Codex and Gemini CLI mark their key method with `_meta["api-key"].provider`.
        const keyMeta = meta['api-key'] && typeof meta['api-key'] === 'object' ? (meta['api-key'] as Record<string, unknown>) : null;
        const provider = typeof keyMeta?.['provider'] === 'string' && Object.hasOwn(API_KEY_ENV, keyMeta['provider']) ? keyMeta['provider'] : null;
        const type: AuthMethodView['type'] = declared === 'terminal' || hint ? 'terminal' : provider ? 'api-key' : declared === 'env_var' || declared === 'env' ? 'env' : 'agent';
        const view: AuthMethodView = {
            id: method['id'],
            name: method['name'],
            type,
            ...(type === 'api-key' && provider ? { provider } : {}),
            ...(typeof method['description'] === 'string' && method['description'] ? { description: method['description'] } : {}),
        };
        const args = stringArray(method['args']) ?? stringArray(hint?.['args']);
        const env = stringRecord(method['env']) ?? stringRecord(hint?.['env']);
        const command = typeof hint?.['command'] === 'string' ? hint['command'] : undefined;
        specs.push({ view, ...(args ? { args } : {}), ...(env ? { env } : {}), ...(command ? { command } : {}) });
    }
    return specs;
}

/** JSON-RPC `-32000` is ACP's "authentication required"; some agents only say it in words. */
export function isAuthRequiredError(error: unknown): boolean {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === -32000) {
        return true;
    }
    const message = errorMessage(error);
    return /authenticat|not logged in|log ?in required|sign ?in required|please (log|sign) ?in|unauthori[sz]ed/i.test(message);
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
        return (error as { message: string }).message;
    }
    return String(error);
}

// ---- Prompts and files ------------------------------------------------------

/** An attachment after the main process resolved and read it. */
export type ResolvedAttachment =
    | { readonly kind: 'file'; readonly absolutePath: string; readonly relativePath: string; readonly text: string | null }
    | { readonly kind: 'selection'; readonly absolutePath: string; readonly relativePath: string; readonly startLine?: number; readonly endLine?: number; readonly text: string };

/** The label the transcript shows for an attachment, as the chat's composer writes it. */
export function attachmentLabel(attachment: { readonly kind: 'file' | 'selection'; readonly path: string; readonly startLine?: number; readonly endLine?: number }): string {
    return attachment.kind === 'selection' && attachment.startLine !== undefined
        ? `${attachment.path}:${attachment.startLine}-${attachment.endLine ?? attachment.startLine}`
        : attachment.path;
}

/**
 * The `session/prompt` content: the message, then each file as an embedded
 * text resource (when the agent accepts embedded context and the IDE could
 * read it) or a `resource_link`, then each selection as text naming its lines.
 */
export function buildPromptBlocks(text: string, attachments: readonly ResolvedAttachment[], embeddedContext: boolean): ContentBlock[] {
    const blocks: ContentBlock[] = [{ type: 'text', text }];
    for (const attachment of attachments) {
        const uri = pathToFileURL(attachment.absolutePath).href;
        if (attachment.kind === 'file') {
            if (embeddedContext && attachment.text !== null) {
                blocks.push({ type: 'resource', resource: { uri, text: attachment.text, mimeType: 'text/plain' } });
            } else {
                blocks.push({ type: 'resource_link', uri, name: path.basename(attachment.absolutePath) });
            }
            continue;
        }
        const lines = attachment.startLine !== undefined ? ` (lines ${attachment.startLine}-${attachment.endLine ?? attachment.startLine})` : '';
        blocks.push({ type: 'text', text: `Selection from ${attachment.absolutePath}${lines}:\n\`\`\`\n${attachment.text}\n\`\`\`` });
    }
    return blocks;
}

/** `fs/read_text_file`'s `line` (1-based) and `limit`. */
export function sliceLines(text: string, line?: number | null, limit?: number | null): string {
    if ((line === undefined || line === null) && (limit === undefined || limit === null)) {
        return text;
    }
    const lines = text.split('\n');
    const start = Math.max(0, (line ?? 1) - 1);
    const end = limit === undefined || limit === null ? lines.length : start + Math.max(0, limit);
    return lines.slice(start, end).join('\n');
}

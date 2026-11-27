/**
 * The Output panel (#174): its channels, how a log line finds its channel,
 * the secrets taken out of every line before it is kept, and the bounded
 * buffer each channel holds. Shared by the main process (which collects the
 * lines) and the renderer (which shows them). Pure, unit-tested in Node.
 */

export const OUTPUT_CHANNELS = [
    { id: 'ide', label: 'Code-XR IDE' },
    { id: 'core', label: 'Analysis core' },
    { id: 'python', label: 'Python environment' },
    { id: 'servers', label: 'Servers and tunnel' },
    // #21: the language servers (TypeScript, Python): start, stop, crashes, their own messages.
    { id: 'lsp', label: 'Language servers' },
    // #180: the debug adapters: what each session ran, how it ended, an adapter's errors.
    { id: 'debug', label: 'Debugger' },
    // #284: Source Control's remote operations (push, pull, fetch, sync): what git ran and answered.
    { id: 'git', label: 'Git' },
] as const;

export type OutputChannelId = (typeof OUTPUT_CHANNELS)[number]['id'];

export function isOutputChannel(value: unknown): value is OutputChannelId {
    return typeof value === 'string' && OUTPUT_CHANNELS.some((channel) => channel.id === value);
}

/** Lines each channel keeps; the oldest go first. */
export const MAX_OUTPUT_LINES = 5000;
/** A longer line is cut, so one runaway line cannot take the memory. */
export const MAX_LINE_LENGTH = 4000;

/**
 * The channel of a core log scope (`[PYTHON_ENV]`, `[SERVER]`...): the core
 * names its scopes by area, and these are the areas the panel separates.
 */
export function channelForScope(scope: string): OutputChannelId {
    const words = scope.toUpperCase().split(/[^A-Z0-9]+/);
    if (words.some((word) => word === 'PYTHON' || word.startsWith('VENV'))) {
        return 'python';
    }
    if (words.some((word) => SERVER_WORDS.has(word))) {
        return 'servers';
    }
    return 'core';
}

/** Words of a scope that put it in the servers channel (whole words: REPORT is not PORT). */
const SERVER_WORDS = new Set(['SERVER', 'SERVERS', 'SSE', 'REMOTE', 'TUNNEL', 'CLOUDFLARE', 'CLOUDFLARED', 'COLLABORATION', 'COLLAB', 'BROADCAST', 'SHARE', 'NETWORK', 'PORT']);

const REDACTED = '<redacted>';

const SECRET_PATTERNS: readonly [RegExp, string][] = [
    // cloudflared tunnel tokens and any "--token value" on a command line.
    [/(--(?:token|password|api-key|apikey|secret)[= ])\S+/gi, `$1${REDACTED}`],
    // key=value and "key": "value" pairs whose key names a secret.
    [/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|credential|session[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, `$1${REDACTED}`],
    // Authorization headers.
    [/(authorization:\s*(?:bearer|basic|token)\s+)\S+/gi, `$1${REDACTED}`],
    [/(\bbearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${REDACTED}`],
    // Well-known key shapes: Anthropic and OpenAI style keys, GitHub tokens, AWS access keys, Slack tokens.
    [/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{16,}/g, REDACTED],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
    [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
    // JSON Web Tokens (cloudflared's tunnel tokens are base64 JSON too, starting eyJ).
    [/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){0,2}/g, REDACTED],
    // Credentials inside URLs: https://user:password@host.
    [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`],
];

/** The line with anything that looks like a secret replaced by `<redacted>`. */
/**
 * A core message as plain text: the core writes VS Code's icon syntax
 * ("$(check) CodeXR re-analysis updated ..."), which the IDE does not draw.
 */
export function plainCoreText(message: string): string {
    return message.replace(/\$\([a-z0-9-]+(?:~[a-z]+)?\)\s*/gi, '').trim();
}

export function redactSecrets(line: string): string {
    let result = line;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
        result = result.replace(pattern, replacement);
    }
    return result;
}

/** Splits text into lines (any line ending), redacts and bounds each one. */
export function outputLines(text: string): string[] {
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    return lines.map((line) => {
        const clean = redactSecrets(line);
        return clean.length > MAX_LINE_LENGTH ? `${clean.slice(0, MAX_LINE_LENGTH)} … (${clean.length - MAX_LINE_LENGTH} more characters)` : clean;
    });
}

/** A channel's lines: at most `limit`, the oldest dropped first. */
export class OutputBuffer {
    private lines: string[] = [];
    private readonly limit: number;

    constructor(limit = MAX_OUTPUT_LINES) {
        this.limit = limit;
    }

    append(lines: readonly string[]): void {
        this.lines.push(...lines);
        if (this.lines.length > this.limit) {
            this.lines.splice(0, this.lines.length - this.limit);
        }
    }

    clear(): void {
        this.lines = [];
    }

    snapshot(): readonly string[] {
        return [...this.lines];
    }

    get size(): number {
        return this.lines.length;
    }
}

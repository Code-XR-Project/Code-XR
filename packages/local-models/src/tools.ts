import type { ToolDefinition } from './agentLoop.ts';

/**
 * The coding tools a local model gets (epic #310, LM2), as JSON Schemas, and
 * the pure pieces of their behaviour. Hosts implement them (the IDE through
 * ACP requests, the VS Code extension through its own APIs) with these names
 * and arguments, so a model behaves the same in both.
 */

export type WorkspaceToolName = 'read_file' | 'list_directory' | 'find_files' | 'search_text' | 'write_file' | 'edit_file' | 'run_command';

/** What a tool does, which decides whether it asks first. */
export type WorkspaceToolKind = 'read' | 'search' | 'edit' | 'execute';

export const WORKSPACE_TOOL_KINDS: Readonly<Record<WorkspaceToolName, WorkspaceToolKind>> = {
    read_file: 'read',
    list_directory: 'search',
    find_files: 'search',
    search_text: 'search',
    write_file: 'edit',
    edit_file: 'edit',
    run_command: 'execute',
};

const path = { type: 'string', description: 'A path relative to the project folder.' };

export const WORKSPACE_TOOLS: readonly ToolDefinition[] = [
    {
        name: 'read_file',
        description: 'Read a text file of the project. Lines are numbered in the answer. Use offset and limit for long files.',
        parameters: { type: 'object', properties: { path, offset: { type: 'integer', description: 'First line to read (1-based).' }, limit: { type: 'integer', description: 'How many lines to read (default 400).' } }, required: ['path'] },
    },
    {
        name: 'list_directory',
        description: 'List the files and folders in a folder of the project (folders end with /).',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'A folder relative to the project folder; empty for the project root.' } } },
    },
    {
        name: 'find_files',
        description: 'Find files by name with a glob pattern such as **/*.ts or src/**/test_*.py.',
        parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    },
    {
        name: 'search_text',
        description: 'Search the text of the project files. Returns file:line: text for each match.',
        parameters: { type: 'object', properties: { query: { type: 'string' }, regex: { type: 'boolean', description: 'Treat the query as a regular expression.' }, path: { type: 'string', description: 'Limit the search to this folder.' } }, required: ['query'] },
    },
    {
        name: 'write_file',
        description: 'Create a file, or replace a whole file, with the given content. Prefer edit_file for changes to an existing file.',
        parameters: { type: 'object', properties: { path, content: { type: 'string' } }, required: ['path', 'content'] },
    },
    {
        name: 'edit_file',
        description: 'Replace an exact piece of text in a file. old_string must appear exactly once (copy it from read_file without the line numbers), unless replace_all is true.',
        parameters: { type: 'object', properties: { path, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'] },
    },
    {
        name: 'run_command',
        description: 'Run a shell command in the project folder (build, tests, git status...). Returns its output and exit code.',
        parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer', description: 'Default 120, at most 600.' } }, required: ['command'] },
    },
];

export function isWorkspaceTool(name: string): name is WorkspaceToolName {
    return Object.prototype.hasOwnProperty.call(WORKSPACE_TOOL_KINDS, name);
}

/** A string argument, or an error naming it. */
export function stringArg(args: Record<string, unknown>, name: string, options: { optional?: boolean; allowEmpty?: boolean } = {}): string {
    const value = args[name];
    if (value === undefined || value === null) {
        if (options.optional) {
            return '';
        }
        throw new Error(`Missing argument: ${name}.`);
    }
    if (typeof value !== 'string') {
        throw new Error(`The argument ${name} must be a string.`);
    }
    if (!options.allowEmpty && !options.optional && value === '') {
        throw new Error(`The argument ${name} is empty.`);
    }
    return value;
}

export function intArg(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
    const value = args[name];
    const number = typeof value === 'string' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(number)));
}

/** The lines `offset..offset+limit-1` (1-based) of a text, numbered like `cat -n`. */
export function numberLines(text: string, offset = 1, limit = 400): string {
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    const start = Math.max(1, offset);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const width = String(start + slice.length).length;
    const body = slice.map((line, index) => `${String(start + index).padStart(width, ' ')}\t${line}`).join('\n');
    const rest = lines.length - (start - 1 + slice.length);
    return rest > 0 ? `${body}\n[${rest} more lines: read again with offset ${start + slice.length}]` : body;
}

/**
 * edit_file's replacement. Line endings of the file are kept: the model
 * always writes \n, so a CRLF file is matched and written with CRLF.
 */
export function applyEdit(content: string, oldString: string, newString: string, replaceAll: boolean): string {
    if (oldString === '') {
        throw new Error('old_string is empty: use write_file to create a file.');
    }
    const crlf = content.includes('\r\n');
    const toFile = (text: string): string => (crlf ? text.replace(/\r?\n/g, '\r\n') : text);
    const needle = toFile(oldString);
    const replacement = toFile(newString);
    const count = content.split(needle).length - 1;
    if (count === 0) {
        throw new Error('old_string was not found in the file. Read the file again and copy the text exactly, without the line numbers.');
    }
    if (count > 1 && !replaceAll) {
        throw new Error(`old_string appears ${count} times. Add more surrounding lines to make it unique, or set replace_all.`);
    }
    return replaceAll ? content.split(needle).join(replacement) : content.replace(needle, () => replacement);
}

/** A glob (`*`, `**`, `?`, `{a,b}`) as a regular expression over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
    let pattern = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!pattern.includes('/')) {
        pattern = `**/${pattern}`;
    }
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i] ?? '';
        if (char === '*') {
            if (pattern[i + 1] === '*') {
                const slash = pattern[i + 2] === '/';
                out += slash ? '(?:.*/)?' : '.*';
                i += slash ? 2 : 1;
            } else {
                out += '[^/]*';
            }
        } else if (char === '?') {
            out += '[^/]';
        } else if (char === '{') {
            const end = pattern.indexOf('}', i);
            if (end > i) {
                out += `(?:${pattern.slice(i + 1, end).split(',').map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
                i = end;
            } else {
                out += '\\{';
            }
        } else {
            out += /[.+^$()|[\]\\}]/.test(char) ? `\\${char}` : char;
        }
    }
    return new RegExp(`^${out}$`, 'i');
}

/** Folders never walked by find_files and search_text. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.next', '.turbo', '.cache', 'target', '.gradle', '.idea', '.vs']);

export interface SystemPromptInput {
    readonly agentName: string;
    readonly model: string;
    readonly cwd: string;
    readonly platform: string;
    readonly toolsEnabled: boolean;
    /** Names of extra tools (MCP), e.g. the Code-XR analysis. */
    readonly extraTools: readonly string[];
    /** The project's own instructions (AGENTS.md...), already trimmed. */
    readonly projectInstructions?: string;
}

/** The instructions a local model starts each turn with. */
export function buildSystemPrompt(input: SystemPromptInput): string {
    const lines = [
        `You are ${input.agentName}, a coding agent running on a local model (${input.model}) inside the Code-XR IDE.`,
        `You work in the project folder ${input.cwd} on ${input.platform}. Paths you pass to tools are relative to it.`,
        'Be concise. Answer in the language the user writes in. Use Markdown, with fenced code blocks for code.',
    ];
    if (input.toolsEnabled) {
        lines.push(
            'Use the tools to look at the project before answering questions about it; never guess file contents.',
            'To change code: read the file, then use edit_file with an exact old_string (or write_file for new files). The user reviews every change.',
            'Run commands with run_command only when they help (tests, builds, git status). Explain briefly what you are about to do.',
        );
        if (input.extraTools.some((name) => name.startsWith('code-xr__'))) {
            lines.push('The code-xr__ tools return Code-XR\'s analysis of this project (complexity, size, hotspots, dependencies, evolution): use them for questions about code quality, risk or structure.');
        }
    } else {
        lines.push('This model cannot call tools, so you cannot read or change files yourself: ask the user to paste what you need.');
    }
    if (input.projectInstructions) {
        lines.push('', 'Project instructions (from the project\'s AGENTS.md):', input.projectInstructions);
    }
    return lines.join('\n');
}

import { compileQuery } from '../../../shared/searchText.ts';
import { clip, numberArg, stringArg, type AgentTool, type ToolContext, type ToolWorkspace } from './toolTypes.ts';

/**
 * The read-only workspace tools (A7): they run without asking, because they
 * only read inside the open folder through Workspace's checks and the answer
 * stays on this machine until the model's next request.
 */

const READ_MAX_LINES = 400;
const SEARCH_MAX_RESULTS = 100;
const FIND_MAX_RESULTS = 200;

function needWorkspace(context: ToolContext): ToolWorkspace {
    if (!context.workspace) {
        throw new Error('No folder is open in the IDE, so there are no files to look at. Ask the person to open one.');
    }
    return context.workspace;
}

const normalizePath = (value: string | undefined): string => (value ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');

export const listDirectoryTool: AgentTool = {
    name: 'list_directory',
    title: 'List a folder',
    description: 'Lists the files and folders directly inside a folder of the open project. Use "" for the project root.',
    risk: 'read',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder path relative to the project root; "" for the root.' } }, required: ['path'] },
    preview: (args) => ({ summary: `list ${normalizePath(args['path'] as string | undefined) || 'the project root'}` }),
    async run(args, context) {
        const entries = await needWorkspace(context).listDirectory(normalizePath(stringArg(args, 'path', false)));
        if (entries.length === 0) {
            return '(empty folder)';
        }
        return clip(entries.map((entry) => `${entry.kind === 'directory' ? `${entry.name}/` : entry.name}${entry.ignored ? '  (git-ignored)' : ''}`).join('\n'));
    },
};

export const readFileTool: AgentTool = {
    name: 'read_file',
    title: 'Read a file',
    description: `Reads a text file of the open project, with line numbers. At most ${READ_MAX_LINES} lines per call: pass start_line/end_line to read further.`,
    risk: 'read',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File path relative to the project root.' },
            start_line: { type: 'integer', description: 'First line (1-based). Default 1.' },
            end_line: { type: 'integer', description: 'Last line, inclusive.' },
        },
        required: ['path'],
    },
    preview(args) {
        const start = args['start_line'];
        return { summary: `read ${normalizePath(args['path'] as string | undefined)}${start ? ` from line ${String(start)}` : ''}` };
    },
    async run(args, context) {
        const path = normalizePath(stringArg(args, 'path', true));
        const content = await needWorkspace(context).readFile(path);
        if (content.kind !== 'text') {
            return content.kind === 'binary' ? `${path} is a binary file (${content.size} bytes).` : `${path} is too large to read (${content.size} bytes).`;
        }
        const lines = content.text.split(/\r?\n/);
        const start = Math.max(1, numberArg(args, 'start_line') ?? 1);
        const end = Math.min(lines.length, numberArg(args, 'end_line') ?? start + READ_MAX_LINES - 1, start + READ_MAX_LINES - 1);
        if (start > lines.length) {
            return `${path} has only ${lines.length} lines.`;
        }
        const width = String(end).length;
        const body = lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(width)}  ${line}`).join('\n');
        const more = end < lines.length ? `\n(lines ${end + 1}-${lines.length} not shown)` : '';
        return clip(`${path} (lines ${start}-${end} of ${lines.length})\n${body}${more}`);
    },
};

export const findFilesTool: AgentTool = {
    name: 'find_files',
    title: 'Find files by name',
    description: 'Finds project files whose path contains the given text (case-insensitive), skipping git-ignored files.',
    risk: 'read',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Part of a file name or path, e.g. "router" or "src/api".' } }, required: ['query'] },
    preview: (args) => ({ summary: `find files matching "${String(args['query'] ?? '')}"` }),
    async run(args, context) {
        const query = (stringArg(args, 'query', true) ?? '').toLowerCase();
        const index = await needWorkspace(context).listFiles();
        const hits = index.files.filter((file) => file.toLowerCase().includes(query));
        if (hits.length === 0) {
            return `No file path contains "${query}".`;
        }
        const shown = hits.slice(0, FIND_MAX_RESULTS);
        return `${shown.join('\n')}${hits.length > shown.length ? `\n… and ${hits.length - shown.length} more` : ''}`;
    },
};

export const searchTextTool: AgentTool = {
    name: 'search_text',
    title: 'Search the code',
    description: `Searches the text of the project's files (git-ignored files skipped) and returns up to ${SEARCH_MAX_RESULTS} matching lines with their file and line number.`,
    risk: 'read',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Text to look for.' },
            is_regex: { type: 'boolean', description: 'Treat the query as a JavaScript regular expression.' },
            include: { type: 'string', description: 'Comma-separated globs to limit the files, e.g. "src, *.ts".' },
        },
        required: ['query'],
    },
    preview: (args) => ({ summary: `search for "${String(args['query'] ?? '')}"${args['include'] ? ` in ${String(args['include'])}` : ''}` }),
    async run(args, context) {
        const query = {
            pattern: stringArg(args, 'query', true) ?? '',
            isRegex: args['is_regex'] === true,
            matchCase: false,
            wholeWord: false,
            include: stringArg(args, 'include', false) ?? '',
            exclude: '',
        };
        const compiled = compileQuery(query);
        if ('error' in compiled) {
            throw new Error(compiled.error);
        }
        const lines: string[] = [];
        let total = 0;
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        context.signal.addEventListener('abort', abort, { once: true });
        try {
            await needWorkspace(context).search(query, compiled, (path, matches) => {
                for (const match of matches) {
                    total += 1;
                    if (lines.length < SEARCH_MAX_RESULTS) {
                        lines.push(`${path}:${match.line}: ${match.preview.trim()}`);
                    } else {
                        controller.abort();
                    }
                }
            }, controller.signal);
        } finally {
            context.signal.removeEventListener('abort', abort);
        }
        if (lines.length === 0) {
            return `No match for "${query.pattern}".`;
        }
        return clip(`${lines.join('\n')}${total > lines.length ? `\n… more matches not shown; narrow the query or use include.` : ''}`);
    },
};

export const WORKSPACE_TOOLS: readonly AgentTool[] = [listDirectoryTool, readFileTool, findFilesTool, searchTextTool];

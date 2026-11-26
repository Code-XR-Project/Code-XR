import { diffLines, matchLineEndings } from '../../../shared/lineDiff.ts';
import { stringArg, type AgentTool, type ToolWorkspace } from './toolTypes.ts';

/**
 * `propose_edit` (A8): the agent proposes a file change, the window shows it
 * as a diff, and only what the person accepts is written, by the window's own
 * save path (undo, and refusal when the file changed on disk meanwhile). The
 * tool itself never writes, so it needs no approval card.
 */

const MAX_FILE_CHARS = 2_000_000;
const MAX_EDITS = 50;

interface Replacement {
    readonly find: string;
    readonly replace: string;
}

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');

function parseEdits(raw: unknown): Replacement[] | undefined {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EDITS) {
        throw new Error(`"edits" must be a list of 1 to ${MAX_EDITS} {find, replace} objects.`);
    }
    return raw.map((item, index) => {
        const record = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        const find = record['find'];
        const replace = record['replace'];
        if (typeof find !== 'string' || !find || typeof replace !== 'string') {
            throw new Error(`Edit ${index + 1} needs a non-empty "find" and a "replace" string.`);
        }
        return { find, replace };
    });
}

/** Applies search/replace edits; each `find` must occur exactly once, so an edit can never land in the wrong place. */
export function applyReplacements(original: string, edits: readonly Replacement[]): string {
    const lf = original.replace(/\r\n/g, '\n');
    let text = lf;
    edits.forEach((edit, index) => {
        const find = edit.find.replace(/\r\n/g, '\n');
        const first = text.indexOf(find);
        if (first < 0) {
            throw new Error(`Edit ${index + 1}: the "find" text is not in the file. Read the file again and copy the lines exactly.`);
        }
        if (text.indexOf(find, first + 1) >= 0) {
            throw new Error(`Edit ${index + 1}: the "find" text occurs more than once. Include more surrounding lines.`);
        }
        text = `${text.slice(0, first)}${edit.replace.replace(/\r\n/g, '\n')}${text.slice(first + find.length)}`;
    });
    return text;
}

async function parentExists(workspace: ToolWorkspace, path: string): Promise<boolean> {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    try {
        await workspace.listDirectory(parent);
        return true;
    } catch {
        return false;
    }
}

export const proposeEditTool: AgentTool = {
    name: 'propose_edit',
    title: 'Propose a file change',
    description: 'Proposes a change to one file of the open project. The person reviews it as a diff and accepts or rejects each part; you get back what was applied. '
        + 'Prefer "edits" (exact find/replace pairs, each "find" copied from the file and unique in it); use "content" for a new file or a full rewrite. Read the file first.',
    risk: 'write',
    reviewsItself: true,
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'File path relative to the project root.' },
            summary: { type: 'string', description: 'One line on what the change does and why.' },
            edits: {
                type: 'array',
                description: 'Exact replacements, applied in order.',
                items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] },
            },
            content: { type: 'string', description: 'The whole new content of the file (new files, full rewrites).' },
        },
        required: ['path', 'summary'],
    },
    preview: (args) => ({ summary: `change ${normalizePath(String(args['path'] ?? ''))}` }),
    async run(args, context) {
        const workspace = context.workspace;
        if (!workspace) {
            throw new Error('No folder is open in the IDE, so there is nothing to edit.');
        }
        const path = normalizePath(stringArg(args, 'path', true) ?? '');
        const summary = (stringArg(args, 'summary', false) ?? '').slice(0, 300);
        const edits = parseEdits(args['edits']);
        const content = stringArg(args, 'content', false) ?? (args['content'] === '' ? '' : undefined);
        if ((edits === undefined) === (content === undefined)) {
            throw new Error('Pass either "edits" or "content", not both.');
        }
        let original = '';
        let originalMtimeMs: number | null = null;
        let isNew = false;
        try {
            const file = await workspace.readFile(path);
            if (file.kind !== 'text') {
                throw new Error(`${path} is ${file.kind === 'binary' ? 'a binary file' : 'too large'} and cannot be edited by an agent.`);
            }
            original = file.text;
            originalMtimeMs = file.mtimeMs;
        } catch (error) {
            if (edits || !/ENOENT|no such file|not found/i.test(error instanceof Error ? error.message : String(error))) {
                throw error;
            }
            if (!(await parentExists(workspace, path))) {
                throw new Error(`The folder for ${path} does not exist.`);
            }
            isNew = true;
        }
        const proposed = matchLineEndings(original, edits ? applyReplacements(original, edits) : (content ?? ''));
        if (proposed.length > MAX_FILE_CHARS) {
            throw new Error('The proposed file is too large.');
        }
        const total = diffLines(original, proposed).length;
        if (total === 0 && !isNew) {
            return `No change: ${path} already has that content.`;
        }
        const result = await context.reviewEdit({ path, original, originalMtimeMs, proposed, isNew, summary });
        const note = result.message ? ` ${result.message}` : '';
        switch (result.outcome) {
            case 'applied':
                return result.accepted === result.total
                    ? `Applied and saved: ${path} (${result.total} change${result.total === 1 ? '' : 's'}).${note}`
                    : `Partly applied to ${path}: the person accepted ${result.accepted} of ${result.total} changes and rejected the rest. Read the file again before further edits.${note}`;
            case 'rejected':
                return `The person rejected the change to ${path}.${note} Do not re-propose it unchanged; ask what they want instead.`;
            default:
                throw new Error(`The change to ${path} could not be saved:${note || ' unknown error.'}`);
        }
    },
};

export const EDIT_TOOLS: readonly AgentTool[] = [proposeEditTool];

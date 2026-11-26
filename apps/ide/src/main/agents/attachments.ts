import type { ToolWorkspace } from './tools/toolTypes.ts';

/** The most context one message may carry (A6): about 30k tokens. */
export const ATTACHMENT_BUDGET_CHARS = 120_000;
const MAX_ATTACHMENTS = 20;

export interface AttachmentContext {
    /** Prepended to the message sent to the model; '' when nothing was attached. */
    readonly text: string;
    /** Shown on the user turn. */
    readonly labels: readonly string[];
}

/**
 * Turns the renderer's attachments into context for the model. Files are read
 * here, through Workspace (so a path can never leave the folder), and only if
 * quick open lists them, which skips git-ignored ones. Everything shares one
 * budget; a file that does not fit is refused with a clear message instead of
 * being silently cut.
 */
export async function buildAttachmentContext(workspace: ToolWorkspace | null, raw: unknown): Promise<AttachmentContext> {
    if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
        return { text: '', labels: [] };
    }
    if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) {
        throw new Error(`Attach at most ${MAX_ATTACHMENTS} items.`);
    }
    if (!workspace) {
        throw new Error('Open a folder to attach files.');
    }
    const parts: string[] = [];
    const labels: string[] = [];
    let used = 0;
    let listed: ReadonlySet<string> | null = null;
    const add = (label: string, body: string, fence: string): void => {
        const block = `<context source="${label}">\n\`\`\`${fence}\n${body}\n\`\`\`\n</context>`;
        if (used + block.length > ATTACHMENT_BUDGET_CHARS) {
            throw new Error(`${label} does not fit: attachments are limited to about ${Math.round(ATTACHMENT_BUDGET_CHARS / 1000)}k characters per message.`);
        }
        used += block.length;
        parts.push(block);
        labels.push(label);
    };
    for (const item of raw as unknown[]) {
        if (!item || typeof item !== 'object') {
            throw new Error('Invalid attachment.');
        }
        const record = item as Record<string, unknown>;
        const path = typeof record['path'] === 'string' ? record['path'].replace(/\\/g, '/') : '';
        if (!path || path.length > 1000) {
            throw new Error('Invalid attachment path.');
        }
        if (record['kind'] === 'file') {
            listed ??= new Set((await workspace.listFiles()).files);
            if (!listed.has(path)) {
                throw new Error(`${path} is not a project file (it may be git-ignored).`);
            }
            const content = await workspace.readFile(path);
            if (content.kind !== 'text') {
                throw new Error(`${path} is ${content.kind === 'binary' ? 'a binary file' : 'too large'} and cannot be attached.`);
            }
            add(path, content.text, fenceFor(path));
        } else if (record['kind'] === 'selection') {
            const start = record['startLine'];
            const end = record['endLine'];
            const text = record['text'];
            if (typeof start !== 'number' || typeof end !== 'number' || typeof text !== 'string' || start < 1 || end < start) {
                throw new Error('Invalid selection.');
            }
            add(`${path}:${start}-${end}`, text, fenceFor(path));
        } else {
            throw new Error('Invalid attachment.');
        }
    }
    return { text: `${parts.join('\n\n')}\n\n`, labels };
}

function fenceFor(path: string): string {
    const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
    return /^[a-z0-9]{1,10}$/.test(extension) ? extension : '';
}

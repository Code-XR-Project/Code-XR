import type { DirEntry, FileContent, SearchMatch, SearchQuery } from '../../../shared/api.ts';
import type { EditReviewRequest, EditReviewResult, ToolInfo } from '../../../shared/agents.ts';
import type { CompiledQuery } from '../../../shared/searchText.ts';
import type { FileIndex } from '../../workspace/fileIndex.ts';
import type { SearchStats } from '../../workspace/textSearch.ts';

/**
 * The slice of a window's Workspace the agent tools use (A6, A7). Every path
 * goes through Workspace's own checks, so a tool can never leave the folder.
 */
export interface ToolWorkspace {
    /** The folder's absolute path (where commands run). */
    readonly root: string;
    listDirectory(relativePath: unknown): Promise<DirEntry[]>;
    readFile(relativePath: unknown): Promise<FileContent>;
    listFiles(): Promise<FileIndex>;
    search(query: SearchQuery, compiled: CompiledQuery, onFile: (path: string, matches: SearchMatch[], total: number) => void, signal: AbortSignal): Promise<SearchStats>;
}

export interface ToolContext {
    /** The folder open in the window, or null: workspace tools then explain that one is needed. */
    readonly workspace: ToolWorkspace | null;
    readonly signal: AbortSignal;
    /** Shows a proposed file change to the person and resolves with what they did (A8). */
    reviewEdit(request: Omit<EditReviewRequest, 'id' | 'sessionId'>): Promise<EditReviewResult>;
    /** Live output of a long tool (A9), shown in the chat while it runs. */
    progress?(text: string): void;
}

/** What a tool shows before it runs (risky tools) and in the chat. */
export interface ToolPreview {
    readonly summary: string;
    /** For an approval card: exactly what will happen. */
    readonly detail?: string;
}

export interface AgentTool extends ToolInfo {
    /** JSON Schema of the arguments, as the providers want it. */
    readonly parameters: Readonly<Record<string, unknown>>;
    /** The tool shows its own review (a diff) instead of the approval card. */
    readonly reviewsItself?: boolean;
    preview(args: Record<string, unknown>): ToolPreview;
    /** The result as text for the model; throws a readable Error on failure. */
    run(args: Record<string, unknown>, context: ToolContext): Promise<string>;
}

/** The longest tool result handed back to the model. */
export const MAX_TOOL_RESULT_CHARS = 40_000;

export function clip(text: string, max = MAX_TOOL_RESULT_CHARS): string {
    return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters cut)`;
}

export function stringArg(args: Record<string, unknown>, key: string, required: boolean): string | undefined {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
        if (required) {
            throw new Error(`Missing argument "${key}".`);
        }
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(`Argument "${key}" must be a string.`);
    }
    return value;
}

export function numberArg(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    if (value === undefined || value === null) {
        return undefined;
    }
    const number = typeof value === 'string' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) {
        throw new Error(`Argument "${key}" must be a number.`);
    }
    return Math.trunc(number);
}

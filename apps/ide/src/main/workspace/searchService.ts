import type { WebContents } from 'electron';
import { IPC_EVENTS, type ReplaceResult, type SearchDoneEvent, type SearchFileEvent, type SearchQuery } from '../../shared/api.ts';
import { compileQuery } from '../../shared/searchText.ts';
import type { Workspace } from './workspace.ts';

/**
 * One search at a time per window (#165). Results reach the renderer in
 * batches (every 100 ms or 100 files), so a search with thousands of hits does
 * not flood the IPC channel, and the first ones still show at once.
 */

const MAX_PATTERN = 2_000;
const MAX_GLOBS = 2_000;
const MAX_REPLACE_PATHS = 50_000;
const FLUSH_MS = 100;
const FLUSH_FILES = 100;

const running = new Map<number, { readonly searchId: number; readonly controller: AbortController }>();

/** Checks the shape of a query from the renderer; throws on anything else. */
export function parseSearchQuery(value: unknown): SearchQuery {
    if (typeof value !== 'object' || value === null) {
        throw new Error('Invalid search query.');
    }
    const record = value as Record<string, unknown>;
    const text = (key: string, max: number): string => {
        const field = record[key];
        if (typeof field !== 'string' || field.length > max) {
            throw new Error(`Invalid search query field "${key}".`);
        }
        return field;
    };
    const flag = (key: string): boolean => {
        if (typeof record[key] !== 'boolean') {
            throw new Error(`Invalid search query field "${key}".`);
        }
        return record[key] as boolean;
    };
    return {
        pattern: text('pattern', MAX_PATTERN),
        isRegex: flag('isRegex'),
        matchCase: flag('matchCase'),
        wholeWord: flag('wholeWord'),
        include: text('include', MAX_GLOBS),
        exclude: text('exclude', MAX_GLOBS),
    };
}

function parseSearchId(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error('Invalid search id.');
    }
    return value;
}

export function cancelSearch(contents: WebContents, searchId?: unknown): void {
    const current = running.get(contents.id);
    if (current && (searchId === undefined || current.searchId === parseSearchId(searchId))) {
        current.controller.abort();
        running.delete(contents.id);
    }
}

export async function startSearch(contents: WebContents, workspace: Workspace, rawId: unknown, rawQuery: unknown): Promise<void> {
    const searchId = parseSearchId(rawId);
    const query = parseSearchQuery(rawQuery);
    cancelSearch(contents);
    const send = (channel: string, payload: SearchFileEvent | SearchDoneEvent): void => {
        if (!contents.isDestroyed()) {
            contents.send(channel, payload);
        }
    };
    const compiled = compileQuery(query);
    if ('error' in compiled) {
        send(IPC_EVENTS.workspaceSearchDone, { searchId, files: 0, matches: 0, limitHit: false, cancelled: false, error: compiled.error });
        return;
    }
    const controller = new AbortController();
    running.set(contents.id, { searchId, controller });
    let pending: SearchFileEvent[] = [];
    let lastFlush = Date.now();
    const flush = (): void => {
        for (const event of pending) {
            send(IPC_EVENTS.workspaceSearchResult, event);
        }
        pending = [];
        lastFlush = Date.now();
    };
    try {
        const stats = await workspace.search(query, compiled, (path, matches, total) => {
            if (controller.signal.aborted) {
                return;
            }
            pending.push({ searchId, path, matches, total });
            if (pending.length >= FLUSH_FILES || Date.now() - lastFlush >= FLUSH_MS) {
                flush();
            }
        }, controller.signal);
        if (!controller.signal.aborted) {
            flush();
        }
        send(IPC_EVENTS.workspaceSearchDone, { searchId, ...stats, cancelled: controller.signal.aborted });
    } catch (error) {
        send(IPC_EVENTS.workspaceSearchDone, { searchId, files: 0, matches: 0, limitHit: false, cancelled: false, error: String(error) });
    } finally {
        if (running.get(contents.id)?.controller === controller) {
            running.delete(contents.id);
        }
    }
}

export async function replaceInFiles(workspace: Workspace, rawQuery: unknown, rawReplacement: unknown, rawPaths: unknown): Promise<ReplaceResult> {
    const query = parseSearchQuery(rawQuery);
    if (typeof rawReplacement !== 'string' || rawReplacement.length > MAX_PATTERN) {
        throw new Error('Invalid replacement.');
    }
    if (!Array.isArray(rawPaths) || rawPaths.length > MAX_REPLACE_PATHS || !rawPaths.every((entry) => typeof entry === 'string')) {
        throw new Error('Invalid list of files to replace in.');
    }
    const compiled = compileQuery(query);
    if ('error' in compiled) {
        throw new Error(compiled.error);
    }
    return workspace.replaceInFiles(query, compiled, rawReplacement, rawPaths as string[]);
}

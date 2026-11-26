/**
 * The editor tabs (#167) as data: which tabs a group close takes, the one
 * question asked before discarding unsaved ones, cycling, reordering, and the
 * saved session restored with the folder. Pure, unit-tested in Node.
 */

export type CloseKind = 'others' | 'right' | 'saved' | 'all';

export interface TabInfo {
    readonly path: string;
    readonly dirty: boolean;
}

/** The tabs a group close takes, in tab order; `path` is the tab it was asked on. */
export function closeTargets(kind: CloseKind, tabs: readonly TabInfo[], path: string | null): string[] {
    const index = path === null ? -1 : tabs.findIndex((tab) => tab.path === path);
    switch (kind) {
        case 'others': return index < 0 ? [] : tabs.filter((tab) => tab.path !== path).map((tab) => tab.path);
        case 'right': return index < 0 ? [] : tabs.slice(index + 1).map((tab) => tab.path);
        case 'saved': return tabs.filter((tab) => !tab.dirty).map((tab) => tab.path);
        case 'all': return tabs.map((tab) => tab.path);
    }
}

const LISTED = 8;

/** The single question before closing `paths` drops unsaved changes, or null when none is unsaved. */
export function discardQuestion(paths: readonly string[], dirty: ReadonlySet<string>): string | null {
    const unsaved = paths.filter((path) => dirty.has(path));
    if (unsaved.length === 0) {
        return null;
    }
    if (unsaved.length === 1 && paths.length === 1) {
        return `${unsaved[0]} has unsaved changes. Close it and discard them?`;
    }
    const list = unsaved.slice(0, LISTED).join('\n') + (unsaved.length > LISTED ? `\n... and ${unsaved.length - LISTED} more` : '');
    const subject = unsaved.length === 1 ? 'This file has' : `These ${unsaved.length} files have`;
    return `${subject} unsaved changes:\n${list}\n\nClose ${paths.length === 1 ? 'it' : `the ${paths.length} tabs`} and discard them?`;
}

/** The tab `delta` steps from `path`, wrapping around (Ctrl+Tab, Ctrl+PageDown). */
export function cycleTab(order: readonly string[], path: string | null, delta: number): string | null {
    if (order.length === 0) {
        return null;
    }
    const index = path === null ? -1 : order.indexOf(path);
    if (index < 0) {
        return order[delta >= 0 ? 0 : order.length - 1] ?? null;
    }
    return order[(((index + delta) % order.length) + order.length) % order.length] ?? null;
}

/** `order` with `moved` placed before `before` (null: at the end). */
export function moveTab(order: readonly string[], moved: string, before: string | null): string[] {
    if (!order.includes(moved) || moved === before) {
        return [...order];
    }
    const rest = order.filter((path) => path !== moved);
    const index = before === null ? -1 : rest.indexOf(before);
    rest.splice(index < 0 ? rest.length : index, 0, moved);
    return rest;
}

/** Where a session is kept: one per folder. */
export function sessionKey(root: string): string {
    return `codexr.tabs:${root}`;
}

const SESSION_VERSION = 1;
/** More tabs than this are not restored (a session is for picking up where you left). */
export const MAX_RESTORED_TABS = 50;

export interface SavedTab {
    readonly path: string;
    /** Monaco's view state (cursor, scroll, folding) as it serialises itself; opaque here. */
    readonly viewState: unknown;
}

export interface TabSession {
    readonly tabs: readonly SavedTab[];
    readonly active: string | null;
    readonly preview: string | null;
}

export const EMPTY_SESSION: TabSession = { tabs: [], active: null, preview: null };

const isPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 4096 && !value.startsWith('/') && !value.split('/').includes('..');

export function serializeSession(session: TabSession): string {
    return JSON.stringify({ version: SESSION_VERSION, ...session, tabs: session.tabs.slice(0, MAX_RESTORED_TABS) });
}

/** Reads a saved session; damaged entries are dropped, a damaged session is empty. */
export function parseSession(text: string | null): TabSession {
    if (!text) {
        return EMPTY_SESSION;
    }
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return EMPTY_SESSION;
    }
    if (typeof data !== 'object' || data === null || (data as { version?: unknown }).version !== SESSION_VERSION) {
        return EMPTY_SESSION;
    }
    const raw = data as { tabs?: unknown; active?: unknown; preview?: unknown };
    const seen = new Set<string>();
    const tabs: SavedTab[] = [];
    for (const entry of Array.isArray(raw.tabs) ? raw.tabs : []) {
        const path = (entry as { path?: unknown } | null)?.path;
        if (isPath(path) && !seen.has(path) && tabs.length < MAX_RESTORED_TABS) {
            seen.add(path);
            const viewState = (entry as { viewState?: unknown }).viewState;
            tabs.push({ path, viewState: typeof viewState === 'object' ? viewState : null });
        }
    }
    const pick = (value: unknown): string | null => (isPath(value) && seen.has(value) ? value : null);
    return { tabs, active: pick(raw.active), preview: pick(raw.preview) };
}

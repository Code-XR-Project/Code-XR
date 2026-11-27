/**
 * The review base of a chat session (AF5, #270): which checkpoint each file's
 * pending changes are measured against. Pure data, no git, so the session store
 * can persist it as JSON and the tests need no repository.
 *
 * The model is one session-wide base checkpoint plus per-file overrides:
 *
 * - When a session starts reviewing, its base is a snapshot of the tree
 *   (`createReviewBase`). Pending changes are `changes(baseId)`.
 * - "Keep" on one file: the caller takes a fresh snapshot and records it as
 *   that file's own base (`keepFile`). The file then shows as pending again
 *   only if it changes after the keep.
 * - "Keep all": a fresh snapshot becomes the session base and the overrides go
 *   (`keepAll`).
 * - "Undo" on one file restores it from `baseFor(state, path)`; the base does
 *   not move, so the file simply stops differing.
 *
 * With overrides, the pending list is assembled per base: query
 * `changes(base)` for every id in `basesToQuery(state)`, then keep, from each
 * result, only the files whose own base is that id (`mergePendingChanges`).
 */

export interface ReviewBaseState {
    /** The checkpoint every file is compared against unless it has its own. */
    readonly baseId: string;
    /** Per-file bases (posix project-relative path → checkpoint id), set by "Keep" on one file. */
    readonly fileBases: Readonly<Record<string, string>>;
}

export function createReviewBase(baseId: string): ReviewBaseState {
    return { baseId, fileBases: {} };
}

/** The checkpoint `filePath` is compared against. */
export function baseFor(state: ReviewBaseState, filePath: string): string {
    return Object.hasOwn(state.fileBases, filePath) ? state.fileBases[filePath] ?? state.baseId : state.baseId;
}

/** "Keep" one file: from now on it is compared against `checkpointId` (a snapshot taken at the keep). */
export function keepFile(state: ReviewBaseState, filePath: string, checkpointId: string): ReviewBaseState {
    if (checkpointId === state.baseId) {
        const { [filePath]: _removed, ...rest } = state.fileBases;
        return { baseId: state.baseId, fileBases: rest };
    }
    return { baseId: state.baseId, fileBases: { ...state.fileBases, [filePath]: checkpointId } };
}

/** "Keep" several files against the same new snapshot. */
export function keepFiles(state: ReviewBaseState, filePaths: readonly string[], checkpointId: string): ReviewBaseState {
    return filePaths.reduce((current, filePath) => keepFile(current, filePath, checkpointId), state);
}

/** "Keep all": `checkpointId` becomes the base of every file. */
export function keepAll(_state: ReviewBaseState, checkpointId: string): ReviewBaseState {
    return createReviewBase(checkpointId);
}

/** Every checkpoint id `changes()` must be asked about, the session base first. */
export function basesToQuery(state: ReviewBaseState): string[] {
    return [...new Set([state.baseId, ...Object.values(state.fileBases)])];
}

/** All checkpoint ids the state refers to (what a pruning pass must keep). */
export function referencedCheckpoints(state: ReviewBaseState): string[] {
    return basesToQuery(state);
}

/**
 * Assembles the pending list from `changes(base)` per base: each file comes
 * from the result of its own base, and the list is sorted by path.
 */
export function mergePendingChanges<T extends { readonly path: string }>(state: ReviewBaseState, changesByBase: ReadonlyMap<string, readonly T[]>): T[] {
    const pending: T[] = [];
    for (const [base, changes] of changesByBase) {
        for (const change of changes) {
            if (baseFor(state, change.path) === base) {
                pending.push(change);
            }
        }
    }
    return pending.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function serializeReviewBase(state: ReviewBaseState): string {
    return JSON.stringify({ baseId: state.baseId, fileBases: state.fileBases });
}

/** Reads a persisted state back; returns null for anything malformed rather than trusting it. */
export function parseReviewBase(value: unknown): ReviewBaseState | null {
    let data = value;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data) as unknown;
        } catch {
            return null;
        }
    }
    if (typeof data !== 'object' || data === null) {
        return null;
    }
    const { baseId, fileBases } = data as { baseId?: unknown; fileBases?: unknown };
    if (typeof baseId !== 'string' || baseId === '') {
        return null;
    }
    const bases: Record<string, string> = {};
    if (fileBases !== undefined) {
        if (typeof fileBases !== 'object' || fileBases === null || Array.isArray(fileBases)) {
            return null;
        }
        for (const [filePath, id] of Object.entries(fileBases)) {
            if (typeof id !== 'string' || id === '') {
                return null;
            }
            if (id !== baseId) {
                bases[filePath] = id;
            }
        }
    }
    return { baseId, fileBases: bases };
}

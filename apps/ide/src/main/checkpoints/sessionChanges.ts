import path from 'node:path';
import { CheckpointStore, normalizeProjectPath, type ChangedFile, type CheckpointStoreOptions, type DiffText } from './checkpointStore.ts';
import {
    baseFor, basesToQuery, createReviewBase, keepAll, keepFiles, mergePendingChanges, parseReviewBase, type ReviewBaseState,
} from './reviewBase.ts';

/**
 * The review of a chat's changes (AF5, #270) and its checkpoints per turn
 * (AF6, #271), on top of `CheckpointStore` (the snapshots) and `reviewBase`
 * (what each file is compared against):
 *
 * - `beforePrompt` snapshots the project before every message; the chat's
 *   first snapshot becomes its review base, so "pending" means "changed since
 *   this chat started, and not kept or undone since".
 * - `pending` lists those files; `diff` gives the two sides of one of them.
 * - `keep` accepts files as they are (a fresh snapshot becomes their base);
 *   `undo` writes them back from their base, after which they no longer differ.
 * - `previewRestore` / `restoreCheckpoint` put the whole project back as it
 *   was before one message (the conversation is not touched).
 *
 * One `CheckpointStore` per project root, its shadow repositories under
 * `storageDir` (outside every project); the review base of each chat is
 * persisted in `bases`. A project whose checkpoints are off (too many files, a
 * timeout, no git) degrades to "no checkpoint": `beforePrompt` returns null and
 * `pending` reports the reason. No Electron, so it is unit-tested on temp
 * folders.
 */

export interface ReviewBaseStore {
    get<T>(key: string): T | undefined;
    /** undefined removes the key. */
    update(key: string, value: unknown): Promise<void>;
}

export interface SessionChangesOptions {
    /** Where the shadow repositories live (userData/checkpoints). */
    readonly storageDir: string;
    /** The persisted review bases, keyed by chat id. */
    readonly bases: ReviewBaseStore;
    /** Extra options for each store (git executable, limits, timeout); tests use them. */
    readonly store?: Omit<CheckpointStoreOptions, 'storageDir' | 'projectRoot'>;
}

export interface PendingChanges {
    readonly files: readonly ChangedFile[];
    readonly disabledReason: string | null;
}

const CHECKPOINT_ID = /^[0-9a-f]{40,64}$/;

export class SessionChanges {
    private readonly options: SessionChangesOptions;
    private readonly stores = new Map<string, CheckpointStore>();

    constructor(options: SessionChangesOptions) {
        this.options = options;
    }

    /** The store of a project, created on first use. */
    storeFor(root: string): CheckpointStore {
        const key = path.resolve(root);
        let store = this.stores.get(key);
        if (!store) {
            store = new CheckpointStore({ ...this.options.store, storageDir: this.options.storageDir, projectRoot: key });
            this.stores.set(key, store);
        }
        return store;
    }

    /** The chat's review base, or null before its first checkpoint. */
    reviewBase(sessionId: string): ReviewBaseState | null {
        return parseReviewBase(this.options.bases.get<unknown>(sessionId));
    }

    /**
     * Snapshots the project before a message. The chat's first snapshot is
     * its review base. Null when checkpoints are off for the project.
     */
    async beforePrompt(sessionId: string, root: string, label = 'Before a message'): Promise<{ readonly checkpointId: string } | null> {
        const checkpoint = await this.storeFor(root).snapshot(label);
        if (!checkpoint) {
            return null;
        }
        if (!this.reviewBase(sessionId)) {
            await this.saveBase(sessionId, createReviewBase(checkpoint.id));
        }
        return { checkpointId: checkpoint.id };
    }

    /** How many files await review after a turn; null when the chat has no review base or checkpoints are off. */
    async afterTurn(sessionId: string, root: string): Promise<number | null> {
        if (!this.reviewBase(sessionId)) {
            return null;
        }
        const pending = await this.pending(sessionId, root);
        return pending.disabledReason !== null ? null : pending.files.length;
    }

    /** The files the chat changed that still await review, sorted by path. */
    async pending(sessionId: string, root: string): Promise<PendingChanges> {
        const store = this.storeFor(root);
        const state = this.reviewBase(sessionId);
        if (store.disabledReason !== null) {
            return { files: [], disabledReason: store.disabledReason };
        }
        if (!state) {
            return { files: [], disabledReason: null };
        }
        const byBase = new Map<string, readonly ChangedFile[]>();
        for (const base of basesToQuery(state)) {
            byBase.set(base, await store.changes(base));
        }
        return { files: mergePendingChanges(state, byBase), disabledReason: null };
    }

    /** The files the project has changed since a checkpoint (all of them, not only the pending ones). */
    async changedSince(root: string, checkpointId: string): Promise<string[]> {
        const store = this.storeFor(root);
        if (store.disabledReason !== null) {
            return [];
        }
        return (await store.changes(checkCheckpointId(checkpointId))).map((change) => change.path);
    }

    /** One file at its review base and on disk now. */
    async diff(sessionId: string, root: string, filePath: string): Promise<DiffText> {
        const relative = normalizeProjectPath(filePath);
        const state = this.requireBase(sessionId);
        return this.storeFor(root).diffText(baseFor(state, relative), relative);
    }

    /** Accepts files as they are now: a fresh snapshot becomes their base ("all": every file's). */
    async keep(sessionId: string, root: string, paths: readonly string[] | 'all'): Promise<void> {
        const state = this.requireBase(sessionId);
        const store = this.storeFor(root);
        const checkpoint = await store.snapshot('Kept changes');
        if (!checkpoint) {
            throw new Error(`Checkpoints are off for this project: ${store.disabledReason ?? 'unknown reason'}.`);
        }
        const next = paths === 'all' ? keepAll(state, checkpoint.id) : keepFiles(state, [...new Set(paths.map(normalizeProjectPath))], checkpoint.id);
        await this.saveBase(sessionId, next);
    }

    /** Writes files back as they were at their base ("all": every pending file). Returns the paths written. */
    async undo(sessionId: string, root: string, paths: readonly string[] | 'all'): Promise<string[]> {
        const state = this.requireBase(sessionId);
        const store = this.storeFor(root);
        const targets = paths === 'all' ? (await this.pending(sessionId, root)).files.map((file) => file.path) : [...new Set(paths.map(normalizeProjectPath))];
        const groups = new Map<string, string[]>();
        for (const target of targets) {
            const base = baseFor(state, target);
            groups.set(base, [...(groups.get(base) ?? []), target]);
        }
        for (const [base, group] of groups) {
            await store.restoreFiles(base, group);
        }
        return targets;
    }

    /** What `restoreCheckpoint` would write. */
    previewRestore(root: string, checkpointId: string): Promise<string[]> {
        return this.storeFor(root).previewRestore(checkCheckpointId(checkpointId));
    }

    /** Puts every snapshotted file back as it was at the checkpoint; returns the paths written. */
    restoreCheckpoint(root: string, checkpointId: string): Promise<string[]> {
        return this.storeFor(root).restoreAll(checkCheckpointId(checkpointId));
    }

    /** A chat was deleted: its review base goes (the snapshots stay in the shadow repository). */
    async forget(sessionId: string): Promise<void> {
        if (this.options.bases.get<unknown>(sessionId) !== undefined) {
            await this.options.bases.update(sessionId, undefined);
        }
    }

    async dispose(): Promise<void> {
        await Promise.all([...this.stores.values()].map((store) => store.dispose()));
        this.stores.clear();
    }

    private requireBase(sessionId: string): ReviewBaseState {
        const state = this.reviewBase(sessionId);
        if (!state) {
            throw new Error('This chat has no checkpoint to compare with yet.');
        }
        return state;
    }

    private saveBase(sessionId: string, state: ReviewBaseState): Promise<void> {
        return this.options.bases.update(sessionId, { baseId: state.baseId, fileBases: state.fileBases });
    }
}

function checkCheckpointId(value: string): string {
    if (!CHECKPOINT_ID.test(value)) {
        throw new Error('Invalid checkpoint.');
    }
    return value;
}

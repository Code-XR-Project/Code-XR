/**
 * Writes the planned blobs of one revision into its snapshot folder (#106,
 * EVO-8). Contents come through one `git cat-file --batch` process per
 * revision instead of one `git show` per file, and every blob is read from
 * Git and written to disk once per service: later copies, in this revision
 * or in another frame, are hard links to the first one.
 */
import * as fs from 'fs';
import * as path from 'path';
import { GitBatchObjectReader } from './gitBatchObjectReader';
import { MAX_SNAPSHOT_BYTES, PlannedSnapshotFile } from './gitSnapshotPlan';

/** Blob contents of one revision; disposed when the revision is written. */
export interface GitBlobSource {
    read(blobSha: string): Promise<Buffer>;
    dispose(force?: boolean): Promise<void>;
}

/** Blobs read and written at once while a revision is copied. */
const WRITE_CONCURRENCY = 16;

/** The persistent cat-file reader as a GitBlobSource. */
export function openBatchBlobSource(repositoryRoot: string): GitBlobSource {
    const reader = new GitBatchObjectReader(repositoryRoot);
    return {
        async read(blobSha: string): Promise<Buffer> {
            const object = await reader.readObject(blobSha);
            if (object.objectType !== 'blob') {
                throw new Error(`git-object-is-not-blob: ${blobSha}`);
            }
            return object.content;
        },
        dispose: (force?: boolean) => reader.dispose(force),
    };
}

/** Hard link `existing` at `destination`; a plain copy where links are not available (FAT, some shares, the link limit). */
async function linkOrCopy(existing: string, destination: string): Promise<void> {
    try {
        await fs.promises.link(existing, destination);
    } catch {
        await fs.promises.copyFile(existing, destination);
    }
}

/**
 * Content-addressed copies of the blobs a service has already written, kept
 * next to its snapshots and removed with them on dispose. Snapshots link to
 * these files, so a blob that is still in a live snapshot costs no extra
 * space; the budget bounds what released snapshots leave behind. Past it, a
 * new blob is written straight into its snapshot, as before.
 */
export class GitSnapshotBlobStore {
    private readonly stored = new Map<string, Promise<string>>();
    private storedBytes = 0;

    public constructor(
        private readonly root: string,
        private readonly budgetBytes = MAX_SNAPSHOT_BYTES,
    ) {}

    /** Number of distinct blobs read from Git so far (for tests and measurements). */
    public get size(): number {
        return this.stored.size;
    }

    public async place(
        file: PlannedSnapshotFile,
        destination: string,
        read: (blobSha: string) => Promise<Buffer>,
    ): Promise<void> {
        let storedPath = this.stored.get(file.blobSha);
        if (!storedPath) {
            if (this.storedBytes + file.size > this.budgetBytes) {
                await fs.promises.writeFile(destination, await read(file.blobSha));
                return;
            }
            storedPath = this.store(file, read);
            this.stored.set(file.blobSha, storedPath);
        }
        await linkOrCopy(await storedPath, destination);
    }

    private async store(file: PlannedSnapshotFile, read: (blobSha: string) => Promise<Buffer>): Promise<string> {
        this.storedBytes += file.size;
        const storedPath = path.join(this.root, file.blobSha);
        try {
            const content = await read(file.blobSha);
            await fs.promises.mkdir(this.root, { recursive: true });
            await fs.promises.writeFile(storedPath, content);
            return storedPath;
        } catch (error) {
            // A cancelled or failed read is not a property of the blob: the
            // next revision that needs it tries again.
            this.stored.delete(file.blobSha);
            this.storedBytes -= file.size;
            throw error;
        }
    }
}

/**
 * Writes `files` under `sourceDirectory` at their repository paths. The
 * caller's plan already rejected empty and escaping paths; `assertInside`
 * still guards every destination. Cancelling `signal` stops the reader.
 */
export async function writeSnapshotFiles(options: {
    files: PlannedSnapshotFile[];
    sourceDirectory: string;
    store: GitSnapshotBlobStore;
    openSource: () => GitBlobSource;
    assertInside: (root: string, candidate: string) => void;
    signal?: AbortSignal;
}): Promise<void> {
    const { files, sourceDirectory, store, signal } = options;
    let source: GitBlobSource | null = null;
    const read = (blobSha: string): Promise<Buffer> => {
        source ??= options.openSource();
        return source.read(blobSha);
    };
    const onAbort = (): void => {
        void source?.dispose(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const directories = new Map<string, Promise<unknown>>();
    let next = 0;
    try {
        await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, files.length) }, async () => {
            while (next < files.length) {
                if (signal?.aborted) {
                    throw new Error('git-command-cancelled');
                }
                const file = files[next];
                next += 1;
                const destination = path.join(sourceDirectory, ...file.repositoryPath.split('/'));
                options.assertInside(sourceDirectory, destination);
                const directory = path.dirname(destination);
                let created = directories.get(directory);
                if (!created) {
                    created = fs.promises.mkdir(directory, { recursive: true });
                    directories.set(directory, created);
                }
                await created;
                await store.place(file, destination, read);
            }
        }));
    } catch (error) {
        throw signal?.aborted ? new Error('git-command-cancelled') : error;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        await (source as GitBlobSource | null)?.dispose(signal?.aborted);
    }
}

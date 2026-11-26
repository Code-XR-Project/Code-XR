import * as childProcess from 'child_process';
import { PARTIAL_CLONE_MISSING_MESSAGE, gitOfflineEnvironment, isPartialCloneMissingObject } from './gitOfflineEnvironment';

export interface GitBatchObject {
    objectName: string;
    objectType: string;
    size: number;
    content: Buffer;
}

export interface GitBatchObjectMetadata {
    objectName: string;
    objectType: string;
    size: number;
}

interface PendingRequest<T> {
    spec: string;
    resolve: (value: T) => void;
    reject: (reason: Error) => void;
}

function gitBatchError(spec: string, detail: string): Error {
    return new Error(`git-object-unavailable (${spec}): ${detail}`);
}

/**
 * The answer for an object Git does not have. Newer Git versions answer a
 * missing promisor object instead of dying: `<oid> missing`, or a header
 * whose size is not a number (2.5x prints `BAD`, as `ls-tree -l` does, see
 * gitSnapshotPlan). Object ids here come from commits and trees Git already
 * read, so an id Git cannot find is a partial-clone gap, not a typo.
 */
function missingObjectError(spec: string, detail: string): Error {
    return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(spec)
        ? new Error(PARTIAL_CLONE_MISSING_MESSAGE)
        : gitBatchError(spec, detail);
}

const MISSING_ANSWER = /\s(?:missing|ambiguous)$|^[0-9a-f]+\s+\S+\s+(?!\d+$)\S+$/;

/**
 * One persistent `git cat-file` process that survives a partial clone
 * (EVO-10, #105).
 *
 * With `GIT_NO_LAZY_FETCH`, Git 2.43 (the Ubuntu 24.04 default) does not
 * answer a missing promisor object with a `missing` line: it dies with
 * `fatal: could not fetch … from promisor remote` (exit 128). Git answers
 * requests strictly in order and flushes every answer, so the request at the
 * head of the queue when the process dies is the one that killed it. That
 * request alone is rejected as "not on this computer"; a fresh process is
 * started and the requests still queued behind it are sent again. Every
 * restart consumes one request, so it cannot loop. Newer Git versions that
 * print a `missing` line never take this path.
 */
abstract class GitCatFileProcess<T> {
    protected readonly pending: Array<PendingRequest<T>> = [];
    protected buffered = Buffer.alloc(0);
    private child: childProcess.ChildProcessWithoutNullStreams | null = null;
    private terminalError: Error | undefined;
    private disposed = false;

    protected constructor(
        private readonly repositoryRoot: string,
        private readonly batchArgument: string,
        private readonly label: string,
    ) {
        this.start();
    }

    protected request(spec: string): Promise<T> {
        if (this.terminalError) {
            return Promise.reject(this.terminalError);
        }
        if (this.disposed) {
            return Promise.reject(new Error(`${this.label}-reader-disposed`));
        }
        if (!this.child) {
            this.start();
        }
        return new Promise<T>((resolve, reject) => {
            this.pending.push({ spec, resolve, reject });
            this.child?.stdin.write(`${spec}\n`, 'utf8');
        });
    }

    public async dispose(force = false): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const child = this.child;
        if (force) {
            this.failAll(new Error(`${this.label}-cancelled`));
            child?.kill();
            return;
        }
        if (!child) {
            return;
        }
        child.stdin.end();
        if (child.exitCode !== null) {
            return;
        }
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                child.kill();
                resolve();
            }, 2_000);
            child.once('close', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    /** Resolve or reject as many queued requests as `buffered` allows. */
    protected abstract parseAvailableResponses(): void;

    /** Forget a half-read response; called when its process is replaced. */
    protected resetParser(): void {
        this.buffered = Buffer.alloc(0);
    }

    protected failAll(error: Error): void {
        this.terminalError = error;
        this.resetParser();
        while (this.pending.length) {
            this.pending.shift()?.reject(error);
        }
    }

    private start(): childProcess.ChildProcessWithoutNullStreams {
        const child = childProcess.spawn(
            'git',
            ['-C', this.repositoryRoot, 'cat-file', this.batchArgument],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: gitOfflineEnvironment() },
        );
        this.child = child;
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            if (child !== this.child) {
                return;
            }
            this.buffered = this.buffered.length
                ? Buffer.concat([this.buffered, chunk])
                : Buffer.from(chunk);
            this.parseAvailableResponses();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', (error) => {
            if (child === this.child && !this.disposed) {
                this.failAll(new Error(`${this.label}-start-failed: ${error.message}`));
            }
        });
        // A write to a process that just died fails with EPIPE; the `close`
        // handler below decides what that death means, so it is not fatal here.
        child.stdin.on('error', () => undefined);
        child.on('close', (code) => this.handleClose(child, code, stderr));
        return child;
    }

    private handleClose(
        child: childProcess.ChildProcessWithoutNullStreams,
        code: number | null,
        stderr: string,
    ): void {
        if (child !== this.child || this.disposed || this.terminalError) {
            return;
        }
        this.child = null;
        if (this.pending.length === 0 && code === 0) {
            return;
        }
        const partialClone = isPartialCloneMissingObject(stderr);
        if (partialClone && this.pending.length > 0) {
            this.skipMissingObjectAndRestart();
            return;
        }
        this.failAll(new Error(partialClone
            ? PARTIAL_CLONE_MISSING_MESSAGE
            : `${this.label}-closed (${String(code)}): ${stderr.trim() || 'no diagnostic'}`));
    }

    /** The head request killed the process: reject it, replay the rest. */
    private skipMissingObjectAndRestart(): void {
        this.pending.shift()?.reject(new Error(PARTIAL_CLONE_MISSING_MESSAGE));
        this.resetParser();
        if (this.pending.length === 0) {
            return;
        }
        const replacement = this.start();
        for (const request of this.pending) {
            replacement.stdin.write(`${request.spec}\n`, 'utf8');
        }
    }
}

/**
 * Persistent `git cat-file --batch` transport. Responses are framed by the
 * byte size announced in Git's header; no line-based content parsing is used,
 * so source files may contain arbitrary bytes and newline sequences.
 */
export class GitBatchObjectReader extends GitCatFileProcess<GitBatchObject> {
    private currentHeader: { objectName: string; objectType: string; size: number } | undefined;

    public constructor(repositoryRoot: string) {
        super(repositoryRoot, '--batch', 'git-cat-file');
    }

    public readObject(spec: string): Promise<GitBatchObject> {
        return this.request(spec);
    }

    protected resetParser(): void {
        super.resetParser();
        this.currentHeader = undefined;
    }

    protected parseAvailableResponses(): void {
        while (this.pending.length > 0) {
            if (!this.currentHeader) {
                const newline = this.buffered.indexOf(0x0a);
                if (newline < 0) {
                    return;
                }
                const header = this.buffered.subarray(0, newline).toString('utf8').trim();
                this.buffered = this.buffered.subarray(newline + 1);
                const request = this.pending[0];
                if (MISSING_ANSWER.test(header)) {
                    this.pending.shift();
                    request.reject(missingObjectError(request.spec, header));
                    continue;
                }
                const match = /^([0-9a-f]+)\s+(\S+)\s+(\d+)$/.exec(header);
                if (!match) {
                    this.failAll(gitBatchError(request.spec, `invalid header "${header}"`));
                    return;
                }
                this.currentHeader = {
                    objectName: match[1],
                    objectType: match[2],
                    size: Number(match[3]),
                };
            }

            const required = this.currentHeader.size + 1;
            if (this.buffered.length < required) {
                return;
            }
            const request = this.pending.shift() as PendingRequest<GitBatchObject>;
            const content = Buffer.from(this.buffered.subarray(0, this.currentHeader.size));
            const separator = this.buffered[this.currentHeader.size];
            this.buffered = this.buffered.subarray(required);
            const header = this.currentHeader;
            this.currentHeader = undefined;
            if (separator !== 0x0a) {
                request.reject(gitBatchError(request.spec, 'missing object separator'));
                continue;
            }
            request.resolve({ ...header, content });
        }
    }
}

/**
 * Size/type companion for the content reader. It keeps one
 * `--batch-check` process alive and makes limit validation cheap without
 * loading every blob into Node during the indexing phase.
 */
export class GitBatchMetadataReader extends GitCatFileProcess<GitBatchObjectMetadata> {
    public constructor(repositoryRoot: string) {
        super(repositoryRoot, '--batch-check=%(objectname) %(objecttype) %(objectsize)', 'git-cat-file-check');
    }

    public readMetadata(spec: string): Promise<GitBatchObjectMetadata> {
        return this.request(spec);
    }

    protected parseAvailableResponses(): void {
        let newline = this.buffered.indexOf(0x0a);
        while (newline >= 0 && this.pending.length > 0) {
            const line = this.buffered.subarray(0, newline).toString('utf8').trim();
            this.buffered = this.buffered.subarray(newline + 1);
            const request = this.pending.shift() as PendingRequest<GitBatchObjectMetadata>;
            if (MISSING_ANSWER.test(line)) {
                request.reject(missingObjectError(request.spec, line));
            } else {
                const match = /^([0-9a-f]+)\s+(\S+)\s+(\d+)$/.exec(line);
                if (!match) {
                    request.reject(gitBatchError(request.spec, `invalid metadata "${line}"`));
                } else {
                    request.resolve({
                        objectName: match[1],
                        objectType: match[2],
                        size: Number(match[3]),
                    });
                }
            }
            newline = this.buffered.indexOf(0x0a);
        }
    }
}

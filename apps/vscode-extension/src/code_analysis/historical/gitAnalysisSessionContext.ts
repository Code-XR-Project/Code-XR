import * as path from 'path';
import { UnifiedAnalysisSession } from '../engine/core/analysisSession';
import { GitAnalysisSourceCatalog } from './gitAnalysisEligibility';
import { GitRepositoryService } from './gitRepositoryService';

/** One analyzed revision as both Git services cache it. */
export interface CachedPayload {
    payload: Record<string, unknown>[];
    missingTarget: boolean;
    warnings: string[];
}

/**
 * What historical comparison and project evolution share about one analysis
 * session: the Git service, the source catalogue (owned or injected by the
 * host), the per-revision payload cache and the teardown.
 *
 * Composition, not a base class: each service still resolves its own session
 * (they admit different analysis modes), builds its own GitRepositoryService
 * over its own snapshot namespace, and answers availability and references
 * itself. It hands this object what it has resolved.
 */
export class GitAnalysisSessionContext {
    public readonly sourceCatalog: GitAnalysisSourceCatalog;
    public readonly cache = new Map<string, CachedPayload>();
    private readonly ownsSourceCatalog: boolean;

    public constructor(
        session: UnifiedAnalysisSession,
        public readonly gitService: GitRepositoryService,
        staticRoot: string,
        sourceCatalog?: GitAnalysisSourceCatalog,
    ) {
        this.ownsSourceCatalog = !sourceCatalog;
        this.sourceCatalog = sourceCatalog || new GitAnalysisSourceCatalog(
            session.targetType,
            session.isDeep === true,
            path.join(session.savedFilesPath || staticRoot, 'data.json'),
        );
    }

    /** Disposes the Git snapshots, the catalogue only when owned, and the cache. */
    public async dispose(): Promise<void> {
        await this.gitService.dispose();
        if (this.ownsSourceCatalog) {
            await this.sourceCatalog.dispose();
        }
        this.cache.clear();
    }
}

/**
 * At most one job at a time. A second start while one runs is refused with
 * the caller's busy code; the request of the last job that SUCCEEDED is kept
 * (a copy), so a failed run never replaces what the room is showing.
 */
export class SingleJobGate<TRequest extends object, TResult> {
    private activeJob: Promise<TResult> | null = null;
    private completedRequest: TRequest | null = null;

    public constructor(private readonly busyCode: string) {}

    public isBusy(): boolean {
        return this.activeJob !== null;
    }

    /** The request of the last successful job, or null. */
    public get lastRequest(): TRequest | null {
        return this.completedRequest;
    }

    public forgetLastRequest(): void {
        this.completedRequest = null;
    }

    public async run(request: TRequest, execute: () => Promise<TResult>): Promise<TResult> {
        if (this.activeJob) {
            throw new Error(this.busyCode);
        }
        const job = execute();
        this.activeJob = job;
        try {
            const result = await job;
            this.completedRequest = { ...request };
            return result;
        } finally {
            this.activeJob = null;
        }
    }
}

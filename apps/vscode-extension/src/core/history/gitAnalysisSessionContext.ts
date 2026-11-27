import * as fs from 'fs';
import * as path from 'path';
import { UnifiedAnalysisSession } from '../analysis/session/analysisSession';
import { ExecutePython } from '../analysis/python/executePython';
import { currentLaunchSignal, runWithLaunchSignal } from '../analysis/launch/launchControl';
import { withTimeout } from '../analysis/launch/jobRunner';
import {
    GitAnalysisSourceCatalog,
    GitAnalysisSourceError,
    isDeterministicNoDataError,
    validateGitAnalysisPayload,
} from './gitAnalysisEligibility';
import { buildAnalyzerCacheKey } from './gitAnalysisShared';
import { GitRepositoryService } from './gitRepositoryService';
import { ComparisonSource, GitAnalysisExclusionCode } from './historicalComparisonModels';
import type { CoreContext } from '../host/hostPaths';

/**
 * One revision's analysis longer than this is killed: in a movie the frame
 * is discarded, in a comparison the comparison fails with a clear message,
 * and in both the job is free again (EVO-3, HIST-7).
 */
export const REVISION_ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Analyzed revisions kept per session (least recently used dropped first).
 * Enough for a 96-frame movie; before, every regeneration over a different
 * range added to a cache nothing ever trimmed (EVO-8).
 */
export const MAX_CACHED_REVISIONS = 128;

/** One analyzed revision as both Git services cache it. */
export interface CachedPayload {
    payload: Record<string, unknown>[];
    missingTarget: boolean;
    warnings: string[];
}

/**
 * How one Git analysis mode analyzes a revision. The two modes differ only
 * in these values; everything else in analyzeSource is shared.
 */
export interface GitRevisionAnalysisPolicy {
    /** Namespaces the payload cache (each mode passes its own literal). */
    cacheVersion: string;
    /** The GitAnalysisSourceError code an excluded source is reported with. */
    errorCode: GitAnalysisSourceError['code'];
    /** Infix of the per-revision analyzer session id: `<id>-<infix>-<sha8>`. */
    sessionIdInfix: string;
    /** Metadata key the analyzed source travels under in that session. */
    metadataKey: string;
    /**
     * A revision without the analyzed target: 'throw' excludes it and fails
     * (a two-sided comparison against it is meaningless; nothing is cached),
     * 'cache-empty' caches an empty missingTarget payload (a movie survives
     * revisions where the target did not exist yet).
     */
    missingTarget: 'throw' | 'cache-empty';
    /** The mode's identity decoration of a usable payload. */
    decorate(
        payload: Record<string, unknown>[],
        session: UnifiedAnalysisSession,
        analyzedTargetPath: string,
    ): Record<string, unknown>[];
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
    /** Analyses running now, by cache key: one per commit, however many sources name it. */
    private readonly inFlight = new Map<string, Promise<CachedPayload>>();
    private readonly ownsSourceCatalog: boolean;
    /** Test seam: the per-revision watchdog. */
    public revisionTimeoutMs = REVISION_ANALYSIS_TIMEOUT_MS;

    public constructor(
        session: UnifiedAnalysisSession,
        public readonly gitService: GitRepositoryService,
        private readonly staticRoot: string,
        sourceCatalog: GitAnalysisSourceCatalog | undefined,
        private readonly extensionContext: CoreContext,
        private readonly policy: GitRevisionAnalysisPolicy,
    ) {
        this.ownsSourceCatalog = !sourceCatalog;
        this.sourceCatalog = sourceCatalog ?? new GitAnalysisSourceCatalog(
            session.targetType,
            session.isDeep === true,
            path.join(session.savedFilesPath || staticRoot, 'data.json'),
        );
    }

    /**
     * The decorated payload of one revision, analyzed once per commit (cached
     * by cacheVersion, commit and session shape); the working copy is re-read
     * from the live data.json every time. `session` is the CURRENT session,
     * resolved by the caller on every call.
     */
    public async analyzeSource(
        source: ComparisonSource,
        session: UnifiedAnalysisSession,
    ): Promise<CachedPayload> {
        if (source.kind === 'workingCopy') {
            return this.analyzeWorkingCopy(source, session);
        }

        const cacheKey = buildAnalyzerCacheKey(this.policy.cacheVersion, source.commitSha, session);
        const cached = this.cache.get(cacheKey);
        if (cached) {
            this.remember(cacheKey, cached);
            return cached;
        }

        // Two sources on one commit (a tag and its commit, picked together)
        // share one analysis: they share one snapshots/<sha> folder, and the
        // first release used to delete it under the second (EVO-2, #104).
        const pending = this.inFlight.get(cacheKey);
        if (pending) {
            return pending;
        }
        const run = this.analyzeAndRelease(source, session, cacheKey);
        this.inFlight.set(cacheKey, run);
        try {
            return await run;
        } finally {
            if (this.inFlight.get(cacheKey) === run) {
                this.inFlight.delete(cacheKey);
            }
        }
    }

    private async analyzeAndRelease(
        source: Extract<ComparisonSource, { kind: 'gitRef' }>,
        session: UnifiedAnalysisSession,
        cacheKey: string,
    ): Promise<CachedPayload> {
        try {
            return await this.analyzeRevision(source, session, cacheKey);
        } finally {
            // The snapshot is only the analyzer's input: once its payload is
            // cached it is dead weight (up to 100 MB per revision, EVO-8).
            // Released once per commit, after its only analysis has ended.
            await this.gitService.releaseSnapshot(source).catch(() => undefined);
        }
    }

    /** Keeps `key` as the most recently used entry and trims the oldest ones. */
    private remember(key: string, value: CachedPayload): void {
        this.cache.delete(key);
        this.cache.set(key, value);
        while (this.cache.size > MAX_CACHED_REVISIONS) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.cache.delete(oldest);
        }
    }

    private async analyzeRevision(
        source: Extract<ComparisonSource, { kind: 'gitRef' }>,
        session: UnifiedAnalysisSession,
        cacheKey: string,
    ): Promise<CachedPayload> {
        const materialized = await this.gitService.materialize(source, { recursive: session.isDeep !== false });
        if (!materialized.targetPath) {
            if (this.policy.missingTarget === 'throw') {
                throw this.excludeSource(
                    source,
                    'target-missing',
                    'The analyzed target does not exist in this revision.',
                );
            }
            const missing = {
                payload: [],
                missingTarget: true,
                warnings: materialized.warnings,
            };
            this.remember(cacheKey, missing);
            return missing;
        }

        const revisionSession: UnifiedAnalysisSession = {
            ...session,
            id: `${session.id}-${this.policy.sessionIdInfix}-${source.commitSha.slice(0, 8)}`,
            targetPath: materialized.targetPath,
            targetName: path.basename(materialized.targetPath),
            status: 'analyzing',
            startTime: new Date(),
            requiredFiles: new Map(),
            templatePaths: new Map(),
            metadata: { [this.policy.metadataKey]: source },
        };
        const analysisResult = await this.runRevisionAnalysis(source, revisionSession);
        const result = {
            payload: this.policy.decorate(
                this.requireUsablePayload(source, analysisResult),
                session,
                materialized.targetPath,
            ),
            missingTarget: false,
            warnings: materialized.warnings,
        };
        this.remember(cacheKey, result);
        return result;
    }

    /**
     * Runs one revision's Python analysis under the job's signal plus a
     * per-revision watchdog. A cancelled job's analysis is never classified
     * (nor cached) as a fact about the revision.
     */
    private async runRevisionAnalysis(
        source: ComparisonSource,
        revisionSession: UnifiedAnalysisSession,
    ): Promise<unknown> {
        let analysisResult: unknown;
        const jobSignal = currentLaunchSignal();
        const watchdog = withTimeout(jobSignal, this.revisionTimeoutMs, 'revision-timeout');
        try {
            analysisResult = await runWithLaunchSignal(
                watchdog.signal,
                // Silent: one VS Code notification per revision (up to 24,
                // four at a time) was noise; the room's progress bar is the
                // report (EVO-8).
                () => new ExecutePython(this.extensionContext).executeAnalysis(revisionSession, { silent: true }),
            );
        } catch (error) {
            if (jobSignal?.aborted) {
                // A killed analysis is not a fact about the revision: never
                // record it as a deterministic exclusion (EVO-2).
                throw new Error('revision-analysis-cancelled');
            }
            if (watchdog.signal.aborted) {
                throw new Error(
                    `revision-analysis-timeout: the analysis of "${source.label}" took more than `
                    + `${Math.round(this.revisionTimeoutMs / 1000)} s and was stopped.`,
                );
            }
            if (isDeterministicNoDataError(error)) {
                throw this.excludeSource(
                    source,
                    'invalid-payload',
                    'The analyzer did not produce a readable JSON payload.',
                );
            }
            throw error;
        } finally {
            watchdog.dispose();
        }
        if (jobSignal?.aborted) {
            // A cancelled job never caches what its last analysis returned.
            throw new Error('revision-analysis-cancelled');
        }
        return analysisResult;
    }

    /** The working copy is never cached: its data.json is the live analysis. */
    private async analyzeWorkingCopy(
        source: ComparisonSource,
        session: UnifiedAnalysisSession,
    ): Promise<CachedPayload> {
        const dataPath = path.join(session.savedFilesPath || this.staticRoot, 'data.json');
        let payload: unknown;
        try {
            payload = JSON.parse(await fs.promises.readFile(dataPath, 'utf8'));
        } catch {
            throw this.excludeSource(
                source,
                'invalid-payload',
                'The working copy data.json is missing or unreadable.',
            );
        }
        return {
            payload: this.policy.decorate(
                this.requireUsablePayload(source, payload),
                session,
                session.targetPath,
            ),
            missingTarget: false,
            warnings: [],
        };
    }

    /** The usable records of a payload; otherwise the source is excluded and this throws. */
    public requireUsablePayload(
        source: ComparisonSource,
        payload: unknown,
    ): Record<string, unknown>[] {
        const validation = validateGitAnalysisPayload(payload);
        if (!validation.usable) {
            throw this.excludeSource(
                source,
                validation.code || 'invalid-payload',
                validation.reason || 'The analysis produced no usable data.',
            );
        }
        return validation.entries;
    }

    /**
     * Records a deterministic exclusion in the shared catalogue (both pickers
     * then drop the source) and returns the error to throw.
     */
    public excludeSource(
        source: ComparisonSource,
        code: GitAnalysisExclusionCode,
        reason: string,
    ): GitAnalysisSourceError {
        const exclusion = this.sourceCatalog.recordDeterministicExclusion(
            source,
            code,
            reason,
        );
        return new GitAnalysisSourceError(
            this.policy.errorCode,
            `"${source.label}" was removed from Git analyses: ${reason}`,
            [exclusion],
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

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
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

/**
 * One revision's analysis longer than this is killed: in a movie the frame
 * is discarded, in a comparison the comparison fails with a clear message,
 * and in both the job is free again (EVO-3, HIST-7).
 */
export const REVISION_ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;

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
    private readonly ownsSourceCatalog: boolean;
    /** Test seam: the per-revision watchdog. */
    public revisionTimeoutMs = REVISION_ANALYSIS_TIMEOUT_MS;

    public constructor(
        session: UnifiedAnalysisSession,
        public readonly gitService: GitRepositoryService,
        private readonly staticRoot: string,
        sourceCatalog: GitAnalysisSourceCatalog | undefined,
        private readonly extensionContext: vscode.ExtensionContext,
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
            return cached;
        }

        const materialized = await this.gitService.materialize(source);
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
            this.cache.set(cacheKey, missing);
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
        this.cache.set(cacheKey, result);
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
                () => new ExecutePython(this.extensionContext).executeAnalysis(revisionSession),
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

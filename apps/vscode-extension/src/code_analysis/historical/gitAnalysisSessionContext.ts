import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { UnifiedAnalysisSession } from '../engine/core/analysisSession';
import { ExecutePython } from '../engine/utils/executePython';
import {
    GitAnalysisSourceCatalog,
    GitAnalysisSourceError,
    isDeterministicNoDataError,
    validateGitAnalysisPayload,
} from './gitAnalysisEligibility';
import { buildAnalyzerCacheKey } from './gitAnalysisShared';
import { GitRepositoryService } from './gitRepositoryService';
import { ComparisonSource, GitAnalysisExclusionCode } from './historicalComparisonModels';

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

    public constructor(
        session: UnifiedAnalysisSession,
        public readonly gitService: GitRepositoryService,
        private readonly staticRoot: string,
        sourceCatalog: GitAnalysisSourceCatalog | undefined,
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly policy: GitRevisionAnalysisPolicy,
    ) {
        this.ownsSourceCatalog = !sourceCatalog;
        this.sourceCatalog = sourceCatalog || new GitAnalysisSourceCatalog(
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
        let analysisResult: unknown;
        try {
            analysisResult = await new ExecutePython(this.extensionContext).executeAnalysis(revisionSession);
        } catch (error) {
            if (isDeterministicNoDataError(error)) {
                throw this.excludeSource(
                    source,
                    'invalid-payload',
                    'The analyzer did not produce a readable JSON payload.',
                );
            }
            throw error;
        }
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

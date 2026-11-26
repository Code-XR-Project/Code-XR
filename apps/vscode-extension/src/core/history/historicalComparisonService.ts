import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnalysisConfigurationStorage } from '../analysis/configuration/analysisConfigurationStorage';
import { UnifiedAnalysisSession } from '../analysis/session/analysisSession';
import { UnifiedSessionRegistry } from '../analysis/session/sessionRegistry';
import { decorateDirectoryEntries } from './gitAnalysisShared';
import { CachedPayload, GitAnalysisSessionContext } from './gitAnalysisSessionContext';
import { JobRunner, JobTicket } from '../analysis/launch/jobRunner';
import { GitRepositoryService } from './gitRepositoryService';
import { GitAnalysisSourceCatalog } from './gitAnalysisEligibility';
import {
    ComparisonDataset,
    ComparisonDeltaSummary,
    ComparisonSource,
    HistoricalComparisonProgress,
    HistoricalComparisonReferences,
    HistoricalComparisonRequest,
    HistoricalComparisonResult,
} from './historicalComparisonModels';
import { hostPathsFromContext, privateStorageRoot } from '../host/hostPaths';

const ANALYZER_CACHE_VERSION = 'historical-v1';

/** A comparison (two revisions) longer than this is cancelled and reported (HIST-7). */
export const HISTORICAL_COMPARISON_JOB_TIMEOUT_MS = 15 * 60 * 1000;

/** Comparison revision files kept on disk: the current one and the one before it (HIST-8). */
const KEPT_COMPARISON_REVISIONS = 2;

/**
 * A typed code and a sentence for the failures a user can act on (HIST-10).
 * Anything else returns null, and the caller reports it as it is.
 */
export function classifyHistoricalComparisonError(error: unknown): { code: string; message: string } | null {
    const raw = error instanceof Error ? error.message : String(error);
    if (/unknown-comparison-source|comparison-reference-not-found/.test(raw)) {
        return {
            code: 'comparison-reference-gone',
            message: 'A revision of this comparison no longer exists in the repository (a branch or tag was deleted or rewritten). Pick it again.',
        };
    }
    if (/comparison-snapshot-(?:file|size)-limit/.test(raw)) {
        return {
            code: 'comparison-snapshot-limit',
            message: 'A revision is too large to copy for analysis (more than 5,000 files or 100 MB).',
        };
    }
    if (/git-command-timeout|revision-analysis-timeout/.test(raw)) {
        return {
            code: 'comparison-step-timeout',
            message: 'A Git or analysis step took too long and was stopped.',
        };
    }
    return null;
}

/** One sentence for any comparison failure. */
export function describeHistoricalComparisonError(error: unknown): string {
    const known = classifyHistoricalComparisonError(error);
    if (known) {
        return known.message;
    }
    const raw = error instanceof Error ? error.message : String(error);
    return `The analysis failed (${raw}).`;
}

export class HistoricalComparisonService {
    private readonly gitService: GitRepositoryService;
    private readonly analysis: GitAnalysisSessionContext;
    private readonly jobs = new JobRunner<HistoricalComparisonRequest, HistoricalComparisonResult>({
        busyCode: 'comparison-busy',
        cancelledCode: 'comparison-cancelled',
        timeoutCode: 'comparison-timeout',
        timeoutMs: HISTORICAL_COMPARISON_JOB_TIMEOUT_MS,
    });
    private revision = 0;
    /** Set when the live link gave up after repeated failures (HIST-1); a new comparison clears it. */
    private liveRefreshSuspended = false;

    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly sessionId: string,
        private readonly staticRoot: string,
        sourceCatalog?: GitAnalysisSourceCatalog,
    ) {
        const session = this.getSession();
        const storageRoot = privateStorageRoot(hostPathsFromContext(context));
        const snapshotRoot = path.join(
            storageRoot,
            'historical-comparisons',
            sessionId,
            'snapshots',
        );
        this.gitService = new GitRepositoryService(session.targetPath, snapshotRoot);
        this.analysis = new GitAnalysisSessionContext(session, this.gitService, staticRoot, sourceCatalog, context, {
            cacheVersion: ANALYZER_CACHE_VERSION,
            errorCode: 'comparison-source-no-data',
            sessionIdInfix: 'comparison',
            metadataKey: 'comparisonSource',
            missingTarget: 'throw',
            decorate: (payload, current, analyzedTargetPath) => this.decoratePayload(payload, current, analyzedTargetPath),
        });
    }

    private get sourceCatalog(): GitAnalysisSourceCatalog {
        return this.analysis.sourceCatalog;
    }

    /** The request of the last successful comparison (what the room shows). */
    private get activeRequest(): HistoricalComparisonRequest | null {
        return this.jobs.lastRequest;
    }

    public async getReferences(): Promise<HistoricalComparisonReferences> {
        const references = await this.gitService.listReferences();
        const filtered = await this.sourceCatalog.filterSources({
            repositoryRoot: references.repositoryRoot,
            targetRelativePath: references.targetRelativePath,
            sources: references.sources,
        });
        return {
            ...references,
            sources: filtered.sources,
            eligibility: filtered.eligibility,
            activeRequest: this.activeRequest ? { ...this.activeRequest } : null,
            job: this.jobs.status,
        };
    }

    public getAvailability(): Promise<{ enabled: boolean; reason: string | null }> {
        return this.gitService.getAvailability(
            'The analyzed target is not inside a local Git repository.',
        );
    }

    /**
     * Takes the job slot synchronously (before the caller's first await), or
     * returns null when a comparison is already running (HIST-9).
     */
    public reserveComparison(request: HistoricalComparisonRequest): JobTicket<HistoricalComparisonResult> | null {
        return this.jobs.tryReserve(request);
    }

    /** Runs a reserved comparison. Rejects with comparison-cancelled/-timeout when stopped. */
    public runComparison(
        ticket: JobTicket<HistoricalComparisonResult>,
        request: HistoricalComparisonRequest,
        onProgress?: (progress: HistoricalComparisonProgress) => void,
    ): Promise<HistoricalComparisonResult> {
        const tagged = onProgress
            ? (progress: HistoricalComparisonProgress) => onProgress({ ...progress, jobId: ticket.id })
            : undefined;
        return ticket.execute(async () => {
            const result = await this.executeComparison(request, tagged);
            this.liveRefreshSuspended = false;
            return result;
        });
    }

    public compare(
        request: HistoricalComparisonRequest,
        onProgress?: (progress: HistoricalComparisonProgress) => void,
    ): Promise<HistoricalComparisonResult> {
        const ticket = this.reserveComparison(request);
        if (!ticket) {
            return Promise.reject(new Error('comparison-busy'));
        }
        return this.runComparison(ticket, request, onProgress);
    }

    /** Stops the running comparison and kills its children. Returns whether one ran. */
    public cancelComparison(): boolean {
        return this.jobs.cancel('cancelled');
    }

    public getJobStatus() {
        return this.jobs.status;
    }

    public isBusy(): boolean {
        return this.jobs.isBusy();
    }

    /** Stops following working-copy edits until the next successful comparison. */
    public suspendLiveRefresh(): void {
        this.liveRefreshSuspended = true;
    }

    public hasLiveSource(): boolean {
        if (this.liveRefreshSuspended) {
            return false;
        }
        return this.activeRequest?.leftSourceId === 'working-copy'
            || this.activeRequest?.rightSourceId === 'working-copy';
    }

    public async refreshActiveComparison(
        onProgress?: (progress: HistoricalComparisonProgress) => void,
    ): Promise<HistoricalComparisonResult | null> {
        if (!this.activeRequest || !this.hasLiveSource()) {
            return null;
        }
        return this.compare({ ...this.activeRequest }, onProgress);
    }

    public async dispose(): Promise<void> {
        await this.jobs.cancelAndWait('disposed');
        await this.analysis.dispose();
    }

    private async executeComparison(
        request: HistoricalComparisonRequest,
        onProgress?: (progress: HistoricalComparisonProgress) => void,
    ): Promise<HistoricalComparisonResult> {
        if (!request.leftSourceId || !request.rightSourceId || request.leftSourceId === request.rightSourceId) {
            throw new Error('comparison-sources-must-differ');
        }
        onProgress?.({ state: 'analyzing', message: 'Resolving Git references...' });
        const [leftSource, rightSource] = await Promise.all([
            this.gitService.resolveSource(request.leftSourceId),
            this.gitService.resolveSource(request.rightSourceId),
        ]);

        onProgress?.({ state: 'analyzing', message: `Analyzing ${leftSource.label}...` });
        const leftPayload = await this.analysis.analyzeSource(leftSource, this.getSession());
        onProgress?.({ state: 'analyzing', message: `Analyzing ${rightSource.label}...` });
        const rightPayload = await this.analysis.analyzeSource(rightSource, this.getSession());

        // A side whose revision lacks the target never gets here: the request
        // API accepts raw source ids, so analyzeSource refuses that revision
        // itself (a target-missing exclusion) before any comparison is built.
        const session = this.getSession();
        const mappings = await this.getSelectedMetricFields(session);
        const delta = this.buildDelta(
            leftPayload.payload,
            rightPayload.payload,
            session,
            mappings,
        );
        const revision = ++this.revision;
        const comparisonDirectory = path.join(this.staticRoot, 'comparison');
        await fs.promises.mkdir(comparisonDirectory, { recursive: true });

        const leftFileName = `revision-${revision}-left.json`;
        const rightFileName = `revision-${revision}-right.json`;
        await Promise.all([
            fs.promises.writeFile(
                path.join(comparisonDirectory, leftFileName),
                JSON.stringify(leftPayload.payload, null, 2),
                'utf8',
            ),
            fs.promises.writeFile(
                path.join(comparisonDirectory, rightFileName),
                JSON.stringify(rightPayload.payload, null, 2),
                'utf8',
            ),
        ]);

        const result: HistoricalComparisonResult = {
            revision,
            mode: 'historical-compare',
            left: this.toDataset(leftSource, leftPayload, `/comparison/${leftFileName}`),
            right: this.toDataset(rightSource, rightPayload, `/comparison/${rightFileName}`),
            delta,
            generatedAt: new Date().toISOString(),
        };
        await fs.promises.writeFile(
            path.join(comparisonDirectory, `revision-${revision}.json`),
            JSON.stringify(result, null, 2),
            'utf8',
        );
        await this.pruneComparisonRevisions(comparisonDirectory, revision);
        onProgress?.({ state: 'ready', message: 'Historical comparison ready.', revision });
        return result;
    }




    /**
     * Every comparison, and every live refresh on save, writes three files.
     * Only the current revision and the one before it (still on screen for
     * a client that has not loaded the new one) are kept (HIST-8).
     */
    private async pruneComparisonRevisions(comparisonDirectory: string, current: number): Promise<void> {
        let names: string[];
        try {
            names = await fs.promises.readdir(comparisonDirectory);
        } catch {
            return;
        }
        await Promise.all(names.map(async (name) => {
            const match = /^revision-(\d+)(?:-left|-right)?\.json$/.exec(name);
            if (match && Number(match[1]) <= current - KEPT_COMPARISON_REVISIONS) {
                await fs.promises.rm(path.join(comparisonDirectory, name), { force: true, maxRetries: 5, retryDelay: 100 })
                    .catch(() => undefined);
            }
        }));
    }

    private decoratePayload(
        payload: Record<string, unknown>[],
        session: UnifiedAnalysisSession,
        analyzedTargetPath: string,
    ): Record<string, unknown>[] {
        if (session.targetType === 'directory') {
            // Both sides rebuild filePath against the ORIGINAL target, so the
            // working copy and a materialized commit paint identical quarters.
            return decorateDirectoryEntries(payload, session.targetPath, analyzedTargetPath, ['comparisonKey']);
        }

        const occurrences = new Map<string, number>();
        const targetKey = path.basename(session.targetPath).toLocaleLowerCase();
        return payload.map((entry) => {
            const functionName = String(entry.functionName || 'unknown').trim() || 'unknown';
            const parameters = Number(entry.parameters || 0);
            const signature = `${functionName}#${parameters}`;
            const ordinal = (occurrences.get(signature) || 0) + 1;
            occurrences.set(signature, ordinal);
            return {
                ...entry,
                filePath: targetKey,
                comparisonKey: `function:${targetKey}:${signature.toLocaleLowerCase()}:${ordinal}`,
            };
        });
    }

    private buildDelta(
        left: Record<string, unknown>[],
        right: Record<string, unknown>[],
        session: UnifiedAnalysisSession,
        selectedMetrics: string[],
    ): ComparisonDeltaSummary {
        const leftByKey = new Map(left.map((entry) => [String(entry.comparisonKey || ''), entry]));
        const rightByKey = new Map(right.map((entry) => [String(entry.comparisonKey || ''), entry]));
        let added = 0;
        let removed = 0;
        let modified = 0;
        let unchanged = 0;

        for (const [key, leftEntry] of leftByKey) {
            const rightEntry = rightByKey.get(key);
            if (!rightEntry) {
                removed += 1;
            } else if (this.entriesHaveMetricChanges(leftEntry, rightEntry, session)) {
                modified += 1;
            } else {
                unchanged += 1;
            }
        }
        for (const key of rightByKey.keys()) {
            if (!leftByKey.has(key)) {
                added += 1;
            }
        }

        const metrics = Array.from(new Set(selectedMetrics))
            .map((metric) => {
                const leftValue = this.sumMetric(left, metric);
                const rightValue = this.sumMetric(right, metric);
                return {
                    metric,
                    left: leftValue,
                    right: rightValue,
                    delta: rightValue - leftValue,
                };
            });
        return { added, removed, modified, unchanged, metrics };
    }

    private entriesHaveMetricChanges(
        left: Record<string, unknown>,
        right: Record<string, unknown>,
        session: UnifiedAnalysisSession,
    ): boolean {
        const ignored = new Set([
            'comparisonKey',
            'filePath',
            'treePath',
            'timestamp',
            'status',
            'lineStart',
            'lineEnd',
            'fileName',
            'functionName',
            'relativePath',
        ]);
        const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
        for (const key of keys) {
            if (ignored.has(key)) {
                continue;
            }
            const leftValue = left[key];
            const rightValue = right[key];
            if (
                (typeof leftValue === 'number' || typeof rightValue === 'number')
                && Number(leftValue || 0) !== Number(rightValue || 0)
            ) {
                return true;
            }
            if (
                session.targetType === 'file'
                && typeof leftValue === 'string'
                && typeof rightValue === 'string'
                && leftValue !== rightValue
            ) {
                return true;
            }
        }
        return false;
    }

    private sumMetric(payload: Record<string, unknown>[], metric: string): number {
        return payload.reduce((sum, entry) => {
            const value = Number(entry[metric]);
            return sum + (Number.isFinite(value) ? value : 0);
        }, 0);
    }

    private async getSelectedMetricFields(session: UnifiedAnalysisSession): Promise<string[]> {
        const storage = AnalysisConfigurationStorage.getInstance(this.context);
        const mappings = session.targetType === 'file'
            ? await storage.getDimensionMappingFile()
            : await storage.getDimensionMappingDirectory();
        return Object.values(mappings).filter((value) => typeof value === 'string' && value.length > 0);
    }

    private toDataset(
        source: ComparisonSource,
        payload: CachedPayload,
        url: string,
    ): ComparisonDataset {
        return {
            source,
            url,
            itemCount: payload.payload.length,
            missingTarget: payload.missingTarget,
            warnings: payload.warnings,
        };
    }

    private getSession(): UnifiedAnalysisSession {
        const session = UnifiedSessionRegistry.getInstance(this.context).getSession(this.sessionId);
        if (!session || (session.analysisMode !== 'XR' && session.analysisMode !== 'LivePanel')) {
            throw new Error('historical-comparison-session-unavailable');
        }
        return session;
    }
}

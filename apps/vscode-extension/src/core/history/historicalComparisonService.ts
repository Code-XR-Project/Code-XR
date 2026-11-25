import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AnalysisConfigurationStorage } from '../../code_analysis/configuration/analysisConfigurationStorage';
import { UnifiedAnalysisSession } from '../../code_analysis/engine/core/analysisSession';
import { UnifiedSessionRegistry } from '../../code_analysis/engine/core/sessionRegistry';
import { decorateDirectoryEntries } from './gitAnalysisShared';
import { CachedPayload, GitAnalysisSessionContext, SingleJobGate } from './gitAnalysisSessionContext';
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

const ANALYZER_CACHE_VERSION = 'historical-v1';

export class HistoricalComparisonService {
    private readonly gitService: GitRepositoryService;
    private readonly analysis: GitAnalysisSessionContext;
    private readonly jobs = new SingleJobGate<HistoricalComparisonRequest, HistoricalComparisonResult>('comparison-busy');
    private revision = 0;

    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly sessionId: string,
        private readonly staticRoot: string,
        sourceCatalog?: GitAnalysisSourceCatalog,
    ) {
        const session = this.getSession();
        const privateStorageRoot = context.storageUri?.fsPath || context.globalStorageUri.fsPath;
        const snapshotRoot = path.join(
            privateStorageRoot,
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
        };
    }

    public getAvailability(): Promise<{ enabled: boolean; reason: string | null }> {
        return this.gitService.getAvailability(
            'The analyzed target is not inside a local Git repository.',
        );
    }

    public async compare(
        request: HistoricalComparisonRequest,
        onProgress?: (progress: HistoricalComparisonProgress) => void,
    ): Promise<HistoricalComparisonResult> {
        return this.jobs.run(request, () => this.executeComparison(request, onProgress));
    }

    public isBusy(): boolean {
        return this.jobs.isBusy();
    }

    public hasLiveSource(): boolean {
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

    public dispose(): Promise<void> {
        return this.analysis.dispose();
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
        onProgress?.({ state: 'ready', message: 'Historical comparison ready.', revision });
        return result;
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

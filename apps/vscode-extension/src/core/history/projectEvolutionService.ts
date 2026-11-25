import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { UnifiedAnalysisSession } from '../analysis/session/analysisSession';
import { UnifiedSessionRegistry } from '../analysis/session/sessionRegistry';
import { decorateDirectoryEntries } from './gitAnalysisShared';
import { CachedPayload, GitAnalysisSessionContext } from './gitAnalysisSessionContext';
import { JobRunner, JobTicket } from '../analysis/launch/jobRunner';
import { GitRepositoryService } from './gitRepositoryService';
import {
    GitAnalysisSourceCatalog,
    GitAnalysisSourceError,
    createGitAnalysisExclusion,
} from './gitAnalysisEligibility';
import { sampleTimeline } from './gitTimelineSampler';
import {
    describeRevisionType,
    evolutionDirectoryOf,
    listEvolutionRevisions,
    mergeEvolutionSources,
    removeOtherEvolutionRevisions,
    resolveEvolutionFrame,
    writeEvolutionRevision,
} from './projectEvolutionArtifacts';
import {
    ComparisonSource,
    GitAnalysisExclusion,
    ProjectEvolutionProgress,
    ProjectEvolutionReferences,
    ProjectEvolutionRequest,
    ProjectEvolutionResult,
} from './historicalComparisonModels';

const ANALYZER_CACHE_VERSION = 'project-evolution-v1';
const DEFAULT_MAX_FRAMES = 24;
const DEFAULT_ANALYSIS_CONCURRENCY = 4;
const TIMELINE_SCAN_LIMIT = 240;
/** A whole movie longer than this is cancelled and reported (EVO-3). */
export const PROJECT_EVOLUTION_JOB_TIMEOUT_MS = 30 * 60 * 1000;

interface ResolvedEvolutionSources {
    sources: ComparisonSource[];
    exclusions: GitAnalysisExclusion[];
}

export class ProjectEvolutionService {
    private readonly gitService: GitRepositoryService;
    private readonly analysis: GitAnalysisSessionContext;
    private readonly jobs = new JobRunner<ProjectEvolutionRequest, ProjectEvolutionResult>({
        busyCode: 'project-evolution-busy',
        cancelledCode: 'project-evolution-cancelled',
        timeoutCode: 'project-evolution-timeout',
        timeoutMs: PROJECT_EVOLUTION_JOB_TIMEOUT_MS,
    });
    private revision = 0;
    /** Frames of the current movie (`revision`), for resolveFrame. */
    private frameCount = 0;

    public constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly sessionId: string,
        private readonly staticRoot: string,
        sourceCatalog?: GitAnalysisSourceCatalog,
    ) {
        const session = this.getSession();
        const privateStorageRoot = context.storageUri?.fsPath || context.globalStorageUri.fsPath;
        this.gitService = new GitRepositoryService(
            session.targetPath,
            path.join(privateStorageRoot, 'project-evolution', sessionId, 'snapshots'),
        );
        this.analysis = new GitAnalysisSessionContext(session, this.gitService, staticRoot, sourceCatalog, context, {
            cacheVersion: ANALYZER_CACHE_VERSION,
            errorCode: 'project-evolution-insufficient-data',
            sessionIdInfix: 'evolution',
            metadataKey: 'projectEvolutionSource',
            missingTarget: 'cache-empty',
            decorate: (payload, current, analyzedTargetPath) => this.decoratePayload(payload, current, analyzedTargetPath),
        });
    }

    public getAvailability(): Promise<{ enabled: boolean; reason: string | null }> {
        return this.gitService.getAvailability(
            'Project evolution requires a local Git repository.',
        );
    }

    public async getReferences(): Promise<ProjectEvolutionReferences> {
        const references = await this.gitService.listReferences();
        const timeline = await this.buildAutomaticTimeline(references);
        const mergedSources = mergeEvolutionSources(references.sources, timeline);
        const filtered = await this.analysis.sourceCatalog.filterSources({
            repositoryRoot: references.repositoryRoot,
            targetRelativePath: references.targetRelativePath,
            sources: mergedSources,
        });
        const usableIds = new Set(filtered.sources.map((source) => source.id));
        const usableTimeline = timeline.filter((source) => usableIds.has(source.id));
        const suggested = this.sampleSources(usableTimeline, DEFAULT_MAX_FRAMES)
            .map((source) => source.id);
        return {
            ...references,
            sources: filtered.sources,
            eligibility: filtered.eligibility,
            activeRequest: this.jobs.lastRequest ? { ...this.jobs.lastRequest } : null,
            job: this.jobs.status,
            suggestedSourceIds: suggested,
            maxFrames: DEFAULT_MAX_FRAMES,
        };
    }

    public isBusy(): boolean {
        return this.jobs.isBusy();
    }

    /**
     * Takes the job slot synchronously (before the caller's first await), or
     * returns null when a movie is already being generated.
     */
    public reserveGeneration(request: ProjectEvolutionRequest): JobTicket<ProjectEvolutionResult> | null {
        return this.jobs.tryReserve(request);
    }

    /** Runs a reserved generation. Rejects with project-evolution-cancelled/-timeout when stopped. */
    public runGeneration(
        ticket: JobTicket<ProjectEvolutionResult>,
        request: ProjectEvolutionRequest,
        onProgress: (progress: ProjectEvolutionProgress) => void,
    ): Promise<ProjectEvolutionResult> {
        const tagged = (progress: ProjectEvolutionProgress) => onProgress?.({ ...progress, jobId: ticket.id });
        return ticket.execute((signal) => this.executeEvolution(request, tagged, signal));
    }

    public generate(
        request: ProjectEvolutionRequest,
        onProgress: (progress: ProjectEvolutionProgress) => void,
    ): Promise<ProjectEvolutionResult> {
        const ticket = this.reserveGeneration(request);
        if (!ticket) {
            return Promise.reject(new Error('project-evolution-busy'));
        }
        return this.runGeneration(ticket, request, onProgress);
    }

    /**
     * Stops the generation in flight: kills its Git and Python children and
     * discards its result. The movie already generated is kept. Returns
     * whether a generation was running.
     */
    public cancelGeneration(): boolean {
        return this.jobs.cancel('cancelled');
    }

    public getJobStatus() {
        return this.jobs.status;
    }

    public async dispose(): Promise<void> {
        await this.jobs.cancelAndWait('disposed');
        await this.analysis.dispose();
    }

    /**
     * Deletes the generated movie. A generation in flight is cancelled and
     * waited for first, so its late files can never land after the clear.
     */
    public async clearGeneratedMovie(): Promise<void> {
        await this.jobs.cancelAndWait('cancelled');
        this.jobs.forgetLastRequest();
        this.analysis.cache.clear();
        // The whole folder, not only the newest revision (EVO-11): an older
        // movie left behind was what a later export shipped.
        await fs.promises.rm(this.resolveEvolutionDirectory(), { recursive: true, force: true });
        this.frameCount = 0;
    }

    /**
     * Validates a frame of the current movie and returns its own URL. No file
     * is copied (EVO-5): each frame is an immutable `dataN.json`, so players
     * seeking at once can no longer race on a shared bridge file.
     */
    public resolveFrame(
        revision: number,
        frameIndex: number,
    ): { revision: number; frameIndex: number; frameUrl: string } {
        return resolveEvolutionFrame(revision, frameIndex, this.revision, this.frameCount);
    }

    private async executeEvolution(
        request: ProjectEvolutionRequest,
        onProgress: (progress: ProjectEvolutionProgress) => void,
        signal: AbortSignal,
    ): Promise<ProjectEvolutionResult> {
        onProgress?.({ state: 'analyzing', message: 'Resolving project timeline...' });
        const resolved = await this.resolveTimelineSources(request);
        const sources = resolved.sources;
        if (sources.length < 2) {
            throw new GitAnalysisSourceError(
                'project-evolution-insufficient-data',
                `Project evolution needs at least two revisions with data; ${sources.length} remain after filtering.`,
                resolved.exclusions,
            );
        }

        const { analyzed, exclusionsByIndex } = await this.analyzeSources(sources, signal, onProgress);
        const valid = analyzed
            .map((payload, index) => payload ? { payload, source: sources[index] } : undefined)
            .filter((entry): entry is { payload: CachedPayload; source: ComparisonSource } => !!entry);
        const excludedSources = [
            ...resolved.exclusions,
            ...exclusionsByIndex.filter(
                (entry): entry is GitAnalysisExclusion => !!entry,
            ),
        ];
        if (valid.length < 2) {
            throw new GitAnalysisSourceError(
                'project-evolution-insufficient-data',
                `Project evolution needs at least two revisions with data; ${valid.length} remain after analysis.`,
                excludedSources,
            );
        }

        const result = await this.writeEvolutionArtifacts(valid, excludedSources, signal);
        onProgress?.({
            state: 'ready',
            message: excludedSources.length
                ? `Project evolution ready. ${excludedSources.length} revision(s) were discarded because they had no usable data.`
                : 'Project evolution ready.',
            revision: result.revision,
            frameCount: result.frames.length,
        });
        return result;
    }

    /** Phase 2: a worker pool analyzes every source; a failure becomes that frame's exclusion. */
    private async analyzeSources(
        sources: ComparisonSource[],
        signal: AbortSignal,
        onProgress: (progress: ProjectEvolutionProgress) => void,
    ): Promise<{ analyzed: (CachedPayload | undefined)[]; exclusionsByIndex: (GitAnalysisExclusion | undefined)[] }> {
        const analyzed = new Array<CachedPayload | undefined>(sources.length);
        const exclusionsByIndex = new Array<GitAnalysisExclusion | undefined>(sources.length);
        const concurrency = Math.min(DEFAULT_ANALYSIS_CONCURRENCY, sources.length);
        let nextIndex = 0;
        let completed = 0;

        onProgress?.({
            state: 'analyzing',
            message: `Analyzing ${sources.length} project revisions with ${concurrency} workers...`,
            frameIndex: 0,
            frameCount: sources.length,
            completed: 0,
        });

        const workers = Array.from({ length: concurrency }, async () => {
            while (nextIndex < sources.length && !signal.aborted) {
                const index = nextIndex;
                nextIndex += 1;
                const source = sources[index];
                onProgress?.({
                    state: 'analyzing',
                    message: `Analyzing frame ${index + 1} / ${sources.length} (${describeRevisionType(source)}): ${source.label}`,
                    frameIndex: index,
                    frameCount: sources.length,
                    completed,
                });
                try {
                    const payload = await this.analysis.analyzeSource(source, this.getSession());
                    if (payload.missingTarget) {
                        exclusionsByIndex[index] = this.analysis.sourceCatalog.recordDeterministicExclusion(
                            source,
                            'target-missing',
                            'The analyzed target does not exist in this revision.',
                        );
                    } else {
                        // Already validated by analyzeSource (requireUsablePayload).
                        analyzed[index] = payload;
                    }
                } catch (error) {
                    exclusionsByIndex[index] = error instanceof GitAnalysisSourceError
                        && error.exclusions.length
                        ? error.exclusions[0]
                        : createGitAnalysisExclusion(
                            source,
                            'analysis-failed',
                            'analysis',
                            error instanceof Error ? error.message : String(error),
                        );
                }
                if (signal.aborted) {
                    return;
                }
                completed += 1;
                const exclusion = exclusionsByIndex[index];
                onProgress?.({
                    state: 'analyzing',
                    message: exclusion
                        ? `Discarded ${source.label}: ${exclusion.reason}`
                        : `Analyzed ${completed} / ${sources.length} project revisions. Last completed: ${describeRevisionType(source)} ${source.label}`,
                    frameIndex: index,
                    frameCount: sources.length,
                    completed,
                });
            }
        });
        // Every worker ends before the job does: a cancelled job leaves no
        // orphan analysis writing into the cache (EVO-2). The children are
        // killed by the job signal, so this returns promptly.
        await Promise.allSettled(workers);
        if (signal.aborted) {
            throw new Error('project-evolution-cancelled');
        }
        return { analyzed, exclusionsByIndex };
    }

    /** Phase 4: a new revision folder with dataN.json per frame and the manifest; older ones are removed. */
    private async writeEvolutionArtifacts(
        valid: Array<{ payload: CachedPayload; source: ComparisonSource }>,
        excludedSources: GitAnalysisExclusion[],
        signal: AbortSignal,
    ): Promise<ProjectEvolutionResult> {
        // The revision becomes current only once every file is written and
        // the job is still wanted; a cancelled write leaves the previous
        // movie current and removes its own folder (EVO-4).
        if (signal.aborted) {
            throw new Error('project-evolution-cancelled');
        }
        const evolutionDirectory = this.resolveEvolutionDirectory();
        // Never reuse a number a folder on disk already has: a new service
        // starts at 0, and revision-1 of a previous one would be overwritten
        // under a URL the scene may have cached (EVO-11).
        const revision = Math.max(this.revision, ...await listEvolutionRevisions(evolutionDirectory)) + 1;
        const revisionDirectory = path.join(evolutionDirectory, `revision-${revision}`);
        try {
            const result = await writeEvolutionRevision(revision, revisionDirectory, valid, excludedSources);
            if (signal.aborted) {
                throw new Error('project-evolution-cancelled');
            }
            this.revision = revision;
            this.frameCount = result.frames.length;
            await removeOtherEvolutionRevisions(evolutionDirectory, revision).catch(() => undefined);
            return result;
        } catch (error) {
            await fs.promises.rm(revisionDirectory, { recursive: true, force: true }).catch(() => undefined);
            throw error;
        }
    }

    private async resolveTimelineSources(request: ProjectEvolutionRequest): Promise<ResolvedEvolutionSources> {
        const mode = request.mode || 'auto';
        const maxFrames = Math.max(1, Math.min(96, Math.floor(Number(request.maxFrames || DEFAULT_MAX_FRAMES))));
        let candidates: ComparisonSource[];
        if (mode === 'manual' && Array.isArray(request.sourceIds) && request.sourceIds.length) {
            // Picks past the limit used to be dropped without a word (EVO-13).
            if (request.sourceIds.length > maxFrames) {
                throw new Error(
                    `A manual movie has at most ${maxFrames} frames and ${request.sourceIds.length} were picked. `
                    + `Remove ${request.sourceIds.length - maxFrames} and generate again.`,
                );
            }
            candidates = await this.gitService.resolveSourcesInChronologicalOrder(request.sourceIds);
        } else {
            candidates = await this.resolveAutomaticOrRangeSources(request);
        }
        const repository = await this.gitService.getRepositoryContext();
        const filtered = await this.analysis.sourceCatalog.filterSources({
            ...repository,
            sources: candidates,
        });
        return {
            sources: mode === 'manual'
                ? filtered.sources.slice(0, maxFrames)
                : this.sampleSources(filtered.sources, maxFrames),
            exclusions: filtered.eligibility.excludedSources,
        };
    }

    private async resolveAutomaticOrRangeSources(
        request: ProjectEvolutionRequest,
    ): Promise<ComparisonSource[]> {
        const timeline = await this.buildAutomaticTimeline();
        const mode = request.mode || 'auto';
        if (mode === 'range' && request.startSourceId && request.endSourceId) {
            const startIndex = await this.resolveTimelineIndex(timeline, request.startSourceId);
            const endIndex = await this.resolveTimelineIndex(timeline, request.endSourceId);
            // A range the user asked for must never silently degrade into the
            // full automatic movie — that is how "my range was not analyzed"
            // presented. Unresolvable endpoints are a loud error instead.
            if (startIndex < 0 || endIndex < 0) {
                throw new Error('project-evolution-range-not-found');
            }
            const from = Math.min(startIndex, endIndex);
            const to = Math.max(startIndex, endIndex);
            return timeline.slice(from, to + 1);
        }
        return timeline;
    }

    /**
     * Position of a picked source inside the commit timeline.
     *
     * The picker offers branches, tags and the working copy, whose ids do not
     * exist in the commit-only timeline — so a direct id match is only the fast
     * path. Otherwise the source is resolved to its commit sha (branches/tags
     * point at one) and located by sha; the working copy means "the end".
     */
    private async resolveTimelineIndex(
        timeline: ComparisonSource[],
        sourceId: string,
    ): Promise<number> {
        const byId = timeline.findIndex((source) => source.id === sourceId);
        if (byId >= 0) {
            return byId;
        }
        if (sourceId === 'working-copy') {
            return timeline.length - 1;
        }
        try {
            const picked = await this.gitService.resolveSource(sourceId);
            if (picked.kind !== 'gitRef' || !picked.commitSha) {
                return -1;
            }
            return timeline.findIndex(
                (source) => source.kind === 'gitRef' && source.commitSha === picked.commitSha,
            );
        } catch {
            return -1;
        }
    }

    private async buildAutomaticTimeline(existingReferences?: { sources: ComparisonSource[]; workingTreeDirty: boolean }): Promise<ComparisonSource[]> {
        const references = existingReferences ?? await this.gitService.listReferences();
        const timeline = await this.gitService.listTimelineSources(TIMELINE_SCAN_LIMIT);
        const gitTimeline = timeline.length
            ? timeline
            : references.sources.filter((source) => source.kind === 'gitRef');
        const endAnchor = this.resolveCurrentStateSource(references);
        if (endAnchor && !gitTimeline.some((source) => source.id === endAnchor.id)) {
            return [...gitTimeline, endAnchor];
        }
        return gitTimeline;
    }

    /**
     * The revision a movie must finish on: the branch as it stands right now.
     *
     * That is the working copy — it is the checked-out branch whether or not the
     * tree is dirty, and it is what the user is looking at. The timeline itself
     * is `--all`, so its last entry may well belong to a different branch and
     * cannot be trusted as the ending.
     */
    private resolveCurrentStateSource(
        references: { sources: ComparisonSource[]; workingTreeDirty: boolean },
    ): ComparisonSource | null {
        return references.sources.find((source) => source.kind === 'workingCopy') || null;
    }

    private sampleSources(sources: ComparisonSource[], maxFrames: number): ComparisonSource[] {
        // Shared sampler: even spacing in time, milestones preferred, and the
        // current state of the branch always last (see gitTimelineSampler).
        return sampleTimeline(sources, maxFrames, sources[sources.length - 1] || null);
    }

    private decoratePayload(
        payload: Record<string, unknown>[],
        session: UnifiedAnalysisSession,
        analyzedTargetPath: string,
    ): Record<string, unknown>[] {
        if (session.targetType === 'directory') {
            // Every frame rebuilds filePath against the ORIGINAL target, so the
            // movie's tree matches the normal analysis exactly.
            return decorateDirectoryEntries(payload, session.targetPath, analyzedTargetPath, ['evolutionKey']);
        }
        return payload.map((entry) => ({
            ...entry,
            evolutionKey: `function:${String(entry.functionName || entry.name || 'unknown').toLocaleLowerCase()}`,
        }));
    }

    private resolveEvolutionDirectory(): string {
        return evolutionDirectoryOf(this.staticRoot);
    }

    private getSession(): UnifiedAnalysisSession {
        const session = UnifiedSessionRegistry.getInstance(this.context).getSession(this.sessionId);
        if (!session || session.analysisMode !== 'XR') {
            throw new Error('project-evolution-session-unavailable');
        }
        return session;
    }
}

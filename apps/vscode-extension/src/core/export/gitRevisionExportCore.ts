import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    ComparisonSource,
    GitAnalysisExclusion,
    GitAnalysisExclusionCode,
    HistoricalComparisonReferences,
} from '../history/historicalComparisonModels';
import {
    createGitAnalysisExclusion,
    validateGitAnalysisPayload,
} from '../history/gitAnalysisEligibility';
import { decorateDirectoryEntries } from '../history/gitAnalysisShared';
import { sampleTimeline } from '../history/gitTimelineSampler';
import {
    GitRevisionExportRequest,
    revisionLimitForScope,
} from './gitExportOptions';
import {
    GitBlobPipelineStatistics,
    PreparedGitRevisionStore,
} from './gitTimelineBlobAnalyzer';

/**
 * Export-time git pre-analysis: the whole timeline, once, shared.
 *
 * Historical comparison and project evolution analyze the same thing per
 * revision; they only disagree on the identity key each mode reads. The
 * export provider indexes Git blobs and analyzes each distinct content once,
 * then this module decorates every chronological payload with BOTH keys and
 * writes it under `git-revisions/`. The exported scene can compose any
 * comparison and any movie offline without repeating work.
 *
 * Deliberately vscode-free: git access, the analyzer and the working-copy
 * reader are injected, so tests drive the full pipeline against a real fixture
 * repository with a stubbed analyzer.
 */

export const GIT_REVISIONS_FOLDER = 'git-revisions';
export const WORKING_COPY_PAYLOAD_FILE = 'working-copy.json';
const WORKING_COPY_PAYLOAD_URL = `./${GIT_REVISIONS_FOLDER}/${WORKING_COPY_PAYLOAD_FILE}`;
const CANCELLED_REASON = 'The git analysis was cancelled before enough revisions completed.';

/**
 * Exports deliberately carry the complete timeline. Live Evolution keeps a
 * bounded scan for responsiveness; an explicit export is a long-running,
 * confirmed operation whose purpose is to remain useful without CodeXR.
 */
/** Mirrors the live evolution defaults so offline suggestions match online. */
export const EXPORT_DEFAULT_MAX_FRAMES = 24;

export interface CancelSignal { readonly isCancellationRequested: boolean }
export interface ProgressSink { report(value: { message?: string; increment?: number }): void }

export interface GitExportSourceEntry extends Record<string, unknown> {
    id: string;
    payloadUrl: string;
    itemCount: number;
}

export interface ExportGitData {
    references: {
        repositoryRoot?: string;
        targetRelativePath: string;
        workingTreeDirty: boolean;
        activeBranch: string | null;
        pageSize: number;
        sources: GitExportSourceEntry[];
    };
    timelineSourceIds: string[];
    suggestedSourceIds: string[];
    maxFrames: number;
    workingCopyPayloadUrl?: string;
    timelineSelection?: {
        kind: 'all' | 'latest';
        requestedCommitCount: number | null;
        selectedCommitCount: number;
        exportedCommitCount: number;
        exportedSourceCount: number;
    };
    pipelineStatistics?: GitBlobPipelineStatistics;
    analyzedRevisionCount: number;
    skippedRevisions?: GitAnalysisExclusion[];
    partial?: boolean;
}

export interface GitExportOutcome {
    gitData?: ExportGitData;
    failureReason?: string;
    cancelled: boolean;
}

export interface GitRevisionExportDeps {
    gitService: {
        listReferences(): Promise<HistoricalComparisonReferences>;
        listTimelineSources(maxCount: number | null): Promise<ComparisonSource[]>;
        dispose(): Promise<void> | void;
    };
    prepareRevisionStore: (sources: ComparisonSource[]) => Promise<PreparedGitRevisionStore>;
    readWorkingCopyPayload: () => Promise<unknown>;
}

export interface GitRevisionExportOptions {
    targetPath: string;
    targetType: string;
    destinationPath: string;
    request?: GitRevisionExportRequest;
    token?: CancelSignal;
    progress?: ProgressSink;
}

/**
 * The unified decorator: one payload serves both git modes.
 *
 * Directory targets: the two live decorations coincide except for the field
 * name, so both keys carry the same `file:<relativePath>` value, and filePath
 * is rebuilt against the ORIGINAL target (normal-analysis shape) exactly like
 * both services do.
 *
 * File targets: the live decorations genuinely differ, so both are computed —
 * historical's ordinal-disambiguated key (the stricter one) and evolution's
 * plain function key — in a single pass.
 */
export function decorateRevisionPayload(
    entries: Record<string, unknown>[],
    targetType: string,
    originalTargetPath: string,
    analyzedTargetPath: string,
): Record<string, unknown>[] {
    if (targetType === 'directory') {
        return decorateDirectoryEntries(entries, originalTargetPath, analyzedTargetPath, ['comparisonKey', 'evolutionKey']);
    }

    const occurrences = new Map<string, number>();
    const targetKey = path.basename(originalTargetPath).toLocaleLowerCase();
    return entries.map((entry) => {
        const functionName = String(entry.functionName || 'unknown').trim() || 'unknown';
        const parameters = Number(entry.parameters || 0);
        const signature = `${functionName}#${parameters}`;
        const ordinal = (occurrences.get(signature) || 0) + 1;
        occurrences.set(signature, ordinal);
        return {
            ...entry,
            filePath: targetKey,
            comparisonKey: `function:${targetKey}:${signature.toLocaleLowerCase()}:${ordinal}`,
            evolutionKey: `function:${functionName.toLocaleLowerCase()}`,
        };
    });
}

/**
 * The exclusion code and stage of a revision whose analysis threw `reason`.
 * The two are matched independently and disagree for some messages (for
 * example "git-revision-target-missing" is a target-missing failure at the
 * analysis stage); `gitRevisionExportPhases.test.cjs` pins the table.
 * Distinct from the live catalogue's classifyIndexedRevision, which works on
 * indexed revisions rather than error messages.
 */
function classifyExportRevisionFailure(reason: string): {
    code: GitAnalysisExclusionCode;
    stage: GitAnalysisExclusion['stage'];
} {
    const code: GitAnalysisExclusionCode = /target does not exist|target-missing/i.test(reason)
        ? 'target-missing'
        : /no analyzable|no data records|no-analyzable-content/i.test(reason)
            ? 'no-analyzable-content'
            : /(?:file|size)-limit|exceeds the configured/i.test(reason)
                ? 'limit-exceeded'
                : 'analysis-failed';
    const stage = /no analyzable|target does not exist|limit/i.test(reason) ? 'index' : 'analysis';
    return { code, stage };
}

function payloadFileNameForSha(commitSha: string): string {
    return `${commitSha.slice(0, 12)}.json`;
}

/**
 * Analyze the timeline once and write the shared payloads into the copy.
 * Failures and cancellation degrade, never abort: whatever completed ships,
 * and the outcome says exactly what happened.
 */
export async function runGitRevisionExport(
    deps: GitRevisionExportDeps,
    options: GitRevisionExportOptions,
): Promise<GitExportOutcome> {
    const { gitService } = deps;
    const request: GitRevisionExportRequest = options.request ?? {
        scope: { kind: 'all' },
        performanceProfile: 'balanced',
    };
    const revisionsDir = path.join(options.destinationPath, GIT_REVISIONS_FOLDER);
    let preparedStore: PreparedGitRevisionStore | undefined;

    let references: HistoricalComparisonReferences;
    let timeline: ComparisonSource[];
    try {
        references = await gitService.listReferences();
        timeline = await gitService.listTimelineSources(revisionLimitForScope(request.scope));
    } catch (error) {
        await gitService.dispose();
        return {
            cancelled: false,
            failureReason: 'The git timeline could not be listed for the export: '
                + `${error instanceof Error ? error.message : String(error)}`,
        };
    }

    try {
        await fs.promises.mkdir(revisionsDir, { recursive: true });
        const run: ExportRun = {
            options, request, references, revisionsDir,
            payloadUrlBySourceId: new Map(), itemCountBySourceId: new Map(), skippedRevisions: [],
        };
        const bySha = groupSourcesByCommit(timeline, references);
        const workingCopySource = references.sources.find((source) => source.kind === 'workingCopy');
        await writeWorkingCopyPayload(run, deps, workingCopySource);

        // The prepared store indexes all selected revisions and analyzes every
        // distinct Git blob/extension once. Assembly below remains
        // chronological so output naming and content-hash sharing never depend
        // on worker completion order.
        const total = bySha.size;
        if (total > 0) {
            const prepared = await prepareStoreOrCancel(run, deps, bySha);
            if ('outcome' in prepared) {
                return prepared.outcome;
            }
            preparedStore = prepared.store;
        }
        const cancelled = await exportRevisionGroups(run, preparedStore, bySha);
        const exported = selectExportedSources(run, timeline, workingCopySource);
        return await finishExport(run, exported, { selectedCommitCount: total, preparedStore, cancelled });
    } catch (error) {
        await fs.promises.rm(revisionsDir, { recursive: true, force: true }).catch(() => undefined);
        return {
            cancelled: false,
            failureReason: `The git revision export failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    } finally {
        await preparedStore?.dispose().catch(() => undefined);
        await gitService.dispose();
    }
}

/** What one export run accumulates: payload per source, and the exclusions. */
interface ExportRun {
    options: GitRevisionExportOptions;
    request: GitRevisionExportRequest;
    references: HistoricalComparisonReferences;
    revisionsDir: string;
    payloadUrlBySourceId: Map<string, string>;
    itemCountBySourceId: Map<string, number>;
    skippedRevisions: GitAnalysisExclusion[];
}

/** The sources an export ships, once every revision has been tried. */
interface ExportedSources {
    usableSources: ComparisonSource[];
    exportedTimeline: ComparisonSource[];
    workingCopySource?: ComparisonSource;
    hasUsableWorkingCopy: boolean;
    frameSourceCount: number;
}

/**
 * One set of selected commits, keyed by SHA in timeline order. Refs only
 * share a payload when their target SHA is inside the requested timeline
 * scope; an old branch or tag must never silently expand a "latest N"
 * export.
 */
function groupSourcesByCommit(
    timeline: ComparisonSource[],
    references: HistoricalComparisonReferences,
): Map<string, ComparisonSource[]> {
    const bySha = new Map<string, ComparisonSource[]>();
    const registerSource = (source: ComparisonSource) => {
        if (source.kind !== 'gitRef' || !source.commitSha) {
            return;
        }
        const group = bySha.get(source.commitSha) ?? [];
        if (!group.some((existing) => existing.id === source.id)) {
            group.push(source);
        }
        bySha.set(source.commitSha, group);
    };
    timeline.forEach(registerSource);
    references.sources.forEach((source) => {
        if (source.kind === 'gitRef' && bySha.has(source.commitSha)) {
            registerSource(source);
        }
    });
    return bySha;
}

/** The working copy is free: decorate the copy's own data.json (read even without a working-copy source). */
async function writeWorkingCopyPayload(
    run: ExportRun,
    deps: GitRevisionExportDeps,
    workingCopySource: ComparisonSource | undefined,
): Promise<void> {
    const workingCopyEntries = await deps.readWorkingCopyPayload();
    const validation = validateGitAnalysisPayload(workingCopyEntries);
    if (!workingCopySource) {
        return;
    }
    if (!validation.usable) {
        const reason = validation.reason || 'The working copy data.json could not be read.';
        run.skippedRevisions.push(createGitAnalysisExclusion(
            workingCopySource, validation.code || 'invalid-payload', 'index', reason,
        ));
        return;
    }
    const { targetType, targetPath } = run.options;
    const decorated = decorateRevisionPayload(validation.entries, targetType, targetPath, targetPath);
    const serialized = JSON.stringify(decorated, null, 2);
    await fs.promises.writeFile(path.join(run.revisionsDir, WORKING_COPY_PAYLOAD_FILE), serialized, 'utf8');
    run.payloadUrlBySourceId.set(workingCopySource.id, WORKING_COPY_PAYLOAD_URL);
    run.itemCountBySourceId.set(workingCopySource.id, decorated.length);
}

/** The revision store for each commit group's first source; a cancelled preparation becomes the outcome. */
async function prepareStoreOrCancel(
    run: ExportRun,
    deps: GitRevisionExportDeps,
    bySha: Map<string, ComparisonSource[]>,
): Promise<{ store: PreparedGitRevisionStore } | { outcome: GitExportOutcome }> {
    try {
        const primarySources = Array.from(bySha.keys()).map((sha) => (bySha.get(sha) ?? [])[0]);
        return { store: await deps.prepareRevisionStore(primarySources) };
    } catch (error) {
        if (run.options.token?.isCancellationRequested || String(error).includes('git-export-cancelled')) {
            await fs.promises.rm(run.revisionsDir, { recursive: true, force: true });
            return { outcome: { cancelled: true, failureReason: CANCELLED_REASON } };
        }
        throw error;
    }
}

/** Every commit group's payload, in timeline order, failures excluded; true when cancelled part-way. */
async function exportRevisionGroups(
    run: ExportRun,
    preparedStore: PreparedGitRevisionStore | undefined,
    bySha: Map<string, ComparisonSource[]>,
): Promise<boolean> {
    const fileByContentHash = new Map<string, string>();
    const total = bySha.size;
    let completed = 0;
    for (const [sha, group] of bySha) {
        if (run.options.token?.isCancellationRequested) {
            return true;
        }
        const source = group[0];
        try {
            await exportRevisionGroup(run, preparedStore, sha, group, fileByContentHash);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const { code, stage } = classifyExportRevisionFailure(reason);
            for (const member of group) {
                run.skippedRevisions.push(createGitAnalysisExclusion(member, code, stage, reason));
            }
        }
        completed += 1;
        run.options.progress?.report({
            increment: 10 / Math.max(total, 1),
            message: `Building offline revision: ${completed}/${total} · ${source?.label || sha.slice(0, 12)}`,
        });
    }
    return false;
}

/** Analyse one commit for its whole group; a byte-identical payload reuses the earlier file. */
async function exportRevisionGroup(
    run: ExportRun,
    preparedStore: PreparedGitRevisionStore | undefined,
    sha: string,
    group: ComparisonSource[],
    fileByContentHash: Map<string, string>,
): Promise<void> {
    if (!preparedStore) {
        throw new Error('git-revision-store-unavailable');
    }
    const prepared = await preparedStore.get(group[0]);
    const validation = validateGitAnalysisPayload(prepared.entries);
    if (!validation.usable) {
        throw new Error(validation.reason || 'git-revision-no-analyzable-content');
    }
    const { targetType, targetPath } = run.options;
    const decorated = decorateRevisionPayload(validation.entries, targetType, targetPath, prepared.analyzedTargetPath);
    const serialized = JSON.stringify(decorated, null, 2);
    const contentHash = crypto.createHash('sha1').update(serialized).digest('hex');
    let fileName = fileByContentHash.get(contentHash);
    if (!fileName) {
        fileName = payloadFileNameForSha(sha);
        await fs.promises.writeFile(path.join(run.revisionsDir, fileName), serialized, 'utf8');
        fileByContentHash.set(contentHash, fileName);
    }
    for (const member of group) {
        run.payloadUrlBySourceId.set(member.id, `./${GIT_REVISIONS_FOLDER}/${fileName}`);
        run.itemCountBySourceId.set(member.id, decorated.length);
    }
}

/** References first, then the timeline commits they do not list, keeping only those with a payload. */
function selectExportedSources(
    run: ExportRun,
    timeline: ComparisonSource[],
    workingCopySource: ComparisonSource | undefined,
): ExportedSources {
    const { references } = run;
    const hasPayload = (source: ComparisonSource) => run.payloadUrlBySourceId.has(source.id);
    const usableSources = references.sources
        .concat(timeline.filter((source) => !references.sources.some((ref) => ref.id === source.id)))
        .filter(hasPayload);
    const exportedTimeline = timeline.filter(hasPayload);
    const hasUsableWorkingCopy = !!workingCopySource && hasPayload(workingCopySource);
    return {
        usableSources,
        exportedTimeline,
        workingCopySource,
        hasUsableWorkingCopy,
        frameSourceCount: exportedTimeline.length + (hasUsableWorkingCopy ? 1 : 0),
    };
}

/** How the run went, as assembleGitData reports it. */
interface ExportRunSummary { selectedCommitCount: number; preparedStore?: PreparedGitRevisionStore; cancelled: boolean }

/** The gitData, or, under two usable sources or frames, a failure once git-revisions/ is removed. */
async function finishExport(
    run: ExportRun,
    exported: ExportedSources,
    summary: ExportRunSummary,
): Promise<GitExportOutcome> {
    const { cancelled } = summary;
    if (exported.usableSources.length < 2 || exported.frameSourceCount < 2) {
        await fs.promises.rm(run.revisionsDir, { recursive: true, force: true });
        return {
            cancelled,
            failureReason: cancelled
                ? CANCELLED_REASON
                : 'Fewer than two revisions could be analyzed, so offline comparisons are not possible.',
        };
    }
    return { gitData: assembleGitData(run, exported, summary), cancelled };
}

function assembleGitData(run: ExportRun, exported: ExportedSources, context: ExportRunSummary): ExportGitData {
    const { usableSources, exportedTimeline } = exported;
    const { preparedStore, cancelled } = context;
    const { references, request, skippedRevisions } = run;
    const endAnchor = exported.hasUsableWorkingCopy
        ? exported.workingCopySource
        : exportedTimeline[exportedTimeline.length - 1];
    // Mirror of the live suggestion: buildAutomaticTimeline + default sample.
    const suggested = sampleTimeline(exportedTimeline, EXPORT_DEFAULT_MAX_FRAMES, endAnchor);

    return {
        references: {
            repositoryRoot: references.repositoryRoot,
            targetRelativePath: references.targetRelativePath,
            workingTreeDirty: references.workingTreeDirty,
            activeBranch: references.activeBranch,
            pageSize: references.pageSize,
            sources: usableSources.map((source) => ({
                ...(source as unknown as Record<string, unknown>),
                id: source.id,
                payloadUrl: run.payloadUrlBySourceId.get(source.id) as string,
                itemCount: run.itemCountBySourceId.get(source.id) || 0,
            })),
        },
        timelineSourceIds: exportedTimeline.map((source) => source.id)
            .concat(endAnchor && endAnchor.kind === 'workingCopy' ? [endAnchor.id] : []),
        suggestedSourceIds: suggested.map((source) => source.id),
        maxFrames: EXPORT_DEFAULT_MAX_FRAMES,
        ...(exported.hasUsableWorkingCopy ? { workingCopyPayloadUrl: WORKING_COPY_PAYLOAD_URL } : {}),
        timelineSelection: {
            kind: request.scope.kind,
            requestedCommitCount: request.scope.kind === 'latest' ? request.scope.count : null,
            selectedCommitCount: context.selectedCommitCount,
            exportedCommitCount: exportedTimeline.length,
            exportedSourceCount: usableSources.length,
        },
        ...(preparedStore ? { pipelineStatistics: preparedStore.statistics } : {}),
        analyzedRevisionCount: exportedTimeline.length,
        ...(skippedRevisions.length ? { skippedRevisions } : {}),
        ...(cancelled || skippedRevisions.length ? { partial: true } : {}),
    };
}

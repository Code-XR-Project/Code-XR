export type AnalysisTableMode =
    | 'selection'
    | 'single'
    | 'historical-compare'
    | 'project-evolution'
    | 'dependency-graph';

export type GitReferenceType = 'branch' | 'tag' | 'commit';
export type GitRevisionType = 'working-copy' | 'branch' | 'tag' | 'commit' | 'merge';
export type GitAnalysisExclusionCode =
    | 'target-missing'
    | 'no-analyzable-content'
    | 'invalid-payload'
    | 'analysis-failed'
    | 'limit-exceeded';

export interface GitAnalysisExclusion {
    /** Source id; kept as `id` for backwards compatibility with skippedRevisions. */
    id: string;
    label: string;
    commitSha?: string;
    code: GitAnalysisExclusionCode;
    stage: 'index' | 'analysis';
    reason: string;
}

export interface GitAnalysisEligibility {
    scannedSourceCount: number;
    usableSourceCount: number;
    excludedSources: GitAnalysisExclusion[];
}

export type ComparisonSource =
    | {
        id: 'working-copy';
        kind: 'workingCopy';
        label: string;
        activeBranch: string | null;
        dirty: boolean;
        live: true;
        revisionType: GitRevisionType;
    }
    | {
        id: string;
        kind: 'gitRef';
        refType: GitReferenceType;
        refName: string;
        commitSha: string;
        label: string;
        description?: string;
        /** Committer date (YYYY-MM-DD) of the ref's target commit, if known. */
        date?: string;
        /**
         * Committer time (Unix epoch seconds) of the ref's target commit.
         * `date` is day-granular, so same-day refs are indistinguishable by
         * it; ordering and range membership need this precise key.
         */
        timestamp?: number;
        live: false;
        revisionType: GitRevisionType;
        parentCount: number;
    };

export interface HistoricalComparisonRequest {
    leftSourceId: string;
    rightSourceId: string;
}

export interface ComparisonDataset {
    source: ComparisonSource;
    url: string;
    itemCount: number;
    missingTarget: boolean;
    warnings: string[];
}

export interface ComparisonMetricDelta {
    metric: string;
    left: number;
    right: number;
    delta: number;
}

export interface ComparisonDeltaSummary {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
    metrics: ComparisonMetricDelta[];
}

export interface HistoricalComparisonResult {
    revision?: number;
    mode: 'historical-compare';
    left: ComparisonDataset;
    right: ComparisonDataset;
    delta: ComparisonDeltaSummary;
    generatedAt: string;
}

export interface HistoricalComparisonReferences {
    repositoryRoot: string;
    targetRelativePath: string;
    workingTreeDirty: boolean;
    activeBranch: string | null;
    sources: ComparisonSource[];
    pageSize: number;
    activeRequest?: HistoricalComparisonRequest | null;
    eligibility?: GitAnalysisEligibility;
    /**
     * The job running (or last run) for this mode, so a client that joins
     * mid-job shows the same state as everyone else (S6).
     */
    job?: AnalysisJobSnapshot | null;
}

/** What the room sees of a long analysis job (JobRunner's JobStatus). */
export interface AnalysisJobSnapshot {
    id: string;
    state: 'queued' | 'running' | 'cancelled' | 'failed' | 'done';
    startedAt: string;
    endedAt?: string;
    error?: string;
}

export interface HistoricalComparisonProgress {
    state: 'idle' | 'analyzing' | 'ready' | 'error';
    message: string;
    revision?: number;
    /** The job this progress belongs to. */
    jobId?: string;
}

export interface ProjectEvolutionRequest {
    mode: 'auto' | 'range' | 'manual';
    startSourceId?: string;
    endSourceId?: string;
    sourceIds?: string[];
    maxFrames?: number;
}

export interface ProjectEvolutionFrame {
    index: number;
    source: ComparisonSource;
    label: string;
    date: string;
    url: string;
    itemCount: number;
    missingTarget: boolean;
    warnings: string[];
}

export interface ProjectEvolutionResult {
    revision: number;
    mode: 'project-evolution';
    frames: ProjectEvolutionFrame[];
    generatedAt: string;
    manifestUrl: string;
    /**
     * Gone since 1.2.1: frames are loaded by their own immutable `url`
     * (EVO-5). Kept optional so a movie exported by 1.2.0 still parses.
     */
    bridgeUrl?: string;
    excludedSources: GitAnalysisExclusion[];
}

export interface ProjectEvolutionReferences extends Omit<HistoricalComparisonReferences, 'activeRequest'> {
    activeRequest: ProjectEvolutionRequest | null;
    suggestedSourceIds: string[];
    maxFrames: number;
}

export interface ProjectEvolutionProgress {
    state: 'idle' | 'analyzing' | 'ready' | 'error';
    message: string;
    revision?: number;
    frameIndex?: number;
    frameCount?: number;
    /**
     * Revisions finished so far (analyzed or discarded) out of `frameCount`.
     * Only ever grows and reaches `frameCount`, unlike `frameIndex`, which
     * names whichever of the parallel workers spoke last (EVO-14).
     */
    completed?: number;
    /** The job this progress belongs to. */
    jobId?: string;
}

/**
 * Rebuild a file path exactly as the normal analysis publishes it for the
 * ORIGINAL analyzed target (Python's normalize_path_for_babia: forward
 * slashes, no drive letter). Evolution and historical analyses run in
 * per-commit temp copies, so their raw paths would paint a different boats
 * tree per frame; anchoring the path to the original target keeps the
 * quarters identical to the normal analysis of the same directory.
 */
export function buildBabiaStyleFilePath(originalTargetPath: string, relativePath: string): string {
    let prefix = String(originalTargetPath || '').replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(prefix)) {
        prefix = prefix.slice(2);
    }
    prefix = prefix.replace(/\/+/g, '/').replace(/\/+$/, '');
    const suffix = String(relativePath || '').replace(/^\/+/, '');
    return `${prefix}/${suffix}`.replace(/\/+/g, '/');
}

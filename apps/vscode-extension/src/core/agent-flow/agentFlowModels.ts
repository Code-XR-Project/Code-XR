/**
 * Agent Flow: the fifth analysis type. Watches an AI coding agent work on the
 * analysis table: which files it reads, searches, edits and runs, in which
 * order, turn by turn, with the metric deltas its edits cause.
 *
 * This module is the contract shared by every producer and consumer:
 * - the normalized trace event every agent source is mapped to (ACP chats in
 *   the Code-XR IDE, Claude Code transcripts, Codex rollouts);
 * - the dataset the browser runtime draws (`agent-flow/agent-flow-<rev>.json`).
 *
 * Pure types and constants, zero imports: the IDE reads it through
 * `@codexr/core/agent-flow/agentFlowModels` and the tests from `out/`.
 */

/** What an agent step did to the code, the visual verb of the scene. */
export type AgentStepKind = 'read' | 'write' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

export const AGENT_STEP_KINDS: ReadonlyArray<AgentStepKind> = Object.freeze([
    'read', 'write', 'search', 'execute', 'think', 'fetch', 'other',
]);

/** Where a trace comes from. */
export type AgentTraceSourceKind = 'ide-acp' | 'claude-code' | 'codex' | 'fixture';

export type AgentStepStatus = 'pending' | 'running' | 'done' | 'failed';

/** A file location an event names, as the agent sent it (absolute or relative). */
export interface AgentTraceLocation {
    path: string;
    line?: number;
}

/**
 * One normalized event of an agent session. Producers emit these; the builder
 * folds them into a dataset. `id` identifies a tool step across its updates
 * (an ACP toolCallId, a Claude Code tool_use id, a Codex call_id): a second
 * event with the same id updates the step instead of adding one.
 */
export type AgentTraceEvent =
    | { type: 'turn-start'; at: number; prompt?: string }
    | { type: 'turn-end'; at: number; stopReason?: string }
    | {
        type: 'step';
        at: number;
        id: string;
        kind: AgentStepKind;
        /** The agent's own tool name (Read, Edit, shell, read_file...). */
        tool?: string;
        title?: string;
        status?: AgentStepStatus;
        locations?: AgentTraceLocation[];
        /** Files created by this step (a Write to a new path, an "Add File" patch). */
        created?: string[];
        /** Files removed by this step. */
        deleted?: string[];
        /** Lines added/removed when the source knows them (a diff). */
        added?: number;
        removed?: number;
        /** The command of an execute step. */
        command?: string;
        exitCode?: number | null;
        /** True for a step a sub-agent ran. */
        subagent?: boolean;
    }
    | {
        type: 'metric-delta';
        at: number;
        /** Per-file deltas of the turn that just ended, paths as the source names them. */
        files: Array<{ path: string; codeLines?: number; complexity?: number }>;
    };

/** Per-file metrics the builder lays the city out from (the classic data.json). */
export interface AgentFlowFileMetrics {
    /** Path relative to the analysed root, forward slashes. */
    path: string;
    loc: number;
    complexity?: number;
    functions?: number;
    language?: string;
}

/** Touch counters of one file. */
export interface AgentFlowTouches {
    reads: number;
    writes: number;
    searches: number;
    executes: number;
}

export interface AgentFlowMetricDelta {
    codeLines: number;
    complexity: number;
}

/** A building of the agent city. Layout values are table-local metres, origin at the table centre. */
export interface AgentFlowFile {
    index: number;
    path: string;
    name: string;
    dir: string;
    language?: string;
    loc: number;
    complexity?: number;
    functions?: number;
    /** Footprint centre and size on the table plane, and building height. */
    x: number;
    z: number;
    w: number;
    d: number;
    h: number;
    touches: AgentFlowTouches;
    /** First and last step seq that touched it, -1 when never. */
    firstStep: number;
    lastStep: number;
    /** Turn indexes it was touched in, ascending, unique. */
    turns: number[];
    created: boolean;
    deleted: boolean;
    /** Net metric change the session caused, null when unknown. */
    delta: AgentFlowMetricDelta | null;
    /** Files that import this one (from the dependency graph), -1 when unknown. */
    dependents: number;
}

/** A folder plate of the city. */
export interface AgentFlowDistrict {
    path: string;
    depth: number;
    x: number;
    z: number;
    w: number;
    d: number;
}

export interface AgentFlowStep {
    seq: number;
    turn: number;
    at: number;
    kind: AgentStepKind;
    tool: string;
    title: string;
    status: AgentStepStatus;
    /** Indexes into `files`. */
    files: number[];
    line?: number;
    command?: string;
    exitCode?: number | null;
    subagent?: boolean;
    added?: number;
    removed?: number;
}

export interface AgentFlowTurn {
    index: number;
    prompt: string;
    startedAt: number;
    endedAt: number | null;
    /** First and last step seq of the turn, -1 when the turn has none. */
    stepStart: number;
    stepEnd: number;
    reads: number;
    writes: number;
    searches: number;
    executes: number;
    filesTouched: number;
    delta: AgentFlowMetricDelta | null;
    stopReason?: string;
}

/** A move of the agent from one file to the next (consecutive touched steps). */
export interface AgentFlowTransition {
    from: number;
    to: number;
    count: number;
}

/** Session-level process metrics (see docs/agent-flow/research.md §4.5). */
export interface AgentFlowSessionMetrics {
    turns: number;
    steps: number;
    footprint: number;
    reads: number;
    writes: number;
    searches: number;
    executes: number;
    failures: number;
    /** reads / writes, null without writes. */
    readWriteRatio: number | null;
    /** Share of read steps that hit a file already read, 0..1. */
    revisitRate: number;
    /** Written files that were never read before their first write. */
    blindWrites: number;
    /** Writes with no execute step after them in the same session. */
    unverifiedEdits: number;
    /** Dependents of written files the agent never touched, -1 when unknown. */
    unreadDependents: number;
    filesCreated: number;
    filesDeleted: number;
    durationMs: number;
    delta: AgentFlowMetricDelta | null;
}

export interface AgentFlowSessionInfo {
    id: string;
    source: AgentTraceSourceKind;
    agent: string;
    label: string;
    startedAt: number;
    updatedAt: number;
    live: boolean;
}

export const AGENT_FLOW_SCHEMA_VERSION = 1;

/** The table box the city is laid out in (metres), the dependency graph's box. */
export const AGENT_FLOW_TABLE = Object.freeze({ width: 4.7, depth: 2.35, maxHeight: 0.9, minHeight: 0.04 });

export interface AgentFlowDataset {
    schemaVersion: number;
    revision: number;
    generatedAt: string;
    /** Display name of the analysed root (its folder name, never an absolute path). */
    rootName: string;
    session: AgentFlowSessionInfo;
    files: AgentFlowFile[];
    districts: AgentFlowDistrict[];
    turns: AgentFlowTurn[];
    steps: AgentFlowStep[];
    transitions: AgentFlowTransition[];
    metrics: AgentFlowSessionMetrics;
    /** For each written file, the files that import it (indexes), when a dependency graph exists. */
    blastRadius: Array<{ file: number; dependents: number[] }>;
    warnings: string[];
}

/** The room entity that points the scene at the current dataset. */
export interface AgentFlowEntity {
    entityKind: 'agent-flow';
    entityId: 'main';
    status: 'idle' | 'loading' | 'ready' | 'error';
    revision: number;
    datasetUrl: string | null;
    sourceId: string | null;
    live: boolean;
    message?: string;
}

/** One entry of the source picker. */
export interface AgentTraceSourceSummary {
    id: string;
    kind: AgentTraceSourceKind;
    agent: string;
    label: string;
    updatedAt: number;
    live: boolean;
}

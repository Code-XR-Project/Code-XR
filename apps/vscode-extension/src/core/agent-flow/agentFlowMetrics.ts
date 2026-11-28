/**
 * Phases 3 to 6 of the Agent Flow builder, run once the city's files are
 * known: per-file touches and the agent's path between files, the metric
 * deltas, the blast radius of the edits and the session's process metrics.
 */
import {
    type AgentFlowDataset,
    type AgentFlowFile,
    type AgentFlowFileMetrics,
    type AgentFlowMetricDelta,
    type AgentFlowSessionMetrics,
    type AgentFlowTransition,
    type AgentFlowTurn,
    type AgentStepKind,
} from './agentFlowModels';
import { type MutableStep } from './agentFlowSteps';

export const TOUCHING_KINDS = new Set<AgentStepKind>(['read', 'write', 'search', 'execute']);

export function round(value: number, digits = 4): number {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

// ---- 3. Touches, turns, transitions ----------------------------------------

export interface TouchSummary {
    transitions: AgentFlowTransition[];
    revisits: number;
    failures: number;
    /** Files written before the agent ever read them (and not created by it). */
    blindWrites: number;
    unverifiedEdits: number;
}

interface TouchState {
    files: AgentFlowFile[];
    transitions: Map<string, AgentFlowTransition>;
    previousFile: number;
    readSoFar: Set<number>;
    writtenBeforeRead: Set<number>;
    revisits: number;
    failures: number;
    lastExecuteSeq: number;
    lastWriteSeq: number;
    writeSeqs: number[];
    turnFiles: Map<number, Set<number>>;
}

function stepFileIndexes(step: MutableStep, indexByPath: Map<string, number>): number[] {
    return [...step.paths, ...step.createdPaths, ...step.deletedPaths]
        .map((path) => indexByPath.get(path))
        .filter((index): index is number => index !== undefined)
        .filter((index, position, list) => list.indexOf(index) === position);
}

function countStepKind(state: TouchState, turn: AgentFlowTurn, step: MutableStep): void {
    switch (step.kind) {
        case 'read': turn.reads += 1; break;
        case 'write': turn.writes += 1; state.writeSeqs.push(step.seq); state.lastWriteSeq = step.seq; break;
        case 'search': turn.searches += 1; break;
        case 'execute': turn.executes += 1; state.lastExecuteSeq = step.seq; break;
        default: break;
    }
}

function markFiles(paths: string[], indexByPath: Map<string, number>, mark: (index: number) => void): void {
    for (const path of paths) {
        const index = indexByPath.get(path);
        if (index !== undefined) { mark(index); }
    }
}

function touchFile(state: TouchState, step: MutableStep, index: number): void {
    const file = state.files[index];
    if (step.kind === 'read') {
        file.touches.reads += 1;
        if (state.readSoFar.has(index)) { state.revisits += 1; }
        state.readSoFar.add(index);
    } else if (step.kind === 'write') {
        file.touches.writes += 1;
        if (!state.readSoFar.has(index) && !file.created) { state.writtenBeforeRead.add(index); }
    } else if (step.kind === 'search') {
        file.touches.searches += 1;
    } else {
        file.touches.executes += 1;
    }
    if (file.firstStep < 0) { file.firstStep = step.seq; }
    file.lastStep = step.seq;
    if (!file.turns.includes(step.turn)) { file.turns.push(step.turn); }
}

/** The agent's path: one hop per read/write of a single file (a search lights many, it is not a move). */
function recordHop(state: TouchState, step: MutableStep): void {
    if ((step.kind !== 'read' && step.kind !== 'write') || step.files.length === 0) { return; }
    const target = step.files[0];
    if (state.previousFile >= 0 && state.previousFile !== target) {
        const key = `${state.previousFile}>${target}`;
        const edge = state.transitions.get(key) ?? { from: state.previousFile, to: target, count: 0 };
        edge.count += 1;
        state.transitions.set(key, edge);
    }
    state.previousFile = target;
}

function foldStepTouches(state: TouchState, step: MutableStep, indexByPath: Map<string, number>): void {
    markFiles(step.createdPaths, indexByPath, (index) => { state.files[index].created = true; });
    const set = state.turnFiles.get(step.turn) ?? new Set<number>();
    for (const index of step.files) {
        set.add(index);
        touchFile(state, step, index);
    }
    markFiles(step.deletedPaths, indexByPath, (index) => { state.files[index].deleted = true; });
    state.turnFiles.set(step.turn, set);
    recordHop(state, step);
}

export function foldTouches(
    steps: MutableStep[],
    turns: AgentFlowTurn[],
    files: AgentFlowFile[],
    indexByPath: Map<string, number>,
): TouchSummary {
    const state: TouchState = {
        files,
        transitions: new Map(),
        previousFile: -1,
        readSoFar: new Set(),
        writtenBeforeRead: new Set(),
        revisits: 0,
        failures: 0,
        lastExecuteSeq: -1,
        lastWriteSeq: -1,
        writeSeqs: [],
        turnFiles: new Map(),
    };
    for (const step of steps) {
        step.files = stepFileIndexes(step, indexByPath);
        if (step.status === 'failed') { state.failures += 1; }
        countStepKind(state, turns[step.turn], step);
        if (TOUCHING_KINDS.has(step.kind)) { foldStepTouches(state, step, indexByPath); }
    }
    for (const turn of turns) {
        turn.filesTouched = state.turnFiles.get(turn.index)?.size ?? 0;
    }
    const lastExecuteSeq = state.lastExecuteSeq;
    return {
        transitions: [...state.transitions.values()],
        revisits: state.revisits,
        failures: state.failures,
        blindWrites: state.writtenBeforeRead.size,
        unverifiedEdits: state.lastWriteSeq < 0 ? 0 : state.writeSeqs.filter((seq) => seq > lastExecuteSeq).length,
    };
}

// ---- 4. Metric deltas -------------------------------------------------------

export interface DeltaInput {
    steps: MutableStep[];
    turns: AgentFlowTurn[];
    files: AgentFlowFile[];
    indexByPath: Map<string, number>;
    baseByPath: Map<string, AgentFlowFileMetrics>;
    currentByPath: Map<string, AgentFlowFileMetrics>;
    turnDeltas: Map<number, Map<string, AgentFlowMetricDelta>>;
}

function addDelta(a: AgentFlowMetricDelta, codeLines: number, complexity: number): AgentFlowMetricDelta {
    return { codeLines: a.codeLines + codeLines, complexity: a.complexity + complexity };
}

function isChanged(file: AgentFlowFile): boolean {
    return file.touches.writes > 0 || file.created || file.deleted;
}

/** Best source: the live re-analysis (current vs base). */
function liveDeltas(input: DeltaInput): Map<number, AgentFlowMetricDelta> {
    const fileDelta = new Map<number, AgentFlowMetricDelta>();
    for (const file of input.files) {
        if (!isChanged(file)) { continue; }
        const base = input.baseByPath.get(file.path);
        const current = input.currentByPath.get(file.path);
        if (current || (base && file.deleted)) {
            fileDelta.set(file.index, {
                codeLines: (current?.loc ?? 0) - (base?.loc ?? 0),
                complexity: (current?.complexity ?? 0) - (base?.complexity ?? 0),
            });
        }
    }
    return fileDelta;
}

/** Then the deltas the host measured per turn: they also set each turn's delta. */
function applyTurnDeltas(input: DeltaInput, fileDelta: Map<number, AgentFlowMetricDelta>): void {
    for (const [turnIndex, map] of input.turnDeltas) {
        let sum: AgentFlowMetricDelta = { codeLines: 0, complexity: 0 };
        for (const [path, delta] of map) {
            sum = addDelta(sum, delta.codeLines, delta.complexity);
            const index = input.indexByPath.get(path);
            if (index === undefined || input.currentByPath.has(path)) { continue; }
            const prior = fileDelta.get(index) ?? { codeLines: 0, complexity: 0 };
            fileDelta.set(index, addDelta(prior, delta.codeLines, delta.complexity));
        }
        if (input.turns[turnIndex]) { input.turns[turnIndex].delta = sum; }
    }
}

function hasDiffCounts(step: MutableStep): boolean {
    return step.kind === 'write' && (step.added !== undefined || step.removed !== undefined);
}

function diffLines(step: MutableStep): number {
    return (step.added ?? 0) - (step.removed ?? 0);
}

/** Last resort: the diff line counts. */
function applyDiffDeltas(input: DeltaInput, fileDelta: Map<number, AgentFlowMetricDelta>): void {
    for (const step of input.steps) {
        if (!hasDiffCounts(step)) { continue; }
        for (const index of step.files) {
            if (fileDelta.has(index) && (input.currentByPath.has(input.files[index].path) || input.turnDeltas.size > 0)) { continue; }
            const prior = fileDelta.get(index) ?? { codeLines: 0, complexity: 0 };
            fileDelta.set(index, addDelta(prior, diffLines(step), 0));
        }
    }
}

/** Turns with no measured delta get the diff estimate of their own writes. */
function estimateTurnDeltas(steps: MutableStep[], turns: AgentFlowTurn[]): void {
    for (const turn of turns) {
        if (turn.delta || turn.stepStart < 0) { continue; }
        let lines = 0;
        let any = false;
        for (let seq = turn.stepStart; seq <= turn.stepEnd; seq += 1) {
            const step = steps[seq];
            if (hasDiffCounts(step)) {
                any = true;
                lines += diffLines(step);
            }
        }
        if (any) { turn.delta = { codeLines: lines, complexity: 0 }; }
    }
}

/** Sets every file's and turn's delta; returns the session total (null when nothing changed). */
export function applyMetricDeltas(input: DeltaInput): AgentFlowMetricDelta | null {
    const fileDelta = liveDeltas(input);
    applyTurnDeltas(input, fileDelta);
    applyDiffDeltas(input, fileDelta);
    let totalDelta: AgentFlowMetricDelta | null = null;
    for (const [index, delta] of fileDelta) {
        input.files[index].delta = delta;
        totalDelta = addDelta(totalDelta ?? { codeLines: 0, complexity: 0 }, delta.codeLines, delta.complexity);
    }
    estimateTurnDeltas(input.steps, input.turns);
    return totalDelta;
}

// ---- 5. Blast radius --------------------------------------------------------

export interface BlastRadiusResult {
    blastRadius: AgentFlowDataset['blastRadius'];
    /** -1 when no dependency edges were given. */
    unreadDependents: number;
}

function importersByPath(edges: ReadonlyArray<readonly [string, string]>): Map<string, Set<string>> {
    const importers = new Map<string, Set<string>>();
    for (const [from, to] of edges) {
        const set = importers.get(to) ?? new Set<string>();
        set.add(from);
        importers.set(to, set);
    }
    return importers;
}

/** The city files that import `file` (itself excluded). */
function dependentIndexes(file: AgentFlowFile, importers: Map<string, Set<string>>, indexByPath: Map<string, number>): number[] {
    return [...(importers.get(file.path) ?? [])]
        .map((path) => indexByPath.get(path))
        .filter((index): index is number => index !== undefined && index !== file.index);
}

export function computeBlastRadius(
    files: AgentFlowFile[],
    indexByPath: Map<string, number>,
    dependencyEdges: ReadonlyArray<readonly [string, string]> | undefined,
): BlastRadiusResult {
    const blastRadius: AgentFlowDataset['blastRadius'] = [];
    if (!dependencyEdges) { return { blastRadius, unreadDependents: -1 }; }
    const importers = importersByPath(dependencyEdges);
    for (const file of files) {
        file.dependents = importers.get(file.path)?.size ?? 0;
    }
    const unread = new Set<number>();
    for (const file of files) {
        if (file.touches.writes === 0) { continue; }
        const dependents = dependentIndexes(file, importers, indexByPath);
        if (dependents.length === 0) { continue; }
        blastRadius.push({ file: file.index, dependents });
        for (const index of dependents) {
            const dep = files[index];
            if (dep.touches.reads === 0 && dep.touches.writes === 0) { unread.add(index); }
        }
    }
    return { blastRadius, unreadDependents: unread.size };
}

// ---- 6. Session metrics -----------------------------------------------------

export interface SessionMetricsInput {
    steps: MutableStep[];
    turns: AgentFlowTurn[];
    files: AgentFlowFile[];
    touches: TouchSummary;
    unreadDependents: number;
    totalDelta: AgentFlowMetricDelta | null;
    sessionStartedAt: number;
}

function sessionDurationMs(steps: MutableStep[], turns: AgentFlowTurn[], sessionStartedAt: number): number {
    const firstAt = steps[0]?.at ?? turns[0]?.startedAt ?? sessionStartedAt;
    const lastAt = Math.max(steps[steps.length - 1]?.at ?? 0, ...turns.map((turn) => turn.endedAt ?? turn.startedAt), firstAt);
    return Math.max(0, lastAt - firstAt);
}

export function sessionMetrics(input: SessionMetricsInput): AgentFlowSessionMetrics {
    const { steps, turns, files, touches } = input;
    const totals = turns.reduce((acc, turn) => {
        acc.reads += turn.reads; acc.writes += turn.writes; acc.searches += turn.searches; acc.executes += turn.executes;
        return acc;
    }, { reads: 0, writes: 0, searches: 0, executes: 0 });
    return {
        turns: turns.length,
        steps: steps.length,
        footprint: files.filter((file) => file.firstStep >= 0).length,
        ...totals,
        failures: touches.failures,
        readWriteRatio: totals.writes > 0 ? round(totals.reads / totals.writes, 2) : null,
        revisitRate: totals.reads > 0 ? round(touches.revisits / totals.reads, 3) : 0,
        blindWrites: touches.blindWrites,
        unverifiedEdits: touches.unverifiedEdits,
        unreadDependents: input.unreadDependents,
        filesCreated: files.filter((file) => file.created).length,
        filesDeleted: files.filter((file) => file.deleted).length,
        durationMs: sessionDurationMs(steps, turns, input.sessionStartedAt),
        delta: input.totalDelta,
    };
}

/**
 * Folds a session's agent trace events into the dataset the XR runtime
 * draws: the city (laid out once from the base metrics), the steps and
 * turns, the agent's path between files, per-file touches and metric deltas,
 * the blast radius of its edits and the session's process metrics. Pure:
 * the service reads files and calls this; tests call it directly.
 */
import {
    AGENT_FLOW_SCHEMA_VERSION,
    AGENT_FLOW_TABLE,
    AgentFlowDataset,
    AgentFlowFile,
    AgentFlowFileMetrics,
    AgentFlowMetricDelta,
    AgentFlowSessionInfo,
    AgentFlowStep,
    AgentFlowTurn,
    AgentStepKind,
    AgentTraceEvent,
} from './agentFlowModels';
import { CityLayout, layoutCity } from './agentFlowLayout';

/** Most buildings a city carries; touched files always make it. */
export const AGENT_FLOW_FILE_BUDGET = 900;

export interface AgentFlowBuildInput {
    /** Absolute analysed root, any separator style. */
    root: string;
    session: AgentFlowSessionInfo;
    events: ReadonlyArray<AgentTraceEvent>;
    /** Metrics when the session was opened: they fix the city. */
    baseMetrics: ReadonlyArray<AgentFlowFileMetrics>;
    /** Metrics now (the live re-analysis), for real deltas. */
    currentMetrics?: ReadonlyArray<AgentFlowFileMetrics>;
    /** Dependency edges `[importer, imported]`, root-relative paths. */
    dependencyEdges?: ReadonlyArray<readonly [string, string]>;
    revision: number;
    now?: number;
    /** A previous layout to keep (so a rebuild never moves a building). */
    layout?: CityLayout;
}

export interface AgentFlowBuildResult {
    dataset: AgentFlowDataset;
    layout: CityLayout;
}

const TOUCHING_KINDS = new Set<AgentStepKind>(['read', 'write', 'search', 'execute']);

/** Root-relative forward-slash path, or null when it lies outside the root. */
export function relativeToRoot(root: string, candidate: string): string | null {
    if (!candidate) { return null; }
    const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const rootNorm = norm(root);
    let path = norm(candidate.trim());
    const windows = /^[A-Za-z]:\//.test(rootNorm);
    const isAbsolute = path.startsWith('/') || /^[A-Za-z]:\//.test(path);
    if (isAbsolute) {
        const a = windows ? path.toLowerCase() : path;
        const b = windows ? rootNorm.toLowerCase() : rootNorm;
        if (a === b) { return null; }
        if (!a.startsWith(`${b}/`)) { return null; }
        path = path.slice(rootNorm.length + 1);
    }
    path = path.replace(/^(\.\/)+/, '');
    if (!path || path === '.' || path.startsWith('../') || path === '..') { return null; }
    const parts: string[] = [];
    for (const part of path.split('/')) {
        if (part === '' || part === '.') { continue; }
        if (part === '..') {
            if (parts.length === 0) { return null; }
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    return parts.length > 0 ? parts.join('/') : null;
}

function heightOf(loc: number, maxLoc: number): number {
    if (maxLoc <= 0 || loc <= 0) { return AGENT_FLOW_TABLE.minHeight; }
    const ratio = Math.sqrt(Math.min(1, loc / maxLoc));
    return AGENT_FLOW_TABLE.minHeight + (AGENT_FLOW_TABLE.maxHeight - AGENT_FLOW_TABLE.minHeight) * ratio;
}

function round(value: number, digits = 4): number {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

interface MutableStep extends AgentFlowStep {
    paths: string[];
    createdPaths: string[];
    deletedPaths: string[];
}

export function buildAgentFlowDataset(input: AgentFlowBuildInput): AgentFlowBuildResult {
    const warnings: string[] = [];
    const now = input.now ?? Date.now();
    const rootName = input.root.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || 'project';

    // ---- 1. Steps and turns ------------------------------------------------
    const steps: MutableStep[] = [];
    const stepById = new Map<string, MutableStep>();
    const turns: AgentFlowTurn[] = [];
    const turnDeltas = new Map<number, Map<string, AgentFlowMetricDelta>>();
    let outside = 0;
    const openTurn = (at: number, prompt: string): AgentFlowTurn => {
        const turn: AgentFlowTurn = {
            index: turns.length, prompt, startedAt: at, endedAt: null, stepStart: -1, stepEnd: -1,
            reads: 0, writes: 0, searches: 0, executes: 0, filesTouched: 0, delta: null,
        };
        turns.push(turn);
        return turn;
    };
    const currentTurn = (at: number): AgentFlowTurn => {
        const last = turns[turns.length - 1];
        return last && last.endedAt === null ? last : openTurn(at, '');
    };
    const resolvePaths = (locations: ReadonlyArray<{ path: string }> | undefined): string[] => {
        const out: string[] = [];
        for (const location of locations ?? []) {
            const rel = relativeToRoot(input.root, location.path);
            if (rel === null) { outside += 1; continue; }
            if (!out.includes(rel)) { out.push(rel); }
        }
        return out;
    };

    for (const event of input.events) {
        if (event.type === 'turn-start') {
            const last = turns[turns.length - 1];
            if (last && last.endedAt === null) { last.endedAt = event.at; }
            openTurn(event.at, event.prompt ?? '');
            continue;
        }
        if (event.type === 'turn-end') {
            const last = turns[turns.length - 1];
            if (last && last.endedAt === null) {
                last.endedAt = event.at;
                if (event.stopReason) { last.stopReason = event.stopReason; }
            }
            continue;
        }
        if (event.type === 'metric-delta') {
            const target = turns.length > 0 ? turns[turns.length - 1].index : 0;
            const map = turnDeltas.get(target) ?? new Map<string, AgentFlowMetricDelta>();
            for (const file of event.files) {
                const rel = relativeToRoot(input.root, file.path);
                if (!rel) { continue; }
                map.set(rel, { codeLines: file.codeLines ?? 0, complexity: file.complexity ?? 0 });
            }
            turnDeltas.set(target, map);
            continue;
        }
        // step
        const existing = stepById.get(event.id);
        if (existing) {
            if (event.status) { existing.status = event.status; }
            if (event.title) { existing.title = event.title; }
            if (event.exitCode !== undefined) { existing.exitCode = event.exitCode; }
            if (event.command) { existing.command = event.command; }
            if (event.added !== undefined) { existing.added = event.added; }
            if (event.removed !== undefined) { existing.removed = event.removed; }
            // An update that only now names its files (search hits, a diff) adds them.
            for (const rel of resolvePaths(event.locations)) {
                if (!existing.paths.includes(rel)) { existing.paths.push(rel); }
            }
            for (const rel of resolvePaths(event.created?.map((path) => ({ path })))) {
                if (!existing.createdPaths.includes(rel)) { existing.createdPaths.push(rel); }
            }
            continue;
        }
        const turn = currentTurn(event.at);
        const step: MutableStep = {
            seq: steps.length,
            turn: turn.index,
            at: event.at,
            kind: event.kind,
            tool: event.tool ?? event.kind,
            title: event.title ?? event.tool ?? event.kind,
            status: event.status ?? 'running',
            files: [],
            paths: resolvePaths(event.locations),
            createdPaths: resolvePaths(event.created?.map((path) => ({ path }))),
            deletedPaths: resolvePaths(event.deleted?.map((path) => ({ path }))),
        };
        const line = event.locations?.find((loc) => loc.line !== undefined)?.line;
        if (line !== undefined) { step.line = line; }
        if (event.command) { step.command = event.command; }
        if (event.exitCode !== undefined) { step.exitCode = event.exitCode; }
        if (event.subagent) { step.subagent = true; }
        if (event.added !== undefined) { step.added = event.added; }
        if (event.removed !== undefined) { step.removed = event.removed; }
        steps.push(step);
        stepById.set(event.id, step);
        if (turn.stepStart < 0) { turn.stepStart = step.seq; }
        turn.stepEnd = step.seq;
    }
    if (outside > 0) {
        warnings.push(`${outside} location(s) outside the analysed folder were left out.`);
    }

    // ---- 2. Files: base city + files outside the analysis ------------------
    const baseByPath = new Map<string, AgentFlowFileMetrics>();
    for (const metrics of input.baseMetrics) {
        const rel = relativeToRoot(input.root, metrics.path) ?? metrics.path.replace(/\\/g, '/');
        baseByPath.set(rel, { ...metrics, path: rel });
    }
    const currentByPath = new Map<string, AgentFlowFileMetrics>();
    for (const metrics of input.currentMetrics ?? []) {
        const rel = relativeToRoot(input.root, metrics.path) ?? metrics.path.replace(/\\/g, '/');
        currentByPath.set(rel, { ...metrics, path: rel });
    }
    const touchedPaths = new Set<string>();
    for (const step of steps) {
        if (!TOUCHING_KINDS.has(step.kind)) { continue; }
        for (const path of [...step.paths, ...step.createdPaths, ...step.deletedPaths]) { touchedPaths.add(path); }
    }
    // A search scope or `ls dir` names a folder: it touches nothing by itself.
    const knownDirs = new Set<string>();
    for (const path of baseByPath.keys()) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i += 1) { knownDirs.add(parts.slice(0, i).join('/')); }
    }
    for (const path of [...touchedPaths]) {
        if (knownDirs.has(path)) { touchedPaths.delete(path); }
    }

    let baseList = [...baseByPath.values()];
    if (baseList.length > AGENT_FLOW_FILE_BUDGET) {
        const keep = baseList.filter((file) => touchedPaths.has(file.path));
        const rest = baseList.filter((file) => !touchedPaths.has(file.path)).sort((a, b) => b.loc - a.loc);
        baseList = [...keep, ...rest.slice(0, Math.max(0, AGENT_FLOW_FILE_BUDGET - keep.length))];
        warnings.push(`The city shows ${baseList.length} of ${baseByPath.size} files: the largest ones and every file the agent touched.`);
    }
    const inBase = new Set(baseList.map((file) => file.path));
    const extraPaths = [...touchedPaths].filter((path) => !inBase.has(path));

    let layout = input.layout;
    const missingFromLayout = layout
        ? [...inBase, ...extraPaths].some((path) => !layout!.files.has(path))
        : true;
    if (!layout || missingFromLayout) {
        // Keep the previous order of the extra strip so earlier arrivals stay put.
        const previousExtra = layout ? extraPaths.filter((p) => layout!.files.has(p)) : [];
        const newExtra = extraPaths.filter((p) => !previousExtra.includes(p));
        layout = layoutCity(
            baseList.map((file) => ({ path: file.path, weight: Math.max(1, file.loc) })),
            [...previousExtra, ...newExtra].map((path) => ({ path, weight: 1 })),
            AGENT_FLOW_TABLE,
            true,
        );
    }

    const allPaths = [...baseList.map((file) => file.path), ...extraPaths];
    const maxLoc = Math.max(1, ...baseList.map((file) => file.loc), ...[...currentByPath.values()].map((file) => file.loc));
    const files: AgentFlowFile[] = [];
    const indexByPath = new Map<string, number>();
    for (const path of allPaths) {
        const rect = layout.files.get(path);
        if (!rect) { continue; }
        const base = baseByPath.get(path);
        const current = currentByPath.get(path);
        const metrics = current ?? base;
        const slash = path.lastIndexOf('/');
        const file: AgentFlowFile = {
            index: files.length,
            path,
            name: slash >= 0 ? path.slice(slash + 1) : path,
            dir: slash >= 0 ? path.slice(0, slash) : '',
            loc: metrics?.loc ?? 0,
            x: round(rect.x), z: round(rect.z), w: round(rect.w), d: round(rect.d),
            h: round(heightOf(metrics?.loc ?? 0, maxLoc)),
            touches: { reads: 0, writes: 0, searches: 0, executes: 0 },
            firstStep: -1,
            lastStep: -1,
            turns: [],
            created: false,
            deleted: false,
            delta: null,
            dependents: -1,
        };
        if (metrics?.language) { file.language = metrics.language; }
        if (metrics?.complexity !== undefined) { file.complexity = metrics.complexity; }
        if (metrics?.functions !== undefined) { file.functions = metrics.functions; }
        indexByPath.set(path, file.index);
        files.push(file);
    }

    // ---- 3. Touches, turns, transitions ------------------------------------
    const transitions = new Map<string, { from: number; to: number; count: number }>();
    let previousFile = -1;
    const readSoFar = new Set<number>();
    const writtenBeforeRead = new Set<number>();
    let revisits = 0;
    let failures = 0;
    let lastExecuteSeq = -1;
    let lastWriteSeq = -1;
    const writeSeqs: number[] = [];
    const turnFiles = new Map<number, Set<number>>();
    for (const step of steps) {
        step.files = [...step.paths, ...step.createdPaths, ...step.deletedPaths]
            .map((path) => indexByPath.get(path))
            .filter((index): index is number => index !== undefined)
            .filter((index, position, list) => list.indexOf(index) === position);
        if (step.status === 'failed') { failures += 1; }
        const turn = turns[step.turn];
        switch (step.kind) {
            case 'read': turn.reads += 1; break;
            case 'write': turn.writes += 1; writeSeqs.push(step.seq); lastWriteSeq = step.seq; break;
            case 'search': turn.searches += 1; break;
            case 'execute': turn.executes += 1; lastExecuteSeq = step.seq; break;
            default: break;
        }
        if (!TOUCHING_KINDS.has(step.kind)) { continue; }
        for (const path of step.createdPaths) {
            const index = indexByPath.get(path);
            if (index !== undefined) { files[index].created = true }
        }
        const set = turnFiles.get(step.turn) ?? new Set<number>();
        for (const index of step.files) {
            const file = files[index];
            set.add(index);
            if (step.kind === 'read') {
                file.touches.reads += 1;
                if (readSoFar.has(index)) { revisits += 1; }
                readSoFar.add(index);
            } else if (step.kind === 'write') {
                file.touches.writes += 1;
                if (!readSoFar.has(index) && !file.created) { writtenBeforeRead.add(index); }
            } else if (step.kind === 'search') {
                file.touches.searches += 1;
            } else {
                file.touches.executes += 1;
            }
            if (file.firstStep < 0) { file.firstStep = step.seq; }
            file.lastStep = step.seq;
            if (!file.turns.includes(step.turn)) { file.turns.push(step.turn); }
        }
        for (const path of step.deletedPaths) {
            const index = indexByPath.get(path);
            if (index !== undefined) { files[index].deleted = true; }
        }
        turnFiles.set(step.turn, set);
        // The agent's path: one hop per read/write of a single file (a search lights many, it is not a move).
        if ((step.kind === 'read' || step.kind === 'write') && step.files.length > 0) {
            const target = step.files[0];
            if (previousFile >= 0 && previousFile !== target) {
                const key = `${previousFile}>${target}`;
                const edge = transitions.get(key) ?? { from: previousFile, to: target, count: 0 };
                edge.count += 1;
                transitions.set(key, edge);
            }
            previousFile = target;
        }
    }
    for (const turn of turns) {
        turn.filesTouched = turnFiles.get(turn.index)?.size ?? 0;
    }

    // ---- 4. Metric deltas ---------------------------------------------------
    // Best source: the live re-analysis (current vs base). Then the deltas the
    // host measured per turn. Last resort: the diff line counts.
    const fileDelta = new Map<number, AgentFlowMetricDelta>();
    for (const file of files) {
        if (file.touches.writes === 0 && !file.created && !file.deleted) { continue; }
        const base = baseByPath.get(file.path);
        const current = currentByPath.get(file.path);
        if (current || (base && file.deleted)) {
            fileDelta.set(file.index, {
                codeLines: (current?.loc ?? 0) - (base?.loc ?? 0),
                complexity: (current?.complexity ?? 0) - (base?.complexity ?? 0),
            });
        }
    }
    for (const [turnIndex, map] of turnDeltas) {
        let sumLines = 0;
        let sumComplexity = 0;
        for (const [path, delta] of map) {
            sumLines += delta.codeLines;
            sumComplexity += delta.complexity;
            const index = indexByPath.get(path);
            if (index === undefined || currentByPath.has(path)) { continue; }
            const prior = fileDelta.get(index) ?? { codeLines: 0, complexity: 0 };
            fileDelta.set(index, { codeLines: prior.codeLines + delta.codeLines, complexity: prior.complexity + delta.complexity });
        }
        if (turns[turnIndex]) { turns[turnIndex].delta = { codeLines: sumLines, complexity: sumComplexity }; }
    }
    for (const step of steps) {
        if (step.kind !== 'write' || (step.added === undefined && step.removed === undefined)) { continue; }
        for (const index of step.files) {
            if (fileDelta.has(index) && (currentByPath.has(files[index].path) || turnDeltas.size > 0)) { continue; }
            const prior = fileDelta.get(index) ?? { codeLines: 0, complexity: 0 };
            fileDelta.set(index, { codeLines: prior.codeLines + (step.added ?? 0) - (step.removed ?? 0), complexity: prior.complexity });
        }
    }
    let totalDelta: AgentFlowMetricDelta | null = null;
    for (const [index, delta] of fileDelta) {
        files[index].delta = delta;
        const sum: AgentFlowMetricDelta = totalDelta ?? { codeLines: 0, complexity: 0 };
        totalDelta = { codeLines: sum.codeLines + delta.codeLines, complexity: sum.complexity + delta.complexity };
    }
    // Turns with no measured delta get the diff estimate of their own writes.
    for (const turn of turns) {
        if (turn.delta || turn.stepStart < 0) { continue; }
        let lines = 0;
        let any = false;
        for (let seq = turn.stepStart; seq <= turn.stepEnd; seq += 1) {
            const step = steps[seq];
            if (step.kind === 'write' && (step.added !== undefined || step.removed !== undefined)) {
                any = true;
                lines += (step.added ?? 0) - (step.removed ?? 0);
            }
        }
        if (any) { turn.delta = { codeLines: lines, complexity: 0 }; }
    }

    // ---- 5. Blast radius ----------------------------------------------------
    const blastRadius: AgentFlowDataset['blastRadius'] = [];
    let unreadDependents = -1;
    if (input.dependencyEdges) {
        const importers = new Map<string, Set<string>>();
        for (const [from, to] of input.dependencyEdges) {
            const set = importers.get(to) ?? new Set<string>();
            set.add(from);
            importers.set(to, set);
        }
        for (const file of files) {
            file.dependents = importers.get(file.path)?.size ?? 0;
        }
        const unread = new Set<number>();
        for (const file of files) {
            if (file.touches.writes === 0) { continue; }
            const dependents = [...(importers.get(file.path) ?? [])]
                .map((path) => indexByPath.get(path))
                .filter((index): index is number => index !== undefined && index !== file.index);
            if (dependents.length > 0) {
                blastRadius.push({ file: file.index, dependents });
                for (const index of dependents) {
                    const dep = files[index];
                    if (dep.touches.reads === 0 && dep.touches.writes === 0) { unread.add(index); }
                }
            }
        }
        unreadDependents = unread.size;
    }

    // ---- 6. Session metrics -------------------------------------------------
    const touchedFiles = files.filter((file) => file.firstStep >= 0);
    const totals = turns.reduce((acc, turn) => {
        acc.reads += turn.reads; acc.writes += turn.writes; acc.searches += turn.searches; acc.executes += turn.executes;
        return acc;
    }, { reads: 0, writes: 0, searches: 0, executes: 0 });
    const unverifiedEdits = lastWriteSeq < 0 ? 0 : writeSeqs.filter((seq) => seq > lastExecuteSeq).length;
    const firstAt = steps[0]?.at ?? turns[0]?.startedAt ?? input.session.startedAt;
    const lastAt = Math.max(steps[steps.length - 1]?.at ?? 0, ...turns.map((turn) => turn.endedAt ?? turn.startedAt), firstAt);

    const dataset: AgentFlowDataset = {
        schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
        revision: input.revision,
        generatedAt: new Date(now).toISOString(),
        rootName,
        session: input.session,
        files,
        districts: layout.districts.map((district) => ({
            path: district.path, depth: district.depth,
            x: round(district.x), z: round(district.z), w: round(district.w), d: round(district.d),
        })),
        turns,
        steps: steps.map(({ paths: _paths, createdPaths: _created, deletedPaths: _deleted, ...step }) => step),
        transitions: [...transitions.values()],
        metrics: {
            turns: turns.length,
            steps: steps.length,
            footprint: touchedFiles.length,
            ...totals,
            failures,
            readWriteRatio: totals.writes > 0 ? round(totals.reads / totals.writes, 2) : null,
            revisitRate: totals.reads > 0 ? round(revisits / totals.reads, 3) : 0,
            blindWrites: writtenBeforeRead.size,
            unverifiedEdits,
            unreadDependents,
            filesCreated: files.filter((file) => file.created).length,
            filesDeleted: files.filter((file) => file.deleted).length,
            durationMs: Math.max(0, lastAt - firstAt),
            delta: totalDelta,
        },
        blastRadius,
        warnings,
    };
    return { dataset, layout };
}

/**
 * Folds a session's agent trace events into the dataset the XR runtime
 * draws: the city (laid out once from the base metrics), the steps and
 * turns, the agent's path between files, per-file touches and metric deltas,
 * the blast radius of its edits and the session's process metrics. Pure:
 * the service reads files and calls this; tests call it directly.
 *
 * The phases live in sibling modules: steps and turns in agentFlowSteps.ts,
 * touches, deltas, blast radius and session metrics in agentFlowMetrics.ts.
 * This module owns the files of the city and assembles the dataset.
 */
import {
    AGENT_FLOW_SCHEMA_VERSION,
    AGENT_FLOW_TABLE,
    type AgentFlowDataset,
    type AgentFlowFile,
    type AgentFlowFileMetrics,
    type AgentFlowSessionInfo,
    type AgentTraceEvent,
} from './agentFlowModels';
import { type CityLayout, type LayoutRect, layoutCity, PLATE_HEIGHT } from './agentFlowLayout';
import { relativeToRoot } from './agentFlowPaths';
import { foldTraceEvents, type MutableStep } from './agentFlowSteps';
import { applyMetricDeltas, computeBlastRadius, foldTouches, round, sessionMetrics, TOUCHING_KINDS } from './agentFlowMetrics';

export { relativeToRoot } from './agentFlowPaths';

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

function heightOf(loc: number, maxLoc: number): number {
    if (maxLoc <= 0 || loc <= 0) { return AGENT_FLOW_TABLE.minHeight; }
    const ratio = Math.sqrt(Math.min(1, loc / maxLoc));
    return AGENT_FLOW_TABLE.minHeight + (AGENT_FLOW_TABLE.maxHeight - AGENT_FLOW_TABLE.minHeight) * ratio;
}

// ---- 2. Files: base city + files outside the analysis ----------------------

function metricsByPath(root: string, list: ReadonlyArray<AgentFlowFileMetrics>): Map<string, AgentFlowFileMetrics> {
    const byPath = new Map<string, AgentFlowFileMetrics>();
    for (const metrics of list) {
        const rel = relativeToRoot(root, metrics.path) ?? metrics.path.replace(/\\/g, '/');
        byPath.set(rel, { ...metrics, path: rel });
    }
    return byPath;
}

function collectTouchedPaths(steps: MutableStep[], baseByPath: Map<string, AgentFlowFileMetrics>): Set<string> {
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
    return touchedPaths;
}

function applyFileBudget(
    baseByPath: Map<string, AgentFlowFileMetrics>,
    touchedPaths: Set<string>,
    warnings: string[],
): AgentFlowFileMetrics[] {
    const baseList = [...baseByPath.values()];
    if (baseList.length <= AGENT_FLOW_FILE_BUDGET) { return baseList; }
    const keep = baseList.filter((file) => touchedPaths.has(file.path));
    const rest = baseList.filter((file) => !touchedPaths.has(file.path)).sort((a, b) => b.loc - a.loc);
    const kept = [...keep, ...rest.slice(0, Math.max(0, AGENT_FLOW_FILE_BUDGET - keep.length))];
    warnings.push(`The city shows ${kept.length} of ${baseByPath.size} files: the largest ones and every file the agent touched.`);
    return kept;
}

function resolveLayout(
    previous: CityLayout | undefined,
    baseList: AgentFlowFileMetrics[],
    inBase: Set<string>,
    extraPaths: string[],
): CityLayout {
    const missingFromLayout = previous
        ? [...inBase, ...extraPaths].some((path) => !previous.files.has(path))
        : true;
    if (previous && !missingFromLayout) { return previous; }
    // Keep the previous order of the extra strip so earlier arrivals stay put.
    const previousExtra = previous ? extraPaths.filter((p) => previous.files.has(p)) : [];
    const newExtra = extraPaths.filter((p) => !previousExtra.includes(p));
    return layoutCity(
        baseList.map((file) => ({ path: file.path, weight: Math.max(1, file.loc) })),
        [...previousExtra, ...newExtra].map((path) => ({ path, weight: 1 })),
        AGENT_FLOW_TABLE,
        true,
    );
}

function makeFile(index: number, path: string, rect: LayoutRect, metrics: AgentFlowFileMetrics | undefined, maxLoc: number): AgentFlowFile {
    const slash = path.lastIndexOf('/');
    const loc = metrics?.loc ?? 0;
    const file: AgentFlowFile = {
        index,
        path,
        name: slash >= 0 ? path.slice(slash + 1) : path,
        dir: slash >= 0 ? path.slice(0, slash) : '',
        loc,
        x: round(rect.x), z: round(rect.z), w: round(rect.w), d: round(rect.d), baseY: round(rect.y ?? 0),
        h: round(heightOf(loc, maxLoc)),
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
    return file;
}

interface CityFiles {
    files: AgentFlowFile[];
    indexByPath: Map<string, number>;
    layout: CityLayout;
}

function buildCityFiles(
    input: AgentFlowBuildInput,
    steps: MutableStep[],
    baseByPath: Map<string, AgentFlowFileMetrics>,
    currentByPath: Map<string, AgentFlowFileMetrics>,
    warnings: string[],
): CityFiles {
    const touchedPaths = collectTouchedPaths(steps, baseByPath);
    const baseList = applyFileBudget(baseByPath, touchedPaths, warnings);
    const inBase = new Set(baseList.map((file) => file.path));
    const extraPaths = [...touchedPaths].filter((path) => !inBase.has(path));
    const layout = resolveLayout(input.layout, baseList, inBase, extraPaths);

    const allPaths = [...baseList.map((file) => file.path), ...extraPaths];
    const maxLoc = Math.max(1, ...baseList.map((file) => file.loc), ...[...currentByPath.values()].map((file) => file.loc));
    const files: AgentFlowFile[] = [];
    const indexByPath = new Map<string, number>();
    for (const path of allPaths) {
        const rect = layout.files.get(path);
        if (!rect) { continue; }
        const file = makeFile(files.length, path, rect, currentByPath.get(path) ?? baseByPath.get(path), maxLoc);
        indexByPath.set(path, file.index);
        files.push(file);
    }
    return { files, indexByPath, layout };
}

function datasetDistricts(layout: CityLayout): AgentFlowDataset['districts'] {
    return layout.districts.map((district) => ({
        path: district.path, depth: district.depth,
        x: round(district.x), z: round(district.z), w: round(district.w), d: round(district.d),
        y: round(district.y ?? (district.depth - 1) * PLATE_HEIGHT),
    }));
}

export function buildAgentFlowDataset(input: AgentFlowBuildInput): AgentFlowBuildResult {
    const warnings: string[] = [];
    const now = input.now ?? Date.now();
    const rootName = input.root.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || 'project';

    // ---- 1. Steps and turns, actors -----------------------------------------
    const { steps, turns, actors, turnDeltas, outside } = foldTraceEvents(input.root, input.session.agent, input.events);
    if (outside > 0) {
        warnings.push(`${outside} location(s) outside the analysed folder were left out.`);
    }

    // ---- 2. Files ------------------------------------------------------------
    const baseByPath = metricsByPath(input.root, input.baseMetrics);
    const currentByPath = metricsByPath(input.root, input.currentMetrics ?? []);
    const { files, indexByPath, layout } = buildCityFiles(input, steps, baseByPath, currentByPath, warnings);

    // ---- 3-6. Touches, deltas, blast radius, session metrics ----------------
    const touches = foldTouches(steps, turns, files, indexByPath);
    const totalDelta = applyMetricDeltas({ steps, turns, files, indexByPath, baseByPath, currentByPath, turnDeltas });
    const { blastRadius, unreadDependents } = computeBlastRadius(files, indexByPath, input.dependencyEdges);

    const dataset: AgentFlowDataset = {
        schemaVersion: AGENT_FLOW_SCHEMA_VERSION,
        revision: input.revision,
        generatedAt: new Date(now).toISOString(),
        rootName,
        session: input.session,
        actors,
        files,
        districts: datasetDistricts(layout),
        turns,
        steps: steps.map(({ paths: _paths, createdPaths: _created, deletedPaths: _deleted, ...step }) => step),
        transitions: touches.transitions,
        metrics: sessionMetrics({
            steps, turns, files, touches, unreadDependents, totalDelta, sessionStartedAt: input.session.startedAt,
        }),
        blastRadius,
        warnings,
    };
    return { dataset, layout };
}
